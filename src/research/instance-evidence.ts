import { bytesToHex } from '@noble/hashes/utils.js';
import { retried, transientError, transientStatus } from '../chain/https.ts';
import type { NoteUnread } from '../chain/https.ts';
import { aggregate } from '../chain/multicall.ts';
import type { Reader } from '../chain/reader.ts';
import { admitted, expectedAnswers, proveInstance } from '../contracts/instance.ts';
import { trimBlockAnswers } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import type { Transport } from '../chain/rpc.ts';
import type { BlockRef, BlockTag } from '../chain/types.ts';
import { parseFunctionSignature } from '../decode/abi.ts';
import type { AbiFunction } from '../decode/abi.ts';
import { encodeCall } from '../decode/codec.ts';
import { sizeOf } from '../registry.ts';
import type { Registry, RegistryEntry, SizeView } from '../registry.ts';
import { SafeTxParseError, checksumAddress, parseAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';

export type AlchemyCall = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** Asks again after each pause while Alchemy gives no answer, and notes a request that never got one. */
export function alchemyCall(transport: Transport, url: string, note: NoteUnread, pausesMs?: readonly number[]): AlchemyCall {
  return async (method, params) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    let answer;
    try {
      answer = await retried(`alchemy ${method}`, () => transport(url, body, AbortSignal.timeout(60_000)), transientStatus, note, pausesMs);
    } catch (error) {
      if (!transientError(error)) note(`alchemy ${method}: unreachable`);
      throw new Error('alchemy unreachable');
    }
    const failed = (why: string): never => {
      if (transientStatus(answer) === undefined) note(`alchemy ${method}: ${why}`);
      throw new Error(`alchemy ${why}`);
    };
    if (answer.status !== 200) failed(`answered HTTP ${answer.status}`);
    let reply: { result?: unknown; error?: unknown };
    try {
      reply = JSON.parse(answer.text) as typeof reply;
    } catch {
      return failed('sent no JSON');
    }
    if (typeof reply !== 'object' || reply === null) return failed('sent no JSON object');
    if (reply.error !== undefined && reply.error !== null) failed('refused the request');
    return reply.result;
  };
}

export function trimVaultRecording(exchanges: readonly Exchange[]): Exchange[] {
  return exchanges.map(trimBlockAnswers).map((exchange) => {
    const answer = exchange.answers.alchemy;
    if (exchange.method !== 'alchemy_getAssetTransfers' || !isRecord(answer) || !Array.isArray(answer.transfers)) return exchange;
    const to = [...new Set((answer.transfers as unknown[]).map((t) => (isRecord(t) ? t.to : undefined)))];
    return { ...exchange, answers: { alchemy: { ...answer, transfers: to.map((recipient) => ({ to: recipient })) } } };
  });
}

export type Reading<T> = { readonly kind: 'read'; readonly value: T } | { readonly kind: 'unverifiable'; readonly reason: string };

export type AssetsPoint = {
  readonly block: bigint;
  readonly time: Reading<bigint>;
  readonly totalAssets: Reading<{ readonly kind: 'assets'; readonly amount: bigint } | { readonly kind: 'no-code' } | { readonly kind: 'reverted' }>;
};

export type HolderCount = {
  readonly block: bigint;
  readonly candidates: number;
  readonly holders: number;
  readonly supply: bigint;
  readonly largestBalances: readonly bigint[];
};

/** What `size` declares, read: `asset` is the token its `unit` view answers, and `holders` is absent when it counts none. */
export type VaultEvidence = {
  readonly vault: RegistryEntry;
  readonly size: SizeView;
  readonly latest: BlockRef;
  readonly asset: Reading<{ readonly address: Address; readonly decimals: number }> | undefined;
  readonly points: readonly AssetsPoint[];
  readonly holders: Reading<HolderCount> | undefined;
};

