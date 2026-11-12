import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadStoredConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadAbiCases, recordAbiCase } from '../src/contracts/abi-case.ts';
import { proveAbi } from '../src/contracts/prove.ts';
import type { AbiProof, AbiRefusal } from '../src/contracts/prove.ts';
import { cachedCompilers } from '../src/contracts/solc.ts';
import { retryingSourcify, sourcifyHttps } from '../src/contracts/sourcify.ts';
import { loadRegistry } from '../src/registry.ts';
import { gatherApiAnswers, httpsApi, retryingSend } from '../src/research/api-source.ts';
import { fetchListing, listingsFor } from '../src/research/listings.ts';
import { factsRecording, factsScope, parseFactsRecording, protocolFacts } from '../src/research/protocol-facts.ts';
import { chainAt, loadSnapshot, trimForRecording as trimErc7730 } from '../src/research/erc7730.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import {
  checkSpans,
  compareReports,
  entriesOf,
  erc7730Text,
  generatedPath,
  loadSubject,
  pastTxsRecordings,
  programChanges,
  renderReport,
  replayInputs,
  replayReport,
  reportRecordingPath,
  summarizePastTxs,
  trimReportRecording,
  vaultsAt,
  vaultsOf,
} from '../src/research/report.ts';
import type { Target } from '../src/research/report.ts';
import { notesChanges, NotesError } from '../src/research/notes.ts';
import { generatedHtml, generatedHtmlPath, htmlDifference } from '../src/research/report-html.ts';
import { gatherSourcePages, httpsGet, retryingGet } from '../src/research/source-page.ts';
import { alchemyCall, vaultEvidenceText } from '../src/research/vault-evidence.ts';
import type { Address } from '../src/safe/types.ts';
import { ensureVendored } from '../src/vendor.ts';

const USAGE = `usage: ALCHEMY_API_KEY=... node scripts/report.ts (<protocol>/<operation> | --vault <registry vault name>) [--record | --compare [--data <git ref>]]
       node scripts/report.ts (<protocol>/<operation> | --vault <registry vault name>) (--offline | --render)

Prints the generated report of a template, read live: each field's rule from template.json, each function's page from
docs.json checked against DefiLlama and the page itself, pnpm check-sources and pnpm prove-abi for every registry entry
the operation can touch, each span of its code pin checked on the chain, pnpm vault-evidence for every vault its card
can name, the protocol facts (DefiLlama's TVL, listing date and hacks for each protocol a call goes to, each facts view
for every value its card field can name, and each token's decimals()), the past-txs recordings of the template studied
again with each recorded transaction fetched again by hash through both providers, and pnpm erc7730 for every such
entry. --vault prints the same for one vault, for a pull request that adds it.

A read with no answer (no connection, a timeout, a server error or a rate limit) is asked again after each pause; one
still without an answer prints as UNVERIFIABLE, never as FINDING, and --record then writes nothing.

--record also writes the live answers to testdata/report/, records an ABI case for each entry testdata/abi/ lacks, and
writes the committed report from those recordings alone: templates/<protocol>/<operation>/report.generated.md, or
registry/reports/<vault>.generated.md, and for a template with notes.json, report.generated.html beside it. --offline
prints the Markdown text from the recordings, reading nothing live; --render writes both files from them.
--compare reads the listings, pages, official APIs, ABI proofs, code spans and ERC-7730 attestations live, reads each vault again at the blocks
the committed report names, reads the protocol facts and decimals again at the block the recording names, fetches each
recorded past transaction again by hash, and prints each fact that differs from the committed report, setting aside
DefiLlama's TVL; it exits 1 on any. It does not search for past transactions again. For a template with
notes.json it also writes report.generated.html again from the recordings and notes with this code and requires the
committed file to equal it byte for byte. It first prints every file the pull request changes outside templates/,
registry/ and testdata/ against origin/main, and AI TEXT for each notes.json it changes.

--data <git ref> takes templates/, registry/ and testdata/ from that ref, such as a fetched pull request branch, and
runs the code checked out here. Run --compare from main with --data, so the pull request's own code cannot change what
--compare checks.`;

const { values: flags, positionals } = parseArgs({
  options: {
    vault: { type: 'string' },
    record: { type: 'boolean' },
    offline: { type: 'boolean' },
    render: { type: 'boolean' },
    compare: { type: 'boolean' },
    data: { type: 'string' },
  },
  allowPositionals: true,
});
const [id] = positionals;
if (
  (id === undefined) === (flags.vault === undefined) ||
  positionals.length > 1 ||
  [flags.record, flags.offline, flags.render, flags.compare].filter(Boolean).length > 1 ||
  (flags.data !== undefined && !flags.compare)
) {
  console.error(USAGE);
  process.exit(2);
}
const target: Target = id === undefined ? { vault: flags.vault! } : { template: id };

