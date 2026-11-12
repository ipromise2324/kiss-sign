import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AbiSignatureError, canonicalType, paramName, parseFunctionSignature, parseViewSignature } from '../decode/abi.ts';
import type { AbiFunction, AbiParam, AbiType } from '../decode/abi.ts';
import { ATTRIBUTES, CONTRACT_KINDS, MARKET_PARAMS, MARKET_PARTS, isAttribute, isEntryName } from '../registry.ts';
import type { Attribute, ContractKind, MarketPart, Registry, RegistryEntry } from '../registry.ts';
import { SafeTxParseError, parseAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';

/**
 * The registry entries a contract card field accepts: those of `registryKind`, and when `protocol` is set, only those
 * whose `defillama` slug it is.
 */
export type EntryScope = { readonly registryKind: ContractKind; readonly protocol: string | undefined };

/** Why `entry` cannot fill a contract card field of `scope`, or undefined when it can. */
export function contractRefusal(scope: EntryScope, entry: RegistryEntry): { readonly reason: 'wrong-contract-kind' | 'wrong-protocol'; readonly detail: string } | undefined {
  if (entry.kind !== scope.registryKind) return { reason: 'wrong-contract-kind', detail: `${entry.name} is a ${entry.kind}, not a ${scope.registryKind}` };
  if (scope.protocol !== undefined && entry.defillama !== scope.protocol) {
    return { reason: 'wrong-protocol', detail: `${entry.name} is a ${entry.kind} of ${entry.defillama ?? 'no DefiLlama protocol'}, not of ${scope.protocol}` };
  }
  return undefined;
}

export const inScope = (scope: EntryScope, entry: RegistryEntry): boolean => contractRefusal(scope, entry) === undefined;

/** Every registry entry a contract card field of `scope` accepts, in registry order. */
export const scopeEntries = (scope: EntryScope, registry: Registry): RegistryEntry[] => [...registry.entries.values()].filter((entry) => inScope(scope, entry));

/** What the signer fills in at each signing. */
export type CardField =
  | { readonly kind: 'contract'; readonly scope: EntryScope }
  /** A base-unit integer of the token `of` names. */
  | { readonly kind: 'amount'; readonly of: TokenRef }
  /** A registry name, an address-book name, or `safe`. */
  | { readonly kind: 'address' }
  /** Who receives a transfer: an address-book name or `safe`, never a registry contract. */
  | { readonly kind: 'recipient' }
  /** A Safe nonce. */
  | { readonly kind: 'nonce' }
  /** A Morpho Blue market from `registry/markets.json`. */
  | { readonly kind: 'market' };

/**
 * `vault`, `vault.asset` or `market.loanToken`: a card field, an attribute of the registry entry that field names, or a
 * part of the market it names.
 */
export type CardRef = { readonly field: string; readonly attribute: Attribute | MarketPart | undefined };

/** Native ETH, which no contract holds, or a token a card field names. */
export type TokenRef = 'eth' | CardRef;

export type ConstValue =
  | { readonly kind: 'uint' | 'int'; readonly value: bigint }
  | { readonly kind: 'address'; readonly value: Address }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'fixed-bytes' | 'bytes' | 'string'; readonly value: Hex };

/**
 * Why a free field is safe at any value. `scalar`: a number, bool or fixed-size bytes, which the reason explains.
 * `proof`: the contract reverts unless it verifies the value against what it already holds, such as a Merkle root or
 * attesters' signatures. `unread`: the contract never reads the value. Only `proof` and `unread` may free bytes, a string
 * or an array, and nothing may free an address or a tuple.
 */
export type FreeClaim = 'scalar' | 'proof' | 'unread';

