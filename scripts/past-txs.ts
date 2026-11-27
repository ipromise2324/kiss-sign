import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MissingKeyError, mainnetEndpoints } from '../src/chain/providers.ts';
import type { Endpoint } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadStoredConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Registry } from '../src/registry.ts';
import { TX_PARTY_READS, WINDOWS, pastTxs } from '../src/research/past-txs.ts';
import { renderPastTxs } from '../src/research/past-txs-render.ts';
import { ANCHOR_KINDS, RANGE_PAGES, anchorEvent, eventArgText, eventArgTopic, indexedTopic, liveAsk, markedEvent, recordingAsk } from '../src/research/sources.ts';
import type { AnchorEvent, AnchorKind, EventArg, EventTopic, IndexedType } from '../src/research/sources.ts';
import { liveMessages, recordingMessages } from '../src/research/messages.ts';
import { httpsMessage } from '../src/verify/messages.ts';
import { DEFAULT_SAMPLING, MAX_PAGES, samplingFields, samplingOf, scrubRecording } from '../src/research/recording.ts';
import { safeExecutions, showSummary } from '../src/research/past-txs-show.ts';
import { RECORDINGS_DIR, SUMMARIES_DIR, parseSummary, staleParts, studyRecording, summaryFile } from '../src/research/past-txs-summary.ts';
import type { PastTxsSummary } from '../src/research/past-txs-summary.ts';
import { ReportError, anchorOutsideList, pastTxsRegistry, withoutUnlisted } from '../src/research/report.ts';
import { fillRecording } from '../src/research/fill-recording.ts';
import { progress } from '../src/research/progress.ts';
import { drpcTraces } from '../src/research/trace.ts';
import { traceAddressesText } from '../src/research/trace-addresses.ts';
import type { PastTxsRecording, Sampling } from '../src/research/recording.ts';
import { parseAddress } from '../src/safe/types.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { loadTemplate } from '../src/template/template.ts';
import { readRecording, recordingText } from '../src/chain/bytecode.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { parseFlags } from '../src/cli/flags.ts';
import { UsageError } from '../src/cli/io.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';

