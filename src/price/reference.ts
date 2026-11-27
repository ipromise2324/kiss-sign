import type { AbiFunction, AbiParam } from '../decode/abi.ts';
import { parseViewSignature } from '../decode/abi.ts';
import type { AbiValue } from '../decode/codec.ts';
import type { Feed, Registry, RegistryEntry } from '../registry.ts';
import { feedChain, twapPools } from '../registry.ts';
import type { TwapPool } from '../registry.ts';
import { callRules, cardRefs } from '../template/template.ts';
import type { CardRef, Template } from '../template/template.ts';
import { visible } from '../verify/checklist.ts';
import { harmonicLiquidity, meanTick, sqrtRatioAtTick } from './tick.ts';

/**
 * The rule of a swap's floor, the same for every pair and protocol. No template or registry entry changes these numbers,
 * but the rule trusts the registry's facts, which load cannot check against their sources.
 */
export const FLOOR_RULE = {
  /** The slippage an empty answer takes and the most the signer may type, for a pair that shares a peg. */
  slippageBps: 50,
  maxSlippageBps: 100,
  /** Room for the feeds' own error and a fee inside the app's minimum, on top of the typed slippage. */
  marginBps: 25,
  /** The most the two sources may differ. For a pegged pair, below the margin by more than the 7.7 bps measured over the slippage. */
  agreeBps: { pegged: 15, other: 150 },
  /** How far a pegged token's feed price may be from its peg. */
  bandBps: 100,
  /** A feed is late once its answer is older than its heartbeat by this many seconds. */
  graceSeconds: 3600n,
  /** The most the feeds of a pegged pair may be off together before a floor is no longer computed from them. */
  maxDeviationBps: 50,
  /** A typed minimum this far below the price must be typed again. */
  retypeBps: 250,
  windowSeconds: { pegged: 1800n, other: 300n },
  maxPoolHops: 2,
} as const;

/** Buy-token base units per base unit of the sell token, before any rounding. */
export type Ratio = { readonly num: bigint; readonly den: bigint };

export const valueOf = (amount: bigint, { num, den }: Ratio): bigint => (amount * num) / den;
export const floorOf = (amount: bigint, { num, den }: Ratio, bps: number): bigint => (amount * num * BigInt(10_000 - bps)) / (den * 10_000n);
export const moreThan = (a: Ratio, b: Ratio): boolean => a.num * b.den > b.num * a.den;
const times = (a: Ratio, b: Ratio): Ratio => ({ num: a.num * b.num, den: a.den * b.den });
const inverse = ({ num, den }: Ratio): Ratio => ({ num: den, den: num });
const ONE: Ratio = { num: 1n, den: 1n };

/** How far `a` is from `b` in hundredths of a basis point, rounded up so a gap just over a limit reads over it. */
function gap(a: Ratio, b: Ratio): bigint {
  const [x, y] = [a.num * b.den, b.num * a.den];
  const difference = x > y ? x - y : y - x;
  return (difference * 1_000_000n + y - 1n) / y;
}

export type FeedEntry = RegistryEntry & { readonly feed: Feed };
type Route = readonly TwapPool[];

/** Why the pair has one price source: no pool, feeds that read decentralized exchanges too, or a pool the template itself names. */
export type Alone = 'no-pool' | 'shared-upstream' | 'own-pool';

/** What the registry alone says of a pair. `pegged` decides whether the floor is computed or the typed one is checked. */
export type PairFacts =
  | { readonly kind: 'no-feed'; readonly tokens: readonly RegistryEntry[] }
  | {
      readonly kind: 'feeds';
      readonly sell: readonly FeedEntry[];
      readonly buy: readonly FeedEntry[];
      readonly pegged: { readonly sell: readonly FeedEntry[]; readonly buy: readonly FeedEntry[] } | undefined;
      readonly routes: readonly Route[];
      readonly alone: Alone | undefined;
    };

/** The feeds a peg counts: those before the feed that prices the peg itself, or all of them for a peg to the dollar. */
function peggedLegs(chain: readonly FeedEntry[], peg: string): readonly FeedEntry[] {
  const at = chain.findIndex((feed) => feed.name === peg);
  return at === -1 ? chain : chain.slice(0, at);
}