export type Rule =
  | { readonly kind: 'card'; readonly ref: CardRef }
  | { readonly kind: 'safe' }
  | { readonly kind: 'contract'; readonly name: string }
  | { readonly kind: 'const'; readonly value: ConstValue }
  | { readonly kind: 'free'; readonly reason: string; readonly claim: FreeClaim }
  /** The same number as the transaction holds at an earlier template path, such as an approval its transfer spends. */
  | { readonly kind: 'equals'; readonly path: string; readonly rule: LeafRule }
  /**
   * An ERC-4626 price bound in assets per share, scaled by 1e27, as Morpho's adapters take it. `max` must be at most, and
   * `min` at least, `assets` × 1e27 / `shares`, so the transaction's bound is at least as strict as the card's amounts.
   */
  | { readonly kind: 'share-price'; readonly bound: 'max' | 'min'; readonly assets: Quantity; readonly shares: Quantity }
  | { readonly kind: 'call'; readonly call: CallNode }
  /** An array of exactly this many items. */
  | { readonly kind: 'items'; readonly items: readonly Rule[] }
  /** A tuple's components, by position. */
  | { readonly kind: 'fields'; readonly fields: readonly Rule[] };

export type Quantity = { readonly kind: 'card'; readonly field: string } | { readonly kind: 'path'; readonly path: string; readonly rule: LeafRule };

export type LeafRule = Exclude<Rule, { readonly kind: 'call' | 'items' | 'fields' }>;

/** Bytes a contract ignores after a call's arguments, which the template lets through up to `maxBytes`. */
export type TrailerAllowance = { readonly maxBytes: number; readonly why: string };

export type CallNode = {
  readonly fn: AbiFunction;
  /** One rule per parameter, by position. */
  readonly args: readonly Rule[];
  readonly trailer: TrailerAllowance | undefined;
};

/**
 * A call the Safe makes: a function call, or `empty` data, as a plain ETH transfer or a cancellation sends. `merge`,
 * with its reason, lets several operations share this call: see `checkTemplateFields`.
 */
export type TemplateCall = { readonly to: Rule; readonly value: Rule; readonly data: CallNode | 'empty'; readonly merge: string | undefined };

/** `all`, only on what the Safe gives, means its whole balance: the Safe holds none of the token afterwards. */
export type EffectAmount = { readonly kind: 'card'; readonly field: string } | { readonly kind: 'positive' } | { readonly kind: 'all' };
/** `to`, on what the Safe gives, names the receiver; the Safe giving to itself changes nothing. */
export type Effect = { readonly token: TokenRef; readonly amount: EffectAmount; readonly to: CardRef | undefined };

export const VIEW_CHANGES = ['increases', 'decreases', 'same'] as const;
export type ViewChange = (typeof VIEW_CHANGES)[number];

/**
 * A view function on a registry contract, called just before and just after the transaction with every argument
 * bound. Each return value `changes` names must change that way; the others are not judged.
 */
export type ViewEffect = {
  readonly to: string;
  readonly fn: AbiFunction;
  readonly args: readonly Rule[];
  readonly returns: readonly AbiParam[];
  /** By the return value's position, which `returns` names. */
  readonly changes: readonly { readonly value: number; readonly change: ViewChange }[];
};

export type Template = {
  readonly id: string;
  readonly card: ReadonlyMap<string, CardField>;
  /** The Safe transaction's own nonce. */
  readonly nonce: Rule | undefined;
  /** Card references that must all name the same address, such as two vaults' assets; a card where they differ is refused. */
  readonly same: readonly CardRef[];
  readonly calls: readonly TemplateCall[];
  readonly effects: { readonly gives: readonly Effect[]; readonly gets: readonly Effect[]; readonly views: readonly ViewEffect[] };
};

export const TEMPLATES_DIR = 'templates';
const ID = /^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/;
const ADDRESS_BYTES = 20;
const MAX_TRAILER = ADDRESS_BYTES - 1;

export class TemplateError extends Error {
  override name = 'TemplateError';
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.path = path;
  }
}

type Json = Record<string, unknown>;

function object(path: string, raw: unknown): Json {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TemplateError(path, 'not a JSON object');
  return raw as Json;
}

function array(path: string, raw: unknown): unknown[] {
  if (!Array.isArray(raw)) throw new TemplateError(path, 'not a JSON array');
  return raw;
}

function text(path: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new TemplateError(path, 'not a non-empty string');
  return raw;
}

