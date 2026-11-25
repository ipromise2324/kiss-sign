import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadStoredConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Registry } from '../src/registry.ts';
import { WINDOWS, pastTxs } from '../src/research/past-txs.ts';
import { renderPastTxs } from '../src/research/past-txs-render.ts';
import { ANCHOR_KINDS, RANGE_PAGES, anchorEvent, liveAsk, recordingAsk } from '../src/research/sources.ts';
import type { AnchorEvent, AnchorKind } from '../src/research/sources.ts';
import { liveMessages, recordingMessages } from '../src/research/messages.ts';
import { httpsMessage } from '../src/verify/messages.ts';
import { DEFAULT_SAMPLING, MAX_PAGES, samplingFields, samplingOf, scrubRecording } from '../src/research/recording.ts';
import { RECORDINGS_DIR, SUMMARIES_DIR, parseSummary, studyRecording, summaryFile } from '../src/research/past-txs-summary.ts';
import type { PastTxsSummary } from '../src/research/past-txs-summary.ts';
import { ReportError, pastTxsRegistry } from '../src/research/report.ts';
import { progress } from '../src/research/progress.ts';
import { drpcTraces } from '../src/research/trace.ts';
import { traceAddressesText } from '../src/research/trace-addresses.ts';
import type { PastTxsRecording, Sampling } from '../src/research/recording.ts';
import { parseAddress } from '../src/safe/types.ts';
import type { Address } from '../src/safe/types.ts';
import { loadTemplate } from '../src/template/template.ts';
import { readRecording, recordingText } from '../src/chain/bytecode.ts';
import { RETRY_PAUSES_MS, unreadRefusal } from '../src/chain/https.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = `usage: pnpm past-txs <protocol>/<operation>
  --token <registry name | address> --anchor mint|burn|any [--from <registry name | address>]
  [--to <registry name | address>]
  [--token <registry name | address>] --anchor event --event '<event signature>'
  [--max-txs <n>] [--record <name>]
  [--from-block <n> --to-block <n> | --same-windows-as <name>]
       pnpm past-txs --restudy [<name>...]

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
address minted to, burned from, the side --from or --to leaves open, or the contract that logged
an event with no --token. It studies every transaction with a Safe party, leaving the rest
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
summary. A computer without the recording runs the command of the report again, with
--same-windows-as.
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
  --max-txs <n>                  Transactions to study, 240 unless given, at least 12 without
                                 --from-block and --to-block, at least 1 with them.
  --from-block, --to-block <n>   Search one block range in place of the program's search, for
                                 debugging the search; a template's research never passes them.
  --same-windows-as <name>       Search the blocks testdata/research/<name>.json searched again.
  --record <name>                Write .cache/past-txs/<name>.json and testdata/research/<name>.json;
                                 nothing is written when a read got no answer.
  --restudy [<name>...]          Rewrite each testdata/research/<name>.json from
                                 .cache/past-txs/<name>.json, reading nothing live.

Writes: .cache/past-txs/<name>.json and testdata/research/<name>.json with --record;
testdata/research/<name>.json with --restudy; otherwise nothing.
Keys: ALCHEMY_API_KEY, DRPC_API_KEY and ETHERSCAN_API_KEY, from the environment or
  $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 4,
  Study past transactions, Call traces).`;

const ROOT = join(import.meta.dirname, '..');

exitOnHelp(HELP);

const { values: flags, positionals } = parseArgs({
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
    'max-txs': { type: 'string', default: '240' },
    record: { type: 'string' },
    restudy: { type: 'boolean' },
  },
});

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

function writeSummary({ path, text }: { readonly path: string; readonly text: string }): string {
  mkdirSync(join(ROOT, SUMMARIES_DIR), { recursive: true });
  writeFileSync(join(ROOT, path), text);
  return path;
}

if (flags.restudy === true) {
  const names = positionals.length > 0 ? positionals : readdirSync(join(ROOT, RECORDINGS_DIR)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
  const registry = loadRegistry(ROOT);
  const safe = configuredSafe();
  for (const name of names) {
    const path = join(ROOT, RECORDINGS_DIR, `${name}.json`);
    if (!/^[a-z0-9-]+$/.test(name) || !existsSync(path)) {
      console.error(`--restudy ${name}: no recording ${join(RECORDINGS_DIR, `${name}.json`)}`);
      process.exit(64);
    }
    const recording = readRecording(path) as PastTxsRecording;
    const studied = pastTxsRegistry(ROOT, registry, recording.query);
    const summary = await studyRecording(ROOT, recording, studied);
    console.log(`wrote ${writeSummary(checkedSummary(name, summary, safe))}`);
    process.stdout.write(traceAddressesText(loadTemplate(ROOT, recording.query.template, studied), studied, summary));
  }
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
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new Error('--record takes a name of lowercase letters, digits and -');
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
  return { ...sampling, head: summary.head };
}

const fullRegistry = loadRegistry(ROOT);
const token = flags.token === undefined ? undefined : (fullRegistry.entries.get(flags.token)?.address ?? parseAddress('--token', flags.token));
const from = flags.from === undefined ? undefined : (fullRegistry.entries.get(flags.from)?.address ?? parseAddress('--from', flags.from));
const to = flags.to === undefined ? undefined : (fullRegistry.entries.get(flags.to)?.address ?? parseAddress('--to', flags.to));
const registry = studyRegistry();
const template = loadTemplate(ROOT, templateId, registry);
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

const endpoints = mainnetEndpoints(process.env);
const shown = progress((line) => void process.stderr.write(line));
const chain = recordingTransport(shown.transport(httpsTransport()), endpoints);
const unread: string[] = [];
const note = (read: string) => void unread.push(read);
const sources = recordingAsk(shown.ask(liveAsk(process.env, note)));
const messages = recordingMessages(liveMessages(httpsMessage, note));
const reader = createReader(endpoints, chain.transport, { note, retryPausesMs: RETRY_PAUSES_MS });
const batches = createReader(endpoints, chain.transport);
const traces = drpcTraces(endpoints[1], httpsTransport(), note);
const query = {
  template,
  anchor: { ...(token === undefined ? {} : { token }), kind, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), ...(event === undefined ? {} : { event }) },
  sampling: range !== undefined ? ({ kind: 'range', range } as const) : (sameAs ?? DEFAULT_SAMPLING),
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
process.stdout.write(renderPastTxs(run, registry));
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
        ...(event === undefined ? {} : { event: event.signature }),
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
  const full = join(ROOT, RECORDINGS_DIR, `${flags.record}.json`);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, recordingText(fixture, 1));
  console.log(`wrote ${full}: ${fixture.sources.length} source answers, ${fixture.exchanges.length} chain requests, ${fixture.traces?.length ?? 0} call traces`);
  console.log(`wrote ${writeSummary(summary)}`);
}
