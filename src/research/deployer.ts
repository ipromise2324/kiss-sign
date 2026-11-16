import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { request } from 'node:https';
import { fallbackLookup } from '../chain/dns.ts';
import { requestText, retried, transientStatus } from '../chain/https.ts';
import type { NoteUnread } from '../chain/https.ts';
import { MissingKeyError } from '../chain/providers.ts';
import type { Reader } from '../chain/reader.ts';
import { findKey, keySpec } from '../keys.ts';
import type { Env, KeySpec } from '../keys.ts';
import type { RegistryEntry } from '../registry.ts';
import { SafeTxParseError, checksumAddress, parseAddress, parseHex } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';

/**
 * How the transaction made the address: the sender deployed it (`transaction`), the transaction called a public CREATE2
 * deployer with a salt and the init code (`create2`), or a contract the transaction called or deployed made it by
 * CREATE at one of its nonces (`create`).
 */
export type CreationVia = { readonly kind: 'transaction' } | { readonly kind: 'create2'; readonly deployer: Address } | { readonly kind: 'create'; readonly factory: Address };

/** An entry's creation as the proof found it. The sender, who signed the transaction, is the deployer. */
export type Creation =
  | { readonly kind: 'proven'; readonly tx: Hex; readonly block: bigint; readonly sender: Address; readonly via: CreationVia }
  | { readonly kind: 'unproven'; readonly why: string }
  | { readonly kind: 'unread'; readonly why: string };

export type Creations = ReadonlyMap<Address, Creation>;

/** Where Etherscan says to look: the creation transaction, and the contract that made the address when a contract did. */
export type CreationHint = { readonly tx: Hex; readonly factory: Address | undefined };

/** Answers each address's hint, or why it has none; throws when the service gives no answer. */
export type HintLookup = (addresses: readonly Address[]) => Promise<ReadonlyMap<Address, CreationHint>>;

/**
 * Deployers anyone may call to put the same init code at the same address. A contract they create was deployed by
 * whoever sent the transaction, never by them.
 */
export const PUBLIC_CREATE2_DEPLOYERS: ReadonlySet<Address> = new Set(['0x4e59b44847b379578588920ca78fbf26c0b4956c', '0x914d7fec6aac8cd542e72bca78b30650d45643d7'].map((a) => parseAddress('deployer', a)));

const EMPTY = parseHex('code', '0x');

/** At most this many nonces of one factory are tried: one block's CREATEs by one contract. */
const MAX_NONCES = 1024n;

const addressOfHash = (hash: Uint8Array): Address => `0x${bytesToHex(hash.slice(12))}` as Address;

function rlpNonce(nonce: bigint): Uint8Array {
  if (nonce === 0n) return Uint8Array.of(0x80);
  const hex = nonce.toString(16);
  const bytes = hexToBytes(hex.length % 2 === 0 ? hex : `0${hex}`);
  return bytes.length === 1 && (bytes[0] as number) < 0x80 ? bytes : Uint8Array.of(0x80 + bytes.length, ...bytes);
}

/** The address CREATE gives `sender` at `nonce`: the last 20 bytes of keccak256(rlp([sender, nonce])). */
export function createAddress(sender: Address, nonce: bigint): Address {
  const payload = Uint8Array.of(0x94, ...hexToBytes(sender.slice(2)), ...rlpNonce(nonce));
  return addressOfHash(keccak_256(Uint8Array.of(0xc0 + payload.length, ...payload)));
}

/** The address CREATE2 gives `deployer` for `salt` and the init code's hash. */
export function create2Address(deployer: Address, salt: Uint8Array, initCode: Uint8Array): Address {
  return addressOfHash(keccak_256(Uint8Array.of(0xff, ...hexToBytes(deployer.slice(2)), ...salt, ...keccak_256(initCode))));
}

/** What a call to a public CREATE2 deployer creates: its input is a 32-byte salt, then the init code. */
function publicCreate2(to: Address | null, input: Hex): Address | undefined {
  if (to === null || !PUBLIC_CREATE2_DEPLOYERS.has(to) || input.length < 2 + 64) return undefined;
  const bytes = hexToBytes(input.slice(2));
  return create2Address(to, bytes.slice(0, 32), bytes.slice(32));
}

