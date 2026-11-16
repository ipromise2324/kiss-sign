import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { aggregate } from '../chain/multicall.ts';
import type { Aggregated } from '../chain/multicall.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import type { AbiFunction, AbiType } from '../decode/abi.ts';
import { decodeValues, encodeCall } from '../decode/codec.ts';
import type { AbiValue } from '../decode/codec.ts';
import type { CodePin, CodePins, CodeSpan, Route, SelectorRouting } from '../registry.ts';
import type { Address, Hex } from '../safe/types.ts';
import { locate, minimalProxyTarget, safeProxyFactory, unknownDelegation } from './proxy.ts';
import type { Proxy, ProxyRefusal } from './proxy.ts';

/** `call` and `detail` hold only function names, selectors and addresses. */
export type RoutesRefusal =
  | { readonly why: 'multicall-no-code' }
  | { readonly why: 'routes-reverted' }
  | { readonly why: 'routes-malformed'; readonly call: string }
  | { readonly why: 'routes-inconsistent'; readonly detail: string };

export type CodeRefusal = ProxyRefusal | RoutesRefusal | { readonly why: 'no-code'; readonly at: Address } | { readonly why: 'chained-proxy'; readonly at: Address };

/** The code at an address, and the code a call to it runs: the implementation's behind a proxy, else its own. */
export type RunningCode = { readonly own: Hex; readonly proxy: Proxy; readonly runs: Hex; readonly routes?: readonly Route[] };

export type CodeRead = { readonly kind: 'read'; readonly code: RunningCode } | { readonly kind: 'refused'; readonly refusal: CodeRefusal };

export const keccakCode = (code: Hex): Hex => `0x${bytesToHex(keccak_256(hexToBytes(code.slice(2))))}` as Hex;

async function codeAt(reader: Reader, address: Address, at: BlockRef): Promise<Hex | CodeRefusal> {
  const read = await reader.getCode(address, at);
  if (read.kind === 'unverifiable') return { why: 'unverifiable', read: read.reason };
  return read.value.length === 2 ? { why: 'no-code', at: address } : read.value;
}

const ADDRESS_WORD: readonly AbiType[] = [{ kind: 'address' }];
const SELECTOR_LIST: readonly AbiType[] = [{ kind: 'array', item: { kind: 'fixed-bytes', size: 4 } }];
const ZERO = `0x${'0'.repeat(40)}`;

const oneArgument = (fn: AbiFunction, arg: AbiValue): Uint8Array => encodeCall({ fn, args: [arg], trailer: undefined });

function batchRefusal(batch: Exclude<Aggregated, { kind: 'returned' }>, call: string): CodeRefusal {
  if (batch.kind === 'unverifiable') return { why: 'unverifiable', read: batch.reason };
  if (batch.kind === 'no-code') return { why: 'multicall-no-code' };
  return batch.kind === 'reverted' ? { why: 'routes-reverted' } : { why: 'routes-malformed', call };
}

async function implementationsOf(reader: Reader, proxy: Address, fn: AbiFunction, selectors: readonly Hex[], at: BlockRef): Promise<(Address | null)[] | CodeRefusal> {
  const batch = await aggregate(reader, selectors.map((selector) => ({ to: proxy, data: oneArgument(fn, { kind: 'fixed-bytes', value: selector, span: [0, 0] }) })), at);
  if (batch.kind !== 'returned') return batchRefusal(batch, `Multicall3 aggregate of ${fn.name}`);
  const answers: (Address | null)[] = [];
  for (const [i, data] of batch.data.entries()) {
    const value = decodeValues(ADDRESS_WORD, data)?.[0];
    if (value?.kind !== 'address') return { why: 'routes-malformed', call: `${fn.name}(${selectors[i]})` };
    answers.push(value.value === ZERO ? null : value.value);
  }
  return answers;
}

