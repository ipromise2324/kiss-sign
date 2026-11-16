import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { Transaction } from '../chain/types.ts';
import { safeProxyFactory } from '../contracts/proxy.ts';
import { parseFunctionSignature } from '../decode/abi.ts';
import type { AbiType } from '../decode/abi.ts';
import { decodeCall, wholeRegion } from '../decode/codec.ts';
import type { AbiValue, Region, Span } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import type { InnerCall } from '../decode/multisend.ts';
import type { Market, Registry } from '../registry.ts';
import { OFFICIAL_SAFE_SINGLETONS } from '../safe/deployments.ts';
import { EXECUTION_SUCCESS } from '../simulate/events.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { decodeTemplateCall, inspectTemplateFields } from '../template/check.ts';
import type { Leaf } from '../template/check.ts';
import { isMarketEntryPart } from '../registry.ts';
import { targetNames } from '../template/template.ts';
import type { CallNode, ConstValue, LeafRule, Rule, Template, TemplateCall } from '../template/template.ts';
import type { Anchor } from './sources.ts';


/**
 * The template with every leaf set free, so only its shape is checked (calls, selectors, canonical encoding, trailers),
 * and the original leaf rules in the order the check visits them, so each leaf the check reports pairs with its rule.
 */
export type Loosened = { readonly shape: Template; readonly anyTrailer: Template; readonly rules: readonly LeafRule[] };

const MAX_TRAILER = 32;
const ZERO = `0x${'00'.repeat(20)}` as Address;

export function loosen(template: Template): Loosened {
  const rules: LeafRule[] = [];
  const looseRule = (rule: Rule, wideTrailer: boolean, record: boolean): Rule => {
    switch (rule.kind) {
      case 'call':
        return { kind: 'call', call: looseCall(rule.call, wideTrailer, record) };
      case 'items':
        return { kind: 'items', items: rule.items.map((item) => looseRule(item, wideTrailer, record)) };
      case 'fields':
        return { kind: 'fields', fields: rule.fields.map((field) => looseRule(field, wideTrailer, record)) };
      case 'packed':
      case 'eip712':
        return { kind: 'free', reason: 'study', claim: 'unread' };
      default:
        if (record) rules.push(rule);
        return { kind: 'free', reason: 'study', claim: 'scalar' };
    }
  };
  const looseCall = (node: CallNode, wideTrailer: boolean, record: boolean): CallNode => ({
    fn: node.fn,
    args: node.args.map((arg) => looseRule(arg, wideTrailer, record)),
    trailer: wideTrailer ? { maxBytes: MAX_TRAILER, why: 'study' } : node.trailer,
  });
  const looseTop = (call: TemplateCall, wideTrailer: boolean, record: boolean): TemplateCall => {
    const to = looseRule(call.to, wideTrailer, record);
    const value = looseRule(call.value, wideTrailer, record);
    return { to, value, data: call.data === 'empty' ? 'empty' : looseCall(call.data, wideTrailer, record), merge: call.merge };
  };
  // An execTransaction call does not carry the Safe's nonce, so a study never checks it.
  const shape = { ...template, nonce: undefined, calls: template.calls.map((call) => looseTop(call, false, true)) };
  const anyTrailer = { ...template, nonce: undefined, calls: template.calls.map((call) => looseTop(call, true, false)) };
  return { shape, anyTrailer, rules };
}

export type NotStudiedReason = 'execTransaction calldata does not decode' | 'no ExecutionSuccess from the Safe' | 'calls no function the template calls';

export type UnprovenReason = 'its code is not a known Safe proxy' | 'its singleton is not an official Safe singleton';

/** A call as a misfit names it: the contract it goes to, when known, and its selector, undefined for a call with no data. */
export type CallName = { readonly to: Address | undefined; readonly selector: Hex | undefined };

