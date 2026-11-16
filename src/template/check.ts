import { bytesToHex } from '@noble/hashes/utils.js';
import { resolveRef } from '../card.ts';
import type { ResolvedCard, ResolvedValue } from '../card.ts';
import { paramName } from '../decode/abi.ts';
import type { AbiType } from '../decode/abi.ts';
import { decodeCall } from '../decode/codec.ts';
import type { AbiValue, DecodeFailure, DecodedCall, Region, Span } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import type { InnerCall } from '../decode/multisend.ts';
import type { Registry } from '../registry.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import type { CallNode, ConstValue, LeafRule, Quantity, Rule, Template, TemplateCall } from './template.ts';

/**
 * Where a field differs. `callPath` names the call, such as `multiSend[1].multicall.bundle[1].data.erc4626Deposit`;
 * `arg` the field inside it; `bytes` its span in the Safe transaction's `data`, absent for a field outside `data`.
 */
export type Finding = {
  readonly callPath: string;
  readonly arg: string;
  readonly bytes: Span | undefined;
  readonly expected: string;
  readonly actual: string;
};

/**
 * One argument the check compared, or let through as free. `bytes` is its span in `data`; absent, it is the Safe
 * transaction's own `to`, `value` or `nonce`.
 */
export type Leaf = {
  readonly callPath: string;
  readonly arg: string;
  readonly bytes: Span | undefined;
  readonly rule: LeafRule;
  readonly type: AbiType;
};

export type FieldCheck =
  | { readonly kind: 'match' }
  | { readonly kind: 'mismatch'; readonly findings: readonly Finding[] }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

/**
 * The Safe's owners, in `getOwners()` order, as both providers read them at the block the transaction runs on, for an
 * `ownerBefore` rule; absent when no rule needs them.
 */
export type OwnersRead = { readonly kind: 'read'; readonly owners: readonly Address[] } | { readonly kind: 'unread'; readonly why: string };

/** Chain readings a field rule depends on, read once before the field check. */
export type FieldChain = { readonly owners?: OwnersRead };

/** The first entry of the Safe's owner list points back to this sentinel. */
const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001' as Address;

/** The registry and templates describe Ethereum mainnet contracts only. */
const REGISTRY_CHAIN_ID = 1n;

type Context = {
  readonly safe: Address;
  readonly registry: Registry;
  readonly values: ReadonlyMap<string, ResolvedValue>;
  readonly findings: Finding[];
  readonly unverifiable: string[];
  readonly leaves: Leaf[];
  readonly root: Uint8Array;
  readonly seen: Map<Values, Map<LeafRule, bigint>>;
  readonly chain: FieldChain;
};

const RAY = 10n ** 27n;
const MAX_UINT = (1n << 256n) - 1n;

function remember(rule: LeafRule, actual: ConstValue, context: Context): void {
  if (actual.kind !== 'uint') return;
  const seen = context.seen.get(context.values) ?? new Map<LeafRule, bigint>();
  seen.set(rule, actual.value);
  context.seen.set(context.values, seen);
}

function checkSharePrice(rule: Extract<Rule, { kind: 'share-price' }>, price: bigint, context: Context): string | undefined {
  const amount = (q: Quantity): bigint | undefined => {
    if (q.kind === 'path') return context.seen.get(context.values)?.get(q.rule);
    const value = context.values.get(q.field);
    return value?.kind === 'amount' ? value.value : undefined;
  };
  const [assets, shares] = [amount(rule.assets), amount(rule.shares)];
  if (assets === undefined || shares === undefined) {
    context.unverifiable.push(`a share price bound has no value for ${[rule.assets, rule.shares].map((q) => (q.kind === 'path' ? q.path : q.field)).join(' or ')}`);
    return undefined;
  }
  if (rule.shares.kind === 'path' && shares === MAX_UINT) return 'a stated share count, not the whole balance (2^256-1), to bound the price against';
  const limit = shares === 0n ? 'any' : `${(assets * RAY) / shares}`;
  if (rule.bound === 'max') return price * shares <= assets * RAY ? undefined : `at most ${limit}: ${assets} assets for ${shares} shares, scaled by 1e27`;
  return price * shares >= assets * RAY ? undefined : `at least ${limit}: ${assets} assets for ${shares} shares, scaled by 1e27`;
}

