import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import type { CodePin, CodePins, CodeSpan } from '../registry.ts';
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

export const samePin = (a: CodePin, b: CodePin): boolean =>
  a.hash === b.hash && a.implementation?.address === b.implementation?.address && a.implementation?.hash === b.implementation?.hash;

/** The spans the walk read, and why it stopped: the block before the first span holds no code it can pin, or that span starts at block 0. */
export type CodeHistory =
  | { readonly kind: 'read'; readonly pins: CodePins; readonly before: CodeRefusal | 'genesis' }
  | { readonly kind: 'refused'; readonly refusal: CodeRefusal };

/** The code a call to `address` runs at block `number`, read at the block hash both providers agree on. */
export async function readRunningCodeAt(reader: Reader, address: Address, number: bigint): Promise<CodeRead> {
  const block = await reader.block(number);
  return block.kind === 'unverifiable' ? { kind: 'refused', refusal: { why: 'unverifiable', read: block.reason } } : readRunningCode(reader, address, block.value);
}

/**
 * Walks back from block `head`, where `address` runs `headPin`, through every change of the code a call to it runs.
 * For each pin it searches, by halving the blocks from 0 to the latest block known to hold it, for the first block of
 * the run that ends there, then reads the block before that run and repeats until that block holds no pin. Each read
 * goes through both providers at an agreed block hash; one they disagree on refuses the whole history.
 */
export async function readCodeHistory(reader: Reader, address: Address, head: bigint, headPin: CodePin): Promise<CodeHistory> {
  const reads = new Map<bigint, CodeRead>();
  const readAt = async (number: bigint): Promise<CodeRead> => {
    let read = reads.get(number);
    if (read === undefined) {
      read = await readRunningCodeAt(reader, address, number);
      reads.set(number, read);
    }
    return read;
  };
  const found: CodeSpan[] = [];
  let pin = headPin;
  let held = head;
  for (;;) {
    let lo = -1n;
    while (held - lo > 1n) {
      const mid = (lo + held) / 2n;
      const read = await readAt(mid);
      if (read.kind === 'refused' && read.refusal.why === 'unverifiable') return read;
      if (read.kind === 'read' && samePin(pinOf(read.code), pin)) held = mid;
      else lo = mid;
    }
    found.push({ from: held, pin });
    const before = lo < 0n ? 'genesis' : await readAt(lo);
    if (before === 'genesis' || before.kind === 'refused') {
      const [current, ...earlier] = found as [CodeSpan, ...CodeSpan[]];
      return { kind: 'read', pins: { earlier: earlier.reverse(), current }, before: before === 'genesis' ? before : before.refusal };
    }
    pin = pinOf(before.code);
    held = lo;
  }
}
