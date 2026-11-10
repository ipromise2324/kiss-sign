import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import type { CodePin } from '../registry.ts';
import type { Address, Hex } from '../safe/types.ts';
import { locate, minimalProxyTarget, safeProxyFactory } from './proxy.ts';
import type { Proxy, ProxyRefusal } from './proxy.ts';

export type CodeRefusal = ProxyRefusal | { readonly why: 'no-code'; readonly at: Address } | { readonly why: 'chained-proxy'; readonly at: Address };

/** The code at an address, and the code a call to it runs: the implementation's behind a proxy, else its own. */
export type RunningCode = { readonly own: Hex; readonly proxy: Proxy; readonly runs: Hex };

export type CodeRead = { readonly kind: 'read'; readonly code: RunningCode } | { readonly kind: 'refused'; readonly refusal: CodeRefusal };

export const keccakCode = (code: Hex): Hex => `0x${bytesToHex(keccak_256(hexToBytes(code.slice(2))))}` as Hex;

async function codeAt(reader: Reader, address: Address, at: BlockRef): Promise<Hex | CodeRefusal> {
  const read = await reader.getCode(address, at);
  if (read.kind === 'unverifiable') return { why: 'unverifiable', read: read.reason };
  return read.value.length === 2 ? { why: 'no-code', at: address } : read.value;
}

export async function readRunningCode(reader: Reader, address: Address, at: BlockRef): Promise<CodeRead> {
  const refused = (refusal: CodeRefusal): CodeRead => ({ kind: 'refused', refusal });
  const own = await codeAt(reader, address, at);
  if (typeof own !== 'string') return refused(own);
  const located = await locate(reader, address, own, at);
  if (located.kind === 'refused') return refused(located.refusal);
  const { proxy } = located;
  if (proxy.kind === 'none') return { kind: 'read', code: { own, proxy, runs: own } };
  const runs = await codeAt(reader, proxy.implementation, at);
  if (typeof runs !== 'string') return refused(runs);
  if (minimalProxyTarget(runs) !== undefined || safeProxyFactory(runs) !== undefined) return refused({ why: 'chained-proxy', at: proxy.implementation });
  return { kind: 'read', code: { own, proxy, runs } };
}

export function pinOf({ own, proxy, runs }: RunningCode): CodePin {
  const hash = keccakCode(own);
  return proxy.kind === 'none' ? { hash } : { hash, implementation: { address: proxy.implementation, hash: keccakCode(runs) } };
}