const SECONDS_PER_SLOT = 12n;
export const BLOCKS_PER_MONTH = (30n * 24n * 3600n) / SECONDS_PER_SLOT;
export const MONTHS = 12;
const MAX_TRANSFER_PAGES = 300;
const BALANCES_PER_CALL = 500;

const TOTAL_SUPPLY = '0x18160ddd' as Hex;
const DECIMALS = '0x313ce567' as Hex;
const BALANCE_OF = parseFunctionSignature('balanceOf(address)');

const ZERO = parseAddress('zero', `0x${'00'.repeat(20)}`);
const hex = (n: bigint): string => `0x${n.toString(16)}`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const unverifiable = (reason: string) => ({ kind: 'unverifiable', reason }) as const;

async function word(reader: Reader, to: Address, data: Hex, at: BlockRef, label: string): Promise<Reading<bigint>> {
  const read = await reader.call({ to, data }, at);
  if (read.kind === 'unverifiable') return unverifiable(read.reason);
  if (read.value.kind === 'reverted') return unverifiable(`${label} reverted`);
  if (read.value.data.length !== 66) return unverifiable(`${label} answered ${(read.value.data.length - 2) / 2} bytes, not one word`);
  return { kind: 'read', value: BigInt(read.value.data) };
}

async function assetOf(reader: Reader, vault: Address, unit: AbiFunction, at: BlockRef): Promise<Reading<{ readonly address: Address; readonly decimals: number }>> {
  const asset = await word(reader, vault, unit.selector, at, unit.signature);
  if (asset.kind === 'unverifiable') return asset;
  if (asset.value >> 160n !== 0n) return unverifiable(`${unit.signature} answered a word that is no address`);
  const address = parseAddress('asset', `0x${asset.value.toString(16).padStart(40, '0')}`);
  const decimals = await word(reader, address, DECIMALS, at, 'decimals()');
  if (decimals.kind === 'unverifiable') return decimals;
  if (decimals.value > 77n) return unverifiable(`decimals() answered ${decimals.value}`);
  return { kind: 'read', value: { address, decimals: Number(decimals.value) } };
}

async function pointAt(reader: Reader, vault: Address, size: AbiFunction, number: bigint): Promise<AssetsPoint> {
  const block = await reader.block(number);
  if (block.kind === 'unverifiable') return { block: number, time: unverifiable(block.reason), totalAssets: unverifiable(block.reason) };
  const header = await reader.header(block.value);
  const time: Reading<bigint> = header.kind === 'agreed' ? { kind: 'read', value: header.value.time } : unverifiable(header.reason);
  const read = await reader.call({ to: vault, data: size.selector }, block.value);
  if (read.kind === 'unverifiable') return { block: number, time, totalAssets: unverifiable(read.reason) };
  if (read.value.kind === 'reverted') return { block: number, time, totalAssets: { kind: 'read', value: { kind: 'reverted' } } };
  if (read.value.data.length === 2) return { block: number, time, totalAssets: { kind: 'read', value: { kind: 'no-code' } } };
  if (read.value.data.length !== 66) return { block: number, time, totalAssets: unverifiable(`${size.signature} answered more or less than one word`) };
  return { block: number, time, totalAssets: { kind: 'read', value: { kind: 'assets', amount: BigInt(read.value.data) } } };
}

