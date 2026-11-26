import type { Reader } from '../chain/reader.ts';
import type { Registry } from '../registry.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { Template } from '../template/template.ts';
import { measure, statedEffects } from './amounts.ts';
import type { Measurement, StatedEffect } from './amounts.ts';
import { PAGE, RANGE_PAGES, ResearchError, SOURCES, search, searchedBy } from './sources.ts';
import type { Anchor, Ask, Hit, Hits, SourceName } from './sources.ts';
import type { ReadMessage } from './messages.ts';
import type { Sampling } from './recording.ts';
import { inPool } from './pool.ts';
import { proveParties } from './safe-parties.ts';
import { sharedReads } from './shared-reads.ts';
import { shapesOf, studyTx } from './study.ts';
import type { PartyProof, TxStudy } from './study.ts';
import { checkTrace, holdingTemplateCalls } from './trace.ts';
import type { TraceSource, TracedTx } from './trace.ts';

export type BlockRange = { readonly fromBlock: bigint; readonly toBlock: bigint };

/**
 * Legacy until every summary is recorded again: the windows a recording made before the newest-first search fell back
 * to, `count` windows of up to `blocks` blocks each, evenly spaced over the last year and placed by the head block
 * alone. A window whose transfers do not fit one page of a source is halved until they do.
 */
export const WINDOWS = { count: 12, blocks: 7200n } as const;

export const YEAR = (365n * 24n * 60n * 60n) / 12n;
const FINALITY = 64n;

export function spreadWindows(head: bigint, count: number, blocks: bigint): BlockRange[] {
  const top = ((head - FINALITY) / blocks) * blocks;
  const step = YEAR / BigInt(count);
  return Array.from({ length: count }, (_, i) => {
    const toBlock = top - BigInt(count - 1 - i) * step;
    return { fromBlock: toBlock - blocks + 1n, toBlock };
  });
}

export type PastTxsQuery = { readonly template: Template; readonly anchor: Omit<Anchor, keyof BlockRange>; readonly sampling: Sampling };

/** The block a newest-first search ends on: the head less the blocks a reorganization could still replace. */
export const searchTop = (head: bigint): bigint => head - FINALITY;

/** The last year a newest-first search from `head` pages back through. */
export const yearBefore = (head: bigint): BlockRange => ({ fromBlock: searchTop(head) - YEAR + 1n, toBlock: searchTop(head) });

export type PastTxsDeps = {
  readonly ask: Ask;
  readonly reader: Reader;
  /** Reads the anchor parties in batches, noting no read with no answer, since each party of such a batch is read alone; without it, `reader`. */
  readonly batches?: Reader;
  readonly registry: Registry;
  readonly readMessage: ReadMessage;
  readonly exclude: Address | undefined;
  /**
   * The most transactions studied in a run: in a newest-first search or a covered paged year, chosen by `safesFirst`;
   * in the windows, shared evenly between them, and below one per window none; in a year a recording asked in one page,
   * taken evenly.
   */
  readonly maxTxs: number;
  /** Each transaction's call trace; without it, nothing is traced. */
  readonly traces?: TraceSource;
  /** A recording's transactions left out because they touch the configured Safe, whose address the recording does not hold. */
  readonly excludedByRecording?: ExcludedHashes;
};

/** The transactions left out because they touch the configured Safe: `found` before sampling, `sampled` after. */
export type ExcludedHashes = { readonly found: ReadonlySet<Hex>; readonly sampled: ReadonlySet<Hex> };

export type Kept = Exclude<TxStudy, { kind: 'excluded' }>;
export type Fit = Extract<Kept, { kind: 'fit' }>;
export type Misfit = Extract<Kept, { kind: 'misfit' }>;

/** One window as searched, `asked` before any halving: `found` transactions after exclusion, of which `studied` were read. */
export type WindowRun = { readonly asked: BlockRange; readonly range: BlockRange; readonly found: number; readonly studied: number };

/** Which address of an anchor hit is the party that would be a Safe doing the operation, or why none is. */
export type PartyRule = { readonly kind: 'side'; readonly side: 'from' | 'to' | 'emitter'; readonly noun: string } | { readonly kind: 'none'; readonly why: string };