async function selectorListsOf(reader: Reader, proxy: Address, fn: AbiFunction, implementations: readonly Address[], at: BlockRef): Promise<Hex[][] | CodeRefusal> {
  const batch = await aggregate(reader, implementations.map((implementation) => ({ to: proxy, data: oneArgument(fn, { kind: 'address', value: implementation, span: [0, 0] }) })), at);
  if (batch.kind !== 'returned') return batchRefusal(batch, `Multicall3 aggregate of ${fn.name}`);
  const lists: Hex[][] = [];
  for (const [i, data] of batch.data.entries()) {
    const list = decodeValues(SELECTOR_LIST, data)?.[0];
    if (list?.kind !== 'array') return { why: 'routes-malformed', call: `${fn.name}(${implementations[i]})` };
    lists.push(list.items.flatMap((item) => (item.kind === 'fixed-bytes' ? [item.value] : [])));
  }
  return lists;
}

function selectorOwners(implementations: readonly Address[], lists: readonly (readonly Hex[])[]): Map<Hex, Address> | string {
  const owners = new Map<Hex, Address>();
  for (const [i, address] of implementations.entries()) {
    for (const selector of lists[i] ?? []) {
      const other = owners.get(selector);
      if (other !== undefined) return other === address ? `${address} lists ${selector} twice` : `${other} and ${address} both list ${selector}`;
      owners.set(selector, address);
    }
  }
  return owners;
}

function seedOutsideItsList(seeds: readonly Hex[], reached: readonly (Address | null)[], owners: ReadonlyMap<Hex, Address>): string | undefined {
  const outside = seeds.flatMap((seed, i) => {
    const implementation = reached[i];
    return implementation != null && owners.get(seed) !== implementation ? [`${seed} routes to ${implementation}, whose selector list does not hold it`] : [];
  });
  return outside[0];
}

function selectorRoutedElsewhere(owners: readonly (readonly [Hex, Address])[], answers: readonly (Address | null)[]): string | undefined {
  const elsewhere = owners.flatMap(([selector, address], i) => (answers[i] === address ? [] : [`${address} lists ${selector}, which routes to ${answers[i] ?? 'no implementation'}`]));
  return elsewhere[0];
}

type RoutesRead = { readonly kind: 'read'; readonly routes: readonly Route[] } | { readonly kind: 'refused'; readonly refusal: CodeRefusal };

export async function readRoutes(reader: Reader, proxy: Address, routing: SelectorRouting, at: BlockRef): Promise<RoutesRead> {
  const refused = (refusal: CodeRefusal): RoutesRead => ({ kind: 'refused', refusal });
  const inconsistent = (detail: string): RoutesRead => refused({ why: 'routes-inconsistent', detail });
  const reached = await implementationsOf(reader, proxy, routing.implementationOf, routing.seeds, at);
  if (!Array.isArray(reached)) return refused(reached);
  const implementations = [...new Set(reached.filter((address) => address !== null))].sort();
  if (implementations.length === 0) return { kind: 'read', routes: [] };
  const lists = await selectorListsOf(reader, proxy, routing.selectorsOf, implementations, at);
  if (!Array.isArray(lists)) return refused(lists);
  const owners = selectorOwners(implementations, lists);
  if (typeof owners === 'string') return inconsistent(owners);
  const unlisted = seedOutsideItsList(routing.seeds, reached, owners);
  if (unlisted !== undefined) return inconsistent(unlisted);
  const listed = [...owners];
  const answers = await implementationsOf(reader, proxy, routing.implementationOf, listed.map(([selector]) => selector), at);
  if (!Array.isArray(answers)) return refused(answers);
  const elsewhere = selectorRoutedElsewhere(listed, answers);
  if (elsewhere !== undefined) return inconsistent(elsewhere);
  const routes: Route[] = [];
  for (const [i, address] of implementations.entries()) {
    const code = await codeAt(reader, address, at);
    if (typeof code !== 'string') return refused(code);
    routes.push({ address, hash: keccakCode(code), selectors: lists[i] ?? [] });
  }
  return { kind: 'read', routes };
}