async function recipients(alchemy: AlchemyCall, vault: Address, toBlock: bigint): Promise<Reading<Address[]>> {
  const found = new Set<Address>();
  let pageKey: string | undefined;
  for (let page = 0; page < MAX_TRANSFER_PAGES; page++) {
    const params = {
      fromBlock: '0x0',
      toBlock: hex(toBlock),
      contractAddresses: [vault],
      category: ['erc20'],
      excludeZeroValue: false,
      withMetadata: false,
      order: 'asc',
      maxCount: '0x3e8',
      ...(pageKey === undefined ? {} : { pageKey }),
    };
    let answer: unknown;
    try {
      answer = await alchemy('alchemy_getAssetTransfers', [params]);
    } catch (error) {
      return unverifiable(`the Alchemy Transfers API failed (${(error as Error).message})`);
    }
    if (!isRecord(answer) || !Array.isArray(answer.transfers)) return unverifiable('the Alchemy Transfers API sent no transfer list');
    for (const transfer of answer.transfers as unknown[]) {
      try {
        found.add(parseAddress('to', isRecord(transfer) ? transfer.to : undefined));
      } catch (error) {
        if (error instanceof SafeTxParseError) return unverifiable('the Alchemy Transfers API sent a transfer with no recipient');
        throw error;
      }
    }
    if (typeof answer.pageKey !== 'string') {
      found.delete(ZERO);
      return { kind: 'read', value: [...found] };
    }
    pageKey = answer.pageKey;
  }
  return unverifiable(`the vault has more than ${MAX_TRANSFER_PAGES * 1000} share transfers; holders not counted`);
}

async function balancesOf(reader: Reader, vault: Address, holders: readonly Address[], at: BlockRef): Promise<Reading<bigint[]>> {
  const balances: bigint[] = [];
  for (let i = 0; i < holders.length; i += BALANCES_PER_CALL) {
    const chunk = holders.slice(i, i + BALANCES_PER_CALL);
    const batch = await aggregate(reader, chunk.map((holder) => ({ to: vault, data: encodeCall({ fn: BALANCE_OF, args: [{ kind: 'address', value: holder, span: [0, 0] }], trailer: undefined }) })), at);
    if (batch.kind === 'unverifiable') return unverifiable(batch.reason);
    if (batch.kind === 'no-code') return unverifiable(`Multicall3 has no code at block ${at.number}`);
    if (batch.kind === 'reverted') return unverifiable('a Multicall3 balanceOf batch reverted');
    if (batch.kind === 'malformed') return unverifiable('Multicall3 answered a malformed balanceOf batch');
    for (const balance of batch.data) {
      if (balance.length !== 32) return unverifiable('balanceOf answered more or less than one word');
      balances.push(BigInt(`0x${bytesToHex(balance)}`));
    }
  }
  return { kind: 'read', value: balances };
}

async function holderCount(reader: Reader, alchemy: AlchemyCall, vault: Address, at: BlockRef): Promise<Reading<HolderCount>> {
  const candidates = await recipients(alchemy, vault, at.number);
  if (candidates.kind === 'unverifiable') return candidates;
  const supply = await word(reader, vault, TOTAL_SUPPLY, at, 'totalSupply()');
  if (supply.kind === 'unverifiable') return supply;
  const balances = await balancesOf(reader, vault, candidates.value, at);
  if (balances.kind === 'unverifiable') return balances;
  const held = balances.value.filter((b) => b > 0n).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const sum = held.reduce((total, b) => total + b, 0n);
  if (sum !== supply.value) {
    return unverifiable(`the ${held.length} holders found hold ${sum} of ${supply.value} shares, so the holder list is incomplete`);
  }
  return { kind: 'read', value: { block: at.number, candidates: candidates.value.length, holders: held.length, supply: supply.value, largestBalances: held.slice(0, 10) } };
}

/** The evidence as of block `at`. */
export async function gatherVaultEvidence(
  reader: Reader,
  alchemy: AlchemyCall,
  vault: RegistryEntry,
  size: SizeView,
  at: BlockTag = 'latest',
): Promise<VaultEvidence | { readonly kind: 'unverifiable'; readonly reason: string }> {
  const latest = await reader.block(at);
  if (latest.kind === 'unverifiable') return unverifiable(latest.reason);
  const points: AssetsPoint[] = [];
  for (let month = 0; month <= MONTHS; month++) {
    const number = latest.value.number - BigInt(month) * BLOCKS_PER_MONTH;
    if (number < 0n) break;
    points.push(await pointAt(reader, vault.address, size.fn, number));
  }
  return {
    vault,
    size,
    latest: latest.value,
    asset: size.unit === undefined ? undefined : await assetOf(reader, vault.address, size.unit.fn, latest.value),
    points,
    holders: size.holders ? await holderCount(reader, alchemy, vault.address, latest.value) : undefined,
  };
}