function partyRule(anchor: Omit<Anchor, keyof BlockRange>): PartyRule {
  switch (anchor.kind) {
    case 'mint':
      return { kind: 'side', side: 'to', noun: 'the address minted to' };
    case 'burn':
      return { kind: 'side', side: 'from', noun: 'the address burned from' };
    case 'any':
      if (anchor.from !== undefined && anchor.to !== undefined) return { kind: 'none', why: '--from and --to fix both sides of the transfer' };
      return anchor.from === undefined ? { kind: 'side', side: 'from', noun: 'the address the token moved out of' } : { kind: 'side', side: 'to', noun: 'the address the token moved into' };
    case 'event':
      return anchor.token === undefined
        ? { kind: 'side', side: 'emitter', noun: 'the contract that logged the event' }
        : { kind: 'none', why: 'a named contract\'s event has no party of fixed meaning' };
  }
}

/** The anchor parties of a covered year, each read once at `block` for whether it is a Safe. */
export type PartyCheck =
  | { readonly kind: 'not-checked'; readonly why: string }
  | { readonly kind: 'checked'; readonly noun: string; readonly block: bigint; readonly parties: number; readonly safes: number; readonly unreadable: number };

/**
 * How many of the year's transactions had a proven Safe party, and how many of each kind were studied, counted as the
 * year's window line counts its found and studied: after leaving out those that touch the configured Safe.
 */
export type Selection = { readonly safes: number; readonly safesChosen: number; readonly rest: number; readonly restChosen: number };

/**
 * The one block range a newest-first search read completely, ending on `searchTop(head)`, and why it starts where it
 * does: `year` when it reached the year's first block, `recent` when the page cap stopped it first. `pages` counts the
 * pages its block ranges took, each the pages of the source that took the most, those of a range that held too many to
 * finish included; `time` is the time of the range's first and last block.
 */
export type Coverage = {
  readonly kind: 'year' | 'recent';
  readonly range: BlockRange;
  readonly pages: number;
  readonly time: { readonly from: bigint; readonly to: bigint } | undefined;
};

/** The anchor party check and the choice it made. */
export type SafesFirst = { readonly check: PartyCheck; readonly selection: Selection };

/**
 * What a run searched: `newest-first`, one range read completely; `windows`, legacy until every summary is recorded
 * again, the year a recording asked first, else its windows or a block range given by hand.
 */
export type SearchRun =
  | { readonly kind: 'newest-first'; readonly coverage: Coverage; readonly safesFirst: SafesFirst }
  | { readonly kind: 'windows'; readonly year: YearSearch | undefined; readonly windows: readonly WindowRun[]; readonly perWindow: number };

/**
 * Legacy until every summary is recorded again, the year a recording asked first: `covered` when every source finished
 * within `pages` pages, so it replaced the windows, with the pages each source asked and, for a paged year, its party
 * check; otherwise the sources that did not.
 */
export type YearSearch =
  | {
      readonly kind: 'covered';
      readonly range: BlockRange;
      readonly pages: ReadonlyMap<SourceName, number>;
      /** Absent for a recording that asked the year in one page, before parties were checked. */
      readonly safesFirst: SafesFirst | undefined;
    }
  | { readonly kind: 'overflow'; readonly range: BlockRange; readonly pages: number; readonly sources: readonly SourceName[] };

/**
 * What the search found, the configured Safe's transactions left out: how many, and when both sources searched, the
 * hashes only one of them found. A transaction found by every source that searched is not listed.
 */
export type Found = { readonly total: number; readonly only: Readonly<Record<SourceName, readonly Hex[]>> };

/** How many transactions `source` found: all but those only another source found. */
export const foundBy = (found: Found, source: SourceName): number => found.total - SOURCES.filter((s) => s !== source).reduce((n, s) => n + found.only[s].length, 0);

export type PastTxs = {
  readonly query: PastTxsQuery;
  readonly head: bigint | undefined;
  readonly search: SearchRun;
  readonly found: Found;
  readonly studies: readonly Kept[];
  readonly shapes: ReturnType<typeof shapesOf>;
  /** Transactions left out because they touch the configured Safe. Never printed. */
  readonly excluded: ExcludedHashes;
  /** With an event any contract may log, transactions whose sender did not log it itself, left out of `studies`. */
  readonly otherEmitter: readonly Hex[];
  /** The template's effects that state an amount, and for each fitting transaction stating one, how its balances differed. */
  readonly effects: readonly StatedEffect[];
  readonly measurements: ReadonlyMap<Hex, Measurement>;
  /** Each transaction exactly the template that has a trace, checked against the transaction and its receipt. */
  readonly traces: readonly TracedTx[];
};