const codeRoot = join(import.meta.dirname, '..');
const git = (...args: string[]): Buffer => execFileSync('git', args, { cwd: codeRoot, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });

/** The data directories as they are at `ref`, unpacked into a fresh directory, beside none of this checkout's code. */
function dataAt(ref: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-data-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  execFileSync('tar', ['-x', '-C', dir], { input: git('archive', '--format=tar', ref, 'templates', 'registry', 'testdata') });
  return dir;
}

if (flags.compare) {
  const head = flags.data ?? 'HEAD';
  let changed: string[] | undefined;
  try {
    changed = git('diff', '--name-only', `origin/main...${head}`).toString().split('\n').filter((f) => f !== '');
  } catch {
    console.log(`PROGRAM CHANGE?  git could not compare ${head} with origin/main; check by hand which files the pull request changes`);
  }
  const program = changed === undefined ? [] : programChanges(changed);
  if (program.length > 0) {
    console.log(`PROGRAM CHANGE  ${head} changes ${program.length} file(s) outside templates/, registry/ and testdata/; review it as a program change, not a template:`);
    for (const file of program) console.log(`  ${file}`);
  }
  for (const file of notesChanges(changed ?? [])) console.log(`AI TEXT  ${head} changes ${file}, text the AI wrote that no program checks; read it before merging`);
  if (flags.data === undefined) console.log('NOTE  this runs the code checked out here; to check a pull request, run --compare from main with --data <its branch>');
}

const root = flags.data === undefined ? codeRoot : dataAt(flags.data);
const registry = loadRegistry(root);
if (!(await ensureVendored(['solc', 'psl']))) process.exit(1);
const suffixes = loadPublicSuffixList();
const compilers = cachedCompilers();

if (flags.offline) {
  process.stdout.write(await replayReport(root, registry, target, compilers, suffixes));
  process.exit(0);
}

/** Writes the committed reports from the repository and the recordings alone. */
async function writeGenerated(): Promise<void> {
  const { inputs, title } = await replayInputs(root, registry, target, compilers, suffixes);
  const mdPath = join(root, generatedPath(target));
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, renderReport(inputs, title));
  const written = [generatedPath(target)];
  const html = await generatedHtml(root, inputs, title);
  if (html !== undefined && 'template' in target) {
    writeFileSync(join(root, generatedHtmlPath(target.template)), html);
    written.push(generatedHtmlPath(target.template));
  }
  console.error(`wrote ${written.join(' and ')}`);
}

if (flags.render) {
  await writeGenerated();
  process.exit(0);
}

const subject = loadSubject(root, registry, target);
const committedPath = join(root, generatedPath(target));
if (flags.compare && !existsSync(committedPath)) {
  console.error(`${generatedPath(target)} does not exist; there is nothing to compare with`);
  process.exit(2);
}
const entries = entriesOf(subject, registry);
const endpoints = mainnetEndpoints(process.env);
const unread: string[] = [];
const note = (read: string) => void unread.push(read);
const reader = createReader(endpoints, httpsTransport(), { note });
const latest = await reader.block('latest');
if (latest.kind === 'unverifiable') throw new Error(latest.reason);

/** Each DefiLlama or CoinGecko answer, read once and kept by path: the listings and the protocol facts share the protocol list. */
const answers = new Map<string, Promise<unknown>>();
const listing = (target: { readonly hostname: string; readonly path: string }): Promise<unknown> => {
  const answer = answers.get(target.path) ?? fetchListing(target, note);
  answers.set(target.path, answer);
  return answer;
};
const listings = await listingsFor(entries, suffixes, listing);
const docs = subject.kind === 'template' ? subject.docs.map((d) => d.url) : [];
const pages = await gatherSourcePages([...entries.map((e) => e.source), ...docs], retryingGet(httpsGet, note), await gatherApiAnswers(entries, retryingSend(httpsApi, note)));

const recorded = loadAbiCases(root);
const abi = new Map<Address, AbiProof | AbiRefusal>();
const abiCases = new Map<string, unknown>();
for (const entry of entries) {
  const deps = { sourcify: retryingSourcify(sourcifyHttps, note), compilers };
  if (flags.record && !recorded.has(entry.address)) {
    const { proof, fixture } = await recordAbiCase(reader, entry.address, latest.value, latest.providers, deps);
    abiCases.set(join(root, 'testdata', 'abi', `${entry.name.replace(/\./g, '-')}.json`), fixture);
    abi.set(entry.address, proof);
  } else abi.set(entry.address, await proveAbi(reader, entry.address, latest.value, deps));
}

const alchemy = alchemyCall(httpsTransport(), endpoints[0].url, note);
const vaults = await vaultsAt(flags.compare ? readFileSync(committedPath, 'utf8') : '', vaultsOf(subject, registry), async (vault, at) => {
  console.error(`reading ${vault.name} at ${at === 'latest' ? 'the latest block' : `block ${at}`}`);
  return (await vaultEvidenceText(reader, alchemy, registry, vault, at)).text;
});

