import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressBook } from './address-book.ts';
import { canonicalJson } from './canonical.ts';
import type { Registry, RegistryEntry } from './registry.ts';
import type { Address, Hex } from './safe/types.ts';
import type { Template } from './template/template.ts';

/** What the signer confirms at each signing: which templates, and each one's values. Addresses appear only as names. */
export type Card = { readonly operations: readonly CardOperation[] };
export type CardOperation = { readonly template: string; readonly values: Readonly<Record<string, string>> };

export type ResolvedValue =
  | { readonly kind: 'contract'; readonly name: string; readonly entry: RegistryEntry }
  | { readonly kind: 'amount'; readonly value: bigint }
  | { readonly kind: 'nonce'; readonly value: bigint }
  | { readonly kind: 'address'; readonly name: string; readonly address: Address; readonly from: 'registry' | 'address-book' | 'safe' };

export type ResolvedOperation = { readonly template: string; readonly values: ReadonlyMap<string, ResolvedValue> };
export type ResolvedCard = { readonly safe: Address; readonly operations: readonly ResolvedOperation[] };

export type CardRefusal =
  | 'unknown-template'
  | 'missing-value'
  | 'unexpected-value'
  | 'unknown-name'
  | 'ambiguous-name'
  | 'wrong-contract-kind'
  | 'not-an-amount'
  | 'not-a-nonce';

export type Resolution =
  | { readonly kind: 'resolved'; readonly card: ResolvedCard }
  | { readonly kind: 'refused'; readonly reason: CardRefusal; readonly at: string; readonly detail: string };

export class CardError extends Error {
  override name = 'CardError';
}

const UINT256_LIMIT = 1n << 256n;

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
          const value = /^(0|[1-9][0-9]{0,77})$/.test(raw) ? BigInt(raw) : undefined;
          if (value === undefined || value >= UINT256_LIMIT) {
            return field.kind === 'amount' ? refuse('not-an-amount', name, 'not a base-unit integer') : refuse('not-a-nonce', name, 'not a nonce');
          }
          values.set(name, { kind: field.kind, value });
          break;
        }
        case 'contract': {
          const entry = context.registry.entries.get(raw);
          if (entry === undefined) return refuse('unknown-name', name, `${JSON.stringify(raw)} is not in the contract registry`);
          if (entry.kind !== field.registryKind) return refuse('wrong-contract-kind', name, `${raw} is a ${entry.kind}, not a ${field.registryKind}`);
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
        case 'recipient': {
          const booked = context.addressBook.get(raw);
          if (raw === 'safe') values.set(name, { kind: 'address', name: raw, address: context.safe, from: 'safe' });
          else if (booked !== undefined) values.set(name, { kind: 'address', name: raw, address: booked, from: 'address-book' });
          else return refuse('unknown-name', name, `${JSON.stringify(raw)} is not in the address book; a recipient other than the Safe must be added with kiss-sign book add`);
          break;
        }
      }
    }
    operations.push({ template: template.id, values });
  }
  return { kind: 'resolved', card: { safe: context.safe, operations } };
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