const USAGE = `usage: pnpm past-txs <protocol>/<operation>
  --token <registry name | address> --anchor mint|burn|any [--from <registry name | address>]
  [--to <registry name | address>]
  [--token <registry name | address>] --anchor event --event '<event signature>'
  [--event-arg <n>=<registry name | address | bytes32>]
  [--max-txs <n>] [--record <name>]
  [--from-block <n> --to-block <n> | --same-windows-as <name>]
       pnpm past-txs --restudy [<name>...]
       pnpm past-txs --show <name> [--tx <start of a hash>]

Finds executed transactions of one operation through an anchor: an ERC-20 Transfer of --token, or
an event (--anchor event), as one of the two forms above.
  deposit into a vault:   --token <vault> --anchor mint   (shares minted to the depositor)
  withdraw from a vault:  --token <vault> --anchor burn   (shares burned from the owner)
  transfer a token:       --token <token> --anchor any    (any transfer of the token)
  claim a reward:         --token <token> --anchor any --from <distributor>
                          (the distributor paying it out)
  supply to a market:     --token <loan token> --anchor any --to <lending>
                          (the loan token moving into Morpho Blue)
  move no token:          --token <contract> --anchor event
                          --event 'PreSignature(address,bytes,bool)'
                          (the contract logging the event)
  change a Safe itself:   --anchor event --event 'AddedOwner(address)'
                          (any contract logging it; studied only where the sending Safe did)
  approve one spender:    --token <token> --anchor event --event-arg 2=<spender>
                          --event 'Approval(address indexed owner, address indexed spender, uint256 value)'
                          (the token's approvals of that spender alone)
  swap in one v4 pool:    --token <PoolManager> --anchor event --event-arg 1=<pool id>
                          --event 'Swap(bytes32 indexed id, address indexed sender, int128 amount0,
                            int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)'
                          (that pool's swaps alone; Safes' execTransactions chosen first)
It reads every transaction of the anchor in one block range that ends 64 blocks below the head
and reaches back, newest first, to the start of the last year or until its block ranges have
taken ${MAX_PAGES} pages of 1000, each range counted by the source that took the most. It asks the whole
year first, then, when a range holds more than ${RANGE_PAGES} pages, a shorter one ending on the same
block, and after each range every source finished, the range below it. Alchemy
(alchemy_getAssetTransfers) and Etherscan (logs) search each range for a Transfer, and a range
counts only when both finished it; each transaction says which found it. Only Etherscan searches
an event: Alchemy's eth_getLogs reads at most 10 blocks at a time on the free plan. The report
says which blocks were read and, when the cap stopped the search, that the year's older
transactions were not. It reads each anchor party once at the range's last block for a Safe: the
address minted to, burned from, the side --from or --to leaves open, the contract that logged
an event with no --token, or, for an event --token logs, the address the transaction sent
execTransaction to, read from at most ${TX_PARTY_READS} of the transactions taken evenly, so an
EOA's call to a router has none. It studies every transaction with a Safe party, leaving the rest
Math.ceil(--max-txs / 4) places, and fills the remaining places from the rest, each taken evenly
in block order. When an adapter or bundler moves the token, the party checked is that contract,
so no Safe is found and the choice is the even sample.
It writes a line on stderr every 10 seconds: how many pages, answers and traces it has read.
--same-windows-as places the search by the head block the summary testdata/research/<name>.json
keeps instead of today's, and searches as that run did, so a run again reads the same blocks; a
summary recorded before this search replays its year and 12 windows. --from-block and --to-block
replace the search with one range.
A signed message the template names by its digest, such as a CoW order, is read from the
template's lookup.
For each free number the template leaves, and each withinSeconds time it bounds, it prints the
spread of values, less the block's time for a time.
Senders are counted by type: a proven Safe (Safe proxy code and an official singleton), a
contract that is not a proven Safe, and an EOA making one of the template's calls directly.
The Safe in $KISS_SIGN_HOME/config.json is left out of every count and example, and its address out
of every recording; a recording keeps its transactions' place and hash.`;
const HELP = `${USAGE}
--record keeps two files. The full recording, every answer the run read with the configured
Safe's address taken out, goes to .cache/past-txs/<name>.json, which git ignores. The summary,
studied again from that recording, goes to testdata/research/<name>.json: the query, how many
transactions the search found, the hashes only one source found, each studied transaction's
result, amounts and call traces, and the hashes of the template, the registry entries the study
can read and the study code it was studied with. pnpm test fails when one of those hashes differs
from the checkout's; --restudy then studies each named recording in .cache/past-txs/ again, every
one when none is named, with the template, registry and code of the checkout, and rewrites its
summary. It reads live, with the Alchemy and dRPC keys, only what the recording lacks, such as the
call trace, the run alone or the signed message of a transaction that fits only now, and adds those
answers to the recording; never the search or its party checks. It writes nothing when such a read
gets no answer, when its answer holds the configured Safe's address, or, without those keys, when
the recording lacks any read. To change the search, --max-txs or the sampling, run --record again.
A computer without the recording runs the command of the report again, with --same-windows-as.
One run at a time writes a recording: --record and --restudy hold .cache/past-txs/<name>.lock, and
write the recording and its summary each to a file beside it first, then rename both into place.
Per field it prints how many transactions and senders held the template's rule, and the misfits
grouped by reason. For each fitting transaction it runs the transaction alone on its parent block
and compares each stated amount with the balances, printing FINDING for a sender's difference
beyond the effect's tolerance in a registry token, or a tolerance no difference supports.
For each transaction exactly the template it reads the call trace from drpc alone
(debug_traceTransaction with callTracer), and checks the trace's token transfers and
approvals against the receipt both providers agree on; --record keeps each trace cut down to each
call's depth, type, from, to, selector, value, whether it reverted, and the address arguments of a
transfer, transferFrom, approve or permit.
Then it prints every address the traces show moving the sender's money whose code verify does not
check for the transaction's card, outside the registry or registered but not reached through
dependsOn: per template call, which token moved which way, in how many transactions and one's hash.
It always says over how many traces, and how many transactions have none that counts. Register each
fixed contract and list it in dependsOn, or judge it in the trace-addresses.json beside the report;
pnpm report --record refuses while one is neither. Where the card chooses among several tokens both
given and got, it prints in how many traced transactions each moved, so a sample of one direction
shows; --restudy prints both too.

Options:
  --token <name | address>       The anchor token, or the contract that logs --event; left out for
                                 an event each Safe logs about itself.
  --anchor mint|burn|any|event   Which Transfer marks a transaction, or the event.
  --from, --to <name | address>  With --anchor any: only transfers out of, or into, the address.
  --event '<signature>'          With --anchor event: the event signature.
  --event-arg <n>=<name | address | bytes32>
                                 With --anchor event: only logs whose argument n, counted from 1,
                                 holds that value. --event must mark the argument indexed and it
                                 must be an address (a registry name or 0x and 40 hex digits) or
                                 a bytes32 (0x and 64 hex digits), such as a v4 pool id; Etherscan
                                 then filters by its topic, so the page cap reaches further back.
                                 One per search; a second --event-arg is refused.
                                 The summary keeps the signature with its indexed arguments marked.
  --max-txs <n>                  Transactions to study, 240 unless given, at least 12 without
                                 --from-block and --to-block, at least 1 with them.
  --from-block, --to-block <n>   Search one block range in place of the program's search, for
                                 debugging the search; a template's research never passes them.
  --same-windows-as <name>       Search the blocks testdata/research/<name>.json searched again.
  --record <name>                Write .cache/past-txs/<name>.json and testdata/research/<name>.json;
                                 nothing is written when a read got no answer.
  --restudy [<name>...]          Rewrite each testdata/research/<name>.json from
                                 .cache/past-txs/<name>.json, reading live only what it lacks,
                                 with ALCHEMY_API_KEY and DRPC_API_KEY.
  --show <name>                  Print the recorded summary testdata/research/<name>.json, reading
                                 nothing live: its query, how many transactions ended each way,
                                 then each with its hash, block, sender and why it does not fit.
  --tx <start of a hash>         With --show: only that transaction, with every value the study
                                 read and its traced calls; for a Safe's, when its recording
                                 .cache/past-txs/<name>.json is on this computer, the Safe nonce
                                 and safeTxHash, from its recorded input and ExecutionSuccess log,
                                 which pnpm record-safe-tx takes. A fit also prints the card
                                 it implies, as pnpm template implied-card prints a fixture's;
                                 an EOA's of the one call it made, with safe the EOA; pnpm
                                 record-eoa-tx records an EOA's for a test when no Safe's fits.

Writes: .cache/past-txs/<name>.json and testdata/research/<name>.json with --record and --restudy;
otherwise nothing.
Keys: ALCHEMY_API_KEY, DRPC_API_KEY and ETHERSCAN_API_KEY, from the environment or
  $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 4,
  Study past transactions, Call traces).`;

