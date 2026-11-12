import type { Address, Hex } from '../safe/types.ts';
import type { Reader } from './reader.ts';
import type { BlockRef } from './types.ts';

const DECIMALS = '0x313ce567' as Hex;
const MAX_DECIMALS = 77;

/** decimals() of `token` at `at`, as both providers answer it, or why it could not be read. */
export async function readDecimals(reader: Reader, token: Address, at: BlockRef): Promise<number | { readonly problem: string }> {
  const read = await reader.call({ to: token, data: DECIMALS }, at);
  if (read.kind === 'unverifiable') return { problem: read.reason };
  if (read.value.kind === 'reverted') return { problem: 'decimals() reverted' };
  if (read.value.data.length !== 66) return { problem: `decimals() answered ${(read.value.data.length - 2) / 2} bytes, not one word` };
  const decimals = BigInt(read.value.data);
  return decimals > BigInt(MAX_DECIMALS) ? { problem: `decimals() answered ${decimals}` } : Number(decimals);
}

/** A base-unit amount in whole tokens, such as `1.25`, with no trailing zeros. */
export function wholeTokens(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / scale}${fraction === '' ? '' : `.${fraction}`}`;
}
