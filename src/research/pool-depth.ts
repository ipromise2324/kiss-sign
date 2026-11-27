import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { parseViewSignature } from '../decode/abi.ts';
import type { AbiValue } from '../decode/codec.ts';
import { decodeValues, encodeCall } from '../decode/codec.ts';
import { FLOOR_RULE, POOL_VIEWS, observeArgs, poolMean } from '../price/reference.ts';
import type { ViewFunction } from '../price/reference.ts';
import { sqrtRatioAtTick } from '../price/tick.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { Reading } from './instance-evidence.ts';
import { inPool } from './pool.ts';
import { settledBlock } from './settled.ts';

/** The floor's windows, longest first: 30 minutes for a pair that shares a peg, 5 otherwise. */
export const WINDOWS = [FLOOR_RULE.windowSeconds.pegged, FLOOR_RULE.windowSeconds.other] as const;
export type Window = (typeof WINDOWS)[number];
export const SAMPLE_EVERY = 7200n;
export const SAMPLES = 365;
const READ_WIDTH = 8;
/** The band the depth line prices: 100 ticks is a move of about 1%. */
const BAND_TICKS = 100n;

const VIEWS = {
  token0: parseViewSignature('token0() returns (address token0)'),
  token1: parseViewSignature('token1() returns (address token1)'),
  decimals: parseViewSignature('decimals() returns (uint8 decimals)'),
} as const;

export type WindowDepth =
  | { readonly window: bigint; readonly kind: 'read'; readonly liquidity: bigint; readonly tick: bigint; readonly sqrt: bigint }
  | { readonly window: bigint; readonly kind: 'no-mean' | 'no-code' | 'malformed' }
  | { readonly window: bigint; readonly kind: 'unverifiable'; readonly reason: string };

export type DepthPoint = {
  readonly block: bigint;
  readonly time: Reading<bigint>;
  readonly depth: Reading<readonly WindowDepth[]>;
};

export type Blocks = { readonly kind: 'given'; readonly calm: bigint; readonly stressed: bigint } | { readonly kind: 'auto' };

/** What to read: the blocks, the windows (both, or the one `--window` names, which `--auto` ranks by), and the `minLiquidity` to count against. */
export type DepthRequest = { readonly blocks: Blocks; readonly windows: readonly Window[]; readonly min: bigint | undefined };

type Token = { readonly address: Address; readonly decimals: number };
type Pool = { readonly address: Address; readonly token0: Token; readonly token1: Token };
type Answer = Reading<readonly AbiValue[] | 'reverted' | 'no-code' | 'malformed'>;

const unverifiable = (reason: string) => ({ kind: 'unverifiable', reason }) as const;

/** A view's decoded answer; an empty one is `no-code` only when the address has no code at that block, else `malformed`, as is any other answer that is not the view's. */
async function view(reader: Reader, to: Address, { fn, returns }: ViewFunction, args: readonly AbiValue[], at: BlockRef): Promise<Answer> {
  const read = await reader.call({ to, data: `0x${bytesToHex(encodeCall({ fn, args, trailer: undefined }))}` as Hex }, at);
  if (read.kind === 'unverifiable') return unverifiable(read.reason);
  if (read.value.kind === 'reverted') return { kind: 'read', value: 'reverted' };
  if (read.value.data.length === 2) {
    const code = await reader.getCode(to, at);
    if (code.kind === 'unverifiable') return unverifiable(code.reason);
    return { kind: 'read', value: code.value.length === 2 ? 'no-code' : 'malformed' };
  }
  const values = decodeValues(
    returns.map((param) => param.type),
    hexToBytes(read.value.data.slice(2)),
  );
  return { kind: 'read', value: values ?? 'malformed' };
}

/** What `card new` reads of the pool for a window, through the same `observe` call and `poolMean`. */
async function windowAt(reader: Reader, pool: Address, window: bigint, at: BlockRef): Promise<WindowDepth> {
  const answer = await view(reader, pool, POOL_VIEWS.observe, observeArgs(window), at);
  if (answer.kind === 'unverifiable') return { window, ...answer };
  if (answer.value === 'no-code' || answer.value === 'malformed') return { window, kind: answer.value };
  const mean = answer.value === 'reverted' ? undefined : poolMean(answer.value, window);
  return mean === undefined ? { window, kind: 'no-mean' } : { window, kind: 'read', ...mean };
}

async function pointAt(reader: Reader, pool: Address, number: bigint, windows: readonly Window[]): Promise<DepthPoint> {
  const block = await reader.block(number);
  if (block.kind === 'unverifiable') return { block: number, time: unverifiable(block.reason), depth: unverifiable(block.reason) };
  const header = await reader.header(block.value);
  const time: Reading<bigint> = header.kind === 'agreed' ? { kind: 'read', value: header.value.time } : unverifiable(header.reason);
  const depths: WindowDepth[] = [];
  for (const window of windows) depths.push(await windowAt(reader, pool, window, block.value));
  return { block: number, time, depth: { kind: 'read', value: depths } };
}

