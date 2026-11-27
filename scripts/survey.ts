import { join } from 'node:path';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadStoredConfig } from '../src/config.ts';
import { etherscanFromEnv, retryingEtherscan } from '../src/contracts/etherscan.ts';
import { describeRefusal, proveAbi } from '../src/contracts/prove.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import { namedSignatureOfAbiEntry, parseFunctionSignature, signatureOfAbiEntry } from '../src/decode/abi.ts';
import type { AbiFunction } from '../src/decode/abi.ts';
import { kissSignHome } from '../src/keys.ts';
import { loadRegistry } from '../src/registry.ts';
import { progress } from '../src/research/progress.ts';
import { ResearchError, anchorEvent, liveAsk } from '../src/research/sources.ts';
import type { AnchorEvent } from '../src/research/sources.ts';
import { pacedAsk, survey } from '../src/research/survey.ts';
import type { SurveyTarget } from '../src/research/survey.ts';
import { renderSurvey, unnamedTargets } from '../src/research/survey-render.ts';
import type { Functions } from '../src/research/survey-render.ts';
import type { Address } from '../src/safe/types.ts';
import { parseFlags } from '../src/cli/flags.ts';
import { addressOfWord } from '../src/script-args.ts';
import { exitOnHelp, usageExit } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';
import { ensureVendored } from '../src/vendor.ts';

const YEAR_BLOCKS = 2_628_000;
const PAGES = 20;
const MAX_TXS = 240;
const EXTRA_ABIS = 4;

const USAGE = `usage: pnpm survey <contract>... [--pages <n>] [--max-txs <n>] [--blocks <n>]
       pnpm survey [<contract>...] --event '<event signature>'
       pnpm survey [<contract>...] --token <token> [--token <token>...] [--from <address>] [--to <address>]

Shows how Safes use a contract before there is a template: which functions their executed
transactions call, in which order, with which arguments. Each <contract>, <token> and <address>
is a registry name or an address.

ORIENTATION ONLY. The output is never recorded, and no report, card or verify reads it. The
template's evidence stays pnpm past-txs.

Where it looks, all on Etherscan's logs, newest block first:
  a contract alone   the logs of each event of its proven ABI (every log it made when its ABI is not
                     proven), and every log that names it in a topic, such as a Transfer to it
  --event            that event, logged by the contracts; with none, by the Safe itself
                       pnpm survey --event 'AddedOwner(address)'
  --token            Transfers of each token, one search each and one report, as --anchor any of
                     past-txs; with contracts, kept only where a Safe's call goes to one or names it.
                     A busy token alone fills the page cap within minutes of blocks: name where it
                     moves with --to (or --from), so every page holds the operation:
                       pnpm survey --token usdc --token usdt --to morpho-blue
                     (USDC or USDT moving into Morpho Blue on a supply), or for a swap the token
                     moving into the router or the pool manager it pays:
                       --to 0x000000000004444c5dc75cB358380D2e3dE08A90 (Uniswap v4's PoolManager)
A transaction is kept when its logs hold an address that is a proven Safe, checked in batches
through both providers, or when a Safe logged ExecutionSuccess in it, which finds Safes the logs do
not name but reads only the newest blocks. Each is then read through both providers, and counts when
it is an execTransaction to a proven Safe that logged ExecutionSuccess.

Prints the searched blocks, the whole transactions grouped by their calls in order (a MultiSend's
inner calls among them), the calls that reach the contract grouped by function and argument shape,
each with how many transactions and different Safes, the newest example hashes and each argument's
values, and what it could not reach. Arguments are decoded with proven ABIs only: the contract's and
those of up to ${EXTRA_ABIS} other contracts with unnamed calls, each naming its selectors on every contract, so a
parameter name can come from another contract; a refused proof says why and prints the selector.
Bytes inside an argument are decoded as a known call, else as a command list, else word by word; the
last two are guesses and say so. An address in the output is data: register none on this output.
The Safe in $KISS_SIGN_HOME/config.json is left out of every count and example.

Options:
  --pages <n>    Pages of 1000 logs per search, ${PAGES} unless given.
  --blocks <n>   Blocks to search back, the last year unless given, which is also the most.
  --max-txs <n>  Transactions to read, ${MAX_TXS} unless given.
  --to, --from <address>
                 With --token: only transfers into, or out of, the address.

When a search stops before its blocks or reads less than a day of them, a WARNING on stderr,
before any Safe is checked, and in the output names it and how to narrow the search.

Writes: nothing, except vendor/solc/ when a pinned solc is missing or differs from its pin. A line
on stderr every 10 seconds says what it has read.
Keys: ALCHEMY_API_KEY, DRPC_API_KEY and ETHERSCAN_API_KEY, from the environment or
  $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 4, Survey).`;

const ROOT = join(import.meta.dirname, '..');

exitOnHelp(USAGE);
refuseReadableErrors(64);

const usage: (problem: string) => never = usageExit(USAGE);

