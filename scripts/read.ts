import { join } from 'node:path';
import type { BlockRef } from '../src/chain/types.ts';
import { parseFlags } from '../src/cli/flags.ts';
import { UsageError } from '../src/cli/io.ts';
import { openMainnetReader } from '../src/chain/reader.ts';
import { loadAbiCases } from '../src/contracts/abi-case.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import { AbiSignatureError, parseViewSignature } from '../src/decode/abi.ts';
import type { AbiValue } from '../src/decode/codec.ts';
import type { ViewFunction } from '../src/price/reference.ts';
import { loadRegistry } from '../src/registry.ts';
import { recordedAbiAt } from '../src/research/proven-abi.ts';
import type { ProvenAbi } from '../src/research/proven-abi.ts';
import { argOf, readView, wordTypes } from '../src/research/read-view.ts';
import { addressOfWord } from '../src/script-args.ts';
import { exitOnHelp, usageExit } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';
import { ensureVendored } from '../src/vendor.ts';

const USAGE = `usage: pnpm read <address | registry name> '<function signature> returns (<types>)' [<argument>...] [--block <n>]

Calls one view of one contract and prints what it returns, such as a Chainlink feed's pair:
  pnpm read 0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6 'description() returns (string)'
  pnpm read usdc 'balanceOf(address owner) returns (uint256)' morpho-blue

ORIENTATION ONLY, like pnpm survey, pnpm decode-tx and pnpm events: nothing is recorded, and no
report, card or verify reads it. Use it to confirm on chain that a contract plays its role, or to
read the configured Safe's state before a template is drafted, such as an allowance:
  pnpm read usdc 'allowance(address owner, address spender) returns (uint256)' <the Safe> <spender>

The call is made through Alchemy and drpc at one block both agree on, the latest unless --block
gives one, by its hash; their answers must agree. It exits 0 when it prints the decoded values, or
REVERTED for a revert both agree on. It exits 1 for every result that gives no value: NO ANSWER (the
providers disagree, or one fails), NO CODE, RETURNED NOTHING, UNDECODED, and NOT A VIEW.

Each argument is one word, in the order of the signature's parameters: a decimal number, true or
false, 0x and hex digits for bytes and bytesN, the text for a string, and an address or a registry
name for an address. A view that takes an array or a tuple cannot be called. Give -- before the
first argument that starts with a dash, such as a negative number:
  pnpm read <contract> 'delta(int256 x) returns (int256)' -- -5

The return values are decoded by the contract's proven ABI when the ABI proof recorded in
testdata/abi/ (pnpm record-abi-case) is proven again at the block read, from the code there and the
source the proof recorded, and has a function of the same canonical signature; it says so when the
given returns differ. A function that ABI declares neither view nor pure is not called: NOT A VIEW.
Else the returns the signature gives decode them, and it says why, and that whether the function
changes state is not established; a proof whose code changed since, such as a proxy's new
implementation, is not proven again and names the change.

Options:
  --block <n>   The block read, the latest unless given; not above the latest.

Writes: nothing, except vendor/solc/ when a pinned solc is missing or differs from its pin.
Keys: ALCHEMY_API_KEY and DRPC_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (pnpm read).`;

exitOnHelp(USAGE);
refuseReadableErrors(64);

const usage: (problem: string) => never = usageExit(USAGE);

const { values: flags, positionals } = (() => {
  try {
    return parseFlags({ allowPositionals: true, options: { block: { type: 'string' } } });
  } catch (error) {
    return usage((error as Error).message);
  }
})();
const [contract, signature, ...words] = positionals;
if (contract === undefined || signature === undefined) usage("name one contract and one view, such as 'description() returns (string)'");
if (flags.block !== undefined && !/^(0|[1-9][0-9]{0,11})$/.test(flags.block)) usage('--block takes a block number');

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const addressOf = (word: string) => addressOfWord(registry, word);
const address = addressOf(contract) ?? usage(`${contract} is neither a registry name nor an address`);
let view: ViewFunction;
let args: AbiValue[];
try {
  view = parseViewSignature(signature);
  const types = wordTypes(view.fn);
  if (words.length !== types.length) usage(`${view.fn.signature} takes ${types.length} argument${types.length === 1 ? '' : 's'}; ${words.length} given`);
  args = types.map((type, i) => argOf(type, words[i] as string, addressOf));
} catch (error) {
  if (error instanceof AbiSignatureError) usage(`${signature}: ${error.message}`);
  if (!(error instanceof UsageError)) throw error;
  usage(error.message);
}

const recorded = loadAbiCases(ROOT).get(address);
const reader = openMainnetReader(process.env);
if (flags.block !== undefined) {
  const head = await reader.blockNumber();
  if (head.kind === 'agreed' && BigInt(flags.block) > head.value) usage(`--block ${flags.block} is above the latest block ${head.value}`);
}
if (recorded !== undefined && !(await ensureVendored(['solc']))) process.exit(1);
const abiAt = async (at: BlockRef): Promise<ProvenAbi> =>
  recorded === undefined ? { kind: 'none', why: 'testdata/abi/ holds no ABI proof of it; pnpm record-abi-case records one' } : recordedAbiAt(recorded, { registry, compilers: pinnedCompilers(), reader }, at);
const { text, ok } = await readView(reader, address, view, args, flags.block === undefined ? 'latest' : BigInt(flags.block), abiAt, registry.byAddress.get(address)?.name);
process.stdout.write(text);
if (!ok) process.exit(1);
