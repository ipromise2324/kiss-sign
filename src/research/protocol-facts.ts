import { resolveRef } from '../card.ts';
import type { ResolvedValue } from '../card.ts';
import { readDecimals } from '../chain/decimals.ts';
import type { Reader } from '../chain/reader.ts';
import { replayReader } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import type { BlockRef } from '../chain/types.ts';
import type { Market, Registry, RegistryEntry } from '../registry.ts';
import type { Address, Hex } from '../safe/types.ts';
import { bindView, numbersOf } from '../simulate/effects.ts';
import { callTargetEntries, calledProtocols, protocolOf, scopeEntries } from '../template/template.ts';
import type { Fact, Template, TokenRef } from '../template/template.ts';
import { DEFILLAMA_PROTOCOLS, ListingError } from './listings.ts';

/** A read that got an answer, or why it did not, such as two providers that disagree. */
export type Reading<T> = { readonly kind: 'read'; readonly value: T } | { readonly kind: 'unread'; readonly why: string };

/** One entry of DefiLlama's hacks list: its date (`YYYY-MM-DD`, UTC) and amount in USD. Nothing else of it is kept. */
export type Hack = { readonly date: string; readonly amount: number | undefined };

/** A protocol's entry in DefiLlama's protocol list, cut to what the report prints and the hacks are matched by. */
export type Listing = {
  readonly id: string;
  readonly parent: string | undefined;
  readonly listedFrom: string | undefined;
  readonly tvl: number | undefined;
  readonly ethereumTvl: number | undefined;
};

export type Proxy = 'proxy' | 'not a proxy' | 'not pinned';

export type ProtocolSheet = {
  readonly slug: string;
  readonly listing: Reading<Listing>;
  /** Oldest first; empty when the listing was not read. */
  readonly hacks: readonly Hack[];
  /** The contracts of this protocol a call targets, with whether each is a proxy, from its code pin. */
  readonly contracts: readonly { readonly entry: RegistryEntry; readonly proxy: Proxy }[];
};

/** A value a fact's card field can name. */
export type FactValue = { readonly kind: 'market'; readonly market: Market } | { readonly kind: 'contract'; readonly entry: RegistryEntry };

/** One fact for one value: each unit's number, in `fact.units` order, with the address of the token it counts. */
export type FactReading = {
  readonly fact: Fact;
  readonly value: FactValue;
  readonly read: Reading<readonly { readonly amount: bigint; readonly token: 'eth' | Address }[]>;
};

export type ProtocolFacts = {
  readonly block: BlockRef;
  readonly protocols: readonly ProtocolSheet[];
  /** Call targets that name no DefiLlama protocol, so no protocol facts are read for them. */
  readonly unlisted: readonly RegistryEntry[];
  readonly readings: readonly FactReading[];
  /** Every token and vault of the report's entries, by address. */
  readonly decimals: ReadonlyMap<Address, Reading<number>>;
};

/** What the protocol facts read, from the template and the registry alone. */
export type FactsScope = {
  readonly protocols: readonly { readonly slug: string; readonly contracts: readonly RegistryEntry[] }[];
  readonly unlisted: readonly RegistryEntry[];
  readonly reads: readonly { readonly fact: Fact; readonly value: FactValue }[];
  readonly tokens: readonly RegistryEntry[];
};

export function factsScope(template: Template, registry: Registry, entries: readonly RegistryEntry[]): FactsScope {
  const reads = template.facts.flatMap((fact) => valuesOf(template, fact.field, registry).map((value) => ({ fact, value })));
  return {
    protocols: [...calledProtocols(template, registry)].map(([slug, contracts]) => ({ slug, contracts })),
    unlisted: callTargetEntries(template, registry).filter((entry) => entry.kind !== 'token' && protocolOf(entry, registry).slug === undefined),
    reads,
    tokens: entries.filter((entry) => entry.kind === 'token' || entry.kind === 'vault'),
  };
}

function valuesOf(template: Template, field: string, registry: Registry): FactValue[] {
  const card = template.card.get(field);
  if (card?.kind === 'market') return [...registry.markets.values()].map((market) => ({ kind: 'market', market }));
  if (card?.kind === 'contract') return scopeEntries(card.scope, registry).map((entry) => ({ kind: 'contract', entry }));
  return [];
}

export const DEFILLAMA_HACKS = { hostname: 'api.llama.fi', path: '/hacks' } as const;
type DefiLlamaTarget = typeof DEFILLAMA_PROTOCOLS | typeof DEFILLAMA_HACKS;