function render(value: ConstValue): string {
  return typeof value.value === 'bigint' || typeof value.value === 'boolean' ? String(value.value) : value.value;
}

function leafOf(value: AbiValue): ConstValue | undefined {
  switch (value.kind) {
    case 'bytes':
    case 'string':
      return { kind: value.kind, value: `0x${bytesToHex(value.value)}` as Hex };
    case 'array':
    case 'tuple':
      return undefined;
    default:
      return value;
  }
}

function expectedOf(rule: Rule, context: Context): ConstValue | undefined {
  switch (rule.kind) {
    case 'safe':
      return { kind: 'address', value: context.safe };
    case 'const':
      return rule.value;
    case 'contract': {
      const entry = context.registry.entries.get(rule.name);
      if (entry === undefined) context.unverifiable.push(`the registry has no ${rule.name}`);
      return entry === undefined ? undefined : { kind: 'address', value: entry.address };
    }
    case 'card': {
      const target = resolveRef(rule.ref, context.values, context.registry);
      if ('problem' in target) {
        context.unverifiable.push(target.problem);
        return undefined;
      }
      switch (target.kind) {
        case 'address':
          return { kind: 'address', value: target.address };
        case 'uint':
          return { kind: 'uint', value: target.value };
        case 'bytes32':
          return { kind: 'fixed-bytes', value: target.value };
        case 'market':
          throw new Error('a whole market binds a tuple, part by part, never a leaf');
      }
    }
    default:
      throw new Error(`a ${rule.kind} rule is not a leaf`);
  }
}

/** The owner before the card's owner in the Safe's owner list, or the finding or reason why there is none. */
function ownerBefore(rule: Extract<Rule, { kind: 'owner-before' }>, context: Context): ConstValue | { readonly expected: string } | undefined {
  const owners = context.chain.owners;
  if (owners === undefined || owners.kind === 'unread') {
    context.unverifiable.push(`the Safe's owners: ${owners?.why ?? 'not read'}`);
    return undefined;
  }
  const target = resolveRef(rule.ref, context.values, context.registry);
  if ('problem' in target || target.kind !== 'address') {
    context.unverifiable.push('problem' in target ? target.problem : `card ${rule.ref.field} is not an address`);
    return undefined;
  }
  const at = owners.owners.indexOf(target.address);
  if (at === -1) return { expected: `the owner before ${target.name} ${target.address}, who is not an owner of the Safe` };
  return { kind: 'address', value: at === 0 ? SENTINEL_OWNERS : (owners.owners[at - 1] as Address) };
}

function compareLeaf(rule: Rule, type: AbiType, actual: ConstValue, bytes: Span | undefined, callPath: string, arg: string, context: Context): void {
  if (rule.kind === 'call' || rule.kind === 'items' || rule.kind === 'fields') throw new Error(`a ${rule.kind} rule is not a leaf`);
  context.leaves.push({ callPath, arg, bytes, rule, type });
  remember(rule, actual, context);
  if (rule.kind === 'free') return;
  if (rule.kind === 'owner-before') {
    const expected = ownerBefore(rule, context);
    if (expected === undefined) return;
    if ('expected' in expected) context.findings.push({ callPath, arg, bytes, expected: expected.expected, actual: render(actual) });
    else if (expected.kind !== actual.kind || expected.value !== actual.value) context.findings.push({ callPath, arg, bytes, expected: render(expected), actual: render(actual) });
    return;
  }
  if (rule.kind === 'equals') {
    const expected = context.seen.get(context.values)?.get(rule.rule);
    if (expected === undefined) context.unverifiable.push(`no value at ${rule.path}`);
    else if (actual.kind !== 'uint' || actual.value !== expected) context.findings.push({ callPath, arg, bytes, expected: `${expected}, as at ${rule.path}`, actual: render(actual) });
    return;
  }
  if (rule.kind === 'share-price') {
    const expected = actual.kind === 'uint' ? checkSharePrice(rule, actual.value, context) : 'a uint';
    if (expected !== undefined) context.findings.push({ callPath, arg, bytes, expected, actual: render(actual) });
    return;
  }
  const expected = expectedOf(rule, context);
  if (expected === undefined) return;
  if (expected.kind === actual.kind && expected.value === actual.value) return;
  context.findings.push({ callPath, arg, bytes, expected: render(expected), actual: render(actual) });
}