/**
 * Proves, through both providers, that the hinted transaction created `address`: it succeeded, the address had no code
 * at the block before and has code at its block, and one of three derivations gives the address.
 */
export async function proveCreation(address: Address, hint: CreationHint, reader: Reader): Promise<Creation> {
  const [tx, receipt] = await Promise.all([reader.getTransaction(hint.tx), reader.getTransactionReceipt(hint.tx)]);
  if (tx.kind === 'unverifiable') return { kind: 'unread', why: tx.reason };
  if (receipt.kind === 'unverifiable') return { kind: 'unread', why: receipt.reason };
  if (tx.value === null || receipt.value === null) return { kind: 'unproven', why: `the chain holds no transaction ${hint.tx}` };
  if (receipt.value.status !== 1) return { kind: 'unproven', why: `transaction ${hint.tx} failed` };
  const number = receipt.value.blockNumber;
  const [at, before] = await Promise.all([reader.block(number), reader.block(number - 1n)]);
  if (at.kind === 'unverifiable') return { kind: 'unread', why: at.reason };
  if (before.kind === 'unverifiable') return { kind: 'unread', why: before.reason };
  const [codeBefore, codeAt] = await Promise.all([reader.getCode(address, before.value), reader.getCode(address, at.value)]);
  if (codeBefore.kind === 'unverifiable') return { kind: 'unread', why: codeBefore.reason };
  if (codeAt.kind === 'unverifiable') return { kind: 'unread', why: codeAt.reason };
  if (codeBefore.value !== EMPTY || codeAt.value === EMPTY) return { kind: 'unproven', why: `the address did not first get code in block ${number}, the block of ${hint.tx}` };
  const sender = tx.value.from;
  const proven = (via: CreationVia): Creation => ({ kind: 'proven', tx: hint.tx, block: number, sender, via });
  if (receipt.value.contractAddress === address) return proven({ kind: 'transaction' });
  const created = publicCreate2(tx.value.to, tx.value.input);
  if (created === address) return proven({ kind: 'create2', deployer: tx.value.to as Address });
  const factory = hint.factory;
  if (factory === undefined || (factory !== tx.value.to && factory !== receipt.value.contractAddress && factory !== created)) {
    return { kind: 'unproven', why: `transaction ${hint.tx} neither deploys the address nor calls or deploys the contract that did` };
  }
  const [first, last] = await Promise.all([reader.getTransactionCount(factory, before.value), reader.getTransactionCount(factory, at.value)]);
  if (first.kind === 'unverifiable') return { kind: 'unread', why: first.reason };
  if (last.kind === 'unverifiable') return { kind: 'unread', why: last.reason };
  for (let nonce = first.value; nonce < last.value && nonce < first.value + MAX_NONCES; nonce++) {
    if (createAddress(factory, nonce) === address) return proven({ kind: 'create', factory });
  }
  return { kind: 'unproven', why: `${checksumAddress(factory)} made no contract at the address by CREATE in block ${number}; a CREATE2 from it is not proven` };
}

/** Each entry's creation, from Etherscan's hints, proved through both providers. */
export async function gatherCreations(entries: readonly RegistryEntry[], hints: HintLookup, reader: Reader): Promise<Map<Address, Creation>> {
  const addresses = [...new Set(entries.map((entry) => entry.address))];
  const creations = new Map<Address, Creation>();
  let found: ReadonlyMap<Address, CreationHint>;
  try {
    found = await hints(addresses);
  } catch (error) {
    if (!(error instanceof CreationLookupError)) throw error;
    for (const address of addresses) creations.set(address, { kind: 'unread', why: error.message });
    return creations;
  }
  for (const address of addresses) {
    const hint = found.get(address);
    creations.set(address, hint === undefined ? { kind: 'unproven', why: 'Etherscan names no creation transaction' } : await proveCreation(address, hint, reader));
  }
  return creations;
}

export class CreationLookupError extends Error {
  override name = 'CreationLookupError';
}

