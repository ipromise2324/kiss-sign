import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AbiSignatureError, canonicalType, paramName, parseFunctionSignature } from '../decode/abi.ts';
import type { AbiFunction, AbiParam, AbiType } from '../decode/abi.ts';
import { ATTRIBUTES, CONTRACT_KINDS, isAttribute, isEntryName } from '../registry.ts';
import type { Attribute, ContractKind, Registry } from '../registry.ts';
import { SafeTxParseError, parseAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';

/** What the signer fills in at each signing. */
export type CardField =
  | { readonly kind: 'contract'; readonly registryKind: ContractKind }
  /** A base-unit integer of the token `of` names. */
  | { readonly kind: 'amount'; readonly of: TokenRef }
  /** A registry name, an address-book name, or `safe`. */
  | { readonly kind: 'address' }
  /** Who receives a transfer: an address-book name or `safe`, never a registry contract. */
  | { readonly kind: 'recipient' }
  /** A Safe nonce. */
  | { readonly kind: 'nonce' };

/** `vault` or `vault.asset`: a card field, or an attribute of the registry entry that field names. */
export type CardRef = { readonly field: string; readonly attribute: Attribute | undefined };

/** Native ETH, which no contract holds, or a token a card field names. */
export type TokenRef = 'eth' | CardRef;

export type ConstValue =
  | { readonly kind: 'uint' | 'int'; readonly value: bigint }
  | { readonly kind: 'address'; readonly value: Address }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'fixed-bytes' | 'bytes' | 'string'; readonly value: Hex };

export type Rule =
  | { readonly kind: 'card'; readonly ref: CardRef }
  | { readonly kind: 'safe' }
  | { readonly kind: 'contract'; readonly name: string }
  | { readonly kind: 'const'; readonly value: ConstValue }
  | { readonly kind: 'free'; readonly reason: string }
  | { readonly kind: 'call'; readonly call: CallNode }
  /** An array of exactly this many items. */
  | { readonly kind: 'items'; readonly items: readonly Rule[] }
  /** A tuple's components, by position. */
  | { readonly kind: 'fields'; readonly fields: readonly Rule[] };

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

export type Template = {
  readonly id: string;
  readonly card: ReadonlyMap<string, CardField>;
  /** The Safe transaction's own nonce. */
  readonly nonce: Rule | undefined;
  readonly calls: readonly TemplateCall[];
  readonly effects: { readonly gives: readonly Effect[]; readonly gets: readonly Effect[] };
};

export const TEMPLATES_DIR = 'templates';
const ID = /^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_TRAILER = 32;

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

type Scope = { readonly card: CardFields; readonly registry: Registry };

type CardFields = ReadonlyMap<string, CardField>;

function cardRef(path: string, raw: string, card: CardFields): CardRef {
  const [field, attribute, extra] = raw.split('.');
  const target = field === undefined ? undefined : card.get(field);
  if (field === undefined || target === undefined || extra !== undefined) throw new TemplateError(path, `${JSON.stringify(raw)} is not a card field`);
  if (attribute === undefined) return { field, attribute: undefined };
  if (!isAttribute(attribute)) throw new TemplateError(path, `${JSON.stringify(attribute)} is not a registry attribute`);
  if (target.kind !== 'contract' || !(ATTRIBUTES[attribute].of as readonly ContractKind[]).includes(target.registryKind)) {
    throw new TemplateError(path, `card field ${field} has no ${attribute}`);
  }
  return { field, attribute };
}

/** The ABI type a card reference resolves to. */
function refType(ref: CardRef, card: CardFields): 'address' | 'uint' {
  const kind = card.get(ref.field)?.kind;
  return ref.attribute === undefined && (kind === 'amount' || kind === 'nonce') ? 'uint' : 'address';
}

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

