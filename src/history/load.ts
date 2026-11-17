import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAddressBook } from '../address-book.ts';
import { parseCard } from '../card.ts';
import type { Card } from '../card.ts';
import { canonicalJson } from '../canonical.ts';
import { registryFromTexts } from '../registry.ts';
import { parseServiceTx } from '../safe/parse.ts';
import { SAFE_VERSIONS, checksumAddress, parseHex } from '../safe/types.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { keccakText } from '../verify/verify.ts';

/** Local only: every file here describes the configured Safe and never enters the repository. */
export const historyDir = (home: string): string => join(home, 'history');
export const txsPath = (home: string): string => join(historyDir(home), 'txs.jsonl');
export const cacheDir = (home: string): string => join(historyDir(home), 'cache');

export class HistoryError extends Error {
  override name = 'HistoryError';
}

/** One executed transaction of the Safe, as the Transaction Service gave it, with its fields checked against its safeTxHash. */
export type HistoryTx = {
  readonly nonce: number;
  readonly service: Readonly<Record<string, unknown>>;
  readonly tx: SafeTx;
  readonly transactionHash: Hex;
  readonly executionDate: string;
};

export type Intent = { readonly date: string; readonly app: string; readonly intent: string };

/** Who or what supplied a card value or an address-book entry, when the signer did not. */
export type Mark = { readonly at: string; readonly note: string };

/** A card written for one past nonce. `text` is the card itself as `card seal` would store it; marks stay outside it. */
export type HistoryCard = { readonly card: Card; readonly text: string; readonly hash: Hex; readonly marks: readonly Mark[] };

/**
 * A note on one nonce. `spentBy` names the later nonce that spends the approval this one gives, so the row takes that
 * nonce's reason: the approval is half of that operation.
 */
export type Note = { readonly text: string; readonly spentBy: number | undefined };

export type BookEntry = { readonly address: Address; readonly mark: string };

export type History = {
  readonly txs: readonly HistoryTx[];
  readonly intents: ReadonlyMap<number, Intent>;
  readonly notes: ReadonlyMap<number, Note>;
  readonly cards: ReadonlyMap<number, HistoryCard>;
  readonly book: ReadonlyMap<string, BookEntry>;
  /** Entries for the registry, merged over the repository's; none may share a name with it. */
  readonly registryOverlay: Readonly<Record<string, unknown>>;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function json(path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HistoryError(`${path}: not JSON`);
  }
}

const NONCE = /^(0|[1-9][0-9]{0,8})$/;

function nonceOf(where: string, raw: unknown): number {
  const text = typeof raw === 'number' ? String(raw) : raw;
  if (typeof text !== 'string' || !NONCE.test(text)) throw new HistoryError(`${where}: not a nonce`);
  return Number(text);
}

/** The service's records carry no Safe version; the first version whose hash is the record's safeTxHash parses it. */
function parseRecord(where: string, record: Record<string, unknown>): SafeTx {
  let last: unknown;
  for (const version of SAFE_VERSIONS) {
    try {
      return parseServiceTx(record, { chainId: 1n, version });
    } catch (error) {
      last = error;
    }
  }
  throw new HistoryError(`${where}: ${last instanceof Error ? last.message : String(last)}`);
}

/**
 * The executed multisig transactions in `txs.jsonl`, one per nonce. Records of other kinds (the service's
 * all-transactions listing also holds incoming transfers) and transactions never executed are left out.
 */
function loadTxs(path: string, safe: Address): HistoryTx[] {
  const text = readOptional(path);
  if (text === undefined) throw new HistoryError(`${path}: missing; run pnpm history fetch`);
  const byNonce = new Map<number, HistoryTx>();
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const where = `${path}:${i + 1}`;
    const record = json(where, line);
    if (!isRecord(record)) throw new HistoryError(`${where}: not a JSON object`);
    if (record.txType !== undefined && record.txType !== 'MULTISIG_TRANSACTION') continue;
    if (record.isExecuted !== true) continue;
    const tx = parseRecord(where, record);
    if (tx.safe !== safe) throw new HistoryError(`${where}: a transaction of another Safe, ${checksumAddress(tx.safe)}`);
    const nonce = Number(tx.nonce);
    if (byNonce.has(nonce)) throw new HistoryError(`${where}: a second executed transaction at nonce ${nonce}`);
    if (typeof record.executionDate !== 'string') throw new HistoryError(`${where}: no executionDate`);
    byNonce.set(nonce, {
      nonce,
      service: record,
      tx,
      transactionHash: parseHex(`${where} transactionHash`, record.transactionHash),
      executionDate: record.executionDate,
    });
  }
  return [...byNonce.values()].sort((a, b) => a.nonce - b.nonce);
}