/** Why a transaction does not fit the template's shape. */
export type MisfitReason =
  | { readonly kind: 'foreign-delegatecall' }
  | { readonly kind: 'multisend-noncanonical' }
  /** The Safe made other calls than the template's. */
  | { readonly kind: 'calls'; readonly calls: readonly CallName[] }
  | { readonly kind: 'trailer'; readonly at: string }
  /** An array with another number of items; `calls` names each item when the template decodes the items as calls. */
  | { readonly kind: 'items'; readonly at: string; readonly expected: number; readonly got: number; readonly calls: readonly CallName[] | undefined }
  | { readonly kind: 'field'; readonly at: string; readonly expected: string; readonly actual: string }
  /** A leaf the template binds to the Safe holds another address than the sender's. */
  | { readonly kind: 'not-sender'; readonly at: string }
  /** A leaf the template binds to the same value as the leaf at `other` holds another value. */
  | { readonly kind: 'differs'; readonly at: string; readonly other: string }
  /**
   * An address the template binds to registry entries, such as a call's `to` bound to the card's vault, holds another
   * contract than any of them: one a `contract` rule names, or, for a card field that can name the anchor token, any
   * address but the anchor token.
   */
  | { readonly kind: 'entry'; readonly at: string; readonly expected: readonly string[]; readonly actual: Address }
  | { readonly kind: 'other' };

/**
 * What the recording shows an address outside the registry to be: a card market's parts that are no market of the
 * registry, the anchor token as a token, or under a mint or burn anchor as a vault, and otherwise only an address.
 */
export type OutsideKind = 'market' | 'token' | 'vault' | 'address';

/** A place the template binds to registry entries that holds none of them, in a transaction with the template's shape. */
export type Outside = { readonly at: string; readonly kind: OutsideKind };

/**
 * Who made the template's calls: a proven Safe making all of them in one transaction, or an EOA making the template's
 * call number `call` as its own transaction.
 */
export type Sender = { readonly kind: 'safe'; readonly address: Address } | { readonly kind: 'eoa'; readonly address: Address; readonly call: number };

export type TxStudy =
  | { readonly kind: 'excluded' }
  | { readonly kind: 'unreadable'; readonly hash: Hex; readonly reason: string }
  /** `to` is the contract the transaction called, absent for a contract creation. */
  | { readonly kind: 'not-studied'; readonly hash: Hex; readonly why: NotStudiedReason; readonly to: Address | undefined; readonly selector: string }
  | { readonly kind: 'unproven'; readonly hash: Hex; readonly contract: Address; readonly why: UnprovenReason }
  | { readonly kind: 'misfit'; readonly hash: Hex; readonly sender: Sender; readonly reason: MisfitReason }
  /**
   * The template's calls and arguments: exactly the template when `outside` is empty. `values` pairs with the rules of
   * the sender's `Shape`; `paths` names each leaf.
   */
  | {
      readonly kind: 'fit';
      readonly hash: Hex;
      readonly block: bigint;
      readonly sender: Sender;
      readonly paths: readonly string[];
      readonly types: readonly AbiType[];
      readonly values: readonly string[];
      readonly outside: readonly Outside[];
    };

/** A Safe's transaction that makes none of the template's top-level calls: another operation, not a variant of this one. */
export function isOtherOperation(study: TxStudy, template: Template): boolean {
  if (study.kind !== 'misfit' || study.sender.kind !== 'safe' || study.reason.kind !== 'calls') return false;
  const own = new Set(template.calls.flatMap((call) => (call.data === 'empty' ? [] : [call.data.fn.selector as string])));
  return !study.reason.calls.some((c) => c.selector !== undefined && own.has(c.selector));
}

const EXEC_TRANSACTION = parseFunctionSignature(
  'execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)',
);

const EMPTY_SAFE_TX: SafeTx = {
  chainId: 1n,
  safe: ZERO,
  version: '1.4.1',
  to: ZERO,
  value: 0n,
  data: '0x' as Hex,
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: ZERO,
  refundReceiver: ZERO,
  nonce: 0n,
};

function safeTxOf(safe: Address, input: Hex): SafeTx | undefined {
  const call = decodeCall(EXEC_TRANSACTION, wholeRegion(hexToBytes(input.slice(2))));
  if (call.kind !== 'decoded') return undefined;
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver] = call.args.map((arg) =>
    arg.kind === 'bytes' ? (`0x${bytesToHex(arg.value)}` as Hex) : 'value' in arg ? arg.value : undefined,
  );
  if (operation !== 0n && operation !== 1n) return undefined;
  return {
    ...EMPTY_SAFE_TX,
    safe,
    to: to as Address,
    value: value as bigint,
    data: data as Hex,
    operation: operation === 0n ? 0 : 1,
    safeTxGas: safeTxGas as bigint,
    baseGas: baseGas as bigint,
    gasPrice: gasPrice as bigint,
    gasToken: gasToken as Address,
    refundReceiver: refundReceiver as Address,
  };
}