const ROOT = join(import.meta.dirname, '..');

exitOnHelp(HELP);
refuseReadableErrors(64);

const { values: flags, positionals } = parseFlags({
  allowPositionals: true,
  options: {
    token: { type: 'string' },
    anchor: { type: 'string' },
    'from-block': { type: 'string' },
    'to-block': { type: 'string' },
    'same-windows-as': { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    event: { type: 'string' },
    'event-arg': { type: 'string' },
    'max-txs': { type: 'string', default: '240' },
    record: { type: 'string' },
    restudy: { type: 'boolean' },
    show: { type: 'string' },
    tx: { type: 'string' },
  },
});
if (flags.restudy === true && flags.show !== undefined) throw new UsageError('use --restudy or --show, not both');
if (flags.tx !== undefined && flags.show === undefined) throw new UsageError('--tx names one transaction of --show <name>');

/** Why the values of the summary `name` no longer pair with the checkout's rules, or undefined while they do. */
function unpaired(name: string, summary: PastTxsSummary, registry: Registry): string | undefined {
  try {
    const stale = staleParts(ROOT, pastTxsRegistry(ROOT, registry, summary.query), summary);
    return stale.length === 0 ? undefined : `the ${stale.join(' and the ')} changed since it was studied, so the values no longer pair with the rules; run pnpm past-txs --restudy ${name}`;
  } catch (error) {
    if (error instanceof ReportError) return `${error.message}, so the values cannot be paired with the rules`;
    throw error;
  }
}

/** The configured Safe, whose address no file this command writes may hold. */
function configuredSafe(): Address | undefined {
  const safe = loadStoredConfig(kissSignHome(process.env))?.safe;
  if (safe === undefined) console.error(`no Safe configured in ${kissSignHome(process.env)}, so nothing is excluded`);
  return safe;
}

function checkedSummary(name: string, summary: PastTxsSummary, safe: Address | undefined): { readonly path: string; readonly text: string } {
  try {
    return summaryFile(name, summary, safe);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

/**
 * Holds `.cache/past-txs/<name>.lock` until the process exits, so no two runs read or write one recording and its
 * summary at once.
 */
function holdRecording(name: string): void {
  const lock = join(ROOT, RECORDINGS_DIR, `${name}.lock`);
  mkdirSync(join(ROOT, RECORDINGS_DIR), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    console.error(`${join(RECORDINGS_DIR, `${name}.lock`)}: another past-txs run is writing ${name}; wait for it, or remove the folder when none is running`);
    process.exit(1);
  }
  process.on('exit', () => rmSync(lock, { recursive: true, force: true }));
}

/** Writes each file beside its place first, then renames each into place, so no file is left half written. */
function publish(files: readonly { readonly path: string; readonly text: string }[]): void {
  const staged = files.map(({ path, text }) => {
    const full = join(ROOT, path);
    mkdirSync(dirname(full), { recursive: true });
    const temp = `${full}.${process.pid}.tmp`;
    writeFileSync(temp, text);
    return { temp, full };
  });
  for (const { temp, full } of staged) renameSync(temp, full);
}

if (flags.restudy === true) {
  const names = positionals.length > 0 ? positionals : readdirSync(join(ROOT, RECORDINGS_DIR)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
  const registry = loadRegistry(ROOT);
  const safe = configuredSafe();
  let endpoints: readonly [Endpoint, Endpoint] | undefined;
  let noKeys: string | undefined;
  try {
    endpoints = mainnetEndpoints(process.env);
  } catch (error) {
    if (!(error instanceof MissingKeyError)) throw error;
    noKeys = error.message;
  }
  for (const name of names) {
    const recordingPath = join(RECORDINGS_DIR, `${name}.json`);
    if (!/^[a-z0-9-]+$/.test(name) || !existsSync(join(ROOT, recordingPath))) {
      console.error(`--restudy ${name}: no recording ${recordingPath}`);
      process.exit(64);
    }
    holdRecording(name);
    const recording = readRecording(join(ROOT, recordingPath)) as PastTxsRecording;
    const studied = pastTxsRegistry(ROOT, registry, recording.query);
    const unread: string[] = [];
    const note = (read: string) => void unread.push(read);
    const live =
      endpoints === undefined ? undefined
      : { endpoints, transport: httpsTransport(), traces: drpcTraces(endpoints[1], httpsTransport(), note), messages: recordingMessages(liveMessages(httpsMessage, note)), unread: () => unread };
    const filled = await fillRecording(ROOT, recording, studied, live, safe);
    if (filled.kind === 'lacking') {
      const reads = filled.reads.map((read) => `  ${read}`).join('\n');
      console.error(`--restudy ${name}: the study needs ${filled.reads.length} read(s) ${recordingPath} lacks, so nothing is written:\n${reads}${noKeys === undefined ? '' : `\n${noKeys}`}`);
      process.exit(1);
    }
    const summary = await studyRecording(ROOT, filled.recording, studied);
    const summaryOut = checkedSummary(name, summary, safe);
    const changed = filled.recording !== recording;
    publish([...(changed ? [{ path: recordingPath, text: recordingText(filled.recording, 1) }] : []), summaryOut]);
    if (changed) console.log(`read live what ${recordingPath} lacked and added it there: ${filled.read.chain} chain requests, ${filled.read.traces} call traces, ${filled.read.messages} signed messages`);
    console.log(`wrote ${summaryOut.path}`);
    process.stdout.write(traceAddressesText(loadTemplate(ROOT, recording.query.template, studied), studied, summary));
    rmSync(join(ROOT, RECORDINGS_DIR, `${name}.lock`), { recursive: true, force: true });
  }
  process.exit(0);
}
if (flags.show !== undefined) {
  const path = join(ROOT, SUMMARIES_DIR, `${flags.show}.json`);
  if (!/^[a-z0-9-]+$/.test(flags.show) || !existsSync(path)) {
    console.error(`--show ${flags.show}: no summary ${join(SUMMARIES_DIR, `${flags.show}.json`)}`);
    process.exit(64);
  }
  const summary = parseSummary(join(SUMMARIES_DIR, `${flags.show}.json`), readFileSync(path, 'utf8'));
  const registry = loadRegistry(ROOT);
  const recordingPath = join(ROOT, RECORDINGS_DIR, `${flags.show}.json`);
  const shownHashes = flags.tx === undefined ? [] : summary.studies.filter((s) => s.hash.startsWith(flags.tx?.toLowerCase() ?? '') && 'sender' in s && s.sender.kind === 'safe').map((s) => s.hash);
  const executions = shownHashes.length > 0 && existsSync(recordingPath) ? await safeExecutions((readRecording(recordingPath) as PastTxsRecording).exchanges, shownHashes) : new Map<Hex, string>();
  const shownTemplate = loadTemplate(ROOT, summary.query.template, registry);
  const stale = flags.tx === undefined ? undefined : unpaired(flags.show, summary, registry);
  const text = showSummary(summary, shownTemplate, withoutUnlisted(registry, shownTemplate), flags.tx, executions, stale);
  if (text === '') {
    console.error(`--tx ${flags.tx}: the summary studied no such transaction`);
    process.exit(64);
  }
  await new Promise((done) => process.stdout.write(text, done));
  process.exit(0);
}
const [templateId] = positionals;
const kind = ANCHOR_KINDS.find((k) => k === flags.anchor) as AnchorKind | undefined;
const block = (raw: string | undefined) => (raw !== undefined && /^[0-9]+$/.test(raw) ? BigInt(raw) : undefined);
const [fromBlock, toBlock] = [block(flags['from-block']), block(flags['to-block'])];
const range = fromBlock !== undefined && toBlock !== undefined && fromBlock <= toBlock ? { fromBlock, toBlock } : undefined;
const byHand = flags['from-block'] !== undefined || flags['to-block'] !== undefined;
const maxTxs = Number(flags['max-txs']);
if (templateId === undefined || positionals.length !== 1 || (flags.token === undefined && kind !== 'event') || kind === undefined || (byHand && range === undefined) || (flags['same-windows-as'] !== undefined && byHand) || !(Number.isInteger(maxTxs) && maxTxs >= 1)) {
  console.error(USAGE);
  process.exit(64);
}
if (range === undefined && maxTxs < WINDOWS.count) {
  console.error(`--max-txs must be at least ${WINDOWS.count}, one transaction per window`);
  process.exit(64);
}
for (const flag of ['from', 'to'] as const) {
  if (flags[flag] !== undefined && kind !== 'any') {
    console.error(`--${flag} goes with --anchor any`);
    process.exit(64);
  }
}
if ((kind === 'event') !== (flags.event !== undefined)) {
  console.error('--event goes with --anchor event, and --anchor event needs --event');
  process.exit(64);
}
let event: AnchorEvent | undefined;
try {
  event = flags.event === undefined ? undefined : anchorEvent(flags.event);
} catch (error) {
  console.error(`--event: ${(error as Error).message}`);
  process.exit(64);
}
const fullRegistry = loadRegistry(ROOT);
const eventArg = flags['event-arg'] === undefined ? undefined : eventArgOf(flags['event-arg'], flags.event);

/**
 * `--event-arg <n>=<registry name | address | bytes32>`: the argument as the summary keeps it and the topic it filters
 * by. A registry name stands for its address; a value whose length is not the argument type's is refused.
 */
function eventArgOf(raw: string, signature: string | undefined): { readonly arg: EventArg; readonly topic: EventTopic } {
  const refuse = (why: string): never => {
    console.error(`--event-arg ${raw}: ${why}`);
    process.exit(64);
  };
  if (kind !== 'event' || signature === undefined) return refuse('goes with --anchor event and --event');
  const match = /^([1-9][0-9]*)=(.+)$/.exec(raw);
  if (match === null) return refuse('takes <argument number>=<registry name | address | bytes32>, such as 2=permit2');
  const position = Number(match[1]);
  const value = match[2] as string;
  let type: IndexedType;
  try {
    type = indexedTopic(signature, position).type;
  } catch (error) {
    return refuse((error as Error).message);
  }
  const named = fullRegistry.entries.get(value)?.address;
  if (named === undefined && !/^0x[0-9a-fA-F]*$/.test(value)) return refuse(`${value} is neither a registry name nor an address or a bytes32`);
  const arg: EventArg = type === 'address' ? { position, address: (named ?? value).toLowerCase() } : { position, bytes32: (named ?? value).toLowerCase() };
  try {
    return { arg, topic: eventArgTopic(signature, arg) };
  } catch (error) {
    return refuse((error as Error).message);
  }
}
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new UsageError('--record takes a name of lowercase letters, digits and -');
if (flags.record !== undefined) holdRecording(flags.record);
const sameAs = flags['same-windows-as'] === undefined ? undefined : recordedSearch(flags['same-windows-as']);

function recordedSearch(name: string): Sampling {
  const path = join(ROOT, SUMMARIES_DIR, `${name}.json`);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(path)) {
    console.error(`--same-windows-as ${name}: no summary ${join(SUMMARIES_DIR, `${name}.json`)}`);
    process.exit(64);
  }
  const summary = parseSummary(join(SUMMARIES_DIR, `${name}.json`), readFileSync(path, 'utf8'));
  const sampling = samplingOf(summary.query);
  if (sampling.kind === 'range' || summary.head === undefined) {
    console.error(`--same-windows-as ${name}: the summary searched one block range and keeps no head block, so it has no windows to search again`);
    process.exit(64);
  }
  const recorded = summary.query.eventArg;
  if (JSON.stringify(recorded) !== JSON.stringify(eventArg?.arg)) {
    console.error(`--same-windows-as ${name}: the summary searched ${recorded === undefined ? 'with no --event-arg' : `with --event-arg ${eventArgText(recorded)}`}; give the same`);
    process.exit(64);
  }
  return { ...sampling, head: summary.head };
}

const token = flags.token === undefined ? undefined : (fullRegistry.entries.get(flags.token)?.address ?? parseAddress('--token', flags.token));
const from = flags.from === undefined ? undefined : (fullRegistry.entries.get(flags.from)?.address ?? parseAddress('--from', flags.from));
const to = flags.to === undefined ? undefined : (fullRegistry.entries.get(flags.to)?.address ?? parseAddress('--to', flags.to));
const registry = studyRegistry();
const template = loadTemplate(ROOT, templateId, registry);
const outside = anchorOutsideList({ ...(token === undefined ? {} : { token }), anchor: kind as string, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), ...(eventArg === undefined ? {} : { eventArg: eventArg.arg }) }, template, fullRegistry);
if (outside?.kind === 'unlisted') {
  console.error(`${outside.why}; list it in the template's card field first`);
  process.exit(64);
}
if (outside?.kind === 'unregistered') console.error(`warning: ${outside.why}; its report will not include this search`);
const exclude = configuredSafe();

/**
 * The registry the report reads this search's summary with, which for a template reported per vault holds that vault
 * alone of those its field accepts, so the run printed here is the one --record commits. A search --record cannot
 * commit is refused before any read; one that writes nothing falls back to the whole registry.
 */
function studyRegistry(): Registry {
  try {
    return pastTxsRegistry(ROOT, fullRegistry, { template: templateId as string, ...(token === undefined ? {} : { token }), anchor: kind as AnchorKind, maxTxs });
  } catch (error) {
    if (!(error instanceof ReportError)) throw error;
    if (flags.record === undefined) return fullRegistry;
    console.error(`--record ${flags.record}: ${error.message}`);
    process.exit(64);
  }
}

/** An event a named contract logs has no party of its own; each transaction's execTransaction names the Safe. */
const txParty = kind === 'event' && token !== undefined;
const endpoints = mainnetEndpoints(process.env);
const shown = progress((line) => void process.stderr.write(line));
const chain = recordingTransport(shown.transport(httpsTransport()), endpoints);
const unread: string[] = [];
const note = (read: string) => void unread.push(read);
const sources = recordingAsk(shown.ask(liveAsk(process.env, note)));
const messages = recordingMessages(liveMessages(httpsMessage, note));
const reader = createReader(endpoints, chain.transport, { note });
const batches = createReader(endpoints, chain.transport);
const traces = drpcTraces(endpoints[1], httpsTransport(), note);
const query = {
  template,
  anchor: {
    ...(token === undefined ? {} : { token }),
    kind,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(event === undefined ? {} : { event }),
    ...(eventArg === undefined ? {} : { topic: eventArg.topic }),
  },
  sampling: range !== undefined ? ({ kind: 'range', range } as const) : (sameAs ?? DEFAULT_SAMPLING),
  ...(txParty ? { txParty: true as const } : {}),
};
const run = await pastTxs(query, {
  ask: sources.ask,
  reader,
  batches,
  registry,
  readMessage: messages.read,
  exclude,
  maxTxs,
  traces: shown.traces(traces.source),
});
shown.stop();
process.stdout.write(renderPastTxs(run, withoutUnlisted(registry, template)));
process.stdout.write(traceAddressesText(template, registry, run));

if (flags.record !== undefined) {
  const refusal = unreadRefusal(unread);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exit(1);
  }
  const providers = endpoints.map((e) => e.provider);
  const fixture = scrubRecording(
    {
      query: {
        template: templateId,
        ...(token === undefined ? {} : { token }),
        anchor: kind,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(event === undefined ? {} : { event: eventArg === undefined ? event.signature : markedEvent(flags.event as string) }),
        ...(eventArg === undefined ? {} : { eventArg: eventArg.arg }),
        ...(txParty ? { txParty: true as const } : {}),
        ...samplingFields(query.sampling, run.head),
        maxTxs,
      },
      sources: sources.exchanges(),
      messages: messages.exchanges(),
      providers,
      exchanges: chain.exchanges().filter((e) => providers.every((p) => p in e.answers)),
      traces: traces.recorded(),
    },
    exclude === undefined ? [] : [exclude],
    run.excluded,
  );
  const summary = checkedSummary(flags.record, await studyRecording(ROOT, fixture, registry), exclude);
  const recordingPath = join(RECORDINGS_DIR, `${flags.record}.json`);
  publish([{ path: recordingPath, text: recordingText(fixture, 1) }, summary]);
  console.log(`wrote ${join(ROOT, recordingPath)}: ${fixture.sources.length} source answers, ${fixture.exchanges.length} chain requests, ${fixture.traces?.length ?? 0} call traces`);
  console.log(`wrote ${summary.path}`);
}