function units(amount: bigint, decimals: number): string {
  const whole = (amount / 10n ** BigInt(decimals)).toLocaleString('en-US');
  if (decimals === 0) return whole;
  return `${whole}.${(amount % 10n ** BigInt(decimals)).toString().padStart(decimals, '0')}`;
}

const percent = (part: bigint, whole: bigint): string => (whole === 0n ? 'n/a' : `${(Number((part * 1_000_000n) / whole) / 10_000).toFixed(2)}%`);

export function formatVaultEvidence(evidence: VaultEvidence, registry: Registry): string {
  const { vault, size, latest, asset, points, holders } = evidence;
  const out = [`vault        ${vault.name} ${checksumAddress(vault.address)}`, `latest block ${latest.number} ${latest.hash}`];
  let decimals: number | undefined;
  let symbol = '';
  if (size.unit !== undefined && asset !== undefined) {
    const label = `${size.unit.fn.signature.padEnd(12)} `;
    const attribute = size.unit.attribute;
    if (asset.kind === 'read') {
      decimals = asset.value.decimals;
      const named = registry.byAddress.get(asset.value.address);
      symbol = named === undefined ? '' : ` ${named.name}`;
      const registered = vault.attributes[attribute] === undefined ? '' : named?.name === vault.attributes[attribute] ? `, the ${attribute} the registry names` : `; the registry names ${vault.attributes[attribute]}`;
      out.push(`${label}${named?.name ?? 'not in the registry'} ${checksumAddress(asset.value.address)}, ${decimals} decimals${registered}`);
    } else {
      out.push(`${label}UNVERIFIABLE ${asset.reason}`);
    }
  }
  out.push('', `${size.fn.signature} every ${BLOCKS_PER_MONTH} blocks (about 30 days), read through both providers:`);
  for (const point of points) {
    const date = point.time.kind === 'read' ? new Date(Number(point.time.value) * 1000).toISOString().slice(0, 10) : 'date unknown';
    const at = `  ${date}  block ${point.block}`;
    const value = point.totalAssets;
    if (value.kind === 'unverifiable') out.push(`${at}  UNVERIFIABLE ${value.reason}`);
    else if (value.value.kind === 'no-code') out.push(`${at}  no code at the vault yet`);
    else if (value.value.kind === 'reverted') out.push(`${at}  ${size.fn.signature} reverted`);
    else out.push(`${at}  ${decimals === undefined ? `${value.value.amount} base units` : `${units(value.value.amount, decimals)}${symbol}`}`);
  }
  if (holders === undefined) return out.join('\n');
  out.push('');
  if (holders.kind === 'unverifiable') {
    out.push(`holders      UNVERIFIABLE ${holders.reason}`);
    return out.join('\n');
  }
  const { holders: count, candidates, supply, largestBalances: top } = holders.value;
  const topSum = top.reduce((total, b) => total + b, 0n);
  out.push(
    `holders      ${count} addresses hold shares at block ${holders.value.block}, of ${candidates} that ever received them (Alchemy Transfers API); their balances, read through both providers, add up to totalSupply() ${supply}`,
    `top 10       hold ${percent(topSum, supply)} of the shares; each: ${top.map((b) => percent(b, supply)).join(', ')}`,
  );
  return out.join('\n');
}

const ADMITTED = 'admitted     ';

const ADMITTED_LINE = new RegExp(`^${ADMITTED}(\\S+) answered (\\S+) = (true|0x[0-9a-fA-F]{40}) at block (\\d+)$`);