/** `itemContexts`, for a merged call's items, gives each item the card values of the operation that put it in. */
function checkValue(rule: Rule, type: AbiType, actual: AbiValue, callPath: string, arg: string, context: Context, itemContexts?: readonly Context[]): void {
  if (rule.kind === 'free') {
    context.leaves.push({ callPath, arg, bytes: actual.span, rule, type });
    if (actual.kind === 'uint') remember(rule, actual, context);
    return;
  }
  if (rule.kind === 'call') {
    if (actual.kind !== 'bytes') throw new Error('a call rule on a value that is not bytes');
    checkCall(rule.call, { root: context.root, start: actual.span[0], end: actual.span[1] }, `${callPath}.${arg}`, context);
    return;
  }
  if (rule.kind === 'items') {
    if (actual.kind !== 'array' || (type.kind !== 'array' && type.kind !== 'fixed-array')) throw new Error('an items rule on a value that is not an array');
    if (actual.items.length !== rule.items.length) {
      context.findings.push({ callPath, arg, bytes: actual.span, expected: `${rule.items.length} items`, actual: `${actual.items.length} items` });
    }
    rule.items.forEach((item, i) => {
      const value = actual.items[i];
      if (value !== undefined) checkValue(item, type.item, value, callPath, `${arg}[${i}]`, itemContexts?.[i] ?? context);
    });
    return;
  }
  if (rule.kind === 'fields') {
    if (actual.kind !== 'tuple' || type.kind !== 'tuple') throw new Error('a fields rule on a value that is not a tuple');
    type.components.forEach((param, i) => {
      checkValue(rule.fields[i] as Rule, param.type, actual.fields[i] as AbiValue, callPath, `${arg}.${paramName(param, i)}`, context);
    });
    return;
  }
  const leaf = leafOf(actual);
  if (leaf === undefined) throw new Error(`a ${rule.kind} rule on a ${actual.kind}`);
  compareLeaf(rule, type, leaf, actual.span, callPath, arg, context);
}

/** `region` decoded as `node`'s function, allowing the trailer the template allows. */
export const decodeTemplateCall = (node: CallNode, region: Region): DecodedCall | DecodeFailure =>
  decodeCall(node.fn, region, { trailerMaxBytes: node.trailer?.maxBytes ?? 0 });

function checkCall(node: CallNode, region: Region, callPath: string, context: Context, itemContexts?: readonly Context[]): void {
  const decoded = decodeTemplateCall(node, region);
  switch (decoded.kind) {
    case 'wrong-selector':
      context.findings.push({ callPath, arg: 'selector', bytes: [decoded.at, decoded.at + 4], expected: `${decoded.expected} ${node.fn.signature}`, actual: decoded.actual });
      return;
    case 'non-canonical':
      context.findings.push({ callPath, arg: 'encoding', bytes: [decoded.at, decoded.at + 1], expected: `canonical ${node.fn.signature}`, actual: `differs at byte ${decoded.at}` });
      return;
    case 'malformed':
      context.findings.push({ callPath, arg: 'encoding', bytes: [decoded.at, decoded.at + 1], expected: node.fn.signature, actual: decoded.problem });
      return;
  }
  const path = `${callPath}.${node.fn.name}`;
  node.fn.params.forEach((param, i) => {
    checkValue(node.args[i] as Rule, param.type, decoded.args[i] as AbiValue, path, paramName(param, i), context, itemContexts);
  });
}