const ZERO = `0x${'00'.repeat(20)}`;

function hashesBySource(hits: Hits, exclude: Address | undefined, excludedHashes: ReadonlySet<Hex>): { found: Map<Hex, SourceName[]>; excluded: Set<Hex> } {
  const found = new Map<Hex, SourceName[]>();
  const excluded = new Set<Hex>();
  for (const source of SOURCES) {
    for (const hit of hits[source]) {
      if (excludedHashes.has(hit.hash) || (exclude !== undefined && (hit.from === exclude || hit.to === exclude || hit.emitter === exclude))) excluded.add(hit.hash);
      const sources = found.get(hit.hash) ?? [];
      if (!sources.includes(source)) sources.push(source);
      found.set(hit.hash, sources);
    }
  }
  for (const hash of excluded) found.delete(hash);
  return { found, excluded };
}

function byBlock(hashes: readonly Hex[], hits: Hits): Hex[] {
  const first = new Map<Hex, bigint>();
  for (const hit of SOURCES.flatMap((source) => hits[source])) {
    const seen = first.get(hit.hash);
    if (hit.block !== undefined && (seen === undefined || hit.block < seen)) first.set(hit.hash, hit.block);
  }
  const at = (hash: Hex) => first.get(hash) ?? 0n;
  return [...hashes].sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
}

type Searched = { readonly asked: BlockRange; readonly range: BlockRange; readonly hits: Hits };

async function searchWindow(anchor: PastTxsQuery['anchor'], asked: BlockRange, halve: boolean, ask: Ask): Promise<Searched> {
  for (let range = asked; ; range = { fromBlock: range.toBlock - (range.toBlock - range.fromBlock + 1n) / 2n + 1n, toBlock: range.toBlock }) {
    const found = await search({ ...anchor, ...range }, ask, 1, 'short');
    if (found.kind === 'covered') return { asked, range, hits: found.hits };
    if (!halve || range.fromBlock === range.toBlock) throw new ResearchError(`${found.sources[0]} lists more than ${PAGE - 1} transfers in the range; narrow the block range`);
  }
}

const spacedSample = <T>(items: readonly T[], cap: number): T[] =>
  items.length <= cap ? [...items] : Array.from({ length: cap }, (_, i) => items[Math.floor((i * items.length) / cap)] as T);

function safesFirst<T>(safes: readonly T[], rest: readonly T[], maxTxs: number): { readonly safes: T[]; readonly rest: T[] } {
  const restFloor = Math.min(rest.length, Math.ceil(maxTxs / 4));
  const chosen = spacedSample(safes, maxTxs - restFloor);
  return { safes: chosen, rest: spacedSample(rest, maxTxs - chosen.length) };
}

async function chooseByParty(
  hashes: readonly Hex[],
  hits: Hits,
  rule: PartyRule,
  at: bigint,
  reader: Reader,
  batches: Reader | undefined,
  maxTxs: number,
): Promise<{ sample: Hex[]; check: PartyCheck; safeTxs: ReadonlySet<Hex> }> {
  const kept = new Set(hashes);
  const partiesOf = new Map<Hex, Set<Address>>();
  const sideOf = (hit: Hit): Address | undefined => (rule.kind === 'none' ? undefined : rule.side === 'emitter' ? hit.emitter : hit[rule.side]);
  for (const hit of SOURCES.flatMap((source) => hits[source])) {
    const party = sideOf(hit);
    if (!kept.has(hit.hash) || party === undefined || party === ZERO) continue;
    partiesOf.set(hit.hash, (partiesOf.get(hit.hash) ?? new Set()).add(party));
  }
  const parties = [...new Set([...partiesOf.values()].flatMap((set) => [...set]))].sort();
  const proofs = new Map<Address, PartyProof>();
  if (parties.length > 0) {
    const block = await reader.block(at);
    const read = block.kind === 'unverifiable' ? parties.map((): PartyProof => ({ kind: 'unreadable', reason: block.reason })) : await proveParties(reader, parties, block.value, batches);
    parties.forEach((party, i) => proofs.set(party, read[i] as PartyProof));
  }
  const isSafe = (hash: Hex) => [...(partiesOf.get(hash) ?? [])].some((party) => proofs.get(party)?.kind === 'safe');
  const [safeTxs, rest] = [hashes.filter(isSafe), hashes.filter((hash) => !isSafe(hash))];
  const chosen = safesFirst(safeTxs, rest, maxTxs);
  const picked = new Set([...chosen.safes, ...chosen.rest]);
  const proofCount = (kind: PartyProof['kind']) => [...proofs.values()].filter((p) => p.kind === kind).length;
  return {
    sample: hashes.filter((hash) => picked.has(hash)),
    check: rule.kind === 'none' ? { kind: 'not-checked', why: rule.why } : { kind: 'checked', noun: rule.noun, block: at, parties: parties.length, safes: proofCount('safe'), unreadable: proofCount('unreadable') },
    safeTxs: new Set(safeTxs),
  };
}