/** Every route of the fewest pools, at most `maxPoolHops`, from `sell` to `buy`, so no one pool's place in the registry decides. */
function routesOf(sell: RegistryEntry, buy: RegistryEntry, pools: readonly TwapPool[]): readonly Route[] {
  const other = (pool: TwapPool, token: RegistryEntry): RegistryEntry => (pool.token0 === token ? pool.token1 : pool.token0);
  const touching = (token: RegistryEntry): TwapPool[] => pools.filter((pool) => pool.token0 === token || pool.token1 === token);
  let paths: { readonly at: RegistryEntry; readonly route: Route }[] = [{ at: sell, route: [] }];
  for (let hops = 0; hops < FLOOR_RULE.maxPoolHops; hops++) {
    paths = paths.flatMap(({ at, route }) => touching(at).filter((pool) => !route.includes(pool)).map((pool) => ({ at: other(pool, at), route: [...route, pool] })));
    const found = paths.filter(({ at }) => at === buy);
    if (found.length > 0) return found.map(({ route }) => route);
  }
  return [];
}

/**
 * The entries a swap may trade through, so no pool among them is an independent price: each contract the template's calls
 * name and each entry a card reference names, as `picked` reads it: the signer's pick in `card new`, and in a report
 * every entry the reference can name that the pair does not settle.
 */
export function tradedThrough(template: Template, picked: (ref: CardRef) => readonly string[]): ReadonlySet<string> {
  const ruled = callRules(template).flatMap((rule) => (rule.kind === 'contract' ? [rule.name] : []));
  return new Set([...ruled, ...cardRefs(template).flatMap(picked)]);
}

export function pairFacts(sell: RegistryEntry, buy: RegistryEntry, registry: Registry, tradedThrough: ReadonlySet<string>): PairFacts {
  const without = [sell, buy].filter((token) => token.price === undefined);
  if (sell.price === undefined || buy.price === undefined) return { kind: 'no-feed', tokens: without };
  const chains = { sell: feedChain(sell.price.feed, registry) as readonly FeedEntry[], buy: feedChain(buy.price.feed, registry) as readonly FeedEntry[] };
  const own = [...chains.sell.filter((feed) => !chains.buy.includes(feed)), ...chains.buy.filter((feed) => !chains.sell.includes(feed))];
  const peg = sell.price.peg !== undefined && sell.price.peg === buy.price.peg ? sell.price.peg : undefined;
  const deviation = own.reduce((sum, { feed }) => sum + feed.deviationBps, 0);
  const pegged = peg === undefined || own.length === 0 || deviation > FLOOR_RULE.maxDeviationBps ? undefined : { sell: peggedLegs(chains.sell, peg), buy: peggedLegs(chains.buy, peg) };
  const pools = twapPools(registry);
  const all = routesOf(sell, buy, pools);
  const routes = routesOf(sell, buy, pools.filter(({ entry }) => !tradedThrough.has(entry.name)));
  const alone: Alone | undefined = all.length === 0 ? 'no-pool' : own.some(({ feed }) => feed.sourceClass !== 'cex_price') ? 'shared-upstream' : routes.length === 0 ? 'own-pool' : undefined;
  return { kind: 'feeds', ...chains, pegged, routes: alone === undefined ? routes : [], alone };
}

export type ViewFunction = { readonly fn: AbiFunction; readonly returns: readonly AbiParam[] };

export const FEED_VIEWS = {
  latestRoundData: parseViewSignature('latestRoundData() returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'),
  decimals: parseViewSignature('decimals() returns (uint8 decimals)'),
  description: parseViewSignature('description() returns (string description)'),
} as const;

export const POOL_VIEWS = {
  observe: parseViewSignature('observe(uint32[] secondsAgos) returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'),
} as const;

/**
 * How a reference is read: every answer through both providers at one block, from a contract that runs its pinned code.
 * Each of these throws, refusing the card, on anything else, so a failed read never becomes a price or its absence.
 */
export type PriceReads = {
  /** The block's time. */
  readonly time: () => Promise<bigint>;
  readonly decimals: (token: RegistryEntry) => Promise<number>;
  readonly view: (on: RegistryEntry, view: ViewFunction, args: readonly AbiValue[]) => Promise<readonly AbiValue[]>;
  /** As `view`, but a revert both providers agree on is an answer. */
  readonly viewOrRevert: (on: RegistryEntry, view: ViewFunction, args: readonly AbiValue[]) => Promise<readonly AbiValue[] | 'reverted'>;
};