function checkTopCall(call: TemplateCall, inner: InnerCall, context: Context, itemContexts?: readonly Context[]): void {
  if (inner.operation !== 0) {
    context.findings.push({ callPath: inner.path, arg: 'operation', bytes: inner.fields?.operation, expected: '0 (call)', actual: '1 (delegatecall)' });
  }
  compareLeaf(call.to, { kind: 'address' }, { kind: 'address', value: inner.to }, inner.fields?.to, inner.path, 'to', context);
  compareLeaf(call.value, { kind: 'uint', bits: 256 }, { kind: 'uint', value: inner.value }, inner.fields?.value, inner.path, 'value', context);
  if (call.data !== 'empty') {
    checkCall(call.data, inner.data, inner.path, context, itemContexts);
    return;
  }
  const length = inner.data.end - inner.data.start;
  if (length > 0) {
    context.findings.push({ callPath: inner.path, arg: 'data', bytes: [inner.data.start, inner.data.end], expected: 'no data', actual: `${length} bytes` });
  }
}

export type Inspection = { readonly check: FieldCheck; readonly leaves: readonly Leaf[] };

export type Values = ReadonlyMap<string, ResolvedValue>;

/** One operation's items in a merged call, per argument, checked with that operation's card values. */
type Part = { readonly args: readonly (readonly Rule[])[]; readonly values: Values };

/** A call the transaction must make. A merged call holds every part, in card order, in each of its array arguments. */
export type ExpectedCall = { readonly call: TemplateCall; readonly values: Values; readonly parts: readonly Part[] | undefined };

function mergeKey(call: TemplateCall): string {
  const data = call.data === 'empty' ? undefined : call.data;
  const target = call.to.kind === 'contract' ? call.to.name : '';
  return JSON.stringify([target, data?.fn.signature, call.value.kind === 'const' ? String(call.value.value.value) : '', data?.trailer?.maxBytes]);
}

/**
 * The calls the card's operations make, in card order. Calls a template marks `merge` are made once per target and
 * function, after every other call, with each operation's items in card order.
 */
export function expectedCalls(operations: readonly { readonly template: Template; readonly values: Values }[]): ExpectedCall[] {
  const plain: ExpectedCall[] = [];
  const merged = new Map<string, { call: TemplateCall; values: Values; parts: Part[] }>();
  for (const { template, values } of operations) {
    for (const call of template.calls) {
      if (call.merge === undefined || call.data === 'empty') {
        plain.push({ call, values, parts: undefined });
        continue;
      }
      const args = call.data.args.map((arg) => {
        if (arg.kind !== 'items') throw new Error('a merged call with an argument not bound by items');
        return arg.items;
      });
      const key = mergeKey(call);
      const group = merged.get(key) ?? { call, values, parts: [] };
      group.parts.push({ args, values });
      merged.set(key, group);
    }
  }
  const joined = [...merged.values()].map(({ call, values, parts }): ExpectedCall => {
    const data = call.data as CallNode;
    const args = data.args.map((_, a): Rule => ({ kind: 'items', items: parts.flatMap((part) => part.args[a] ?? []) }));
    return { call: { ...call, data: { ...data, args } }, values, parts };
  });
  return [...plain, ...joined];
}

/**
 * Checks every field of `tx` against the card's templates. The calls the Safe makes, after unwrapping an official
 * MultiSend, must be exactly the card's operations' calls in card order, with merged calls last (`expectedCalls`).
 */
export function checkTemplateFields(
  tx: SafeTx,
  card: ResolvedCard,
  templates: ReadonlyMap<string, Template>,
  registry: Registry,
  chain: FieldChain = {},
): FieldCheck {
  return inspectTemplateFields(tx, card, templates, registry, chain).check;
}