export function leafValue(leaf: Leaf, tx: SafeTx): string {
  if (leaf.bytes === undefined) return leaf.arg === 'to' ? tx.to : String(tx.value);
  const bytes = hexToBytes(tx.data.slice(2)).subarray(leaf.bytes[0], leaf.bytes[1]);
  const word = BigInt(`0x${bytesToHex(bytes) || '0'}`);
  switch (leaf.type.kind) {
    case 'address':
      return `0x${bytesToHex(bytes.subarray(bytes.length - 20))}`;
    case 'uint':
      return word.toString();
    case 'int':
      return BigInt.asIntN(leaf.type.bits, word).toString();
    case 'bool':
      return word === 0n ? 'false' : 'true';
    case 'fixed-bytes':
      return `0x${bytesToHex(bytes.subarray(0, leaf.type.size))}`;
    default:
      return `0x${bytesToHex(bytes)}`;
  }
}

/** A constant rendered the way `leafValue` renders the same bytes. */
export function constText(value: ConstValue): string {
  return typeof value.value === 'bigint' || typeof value.value === 'boolean' ? String(value.value) : value.value;
}

/** The name of each function the template calls, by selector. */
export function functionNames(template: Template): Map<string, string> {
  const names = new Map<string, string>();
  const visitRule = (rule: Rule): void => {
    if (rule.kind === 'call') visitCall(rule.call);
    if (rule.kind === 'items') rule.items.forEach(visitRule);
    if (rule.kind === 'fields') rule.fields.forEach(visitRule);
  };
  const visitCall = (node: CallNode): void => {
    names.set(node.fn.selector, node.fn.name);
    node.args.forEach(visitRule);
  };
  for (const call of template.calls) if (call.data !== 'empty') visitCall(call.data);
  return names;
}

const selectorOf = (bytes: Uint8Array): Hex | undefined => (bytes.length === 0 ? undefined : (`0x${bytesToHex(bytes.subarray(0, 4))}` as Hex));
const firstOf = <T>(items: readonly (T | undefined)[]): T | undefined => items.find((item) => item !== undefined);

/** The only address a tuple holds, such as the target beside a bundled call's data. */
function onlyAddress(value: Extract<AbiValue, { kind: 'tuple' }>): Address | undefined {
  const addresses = value.fields.filter((field) => field.kind === 'address');
  return addresses.length === 1 && addresses[0]?.kind === 'address' ? addresses[0].value : undefined;
}

/**
 * The items of the array at `span`, found by walking the template's rules over the calls it decodes, each named as a
 * call when the template decodes the items as calls: an item that is a call goes to the contract the array's call goes
 * to, and an item that is a tuple to the one address beside its call. Undefined when the items are no calls.
 */
function itemCalls(calls: readonly InnerCall[], template: Template, span: Span): CallName[] | undefined {
  const name = (rule: Rule | undefined, item: AbiValue, target: Address | undefined): CallName | undefined => {
    if (rule?.kind === 'call') return item.kind === 'bytes' ? { to: target, selector: selectorOf(item.value) } : undefined;
    if (rule?.kind !== 'fields' || item.kind !== 'tuple') return undefined;
    const data = item.fields[rule.fields.findIndex((field) => field.kind === 'call')];
    return data?.kind === 'bytes' ? { to: onlyAddress(item), selector: selectorOf(data.value) } : undefined;
  };
  const visit = (rule: Rule, value: AbiValue | undefined, root: Uint8Array, target: Address | undefined): CallName[] | undefined => {
    if (value === undefined) return undefined;
    if (rule.kind === 'call') return value.kind === 'bytes' ? visitCall(rule.call, { root, start: value.span[0], end: value.span[1] }, target) : undefined;
    if (rule.kind === 'fields') return value.kind === 'tuple' ? firstOf(rule.fields.map((field, i) => visit(field, value.fields[i], root, onlyAddress(value) ?? target))) : undefined;
    if (rule.kind !== 'items' || value.kind !== 'array') return undefined;
    if (value.span[0] !== span[0] || value.span[1] !== span[1]) return firstOf(rule.items.map((item, i) => visit(item, value.items[i], root, target)));
    const named = value.items.map((item) => name(rule.items[0], item, target));
    return named.every((call) => call !== undefined) ? (named as CallName[]) : undefined;
  };
  const visitCall = (node: CallNode, region: Region, target: Address | undefined): CallName[] | undefined => {
    const decoded = decodeTemplateCall(node, region);
    return decoded.kind === 'decoded' ? firstOf(node.args.map((arg, i) => visit(arg, decoded.args[i], region.root, target))) : undefined;
  };
  return firstOf(template.calls.map((call, i) => (call.data === 'empty' || calls[i] === undefined ? undefined : visitCall(call.data, calls[i].data, calls[i].to))));
}