function exactKeys(path: string, value: Json, required: readonly string[], optional: readonly string[] = []): void {
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new TemplateError(`${path}.${missing}`, 'missing');
  const extra = Object.keys(value).find((key) => !required.includes(key) && !optional.includes(key));
  if (extra !== undefined) throw new TemplateError(`${path}.${extra}`, 'unexpected field');
}

type Scope = { readonly card: CardFields; readonly registry: Registry; readonly uintLeaves: Map<string, LeafRule> };

type CardFields = ReadonlyMap<string, CardField>;

function cardRef(path: string, raw: string, card: CardFields): CardRef {
  const [field, attribute, extra] = raw.split('.');
  const target = field === undefined ? undefined : card.get(field);
  if (field === undefined || target === undefined || extra !== undefined) throw new TemplateError(path, `${JSON.stringify(raw)} is not a card field`);
  if (attribute === undefined) return { field, attribute: undefined };
  if (target.kind === 'market') {
    const part = MARKET_PARTS.find((p) => p === attribute);
    if (part === undefined) throw new TemplateError(path, `${JSON.stringify(attribute)} is not one of ${MARKET_PARTS.join(', ')}`);
    return { field, attribute: part };
  }
  if (!isAttribute(attribute)) throw new TemplateError(path, `${JSON.stringify(attribute)} is not a registry attribute`);
  if (target.kind !== 'contract' || !(ATTRIBUTES[attribute].of as readonly ContractKind[]).includes(target.scope.registryKind)) {
    throw new TemplateError(path, `card field ${field} has no ${attribute}`);
  }
  return { field, attribute };
}

/** What a card reference resolves to: an address, a number, a market's bytes32 id, or a whole market. */
type RefType = 'address' | 'uint' | 'bytes32' | 'market';

function refType(ref: CardRef, card: CardFields): RefType {
  const kind = card.get(ref.field)?.kind;
  if (kind === 'market') return ref.attribute === undefined ? 'market' : ref.attribute === 'lltv' ? 'uint' : ref.attribute === 'id' ? 'bytes32' : 'address';
  return ref.attribute === undefined && (kind === 'amount' || kind === 'nonce') ? 'uint' : 'address';
}

const binds = (ref: Exclude<RefType, 'market'>, type: AbiType): boolean =>
  ref === 'bytes32' ? type.kind === 'fixed-bytes' && type.size === 32 : type.kind === ref;

/** Morpho Blue's `MarketParams`, which a whole card market binds part by part. */
const isMarketParams = (type: AbiType): boolean => canonicalType(type) === '(address,address,address,address,uint256)';

function cardToken(path: string, raw: string, card: CardFields): CardRef {
  const ref = cardRef(path, raw, card);
  if (refType(ref, card) !== 'address') throw new TemplateError(path, 'must name a token');
  return ref;
}

function constValue(path: string, raw: unknown, type: AbiType): ConstValue {
  const value = text(path, raw);
  const bad = (): never => {
    throw new TemplateError(path, `${JSON.stringify(value.slice(0, 80))} is not a ${canonicalType(type)}`);
  };
  switch (type.kind) {
    case 'uint':
    case 'int': {
      if (!/^-?(0|[1-9][0-9]{0,77})$/.test(value)) return bad();
      const n = BigInt(value);
      const fits = type.kind === 'uint' ? BigInt.asUintN(type.bits, n) === n : BigInt.asIntN(type.bits, n) === n;
      return fits ? { kind: type.kind, value: n } : bad();
    }
    case 'bool':
      return value === 'true' || value === 'false' ? { kind: 'bool', value: value === 'true' } : bad();
    case 'address':
      try {
        return { kind: 'address', value: parseAddress(path, value) };
      } catch (error) {
        if (error instanceof SafeTxParseError) return bad();
        throw error;
      }
    case 'fixed-bytes':
      return new RegExp(`^0x[0-9a-fA-F]{${type.size * 2}}$`).test(value) ? { kind: 'fixed-bytes', value: value.toLowerCase() as Hex } : bad();
    case 'bytes':
      return /^0x([0-9a-fA-F]{2})*$/.test(value) ? { kind: 'bytes', value: value.toLowerCase() as Hex } : bad();
    case 'string':
      return { kind: 'string', value: `0x${Buffer.from(value, 'utf8').toString('hex')}` as Hex };
    default:
      return bad();
  }
}