async function tokenAt(reader: Reader, pool: Address, side: 'token0' | 'token1', at: BlockRef): Promise<Reading<Token>> {
  const answer = await view(reader, pool, VIEWS[side], [], at);
  if (answer.kind === 'unverifiable') return answer;
  if (typeof answer.value === 'string') return unverifiable(`${side}() answered ${answer.value === 'no-code' ? 'nothing, as the address has no code' : answer.value === 'reverted' ? 'a revert' : 'no address'}, as no Uniswap v3 pool does`);
  const address = (answer.value[0] as Extract<AbiValue, { kind: 'address' }>).value;
  const decimals = await view(reader, address, VIEWS.decimals, [], at);
  if (decimals.kind === 'unverifiable') return decimals;
  if (typeof decimals.value === 'string') return unverifiable(`decimals() of ${side} answered no number`);
  return { kind: 'read', value: { address, decimals: Number((decimals.value[0] as Extract<AbiValue, { kind: 'uint' | 'int' }>).value) } };
}

const over = (point: DepthPoint, window: bigint): WindowDepth | undefined => (point.depth.kind === 'read' ? point.depth.value.find((depth) => depth.window === window) : undefined);
const measured = (point: DepthPoint, window: bigint): Extract<WindowDepth, { kind: 'read' }> | undefined => {
  const depth = over(point, window);
  return depth?.kind === 'read' ? depth : undefined;
};

/** Of samples oldest first, by `window`: calm, the one of median liquidity; stressed, the one whose mean tick moved most from the readable sample before; and the thinnest. */
function pickBlocks(samples: readonly DepthPoint[], window: bigint): { readonly calm: DepthPoint; readonly stressed: DepthPoint; readonly lowest: DepthPoint } | undefined {
  const read = samples.filter((point) => measured(point, window) !== undefined);
  if (read.length < 2) return undefined;
  const liquidity = (point: DepthPoint) => measured(point, window)!.liquidity;
  const byLiquidity = [...read].sort((a, b) => (liquidity(a) < liquidity(b) ? -1 : liquidity(a) > liquidity(b) ? 1 : 0));
  const move = (i: number) => {
    const change = measured(read[i]!, window)!.tick - measured(read[i - 1]!, window)!.tick;
    return change < 0n ? -change : change;
  };
  let stressed = 1;
  for (let i = 2; i < read.length; i++) if (move(i) > move(stressed)) stressed = i;
  return { calm: byLiquidity[Math.floor((byLiquidity.length - 1) / 2)]!, stressed: read[stressed]!, lowest: byLiquidity[0]! };
}