/** Where answers come from: live, the DefiLlama API and both providers; on replay, the recording. */
export type FactsSources = {
  readonly defillama: (target: DefiLlamaTarget) => Promise<unknown>;
  readonly reader: Reader;
  readonly block: BlockRef;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const usd = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const day = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
const unixSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function listingOf(slug: string, raw: unknown): Reading<Listing> {
  if (!Array.isArray(raw)) throw new ListingError('DefiLlama sent no protocol list');
  const items = raw.filter((item): item is Record<string, unknown> => isRecord(item) && item.slug === slug);
  const [item] = items;
  if (item === undefined) return { kind: 'unread', why: `DefiLlama lists no protocol ${slug}` };
  if (items.length > 1) return { kind: 'unread', why: `DefiLlama lists ${items.length} protocols with slug ${slug}` };
  if (typeof item.id !== 'string' || !/^\d+$/.test(item.id)) return { kind: 'unread', why: `DefiLlama's entry for ${slug} has no id` };
  if (item.parentProtocol !== undefined && (typeof item.parentProtocol !== 'string' || !/^parent#[a-z0-9-]+$/.test(item.parentProtocol))) {
    return { kind: 'unread', why: `DefiLlama's entry for ${slug} names a parent that is not parent#<slug>` };
  }
  const chains = isRecord(item.chainTvls) ? item.chainTvls : {};
  return {
    kind: 'read',
    value: {
      id: item.id,
      parent: item.parentProtocol,
      listedFrom: unixSeconds(item.listedAt) ? day(item.listedAt) : undefined,
      tvl: usd(item.tvl),
      ethereumTvl: usd(chains.Ethereum),
    },
  };
}

/** The hacks DefiLlama files under the protocol's id or its parent's, oldest first; each must give a date. */
function hacksOf(raw: unknown, listing: Listing): Hack[] {
  if (!Array.isArray(raw)) throw new ListingError('DefiLlama sent no hacks list');
  const filed = raw.filter((item): item is Record<string, unknown> => isRecord(item) && (item.defillamaId === listing.id || item.defillamaId === listing.parent));
  return filed
    .map((item) => {
      if (!unixSeconds(item.date)) throw new ListingError(`DefiLlama's hacks list holds a hack filed under ${String(item.defillamaId)} with no date`);
      return { date: day(item.date), amount: usd(item.amount) };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

const proxyOf = (entry: RegistryEntry): Proxy => (entry.code === undefined ? 'not pinned' : entry.code.current.pin.implementation === undefined ? 'not a proxy' : 'proxy');

function boundValue(value: FactValue): ResolvedValue {
  return value.kind === 'market' ? { kind: 'market', market: value.market } : { kind: 'contract', name: value.entry.name, entry: value.entry };
}

async function readFact(fact: Fact, value: FactValue, registry: Registry, { reader, block }: FactsSources): Promise<FactReading['read']> {
  const values = new Map([[fact.field, boundValue(value)]]);
  const bound = bindView(fact, { safe: undefined, values, registry });
  if ('problem' in bound) return { kind: 'unread', why: bound.problem };
  const answer = await reader.call(bound.call, block);
  if (answer.kind === 'unverifiable') return { kind: 'unread', why: answer.reason };
  if (answer.value.kind === 'reverted') return { kind: 'unread', why: `it reverted at block ${block.number}` };
  const numbers = numbersOf(fact, { kind: 'returned', data: answer.value.data });
  if (typeof numbers === 'string') return { kind: 'unread', why: numbers };
  const amounts = [];
  for (const { value: at, unit } of fact.units) {
    const token = tokenOf(unit, values, registry);
    if (typeof token === 'object') return { kind: 'unread', why: token.problem };
    amounts.push({ amount: numbers[at] as bigint, token });
  }
  return { kind: 'read', value: amounts };
}

function tokenOf(unit: TokenRef, values: ReadonlyMap<string, ResolvedValue>, registry: Registry): 'eth' | Address | { readonly problem: string } {
  if (unit === 'eth') return 'eth';
  const target = resolveRef(unit, values, registry);
  if ('problem' in target) return target;
  return target.kind === 'address' ? target.address : { problem: 'a unit that names no token' };
}

/**
 * Reads what `scope` names: DefiLlama's protocol list and, when some protocol is listed, its hacks list, then through
 * both providers at `sources.block` every fact for every value and every token's decimals(). The same code runs live and
 * on a recording; a read the providers do not agree on is kept as unread, never guessed.
 */
export async function protocolFacts(scope: FactsScope, registry: Registry, sources: FactsSources): Promise<ProtocolFacts> {
  const list = scope.protocols.length === 0 ? [] : await sources.defillama(DEFILLAMA_PROTOCOLS);
  const listings = scope.protocols.map(({ slug }) => listingOf(slug, list));
  const hacks = listings.some((l) => l.kind === 'read') ? await sources.defillama(DEFILLAMA_HACKS) : [];
  const protocols = scope.protocols.map(({ slug, contracts }, i): ProtocolSheet => {
    const listing = listings[i] as Reading<Listing>;
    return { slug, listing, hacks: listing.kind === 'read' ? hacksOf(hacks, listing.value) : [], contracts: contracts.map((entry) => ({ entry, proxy: proxyOf(entry) })) };
  });
  const readings: FactReading[] = [];
  for (const { fact, value } of scope.reads) readings.push({ fact, value, read: await readFact(fact, value, registry, sources) });
  const decimals = new Map<Address, Reading<number>>();
  for (const token of scope.tokens) {
    const read = await readDecimals(sources.reader, token.address, sources.block);
    decimals.set(token.address, typeof read === 'number' ? { kind: 'read', value: read } : { kind: 'unread', why: read.problem });
  }
  return { block: sources.block, protocols, unlisted: scope.unlisted, readings, decimals };
}

/**
 * The `facts` section of a report recording. The DefiLlama answers keep their wire shape, cut to the fields the facts
 * read, so the same parsers read them back: of the protocol list, the entries whose slug the scope names; of the hacks
 * list, those filed under one of those entries' id or parent.
 */
export type FactsRecording = {
  readonly block: { readonly number: string; readonly hash: Hex };
  readonly defillama: readonly Record<string, unknown>[];
  readonly hacks: readonly Record<string, unknown>[];
  readonly chain: readonly Exchange[];
};

const PROTOCOL_KEYS = ['slug', 'id', 'parentProtocol', 'listedAt', 'tvl'] as const;
const HACK_KEYS = ['date', 'amount', 'defillamaId'] as const;

const pick = (item: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((key) => Object.hasOwn(item, key)).map((key) => [key, item[key]]));

/** `answers` holds what DefiLlama sent, by target path; `chain` the exchanges of the fact and decimals reads. */
export function factsRecording(scope: FactsScope, block: BlockRef, answers: ReadonlyMap<string, unknown>, chain: readonly Exchange[]): FactsRecording {
  const slugs = new Set(scope.protocols.map((p) => p.slug));
  const list = answers.get(DEFILLAMA_PROTOCOLS.path);
  const defillama = (Array.isArray(list) ? list : [])
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.slug === 'string' && slugs.has(item.slug))
    .map((item): Record<string, unknown> => ({ ...pick(item, PROTOCOL_KEYS), ...(isRecord(item.chainTvls) ? { chainTvls: pick(item.chainTvls, ['Ethereum']) } : {}) }));
  const ids = new Set<unknown>(defillama.flatMap((item) => [item.id, item.parentProtocol]).filter((id) => typeof id === 'string'));
  const raw = answers.get(DEFILLAMA_HACKS.path);
  const hacks = (Array.isArray(raw) ? raw : []).filter((item): item is Record<string, unknown> => isRecord(item) && ids.has(item.defillamaId)).map((item) => pick(item, HACK_KEYS));
  return { block: { number: block.number.toString(), hash: block.hash }, defillama, hacks, chain };
}

export class FactsRecordingError extends Error {
  override name = 'FactsRecordingError';
}

function records(path: string, raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw) || !raw.every(isRecord)) throw new FactsRecordingError(`facts.${path}: not a list of objects`);
  return raw;
}

function exchange(raw: unknown, i: number): Exchange {
  const maps = (v: unknown) => v === undefined || isRecord(v);
  if (!isRecord(raw) || typeof raw.method !== 'string' || !isRecord(raw.answers) || !maps(raw.errors) || !maps(raw.statuses)) {
    throw new FactsRecordingError(`facts.chain[${i}]: not a recorded exchange`);
  }
  return raw as Exchange;
}

/** The section as `--record` writes it; undefined when the recording predates protocol facts or is a vault's. */
export function parseFactsRecording(raw: unknown): FactsRecording | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new FactsRecordingError('facts: not an object');
  const extra = Object.keys(raw).find((key) => !['block', 'defillama', 'hacks', 'chain'].includes(key));
  if (extra !== undefined) throw new FactsRecordingError(`facts.${extra.slice(0, 40)}: unexpected field`);
  const block = raw.block;
  if (!isRecord(block) || typeof block.number !== 'string' || !/^\d+$/.test(block.number) || typeof block.hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(block.hash)) {
    throw new FactsRecordingError('facts.block: not a block number and 32-byte hash');
  }
  if (!Array.isArray(raw.chain)) throw new FactsRecordingError('facts.chain: not a list');
  return { block: { number: block.number, hash: block.hash as Hex }, defillama: records('defillama', raw.defillama), hacks: records('hacks', raw.hacks), chain: raw.chain.map(exchange) };
}

/** Serves `protocolFacts` from a recording: DefiLlama's answers as cut, the chain through a replaying reader. */
export function replaySources(recording: FactsRecording): FactsSources {
  return {
    defillama: async (target) => (target.path === DEFILLAMA_HACKS.path ? recording.hacks : recording.defillama),
    reader: replayReader(recording.chain),
    block: { number: BigInt(recording.block.number), hash: recording.block.hash },
  };
}
