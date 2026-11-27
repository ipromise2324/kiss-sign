import { join } from 'node:path';
import { parseFlags } from '../src/cli/flags.ts';
import { MissingKeyError } from '../src/chain/providers.ts';
import { openMainnetReader } from '../src/chain/reader.ts';
import { loadAbiCases } from '../src/contracts/abi-case.ts';
import { etherscanFromEnv } from '../src/contracts/etherscan.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import type { AbiEntry } from '../src/contracts/prove.ts';
import { signatureOfAbiEntry } from '../src/decode/abi.ts';
import { loadRegistry } from '../src/registry.ts';
import { markedSignature, readEvents, renderEvents, shapeOfAbi, shapeOfSignature } from '../src/research/events.ts';
import type { EventShape } from '../src/research/events.ts';
import { provenAbis } from '../src/research/proven-abi.ts';
import { ResearchError, eventArgTopic, liveAsk } from '../src/research/sources.ts';
import type { EventTopic } from '../src/research/sources.ts';
import { pacedAsk } from '../src/research/survey.ts';
import type { Address } from '../src/safe/types.ts';
import { addressOfWord } from '../src/script-args.ts';
import { exitOnHelp, usageExit } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';
import { ensureVendored } from '../src/vendor.ts';

const MAX_LOGS = 50;
const PAGES = 20;

const USAGE = `usage: pnpm events <address | registry name> --event '<event signature>'
         [--event-arg <n>=<registry name | address | bytes32>]... [--from-block <n>] [--to-block <n>]
         [--max-logs <n>] [--pages <n>] [--full]

Prints the logs one contract made of one event, such as a proxy's implementation changes or an
admin change: each one's block, transaction hash and decoded arguments, oldest first.

ORIENTATION ONLY, like pnpm survey and pnpm decode-tx: nothing is recorded, and no report, card or
verify reads it. An address in the output is data: register none on this output.

The logs are listed from Etherscan's logs, newest block range first, each range to its empty last
page; a range that holds more than Etherscan lists is asked again as two, and the search stops at
one block that holds more, or at the page cap, saying which blocks it read whole. A listed log not of
this contract, range, event or --event-arg is left out and counted. Each log shown is then looked
for in its transaction's receipt, which Alchemy and drpc must agree on: the same transaction, block
number and hash, log index, contract, topics and data. A log the agreed receipt lacks, or Etherscan
marks removed, is marked NOT CONFIRMED; a confirmed one prints the receipt's block.

The event's parameter names and indexed arguments come from the contract's proven ABI when it has an
event of the same canonical signature: the ABI proof recorded in testdata/abi/, or for a registry
entry with none, proven live at the latest block from Etherscan as pnpm prove-abi proves it (behind
a selector-routed proxy, the proxy's own code); a log older code made is decoded with it unverified.
An event the ABI declares anonymous is refused: its logs carry no signature topic. Else they come
from --event as written, which then marks each indexed argument:
  pnpm events fluid-liquidity --event 'LogSetAdmin(address indexed oldAdmin, address indexed newAdmin)'
An indexed argument that is not a value type logs only its keccak256, which is printed as such.

The newest --max-logs logs are shown, oldest first, with every log of the oldest block shown, so no
block is cut. Every run ends with: ORIENTATION ONLY: logs as Etherscan lists them; a log it left out
is not shown, so no log here proves none happened.

Options:
  --event '<signature>'   The event, such as 'Upgraded(address indexed implementation)'.
  --event-arg <n>=<name | address | bytes32>
                          Only logs whose argument n (from 1) holds that value; the argument must be
                          indexed and an address or a bytes32 (no other type can be filtered). May
                          be given once for each of several arguments.
  --from-block <n>        The first block searched, 0 unless given.
  --to-block <n>          The last block searched, the latest block unless given.
  --max-logs <n>          The newest logs shown, ${MAX_LOGS} unless given; the output says how many older
                          ones it left out and the --to-block that shows them.
  --pages <n>             Pages of 1000 logs read at most, ${PAGES} unless given.
  --full                  Every byte of each bytes value and every character of each string.

Writes: nothing, except vendor/solc/ when a pinned solc is missing or differs from its pin.
Keys: ALCHEMY_API_KEY, DRPC_API_KEY and ETHERSCAN_API_KEY, from the environment or
  $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (pnpm events).`;

exitOnHelp(USAGE);
refuseReadableErrors(64);

const usage: (problem: string) => never = usageExit(USAGE);