const ITEMS = /^(\d+) items$/;

/** Why a transaction does not fit the template's shape. */
function misfitReason(tx: SafeTx, loosened: Loosened, template: Template, context: StudyContext, check: (t: Template) => ReturnType<typeof inspectTemplateFields>): MisfitReason {
  const { registry } = context;
  const unwrapped = unwrapSafeTx(tx);
  if (unwrapped.kind === 'foreign-delegatecall') return { kind: 'foreign-delegatecall' };
  if (unwrapped.kind !== 'direct' && unwrapped.kind !== 'multisend') return { kind: 'multisend-noncanonical' };
  const sameCalls =
    unwrapped.calls.length === template.calls.length &&
    unwrapped.calls.every((call, i) => {
      const data = template.calls[i]?.data;
      if (data === 'empty') return call.data.end === call.data.start;
      return data !== undefined && call.data.end - call.data.start >= 4 && bytesToHex(call.data.root.subarray(call.data.start, call.data.start + 4)) === data.fn.selector.slice(2);
    });
  if (!sameCalls) return { kind: 'calls', calls: unwrapped.calls.map((call) => ({ to: call.to, selector: selectorOf(call.data.root.subarray(call.data.start, call.data.end)) })) };
  const anchorHeld = unwrapped.calls.some((call) => call.to === context.anchor.token);
  for (const [i, call] of unwrapped.calls.entries()) {
    const bound = boundEntry((template.calls[i] as TemplateCall).to, call.to, `${call.path}.to`, template, context, anchorHeld);
    if (bound?.kind === 'entry') return bound;
  }
  const wide = check(loosened.anyTrailer).check;
  const strict = check(loosened.shape).check;
  const first = strict.kind === 'mismatch' ? strict.findings[0] : undefined;
  if (wide.kind === 'match') return { kind: 'trailer', at: first?.callPath ?? 'a call' };
  if (first === undefined) return { kind: 'other' };
  const at = `${first.callPath}.${first.arg}`;
  const [expected, got] = [ITEMS.exec(first.expected), ITEMS.exec(first.actual)];
  if (expected === null || got === null || first.bytes === undefined) return { kind: 'field', at, expected: first.expected, actual: first.actual };
  return { kind: 'items', at, expected: Number(expected[1]), got: Number(got[1]), calls: itemCalls(unwrapped.calls, template, first.bytes) };
}

/** A misfit in words that group alike transactions, each call named by its registry name and the template's function names. */
export function misfitText(reason: MisfitReason, registry: Registry, names: ReadonlyMap<string, string>): string {
  const call = ({ to, selector }: CallName): string => {
    const target = to === undefined ? 'another contract' : (registry.byAddress.get(to)?.name ?? checksumAddress(to));
    return selector === undefined ? `${target} (no data)` : `${target}.${names.get(selector) ?? selector}`;
  };
  switch (reason.kind) {
    case 'foreign-delegatecall':
      return 'a delegatecall to a contract that is not an official MultiSend';
    case 'multisend-noncanonical':
      return 'a MultiSend batch that does not decode canonically';
    case 'calls':
      return `calls ${reason.calls.map(call).join(', ')}`;
    case 'trailer':
      return `more bytes after the arguments than the template allows, at ${reason.at}`;
    case 'items':
      return `${reason.at}: expected ${reason.expected} items, got ${reason.got} items${reason.calls === undefined ? '' : `, calling ${reason.calls.map(call).join(', ')}`}`;
    case 'field':
      return `${reason.at}: expected ${reason.expected}, got ${reason.actual}`;
    case 'not-sender':
      return `${reason.at}: not the sender`;
    case 'differs':
      return `${reason.at}: differs from ${reason.other}`;
    case 'entry':
      return `${reason.at}: expected ${reason.expected.join(' or ')}, got ${registry.byAddress.get(reason.actual)?.name ?? checksumAddress(reason.actual)}`;
    case 'other':
      return 'does not fit';
  }
}

