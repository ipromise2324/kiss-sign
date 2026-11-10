import { parseAddress, parseHex } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';

export type BlockTag = 'latest' | bigint;
export type BlockRef = { readonly number: bigint; readonly hash: Hex };
export type CallResult = { readonly kind: 'returned'; readonly data: Hex } | { readonly kind: 'reverted' };

export type EventLog = { readonly address: Address; readonly topics: readonly Hex[]; readonly data: Hex };
export type Log = EventLog & { readonly logIndex: bigint };

/** The parent fields a simulated block copies, so both providers build the same block. */
export type BlockHeader = BlockRef & { readonly time: bigint; readonly gasLimit: bigint; readonly mixHash: Hex };

export type SimulationCall = { readonly from: Address; readonly to: Address; readonly data: Hex; readonly gas: bigint };
export type StateOverride = { readonly code?: Hex; readonly stateDiff?: Readonly<Record<Hex, Hex>> };

/**
 * One block on top of the block it is sent at. Every block field a contract can read is set here, not left to each
 * provider's default; the base fee is zero, so no call pays for gas.
 */
export type SimulationRequest = {
  readonly block: { readonly number: bigint; readonly time: bigint; readonly gasLimit: bigint; readonly prevRandao: Hex };
  readonly stateOverrides: Readonly<Record<Address, StateOverride>>;
  readonly calls: readonly SimulationCall[];
};

export type SimulatedCall = { readonly status: 'success' | 'reverted'; readonly returnData: Hex; readonly logs: readonly EventLog[] };

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

function parseEventLog(raw: unknown): EventLog {
  const log = record(raw);
  if (!Array.isArray(log.topics)) throw new Error('topics not a list');
  return { address: address(log.address), topics: log.topics.map(hash32), data: parseData(log.data) };
}

const parseLog = (raw: unknown): Log => ({ ...parseEventLog(raw), logIndex: quantity(record(raw).logIndex) });

export function parseBlockHeader(raw: unknown): BlockHeader {
  const block = record(raw);
  return { ...parseBlockRef(raw), time: quantity(block.timestamp), gasLimit: quantity(block.gasLimit), mixHash: hash32(block.mixHash) };
}

function parseSimulatedCall(raw: unknown): SimulatedCall {
  const call = record(raw);
  const status = quantity(call.status);
  if (status !== 0n && status !== 1n) throw new Error('status not 0 or 1');
  const logs = call.logs ?? [];
  if (!Array.isArray(logs)) throw new Error('logs not a list');
  return { status: status === 1n ? 'success' : 'reverted', returnData: parseData(call.returnData), logs: logs.map(parseEventLog) };
}

/** An answer counts only if it is the block that was asked for, with one result per call. */
export function parseSimulation(raw: unknown, request: SimulationRequest, parent: BlockRef): readonly SimulatedCall[] {
  if (!Array.isArray(raw) || raw.length !== 1) throw new Error('not one block');
  const block = record(raw[0]);
  if (quantity(block.number) !== request.block.number || quantity(block.timestamp) !== request.block.time) throw new Error('another block');
  if (hash32(block.parentHash) !== parent.hash) throw new Error('another parent');
  if (!Array.isArray(block.calls) || block.calls.length !== request.calls.length) throw new Error('calls missing');
  return block.calls.map(parseSimulatedCall);
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