/** The stored `admitted` lines, when they are exactly the answers the registry expects of the vault's factory's views, at one block. */
function admission(lines: readonly string[], vault: RegistryEntry, registry: Registry): StoredEvidence['admitted'] {
  const factory = vault.attributes.factory;
  const expected = expectedAnswers(registry, vault.name);
  if (factory === undefined || expected === undefined) return undefined;
  const read = lines.slice(0, expected.length).map((line) => ADMITTED_LINE.exec(line));
  const blocks = new Set(read.map((line) => line?.[4]));
  const matches = read.every((line, i) => line !== null && line[1] === expected[i]?.asker && line[2] === expected[i]?.asked && line[3] === expected[i]?.answered);
  if (!matches || blocks.size !== 1 || ADMITTED_LINE.test(lines[expected.length] ?? '')) return undefined;
  return { factory, answers: expected.map(({ asker, asked, answered }) => ({ asker, check: asked, answer: answered })), block: BigInt([...blocks][0] as string) };
}

/**
 * What stored `pnpm instance-evidence` output says the vault's registry factory answered, from its first line: `admitted`
 * when it admitted the vault, `not-created` when it answered false or another address, `other-answer` when it answered
 * neither. Anything else, such as a read with no answer, an answer from another factory, or no output, is unread.
 */
export function factoryAnswer(text: string | undefined, vault: RegistryEntry, registry: Registry): 'admitted' | 'not-created' | 'other-answer' | 'unread' {
  const factory = vault.attributes.factory;
  if (text === undefined || factory === undefined) return 'unread';
  const first = text.split('\n')[0]!;
  if (admission(text.split('\n'), vault, registry) !== undefined) return 'admitted';
  const refused = /^REFUSED (\S+) answered (.*)$/.exec(first);
  const askers = new Set([factory, ...(expectedAnswers(registry, vault.name) ?? []).map((answer) => answer.asker)]);
  if (refused === null || !askers.has(refused[1] as string)) return 'unread';
  const rest = refused[2] as string;
  if (/^\S+ (false for \S+: (it did not create it|it does not vouch for it)|= 0x[0-9a-fA-F]{40}, not \S+(: its official contract is another)?);/.test(rest)) return 'not-created';
  return /^\S+ with .*, not (true or false|an address);/.test(rest) ? 'other-answer' : 'unread';
}

/**
 * What `pnpm instance-evidence` prints: a vault that names a factory is read only after that factory answers that it
 * created the vault, since the numbers come from the vault's own code. Everything is read as of one block, the latest.
 * `read` is false when nothing was read.
 */
export async function vaultEvidenceText(
  reader: Reader,
  alchemy: AlchemyCall,
  registry: Registry,
  vault: RegistryEntry,
): Promise<{ readonly read: boolean; readonly text: string }> {
  const size = sizeOf(vault, registry);
  if (size === undefined) return { read: false, text: `REFUSED ${vault.name} declares no size, nor does a factory it names; nothing to read` };
  const block = await reader.block('latest');
  if (block.kind === 'unverifiable') return { read: false, text: `UNVERIFIABLE ${block.reason}` };
  const lines: string[] = [];
  if (vault.attributes.factory === undefined) {
    lines.push(`NOTE ${vault.name} names no factory, so no factory vouches for the code these numbers come from`);
  } else {
    const proof = await proveInstance(reader, registry, vault.name, block.value);
    if (proof.kind === 'unasked') return { read: false, text: `REFUSED ${proof.why}; the vault's code is not read` };
    const refused = proof.answers.find((answer) => answer.kind === 'refused');
    if (!admitted(proof) && refused?.kind === 'refused') return { read: false, text: `REFUSED ${refused.why}; the vault's code is not read` };
    for (const answer of proof.answers) if (answer.kind === 'vouched') lines.push(`${ADMITTED}${answer.asker?.name} answered ${answer.asked} = ${answer.answered} at block ${block.value.number}`);
  }
  const evidence = await gatherVaultEvidence(reader, alchemy, vault, size, block.value.number);
  if ('kind' in evidence) return { read: false, text: [...lines, `UNVERIFIABLE ${evidence.reason}`].join('\n') };
  return { read: true, text: [...lines, formatVaultEvidence(evidence, registry)].join('\n') };
}

