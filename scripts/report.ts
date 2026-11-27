import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadStoredConfig } from '../src/config.ts';
import { keySpec, kissSignHome } from '../src/keys.ts';
import { MissingKeyError, mainnetEndpoints } from '../src/chain/providers.ts';
import type { KeySpec } from '../src/keys.ts';
import { liveCreations } from '../src/research/deployer.ts';
import { gatherPackages, provenanceRepositories } from '../src/research/npm-package.ts';
import { createReader } from '../src/chain/reader.ts';
import { askAgain, BlockReplacedError } from '../src/research/ask-again.ts';
import { keptEtherscan, keptGet, keptHints, keptSend, keptTransport } from '../src/research/kept.ts';
import { warmReport } from '../src/research/report-warm.ts';
import type { ReportSources } from '../src/research/report-warm.ts';
import type { Reader } from '../src/chain/reader.ts';
import type { BlockRef } from '../src/chain/types.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import type { NoteUnread } from '../src/chain/https.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadAbiCases, recordAbiCase } from '../src/contracts/abi-case.ts';
import { proveAbi } from '../src/contracts/prove.ts';
import type { AbiProof, AbiRefusal } from '../src/contracts/prove.ts';
import { compilersAhead } from '../src/contracts/solc.ts';
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
  replayAbiProofs,
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
import { isLanguage } from '../src/language.ts';
import type { Language } from '../src/language.ts';
import { pageText } from '../src/research/page-text.ts';
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
import { parseFlags } from '../src/cli/flags.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';

const USAGE = `usage: pnpm report <protocol>/<operation> [--instance-of <instance>] [--record]
       pnpm report <protocol>/<operation> [--instance-of <instance>] (--offline | --render)
       pnpm report <protocol>/<operation> [--instance-of <instance>] --text <en | zh-TW>`;
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
It reads the chain at the block 8 behind the head, which a reorganization is unlikely to replace
while it reads, except that an instance's evidence is read at the latest block and each code pin's
span at the span's own blocks.
Reads go out several at a time, and an answer is kept while the command runs.
A read with no answer is asked again after each pause; one still without an answer prints as
UNVERIFIABLE, never as FINDING, and --record then stops after that section and writes nothing.
The command is refused when a block it reads at is replaced before it asks a chain read again.
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
  --text <en | zh-TW>       print the HTML page --render last wrote in that language as plain text,
                            what the signer reads, each block on a line and each link's address
                            after its text; it reads that file alone, so --render first
Use at most one of --record, --offline, --render and --text.
--record and --render remove a page in a language the notes no longer hold, and a
report.generated.html the program wrote before it wrote one file per language.