const contains = (type: AbiType, kind: AbiType['kind']): boolean =>
  type.kind === kind ||
  ((type.kind === 'array' || type.kind === 'fixed-array') && contains(type.item, kind)) ||
  (type.kind === 'tuple' && type.components.some((param) => contains(param.type, kind)));

function free(path: string, raw: unknown, type: AbiType): Rule {
  if (contains(type, 'address')) throw new TemplateError(path, 'an address is never free; bind it to the Safe, a card value or a registry contract');
  if (contains(type, 'tuple')) throw new TemplateError(path, 'a tuple is never free as a whole; bind its fields');
  if (typeof raw === 'string') {
    if (!['uint', 'int', 'bool', 'fixed-bytes'].includes(type.kind)) {
      throw new TemplateError(path, `a free ${canonicalType(type)} needs {"proof": why} or {"unread": why}`);
    }
    return { kind: 'free', reason: text(path, raw), claim: 'scalar' };
  }
  const value = object(path, raw);
  const [claim, ...extra] = Object.keys(value);
  if ((claim !== 'proof' && claim !== 'unread') || extra.length > 0) throw new TemplateError(path, 'must be a reason, or exactly one of proof, unread');
  return { kind: 'free', reason: text(`${path}.${claim}`, value[claim]), claim };
}

function quantity(path: string, raw: unknown, scope: Scope): Quantity {
  const name = text(path, raw);
  const field = cardFieldName(name);
  if (field !== undefined) {
    if (scope.card.get(field)?.kind !== 'amount') throw new TemplateError(path, `${JSON.stringify(name)} is not a card amount`);
    return { kind: 'card', field };
  }
  const rule = scope.uintLeaves.get(name);
  if (rule === undefined) throw new TemplateError(path, `${JSON.stringify(name)} is neither card.<amount> nor the path of an earlier uint argument`);
  return { kind: 'path', path: name, rule };
}

function sharePrice(path: string, raw: unknown, type: AbiType, scope: Scope, bound: 'max' | 'min'): Rule {
  if (type.kind !== 'uint') throw new TemplateError(path, `a share price bound cannot bind a ${canonicalType(type)}`);
  const value = object(path, raw);
  exactKeys(path, value, ['assets', 'shares']);
  return { kind: 'share-price', bound, assets: quantity(`${path}.assets`, value.assets, scope), shares: quantity(`${path}.shares`, value.shares, scope) };
}

function rule(path: string, raw: unknown, type: AbiType, scope: Scope): Rule {
  const parsed = parseRule(path, raw, type, scope);
  if (type.kind === 'uint' && parsed.kind !== 'call' && parsed.kind !== 'items' && parsed.kind !== 'fields') scope.uintLeaves.set(path, parsed);
  return parsed;
}