export type Shape = { readonly template: Template; readonly loosened: Loosened };

export function shapesOf(template: Template): { readonly whole: Shape; readonly calls: readonly Shape[] } {
  const shape = (t: Template): Shape => ({ template: t, loosened: loosen(t) });
  return { whole: shape(template), calls: template.calls.map((call) => shape({ ...template, calls: [call] })) };
}

export type StudyContext = {
  readonly shapes: ReturnType<typeof shapesOf>;
  readonly registry: Registry;
  /** The configured Safe, left out of every result. */
  readonly exclude: Address | undefined;
  /** The token whose transfers found the transactions, and which transfers. */
  readonly anchor: Pick<Anchor, 'token' | 'kind'>;
};

type Proof = { readonly kind: 'proven' } | { readonly kind: 'unproven'; readonly why: UnprovenReason } | { readonly kind: 'unreadable'; readonly reason: string };

async function proveSafe(reader: Reader, address: Address, blockNumber: bigint): Promise<Proof> {
  const block = await reader.block(blockNumber - 1n);
  if (block.kind === 'unverifiable') return { kind: 'unreadable', reason: block.reason };
  const code = await reader.getCode(address, block.value);
  if (code.kind === 'unverifiable') return { kind: 'unreadable', reason: code.reason };
  if (safeProxyFactory(code.value) === undefined) return { kind: 'unproven', why: 'its code is not a known Safe proxy' };
  const slot = await reader.getStorageAt(address, 0n, block.value);
  if (slot.kind === 'unverifiable') return { kind: 'unreadable', reason: slot.reason };
  const official = OFFICIAL_SAFE_SINGLETONS.some((s) => slot.value === `0x${'00'.repeat(12)}${s.address.slice(2)}`);
  return official ? { kind: 'proven' } : { kind: 'unproven', why: 'its singleton is not an official Safe singleton' };
}

function judge({ hash, block }: { readonly hash: Hex; readonly block: bigint }, tx: SafeTx, sender: Sender, shape: Shape, context: StudyContext): TxStudy {
  const { template, loosened } = shape;
  const { registry } = context;
  const check = (t: Template) =>
    inspectTemplateFields(tx, { safe: sender.address, operations: [{ template: template.id, values: new Map() }] }, new Map([[template.id, t]]), registry);
  const inspection = check(loosened.shape);
  if (inspection.check.kind !== 'match' || inspection.leaves.length !== loosened.rules.length) {
    return { kind: 'misfit', hash, sender, reason: misfitReason(tx, loosened, template, context, check) };
  }
  const paths = inspection.leaves.map((leaf) => `${leaf.callPath}.${leaf.arg}`);
  const values = inspection.leaves.map((leaf) => leafValue(leaf, tx));
  const bound = boundEntries(paths, values, loosened.rules, template, context);
  const wrongTarget = bound.kind === 'misfit' && bound.reason.kind === 'entry' && bound.reason.at.endsWith('.to');
  const broken = wrongTarget ? undefined : loosened.rules.map((rule, i) => brokenRule(rule, i, loosened.rules, paths, values, sender)).find((reason) => reason !== undefined);
  if (broken !== undefined) return { kind: 'misfit', hash, sender, reason: broken };
  if (bound.kind === 'misfit') return { kind: 'misfit', hash, sender, reason: bound.reason };
  return { kind: 'fit', hash, block, sender, paths, types: inspection.leaves.map((leaf) => leaf.type), values, outside: bound.outside };
}

const cardKey = (rule: LeafRule): string | undefined => (rule.kind === 'card' ? `${rule.ref.field}.${rule.ref.attribute ?? ''}` : undefined);

