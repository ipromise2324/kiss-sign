import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadStoredConfig } from '../src/config.ts';
import { keySpec, kissSignHome } from '../src/keys.ts';
import { MissingKeyError, mainnetEndpoints } from '../src/chain/providers.ts';
import type { KeySpec } from '../src/keys.ts';
import { liveCreations } from '../src/research/deployer.ts';
import { gatherPackages, provenanceRepositories } from '../src/research/npm-package.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadAbiCases, recordAbiCase } from '../src/contracts/abi-case.ts';
import { proveAbi } from '../src/contracts/prove.ts';
import type { AbiProof, AbiRefusal } from '../src/contracts/prove.ts';
import { cachedCompilers } from '../src/contracts/solc.ts';
import { etherscanFromEnv, retryingEtherscan } from '../src/contracts/etherscan.ts';
import { loadRegistry, pageUrlsOf } from '../src/registry.ts';
import { gatherApiAnswers, httpsApi, retryingSend } from '../src/research/api-source.ts';
import { fetchListing, listingsFor, liveListingReads } from '../src/research/listings.ts';
import { factsRecording, factsScope, protocolFacts } from '../src/research/protocol-facts.ts';
import { chainAt, loadSnapshot, trimForRecording as trimErc7730 } from '../src/research/erc7730.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import {
  checkSpans,
  entriesOf,
  erc7730Text,
  generatedPath,
  loadReport,
  ReportError,
  reportArgs,
  pastTxsRecordings,
  provedEntries,
  readInstances,
  readToday,
  renderReport,
  replayInputs,
  reportFixtures,
  replayReport,
  reportDir,
  reportRecordingPath,
  summarizePastTxs,
  trimReportRecording,
  evidenceEntries,
} from '../src/research/report.ts';
import type { TemplateTarget } from '../src/research/report.ts';
import { NOTES_FILE, NotesError } from '../src/research/notes.ts';
import type { Language } from '../src/language.ts';
import { generatedHtml, generatedHtmlFile, writeHtmlPages } from '../src/research/report-html.ts';
import { gatherSourcePages, httpsGet, retryingGet } from '../src/research/source-page.ts';
import { readGithubToken } from '../src/research/github-token.ts';
import { settledBlock } from '../src/research/settled.ts';
import { alchemyCall, vaultEvidenceText } from '../src/research/instance-evidence.ts';
import type { Address } from '../src/safe/types.ts';
import { UsageError } from '../src/research/usage.ts';
import { requireJudged } from '../src/research/trace-addresses.ts';
import { ensureVendored, nodeVendorIoWith } from '../src/vendor.ts';
import { recordingText } from '../src/chain/bytecode.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = `usage: pnpm report <protocol>/<operation> [--instance-of <instance>] [--record]
       pnpm report <protocol>/<operation> [--instance-of <instance>] (--offline | --render)`;
const HELP = `${USAGE}

Prints the generated report of a template, read live: the card's choices and each field's rule,
the effects, each function's official page, pnpm check-sources and the code pin's spans for every
registry entry the operation can touch, pnpm prove-abi for each whose ABI it uses (the code it runs
at that block for the others), pnpm instance-evidence for the instance, the protocol facts,
the past-txs recordings of the template studied again, and pnpm erc7730 for every such entry.
A template whose card has an instance field, a vault today, is reported per instance: --instance-of
names it, and the report reads the registry as if it were the only one the card can name and
studies only the past-txs recordings whose --token is that instance. Without
--instance-of such a template is refused, naming the instances that have a report.
It reads the chain at the block 8 behind the head, which no reorganization replaces while it reads.
A read with no answer is asked again after each pause; one still without an answer prints as
UNVERIFIABLE, never as FINDING, and --record then stops and writes nothing.
--record refuses before any read, naming every one, while an address the recorded call traces show
moving the sender's money is neither checked at signing nor judged in the trace-addresses.json
beside the report, while that file judges an address no trace names, or while no trace counts for
a template that moves money and the file gives no "untraced" reason. --render and --offline refuse
the same for a report recorded on 2026-11-26 (UTC) or later, or that has the file.
The report prints no text from a page, a token, a descriptor or an API answer, and prints the
template's reasons escaped and labelled as written by the AI. pnpm test fails when a committed
report, or an HTML page, differs from what its recordings and notes.json give.

Options:
  --instance-of <instance>  report the template for this one instance (--vault and --vault-of were
                            removed and are refused)
  --record                  also write the answers, an ABI case for each entry testdata/abi/ lacks,
                            and then the report files from the recordings alone; the HTML step
                            refuses notes.json that lacks a review the results need, after the
                            recordings and report.generated.md are written, so write the reviews
                            and run --render
  --offline                 print the Markdown report from the recordings, reading no fact live
  --render                  write the report files from the recordings, reading no fact live