function parseRule(path: string, raw: unknown, type: AbiType, scope: Scope): Rule {
  const value = object(path, raw);
  const keys = Object.keys(value);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined) throw new TemplateError(path, 'a rule has exactly one of card, safe, contract, const, free, equals, maxSharePrice, minSharePrice, call, items, fields');
  const body = value[key];
  const at = `${path}.${key}`;
  const cannotBind = () => new TemplateError(path, `a ${key} rule cannot bind a ${canonicalType(type)}`);
  const needs = (kinds: readonly AbiType['kind'][]) => {
    if (!kinds.includes(type.kind)) throw cannotBind();
  };
  switch (key) {
    case 'card': {
      const ref = cardRef(at, text(at, body), scope.card);
      const resolves = refType(ref, scope.card);
      if (resolves === 'market') {
        if (!isMarketParams(type)) throw new TemplateError(path, `a whole market binds only a (address,address,address,address,uint256) tuple, not a ${canonicalType(type)}`);
        return { kind: 'fields', fields: MARKET_PARAMS.map((part): Rule => ({ kind: 'card', ref: { field: ref.field, attribute: part } })) };
      }
      if (!binds(resolves, type)) throw cannotBind();
      return { kind: 'card', ref };
    }
    case 'safe':
      if (body !== true) throw new TemplateError(at, 'must be true');
      needs(['address']);
      return { kind: 'safe' };
    case 'contract': {
      const name = text(at, body);
      if (!scope.registry.entries.has(name)) throw new TemplateError(at, `${JSON.stringify(name)} is not in the contract registry`);
      needs(['address']);
      return { kind: 'contract', name };
    }
    case 'const': {
      const constant = constValue(at, body, type);
      if (constant.kind === 'address' && BigInt(constant.value) !== 0n) {
        throw new TemplateError(at, 'a constant address must be the zero address; bind any other with contract, from the registry');
      }
      if ((constant.kind === 'bytes' || constant.kind === 'string') && constant.value.length > 2) throw new TemplateError(at, `a constant ${constant.kind} must be empty`);
      return { kind: 'const', value: constant };
    }
    case 'free':
      return free(at, body, type);
    case 'equals': {
      const quantityAt = quantity(at, body, scope);
      if (quantityAt.kind !== 'path' || type.kind !== 'uint') throw new TemplateError(at, 'must name the path of an earlier uint argument, on a uint');
      return { kind: 'equals', path: quantityAt.path, rule: quantityAt.rule };
    }
    case 'maxSharePrice':
      return sharePrice(at, body, type, scope, 'max');
    case 'minSharePrice':
      return sharePrice(at, body, type, scope, 'min');
    case 'call':
      needs(['bytes']);
      return { kind: 'call', call: callNode(at, body, scope) };
    case 'items': {
      if (type.kind !== 'array' && type.kind !== 'fixed-array') throw cannotBind();
      const items = array(at, body);
      if (type.kind === 'fixed-array' && items.length !== type.length) throw new TemplateError(at, `${canonicalType(type)} needs ${type.length} items`);
      return { kind: 'items', items: items.map((item, i) => rule(`${at}[${i}]`, item, type.item, scope)) };
    }
    case 'fields': {
      if (type.kind !== 'tuple') throw cannotBind();
      return { kind: 'fields', fields: params(at, body, type.components, scope) };
    }
    default:
      throw new TemplateError(at, 'not a rule');
  }
}

/** Rules keyed by parameter name (its index when unnamed), or a list by position. Every parameter needs one. */
function params(path: string, raw: unknown, list: readonly AbiParam[], scope: Scope): Rule[] {
  if (Array.isArray(raw)) {
    if (raw.length !== list.length) throw new TemplateError(path, `${list.length} rules needed, ${raw.length} given`);
    return list.map((param, i) => rule(`${path}[${i}]`, raw[i], param.type, scope));
  }
  const value = object(path, raw);
  exactKeys(path, value, list.map(paramName));
  return list.map((param, i) => rule(`${path}.${paramName(param, i)}`, value[paramName(param, i)], param.type, scope));
}

function signature(path: string, raw: unknown): AbiFunction {
  try {
    return parseFunctionSignature(text(path, raw));
  } catch (error) {
    if (error instanceof AbiSignatureError) throw new TemplateError(path, error.message);
    throw error;
  }
}

function trailer(path: string, raw: unknown): TrailerAllowance | undefined {
  if (raw === undefined) return undefined;
  const value = object(path, raw);
  exactKeys(path, value, ['maxBytes', 'why']);
  const maxBytes = value.maxBytes;
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TRAILER) {
    throw new TemplateError(`${path}.maxBytes`, `an integer from 1 to ${MAX_TRAILER}`);
  }
  return { maxBytes, why: text(`${path}.why`, value.why) };
}

function callNode(path: string, raw: unknown, scope: Scope): CallNode {
  const value = object(path, raw);
  exactKeys(path, value, ['function', 'args'], ['trailer']);
  const fn = signature(`${path}.function`, value.function);
  return { fn, args: params(`${path}.args`, value.args, fn.params, scope), trailer: trailer(`${path}.trailer`, value.trailer) };
}

