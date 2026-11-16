import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { parseFunctionSignature } from '../decode/abi.ts';
import { decodeValues, encodeCall } from '../decode/codec.ts';
import type { AbiValue } from '../decode/codec.ts';
import { parseAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { Reader } from './reader.ts';
import type { BlockRef } from './types.ts';

export const MULTICALL3 = parseAddress('multicall3', '0xcA11bde05977b3631167028862bE2a173976CA11');
const AGGREGATE = parseFunctionSignature('aggregate((address target, bytes callData)[] calls)');
const AGGREGATE_RETURNS = parseFunctionSignature('aggregateReturn(uint256 blockNumber, bytes[] returnData)').params.map((p) => p.type);

export type SubCall = { readonly to: Address; readonly data: Uint8Array };

/**
 * Each call's return data in order. `aggregate` requires every call to succeed, so one revert reverts the batch.
 * `no-code`: the call returned nothing, which only an address with no code does, as Multicall3 before its deployment.
 */
export type Aggregated =
  | { readonly kind: 'returned'; readonly data: readonly Uint8Array[] }
  | { readonly kind: 'reverted' }
  | { readonly kind: 'no-code' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'unverifiable'; readonly reason: string };

export async function aggregate(reader: Reader, calls: readonly SubCall[], at: BlockRef): Promise<Aggregated> {
  const items: AbiValue[] = calls.map(({ to, data }) => ({
    kind: 'tuple',
    span: [0, 0],
    fields: [
      { kind: 'address', value: to, span: [0, 0] },
      { kind: 'bytes', value: data, span: [0, 0] },
    ],
  }));
  const data = `0x${bytesToHex(encodeCall({ fn: AGGREGATE, args: [{ kind: 'array', items, span: [0, 0] }], trailer: undefined }))}` as Hex;
  const read = await reader.call({ to: MULTICALL3, data }, at);
  if (read.kind === 'unverifiable') return { kind: 'unverifiable', reason: read.reason };
  if (read.value.kind === 'reverted') return { kind: 'reverted' };
  if (read.value.data.length === 2) return { kind: 'no-code' };
  const returned = decodeValues(AGGREGATE_RETURNS, hexToBytes(read.value.data.slice(2)))?.[1];
  const answers = returned?.kind === 'array' ? returned.items.flatMap((item) => (item.kind === 'bytes' ? [item.value] : [])) : [];
  return answers.length === calls.length ? { kind: 'returned', data: answers } : { kind: 'malformed' };
}