export type FeedRead = { readonly entry: FeedEntry; readonly answer: bigint; readonly age: bigint; readonly limit: bigint };
export type PoolRead = { readonly entry: RegistryEntry; readonly liquidity: bigint };

export type Doubt =
  | { readonly kind: 'stale'; readonly read: FeedRead }
  | { readonly kind: 'off-peg'; readonly side: 'sell' | 'buy'; readonly price: Ratio }
  | { readonly kind: 'sources-differ'; readonly gap: bigint; readonly limitBps: number }
  | { readonly kind: 'pool-unusable'; readonly pool: RegistryEntry; readonly why: 'thin' | 'reverted'; readonly window: bigint; readonly liquidity: bigint };

/** The price of one pair at one block. `strict` is the highest of the sources, never their average. */
export type Reference = {
  readonly feeds: readonly FeedRead[];
  readonly chain: Ratio;
  readonly pools: readonly PoolRead[];
  readonly twaps: readonly Ratio[];
  readonly window: bigint;
  readonly strict: Ratio;
  readonly doubts: readonly Doubt[];
};

/** A feed that cannot be what the registry says it is, or that answers no price. */
export class FeedError extends Error {
  readonly entry: RegistryEntry;
  readonly why: 'description' | 'decimals' | 'no-price' | 'no-time';
  readonly answered: string;

  constructor(entry: RegistryEntry, why: FeedError['why'], answered: string) {
    super(`${entry.name}: ${why} ${answered}`);
    this.entry = entry;
    this.why = why;
    this.answered = answered;
  }
}

type Uint = Extract<AbiValue, { kind: 'uint' | 'int' }>;
const numberAt = (values: readonly AbiValue[], i: number): bigint => (values[i] as Uint).value;
const numbersAt = (values: readonly AbiValue[], i: number): bigint[] => (values[i] as Extract<AbiValue, { kind: 'array' }>).items.map((item) => (item as Uint).value);

async function readFeed(entry: FeedEntry, reads: PriceReads): Promise<FeedRead> {
  const [description] = await reads.view(entry, FEED_VIEWS.description, []);
  const said = new TextDecoder().decode((description as Extract<AbiValue, { kind: 'bytes' | 'string' }>).value);
  if (said !== entry.feed.description) throw new FeedError(entry, 'description', JSON.stringify(visible(said.slice(0, 80))));
  const decimals = numberAt(await reads.view(entry, FEED_VIEWS.decimals, []), 0);
  if (decimals !== BigInt(entry.feed.decimals)) throw new FeedError(entry, 'decimals', `${decimals}`);
  const round = await reads.view(entry, FEED_VIEWS.latestRoundData, []);
  const [answer, updatedAt, time] = [numberAt(round, 1), numberAt(round, 3), await reads.time()];
  if (answer <= 0n) throw new FeedError(entry, 'no-price', `${answer}`);
  if (updatedAt === 0n || updatedAt > time) throw new FeedError(entry, 'no-time', `${updatedAt}`);
  return { entry, answer, age: time - updatedAt, limit: BigInt(entry.feed.heartbeat) + FLOOR_RULE.graceSeconds };
}

type PoolAnswer = { readonly kind: 'read'; readonly ratio: Ratio; readonly read: PoolRead } | { readonly kind: 'doubt'; readonly doubt: Doubt };

/** The arguments of `observe` for a pool's mean over the last `window` seconds. */
export function observeArgs(window: bigint): readonly AbiValue[] {
  const span: AbiValue['span'] = [0, 0];
  const ago = (seconds: bigint): AbiValue => ({ kind: 'uint', value: seconds, span });
  return [{ kind: 'array', items: [ago(window), ago(0n)], span }];
}

