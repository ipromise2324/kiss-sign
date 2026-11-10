import { parseAddress, parseHex } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';

export type BlockTag = 'latest' | bigint;
export type BlockRef = { readonly number: bigint; readonly hash: Hex };
export type CallResult = { readonly kind: 'returned'; readonly data: Hex } | { readonly kind: 'reverted' };

export type Log = { readonly address: Address; readonly topics: readonly Hex[]; readonly data: Hex; readonly logIndex: bigint };

export type Receipt = {
  readonly transactionHash: Hex;
  readonly blockHash: Hex;
  readonly blockNumber: bigint;
  readonly transactionIndex: bigint;
  readonly status: 0 | 1;
  readonly from: Address;
  readonly to: Address | null;
  readonly contractAddress: Address | null;
  readonly gasUsed: bigint;
  readonly logs: readonly Log[];
};

export type Transaction = {
  readonly hash: Hex;
  readonly blockHash: Hex | null;
  readonly blockNumber: bigint | null;
  readonly from: Address;
  readonly to: Address | null;
  readonly value: bigint;
  readonly input: Hex;
  readonly nonce: bigint;
};

/** Every parser here throws on a malformed answer; the reader turns the throw into `unverifiable`. */
type Fields = Record<string, unknown>;

export function record(raw: unknown): Fields {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('not an object');
  return raw as Fields;
}

export function quantity(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(raw)) throw new Error('not a quantity');
  return BigInt(raw);
}

export function hash32(raw: unknown): Hex {
  const hex = parseHex('hash', raw);
  if (hex.length !== 66) throw new Error('not 32 bytes');
  return hex;
}

const nullable =
  <T>(parse: (raw: unknown) => T) =>
  (raw: unknown): T | null =>
    raw === null || raw === undefined ? null : parse(raw);

const address = (raw: unknown): Address => parseAddress('address', raw);
export const parseData = (raw: unknown): Hex => parseHex('data', raw);

export function parseBlockRef(raw: unknown): BlockRef {
  const block = record(raw);
  return { number: quantity(block.number), hash: hash32(block.hash) };
}

function parseLog(raw: unknown): Log {
  const log = record(raw);
  if (!Array.isArray(log.topics)) throw new Error('topics not a list');
  return { address: address(log.address), topics: log.topics.map(hash32), data: parseData(log.data), logIndex: quantity(log.logIndex) };
}

export function parseReceipt(raw: unknown): Receipt {
  const r = record(raw);
  const status = quantity(r.status);
  if (status !== 0n && status !== 1n) throw new Error('status not 0 or 1');
  if (!Array.isArray(r.logs)) throw new Error('logs not a list');
  return {
    transactionHash: hash32(r.transactionHash),
    blockHash: hash32(r.blockHash),
    blockNumber: quantity(r.blockNumber),
    transactionIndex: quantity(r.transactionIndex),
    status: status === 1n ? 1 : 0,
    from: address(r.from),
    to: nullable(address)(r.to),
    contractAddress: nullable(address)(r.contractAddress),
    gasUsed: quantity(r.gasUsed),
    logs: r.logs.map(parseLog),
  };
}

export function parseTransaction(raw: unknown): Transaction {
  const t = record(raw);
  return {
    hash: hash32(t.hash),
    blockHash: nullable(hash32)(t.blockHash),
    blockNumber: nullable(quantity)(t.blockNumber),
    from: address(t.from),
    to: nullable(address)(t.to),
    value: quantity(t.value),
    input: parseData(t.input),
    nonce: quantity(t.nonce),
  };
}