const options = {
  event: { type: 'string' },
  'event-arg': { type: 'string', multiple: true },
  'from-block': { type: 'string' },
  'to-block': { type: 'string' },
  'max-logs': { type: 'string' },
  pages: { type: 'string' },
  full: { type: 'boolean' },
} as const;
const { values: flags, positionals } = (() => {
  try {
    return parseFlags({ allowPositionals: true, options });
  } catch (error) {
    return usage((error as Error).message);
  }
})();
const [contract] = positionals;
if (contract === undefined || positionals.length !== 1) usage('name one contract');
if (flags.event === undefined) usage("give --event '<event signature>'");
const count = (name: string, raw: string | undefined, otherwise: number): number => {
  if (raw !== undefined && !/^[1-9][0-9]{0,8}$/.test(raw)) usage(`--${name} takes a positive number`);
  return raw === undefined ? otherwise : Number(raw);
};
const block = (name: string, raw: string | undefined): bigint | undefined => {
  if (raw !== undefined && !/^(0|[1-9][0-9]{0,11})$/.test(raw)) usage(`--${name} takes a block number`);
  return raw === undefined ? undefined : BigInt(raw);
};
const [maxLogs, maxPages] = [count('max-logs', flags['max-logs'], MAX_LOGS), count('pages', flags.pages, PAGES)];
const [fromBlock, toBlock] = [block('from-block', flags['from-block']) ?? 0n, block('to-block', flags['to-block'])];
let given: EventShape;
try {
  given = shapeOfSignature(flags.event);
} catch (error) {
  usage(`--event: ${(error as Error).message}`);
}

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const addressOf = (name: string, raw: string): Address => addressOfWord(registry, raw) ?? usage(`${name}: ${raw} is neither a registry name nor an address`);
const address = addressOf('contract', contract);
const eventsOf = (abi: readonly AbiEntry[]): string => {
  const events = abi.filter((e) => e.type === 'event' && e.anonymous !== true).map((e) => markedSignature(shapeOfAbi([e], signatureOfAbiEntry(e), '') as EventShape));
  return events.length === 0 ? 'none' : events.join(', ');
};

try {
  if (!(await ensureVendored(['solc']))) process.exit(1);
  const reader = openMainnetReader(process.env);
  const unread: string[] = [];
  const ask = pacedAsk(liveAsk(process.env, (read) => void unread.push(read)));
  const head = await reader.block('latest');
  if (head.kind === 'unverifiable') throw new ResearchError(`the latest block: ${head.reason}`);
  const lastBlock = toBlock ?? head.value.number;
  if (fromBlock > head.value.number) usage(`--from-block ${fromBlock} is above the latest block ${head.value.number}`);
  if (lastBlock < fromBlock || lastBlock > head.value.number) usage(`--to-block must be from --from-block ${fromBlock} to the latest block ${head.value.number}`);
  const abi = await provenAbis({ cases: loadAbiCases(ROOT), registry, compilers: pinnedCompilers(), reader, etherscan: () => etherscanFromEnv(process.env), block: head.value.number })(address);
  const shape: EventShape =
    abi.kind === 'none' ? { ...given, from: `${given.from}; no proven ABI: ${abi.why}` }
    : (shapeOfAbi(abi.abi, flags.event, `the proven ABI, ${abi.from}; a log made by older code there is decoded with it unverified`) ?? { ...given, from: `${given.from}; the proven ABI (${abi.from}) has no such event, only ${eventsOf(abi.abi)}` });
  const topics: EventTopic[] = (flags['event-arg'] ?? []).map((raw) => {
    const match = /^([1-9][0-9]*)=(.+)$/.exec(raw);
    if (match === null) return usage(`--event-arg ${raw}: takes <argument number>=<registry name | address | bytes32>`);
    const [position, value] = [Number(match[1]), match[2] as string];
    const named = registry.entries.get(value)?.address;
    try {
      return eventArgTopic(markedSignature(shape), named !== undefined || value.length === 42 ? { position, address: named ?? value } : { position, bytes32: value });
    } catch (error) {
      if (!(error instanceof ResearchError)) throw error;
      return usage(`--event-arg ${raw}: ${error.message}`);
    }
  });
  const positions = topics.map((t) => t.index);
  if (new Set(positions).size !== positions.length) usage('--event-arg names one indexed argument twice; give each argument once');
  const run = await readEvents({ address, shape, topics, range: { fromBlock, toBlock: lastBlock }, maxPages, maxLogs }, { ask, reader });
  process.stdout.write(renderEvents(run, (a) => registry.byAddress.get(a)?.name, flags.full === true));
  if (unread.length > 0) process.stdout.write(`${unread.length} reads with no answer after every retry: ${[...new Set(unread)].slice(0, 8).join('; ')}\n`);
} catch (error) {
  if (!(error instanceof ResearchError || error instanceof MissingKeyError)) throw error;
  console.error(error.message);
  process.exit(1);
}