if (!(await ensureVendored(['erc7730']))) process.exit(1);
const snapshot = loadSnapshot();
if ('unavailable' in snapshot) {
  console.error(snapshot.unavailable);
  process.exit(1);
}
const codeChain = recordingTransport(httpsTransport(), endpoints);
const spans = await checkSpans(createReader(endpoints, codeChain.transport, { note }), entries);
const erc7730Chain = recordingTransport(httpsTransport(), endpoints);
const erc7730 = await erc7730Text(entries, registry, snapshot, () => chainAt(createReader(endpoints, erc7730Chain.transport, { note })));

const factsChain = recordingTransport(httpsTransport(), endpoints);
const committedFacts = flags.compare && subject.kind === 'template' ? parseFactsRecording(JSON.parse(readFileSync(join(root, reportRecordingPath(target)), 'utf8')).facts) : undefined;
const factsBlock = committedFacts === undefined ? latest.value : { number: BigInt(committedFacts.block.number), hash: committedFacts.block.hash };
const scope = subject.kind === 'template' ? factsScope(subject.template, registry, entries) : undefined;
const facts = scope === undefined ? undefined : await protocolFacts(scope, registry, { defillama: listing, reader: createReader(endpoints, factsChain.transport, { note }), block: factsBlock });

const pastTxs = await Promise.all(pastTxsRecordings(root, subject).map(({ file, recording }) => summarizePastTxs(root, registry, file, recording, reader)));
const fetched = new Date();
const live = { subject, registry, listings, pages, fetched: fetched.toISOString().slice(0, 10), abi, vaults, pastTxs, spans, erc7730, facts };
const command = id === undefined ? `pnpm report --vault ${flags.vault}` : `pnpm report ${id}`;
const text = renderReport(live, { command, sources: ['live reads at the time it ran', ...pastTxs.map((p) => p.file)] });

/** The committed HTML report against what the code checked out here writes from the recordings and notes.json. */
async function compareHtml(): Promise<boolean> {
  if (!('template' in target)) return true;
  const path = generatedHtmlPath(target.template);
  const committed = existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined;
  let difference: string | undefined;
  try {
    const { inputs, title } = await replayInputs(root, registry, target, compilers, suffixes);
    difference = htmlDifference(committed, await generatedHtml(root, inputs, title));
  } catch (e) {
    if (!(e instanceof NotesError)) throw e;
    difference = `the program refuses notes.json: ${e.message}`;
  }
  console.log(
    difference === undefined
      ? `${path}: equals, byte for byte, what this code writes from the recordings and notes.json`
      : `DIFFERS  ${path} is not what this code writes from the recordings and notes.json; ${difference}`,
  );
  return difference === undefined;
}

if (flags.compare) {
  if (unread.length > 0) console.log([`NOTE  ${unread.length} read(s) got no answer after every retry; a fact that differs below may differ only for that:`, ...unread.map((read) => `  ${read}`)].join('\n'));
  const differences = compareReports(readFileSync(committedPath, 'utf8'), text);
  for (const line of differences) console.log(`DIFFERS  ${line}`);
  console.log(
    differences.length === 0
      ? `${generatedPath(target)}: every fact read live equals the committed report (not compared: the date the listings were read, DefiLlama's TVL and the block each ABI proof was read at; past transactions were not searched again)`
      : `${generatedPath(target)}: ${differences.length} fact(s) differ from what was read live`,
  );
  const htmlSame = await compareHtml();
  process.exit(differences.length === 0 && htmlSame ? 0 : 1);
}
console.log(text);

if (flags.record) {
  const refusal = unreadRefusal(unread);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exit(1);
  }
  const erc7730Section = { commit: snapshot.commit, files: Object.fromEntries(trimErc7730(snapshot, erc7730.reports)), chain: erc7730Chain.exchanges() };
  const raw = new Map(await Promise.all([...answers].map(async ([path, answer]) => [path, await answer] as const)));
  const factsSection = scope === undefined ? {} : { facts: factsRecording(scope, factsBlock, raw, factsChain.exchanges()) };
  const recording = JSON.stringify({ ...trimReportRecording(subject, entries, listings, pages, fetched, vaults, erc7730Section, codeChain.exchanges()), ...factsSection }, null, 2);
  const safe = loadStoredConfig(kissSignHome(process.env))?.safe;
  if (safe !== undefined && recording.toLowerCase().includes(safe.slice(2))) {
    console.error('the recording would name the configured Safe; nothing written');
    process.exit(1);
  }
  for (const [path, fixture] of abiCases) writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  mkdirSync(dirname(join(root, reportRecordingPath(target))), { recursive: true });
  writeFileSync(join(root, reportRecordingPath(target)), `${recording}\n`);
  console.error(`recorded ${reportRecordingPath(target)}`);
  await writeGenerated();
}