Use at most one of --record, --offline and --render.
--record and --render remove a page in a language the notes no longer hold, and a
report.generated.html the program wrote before it wrote one file per language.

Writes: with --record, testdata/report/<protocol>-<operation>.json (or <protocol>-<operation>/
<instance>.json), testdata/abi/<entry>.json, and in the report's folder report.generated.md and,
for a template with notes.json, report.generated.en.html and report.generated.zh-TW.html in each
language the notes hold; --render writes report.generated.md and the HTML pages; otherwise nothing.
The folder is templates/<protocol>/<operation>/, or instances/<instance>/ under it. Every mode
downloads into vendor/ any pinned solc or Public Suffix List that is missing, and a live read the
ERC-7730 archive, before it reads a fact.
Keys: ALCHEMY_API_KEY and ETHERSCAN_API_KEY for a live read (not --offline or --render), from the
environment or $KISS_SIGN_HOME/.env. GITHUB_TOKEN is optional: sent only to api.github.com, it
raises GitHub's limit from 60 to 5,000 requests an hour and changes no answer.
Rules: docs/design/flow.md, "First time an operation is done: build its template", step 6 "Report".`;

exitOnHelp(HELP);

const { values: flags, positionals } = parseArgs({
  options: {
    'instance-of': { type: 'string' },
    vault: { type: 'string' },
    'vault-of': { type: 'string' },
    record: { type: 'boolean' },
    offline: { type: 'boolean' },
    render: { type: 'boolean' },
  },
  allowPositionals: true,
});
const [id] = positionals;
const removed = (['vault', 'vault-of'] as const).find((flag) => flags[flag] !== undefined);
if (removed !== undefined) {
  console.error(`REFUSED  --${removed} was removed; name an instance's report with <protocol>/<operation> --instance-of <instance>`);
  process.exit(2);
}
if (
  id === undefined ||
  positionals.length > 1 ||
  [flags.record, flags.offline, flags.render].filter(Boolean).length > 1
) {
  console.error(HELP);
  process.exit(2);
}
const target: TemplateTarget = { template: id, instance: flags['instance-of'] };

const root = join(import.meta.dirname, '..');
const fullRegistry = loadRegistry(root);

async function orRefuse<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ReportError || e instanceof NotesError || e instanceof UsageError)) throw e;
    console.error(`REFUSED  ${e.message}`);
    process.exit(2);
  }
}

const { subject, registry } = await orRefuse(() => loadReport(root, fullRegistry, target));
const mdFile = generatedPath(root, target);
const dir = reportDir(root, target);
if (!(await ensureVendored(['solc', 'psl']))) process.exit(1);
const suffixes = loadPublicSuffixList();
const compilers = cachedCompilers();

if (flags.offline) {
  process.stdout.write(await orRefuse(() => replayReport(root, fullRegistry, target, compilers, suffixes)));
  process.exit(0);
}

/** Writes the committed reports from the repository and the recordings alone. */
async function writeGenerated(): Promise<void> {
  const { inputs, title } = await replayInputs(root, fullRegistry, target, compilers, suffixes);
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, mdFile), renderReport(inputs, title));
  const pages = (await generatedHtml(root, inputs, title)) ?? new Map<Language, string>();
  for (const file of writeHtmlPages(join(root, dir), pages)) console.error(`removed ${file}, a page in no language ${NOTES_FILE} holds`);
  const written = [mdFile, ...[...pages.keys()].map((language) => join(dir, generatedHtmlFile(language)))];
  console.error(`wrote ${written.join(' and ')}`);
}

if (flags.render) {
  await orRefuse(writeGenerated);
  process.exit(0);
}

const pastTxs = await orRefuse(() => {
  const studied = pastTxsRecordings(root, subject).map(({ file, recording }) => summarizePastTxs(root, registry, file, recording));
  if (flags.record) requireJudged(root, subject, registry, studied);
  return studied;
});

const entries = entriesOf(subject, registry);
const endpoints = mainnetEndpoints(process.env);
const githubToken = readGithubToken(process.env);
const unread: string[] = [];
const note = (read: string) => void unread.push(read);
const reader = createReader(endpoints, httpsTransport(), { note });
const latest = await settledBlock(reader);
if (latest.kind === 'unverifiable') throw new Error(latest.reason);

/** Stops a recording as soon as a read got no answer, since it would be refused after the rest is read. */
function requireRead(): void {
  const refusal = flags.record === true ? unreadRefusal(unread) : undefined;
  if (refusal === undefined) return;
  console.error(refusal);
  process.exit(1);
}