/** One monthly reading as stored: `amount` in base units, with `decimals` when `asset()` was read. */
export type StoredPoint = {
  readonly date: string | undefined;
  readonly block: bigint;
  readonly assets: { readonly kind: 'amount'; readonly amount: bigint } | { readonly kind: 'unread' } | { readonly kind: 'no-code' } | { readonly kind: 'reverted' };
};

/** Stored `pnpm instance-evidence` output read back into its facts; a fact its text does not hold is undefined. */
export type StoredEvidence = {
  /** Each view's answer in order, `answer` being `true` or the expected checksum address. */
  readonly admitted: { readonly factory: string; readonly answers: readonly { readonly asker: string; readonly check: string; readonly answer: string }[]; readonly block: bigint } | undefined;
  /** `name` is undefined for an asset outside the registry. */
  readonly asset: { readonly name: string | undefined; readonly decimals: number } | undefined;
  /** Oldest first. */
  readonly points: readonly StoredPoint[];
  readonly holders: { readonly holders: number; readonly candidates: number; readonly largest: string | undefined; readonly top10: string } | undefined;
};

function storedAmount(text: string, decimals: number | undefined): bigint | undefined {
  const units = /^(\d+) base units$/.exec(text);
  if (units !== null) return BigInt(units[1] as string);
  const whole = /^([\d,]+)(?:\.(\d+))?(?: \S+)?$/.exec(text);
  if (whole === null || decimals === undefined) return undefined;
  const [, integer = '', fraction = ''] = whole;
  if (fraction.length !== decimals) return undefined;
  return BigInt(integer.replace(/,/g, '')) * 10n ** BigInt(decimals) + (fraction === '' ? 0n : BigInt(fraction));
}

/** What `vaultEvidenceText` printed for `vault`: its factory's admission on the first line, then `formatVaultEvidence`'s. */
export function readStoredEvidence(text: string, vault: RegistryEntry, registry: Registry): StoredEvidence {
  const lines = text.split('\n');
  const size = sizeOf(vault, registry);
  const unit = size?.unit === undefined ? undefined : `${size.unit.fn.signature.padEnd(12)} `;
  const asset = unit === undefined ? null : /^(.+?) 0x[0-9a-fA-F]{40}, (\d+) decimals/.exec(lines.find((l) => l.startsWith(unit))?.slice(unit.length) ?? '');
  const decimals = asset === null ? undefined : Number(asset[2]);
  const points = lines.flatMap((line): StoredPoint[] => {
    const point = /^ {2}(\d{4}-\d{2}-\d{2}|date unknown) {2}block (\d+) {2}(.+)$/.exec(line);
    if (point === null) return [];
    const [, date, block, value = ''] = point;
    const amount = storedAmount(value, decimals);
    const assets: StoredPoint['assets'] =
      amount !== undefined ? { kind: 'amount', amount } : value === 'no code at the vault yet' ? { kind: 'no-code' } : value === `${size?.fn.signature} reverted` ? { kind: 'reverted' } : { kind: 'unread' };
    return [{ date: date === 'date unknown' ? undefined : date, block: BigInt(block as string), assets }];
  });
  const holders = /^holders {6}(\d+) addresses hold shares at block \d+, of (\d+) that ever received them/.exec(lines.find((l) => l.startsWith('holders')) ?? '');
  const top = /^top 10 {7}hold (\S+) of the shares; each: (.*)$/.exec(lines.find((l) => l.startsWith('top 10')) ?? '');
  return {
    admitted: admission(lines, vault, registry),
    asset: asset === null ? undefined : { name: asset[1] === 'not in the registry' ? undefined : asset[1], decimals: decimals as number },
    points: [...points].reverse(),
    holders:
      holders === null || top === null
        ? undefined
        : { holders: Number(holders[1]), candidates: Number(holders[2]), largest: (top[2] as string).split(', ')[0] || undefined, top10: top[1] as string },
  };
}
