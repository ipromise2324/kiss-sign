import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { EventLog } from '../chain/types.ts';
import { parseFunctionSignature } from '../decode/abi.ts';
import { decodeCall, wholeRegion } from '../decode/codec.ts';
import { SAFE_TX_TYPEHASH_HEX } from '../safe/hash.ts';
import { EXECUTION_SUCCESS } from '../simulate/events.ts';
import type { Address, Hex } from '../safe/types.ts';

export const EXEC_TRANSACTION = parseFunctionSignature(
  'execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
);

/** The highest nonce tried: a Safe that has executed more transactions than this is told so, with its safeTxHash. */
export const MOST_NONCE = 1n << 17n;

const word = (value: bigint): Uint8Array => hexToBytes(value.toString(16).padStart(64, '0'));
const MAINNET_DOMAIN = keccak_256(utf8ToBytes('EIP712Domain(uint256 chainId,address verifyingContract)'));
const DOMAIN_1_1_1 = keccak_256(utf8ToBytes('EIP712Domain(address verifyingContract)'));

/**
 * The Safe transaction an executed `execTransaction` ran, in one line: the safeTxHash its one `ExecutionSuccess` log
 * holds, and the nonce whose SafeTx hash, with the call's own fields, on Ethereum mainnet, is that safeTxHash.
 * `pnpm record-safe-tx` takes either. Nothing but the transaction's input and receipt logs is read.
 */
export function safeExecutionLine(safe: Address, input: Hex, logs: readonly EventLog[]): string {
  const executions = logs.filter((log) => log.address === safe && log.topics[0] === EXECUTION_SUCCESS);
  const [event] = executions;
  if (event === undefined || executions.length > 1) return `Safe nonce: not read, the receipt holds ${executions.length} ExecutionSuccess logs of ${safe}, not one`;
  const safeTxHash = (event.topics.length === 2 ? event.topics[1] : event.data.slice(0, 66)) as Hex;
  const call = decodeCall(EXEC_TRANSACTION, wholeRegion(hexToBytes(input.slice(2))));
  if (call.kind !== 'decoded') return `Safe nonce: not read, the input is no canonical execTransaction; safeTxHash ${safeTxHash}`;
  const fields = call.args.slice(0, 9).map((arg) => (arg.kind === 'bytes' ? keccak_256(arg.value) : arg.kind === 'address' ? word(BigInt(arg.value)) : arg.kind === 'uint' ? word(arg.value) : new Uint8Array(32)));
  const head = concatBytes(hexToBytes(SAFE_TX_TYPEHASH_HEX.slice(2)), ...fields);
  const domains = [keccak_256(concatBytes(MAINNET_DOMAIN, word(1n), word(BigInt(safe)))), keccak_256(concatBytes(DOMAIN_1_1_1, word(BigInt(safe))))];
  const wanted = safeTxHash.slice(2);
  for (let nonce = 0n; nonce < MOST_NONCE; nonce++) {
    const message = keccak_256(concatBytes(head, word(nonce)));
    if (domains.some((domain) => bytesToHex(keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domain, message))) === wanted)) return `Safe nonce ${nonce}, safeTxHash ${safeTxHash}`;
  }
  return `Safe nonce: none below ${MOST_NONCE} hashes to the logged safeTxHash ${safeTxHash}`;
}