const options = { event: { type: 'string' }, token: { type: 'string', multiple: true }, from: { type: 'string' }, to: { type: 'string' }, pages: { type: 'string' }, 'max-txs': { type: 'string' }, blocks: { type: 'string' } } as const;
const { values: flags, positionals } = (() => {
  try {
    return parseFlags({ allowPositionals: true, options });
  } catch (error) {
    return usage((error as Error).message);
  }
})();
const count = (name: string, raw: string | undefined, otherwise: number): number => {
  if (raw !== undefined && !/^[1-9][0-9]{0,8}$/.test(raw)) usage(`--${name} takes a positive number`);
  return raw === undefined ? otherwise : Number(raw);
};
const registry = loadRegistry(ROOT);
const addressArg = (name: string, raw: string): Address => addressOfWord(registry, raw) ?? usage(`${name}: ${raw} is neither a registry name nor an address`);
const contracts = [...new Set(positionals.map((raw) => addressArg('contract', raw)))];
const { event: eventText, token: tokens, from, to } = flags;
const token = tokens === undefined ? undefined : [...new Set(tokens.map((raw) => addressArg('--token', raw)))];
if (contracts.length === 0 && eventText === undefined && token === undefined) usage('name a contract, --event or --token');
if (eventText !== undefined && token !== undefined) usage('--event and --token are two searches; give one');
if ((from !== undefined || to !== undefined) && token === undefined) usage('--from and --to go with --token');
let event: AnchorEvent | undefined;
try {
  event = eventText === undefined ? undefined : anchorEvent(eventText);
} catch (error) {
  usage(`--event: ${(error as Error).message}`);
}
const [maxPages, maxTxs, blocks] = [count('pages', flags.pages, PAGES), count('max-txs', flags['max-txs'], MAX_TXS), BigInt(count('blocks', flags.blocks, YEAR_BLOCKS))];

const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)} s`;
if (!(await ensureVendored(['solc']))) process.exit(1);
const unread: string[] = [];
const note = (read: string) => void unread.push(read);
const endpoints = mainnetEndpoints(process.env);
const shown = progress((line) => void process.stderr.write(line));
const transport = shown.transport(httpsTransport());
const reader = createReader(endpoints, transport, { note });
const batches = createReader(endpoints, transport);
const ask = pacedAsk(shown.ask(liveAsk(process.env, note)));
const etherscan = retryingEtherscan(etherscanFromEnv(process.env), note);
const compilers = pinnedCompilers();
const exclude = loadStoredConfig(kissSignHome(process.env))?.safe;
if (exclude === undefined) console.error(`no Safe configured in ${kissSignHome(process.env)}, so nothing is excluded`);

const abis = new Map<Address, Functions>();
const events = new Map<Address, AnchorEvent[]>();
async function prove(address: Address): Promise<void> {
  const entry = registry.byAddress.get(address);
  const block = await reader.block('latest');
  const unproven = (why: string) => void abis.set(address, { kind: 'unproven', why });
  if (block.kind === 'unverifiable') return unproven(block.reason);
  if (entry?.routes !== undefined) return unproven('a selector-routed proxy, see pnpm pin-code');
  const proof = await proveAbi(reader, address, block.value, { etherscan, compilers }, entry);
  if (proof.kind === 'refused') return unproven(describeRefusal(proof.refusal));
  const functions = proof.abi.filter((e) => e.type === 'function').map((e) => parseFunctionSignature(namedSignatureOfAbiEntry(e)));
  abis.set(address, { kind: 'proven', bySelector: new Map(functions.map((fn): [string, AbiFunction] => [fn.selector, fn])) });
  events.set(address, proof.abi.filter((e) => e.type === 'event' && e.anonymous !== true).map((e) => anchorEvent(signatureOfAbiEntry(e))));
}

try {
  for (const address of contracts) await prove(address);
  console.error(`${elapsed()}: ABI proofs done`);
  const target: SurveyTarget =
    event !== undefined ? { kind: 'event', event, contracts }
    : token !== undefined
      ? { kind: 'transfers', tokens: token, ...(from === undefined ? {} : { from: addressArg('--from', from) }), ...(to === undefined ? {} : { to: addressArg('--to', to) }), contracts }
      : { kind: 'contracts', contracts: contracts.map((address) => ({ address, events: events.get(address) ?? [] })) };
  const run = await survey(target, { ask, reader, batches, exclude, maxPages, maxTxs, blocks, warn: (warning) => console.error(warning) });
  console.error(`${elapsed()}: search and reads done`);
  for (const address of unnamedTargets(run, { abis, registry }).filter((a) => !abis.has(a) && a !== exclude).slice(0, EXTRA_ABIS)) await prove(address);
  shown.stop();
  process.stdout.write(renderSurvey(run, { abis, registry }));
  if (unread.length > 0) process.stdout.write(`  ${unread.length} reads with no answer after every retry: ${[...new Set(unread)].slice(0, 8).join('; ')}\n`);
  console.log(`took ${elapsed()}`);
} catch (error) {
  if (!(error instanceof ResearchError)) throw error;
  console.error(error.message);
  process.exit(1);
}