/**
 * A merged call must be the template's last, to a named contract, with a constant value and every argument an array
 * bound by items, each with the same number of items: the operations sharing it put their items in, item by item across
 * the arrays, as the Merkl distributor takes parallel `users`, `tokens`, `amounts` and `proofs`. Only those items can
 * differ between them.
 */
function mergeReason(path: string, raw: unknown, call: TemplateCall, last: boolean): string | undefined {
  if (raw === undefined) return undefined;
  const why = text(path, raw);
  const data = call.data === 'empty' ? undefined : call.data;
  if (!last) throw new TemplateError(path, 'only the last call may merge');
  if (call.to.kind !== 'contract' || call.value.kind !== 'const') throw new TemplateError(path, 'a merged call needs a contract target and a constant value');
  const counts = new Set(data?.args.map((arg) => (arg.kind === 'items' ? arg.items.length : -1)));
  if (data === undefined || data.args.length === 0 || counts.has(-1) || counts.size !== 1) {
    throw new TemplateError(path, 'every argument of a merged call is bound by items, with as many items in each');
  }
  return why;
}

function templateCall(path: string, raw: unknown, scope: Scope, last: boolean): TemplateCall {
  const { merge, ...value } = object(path, raw);
  const { to, value: amount, ...call } = value;
  let data: TemplateCall['data'];
  if (Object.hasOwn(call, 'data')) {
    exactKeys(path, value, ['to', 'value', 'data']);
    if (call.data !== 'empty') throw new TemplateError(`${path}.data`, 'must be "empty"; a call with data names its function and args');
    data = 'empty';
  } else {
    exactKeys(path, value, ['to', 'value', 'function', 'args'], ['trailer']);
    data = callNode(path, call, scope);
  }
  const parsed = {
    to: rule(`${path}.to`, to, { kind: 'address' }, scope),
    value: rule(`${path}.value`, amount, { kind: 'uint', bits: 256 }, scope),
    data,
  };
  return { ...parsed, merge: mergeReason(`${path}.merge`, merge, { ...parsed, merge: undefined }, last) };
}

/** A field's parser waits for the full field list, since `amount.of` may name a field declared after it. */
function cardField(path: string, raw: unknown, registry: Registry): (fields: CardFields) => CardField {
  const value = object(path, raw);
  switch (value.kind) {
    case 'contract': {
      exactKeys(path, value, ['kind', 'registryKind'], ['defillama']);
      const registryKind = CONTRACT_KINDS.find((k) => k === value.registryKind);
      if (registryKind === undefined) throw new TemplateError(`${path}.registryKind`, `not one of ${CONTRACT_KINDS.join(', ')}`);
      const scope = { registryKind, protocol: value.defillama === undefined ? undefined : text(`${path}.defillama`, value.defillama) };
      if (scope.protocol !== undefined && scopeEntries(scope, registry).length === 0) {
        throw new TemplateError(`${path}.defillama`, `no registry ${registryKind} carries the DefiLlama slug ${JSON.stringify(scope.protocol.slice(0, 80))}`);
      }
      return () => ({ kind: 'contract', scope });
    }
    case 'amount': {
      exactKeys(path, value, ['kind', 'of']);
      const of = text(`${path}.of`, value.of);
      return (fields) => ({ kind: 'amount', of: of === 'eth' ? 'eth' : cardToken(`${path}.of`, of, fields) });
    }
    case 'address':
      exactKeys(path, value, ['kind']);
      return () => ({ kind: 'address' });
    case 'recipient':
      exactKeys(path, value, ['kind']);
      return () => ({ kind: 'recipient' });
    case 'nonce':
      exactKeys(path, value, ['kind']);
      return () => ({ kind: 'nonce' });
    case 'market':
      exactKeys(path, value, ['kind']);
      return () => ({ kind: 'market' });
    default:
      throw new TemplateError(`${path}.kind`, 'not one of contract, amount, address, recipient, nonce, market');
  }
}

