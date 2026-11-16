import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressBook } from './address-book.ts';
import { canonicalJson } from './canonical.ts';
import { MARKET_ENTRY_PARTS, isAttribute, isMarketEntryPart } from './registry.ts';
import type { Market, Registry, RegistryEntry } from './registry.ts';
import { checksumAddress } from './safe/types.ts';
import type { Address, Hex } from './safe/types.ts';
import { WAD, contractRefusal } from './template/template.ts';
import type { CardRef, Template } from './template/template.ts';

/** What the signer confirms at each signing: which templates, and each one's values. Addresses appear only as names. */
export type Card = { readonly operations: readonly CardOperation[] };
export type CardOperation = { readonly template: string; readonly values: Readonly<Record<string, string>> };

export type ResolvedValue =
  | { readonly kind: 'contract'; readonly name: string; readonly entry: RegistryEntry }
  | { readonly kind: 'amount'; readonly value: bigint }
  | { readonly kind: 'nonce'; readonly value: bigint }
  | { readonly kind: 'address'; readonly name: string; readonly address: Address; readonly from: 'registry' | 'address-book' | 'safe' }
  | { readonly kind: 'market'; readonly market: Market };

export type ResolvedOperation = { readonly template: string; readonly values: ReadonlyMap<string, ResolvedValue> };
export type ResolvedCard = { readonly safe: Address; readonly operations: readonly ResolvedOperation[] };

export type CardRefusal =
  | 'unknown-template'
  | 'missing-value'
  | 'unexpected-value'
  | 'unknown-name'
  | 'ambiguous-name'
  | 'wrong-contract-kind'
  | 'wrong-protocol'
  | 'not-an-amount'
  | 'not-a-nonce'
  | 'not-a-percent'
  | 'not-the-same';

export type Resolution =
  | { readonly kind: 'resolved'; readonly card: ResolvedCard }
  | { readonly kind: 'refused'; readonly reason: CardRefusal; readonly at: string; readonly detail: string };

export class CardError extends Error {
  override name = 'CardError';
}

const UINT256_LIMIT = 1n << 256n;

/** A card amount or nonce: a base-unit integer in plain decimal digits, below 2^256. */
export function parseUint256(raw: string): bigint | undefined {
  const value = /^(0|[1-9][0-9]{0,77})$/.test(raw) ? BigInt(raw) : undefined;
  return value !== undefined && value < UINT256_LIMIT ? value : undefined;
}

export function parseCard(raw: unknown): Card {
  const fail = (problem: string): never => {
    throw new CardError(problem);
  };
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(raw) || Object.keys(raw).join() !== 'operations' || !Array.isArray(raw.operations)) {
    return fail('card: must be exactly { "operations": [...] }');
  }
  if (raw.operations.length === 0) return fail('card.operations: empty');
  const operations = raw.operations.map((op: unknown, i): CardOperation => {
    const at = `card.operations[${i}]`;
    if (!isObject(op) || Object.keys(op).sort().join() !== 'template,values' || typeof op.template !== 'string' || !isObject(op.values)) {
      return fail(`${at}: must be exactly { "template": string, "values": {...} }`);
    }
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(op.values)) {
      if (typeof value !== 'string') return fail(`${at}.values.${name}: not a string`);
      values[name] = value;
    }
    return { template: op.template, values };
  });
  return { operations };
}

export type CardContext = {
  readonly templates: ReadonlyMap<string, Template>;
  readonly registry: Registry;
  readonly addressBook: AddressBook;
  readonly safe: Address;
};

function resolveAddress(name: string, context: CardContext): ResolvedValue | CardRefusal {
  if (name === 'safe') return { kind: 'address', name, address: context.safe, from: 'safe' };
  const contract = context.registry.entries.get(name);
  const booked = context.addressBook.get(name);
  if (contract !== undefined && booked !== undefined) return 'ambiguous-name';
  if (contract !== undefined) return { kind: 'address', name, address: contract.address, from: 'registry' };
  if (booked !== undefined) return { kind: 'address', name, address: booked, from: 'address-book' };
  return 'unknown-name';
}