/**
 * The reason leaf `i` breaks its rule, when the transaction alone shows it. A card value is unknown, so a card rule
 * breaks only where two leaves bound to it differ; an `equals` naming a leaf of a call an EOA did not make has nothing
 * to compare. Registry bindings are judged by `boundEntries`.
 */
export function brokenRule(
  rule: LeafRule,
  i: number,
  rules: readonly LeafRule[],
  paths: readonly string[],
  values: readonly string[],
  sender: Sender,
): MisfitReason | undefined {
  const at = paths[i] as string;
  const actual = values[i] as string;
  const differs = (j: number): MisfitReason | undefined => (j === -1 || values[j] === actual ? undefined : { kind: 'differs', at, other: paths[j] as string });
  switch (rule.kind) {
    case 'safe':
      return actual === sender.address ? undefined : { kind: 'not-sender', at };
    case 'const': {
      const expected = constText(rule.value);
      return actual === expected ? undefined : { kind: 'field', at, expected, actual };
    }
    case 'card':
      return differs(rules.findIndex((other, k) => cardKey(other) === cardKey(rule) && values[k] !== actual));
    case 'equals':
      return differs(rules.indexOf(rule.rule));
    case 'contract':
    case 'free':
    case 'share-price':
    case 'at-least':
      return undefined;
  }
}

/**
 * Whether `value`, at a place `rule` binds to registry entries, holds one of them: undefined when it does or the rule
 * binds none, else where it is outside the registry or the misfit of another contract. A contract the template names
 * is that contract. A card field that can name the anchor token, in a transaction that binds the anchor token nowhere
 * (`anchorHeld` false), found it through that token, so another address there is another contract, such as a wrapper
 * with the vault's function. Any other address is outside the registry, named by what the anchor shows of it.
 */
function boundEntry(
  rule: Rule,
  value: Address,
  at: string,
  template: Template,
  context: StudyContext,
  anchorHeld: boolean,
): Extract<MisfitReason, { kind: 'entry' }> | Outside | undefined {
  const { registry, anchor } = context;
  const names = targetNames(rule, template, registry);
  const holds = (address: Address) => names?.some((name) => registry.entries.get(name)?.address === address) ?? false;
  if (names === undefined || holds(value)) return undefined;
  if (rule.kind !== 'card' || (holds(anchor.token) && !anchorHeld)) return { kind: 'entry', at, expected: names, actual: value };
  if (value !== anchor.token) return { at, kind: 'address' };
  const kinds = new Set(names.map((name) => registry.entries.get(name)?.kind));
  if (kinds.size === 1 && kinds.has('token')) return { at, kind: 'token' };
  if (kinds.size === 1 && kinds.has('vault') && anchor.kind !== 'any') return { at, kind: 'vault' };
  return { at, kind: 'address' };
}

/**
 * Each place the template binds to registry entries that holds none of them, or the first that holds another
 * contract. The parts of a card market count together: they are outside the registry unless they are the parts of one
 * market of the registry, its lltv included.
 */
function boundEntries(
  paths: readonly string[],
  values: readonly string[],
  rules: readonly LeafRule[],
  template: Template,
  context: StudyContext,
): { readonly kind: 'misfit'; readonly reason: MisfitReason } | { readonly kind: 'shape'; readonly outside: readonly Outside[] } {
  const outside: Outside[] = [];
  const markets = new Map<string, { at: string; parts: [string, string][] }>();
  const anchorHeld = rules.some((rule, i) => values[i] === context.anchor.token && targetNames(rule, template, context.registry) !== undefined);
  for (const [i, rule] of rules.entries()) {
    const value = values[i] as string;
    const at = paths[i] as string;
    if (rule.kind === 'card' && template.card.get(rule.ref.field)?.kind === 'market' && !at.endsWith('.to')) {
      const market = markets.get(rule.ref.field) ?? { at: at.slice(0, at.lastIndexOf('.')), parts: [] };
      if (rule.ref.attribute !== undefined) market.parts.push([rule.ref.attribute, value]);
      markets.set(rule.ref.field, market);
      continue;
    }
    const bound = boundEntry(rule, value as Address, at, template, context, anchorHeld);
    if (bound?.kind === 'entry') return { kind: 'misfit', reason: bound };
    if (bound !== undefined) outside.push(bound);
  }
  const partOf = (market: Market, part: string): string | undefined => {
    if (part === 'lltv') return String(market.lltv);
    if (part === 'id') return market.id;
    return isMarketEntryPart(part) ? market[part].address : undefined;
  };
  for (const { at, parts } of markets.values()) {
    if (![...context.registry.markets.values()].some((market) => parts.every(([part, value]) => partOf(market, part) === value))) outside.push({ at, kind: 'market' });
  }
  return { kind: 'shape', outside };
}