/** `checkTemplateFields`, plus every leaf it reached, for the mutation check. */
export function inspectTemplateFields(
  tx: SafeTx,
  card: ResolvedCard,
  templates: ReadonlyMap<string, Template>,
  registry: Registry,
  chain: FieldChain = {},
): Inspection {
  const operations: { template: Template; values: Values }[] = [];
  const nonces: { rule: Rule; values: Values }[] = [];
  for (const op of card.operations) {
    const template = templates.get(op.template);
    if (template === undefined) return { check: { kind: 'unverifiable', reasons: [`no template ${op.template}`] }, leaves: [] };
    operations.push({ template, values: op.values });
    if (template.nonce !== undefined) nonces.push({ rule: template.nonce, values: op.values });
  }
  const expected = expectedCalls(operations);
  const findings: Finding[] = [];
  const unverifiable: string[] = [];
  const leaves: Leaf[] = [];
  const done = (check: FieldCheck): Inspection => ({ check, leaves });
  const seen = new Map<Values, Map<LeafRule, bigint>>();
  const contextFor = (values: Values, root: Uint8Array): Context => ({
    safe: card.safe,
    registry,
    values,
    findings,
    unverifiable,
    leaves,
    root,
    seen,
    chain,
  });
  for (const { rule, values } of nonces) {
    compareLeaf(rule, { kind: 'uint', bits: 256 }, { kind: 'uint', value: tx.nonce }, undefined, 'safeTx', 'nonce', contextFor(values, new Uint8Array()));
  }
  if (tx.chainId !== REGISTRY_CHAIN_ID) {
    findings.push({ callPath: 'safeTx', arg: 'chainId', bytes: undefined, expected: String(REGISTRY_CHAIN_ID), actual: String(tx.chainId) });
  }
  if (tx.safe !== card.safe) findings.push({ callPath: 'safeTx', arg: 'safe', bytes: undefined, expected: card.safe, actual: tx.safe });
  const unwrapped = unwrapSafeTx(tx);
  switch (unwrapped.kind) {
    case 'foreign-delegatecall':
      findings.push({ callPath: 'safeTx', arg: 'to', bytes: undefined, expected: 'an official MultiSend for a delegatecall', actual: unwrapped.to });
      return done({ kind: 'mismatch', findings });
    case 'malformed':
    case 'non-canonical':
    case 'wrong-selector':
      findings.push({ callPath: 'safeTx', arg: 'data', bytes: [unwrapped.at, unwrapped.at + 1], expected: 'canonical multiSend(bytes)', actual: unwrapped.kind });
      return done({ kind: 'mismatch', findings });
  }
  if (unwrapped.kind === 'multisend' && tx.value !== 0n) {
    findings.push({ callPath: 'safeTx', arg: 'value', bytes: undefined, expected: '0', actual: String(tx.value) });
  }
  const calls = unwrapped.calls;
  const root = calls[0]?.data.root ?? new Uint8Array();
  for (const [i, inner] of calls.entries()) {
    const wanted = expected[i];
    if (wanted === undefined) {
      findings.push({ callPath: inner.path, arg: 'call', bytes: inner.span, expected: 'no call', actual: `a call to ${inner.to}` });
      continue;
    }
    const itemContexts = wanted.parts?.flatMap((part) => (part.args[0] ?? []).map(() => contextFor(part.values, root)));
    checkTopCall(wanted.call, inner, contextFor(wanted.values, root), itemContexts);
  }
  for (const [i, wanted] of expected.entries()) {
    if (i < calls.length) continue;
    const signature = wanted.call.data === 'empty' ? 'a call without data' : wanted.call.data.fn.signature;
    findings.push({ callPath: `multiSend[${i}]`, arg: 'call', bytes: undefined, expected: signature, actual: 'missing' });
  }
  if (findings.length > 0) return done({ kind: 'mismatch', findings });
  if (unverifiable.length > 0) return done({ kind: 'unverifiable', reasons: unverifiable });
  return done({ kind: 'match' });
}