/** Whole tokens with two decimals, cut down. */
function units(amount: bigint, decimals: number): string {
  const cents = decimals < 2 ? amount * 10n ** BigInt(2 - decimals) : amount / 10n ** BigInt(decimals - 2);
  return `${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function priceLines(depth: Extract<WindowDepth, { kind: 'read' }>, pool: Pool, names: (token: Token) => string): string[] {
  const [up, down] = [depth.tick + BAND_TICKS, depth.tick - BAND_TICKS].map(sqrtRatioAtTick);
  if (up === undefined || down === undefined) return [];
  const at = depth.sqrt;
  const price = (Number(at) / 2 ** 96) ** 2 * 10 ** (pool.token0.decimals - pool.token1.decimals);
  const buys1 = (depth.liquidity * (up - at)) >> 96n;
  const buys0 = ((depth.liquidity * (at - down)) << 96n) / (at * down);
  return [`  ${depth.window / 60n}-minute mean price ${price.toPrecision(6)} ${names(pool.token1)} per ${names(pool.token0)}; at this liquidity ${units(buys1, pool.token1.decimals)} ${names(pool.token1)} moves it up ${BAND_TICKS} ticks (1.005%), ${units(buys0, pool.token0.decimals)} ${names(pool.token0)} down`];
}

const dateOf = (time: Reading<bigint>): string => (time.kind === 'read' ? new Date(Number(time.value) * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'date unknown');

function pointLines(label: string, point: DepthPoint, min: bigint | undefined, pool: Pool, names: (token: Token) => string): string[] {
  const at = `${label.padEnd(9)} ${dateOf(point.time)}  block ${point.block}`;
  if (point.depth.kind === 'unverifiable') return [`${at}  UNVERIFIABLE ${point.depth.reason}`];
  const depths = point.depth.value;
  const windows = depths.map((depth) => {
    const minutes = `${depth.window / 60n} min`;
    switch (depth.kind) {
      case 'read':
        return `${minutes} ${depth.liquidity}${min !== undefined && depth.liquidity < min ? ' (under minLiquidity)' : ''}`;
      case 'no-mean':
        return `${minutes} no mean price (observe reverted)`;
      case 'no-code':
        return `${minutes} no code at the pool yet`;
      case 'malformed':
        return `${minutes} UNVERIFIABLE observe answered no (int56[], uint160[])`;
      case 'unverifiable':
        return `${minutes} UNVERIFIABLE ${depth.reason}`;
    }
  });
  return [`${at}  ${windows.join('  ')}`, ...depths.flatMap((depth) => (depth.kind === 'read' ? priceLines(depth, pool, names) : []))];
}

const hasMeasure = (point: DepthPoint): boolean => point.depth.kind === 'read' && point.depth.value.some((depth) => depth.kind === 'read');

/**
 * What `pnpm pool-depth` prints: the pool's harmonic mean liquidity over each of the floor's windows, read as `card new`
 * reads it, at a calm and a stressed block, given or picked from a daily sample of the last year. It reads the pool
 * whether or not it runs pinned code, as research before its entry and pin exist. `read` is false when the calm or the
 * stressed block gave no measure.
 */
export async function poolDepthText(reader: Reader, registry: Registry, address: Address, { blocks, windows, min }: DepthRequest): Promise<{ readonly read: boolean; readonly text: string }> {
  const latest = await settledBlock(reader);
  if (latest.kind === 'unverifiable') return { read: false, text: `UNVERIFIABLE ${latest.reason}` };
  const [token0, token1] = [await tokenAt(reader, address, 'token0', latest.value), await tokenAt(reader, address, 'token1', latest.value)];
  if (token0.kind === 'unverifiable') return { read: false, text: `REFUSED ${checksumAddress(address)}: ${token0.reason}` };
  if (token1.kind === 'unverifiable') return { read: false, text: `REFUSED ${checksumAddress(address)}: ${token1.reason}` };
  const pool: Pool = { address, token0: token0.value, token1: token1.value };
  const names = (token: Token) => registry.byAddress.get(token.address)?.name ?? checksumAddress(token.address);
  const entry = registry.byAddress.get(address);
  const registered = entry?.twap?.minLiquidity;
  const out = [
    `pool         ${entry?.name ?? 'not in the registry'} ${checksumAddress(address)}`,
    ...[pool.token0, pool.token1].map((token, i) => `token${i}       ${registry.byAddress.get(token.address)?.name ?? 'not in the registry'} ${checksumAddress(token.address)}, ${token.decimals} decimals`),
    ...(min === undefined ? [] : [`minLiquidity ${min}, ${min === registered ? "the registry's" : registered === undefined ? 'as given' : `as given; the registry's is ${registered}`}`]),
    `latest block ${latest.value.number} ${latest.value.hash}`,
    '',
    'Harmonic mean liquidity, observe([window, 0]) read as card new reads it for twap.minLiquidity, through both providers:',
  ];
  if (blocks.kind === 'given') {
    const points = { calm: await pointAt(reader, address, blocks.calm, windows), stressed: await pointAt(reader, address, blocks.stressed, windows) };
    const missing = (['calm', 'stressed'] as const).filter((label) => !hasMeasure(points[label]));
    out.push(...pointLines('calm', points.calm, min, pool, names), ...pointLines('stressed', points.stressed, min, pool, names));
    if (missing.length > 0) out.push('', `INCOMPLETE the ${missing.join(' and the ')} block gave no measure over any window, so the pair cannot set minLiquidity`);
    return { read: missing.length === 0, text: out.join('\n') };
  }
  const numbers = Array.from({ length: SAMPLES + 1 }, (_, i) => latest.value.number - BigInt(SAMPLES - i) * SAMPLE_EVERY).filter((number) => number >= 0n);
  const samples = await inPool(numbers, READ_WIDTH, (number) => pointAt(reader, address, number, windows));
  const window = windows[0]!;
  const minutes = `${window / 60n} minutes`;
  const picked = pickBlocks(samples, window);
  if (picked !== undefined) out.push(...(['calm', 'stressed', 'lowest'] as const).flatMap((label) => pointLines(label, picked[label], min, pool, names)));
  else out.push(`no calm or stressed block: fewer than two samples gave a mean price over ${minutes}`);
  out.push('', `sampled      ${samples.length} blocks ${SAMPLE_EVERY} apart (about a day), from ${dateOf(samples[0]!.time)} (block ${numbers[0]}) to ${dateOf(samples.at(-1)!.time)} (block ${numbers.at(-1)})`);
  for (const each of windows) {
    const kinds = samples.map((point) => over(point, each)?.kind ?? 'unverifiable');
    const count = (kind: WindowDepth['kind']) => kinds.filter((k) => k === kind).length;
    const under = min === undefined ? '' : `, ${samples.filter((point) => (measured(point, each)?.liquidity ?? min) < min).length} of them under minLiquidity`;
    out.push(
      `  over ${each / 60n} min ${count('read')} read${under}; ${count('no-code')} before the pool had code, ${count('no-mean')} with no mean price, ${count('malformed') + count('unverifiable')} UNVERIFIABLE`,
    );
  }
  out.push(`calm is the sample of median liquidity over ${minutes}, stressed the one whose mean price over ${minutes} moved most from the readable sample before it, lowest the thinnest`);
  return { read: picked !== undefined, text: out.join('\n') };
}