/**
 * Each entry's creation read live, or undefined with why when a key it needs is not set: Etherscan's hints need
 * `ETHERSCAN_API_KEY`, and the proof reads through Alchemy, which needs `ALCHEMY_API_KEY`.
 */
export async function liveCreations(entries: readonly RegistryEntry[], env: Env, note: NoteUnread, reader: () => Reader): Promise<Map<Address, Creation> | { readonly missing: string }> {
  const spec = keySpec('etherscan') as KeySpec;
  const key = findKey(spec, env)?.value;
  if (key === undefined) return { missing: spec.env };
  let live: Reader;
  try {
    live = reader();
  } catch (error) {
    if (error instanceof MissingKeyError) return { missing: error.message };
    throw error;
  }
  return gatherCreations(entries, etherscanHints(key, note), live);
}

/** Etherscan's hints, five addresses a request, a few requests a second as its free plan allows; the key never reaches a message. */
export function etherscanHints(key: string, note: NoteUnread): HintLookup {
  return async (addresses) => {
    const hints = new Map<Address, CreationHint>();
    for (let i = 0; i < addresses.length; i += 5) {
      const query = new URLSearchParams({ chainid: '1', module: 'contract', action: 'getcontractcreation', contractaddresses: addresses.slice(i, i + 5).join(','), apikey: key });
      const label = `api.etherscan.io getcontractcreation for ${addresses.slice(i, i + 5).length} addresses`;
      let answer;
      try {
        const read = () =>
          requestText(
            request,
            { method: 'GET', hostname: 'api.etherscan.io', path: `/v2/api?${query}`, servername: 'api.etherscan.io', rejectUnauthorized: true, lookup: fallbackLookup(), signal: AbortSignal.timeout(30_000) },
            undefined,
            1024 * 1024,
          );
        answer = await retried(label, read, (a) => transientStatus(a) ?? (/rate limit/i.test(a.text) ? 'rate limited' : undefined), note);
      } catch {
        throw new CreationLookupError('api.etherscan.io unreachable');
      }
      if (answer.status !== 200) throw new CreationLookupError(`api.etherscan.io answered HTTP ${answer.status}`);
      let body: unknown;
      try {
        body = JSON.parse(answer.text);
      } catch {
        throw new CreationLookupError('api.etherscan.io sent no JSON');
      }
      for (const [address, hint] of parseCreationHints(body)) hints.set(address, hint);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return hints;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Etherscan's `getcontractcreation` answer for up to five addresses. */
export function parseCreationHints(raw: unknown): Map<Address, CreationHint> {
  if (!isRecord(raw)) throw new CreationLookupError('Etherscan sent no answer');
  if (raw.status === '0' && /no data found/i.test(String(raw.message))) return new Map();
  if (raw.status !== '1' || !Array.isArray(raw.result)) throw new CreationLookupError(`Etherscan refused: ${String(raw.message).slice(0, 80)}`);
  const hints = new Map<Address, CreationHint>();
  for (const item of raw.result) {
    if (!isRecord(item)) continue;
    try {
      const factory = typeof item.contractFactory === 'string' && item.contractFactory !== '' ? parseAddress('contractFactory', item.contractFactory) : undefined;
      hints.set(parseAddress('contractAddress', item.contractAddress), { tx: parseHex('txHash', item.txHash), factory });
    } catch (error) {
      if (!(error instanceof SafeTxParseError)) throw error;
    }
  }
  return hints;
}

/** The deployer an entry shares with other entries of its protocol the run checks, each a proven creation by the same sender. */
export function sharedDeployer(entry: RegistryEntry, entries: readonly RegistryEntry[], creations: Creations): { readonly sender: Address; readonly siblings: readonly string[] } | undefined {
  const own = creations.get(entry.address);
  if (own?.kind !== 'proven') return undefined;
  const siblings = entries.filter((other) => {
    if (other.name === entry.name || other.defillama === undefined || other.defillama !== entry.defillama || other.address === entry.address) return false;
    const theirs = creations.get(other.address);
    return theirs?.kind === 'proven' && theirs.sender === own.sender;
  });
  return { sender: own.sender, siblings: siblings.map((other) => other.name) };
}