/** A pool's mean over `window` from its decoded `observe(observeArgs(window))` answer, or none when the answer holds no mean or its mean tick no price. */
export function poolMean(answer: readonly AbiValue[], window: bigint): { readonly liquidity: bigint; readonly tick: bigint; readonly sqrt: bigint } | undefined {
  const [ticks, seconds] = [numbersAt(answer, 0), numbersAt(answer, 1)];
  if (ticks.length !== 2 || seconds.length !== 2) return undefined;
  const tick = meanTick((ticks[1] as bigint) - (ticks[0] as bigint), window);
  const sqrt = sqrtRatioAtTick(tick);
  return sqrt === undefined ? undefined : { liquidity: harmonicLiquidity(seconds[0] as bigint, seconds[1] as bigint, window), tick, sqrt };
}

async function readPool(pool: TwapPool, from: RegistryEntry, window: bigint, reads: PriceReads): Promise<PoolAnswer> {
  const unusable = (why: 'thin' | 'reverted', liquidity = 0n): PoolAnswer => ({ kind: 'doubt', doubt: { kind: 'pool-unusable', pool: pool.entry, why, window, liquidity } });
  const answer = await reads.viewOrRevert(pool.entry, POOL_VIEWS.observe, observeArgs(window));
  if (answer === 'reverted') return unusable('reverted');
  const mean = poolMean(answer, window);
  if (mean === undefined) return unusable('reverted');
  const { liquidity, sqrt } = mean;
  if (liquidity < pool.minLiquidity) return unusable('thin', liquidity);
  const token1PerToken0: Ratio = { num: sqrt * sqrt, den: 1n << 192n };
  return { kind: 'read', ratio: from === pool.token0 ? token1PerToken0 : inverse(token1PerToken0), read: { entry: pool.entry, liquidity } };
}

function outsideBand({ num, den }: Ratio): boolean {
  const band = BigInt(FLOOR_RULE.bandBps);
  return num * 10_000n < den * (10_000n - band) || num * 10_000n > den * (10_000n + band);
}

/** Reads the pair's price from its feeds and, where the registry gives an independent one, from its pools. */
export async function readReference(facts: Extract<PairFacts, { kind: 'feeds' }>, sell: RegistryEntry, buy: RegistryEntry, reads: PriceReads): Promise<Reference> {
  const read = new Map<FeedEntry, FeedRead>();
  for (const entry of new Set([...facts.sell, ...facts.buy])) read.set(entry, await readFeed(entry, reads));
  const product = (chain: readonly FeedEntry[]): Ratio =>
    chain.reduce((ratio, entry) => times(ratio, { num: (read.get(entry) as FeedRead).answer, den: 10n ** BigInt(entry.feed.decimals) }), ONE);
  const units: Ratio = { num: 10n ** BigInt(await reads.decimals(buy)), den: 10n ** BigInt(await reads.decimals(sell)) };
  const chain = times(times(product(facts.sell), inverse(product(facts.buy))), units);
  const doubts: Doubt[] = [...read.values()].flatMap((feed) => (feed.age > feed.limit ? [{ kind: 'stale' as const, read: feed }] : []));
  for (const side of ['sell', 'buy'] as const) {
    const price = facts.pegged === undefined ? undefined : product(facts.pegged[side]);
    if (price !== undefined && outsideBand(price)) doubts.push({ kind: 'off-peg', side, price });
  }
  const pairClass = facts.pegged === undefined ? 'other' : 'pegged';
  const window = FLOOR_RULE.windowSeconds[pairClass];
  const limitBps = FLOOR_RULE.agreeBps[pairClass];
  const pools: PoolRead[] = [];
  const twaps: Ratio[] = [];
  for (const route of facts.routes) {
    let at = sell;
    let ratio: Ratio | undefined = ONE;
    for (const pool of route) {
      const answer = await readPool(pool, at, window, reads);
      if (answer.kind === 'doubt') doubts.push(answer.doubt);
      else pools.push(answer.read);
      ratio = ratio === undefined || answer.kind === 'doubt' ? undefined : times(ratio, answer.ratio);
      at = pool.token0 === at ? pool.token1 : pool.token0;
    }
    if (ratio === undefined) continue;
    twaps.push(ratio);
    const apart = gap(ratio, chain);
    if (apart > BigInt(limitBps) * 100n) doubts.push({ kind: 'sources-differ', gap: apart, limitBps });
  }
  const strict = twaps.reduce((highest, ratio) => (moreThan(ratio, highest) ? ratio : highest), chain);
  return { feeds: [...read.values()], chain, pools, twaps, window, strict, doubts };
}
