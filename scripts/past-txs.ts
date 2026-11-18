import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport, replayReader } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadStoredConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { loadRegistry } from '../src/registry.ts';
import { DEFAULT_SPREAD, pastTxs, renderPastTxs } from '../src/research/past-txs.ts';
import { ANCHOR_KINDS, anchorEvent, liveAsk, recordingAsk } from '../src/research/sources.ts';
import type { AnchorEvent, AnchorKind } from '../src/research/sources.ts';
import { liveMessages, recordingMessages } from '../src/research/messages.ts';
import { httpsMessage } from '../src/verify/messages.ts';
import { scrubRecording } from '../src/research/recording.ts';
import { drpcTraces } from '../src/research/trace.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { parseAddress } from '../src/safe/types.ts';
import { loadTemplate } from '../src/template/template.ts';
import { readRecording, recordingText } from '../src/chain/bytecode.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = `usage: pnpm past-txs <protocol>/<operation>
  --token <registry name | address> --anchor mint|burn|any [--from <registry name | address>]
  [--to <registry name | address>]
  [--token <registry name | address>] --anchor event --event '<event signature>'
  [--max-txs <n>] [--record <name>]
  [--from-block <n> --to-block <n> | --same-windows-as <recording>]

Finds executed transactions of one operation through an anchor: an ERC-20 Transfer of --token.
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
It first asks each source for the whole last year, placed by the head block; when every answer
fits in one page it studies at most --max-txs of those transactions, taken evenly in block order.
Otherwise it searches 12 windows of up to 7200 blocks spread over the year, and studies at most
--max-txs (at least 12) transactions shared evenly between them. A window with more transfers
than one page of a source is halved until they fit, and the report names the blocks left out.
--same-windows-as places the year and the windows by the head block
testdata/research/<recording>.json keeps instead of today's, so a run again searches the same
blocks. --from-block and --to-block replace the year and the windows with one range.
Both Alchemy (alchemy_getAssetTransfers) and Etherscan (logs) search each window for a Transfer;
each transaction says which found it. Only Etherscan searches an event: Alchemy's eth_getLogs
reads at most 10 blocks at a time on the free plan.
A signed message the template names by its digest, such as a CoW order, is read from the
template's lookup.
For each free number the template leaves, and each withinSeconds time it bounds, it prints the
spread of values, less the block's time for a time.
Senders are counted by type: a proven Safe (Safe proxy code and an official singleton), a
contract that is not a proven Safe, and an EOA making one of the template's calls directly.
The Safe in $KISS_SIGN_HOME/config.json is left out of every count, example and recording.`;
const HELP = `${USAGE}
Per field it prints how many transactions and senders held the template's rule, and the misfits
grouped by reason. For each fitting transaction it runs the transaction alone on its parent block
and compares each stated amount with the balances, printing FINDING for a sender's difference
beyond the effect's tolerance in a registry token, or a tolerance no difference supports.
For each transaction exactly the template it reads the call trace from drpc alone
(debug_traceTransaction with callTracer, one at a time), and checks the trace's token transfers and
approvals against the receipt both providers agree on; --record keeps each trace cut down to each
call's depth, type, from, to, selector, value, whether it reverted, and the address arguments of a
transfer, transferFrom, approve or permit.

Options:
  --token <name | address>       The anchor token, or the contract that logs --event; left out for
                                 an event each Safe logs about itself.
  --anchor mint|burn|any|event   Which Transfer marks a transaction, or the event.
  --from, --to <name | address>  With --anchor any: only transfers out of, or into, the address.
  --event '<signature>'          With --anchor event: the event signature.
  --max-txs <n>                  Transactions to study, 240 unless given, at least 12 across the
                                 windows, at least 1 with --from-block and --to-block.
  --from-block, --to-block <n>   Search one block range in place of the windows.
  --same-windows-as <recording>  Search the windows of testdata/research/<recording>.json again.
  --record <name>                Write testdata/research/<name>.json; nothing is written when a
                                 read got no answer.