/** `card.<field>` with the prefix removed, or undefined when `raw` lacks it. */
const cardFieldName = (raw: string): string | undefined => (raw.startsWith('card.') ? raw.slice(5) : undefined);

function effect(path: string, raw: unknown, scope: Scope, side: 'gives' | 'gets'): Effect {
  const value = object(path, raw);
  exactKeys(path, value, ['token', 'amount'], side === 'gives' ? ['to'] : []);
  const token = text(`${path}.token`, value.token);
  const field = cardFieldName(token);
  if (token !== 'eth' && field === undefined) throw new TemplateError(`${path}.token`, 'must be eth or card.<field>');
  const ref = field === undefined ? 'eth' : cardToken(`${path}.token`, field, scope.card);
  let to: CardRef | undefined;
  if (value.to !== undefined) {
    const name = cardFieldName(text(`${path}.to`, value.to)) ?? '';
    if (!['address', 'recipient'].includes(scope.card.get(name)?.kind ?? '')) throw new TemplateError(`${path}.to`, 'must be card.<address field>');
    to = { field: name, attribute: undefined };
  }
  const amount = text(`${path}.amount`, value.amount);
  if (amount === 'positive') return { token: ref, amount: { kind: 'positive' }, to };
  if (amount === 'all' && side === 'gives') return { token: ref, amount: { kind: 'all' }, to };
  const amountField = cardFieldName(amount) ?? '';
  if (scope.card.get(amountField)?.kind !== 'amount') {
    throw new TemplateError(`${path}.amount`, side === 'gives' ? 'must be "positive", "all" or card.<amount field>' : 'must be "positive" or card.<amount field>');
  }
  return { token: ref, amount: { kind: 'card', field: amountField }, to };
}

/** A view's arguments are known before the transaction runs: bound by card, safe, contract or const, never free. */
function boundArgument(path: string, rule: Rule): void {
  if (rule.kind === 'fields') rule.fields.forEach((field, i) => boundArgument(`${path}[${i}]`, field));
  else if (rule.kind === 'items') rule.items.forEach((item, i) => boundArgument(`${path}[${i}]`, item));
  else if (!['card', 'safe', 'contract', 'const'].includes(rule.kind)) throw new TemplateError(path, `a view's argument is bound by card, safe, contract or const, not ${rule.kind}`);
}

function view(path: string, raw: unknown, scope: Scope): ViewEffect {
  const value = object(path, raw);
  exactKeys(path, value, ['to', 'function', 'args', 'change']);
  const to = rule(`${path}.to`, value.to, { kind: 'address' }, scope);
  if (to.kind !== 'contract') throw new TemplateError(`${path}.to`, 'must name a registry contract');
  let parsed: ReturnType<typeof parseViewSignature>;
  try {
    parsed = parseViewSignature(text(`${path}.function`, value.function));
  } catch (error) {
    if (error instanceof AbiSignatureError) throw new TemplateError(`${path}.function`, error.message);
    throw error;
  }
  const { fn, returns } = parsed;
  const args = params(`${path}.args`, value.args, fn.params, scope);
  args.forEach((arg, i) => boundArgument(`${path}.args.${paramName(fn.params[i] as AbiParam, i)}`, arg));
  const changes = Object.entries(object(`${path}.change`, value.change)).map(([name, change]) => {
    const at = `${path}.change.${name}`;
    const index = returns.findIndex((param) => param.name === name);
    const type = returns[index]?.type;
    if (type === undefined) throw new TemplateError(at, `not a named return value of ${fn.name}`);
    if (type.kind !== 'uint' && type.kind !== 'int') throw new TemplateError(at, `${canonicalType(type)} is not a number; only a number is judged`);
    const known = VIEW_CHANGES.find((c) => c === change);
    if (known === undefined) throw new TemplateError(at, `not one of ${VIEW_CHANGES.join(', ')}`);
    return { value: index, change: known };
  });
  if (changes.length === 0) throw new TemplateError(`${path}.change`, 'names no return value');
  return { to: to.name, fn, args, returns, changes };
}

