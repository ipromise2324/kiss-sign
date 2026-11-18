import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Hex } from '../safe/types.ts';
import { parseData, quantity, record } from './types.ts';

/**
 * The fields of an Ethereum block header in the order its RLP encoding lists them. The first fifteen are in every block;
 * each later one was added by a fork, from London's `baseFeePerGas` to Prague's `requestsHash`, and a block holds it
 * only from that fork on.
 */
const FIELDS: readonly (readonly [string, 'quantity' | 'data'])[] = [
  ['parentHash', 'data'],
  ['sha3Uncles', 'data'],
  ['miner', 'data'],
  ['stateRoot', 'data'],
  ['transactionsRoot', 'data'],
  ['receiptsRoot', 'data'],
  ['logsBloom', 'data'],
  ['difficulty', 'quantity'],
  ['number', 'quantity'],
  ['gasLimit', 'quantity'],
  ['gasUsed', 'quantity'],
  ['timestamp', 'quantity'],
  ['extraData', 'data'],
  ['mixHash', 'data'],
  ['nonce', 'data'],
  ['baseFeePerGas', 'quantity'],
  ['withdrawalsRoot', 'data'],
  ['blobGasUsed', 'quantity'],
  ['excessBlobGas', 'quantity'],
  ['parentBeaconBlockRoot', 'data'],
  ['requestsHash', 'data'],
];
const ALWAYS = 15;

/** `value` big-endian with no leading zero byte, as RLP encodes a number: zero is no bytes at all. */
function bigEndian(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array();
  const hex = value.toString(16);
  return hexToBytes(hex.length % 2 === 0 ? hex : `0${hex}`);
}

function length(prefix: number, size: number): Uint8Array {
  if (size <= 55) return Uint8Array.of(prefix + size);
  const bytes = bigEndian(BigInt(size));
  return Uint8Array.of(prefix + 55 + bytes.length, ...bytes);
}

function rlpBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && (bytes[0] as number) < 0x80) return bytes;
  return Uint8Array.of(...length(0x80, bytes.length), ...bytes);
}

function rlpList(items: readonly Uint8Array[]): Uint8Array {
  const payload = items.flatMap((item) => [...item]);
  return Uint8Array.of(...length(0xc0, payload.length), ...payload);
}

/**
 * keccak256 of the RLP encoding of the header a JSON-RPC block answer holds: the block's hash, when the answer is true.
 * A field after the first fifteen is encoded when the answer holds it.
 */
export function headerHash(raw: unknown): Hex {
  const block = record(raw);
  const items = FIELDS.flatMap(([name, kind], i) => {
    if (i >= ALWAYS && block[name] === undefined) return [];
    return [rlpBytes(kind === 'quantity' ? bigEndian(quantity(block[name])) : hexToBytes(parseData(block[name]).slice(2)))];
  });
  return `0x${bytesToHex(keccak_256(rlpList(items)))}` as Hex;
}