function rule(path: string, raw: unknown, type: AbiType, scope: Scope): Rule {
  const value = object(path, raw);
  const keys = Object.keys(value);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined) throw new TemplateError(path, 'a rule has exactly one of card, safe, contract, const, free, call, items, fields');
  const body = value[key];
  const at = `${path}.${key}`;
  const cannotBind = () => new TemplateError(path, `a ${key} rule cannot bind a ${canonicalType(type)}`);
  const needs = (kinds: readonly AbiType['kind'][]) => {
    if (!kinds.includes(type.kind)) throw cannotBind();
  };
  switch (key) {
    case 'card': {
      const ref = cardRef(at, text(at, body), scope.card);
      needs([refType(ref, scope.card)]);
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
    case 'const':
      return { kind: 'const', value: constValue(at, body, type) };
    case 'free':
      return { kind: 'free', reason: text(at, body) };
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
 * A merged call must be the template's last, to a named contract, with a constant value and one array argument whose
 * items the operations sharing it put in, so only that argument can differ between them.
 */
function mergeReason(path: string, raw: unknown, call: TemplateCall, last: boolean): string | undefined {
  if (raw === undefined) return undefined;
  const why = text(path, raw);
  const data = call.data === 'empty' ? undefined : call.data;
  if (!last) throw new TemplateError(path, 'only the last call may merge');
  if (call.to.kind !== 'contract' || call.value.kind !== 'const') throw new TemplateError(path, 'a merged call needs a contract target and a constant value');
  if (data === undefined || data.args.length !== 1 || data.args[0]?.kind !== 'items') throw new TemplateError(path, 'a merged call takes one argument bound by items');
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
function cardField(path: string, raw: unknown): (fields: CardFields) => CardField {
  const value = object(path, raw);
  switch (value.kind) {
    case 'contract': {
      exactKeys(path, value, ['kind', 'registryKind']);
      const registryKind = CONTRACT_KINDS.find((k) => k === value.registryKind);
      if (registryKind === undefined) throw new TemplateError(`${path}.registryKind`, `not one of ${CONTRACT_KINDS.join(', ')}`);
      return () => ({ kind: 'contract', registryKind });
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
    default:
      throw new TemplateError(`${path}.kind`, 'not one of contract, amount, address, nonce');
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

export function parseTemplate(raw: unknown, registry: Registry): Template {
  const value = object('template', raw);
  exactKeys('template', value, ['id', 'card', 'calls', 'effects'], ['nonce']);
  const id = text('id', value.id);
  if (!ID.test(id)) throw new TemplateError('id', 'not <protocol>/<operation>');
  const pending = Object.entries(object('card', value.card)).map(([name, field]) => {
    if (!isEntryName(name) || name.includes('.')) throw new TemplateError(`card.${name}`, 'not a card field name');
    return [name, cardField(`card.${name}`, field)] as const;
  });
  const fields = new Map<string, CardField>(pending.map(([name]) => [name, { kind: 'address' }]));
  for (const [name, build] of pending) fields.set(name, build(fields));
  const scope: Scope = { card: fields, registry };
  const nonce = value.nonce === undefined ? undefined : rule('nonce', value.nonce, { kind: 'uint', bits: 256 }, scope);
  const rawCalls = array('calls', value.calls);
  const calls = rawCalls.map((call, i) => templateCall(`calls[${i}]`, call, scope, i === rawCalls.length - 1));
  if (calls.length === 0) throw new TemplateError('calls', 'empty');
  const effects = object('effects', value.effects);
  exactKeys('effects', effects, ['gives', 'gets']);
  return {
    id,
    card: fields,
    nonce,
    calls,
    effects: {
      gives: array('effects.gives', effects.gives).map((e, i) => effect(`effects.gives[${i}]`, e, scope, 'gives')),
      gets: array('effects.gets', effects.gets).map((e, i) => effect(`effects.gets[${i}]`, e, scope, 'gets')),
    },
  };
}

/** Reads `templates/<id>/template.json` and requires its `id` to be the folder it sits in. */
export function loadTemplate(repoRoot: string, id: string, registry: Registry): Template {
  if (!ID.test(id)) throw new TemplateError('id', `${JSON.stringify(id.slice(0, 80))} is not <protocol>/<operation>`);
  const template = parseTemplate(JSON.parse(readFileSync(join(repoRoot, TEMPLATES_DIR, id, 'template.json'), 'utf8')), registry);
  if (template.id !== id) throw new TemplateError('id', `${JSON.stringify(template.id)} sits in templates/${id}`);
  return template;
}