export async function readRunningCode(reader: Reader, address: Address, at: BlockRef, routing?: SelectorRouting): Promise<CodeRead> {
  const refused = (refusal: CodeRefusal): CodeRead => ({ kind: 'refused', refusal });
  const own = await codeAt(reader, address, at);
  if (typeof own !== 'string') return refused(own);
  const located = await locate(reader, address, own, at, routing !== undefined);
  if (located.kind === 'refused') return refused(located.refusal);
  const { proxy } = located;
  let runs = own;
  if (proxy.kind !== 'none') {
    const code = await codeAt(reader, proxy.implementation, at);
    if (typeof code !== 'string') return refused(code);
    if (minimalProxyTarget(code) !== undefined || safeProxyFactory(code) !== undefined) return refused({ why: 'chained-proxy', at: proxy.implementation });
    const delegation = unknownDelegation(proxy.implementation, code);
    if (delegation !== undefined) return refused(delegation);
    runs = code;
  }
  if (routing === undefined) return { kind: 'read', code: { own, proxy, runs } };
  const routes = await readRoutes(reader, address, routing, at);
  return routes.kind === 'refused' ? routes : { kind: 'read', code: { own, proxy, runs, routes: routes.routes } };
}

export function pinOf({ own, proxy, runs, routes }: RunningCode): CodePin {
  const hash = keccakCode(own);
  const routed = routes === undefined ? {} : { routes };
  return proxy.kind === 'none' ? { hash, ...routed } : { hash, implementation: { address: proxy.implementation, hash: keccakCode(runs) }, ...routed };
}

const sameRoute = (a: Route, b: Route | undefined): boolean =>
  b !== undefined && a.address === b.address && a.hash === b.hash && a.selectors.length === b.selectors.length && a.selectors.every((selector, i) => selector === b.selectors[i]);

const sameRoutes = (a: readonly Route[] | undefined, b: readonly Route[] | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.length === b.length && a.every((route, i) => sameRoute(route, b[i]));

export const samePin = (a: CodePin, b: CodePin): boolean =>
  a.hash === b.hash && a.implementation?.address === b.implementation?.address && a.implementation?.hash === b.implementation?.hash && sameRoutes(a.routes, b.routes);

/** The spans the walk read, and why it stopped: the block before the first span holds no code it can pin, or that span starts at block 0. */
export type CodeHistory =
  | { readonly kind: 'read'; readonly pins: CodePins; readonly before: CodeRefusal | 'genesis' }
  | { readonly kind: 'refused'; readonly refusal: CodeRefusal };

/** The code a call to `address` runs at block `number`, read at the block hash both providers agree on. */
export async function readRunningCodeAt(reader: Reader, address: Address, number: bigint, routing?: SelectorRouting): Promise<CodeRead> {
  const block = await reader.block(number);
  return block.kind === 'unverifiable' ? { kind: 'refused', refusal: { why: 'unverifiable', read: block.reason } } : readRunningCode(reader, address, block.value, routing);
}

/**
 * Walks back from block `head`, where `address` runs `headPin`, through every change of the code a call to it runs, and
 * of its routes when `routing` is given.
 * For each pin it searches, by halving the blocks from 0 to the latest block known to hold it, for the first block of
 * the run that ends there, then reads the block before that run and repeats until that block holds no pin. Each read
 * goes through both providers at an agreed block hash; one they disagree on refuses the whole history.
 */
export async function readCodeHistory(reader: Reader, address: Address, head: bigint, headPin: CodePin, routing?: SelectorRouting): Promise<CodeHistory> {
  const reads = new Map<bigint, CodeRead>();
  const readAt = async (number: bigint): Promise<CodeRead> => {
    let read = reads.get(number);
    if (read === undefined) {
      read = await readRunningCodeAt(reader, address, number, routing);
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