async function studySafeTx(reader: Reader, tx: Transaction & { readonly to: Address; readonly blockNumber: bigint }, context: StudyContext): Promise<TxStudy> {
  const { hash } = tx;
  const proof = await proveSafe(reader, tx.to, tx.blockNumber);
  if (proof.kind === 'unreadable') return { kind: 'unreadable', hash, reason: proof.reason };
  if (proof.kind === 'unproven') return { kind: 'unproven', hash, contract: tx.to, why: proof.why };
  const selector = tx.input.slice(0, 10);
  const safeTx = safeTxOf(tx.to, tx.input);
  if (safeTx === undefined) return { kind: 'not-studied', hash, why: 'execTransaction calldata does not decode', to: tx.to, selector };
  const receiptRead = await reader.getTransactionReceipt(hash);
  if (receiptRead.kind === 'unverifiable') return { kind: 'unreadable', hash, reason: receiptRead.reason };
  const receipt = receiptRead.value;
  if (receipt === null || !receipt.logs.some((log) => log.address === tx.to && log.topics[0] === EXECUTION_SUCCESS)) {
    return { kind: 'not-studied', hash, why: 'no ExecutionSuccess from the Safe', to: tx.to, selector };
  }
  return judge({ hash, block: tx.blockNumber }, safeTx, { kind: 'safe', address: tx.to }, context.shapes.whole, context);
}

function studyDirectCall(tx: Transaction & { readonly to: Address; readonly blockNumber: bigint }, context: StudyContext): TxStudy {
  const selector = tx.input.length >= 10 ? tx.input.slice(0, 10) : 'no data';
  const candidates = context.shapes.calls.flatMap((shape, call) => {
    const templateCall = shape.template.calls[0];
    const data = templateCall?.data;
    const same = data === 'empty' ? tx.input.length === 2 : data !== undefined && selector === data.fn.selector;
    // A named contract pins the call's target, so the same selector on another contract is another function.
    const target = templateCall?.to.kind !== 'contract' || context.registry.entries.get(templateCall.to.name)?.address === tx.to;
    return same && target ? [{ shape, call }] : [];
  });
  if (candidates.length === 0) return { kind: 'not-studied', hash: tx.hash, why: 'calls no function the template calls', to: tx.to, selector };
  const direct: SafeTx = { ...EMPTY_SAFE_TX, safe: tx.from, to: tx.to, value: tx.value, data: tx.input };
  const studies = candidates.map(({ shape, call }) => judge({ hash: tx.hash, block: tx.blockNumber }, direct, { kind: 'eoa', address: tx.from, call }, shape, context));
  return studies.find((study) => study.kind === 'fit' && study.outside.length === 0) ?? studies.find((study) => study.kind === 'fit') ?? (studies[0] as TxStudy);
}

export async function studyTx(reader: Reader, hash: Hex, context: StudyContext): Promise<TxStudy> {
  const read = await reader.getTransaction(hash);
  if (read.kind === 'unverifiable') return { kind: 'unreadable', hash, reason: read.reason };
  const tx = read.value;
  if (tx === null) return { kind: 'unreadable', hash, reason: 'neither provider knows the transaction' };
  if (context.exclude !== undefined && (tx.to === context.exclude || tx.from === context.exclude)) return { kind: 'excluded' };
  const { to, blockNumber } = tx;
  if (to === null) return { kind: 'not-studied', hash, why: 'calls no function the template calls', to: undefined, selector: 'contract creation' };
  if (blockNumber === null) return { kind: 'unreadable', hash, reason: 'the transaction is pending' };
  if (tx.input.startsWith(EXEC_TRANSACTION.selector)) return studySafeTx(reader, { ...tx, to, blockNumber }, context);
  return studyDirectCall({ ...tx, to, blockNumber }, context);
}
