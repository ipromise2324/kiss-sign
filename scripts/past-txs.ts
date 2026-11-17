import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadStoredConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { loadRegistry } from '../src/registry.ts';
import { DEFAULT_SPREAD, pastTxs, renderPastTxs } from '../src/research/past-txs.ts';
import { ANCHOR_KINDS, liveAsk, recordingAsk } from '../src/research/sources.ts';
import type { AnchorKind } from '../src/research/sources.ts';
import { scrubRecording } from '../src/research/recording.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { parseAddress } from '../src/safe/types.ts';
import { loadTemplate } from '../src/template/template.ts';
import { readRecording, recordingText } from '../src/chain/bytecode.ts';
import { unreadRefusal } from '../src/chain/https.ts';

const USAGE = `usage: ALCHEMY_API_KEY=... ETHERSCAN_API_KEY=... node scripts/past-txs.ts <protocol>/<operation>
  --token <registry name | address> --anchor mint|burn|any [--from <registry name | address>] [--to <registry name | address>]
  [--max-txs <n>] [--record <name>]
  [--from-block <n> --to-block <n> | --same-windows-as <recording>]

Finds executed transactions of one operation through an anchor: an ERC-20 Transfer of --token.
  deposit into a vault:   --token <vault> --anchor mint   (shares minted to the depositor)
  withdraw from a vault:  --token <vault> --anchor burn   (shares burned from the owner)
  transfer a token:       --token <token> --anchor any    (any transfer of the token)
  claim a reward:         --token <token> --anchor any --from <distributor>   (the distributor paying it out)
  supply to a market:     --token <loan token> --anchor any --to <lending>    (the loan token moving into Morpho Blue)
It searches 12 windows of up to 7200 blocks spread over the last year, placed by the head block, and studies at most
--max-txs (at least 12) transactions shared evenly between them. A window with more transfers than one page of a
source is halved until they fit, and the report names the blocks left out. --same-windows-as places the windows by the head
block testdata/research/<recording>.json keeps instead of today's, so a run again searches the same windows.
--from-block and --to-block replace the windows with one range.
Both Alchemy (alchemy_getAssetTransfers) and Etherscan (logs) search each window; each transaction says which found it.
Senders are counted by type: a proven Safe (Safe proxy code and an official singleton), a contract that is not a proven
Safe, and an EOA making one of the template's calls directly.
The Safe in $KISS_SIGN_HOME/config.json is left out of every count, example and recording.`;

const ROOT = join(import.meta.dirname, '..');

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
if (templateId === undefined || positionals.length !== 1 || flags.token === undefined || kind === undefined || (byHand && range === undefined) || (flags['same-windows-as'] !== undefined && byHand) || !(Number.isInteger(maxTxs) && maxTxs >= 1)) {
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
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new Error('--record takes a name of lowercase letters, digits and -');
const head = flags['same-windows-as'] === undefined ? undefined : recordedHead(flags['same-windows-as']);

/** The head block a `--record` run kept, so a run again searches its windows; no one types a head block. */
function recordedHead(name: string): bigint {
  const path = join(ROOT, 'testdata', 'research', `${name}.json`);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(path)) {
    console.error(`--same-windows-as ${name}: no recording testdata/research/${name}.json`);
    process.exit(64);
  }
  const kept = (readRecording(path) as PastTxsRecording).query.head;
  if (kept === undefined || !/^[0-9]+$/.test(kept)) {
    console.error(`--same-windows-as ${name}: the recording keeps no head block, so its windows cannot be searched again`);
    process.exit(64);
  }
  return BigInt(kept);
}

const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, templateId, registry);
const token = registry.entries.get(flags.token)?.address ?? parseAddress('--token', flags.token);
const from = flags.from === undefined ? undefined : (registry.entries.get(flags.from)?.address ?? parseAddress('--from', flags.from));
const to = flags.to === undefined ? undefined : (registry.entries.get(flags.to)?.address ?? parseAddress('--to', flags.to));
const exclude = loadStoredConfig(kissSignHome(process.env))?.safe;
if (exclude === undefined) console.error(`no Safe configured in ${kissSignHome(process.env)}, so nothing is excluded`);

const endpoints = mainnetEndpoints(process.env);
const chain = recordingTransport(httpsTransport(), endpoints);
const unread: string[] = [];
const note = (read: string) => void unread.push(read);
const sources = recordingAsk(liveAsk(process.env, note));
const reader = createReader(endpoints, chain.transport, { note });
const query = {
  template,
  anchor: { token, kind, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
  sampling: range !== undefined ? ({ kind: 'range', range } as const) : head === undefined ? DEFAULT_SPREAD : { ...DEFAULT_SPREAD, head },
};
const run = await pastTxs(query, {
  ask: sources.ask,
  reader,
  registry,
  exclude,
  maxTxs,
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
        token,
        anchor: kind,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(range === undefined ? {} : { fromBlock: range.fromBlock.toString(), toBlock: range.toBlock.toString() }),
        ...(run.head === undefined ? {} : { head: run.head.toString() }),
        maxTxs,
      },
      sources: sources.exchanges(),
      providers,
      exchanges: chain.exchanges().filter((e) => providers.every((p) => p in e.answers)),
    },
    [...(exclude === undefined ? [] : [exclude]), ...run.excluded],
  );
  const out = join(ROOT, 'testdata', 'research', `${flags.record}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, recordingText(fixture, 1));
  console.log(`wrote ${out}: ${fixture.sources.length} source answers, ${fixture.exchanges.length} chain requests`);
}