Writes: with --record, testdata/report/<protocol>-<operation>.json (or <protocol>-<operation>/
<instance>.json), testdata/abi/<entry>.json, and in the report's folder report.generated.md and,
for a template with notes.json, report.generated.en.html and report.generated.zh-TW.html in each
language the notes hold; --render writes report.generated.md and the HTML pages; otherwise nothing.
The folder is templates/<protocol>/<operation>/, or instances/<instance>/ under it. Every mode but
--text downloads into vendor/ any pinned solc or Public Suffix List that is missing, and a live
read the ERC-7730 archive, before it reads a fact; --text reads the page alone, not the registry,
the template or notes.json, so a draft mid-edit does not stop it.
Keys: ALCHEMY_API_KEY and ETHERSCAN_API_KEY for a live read (not --offline or --render), from the
environment or $KISS_SIGN_HOME/.env. GITHUB_TOKEN is optional: sent only to api.github.com, it
raises GitHub's limit from 60 to 5,000 requests an hour and changes no answer.
Rules: docs/design/flow.md, "First time an operation is done: build its template", step 6 "Report".`;

exitOnHelp(HELP);
refuseReadableErrors();

const { values: flags, positionals } = parseFlags({
  options: {
    'instance-of': { type: 'string' },
    vault: { type: 'string' },
    'vault-of': { type: 'string' },
    record: { type: 'boolean' },
    offline: { type: 'boolean' },
    render: { type: 'boolean' },
    text: { type: 'string' },
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
  [flags.record, flags.offline, flags.render, flags.text !== undefined].filter(Boolean).length > 1
) {
  console.error(HELP);
  process.exit(2);
}
const target: TemplateTarget = { template: id, instance: flags['instance-of'] };

const root = join(import.meta.dirname, '..');
if (flags.text !== undefined) {
  if (!isLanguage(flags.text)) {
    console.error('--text takes en or zh-TW, the language of the page');
    process.exit(2);
  }
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id) || (target.instance !== undefined && !/^[a-z0-9-]+$/.test(target.instance))) {
    console.error('--text names a report as <protocol>/<operation> [--instance-of <instance>], lowercase letters, digits and -');
    process.exit(2);
  }
  const page = join(reportDir(root, target), generatedHtmlFile(flags.text));
  if (!existsSync(join(root, page))) {
    console.error(`REFUSED  no ${page}; run pnpm report ${id}${target.instance === undefined ? '' : ` --instance-of ${target.instance}`} --render first`);
    process.exit(1);
  }
  await new Promise((done) => process.stdout.write(pageText(readFileSync(join(root, page), 'utf8')), done));
  process.exit(0);
}
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
const { compilers, ahead } = compilersAhead();

if (flags.offline || flags.render) {
  const proved = provedEntries(subject, registry);
  await ahead((trial) => replayAbiProofs(proved, loadAbiCases(root), trial));
}
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
const asking = createReader(endpoints, httpsTransport());
const latest = await settledBlock(asking);
if (latest.kind === 'unverifiable') throw new Error(latest.reason);
const head = evidenceEntries(subject).length === 0 ? latest : await asking.block('latest');
if (head.kind === 'unverifiable') throw new Error(head.reason);
const blocks = { settled: latest.value, head: head.value };

/** Stops a recording as soon as a read got no answer, since it would be refused after the rest is read. */
function requireRead(): void {
  const refusal = flags.record === true ? unreadRefusal(unread) : undefined;
  if (refusal === undefined) return;
  console.error(refusal);
  process.exit(1);
}

/**
 * Runs a section that reads the chain at `at`, asking again only its reads that got no answer, and refuses when a block
 * it reads at was replaced or cannot be confirmed. A section that reads only blocks a reorganization does not reach,
 * such as a creation's, names none.
 */
async function section<T>(at: readonly BlockRef[], run: () => Promise<T>): Promise<T> {
  try {
    const value = await askAgain(unread, asking, at, run);
    requireRead();
    return value;
  } catch (e) {
    requireRead();
    if (!(e instanceof BlockReplacedError)) throw e;
    console.error(`REFUSED  ${e.message}`);
    process.exit(1);
  }
}

/** Each DefiLlama or CoinGecko answer, read once and kept by path: the listings and the protocol facts share the protocol list. */
const answers = new Map<string, Promise<unknown>>();
const listing = (noting: NoteUnread) => (target: { readonly hostname: string; readonly path: string }): Promise<unknown> => {
  const known = answers.get(target.path);
  if (known !== undefined) return known;
  const answer = fetchListing(target, noting);
  answers.set(target.path, answer);
  answer.catch(() => answers.delete(target.path));
  return answer;
};
const transport = keptTransport(httpsTransport());
const [rawGet, rawSend, rawEtherscan] = [keptGet(httpsGet(githubToken)), keptSend(httpsApi), keptEtherscan(etherscanFromEnv(process.env))];
const hints = keptHints();
/** With no `pausesMs`, a web read that gets no answer is asked again after each of the usual pauses. */
const sourcesNoting = (noting: NoteUnread, pausesMs?: readonly number[]): ReportSources => {
  const get = retryingGet(rawGet, noting, pausesMs);
  const reader = createReader(endpoints, transport, { note: noting });
  return {
    reader,
    get,
    send: retryingSend(rawSend, noting, pausesMs),
    listings: liveListingReads(noting, githubToken, listing(noting), get),
    etherscan: retryingEtherscan(rawEtherscan, noting),
    alchemy: alchemyCall(transport, endpoints[0].url, noting),
    creations: () => liveCreations(entries, process.env, noting, () => reader, hints),
  };
};
const { reader, get, send, listings: listingReads, etherscan, alchemy, creations: readCreations } = sourcesNoting(note);
await warmReport(sourcesNoting(() => {}, []), subject, registry, suffixes, blocks, ahead);

const docs = subject.kind === 'template' ? subject.docs.map((d) => d.url) : [];
const packages = await gatherPackages(entries, get);
const listings = await listingsFor(entries, suffixes, listingReads, [...entries.flatMap(pageUrlsOf), ...docs, ...provenanceRepositories(packages)]);
const creations = await section([], readCreations);
if ('missing' in creations) throw new MissingKeyError(keySpec('etherscan') as KeySpec);
const pages = {
  ...(await gatherSourcePages([...entries.flatMap(pageUrlsOf), ...docs], get, await gatherApiAnswers(entries, send))),
  packages,
  creations,
};

requireRead();

const recorded = loadAbiCases(root);
const abi = new Map<Address, AbiProof | AbiRefusal>();
const abiCases = new Map<string, unknown>();
const deps = { etherscan, compilers };
for (const entry of provedEntries(subject, registry)) {
  if (flags.record && !recorded.has(entry.address)) {
    const { proof, fixture } = await section([blocks.settled], () => recordAbiCase(reader, entry.address, latest.value, latest.providers, deps, entry));
    abiCases.set(join(root, 'testdata', 'abi', `${entry.name.replace(/\./g, '-')}.json`), fixture);
    abi.set(entry.address, proof);
  } else abi.set(entry.address, await section([blocks.settled], () => proveAbi(reader, entry.address, latest.value, deps, entry)));
}

const vaults = new Map<string, string>();
for (const vault of evidenceEntries(subject)) {
  console.error(`reading ${vault.name} at the latest block`);
  vaults.set(vault.name, (await section([blocks.head], () => vaultEvidenceText(reader, alchemy, registry, vault, head.value.number))).text);
}

if (!(await ensureVendored(['erc7730'], nodeVendorIoWith(githubToken)))) process.exit(1);
const snapshot = loadSnapshot();
if ('unavailable' in snapshot) {
  console.error(snapshot.unavailable);
  process.exit(1);
}
/** Runs a section whose chain answers the recording keeps, in the order it asked: its last run's alone. */
async function recordedSection<T>(run: (reader: Reader) => Promise<T>): Promise<{ readonly read: T; readonly exchanges: Exchange[] }> {
  return section([blocks.settled], async () => {
    const chain = recordingTransport(transport, endpoints);
    const read = await run(createReader(endpoints, chain.transport, { note }));
    return { read, exchanges: chain.exchanges() };
  });
}
const {
  read: { spans, today, instances },
  exchanges: codeExchanges,
} = await recordedSection(async (r) => ({
  spans: await checkSpans(r, entries),
  today: await readToday(r, subject, registry, latest.value),
  instances: await readInstances(r, subject, registry, latest.value),
}));
const { read: erc7730, exchanges: erc7730Exchanges } = await recordedSection((r) => erc7730Text(entries, registry, snapshot, () => chainAt(r, latest.value)));

const scope = subject.kind === 'template' ? factsScope(subject.template, registry, entries) : undefined;
const { read: facts, exchanges: factsExchanges } = await recordedSection(async (r) => (scope === undefined ? undefined : protocolFacts(scope, registry, { defillama: listingReads.list, reader: r, block: latest.value })));

const fetched = new Date();
const fixtures = await reportFixtures(root, subject, fullRegistry);
const live = { subject, registry, listings, pages, fetched: fetched.toISOString().slice(0, 10), abi, vaults, pastTxs, spans, today, instances, erc7730, facts, fixtures };
const command = `pnpm report ${reportArgs(subject)}`;
const text = renderReport(live, { command, sources: ['live reads at the time it ran', ...pastTxs.map((p) => p.file)] });

console.log(text);

if (flags.record) {
  const erc7730Section = { commit: snapshot.commit, block: { number: latest.value.number.toString(), hash: latest.value.hash }, files: Object.fromEntries(trimErc7730(snapshot, erc7730.reports)), chain: erc7730Exchanges };
  const raw = new Map(await Promise.all([...answers].map(async ([path, answer]) => [path, await answer] as const)));
  const factsSection = scope === undefined ? {} : { facts: factsRecording(scope, latest.value, raw, factsExchanges) };
  const recording = recordingText({ ...trimReportRecording(subject, entries, listings, pages, fetched, vaults, erc7730Section, codeExchanges, today?.block, instances?.block), ...factsSection }, 2);
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
