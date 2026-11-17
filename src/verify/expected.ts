import { bytesToHex } from '@noble/hashes/utils.js';
import type { AddressBook } from '../address-book.ts';
import { percentText, resolveRef } from '../card.ts';
import type { ResolvedCard } from '../card.ts';
import { wholeTokens } from '../chain/decimals.ts';
import { canonicalType } from '../decode/abi.ts';
import { castValue } from '../decode/cast.ts';
import type { AbiValue, Region } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import type { Registry } from '../registry.ts';
import { hashSafeTx } from '../safe/hash.ts';
import type { Address, Hex, SafeTx, SafeTxHashes } from '../safe/types.ts';
import { decodeTemplateCall, expectedCalls } from '../template/check.ts';
import type { ExpectedCall, Values } from '../template/check.ts';
import { signedStructs } from '../template/template.ts';
import type { CallNode, Rule, Template, TokenRef, TrailerAllowance } from '../template/template.ts';

/** What kiss-sign knows an address as: the Safe, the zero address, a registry entry or an address-book entry. */
export type Label =
  | { readonly kind: 'safe' }
  | { readonly kind: 'zero' }
  | { readonly kind: 'registry' | 'address-book'; readonly name: string }
  | undefined;

export type Labeled = { readonly address: Address; readonly label: Label };

/**
 * What the last column says of an argument the card bounds: its value in whole tokens, such as `244.093807 usdc`, or as a
 * percent, such as `5%`; or that it is a share price bound, whose value counts no token.
 */
export type ArgNote = { readonly kind: 'equals'; readonly text: string } | { readonly kind: 'share-price'; readonly bound: 'max' | 'min' };

/** One argument as `cast decode-calldata` prints it, and what the last column says of it. */
export type ShownArg = { readonly text: string; readonly note: ArgNote | undefined };

/**
 * `bytes` the template reads as `encoded` parameters (`abi`) or `packed` parts, which no ABI describes. `at` is the
 * argument's number, then each step into an item, a component, or a part of the layout read above it, all from 1.
 */
export type Layout = { readonly at: readonly number[]; readonly kind: 'abi' | 'packed'; readonly types: readonly string[] };

export type Decoded = {
  readonly kind: 'decoded';
  readonly signature: string;
  readonly selector: Hex;
  readonly args: readonly ShownArg[];
  /** Bytes after the arguments, and the template's allowance they fall within. */
  readonly trailer: { readonly hex: Hex; readonly allowance: TrailerAllowance } | undefined;
  /** Every address among the arguments, outside bytes, once each, ordered by its lowercase hex. */
  readonly addresses: readonly Labeled[];
  readonly layouts: readonly Layout[];
  readonly nested: Nested | undefined;
};

/** `raw` is data no template function decodes, shown as it is. */
export type CallData = { readonly kind: 'empty' } | { readonly kind: 'raw'; readonly hex: Hex } | Decoded;

/**
 * Calls inside a call's data: an official MultiSend's calls, each made by the Safe; a Bundler3 `multicall` bundle; or
 * calls the template decodes from other `bytes` arguments.
 */
export type Nested =
  | { readonly kind: 'multisend'; readonly calls: readonly SafeCall[] }
  | { readonly kind: 'bundle'; readonly calls: readonly BundleCall[] }
  | { readonly kind: 'bytes'; readonly calls: readonly CallData[] };

/** A call the Safe makes. `number` counts them as check.sh does: 1 is the Safe transaction itself, then a MultiSend's calls. */
export type SafeCall = { readonly number: number; readonly to: Labeled; readonly value: bigint; readonly operation: 0 | 1; readonly data: CallData };

export type BundleCall = { readonly to: Labeled; readonly value: bigint; readonly data: CallData };

export type CallTree = { readonly nonce: bigint; readonly hashes: SafeTxHashes; readonly top: SafeCall; readonly count: number };

export type TreeContext = {
  readonly registry: Registry;
  readonly safe: Address;
  readonly card: ResolvedCard;
  readonly templates: ReadonlyMap<string, Template>;
  readonly addressBook: AddressBook;
  /** decimals() of the tokens `amountTokens` names; a token missing here gets no whole-token amount. */
  readonly decimals: ReadonlyMap<Address, number>;
};

const BUNDLER3_MULTICALL = 'multicall((address,bytes,uint256,bool,bytes32)[])';
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

type Walk = TreeContext & { readonly names: ReadonlyMap<Address, Label>; readonly templateOf: ReadonlyMap<Values, Template>; readonly root: Uint8Array };