/** `[{nonce, date, app, intent, hash}]`, where `hash` is the hash of the Ethereum transaction that executed the nonce. */
function loadIntents(path: string, txs: readonly HistoryTx[]): Map<number, Intent> {
  const text = readOptional(path);
  const intents = new Map<number, Intent>();
  if (text === undefined) return intents;
  const raw = json(path, text);
  if (!Array.isArray(raw)) throw new HistoryError(`${path}: not a JSON array`);
  for (const [i, entry] of raw.entries()) {
    const where = `${path}[${i}]`;
    if (!isRecord(entry) || typeof entry.date !== 'string' || typeof entry.app !== 'string' || typeof entry.intent !== 'string') {
      throw new HistoryError(`${where}: must be { nonce, date, app, intent, hash }`);
    }
    const nonce = nonceOf(`${where}.nonce`, entry.nonce);
    const hash = parseHex(`${where}.hash`, entry.hash).toLowerCase();
    const tx = txs.find((t) => t.nonce === nonce);
    if (tx !== undefined && tx.transactionHash.toLowerCase() !== hash) {
      throw new HistoryError(`${where}: its hash is not the transaction that executed nonce ${nonce}`);
    }
    intents.set(nonce, { date: entry.date, app: entry.app, intent: entry.intent });
  }
  return intents;
}

/** `{ "<nonce>": "<text>" }`, or `{ "<nonce>": { "note": "<text>", "spentBy": <nonce> } }` for an approval a later nonce spends. */
function loadNotes(path: string, txs: readonly HistoryTx[]): Map<number, Note> {
  const text = readOptional(path);
  const notes = new Map<number, Note>();
  if (text === undefined) return notes;
  const raw = json(path, text);
  if (!isRecord(raw)) throw new HistoryError(`${path}: must be { "<nonce>": "<text>" }`);
  for (const [key, note] of Object.entries(raw)) {
    const where = `${path}.${key}`;
    const nonce = nonceOf(where, key);
    if (typeof note === 'string') {
      notes.set(nonce, { text: note, spentBy: undefined });
      continue;
    }
    if (!isRecord(note) || Object.keys(note).sort().join() !== 'note,spentBy' || typeof note.note !== 'string') {
      throw new HistoryError(`${where}: must be text or exactly { "note": string, "spentBy": <nonce> }`);
    }
    const spentBy = nonceOf(`${where}.spentBy`, note.spentBy);
    if (spentBy <= nonce) throw new HistoryError(`${where}.spentBy: an approval is spent by a later nonce`);
    if (!txs.some((tx) => tx.nonce === spentBy)) throw new HistoryError(`${where}.spentBy: no executed transaction at nonce ${spentBy} in the history`);
    notes.set(nonce, { text: note.note, spentBy });
  }
  for (const [nonce, { spentBy }] of notes) {
    const next = spentBy === undefined ? undefined : notes.get(spentBy)?.spentBy;
    if (next !== undefined) throw new HistoryError(`${path}.${nonce}.spentBy: nonce ${spentBy} is itself an approval spent by nonce ${next}`);
  }
  return notes;
}

function parseMarks(where: string, raw: unknown): Mark[] {
  if (!Array.isArray(raw)) throw new HistoryError(`${where}: must be a list`);
  return raw.map((mark, i) => {
    if (!isRecord(mark) || Object.keys(mark).sort().join() !== 'at,note' || typeof mark.at !== 'string' || typeof mark.note !== 'string') {
      throw new HistoryError(`${where}[${i}]: must be exactly { "at": string, "note": string }`);
    }
    return { at: mark.at, note: mark.note };
  });
}