const yearPages = (sampling: Extract<Sampling, { kind: 'year' | 'old-year' | 'old-windows' }>): number | undefined =>
  sampling.kind === 'year' ? sampling.pages : sampling.kind === 'old-year' ? 1 : undefined;

/** The pages of `PAGE` a newest-first range is sized to hold, fewer than `RANGE_PAGES` so a busier stretch still fits. */
const FILL_PAGES = 5n;
/**
 * The pages the first range below a year that held more is sized to hold: the year's listing reached only its oldest
 * blocks, and an operation is often busier now than a year ago.
 */
const FIRST_PAGES = 1n;
/** How many times longer than the last a range may grow. */
const GROWTH = 8n;

const smaller = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const larger = (a: bigint, b: bigint): bigint => (a > b ? a : b);

type NewestFirst = { readonly kind: Coverage['kind']; readonly range: BlockRange; readonly pages: number; readonly hits: Hits };

/**
 * Pages back from the year's last block, newest first, one block range below the other, until the year is read or the
 * ranges have taken `maxPages` pages, each range counted by the source that took the most. Every source searches each
 * range as `search` does, so a range counts only when every source finished it. The first range is the whole year; a
 * range that held more is asked again shorter, sized by the block its listing reached, and each next range is sized by
 * how many the last one held, and fitted to the pages left, one kept for Etherscan's empty last page.
 */
async function newestFirst(anchor: PastTxsQuery['anchor'], year: BlockRange, maxPages: number, ask: Ask): Promise<NewestFirst> {
  const hits: Record<SourceName, Hit[]> = { alchemy: [], etherscan: [] };
  let used = 0;
  let toBlock = year.toBlock;
  let span = year.toBlock - year.fromBlock + 1n;
  while (toBlock >= year.fromBlock && used < maxPages) {
    const allowed = Math.min(RANGE_PAGES, maxPages - used);
    const fitted = allowed > FILL_PAGES ? span : larger(1n, (span * BigInt(allowed - 1)) / FILL_PAGES);
    const fromBlock = larger(year.fromBlock, toBlock - fitted + 1n);
    const asked = toBlock - fromBlock + 1n;
    const found = await search({ ...anchor, fromBlock, toBlock }, ask, allowed, 'empty');
    used += found.kind === 'covered' ? Math.max(...found.pages.values()) : allowed;
    if (found.kind === 'covered') {
      for (const source of SOURCES) hits[source].push(...found.hits[source]);
      const most = BigInt(Math.max(...SOURCES.map((source) => found.hits[source].length)));
      span = most === 0n ? asked * GROWTH : smaller(asked * GROWTH, larger(1n, (asked * FILL_PAGES * BigInt(PAGE)) / most));
      toBlock = fromBlock - 1n;
    } else {
      const listed = found.reached === undefined || found.reached < fromBlock ? asked : found.reached - fromBlock + 1n;
      const fill = asked === year.toBlock - year.fromBlock + 1n ? FIRST_PAGES : FILL_PAGES;
      span = larger(1n, smaller(asked / 2n, (listed * fill) / BigInt(allowed)));
    }
  }
  if (toBlock === year.toBlock) throw new ResearchError(`no block range ending at block ${year.toBlock} was searched completely within ${maxPages} pages of a source`);
  return { kind: toBlock < year.fromBlock ? 'year' : 'recent', range: { fromBlock: toBlock + 1n, toBlock: year.toBlock }, pages: used, hits };
}

