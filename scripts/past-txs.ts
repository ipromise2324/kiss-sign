import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { loadRegistry } from '../src/registry.ts';
import { pastTxs, renderPastTxs } from '../src/research/past-txs.ts';
import { ANCHOR_KINDS, liveAsk, recordingAsk } from '../src/research/sources.ts';
import type { AnchorKind } from '../src/research/sources.ts';
import { scrubRecording } from '../src/research/recording.ts';
import { parseAddress } from '../src/safe/types.ts';
import { loadTemplate } from '../src/template/template.ts';

const USAGE = `usage: ALCHEMY_API_KEY=... ETHERSCAN_API_KEY=... node scripts/past-txs.ts <protocol>/<operation>
  --token <registry name | address> --anchor mint|burn|any --from-block <n> --to-block <n> [--max-txs <n>] [--record <name>]

Finds executed Safe transactions of one operation through an anchor: an ERC-20 Transfer of --token.
  deposit into a vault:   --token <vault> --anchor mint   (shares minted to the depositor)
  withdraw from a vault:  --token <vault> --anchor burn   (shares burned from the owner)
  transfer a token:       --token <token> --anchor any    (any transfer of the token)
Both Alchemy (alchemy_getAssetTransfers) and Etherscan (logs) search the range; each transaction says which found it.
The Safe in $KISS_SIGN_HOME/config.json is left out of every count, example and recording.`;

const ROOT = join(import.meta.dirname, '..');

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    token: { type: 'string' },
    anchor: { type: 'string' },
    'from-block': { type: 'string' },
    'to-block': { type: 'string' },
    'max-txs': { type: 'string', default: '200' },
    record: { type: 'string' },
  },
});
const [templateId] = positionals;
const kind = ANCHOR_KINDS.find((k) => k === flags.anchor) as AnchorKind | undefined;
const block = (raw: string | undefined) => (raw !== undefined && /^[0-9]+$/.test(raw) ? BigInt(raw) : undefined);
const [fromBlock, toBlock] = [block(flags['from-block']), block(flags['to-block'])];
if (templateId === undefined || positionals.length !== 1 || flags.token === undefined || kind === undefined || fromBlock === undefined || toBlock === undefined || fromBlock > toBlock) {
  console.error(USAGE);
  process.exit(64);
}
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new Error('--record takes a name of lowercase letters, digits and -');

const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, templateId, registry);
const token = registry.entries.get(flags.token)?.address ?? parseAddress('--token', flags.token);
const exclude = loadConfig(kissSignHome(process.env))?.safe;
if (exclude === undefined) console.error(`no Safe configured in ${kissSignHome(process.env)}, so nothing is excluded`);

const endpoints = mainnetEndpoints(process.env);
const chain = recordingTransport(httpsTransport(), endpoints);
const sources = recordingAsk(liveAsk(process.env));
const query = { template, anchor: { token, kind, fromBlock, toBlock } };
const run = await pastTxs(query, {
  ask: sources.ask,
  reader: createReader(endpoints, chain.transport),
  registry,
  exclude,
  maxTxs: Number(flags['max-txs']),
});
process.stdout.write(renderPastTxs(run, registry));

if (flags.record !== undefined) {
  const providers = endpoints.map((e) => e.provider);
  const fixture = scrubRecording(
    {
      query: { template: templateId, token, anchor: kind, fromBlock: fromBlock.toString(), toBlock: toBlock.toString() },
      sources: sources.exchanges(),
      providers,
      exchanges: chain.exchanges().filter((e) => providers.every((p) => p in e.answers)),
    },
    [...(exclude === undefined ? [] : [exclude]), ...run.excluded],
  );
  const out = join(ROOT, 'testdata', 'research', `${flags.record}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${out}: ${fixture.sources.length} source answers, ${fixture.exchanges.length} chain requests`);
}