const VALUE_PATH = /^operations\[(0|[1-9][0-9]*)\]\.values\.([A-Za-z0-9_-]+)$/;

/** `{ "operations": [...], "origin": "history", "marks": [{ "at": "operations[0].values.amount", "note": ... }] }`. */
function parseHistoryCard(where: string, raw: unknown): HistoryCard {
  if (!isRecord(raw) || Object.keys(raw).sort().join() !== 'marks,operations,origin' || raw.origin !== 'history') {
    throw new HistoryError(`${where}: must be exactly { "operations": [...], "origin": "history", "marks": [...] }`);
  }
  let card: Card;
  try {
    card = parseCard({ operations: raw.operations });
  } catch (error) {
    throw new HistoryError(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const marks = parseMarks(`${where}.marks`, raw.marks);
  for (const mark of marks) {
    const [, index, name] = VALUE_PATH.exec(mark.at) ?? [];
    if (index === undefined || name === undefined || card.operations[Number(index)]?.values[name] === undefined) {
      throw new HistoryError(`${where}.marks: ${JSON.stringify(mark.at)} names no value on the card`);
    }
  }
  const text = canonicalJson(card);
  return { card, text, hash: keccakText(text), marks };
}

function loadCards(dir: string): Map<number, HistoryCard> {
  const cards = new Map<number, HistoryCard>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cards;
    throw error;
  }
  for (const name of names) {
    const [, nonce] = /^(0|[1-9][0-9]*)\.json$/.exec(name) ?? [];
    if (nonce === undefined) throw new HistoryError(`${join(dir, name)}: a card file is named <nonce>.json`);
    const path = join(dir, name);
    cards.set(Number(nonce), parseHistoryCard(path, json(path, readFileSync(path, 'utf8'))));
  }
  return cards;
}

/** `{ "<name>": { "address": "0x...", "mark": "<who confirmed it>" } }`. */
function loadBook(path: string): Map<string, BookEntry> {
  const text = readOptional(path);
  if (text === undefined) return new Map();
  const raw = json(path, text);
  if (!isRecord(raw)) throw new HistoryError(`${path}: not a JSON object`);
  const marks = new Map<string, string>();
  const addresses: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || Object.keys(entry).sort().join() !== 'address,mark' || typeof entry.mark !== 'string') {
      throw new HistoryError(`${path}.${name}: must be exactly { "address": "0x...", "mark": string }`);
    }
    addresses[name] = entry.address;
    marks.set(name, entry.mark);
  }
  let book: ReadonlyMap<string, Address>;
  try {
    book = parseAddressBook(addresses);
  } catch (error) {
    throw new HistoryError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return new Map([...book].map(([name, address]) => [name, { address, mark: marks.get(name) ?? '' }]));
}

function loadOverlay(path: string): Record<string, unknown> {
  const text = readOptional(path);
  if (text === undefined) return {};
  const raw = json(path, text);
  if (!isRecord(raw)) throw new HistoryError(`${path}: not a JSON object`);
  return raw;
}

export function loadHistory(home: string, safe: Address): History {
  const dir = historyDir(home);
  const txs = loadTxs(txsPath(home), safe);
  return {
    txs,
    intents: loadIntents(join(dir, 'intents.json'), txs),
    notes: loadNotes(join(dir, 'notes.json'), txs),
    cards: loadCards(join(dir, 'cards')),
    book: loadBook(join(dir, 'address-book.json')),
    registryOverlay: loadOverlay(join(dir, 'registry.json')),
  };
}

/** The repository's registry with the history overlay's entries added, as text. A name in both is refused. */
export function mergeRegistry(repoText: string, overlay: Readonly<Record<string, unknown>>, attributes: string | undefined): string {
  const base = JSON.parse(repoText) as Record<string, unknown>;
  const twin = Object.keys(overlay).find((name) => Object.hasOwn(base, name));
  if (twin !== undefined) throw new HistoryError(`history/registry.json: ${twin} is already in registry/contracts.json`);
  const merged = { ...base, ...overlay };
  try {
    registryFromTexts(JSON.stringify(merged), undefined, attributes);
  } catch (error) {
    throw new HistoryError(`history/registry.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}