async function timesOf(reader: Reader, range: BlockRange): Promise<Coverage['time']> {
  const time = async (number: bigint) => {
    const block = await reader.block(number);
    if (block.kind === 'unverifiable') return undefined;
    const header = await reader.header(block.value);
    return header.kind === 'unverifiable' ? undefined : header.value.time;
  };
  const [from, to] = [await time(range.fromBlock), await time(range.toBlock)];
  return from === undefined || to === undefined ? undefined : { from, to };
}

const STUDY_WIDTH = 8;
const TRACE_WIDTH = 8;

export async function pastTxs(query: PastTxsQuery, given: PastTxsDeps): Promise<PastTxs> {
  const deps = { ...given, reader: sharedReads(given.reader) };
  const { sampling } = query;
  const head = sampling.kind === 'range' ? undefined : (sampling.head ?? (await chainHead(deps.reader)));
  let year: YearSearch | undefined;
  let windowed: Searched[] | undefined;
  let newest: NewestFirst | undefined;
  if (sampling.kind === 'range') windowed = [await searchWindow(query.anchor, sampling.range, false, deps.ask)];
  else if (sampling.kind === 'recent') {
    newest = await newestFirst(query.anchor, yearBefore(head as bigint), sampling.maxPages, deps.ask);
    windowed = [{ asked: newest.range, range: newest.range, hits: newest.hits }];
  } else {
    const spread = spreadWindows(head as bigint, WINDOWS.count, WINDOWS.blocks);
    const pages = yearPages(sampling);
    if (pages !== undefined) {
      const top = (spread.at(-1) as BlockRange).toBlock;
      const range = { fromBlock: top - YEAR + 1n, toBlock: top };
      const found = await search({ ...query.anchor, ...range }, deps.ask, pages, 'short');
      if (found.kind === 'covered') {
        year = { kind: 'covered', range, pages: found.pages, safesFirst: undefined };
        windowed = [{ asked: range, range, hits: found.hits }];
      } else year = { kind: 'overflow', range, pages, sources: found.sources };
    }
    if (windowed === undefined) {
      windowed = [];
      for (const asked of spread) windowed.push(await searchWindow(query.anchor, asked, true, deps.ask));
    }
  }
  const perWindow = Math.floor(deps.maxTxs / windowed.length);
  const found = new Map<Hex, SourceName[]>();
  const excludedFound = new Set<Hex>();
  const excludedSampled = new Set<Hex>();
  const emitters = new Map<Hex, Set<Address>>();
  const searched: { asked: BlockRange; range: BlockRange; found: Hex[]; sample: Hex[] }[] = [];
  let byParty: { check: PartyCheck; safeTxs: ReadonlySet<Hex> } | undefined;
  for (const { asked, range, hits } of windowed) {
    const window = hashesBySource(hits, deps.exclude, deps.excludedByRecording?.found ?? new Set());
    for (const hash of window.excluded) excludedFound.add(hash);
    for (const [hash, sources] of window.found) found.set(hash, sources);
    for (const hit of hits.etherscan) if (hit.emitter !== undefined) emitters.set(hit.hash, (emitters.get(hit.hash) ?? new Set()).add(hit.emitter));
    const hashes = newest !== undefined || year?.kind === 'covered' ? byBlock([...window.found.keys()], hits) : [...window.found.keys()];
    const chosen =
      newest !== undefined || (year?.kind === 'covered' && sampling.kind === 'year') ? await chooseByParty(hashes, hits, partyRule(query.anchor), range.toBlock, deps.reader, deps.batches, deps.maxTxs) : undefined;
    if (chosen !== undefined) byParty = chosen;
    searched.push({ asked, range, found: hashes, sample: chosen?.sample ?? spacedSample(hashes, perWindow) });
  }
  const shapes = shapesOf(query.template);
  const token = query.anchor.token?.toLowerCase() as Address | undefined;
  const context = { shapes, registry: deps.registry, readMessage: deps.readMessage, exclude: deps.exclude, anchor: { kind: query.anchor.kind, ...(token === undefined ? {} : { token }) } };
  const all = await inPool(searched.flatMap((w) => w.sample), STUDY_WIDTH, async (hash) => ({
    hash,
    study: deps.excludedByRecording?.sampled.has(hash) === true ? ({ kind: 'excluded' } as const) : await studyTx(deps.reader, hash, context),
  }));
  const studies: Kept[] = [];
  const otherEmitter: Hex[] = [];
  for (const { hash, study } of all) {
    if (study.kind === 'excluded') {
      excludedSampled.add(hash);
      found.delete(hash);
    } else if (query.anchor.token === undefined && 'sender' in study && !(emitters.get(hash)?.has(study.sender.address) ?? false)) otherEmitter.push(hash);
    else studies.push(study);
  }
  const effects = statedEffects(query.template);
  const fits = studies.filter((s): s is Fit => s.kind === 'fit');
  const rulesOf = (fit: Fit) => (fit.sender.kind === 'safe' ? shapes.whole : (shapes.calls[fit.sender.call] as (typeof shapes.calls)[number])).loosened.rules;
  const measured = await inPool(fits, STUDY_WIDTH, (fit) => measure(deps.reader, { hash: fit.hash, sender: fit.sender, rules: rulesOf(fit), values: fit.values }, effects, deps.registry));
  const measurements = new Map(fits.flatMap((fit, i) => (measured[i] === undefined ? [] : [[fit.hash, measured[i]] as const])));
  const traces = deps.traces === undefined ? [] : await traceExact(query.template, fits, deps.traces, deps.reader, deps.registry);
  const kept = (hashes: readonly Hex[]) => hashes.filter((hash) => !excludedFound.has(hash) && !excludedSampled.has(hash)).length;
  const studiedOf = (sample: readonly Hex[]) => sample.filter((hash) => !otherEmitter.includes(hash));
  const windows = searched.map(({ asked, range, found, sample }) => ({ asked, range, found: kept(found), studied: kept(studiedOf(sample)) }));
  let chosen: SafesFirst | undefined;
  if (byParty !== undefined) {
    const { check, safeTxs } = byParty;
    const { found: hashes, sample } = searched[0] as (typeof searched)[number];
    const isSafe = (hash: Hex) => safeTxs.has(hash);
    const [safes, safesChosen] = [kept(hashes.filter(isSafe)), kept(studiedOf(sample).filter(isSafe))];
    chosen = { check, selection: { safes, safesChosen, rest: kept(hashes) - safes, restChosen: kept(studiedOf(sample)) - safesChosen } };
    if (year?.kind === 'covered') year = { ...year, safesFirst: chosen };
  }
  const searchRun: SearchRun =
    newest === undefined ? { kind: 'windows', year, windows, perWindow }
    : { kind: 'newest-first', coverage: { kind: newest.kind, range: newest.range, pages: newest.pages, time: await timesOf(deps.reader, newest.range) }, safesFirst: chosen as SafesFirst };
  const excluded = { found: excludedFound, sampled: excludedSampled };
  const both = searchedBy(query.anchor).length === SOURCES.length;
  const only = (source: SourceName) => (both ? [...found].filter(([, s]) => s.length === 1 && s[0] === source).map(([hash]) => hash) : []);
  return { query, head, search: searchRun, found: { total: found.size, only: { alchemy: only('alchemy'), etherscan: only('etherscan') } }, studies, shapes, excluded, otherEmitter, effects, measurements, traces };
}

/**
 * Traces each transaction exactly the template and checks each trace that came back: against the
 * transaction and its receipt, and that it holds the template's calls in order.
 */
async function traceExact(template: Template, fits: readonly Fit[], source: TraceSource, reader: Reader, registry: Registry): Promise<TracedTx[]> {
  const tokens = new Set([...registry.entries.values()].filter((entry) => entry.kind === 'token' || entry.kind === 'vault').map((entry) => entry.address.toLowerCase() as Address));
  const traced = await inPool(fits.filter((f) => f.outside.length === 0), TRACE_WIDTH, async (fit) => {
    const calls = await source(fit.hash);
    return calls === undefined ? undefined : holdingTemplateCalls(template, registry, await checkTrace(fit.hash, fit.sender, calls, reader, tokens));
  });
  return traced.filter((tx) => tx !== undefined);
}

async function chainHead(reader: Reader): Promise<bigint> {
  const head = await reader.blockNumber();
  if (head.kind === 'unverifiable') throw new ResearchError(`the head block: ${head.reason}`);
  return head.value;
}
