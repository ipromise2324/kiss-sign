import { join } from 'node:path';
import { parseFlags } from '../src/cli/flags.ts';
import { MissingKeyError } from '../src/chain/providers.ts';
import { openMainnetReader } from '../src/chain/reader.ts';
import type { Reader } from '../src/chain/reader.ts';
import { loadAbiCases } from '../src/contracts/abi-case.ts';
import { etherscanFromEnv } from '../src/contracts/etherscan.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import { namedSignatureOfAbiEntry, parseFunctionSignature } from '../src/decode/abi.ts';
import { loadRegistry } from '../src/registry.ts';
import { renderDecodedTx } from '../src/research/decode-tx.ts';
import type { CallAbi } from '../src/research/decode-tx.ts';
import { provenAbis } from '../src/research/proven-abi.ts';
import type { Hex } from '../src/safe/types.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';
import { TemplateError, loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { ensureVendored } from '../src/vendor.ts';

const USAGE = 'usage: pnpm decode-tx <transaction hash> [--full] [--template <protocol>/<operation>]';
const HELP = `${USAGE}

Decodes one executed Ethereum mainnet transaction for the template author: when it calls a Safe's
execTransaction, its fields and the call the Safe makes; a delegatecall to one of Safe's official
MultiSend deployments, each of its parts; and each call, decoded with the proven ABI of the address
it goes to, or else its selector and raw 32-byte words. The ABI is the one an ABI proof recorded in
testdata/abi/ gives, compiled again offline with the pinned solc; for a registry entry with no
recorded proof, it is proven live from Etherscan's verified source as pnpm prove-abi does. For a
Safe's execTransaction it also prints the safeTxHash its receipt's ExecutionSuccess log holds, and
the Safe nonce whose SafeTx hash, with the call's own fields, is that safeTxHash (nonces below
131072 are tried); pnpm record-safe-tx takes either. Strings from the chain are printed quoted.

Bytes inside an argument, such as each input of Uniswap's Universal Router execute, are decoded:
  - by the rules of --template's call at the same position, to the same contract and function: a
    call or encoded parameters (call, encoded) or packed parts (packed), item by item and field by
    field, saying when the counts of items differ; when no call there matches, they are shown only
    as fitting the rules of the template's first call to that function ("fits");
  - else, as a guess it says is one, as a call of the called contract's own proven ABI, such as a
    multicall's calls to itself;
  - else printed as hex.
A bytes value over 256 bytes, or a string over 400 characters, prints only its start, marked
SHORTENED with how long it is; --full prints it whole, a string's control characters escaped.

Options:
  --full                        Print each bytes value and string whole.
  --template <protocol>/<operation>
                                Decode bytes inside the arguments by this template's rules; a
                                draft in templates/ works too.

It orients the author, as pnpm survey does: never evidence, never recorded, and nothing it prints
is a verdict.

Writes: nothing. Network: the transaction and its receipt from Alchemy and drpc, which must agree;
Etherscan only for a registry entry with no recorded proof. Keys: ALCHEMY_API_KEY and
DRPC_API_KEY, and ETHERSCAN_API_KEY for that live proof, from the environment or
$KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (pnpm decode-tx).`;

exitOnHelp(HELP);
refuseReadableErrors();

function usage(problem: string): never {
  console.error(`${problem}\n${USAGE}`);
  process.exit(2);
}
const { values: flags, positionals } = (() => {
  try {
    return parseFlags({ allowPositionals: true, options: { full: { type: 'boolean' }, template: { type: 'string' } } });
  } catch (error) {
    return usage((error as Error).message);
  }
})();
const [hash] = positionals;
if (hash === undefined || positionals.length !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(hash)) usage('give one transaction hash');

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
function templateOf(id: string): Template {
  try {
    return loadTemplate(root, id, registry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return usage(`--template ${id}: no templates/${id}/template.json`);
    if (!(error instanceof TemplateError)) throw error;
    return usage(`--template ${id}: ${error.message}`);
  }
}
const template = flags.template === undefined ? undefined : templateOf(flags.template);
if (!(await ensureVendored(['solc']))) process.exit(1);
function openReader(): Reader {
  try {
    return openMainnetReader(process.env);
  } catch (error) {
    if (!(error instanceof MissingKeyError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
const reader = openReader();

const read = await reader.getTransaction(hash.toLowerCase() as Hex);
if (read.kind === 'unverifiable') {
  console.error(`REFUSED  the providers gave no agreed answer for the transaction: ${read.reason}`);
  process.exit(1);
}
if (read.value === null) {
  console.error(`REFUSED  no transaction ${hash} on Ethereum mainnet`);
  process.exit(1);
}
const tx = read.value;

const proven = provenAbis({ cases: loadAbiCases(root), registry, compilers: pinnedCompilers(), reader, etherscan: () => etherscanFromEnv(process.env), block: tx.blockNumber ?? undefined });
const abiOf = async (address: Parameters<typeof proven>[0]): Promise<CallAbi> => {
  const abi = await proven(address);
  if (abi.kind === 'none') return abi;
  const functions = abi.abi.filter((e) => e.type === 'function').map((e) => parseFunctionSignature(namedSignatureOfAbiEntry(e)));
  return { kind: 'proven', from: abi.from, functions: new Map(functions.map((fn) => [fn.selector, fn])) };
};

const receipt = tx.blockNumber === null ? undefined : await reader.getTransactionReceipt(tx.hash);
if (receipt?.kind === 'unverifiable') {
  console.error(`REFUSED  the providers gave no agreed answer for the receipt: ${receipt.reason}`);
  process.exit(1);
}
const logs = receipt?.value?.logs;
process.stdout.write(await renderDecodedTx({ ...tx, ...(logs === undefined ? {} : { logs }) }, { abiOf, nameOf: (address) => registry.byAddress.get(address)?.name, full: flags.full === true, ...(template === undefined ? {} : { template }) }));