/** Turns each card value into what it names, using only the registry, the address book, and the Safe. */
export function resolveCard(card: Card, context: CardContext): Resolution {
  const operations: ResolvedOperation[] = [];
  for (const [i, op] of card.operations.entries()) {
    const refuse = (reason: CardRefusal, field: string, detail: string): Resolution => ({
      kind: 'refused',
      reason,
      at: `operations[${i}]${field === '' ? '' : `.values.${field}`}`,
      detail,
    });
    const template = context.templates.get(op.template);
    if (template === undefined) return refuse('unknown-template', '', `no template ${JSON.stringify(op.template)}`);
    const extra = Object.keys(op.values).find((name) => !template.card.has(name));
    if (extra !== undefined) return refuse('unexpected-value', extra, `${template.id} has no card field ${JSON.stringify(extra)}`);
    const values = new Map<string, ResolvedValue>();
    for (const [name, field] of template.card) {
      const raw = op.values[name];
      if (raw === undefined) return refuse('missing-value', name, `${template.id} needs ${name}`);
      switch (field.kind) {
        case 'amount':
        case 'nonce': {
          const value = parseUint256(raw);
          if (value === undefined) {
            return field.kind === 'amount' ? refuse('not-an-amount', name, 'not a base-unit integer') : refuse('not-a-nonce', name, 'not a nonce');
          }
          values.set(name, { kind: field.kind, value });
          break;
        }
        case 'percent': {
          const value = parseUint256(raw);
          if (value === undefined || value > WAD) return refuse('not-a-percent', name, `not a percent in WAD base units, ${WAD} at most`);
          values.set(name, { kind: 'amount', value });
          break;
        }
        case 'contract': {
          const entry = context.registry.entries.get(raw);
          if (entry === undefined) return refuse('unknown-name', name, `${JSON.stringify(raw)} is not in the contract registry`);
          const refused = contractRefusal(field.scope, entry, context.registry);
          if (refused !== undefined) return refuse(refused.reason, name, refused.detail);
          values.set(name, { kind: 'contract', name: raw, entry });
          break;
        }
        case 'address': {
          const resolved = resolveAddress(raw, context);
          if (typeof resolved === 'string') {
            const where = resolved === 'unknown-name' ? 'is in neither the registry nor the address book' : 'is in both the registry and the address book';
            return refuse(resolved, name, `${JSON.stringify(raw)} ${where}`);
          }
          values.set(name, resolved);
          break;
        }
        case 'market': {
          const market = context.registry.markets.get(raw);
          if (market === undefined) return refuse('unknown-name', name, `${JSON.stringify(raw)} is not a market in registry/markets.json`);
          values.set(name, { kind: 'market', market });
          break;
        }
        case 'recipient': {
          const booked = context.addressBook.get(raw);
          if (raw === 'safe') values.set(name, { kind: 'address', name: raw, address: context.safe, from: 'safe' });
          else if (booked !== undefined) values.set(name, { kind: 'address', name: raw, address: booked, from: 'address-book' });
          else return refuse('unknown-name', name, `${JSON.stringify(raw)} is not in the address book; a recipient other than the Safe must be added with pnpm kiss-sign book add`);
          break;
        }
      }
    }
    const named = template.same.map((ref) => {
      const target = resolveRef(ref, values, context.registry);
      const label = ref.attribute === undefined ? ref.field : `${ref.field}.${ref.attribute}`;
      if ('problem' in target) return { text: `${label} none`, address: undefined };
      return target.kind === 'address' ? { text: `${label} ${target.name}`, address: target.address } : { text: label, address: undefined };
    });
    if (named.some((n) => n.address === undefined || n.address !== named[0]?.address)) {
      return refuse('not-the-same', '', `${template.id} needs one address for ${named.map((n) => n.text).join(' and ')}`);
    }
    operations.push({ template: template.id, values });
  }
  return { kind: 'resolved', card: { safe: context.safe, operations } };
}

/** What a card reference names on a resolved card: an address with its name, a number, a market's id, or a whole market. */
export type RefTarget =
  | { readonly kind: 'address'; readonly name: string; readonly address: Address }
  | { readonly kind: 'uint'; readonly value: bigint }
  | { readonly kind: 'bytes32'; readonly value: Hex }
  | { readonly kind: 'market'; readonly market: Market };

export function resolveRef(ref: CardRef, values: ReadonlyMap<string, ResolvedValue>, registry: Registry): RefTarget | { readonly problem: string } {
  const value = values.get(ref.field);
  const { attribute } = ref;
  if (value === undefined) return { problem: `the card has no ${ref.field}` };
  switch (value.kind) {
    case 'amount':
    case 'nonce':
      return { kind: 'uint', value: value.value };
    case 'address':
      return { kind: 'address', name: value.name, address: value.address };
    case 'contract': {
      if (attribute === undefined) return { kind: 'address', name: value.name, address: value.entry.address };
      const name = isAttribute(attribute) ? value.entry.attributes[attribute] : undefined;
      const target = name === undefined ? undefined : registry.entries.get(name);
      return target === undefined ? { problem: `the registry has no ${attribute} for ${value.name}` } : { kind: 'address', name: target.name, address: target.address };
    }
    case 'market': {
      const { market } = value;
      if (attribute === undefined) return { kind: 'market', market };
      if (attribute === 'lltv') return { kind: 'uint', value: market.lltv };
      if (attribute === 'id') return { kind: 'bytes32', value: market.id };
      if (!isMarketEntryPart(attribute)) return { problem: `a market has no ${attribute}` };
      return { kind: 'address', name: market[attribute].name, address: market[attribute].address };
    }
  }
}

/** A market as the signer checks it: its name, id and lltv, then each part's registry name and full address. */
export function marketLines(market: Market): string[] {
  const lltv = `${market.lltv / 10n ** 18n}.${(market.lltv % 10n ** 18n).toString().padStart(18, '0')}`.replace(/\.?0+$/, '');
  return [
    `${market.name} id ${market.id}, lltv ${lltv} (${market.lltv})`,
    ...MARKET_ENTRY_PARTS.map((part) => `${part} ${market[part].name} ${checksumAddress(market[part].address)}`),
  ];
}

const SEAL = /^0x[0-9a-f]{64}$/;

export function cardsDir(home: string): string {
  return join(home, 'cards');
}

/** Stores the card as canonical JSON under the keccak256 of that text, and returns the hash. */
export function sealCard(home: string, card: Card): Hex {
  const text = canonicalJson(card);
  const hash = `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}` as Hex;
  const dir = cardsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${hash}.json`);
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return hash;
}

/** Reads a sealed card back, refusing a file whose content no longer hashes to its name. */
export function loadSealed(home: string, hash: string): Card {
  if (!SEAL.test(hash)) throw new CardError(`${JSON.stringify(hash.slice(0, 80))}: not a card hash`);
  const text = readFileSync(join(cardsDir(home), `${hash}.json`), 'utf8');
  const actual = `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;
  if (actual !== hash) throw new CardError(`sealed card ${hash} was modified: its content hashes to ${actual}`);
  return parseCard(JSON.parse(text));
}