const hex = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}` as Hex;

function labeled(address: Address, walk: Walk): Labeled {
  if (address === walk.safe) return { address, label: { kind: 'safe' } };
  if (address === ZERO) return { address, label: { kind: 'zero' } };
  return { address, label: walk.names.get(address) };
}

export type AmountToken = { readonly address: Address | 'eth'; readonly name: string };

export function amountToken(of: TokenRef, values: Values, registry: Registry): AmountToken | undefined {
  if (of === 'eth') return { address: 'eth', name: 'ETH' };
  if (values.get(of.field)?.kind !== 'contract') return undefined;
  const target = resolveRef(of, values, registry);
  return 'kind' in target && target.kind === 'address' ? { address: target.address, name: target.name } : undefined;
}

/** The struct name of each message a template on the card signs by its digest, such as `Order`, once each. */
export function signedMessages(card: ResolvedCard, templates: ReadonlyMap<string, Template>): string[] {
  return [...new Set(card.operations.flatMap((op) => signedStructs(templates.get(op.template) ?? { calls: [] })))];
}

/** The tokens whose amounts the card names, other than ETH. */
export function amountTokens(card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): Address[] {
  const tokens = new Set<Address>();
  for (const op of card.operations) {
    for (const field of templates.get(op.template)?.card.values() ?? []) {
      const token = field.kind === 'amount' ? amountToken(field.of, op.values, registry) : undefined;
      if (token !== undefined && token.address !== 'eth') tokens.add(token.address);
    }
  }
  return [...tokens];
}

function argNote(rule: Rule | undefined, value: AbiValue, values: Values, walk: Walk): ArgNote | undefined {
  if (value.kind !== 'uint') return undefined;
  if (rule?.kind === 'share-price') return { kind: 'share-price', bound: rule.bound };
  const name = rule?.kind === 'at-least' || rule?.kind === 'at-most' ? rule.field : rule?.kind === 'card' && rule.ref.attribute === undefined ? rule.ref.field : undefined;
  const field = name === undefined ? undefined : walk.templateOf.get(values)?.card.get(name);
  if (field?.kind === 'percent') return { kind: 'equals', text: percentText(value.value) };
  const token = field?.kind === 'amount' ? amountToken(field.of, values, walk.registry) : undefined;
  if (token === undefined) return undefined;
  const decimals = token.address === 'eth' ? 18 : walk.decimals.get(token.address);
  return decimals === undefined ? undefined : { kind: 'equals', text: `${wholeTokens(value.value, decimals)} ${token.name}` };
}

function addressesIn(value: AbiValue): Address[] {
  if (value.kind === 'address') return [value.value];
  if (value.kind === 'array') return value.items.flatMap(addressesIn);
  if (value.kind === 'tuple') return value.fields.flatMap(addressesIn);
  return [];
}

const regionOf = (value: AbiValue, root: Uint8Array): Region => ({ root, start: value.span[0], end: value.span[1] });

function callsIn(rule: Rule | undefined, value: AbiValue, values: Values, walk: Walk, itemValues?: readonly Values[]): CallData[] {
  // check.sh decodes only a call with a selector it knows, never parameters a router reads without one, so neither does this.
  if (rule?.kind === 'call' && value.kind === 'bytes') return rule.call.encoding === 'call' ? [callData(rule.call, regionOf(value, walk.root), values, walk)] : [];
  if (rule?.kind === 'items' && value.kind === 'array') return value.items.flatMap((item, i) => callsIn(rule.items[i], item, itemValues?.[i] ?? values, walk));
  if (rule?.kind === 'fields' && value.kind === 'tuple') return value.fields.flatMap((field, i) => callsIn(rule.fields[i], field, values, walk));
  return [];
}

function layoutsIn(rule: Rule | undefined, value: AbiValue, at: readonly number[], root: Uint8Array): Layout[] {
  if (rule?.kind === 'packed' && value.kind === 'bytes') return [{ at, kind: 'packed', types: rule.parts.map((part) => canonicalType(part.type)) }];
  if (rule?.kind === 'call' && rule.call.encoding === 'params' && value.kind === 'bytes') {
    const here: Layout = { at, kind: 'abi', types: rule.call.fn.params.map((param) => canonicalType(param.type)) };
    const decoded = decodeTemplateCall(rule.call, regionOf(value, root));
    if (decoded.kind !== 'decoded') return [here];
    return [here, ...decoded.args.flatMap((arg, i) => layoutsIn(rule.call.args[i], arg, [...at, i + 1], root))];
  }
  if (rule?.kind === 'items' && value.kind === 'array') return value.items.flatMap((item, i) => layoutsIn(rule.items[i], item, [...at, i + 1], root));
  if (rule?.kind === 'fields' && value.kind === 'tuple') return value.fields.flatMap((field, i) => layoutsIn(rule.fields[i], field, [...at, i + 1], root));
  return [];
}

function bundle(rule: Rule | undefined, value: AbiValue, values: Values, walk: Walk, itemValues?: readonly Values[]): BundleCall[] {
  if (value.kind !== 'array') return [];
  return value.items.map((item, i) => {
    const [to, data, amount] = item.kind === 'tuple' ? item.fields : [];
    if (to?.kind !== 'address' || data?.kind !== 'bytes' || amount?.kind !== 'uint') throw new Error('a Bundler3 call that is not (address,bytes,uint256,bool,bytes32)');
    const itemRule = rule?.kind === 'items' ? rule.items[i] : undefined;
    const dataRule = itemRule?.kind === 'fields' ? itemRule.fields[1] : undefined;
    const shown =
      data.value.length === 0
        ? ({ kind: 'empty' } as const)
        : dataRule?.kind === 'call' && dataRule.call.encoding === 'call'
          ? callData(dataRule.call, regionOf(data, walk.root), itemValues?.[i] ?? values, walk)
          : ({ kind: 'raw', hex: hex(data.value) } as const);
    return { to: labeled(to.value, walk), value: amount.value, data: shown };
  });
}

function callData(node: CallNode | 'empty' | undefined, region: Region, values: Values, walk: Walk, itemValues?: readonly Values[]): CallData {
  const bytes = region.root.subarray(region.start, region.end);
  if (bytes.length === 0) return { kind: 'empty' };
  if (node === undefined || node === 'empty') return { kind: 'raw', hex: hex(bytes) };
  const decoded = decodeTemplateCall(node, region);
  if (decoded.kind !== 'decoded') return { kind: 'raw', hex: hex(bytes) };
  const args = decoded.args.map((value, i) => ({ text: castValue(value), note: argNote(node.args[i], value, values, walk) }));
  const found = [...new Set(decoded.args.flatMap(addressesIn))].sort();
  let nested: Nested | undefined;
  if (node.fn.signature === BUNDLER3_MULTICALL) {
    nested = { kind: 'bundle', calls: bundle(node.args[0], decoded.args[0] as AbiValue, values, walk, itemValues) };
  } else {
    const calls = decoded.args.flatMap((value, i) => callsIn(node.args[i], value, values, walk, itemValues));
    nested = calls.length === 0 ? undefined : { kind: 'bytes', calls };
  }
  return {
    kind: 'decoded',
    signature: node.fn.signature,
    selector: node.fn.selector,
    args,
    trailer: decoded.trailer === undefined || node.trailer === undefined ? undefined : { hex: hex(decoded.trailer.value), allowance: node.trailer },
    addresses: found.map((address) => labeled(address, walk)),
    layouts: decoded.args.flatMap((value, i) => layoutsIn(node.args[i], value, [i + 1], region.root)),
    nested,
  };
}

function itemValuesOf(planned: ExpectedCall | undefined): readonly Values[] | undefined {
  return planned?.parts?.flatMap((part) => (part.args[0] ?? []).map(() => part.values));
}

/**
 * The calls `tx` makes, decoded with the card's templates as the fields check decodes them, numbered as check.sh numbers
 * them. Every value shown is read from `tx`; the card and templates choose only the function each call decodes as and
 * the token an amount counts. A call no template decodes is shown as raw data.
 */
export function callTree(tx: SafeTx, context: TreeContext): CallTree {
  const names = new Map<Address, Label>();
  for (const [name, address] of context.addressBook) names.set(address, { kind: 'address-book', name });
  for (const [name, entry] of context.registry.entries) names.set(entry.address, { kind: 'registry', name });
  const operations = context.card.operations.map((op) => ({ template: context.templates.get(op.template), values: op.values }));
  const complete = operations.every((op): op is { template: Template; values: Values } => op.template !== undefined);
  const plan = complete ? expectedCalls(operations) : [];
  const templateOf = new Map<Values, Template>(complete ? operations.map((op) => [op.values, op.template]) : []);
  const unwrapped = unwrapSafeTx(tx);
  const root = 'calls' in unwrapped ? (unwrapped.calls[0]?.data.root ?? new Uint8Array()) : new Uint8Array();
  const walk: Walk = { ...context, names, templateOf, root };
  const top = (data: CallData): SafeCall => ({ number: 1, to: labeled(tx.to, walk), value: tx.value, operation: tx.operation, data });
  const rawTop = (): CallData => (tx.data.length === 2 ? { kind: 'empty' } : { kind: 'raw', hex: tx.data });
  const tree = (call: SafeCall, count: number): CallTree => ({ nonce: tx.nonce, hashes: hashSafeTx(tx), top: call, count });
  if (unwrapped.kind === 'direct') {
    const [inner] = unwrapped.calls;
    const planned = plan[0];
    return tree(top(callData(planned?.call.data, inner.data, planned?.values ?? new Map(), walk, itemValuesOf(planned))), 1);
  }
  if (unwrapped.kind !== 'multisend') return tree(top(rawTop()), 1);
  const calls = unwrapped.calls.map((inner, i): SafeCall => {
    const planned = plan[i];
    return {
      number: i + 2,
      to: labeled(inner.to, walk),
      value: inner.value,
      operation: inner.operation,
      data: callData(planned?.call.data, inner.data, planned?.values ?? new Map(), walk, itemValuesOf(planned)),
    };
  });
  const { outer } = unwrapped;
  const packed = outer.args[0];
  const multiSend: Decoded = {
    kind: 'decoded',
    signature: outer.fn.signature,
    selector: outer.fn.selector,
    args: [{ text: packed === undefined ? '' : castValue(packed), note: undefined }],
    trailer: undefined,
    addresses: [],
    layouts: [],
    nested: { kind: 'multisend', calls },
  };
  return tree(top(multiSend), 1 + calls.length);
}