/** Each DefiLlama or CoinGecko answer, read once and kept by path: the listings and the protocol facts share the protocol list. */
const answers = new Map<string, Promise<unknown>>();
const listing = (target: { readonly hostname: string; readonly path: string }): Promise<unknown> => {
  const answer = answers.get(target.path) ?? fetchListing(target, note);
  answers.set(target.path, answer);
  return answer;
};
const docs = subject.kind === 'template' ? subject.docs.map((d) => d.url) : [];
const get = retryingGet(httpsGet(githubToken), note);
const packages = await gatherPackages(entries, get);
const listings = await listingsFor(entries, suffixes, liveListingReads(note, githubToken, listing), [...entries.flatMap(pageUrlsOf), ...docs, ...provenanceRepositories(packages)]);
const creations = await liveCreations(entries, process.env, note, () => reader);
if ('missing' in creations) throw new MissingKeyError(keySpec('etherscan') as KeySpec);
const pages = {
  ...(await gatherSourcePages([...entries.flatMap(pageUrlsOf), ...docs], get, await gatherApiAnswers(entries, retryingSend(httpsApi, note)))),
  packages,
  creations,
};

requireRead();

const recorded = loadAbiCases(root);
const abi = new Map<Address, AbiProof | AbiRefusal>();
const abiCases = new Map<string, unknown>();
const deps = { etherscan: retryingEtherscan(etherscanFromEnv(process.env), note), compilers };
for (const entry of provedEntries(subject, registry)) {
  if (flags.record && !recorded.has(entry.address)) {
    const { proof, fixture } = await recordAbiCase(reader, entry.address, latest.value, latest.providers, deps, entry);
    abiCases.set(join(root, 'testdata', 'abi', `${entry.name.replace(/\./g, '-')}.json`), fixture);
    abi.set(entry.address, proof);
  } else abi.set(entry.address, await proveAbi(reader, entry.address, latest.value, deps, entry));
}

requireRead();

const alchemy = alchemyCall(httpsTransport(), endpoints[0].url, note);
const vaults = new Map<string, string>();
for (const vault of evidenceEntries(subject)) {
  console.error(`reading ${vault.name} at the latest block`);
  vaults.set(vault.name, (await vaultEvidenceText(reader, alchemy, registry, vault)).text);
}

if (!(await ensureVendored(['erc7730'], nodeVendorIoWith(githubToken)))) process.exit(1);
const snapshot = loadSnapshot();
if ('unavailable' in snapshot) {
  console.error(snapshot.unavailable);
  process.exit(1);
}
requireRead();
const codeChain = recordingTransport(httpsTransport(), endpoints);
const codeReader = createReader(endpoints, codeChain.transport, { note });
const spans = await checkSpans(codeReader, entries);
const today = await readToday(codeReader, subject, registry, latest.value);
const instances = await readInstances(codeReader, subject, registry, latest.value);
const erc7730Chain = recordingTransport(httpsTransport(), endpoints);
const erc7730 = await erc7730Text(entries, registry, snapshot, () => chainAt(createReader(endpoints, erc7730Chain.transport, { note })));

const factsChain = recordingTransport(httpsTransport(), endpoints);
const scope = subject.kind === 'template' ? factsScope(subject.template, registry, entries) : undefined;
const facts = scope === undefined ? undefined : await protocolFacts(scope, registry, { defillama: listing, reader: createReader(endpoints, factsChain.transport, { note }), block: latest.value });

const fetched = new Date();
const fixtures = await reportFixtures(root, subject, fullRegistry);
const live = { subject, registry, listings, pages, fetched: fetched.toISOString().slice(0, 10), abi, vaults, pastTxs, spans, today, instances, erc7730, facts, fixtures };
const command = `pnpm report ${reportArgs(subject)}`;
const text = renderReport(live, { command, sources: ['live reads at the time it ran', ...pastTxs.map((p) => p.file)] });

console.log(text);

if (flags.record) {
  requireRead();
  const erc7730Section = { commit: snapshot.commit, files: Object.fromEntries(trimErc7730(snapshot, erc7730.reports)), chain: erc7730Chain.exchanges() };
  const raw = new Map(await Promise.all([...answers].map(async ([path, answer]) => [path, await answer] as const)));
  const factsSection = scope === undefined ? {} : { facts: factsRecording(scope, latest.value, raw, factsChain.exchanges()) };
  const recording = recordingText({ ...trimReportRecording(subject, entries, listings, pages, fetched, vaults, erc7730Section, codeChain.exchanges(), today?.block, instances?.block), ...factsSection }, 2);
  const safe = loadStoredConfig(kissSignHome(process.env))?.safe;
  if (safe !== undefined && recording.toLowerCase().includes(safe.slice(2))) {
    console.error('the recording would name the configured Safe; nothing written');
    process.exit(1);
  }
  for (const [path, fixture] of abiCases) writeFileSync(path, recordingText(fixture, 2));
  mkdirSync(dirname(join(root, reportRecordingPath(target))), { recursive: true });
  writeFileSync(join(root, reportRecordingPath(target)), recording);
  console.error(`recorded ${reportRecordingPath(target)}`);
  await orRefuse(writeGenerated);
}