export function parseTemplate(raw: unknown, registry: Registry): Template {
  const value = object('template', raw);
  exactKeys('template', value, ['id', 'card', 'calls', 'effects'], ['nonce', 'same']);
  const id = text('id', value.id);
  if (!ID.test(id)) throw new TemplateError('id', 'not <protocol>/<operation>');
  const pending = Object.entries(object('card', value.card)).map(([name, field]) => {
    if (!isEntryName(name) || name.includes('.')) throw new TemplateError(`card.${name}`, 'not a card field name');
    return [name, cardField(`card.${name}`, field, registry)] as const;
  });
  const fields = new Map<string, CardField>(pending.map(([name]) => [name, { kind: 'address' }]));
  for (const [name, build] of pending) fields.set(name, build(fields));
  const scope: Scope = { card: fields, registry, uintLeaves: new Map() };
  const nonce = value.nonce === undefined ? undefined : rule('nonce', value.nonce, { kind: 'uint', bits: 256 }, scope);
  const same = value.same === undefined ? [] : array('same', value.same).map((ref, i) => cardToken(`same[${i}]`, text(`same[${i}]`, ref), fields));
  if (value.same !== undefined && same.length < 2) throw new TemplateError('same', 'names fewer than two card references');
  const rawCalls = array('calls', value.calls);
  const calls = rawCalls.map((call, i) => templateCall(`calls[${i}]`, call, scope, i === rawCalls.length - 1));
  if (calls.length === 0) throw new TemplateError('calls', 'empty');
  const effects = object('effects', value.effects);
  exactKeys('effects', effects, ['gives', 'gets'], ['views']);
  return {
    id,
    card: fields,
    nonce,
    same,
    calls,
    effects: {
      gives: array('effects.gives', effects.gives).map((e, i) => effect(`effects.gives[${i}]`, e, scope, 'gives')),
      gets: array('effects.gets', effects.gets).map((e, i) => effect(`effects.gets[${i}]`, e, scope, 'gets')),
      views: effects.views === undefined ? [] : array('effects.views', effects.views).map((v, i) => view(`effects.views[${i}]`, v, scope)),
    },
  };
}

/** Every card reference the template makes. */
export function cardRefs(template: Template): CardRef[] {
  const refs: CardRef[] = [...template.same];
  const visit = (rule: Rule | undefined): void => {
    if (rule?.kind === 'card') refs.push(rule.ref);
    else if (rule?.kind === 'share-price') {
      for (const q of [rule.assets, rule.shares]) if (q.kind === 'card') refs.push({ field: q.field, attribute: undefined });
    }
    else if (rule?.kind === 'call') rule.call.args.forEach(visit);
    else if (rule?.kind === 'items') rule.items.forEach(visit);
    else if (rule?.kind === 'fields') rule.fields.forEach(visit);
  };
  visit(template.nonce);
  for (const call of template.calls) {
    visit(call.to);
    visit(call.value);
    if (call.data !== 'empty') call.data.args.forEach(visit);
  }
  for (const { args } of template.effects.views) args.forEach(visit);
  for (const field of template.card.values()) if (field.kind === 'amount' && field.of !== 'eth') refs.push(field.of);
  for (const { token, to } of [...template.effects.gives, ...template.effects.gets]) {
    if (token !== 'eth') refs.push(token);
    if (to !== undefined) refs.push(to);
  }
  return refs;
}

/** Reads `templates/<id>/template.json` and requires its `id` to be the folder it sits in. */
export function loadTemplate(repoRoot: string, id: string, registry: Registry): Template {
  if (!ID.test(id)) throw new TemplateError('id', `${JSON.stringify(id.slice(0, 80))} is not <protocol>/<operation>`);
  const template = parseTemplate(JSON.parse(readFileSync(join(repoRoot, TEMPLATES_DIR, id, 'template.json'), 'utf8')), registry);
  if (template.id !== id) throw new TemplateError('id', `${JSON.stringify(template.id)} sits in templates/${id}`);
  return template;
}