Writes: testdata/research/<name>.json with --record; otherwise nothing.
Keys: ALCHEMY_API_KEY and ETHERSCAN_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
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
  },
});
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
if (range === undefined && maxTxs < DEFAULT_SPREAD.count) {
  console.error(`--max-txs must be at least ${DEFAULT_SPREAD.count}, one transaction per window`);
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
const sameAs = flags['same-windows-as'] === undefined ? undefined : await recordedSearch(flags['same-windows-as']);

/**
 * The head block a `--record` run kept, or for a recording made before it kept one, its recorded head read, and whether
 * it asked the whole year first, so a run again searches its blocks; no one types a head block.
 */
async function recordedSearch(name: string): Promise<{ head: bigint; wholeYear: boolean }> {
  const path = join(ROOT, 'testdata', 'research', `${name}.json`);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(path)) {
    console.error(`--same-windows-as ${name}: no recording testdata/research/${name}.json`);
    process.exit(64);
  }
  const recording = readRecording(path) as PastTxsRecording;
  const kept = recording.query.head;
  const wholeYear = recording.query.wholeYear === true;
  if (kept !== undefined && /^[0-9]+$/.test(kept)) return { head: BigInt(kept), wholeYear };
  const read = recording.query.fromBlock === undefined ? await replayReader(recording.exchanges).blockNumber() : undefined;
  if (read?.kind !== 'agreed') {
    const why = recording.query.fromBlock === undefined ? 'keeps no head block and no head read' : 'searched one block range and keeps no head block';
    console.error(`--same-windows-as ${name}: the recording ${why}, so it has no windows to search again`);
    process.exit(64);
  }
  return { head: read.value, wholeYear: false };
}

const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, templateId, registry);
const token = flags.token === undefined ? undefined : (registry.entries.get(flags.token)?.address ?? parseAddress('--token', flags.token));
const from = flags.from === undefined ? undefined : (registry.entries.get(flags.from)?.address ?? parseAddress('--from', flags.from));
const to = flags.to === undefined ? undefined : (registry.entries.get(flags.to)?.address ?? parseAddress('--to', flags.to));
const exclude = loadStoredConfig(kissSignHome(process.env))?.safe;
if (exclude === undefined) console.error(`no Safe configured in ${kissSignHome(process.env)}, so nothing is excluded`);

const endpoints = mainnetEndpoints(process.env);
const chain = recordingTransport(httpsTransport(), endpoints);
const unread: string[] = [];
const note = (read: string) => void unread.push(read);
const sources = recordingAsk(liveAsk(process.env, note));
const messages = recordingMessages(liveMessages(httpsMessage, note));
const reader = createReader(endpoints, chain.transport, { note });
const traces = drpcTraces(endpoints[1], httpsTransport(), note);
const query = {
  template,
  anchor: { ...(token === undefined ? {} : { token }), kind, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), ...(event === undefined ? {} : { event }) },
  sampling: range !== undefined ? ({ kind: 'range', range } as const) : sameAs === undefined ? DEFAULT_SPREAD : { ...DEFAULT_SPREAD, ...sameAs },
};
const run = await pastTxs(query, {
  ask: sources.ask,
  reader,
  registry,
  readMessage: messages.read,
  exclude,
  maxTxs,
  traces: traces.source,
});
process.stdout.write(renderPastTxs(run, registry));

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
        ...(range === undefined ? {} : { fromBlock: range.fromBlock.toString(), toBlock: range.toBlock.toString() }),
        ...(run.head === undefined ? {} : { head: run.head.toString() }),
        ...(run.year === undefined ? {} : { wholeYear: true as const }),
        maxTxs,
      },
      sources: sources.exchanges(),
      messages: messages.exchanges(),
      providers,
      exchanges: chain.exchanges().filter((e) => providers.every((p) => p in e.answers)),
      traces: traces.recorded(),
    },
    [...(exclude === undefined ? [] : [exclude]), ...run.excluded],
  );
  const out = join(ROOT, 'testdata', 'research', `${flags.record}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, recordingText(fixture, 1));
  console.log(`wrote ${out}: ${fixture.sources.length} source answers, ${fixture.exchanges.length} chain requests, ${fixture.traces?.length ?? 0} call traces`);
}
