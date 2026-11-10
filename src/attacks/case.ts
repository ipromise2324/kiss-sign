import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAddressBook } from '../address-book.ts';
import type { AddressBook } from '../address-book.ts';
import { parseCard } from '../card.ts';
import type { Card } from '../card.ts';
import type { Exchange } from '../chain/recording.ts';
import { parseFunctionSignature } from '../decode/abi.ts';
import type { AbiFunction } from '../decode/abi.ts';
import { parseServiceTx } from '../safe/parse.ts';
import { SAFE_VERSIONS, parseAddress, parseUint256 } from '../safe/types.ts';
import type { Address, SafeTx } from '../safe/types.ts';

export const ATTACKS_DIR = join('testdata', 'attacks');

/** Chains by their Safe Transaction Service name. kiss-sign reads Ethereum only. */
export const CHAINS = {
  eth: { id: 1n, name: 'Ethereum' },
  arb1: { id: 42161n, name: 'Arbitrum' },
} as const;
export type ChainName = keyof typeof CHAINS;

/** One attack as its post-mortems tell it, from `<id>/case.json`. */
export type AttackCase = {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly chain: ChainName;
  readonly safe: Address;
  readonly nonce: bigint;
  /** What the signers were shown, in the sources' words. */
  readonly believed: string;
  readonly sources: readonly string[];
  /** The card a signer would have confirmed for what they believed. */
  readonly card: Card;
  /** Names the card uses that only this case knows, such as the victim's own wallets. */
  readonly addressBook: AddressBook;
  /** The function the sources say the Safe called; shown only when its selector is the call's. */
  readonly call: AbiFunction | undefined;
};

/** What `--record` read: the transaction from the Transaction Service, and every chain request with each provider's answer. */
export type Recording = { readonly service: Readonly<Record<string, unknown>>; readonly exchanges: readonly Exchange[] };

export class AttackCaseError extends Error {
  override name = 'AttackCaseError';
}

const CASE_KEYS = 'addressBook,believed,call,card,chain,date,nonce,safe,sources,title';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

function parseCase(id: string, raw: unknown): AttackCase {
  const where = join(ATTACKS_DIR, id, 'case.json');
  const refuse = (problem: string): never => {
    throw new AttackCaseError(`${where}: ${problem}`);
  };
  if (!isRecord(raw) || Object.keys(raw).sort().join() !== CASE_KEYS) return refuse(`must have exactly ${CASE_KEYS}`);
  const { title, date, chain, believed, sources, call } = raw;
  if (!isText(title) || !isText(believed)) return refuse('title and believed must be text');
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return refuse('date must be YYYY-MM-DD');
  if (typeof chain !== 'string' || !Object.hasOwn(CHAINS, chain)) return refuse(`chain must be one of ${Object.keys(CHAINS).join(', ')}`);
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every((s) => typeof s === 'string' && s.startsWith('https://'))) {
    return refuse('sources must be https URLs');
  }
  if (call !== null && typeof call !== 'string') return refuse('call must be a function signature or null');
  try {
    return {
      id,
      title,
      date,
      chain: chain as ChainName,
      safe: parseAddress('safe', raw.safe),
      nonce: parseUint256('nonce', raw.nonce),
      believed,
      sources,
      card: parseCard(raw.card),
      addressBook: parseAddressBook(raw.addressBook),
      call: call === null ? undefined : parseFunctionSignature(call),
    };
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}

function parseRecording(id: string, raw: unknown): Recording {
  const where = join(ATTACKS_DIR, id, 'recording.json');
  if (!isRecord(raw) || Object.keys(raw).sort().join() !== 'exchanges,service' || !isRecord(raw.service) || !Array.isArray(raw.exchanges)) {
    throw new AttackCaseError(`${where}: must be exactly { "service": {...}, "exchanges": [...] }; run pnpm attacks --record ${id}`);
  }
  return { service: raw.service, exchanges: raw.exchanges as Exchange[] };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

export function caseIds(repoRoot: string): string[] {
  return readdirSync(join(repoRoot, ATTACKS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadCase(repoRoot: string, id: string): AttackCase {
  if (!caseIds(repoRoot).includes(id)) throw new AttackCaseError(`no case ${JSON.stringify(id)} in ${ATTACKS_DIR}`);
  return parseCase(id, readJson(join(repoRoot, ATTACKS_DIR, id, 'case.json')));
}

export function loadRecording(repoRoot: string, id: string): Recording {
  return parseRecording(id, readJson(join(repoRoot, ATTACKS_DIR, id, 'recording.json')));
}

/**
 * The Transaction Service's record as a Safe transaction, refused unless it is the case's Safe and nonce. The record
 * carries no Safe version; the first version whose hash is the record's safeTxHash parses it.
 */
export function caseTx(attack: AttackCase, service: Readonly<Record<string, unknown>>): SafeTx {
  let tx: SafeTx | undefined;
  for (const version of SAFE_VERSIONS) {
    try {
      tx = parseServiceTx(service, { chainId: CHAINS[attack.chain].id, version });
      break;
    } catch {
      continue;
    }
  }
  if (tx === undefined) throw new AttackCaseError(`${attack.id}: the recorded safeTxHash is no supported Safe version's hash of the recorded fields`);
  if (tx.safe !== attack.safe || tx.nonce !== attack.nonce) throw new AttackCaseError(`${attack.id}: the recorded transaction is not the case's Safe and nonce`);
  return tx;
}
