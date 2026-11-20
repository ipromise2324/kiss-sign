import type { Reader } from '../chain/reader.ts';
import type { AbiType } from '../decode/abi.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { LeafRule, Quantity, Template } from '../template/template.ts';
import { effectText, distributionOf, measure, shown, statedEffects, toleranceFinding } from './amounts.ts';
import type { Difference, Measurement, StatedEffect } from './amounts.ts';
import { PAGE, ResearchError, SOURCES, search, searchedBy } from './sources.ts';
import type { Anchor, Ask, Hit, Hits, SourceName } from './sources.ts';
import type { ReadMessage } from './messages.ts';
import type { Sampling } from './recording.ts';
import { brokenRule, constText, functionNames, isOtherOperation, isTime, misfitText, proveParty, shapesOf, studyTx } from './study.ts';
import type { OutsideKind, PartyProof, Sender, TxStudy } from './study.ts';
import { checkTrace, holdingTemplateCalls } from './trace.ts';
import type { TraceSource, TracedTx } from './trace.ts';

export type BlockRange = { readonly fromBlock: bigint; readonly toBlock: bigint };

/**
 * The windows a year search falls back to: `count` windows of up to `blocks` blocks each, evenly spaced over the last
 * year and placed by the head block alone. A window whose transfers do not fit one page of a source is halved until
 * they do.
 */
export const WINDOWS = { count: 12, blocks: 7200n } as const;

const YEAR = (365n * 24n * 60n * 60n) / 12n;
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

export type PastTxsDeps = {
  readonly ask: Ask;
  readonly reader: Reader;
  /** The reader each anchor party of a covered year is checked through; `reader` when absent. */
  readonly partyReader?: Reader;
  readonly registry: Registry;
  readonly readMessage: ReadMessage;
  readonly exclude: Address | undefined;
  /** The most transactions studied in a run, shared evenly between the windows; below one per window none is studied. */
  readonly maxTxs: number;
  /** Each transaction's call trace; without it, nothing is traced. */
  readonly traces?: TraceSource;
  /** A recording's transactions left out because they touch the configured Safe, whose address the recording does not hold. */
  readonly excludedByRecording?: ExcludedHashes;
};

/** The transactions left out because they touch the configured Safe: `found` before sampling, `sampled` after. */
export type ExcludedHashes = { readonly found: ReadonlySet<Hex>; readonly sampled: ReadonlySet<Hex> };

type Kept = Exclude<TxStudy, { kind: 'excluded' }>;

/** One window as searched, `asked` before any halving: `found` transactions after exclusion, of which `studied` were read. */
export type WindowRun = { readonly asked: BlockRange; readonly range: BlockRange; readonly found: number; readonly studied: number };

/**
 * Which address of an anchor hit is the party that would be a Safe doing the operation, or why none is: with `--from`
 * and `--to` both sides are fixed, and topic 1 of a named contract's event has no fixed meaning.
 */
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

/** How many of the year's transactions had a proven Safe party, and how many of each kind were chosen to study. */
export type Selection = { readonly safes: number; readonly safesChosen: number; readonly rest: number; readonly restChosen: number };

/**
 * The year search a run asks first: `covered` when every source finished within `pages` pages, so it replaced the
 * windows, with the pages each source asked and, for a paged year, its party check; otherwise the sources that did not.
 */
export type YearSearch =
  | {
      readonly kind: 'covered';
      readonly range: BlockRange;
      readonly pages: ReadonlyMap<SourceName, number>;
      /** Absent for a recording that asked the year in one page, before parties were checked. */
      readonly safesFirst: { readonly check: PartyCheck; readonly selection: Selection } | undefined;
    }
  | { readonly kind: 'overflow'; readonly range: BlockRange; readonly pages: number; readonly sources: readonly SourceName[] };

export type PastTxs = {
  readonly query: PastTxsQuery;
  readonly head: bigint | undefined;
  /** Absent for a block range, and for a recording made before the whole year was asked first. */
  readonly year: YearSearch | undefined;
  readonly windows: readonly WindowRun[];
  readonly perWindow: number;
  /** Each kept transaction with the sources that found it. */
  readonly found: ReadonlyMap<Hex, readonly SourceName[]>;
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

async function inPool<T, R>(items: readonly T[], width: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
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

/** One page per source; an overflowing window is halved to its newer half, and a range given by hand is refused. */
async function searchWindow(anchor: PastTxsQuery['anchor'], asked: BlockRange, halve: boolean, ask: Ask): Promise<Searched> {
  for (let range = asked; ; range = { fromBlock: range.toBlock - (range.toBlock - range.fromBlock + 1n) / 2n + 1n, toBlock: range.toBlock }) {
    const found = await search({ ...anchor, ...range }, ask, 1);
    if (found.kind === 'covered') return { asked, range, hits: found.hits };
    if (!halve || range.fromBlock === range.toBlock) throw new ResearchError(`${found.sources[0]} lists more than ${PAGE - 1} transfers in the range; narrow the block range`);
  }
}

const spacedSample = <T>(items: readonly T[], cap: number): T[] =>
  items.length <= cap ? [...items] : Array.from({ length: cap }, (_, i) => items[Math.floor((i * items.length) / cap)] as T);

/**
 * At most `maxTxs` of the Safe-party transactions and the rest, each list taken evenly in its order: the Safes' first,
 * but never more than leaves a quarter of `maxTxs` for the rest while the rest holds that many.
 */
function safesFirst<T>(safes: readonly T[], rest: readonly T[], maxTxs: number): { readonly safes: T[]; readonly rest: T[] } {
  const restFloor = Math.min(rest.length, Math.floor(maxTxs / 4));
  const chosen = spacedSample(safes, maxTxs - restFloor);
  return { safes: chosen, rest: spacedSample(rest, maxTxs - chosen.length) };
}

const PROBE_WIDTH = 8;

/**
 * Checks each distinct anchor party of the kept transactions for a Safe at the year's top block, and chooses the
 * transactions to study: every one with a Safe party first, by `safesFirst`, then the rest, in block order.
 */
async function chooseByParty(
  hashes: readonly Hex[],
  hits: Hits,
  rule: PartyRule,
  at: bigint,
  reader: Reader,
  maxTxs: number,
): Promise<{ sample: Hex[]; check: PartyCheck; selection: Selection }> {
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
    const read = block.kind === 'unverifiable' ? parties.map((): PartyProof => ({ kind: 'unreadable', reason: block.reason })) : await inPool(parties, PROBE_WIDTH, (party) => proveParty(reader, party, block.value));
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
    selection: { safes: safeTxs.length, safesChosen: chosen.safes.length, rest: rest.length, restChosen: chosen.rest.length },
  };
}

/** The year's pages each searching source may ask in `sampling`, or none when it searches the windows alone. */
const yearPages = (sampling: Exclude<Sampling, { kind: 'range' }>): number | undefined =>
  sampling.kind === 'year' ? sampling.pages : sampling.kind === 'old-year' ? 1 : undefined;

export async function pastTxs(query: PastTxsQuery, deps: PastTxsDeps): Promise<PastTxs> {
  const { sampling } = query;
  const head = sampling.kind === 'range' ? undefined : (sampling.head ?? (await chainHead(deps.reader)));
  let year: YearSearch | undefined;
  let windowed: Searched[] | undefined;
  if (sampling.kind === 'range') windowed = [await searchWindow(query.anchor, sampling.range, false, deps.ask)];
  else {
    const spread = spreadWindows(head as bigint, WINDOWS.count, WINDOWS.blocks);
    const pages = yearPages(sampling);
    if (pages !== undefined) {
      const top = (spread.at(-1) as BlockRange).toBlock;
      const range = { fromBlock: top - YEAR + 1n, toBlock: top };
      const found = await search({ ...query.anchor, ...range }, deps.ask, pages);
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
  for (const { asked, range, hits } of windowed) {
    const window = hashesBySource(hits, deps.exclude, deps.excludedByRecording?.found ?? new Set());
    for (const hash of window.excluded) excludedFound.add(hash);
    for (const [hash, sources] of window.found) found.set(hash, sources);
    for (const hit of hits.etherscan) if (hit.emitter !== undefined) emitters.set(hit.hash, (emitters.get(hit.hash) ?? new Set()).add(hit.emitter));
    const hashes = year?.kind === 'covered' ? byBlock([...window.found.keys()], hits) : [...window.found.keys()];
    const chosen = year?.kind === 'covered' && sampling.kind === 'year' ? await chooseByParty(hashes, hits, partyRule(query.anchor), range.toBlock, deps.partyReader ?? deps.reader, deps.maxTxs) : undefined;
    if (chosen !== undefined && year?.kind === 'covered') year = { ...year, safesFirst: { check: chosen.check, selection: chosen.selection } };
    searched.push({ asked, range, found: hashes, sample: chosen?.sample ?? spacedSample(hashes, perWindow) });
  }
  const shapes = shapesOf(query.template);
  const token = query.anchor.token?.toLowerCase() as Address | undefined;
  const context = { shapes, registry: deps.registry, readMessage: deps.readMessage, exclude: deps.exclude, anchor: { kind: query.anchor.kind, ...(token === undefined ? {} : { token }) } };
  const all = await inPool(searched.flatMap((w) => w.sample), 4, async (hash) => ({
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
  const measured = await inPool(fits, 4, (fit) => measure(deps.reader, { hash: fit.hash, sender: fit.sender, rules: rulesOf(fit), values: fit.values }, effects, deps.registry));
  const measurements = new Map(fits.flatMap((fit, i) => (measured[i] === undefined ? [] : [[fit.hash, measured[i]] as const])));
  const traces = deps.traces === undefined ? [] : await traceExact(query.template, fits, deps.traces, deps.reader, deps.registry);
  const kept = (hashes: readonly Hex[]) => hashes.filter((hash) => !excludedFound.has(hash) && !excludedSampled.has(hash)).length;
  const windows = searched.map(({ asked, range, found, sample }) => ({ asked, range, found: kept(found), studied: kept(sample.filter((hash) => !otherEmitter.includes(hash))) }));
  const excluded = { found: excludedFound, sampled: excludedSampled };
  return { query, head, year, windows, perWindow, found, studies, shapes, excluded, otherEmitter, effects, measurements, traces };
}

/**
 * Traces each transaction exactly the template, one at a time, and checks each trace that came back: against the
 * transaction and its receipt, and that it holds the template's calls in order.
 */
async function traceExact(template: Template, fits: readonly Fit[], source: TraceSource, reader: Reader, registry: Registry): Promise<TracedTx[]> {
  const tokens = new Set([...registry.entries.values()].filter((entry) => entry.kind === 'token' || entry.kind === 'vault').map((entry) => entry.address.toLowerCase() as Address));
  const traced: TracedTx[] = [];
  for (const fit of fits.filter((f) => f.outside.length === 0)) {
    const calls = await source(fit.hash);
    if (calls === undefined) continue;
    traced.push(holdingTemplateCalls(template, registry, await checkTrace(fit.hash, fit.sender, calls, reader, tokens)));
  }
  return traced;
}

export const PERCENTILES = [50, 90, 99] as const;

export type Spread = { readonly count: number; readonly min: bigint; readonly percentiles: readonly bigint[]; readonly max: bigint };

export function spreadOf(values: readonly bigint[]): Spread | undefined {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = sorted.length;
  if (n === 0) return undefined;
  const nearestRank = (rank: number) => sorted[Math.max(rank, 1) - 1] as bigint;
  return { count: n, min: nearestRank(1), percentiles: PERCENTILES.map((p) => nearestRank(Math.ceil((p * n) / 100))), max: nearestRank(n) };
}

/**
 * One free or `withinSeconds` `uint` or `int` field over the fitting transactions of one sender type: its values, or
 * for a time, each less its block's time; `unrecorded` counts transactions whose block time was not read.
 */
export type FreeNumber = { readonly path: string; readonly time: boolean; readonly spread: Spread | undefined; readonly unrecorded: number };

export function freeNumbers(fits: readonly Fit[], rules: readonly LeafRule[]): FreeNumber[] {
  const first = fits[0];
  if (first === undefined) return [];
  return rules.flatMap((rule, i): FreeNumber[] => {
    const type = first.types[i];
    if ((rule.kind !== 'free' && rule.kind !== 'within-seconds') || (type?.kind !== 'uint' && type?.kind !== 'int')) return [];
    const time = isTime(rule);
    const values = fits.flatMap((fit) => {
      const value = BigInt(fit.values[i] as string);
      if (!time) return [value];
      return fit.time === undefined ? [] : [value - fit.time];
    });
    return [{ path: first.paths[i] as string, time, spread: spreadOf(values), unrecorded: fits.length - values.length }];
  });
}

async function chainHead(reader: Reader): Promise<bigint> {
  const head = await reader.blockNumber();
  if (head.kind === 'unverifiable') throw new ResearchError(`the head block: ${head.reason}`);
  return head.value;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function describeRule(rule: LeafRule, sender: string): string {
  switch (rule.kind) {
    case 'safe':
      return sender;
    case 'contract':
      return `contract ${rule.name}`;
    case 'address-word':
      return `${describeRule(rule.rule, sender)} as a 32-byte word`;
    case 'const':
      return `const ${constText(rule.value)}`;
    case 'card':
      return `card ${rule.ref.field}${rule.ref.attribute === undefined ? '' : `.${rule.ref.attribute}`}`;
    case 'free':
      return 'free';
    case 'within-seconds':
      return `at most ${rule.seconds} seconds after its block's time`;
    case 'equals':
      return `same as ${rule.path}`;
    case 'owner-before':
      return `the owner before card ${rule.ref.field}`;
    case 'at-least':
    case 'at-most':
      return `${rule.kind === 'at-least' ? 'at least' : 'at most'} card ${rule.field}`;
    case 'share-price': {
      const name = (q: Quantity): string => (q.kind === 'card' ? `card ${q.field}` : q.path);
      return `${rule.bound} share price, against ${name(rule.assets)} per ${name(rule.shares)}`;
    }
  }
}

export type Fit = Extract<Kept, { kind: 'fit' }>;
type Misfit = Extract<Kept, { kind: 'misfit' }>;

function label(value: string, type: AbiType, fit: Fit, registry: Registry, anchorToken: Address | undefined, sender: string): string | undefined {
  if (type.kind !== 'address') return undefined;
  if (value === fit.sender.address) return sender;
  const named = registry.byAddress.get(value as Address)?.name;
  if (named !== undefined) return named;
  if (value === anchorToken) return 'the anchor token';
  if (value === ZERO) return 'the zero address';
  return 'another address';
}

const short = (value: string): string => (value.length > 24 ? `${value.slice(0, 18)}…(${(value.length - 2) / 2} bytes)` : value);

function distribution(run: PastTxs, fits: readonly Fit[], i: number, registry: Registry, sender: string): string {
  const type = fits[0]?.types[i] as AbiType;
  const counts = new Map<string, number>();
  const raw = new Set<string>();
  const labelOf = (value: string, fit: Fit) => label(value, type, fit, registry, run.query.anchor.token, sender);
  for (const fit of fits) {
    const value = fit.values[i] as string;
    raw.add(value);
    const name = labelOf(value, fit) ?? value;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (type.kind !== 'address' && counts.size > 3) return `${raw.size} distinct values`;
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${short(name)} in ${n}`);
  const others = type.kind === 'address' ? [...raw].filter((v) => labelOf(v, fits.find((f) => f.values[i] === v) as Fit) === 'another address').length : 0;
  return `${parts.join(', ')}${others > 1 ? ` (${others} distinct other addresses)` : ''}`;
}

const sendersOf = (studies: readonly { sender: Sender }[]): number => new Set(studies.map((s) => s.sender.address)).size;
const distinct = <T>(items: readonly T[]): number => new Set(items).size;

const examples = (hashes: readonly Hex[], n = 3): string => hashes.slice(0, n).join(', ');

const OUTSIDE: Readonly<Record<OutsideKind, string>> = { market: 'another market', token: 'a token outside the registry', vault: 'a vault outside the registry', address: 'an address outside the registry' };

type Group = { readonly fits: readonly Fit[]; readonly misfits: readonly Misfit[]; readonly rules: readonly LeafRule[]; readonly senderLabel: string; readonly senderNoun: string };

function renderGroup(lines: string[], group: Group, run: PastTxs, registry: Registry, mark: (hash: Hex) => string): void {
  const { fits, misfits, rules, senderLabel: sender, senderNoun: who } = group;
  const many = `${who}s`;
  lines.push(`fit the ${who === 'Safe' ? "template's" : "call's"} shape: ${plural(fits.length, 'transaction')} from ${plural(sendersOf(fits), who, many)}; misfits: ${misfits.length} from ${plural(sendersOf(misfits), who, many)}`);
  const outside = fits.filter((fit) => fit.outside.length > 0);
  if (outside.length > 0) {
    const exact = fits.filter((fit) => fit.outside.length === 0);
    const places = new Map<string, number>();
    for (const place of outside.flatMap((fit) => fit.outside.map((o) => `${OUTSIDE[o.kind]} at ${o.at}`))) places.set(place, (places.get(place) ?? 0) + 1);
    const where = [...places].sort((a, b) => b[1] - a[1]).map(([place, n]) => `${place} in ${n}`);
    lines.push(`  exactly the template: ${exact.length} from ${plural(sendersOf(exact), who, many)}; outside the registry: ${outside.length} from ${plural(sendersOf(outside), who, many)} (${where.join(', ')})`);
  }
  if (fits.length > 0) {
    lines.push(`fields, over the ${plural(fits.length, 'fitting transaction')}:`);
    const numbers = freeNumbers(fits, rules);
    const paths = fits[0]?.paths ?? [];
    rules.forEach((rule, i) => {
      const holding = fits.filter((fit) => brokenRule(rule, i, rules, fit.paths, fit.values, fit.sender) === undefined);
      lines.push(`  ${paths[i]}  [${describeRule(rule, sender)}]`);
      const heldText =
        rule.kind === 'free' || rule.kind === 'within-seconds' || rule.kind === 'equals' || rule.kind === 'share-price' || rule.kind === 'at-least' || rule.kind === 'at-most'
          ? ''
          : (rule.kind === 'address-word' ? rule.rule : rule).kind === 'card'
            ? `same as the other leaves bound to ${describeRule(rule, sender)} in ${holding.length} of ${fits.length}; `
            : `equalled ${describeRule(rule, sender)} in ${holding.length} of ${fits.length} (${plural(sendersOf(holding), who, many)}); `;
      const number = numbers.find((n) => n.path === paths[i]);
      lines.push(`    ${heldText}values: ${number === undefined ? distribution(run, fits, i, registry, sender) : spreadText(number)}`);
    });
  }
  if (misfits.length > 0) {
    lines.push('misfits, by reason:');
    const names = functionNames(run.query.template);
    const groups = new Map<string, Misfit[]>();
    for (const m of misfits) {
      const reason = misfitText(m.reason, registry, names);
      groups.set(reason, [...(groups.get(reason) ?? []), m]);
    }
    for (const [reason, members] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  ${members.length} from ${plural(sendersOf(members), who, many)}: ${reason}`);
      lines.push(`    e.g. ${members.slice(0, 3).map((m) => mark(m.hash)).join(', ')}`);
    }
  }
  const exactFirst = [...fits.filter((fit) => fit.outside.length === 0), ...fits.filter((fit) => fit.outside.length > 0)];
  if (fits.length > 0) lines.push(`examples that fit: ${exactFirst.slice(0, 3).map((f) => mark(f.hash)).join(', ')}`);
}

function spreadText({ time, spread, unrecorded }: FreeNumber): string {
  const missing = unrecorded === 0 ? '' : `; block time not recorded for ${unrecorded}`;
  if (spread === undefined) return `${time ? "less the block's time: " : ''}none${missing}`;
  const percentiles = PERCENTILES.map((p, i) => `p${p} ${spread.percentiles[i]}`).join(', ');
  return `${time ? "less the block's time, in seconds: " : ''}${plural(spread.count, 'transaction')}, min ${spread.min}, ${percentiles}, max ${spread.max}${missing}`;
}

/** One token an effect moved in the measured transactions: each party's differences, and the sender types they came from. */
type TokenAmounts = {
  readonly token: Address;
  /** A registry entry, which a card can name; only such a token gives a finding. */
  readonly inRegistry: boolean;
  readonly sender: readonly Difference[];
  readonly receiver: readonly Difference[];
  readonly safes: number;
  readonly eoas: number;
};

/** A measured effect the report shows: one whose differences are not all 0, or that declares a tolerance. */
type EffectAmounts = {
  readonly effect: StatedEffect;
  readonly tokens: readonly TokenAmounts[];
  readonly finding: ReturnType<typeof toleranceFinding>;
};

type Amounts = { readonly effects: readonly EffectAmounts[]; readonly unmeasured: ReadonlyMap<string, readonly Hex[]> };

export function amountsOf(run: PastTxs, registry: Registry): Amounts {
  const senderOf = new Map(run.studies.flatMap((s) => (s.kind === 'fit' ? [[s.hash, s.sender] as const] : [])));
  const measured = [...run.measurements].flatMap(([hash, m]) => (m.kind === 'measured' ? m.differences.map((d) => ({ hash, d })) : []));
  const effects = run.effects.flatMap((effect, i): EffectAmounts[] => {
    const mine = measured.filter(({ d }) => d.effect === i);
    if (!shown(effect, mine.map(({ d }) => d))) return [];
    const tokens = [...new Set(mine.map(({ d }) => d.token))].map((token): TokenAmounts => {
      const of = mine.filter(({ d }) => d.token === token);
      const sender = of.filter(({ d }) => d.party === 'sender');
      const kinds = sender.map(({ hash }) => senderOf.get(hash)?.kind);
      return {
        token,
        inRegistry: registry.byAddress.has(token),
        sender: sender.map(({ d }) => d),
        receiver: of.filter(({ d }) => d.party === 'receiver').map(({ d }) => d),
        safes: kinds.filter((k) => k === 'safe').length,
        eoas: kinds.filter((k) => k === 'eoa').length,
      };
    });
    return [{ effect, tokens, finding: toleranceFinding(effect, tokens.filter((t) => t.inRegistry).flatMap((t) => t.sender)) }];
  });
  const unmeasured = new Map<string, Hex[]>();
  if (effects.length > 0) for (const [hash, m] of run.measurements) if (m.kind === 'unmeasured') unmeasured.set(m.why, [...(unmeasured.get(m.why) ?? []), hash]);
  return { effects, unmeasured };
}

const unitsText = (n: bigint): string => `${n} base unit${n === 1n ? '' : 's'}`;
const byText = (by: bigint): string => (by === 0n ? 'exact' : `${unitsText(by < 0n ? -by : by)} ${by < 0n ? 'lower' : 'higher'}`);

/** Such as `2 base units lower in 8, 1 base unit lower in 10, exact in 20; at most 2 base units lower`. */
function distributionText(differences: readonly Difference[]): string {
  const { counts, lowest, highest } = distributionOf(differences);
  const parts = [...counts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([by, n]) => `${byText(by)} in ${n}`);
  const extremes = [lowest < 0n ? `${unitsText(-lowest)} lower` : '', highest > 0n ? `${unitsText(highest)} higher` : ''].filter((t) => t !== '');
  return `${parts.join(', ')}; at most ${extremes.length === 0 ? '0 base units either way' : extremes.join(' and ')}`;
}

const toleranceText = (effect: StatedEffect): string =>
  effect.tolerance === undefined ? 'none declared, so 0' : `${unitsText(effect.tolerance.less)} lower, ${unitsText(effect.tolerance.more)} higher`;

function renderAmounts(lines: string[], run: PastTxs, registry: Registry): void {
  const { effects, unmeasured } = amountsOf(run, registry);
  if (effects.length === 0) return;
  lines.push("amounts against balances, each transaction run alone on its parent block (shown for an effect that declares a tolerance or whose balances did not all change by exactly the stated amount):");
  for (const { effect, tokens, finding } of effects) {
    lines.push(`  ${effectText(effect)}; tolerance: ${toleranceText(effect)}`);
    for (const t of tokens) {
      const name = registry.byAddress.get(t.token)?.name;
      lines.push(`    ${name === undefined ? `${checksumAddress(t.token)}, outside the registry, so no card can name it and it gives no finding` : `${name} ${checksumAddress(t.token)}`}: ${plural(t.sender.length, 'transaction')}, ${t.safes} from Safes, ${t.eoas} from EOAs`);
      lines.push(`      the sender: ${distributionText(t.sender)}`);
      if (t.receiver.length > 0) lines.push(`      the receiver: ${distributionText(t.receiver)}`);
    }
    if (finding?.kind === 'beyond') {
      const ends = [finding.lower > 0n ? `${unitsText(finding.lower)} lower` : '', finding.higher > 0n ? `${unitsText(finding.higher)} higher` : ''].filter((x) => x !== '').join(' and ');
      lines.push(`    FINDING: a sender's balance ended up to ${ends} than stated, beyond the tolerance; such a transaction to sign would be MISMATCH`);
    }
    if (finding?.kind === 'unfounded') lines.push('    FINDING: a tolerance is declared, but no measured transaction ended other than exactly as stated: no evidence for it');
  }
  for (const [why, hashes] of unmeasured) lines.push(`  not measured, ${why}: ${hashes.length}, e.g. ${examples(hashes)}`);
}

function renderTraces(lines: string[], run: PastTxs): void {
  if (run.traces.length === 0) return;
  const traced = run.traces.filter((t) => t.kind === 'traced').length;
  lines.push(`call traces, from drpc, of the transactions exactly the template: ${plural(run.traces.length, 'transaction')}, ${traced} checked against the receipt both providers agree on`);
  const why = new Map<string, Hex[]>();
  for (const t of run.traces) if (t.kind === 'unverifiable') why.set(t.why, [...(why.get(t.why) ?? []), t.hash]);
  for (const [reason, hashes] of why) lines.push(`  UNVERIFIABLE, ${reason}: ${hashes.length}, e.g. ${examples(hashes)}`);
}

function chosenText({ safes, safesChosen, rest, restChosen }: Selection, checked: boolean): string {
  if (!checked) return `${restChosen === rest ? 'all ' : `${restChosen} of `}${plural(rest, 'transaction')}`;
  const withSafe = safes === 0 ? 'no transaction with a proven Safe party' : `${safesChosen === safes ? 'all ' : `${safesChosen} of `}${plural(safes, 'transaction')} with a proven Safe party`;
  return `${withSafe}, and ${restChosen === rest ? `all ${rest} others` : `${restChosen} of the other ${rest}`}`;
}

/** What a reader of the report sees. Never names the configured Safe, and names no other sender either. */
export function renderPastTxs(run: PastTxs, registry: Registry): string {
  const { anchor, template, sampling } = run.query;
  const lines: string[] = [];
  const named = (address: Address): string => registry.byAddress.get(address)?.name ?? checksumAddress(address);
  const moved = `moved${anchor.from === undefined ? '' : ` out of ${named(anchor.from)}`}${anchor.to === undefined ? '' : ` into ${named(anchor.to)}`}`;
  const of = anchor.token === undefined ? 'any contract, studied only where the sender logged it itself' : `${registry.byAddress.get(anchor.token)?.name ?? ''} ${checksumAddress(anchor.token)}`.trim();
  lines.push(`past transactions for ${template.id}`);
  if (anchor.kind === 'event') lines.push(`anchor: ${anchor.event?.signature} logged by ${of}`);
  else lines.push(`anchor: Transfer of ${of} ${{ mint: 'minted (from the zero address)', burn: 'burned (to the zero address)', any: moved }[anchor.kind]}`);
  const { year } = run;
  const blocks = (range: BlockRange) => `blocks ${range.fromBlock} to ${range.toBlock}`;
  if (year?.kind === 'covered' && year.safesFirst === undefined) {
    lines.push(`whole year: ${blocks(year.range)}, every source's answer in one page, so the search covers the year with no gap; at most ${run.perWindow} studied, taken evenly in block order`);
  } else if (year?.kind === 'covered') {
    const pages = [...year.pages].map(([source, n]) => `${source} in ${plural(n, 'page')}`).join(' and ');
    lines.push(`whole year: ${blocks(year.range)}, ${pages} of up to ${PAGE}, so the search covers the year with no gap`);
  } else if (sampling.kind !== 'range') {
    if (year !== undefined) {
      const over = year.pages === 1 ? 'more than one page of a source' : `more than ${year.pages} pages of ${PAGE} in ${year.sources.join(' and ')}`;
      lines.push(`whole year: ${blocks(year.range)} hold ${over}, so the windows are searched`);
    }
    lines.push(`windows: ${WINDOWS.count} of up to ${WINDOWS.blocks} blocks, one every ${YEAR / BigInt(WINDOWS.count)} blocks over the last year; at most ${run.perWindow} studied per window`);
  } else lines.push('windows: one block range given by hand');
  for (const { asked, range, found, studied } of run.windows) {
    const halved = asked.fromBlock === range.fromBlock ? '' : `; halved, too many transfers in ${asked.fromBlock} to ${asked.toBlock}, so ${asked.fromBlock} to ${range.fromBlock - 1n} not searched`;
    lines.push(`  ${blocks(range)}: ${found} found, ${studied} studied${halved}`);
  }
  if (year?.kind === 'covered' && year.safesFirst !== undefined) {
    const { check, selection } = year.safesFirst;
    const unreadable = check.kind === 'checked' && check.unreadable > 0 ? `, ${check.unreadable} unreadable` : '';
    lines.push(
      check.kind === 'checked'
        ? `anchor parties, ${check.noun}: ${check.parties}, read at block ${check.block}: ${plural(check.safes, 'proven Safe')}${unreadable}`
        : `anchor parties: not checked, ${check.why}`,
    );
    lines.push(`chosen to study: ${chosenText(selection, check.kind === 'checked')}, taken evenly in block order`);
  }

  const bySource = (source: SourceName) => [...run.found].filter(([, s]) => s.includes(source)).length;
  const only = (source: SourceName) => [...run.found].filter(([, s]) => s.length === 1 && s[0] === source).map(([hash]) => hash);
  const both = [...run.found].filter(([, s]) => s.length === SOURCES.length).length;
  const searched = searchedBy(anchor);
  if (searched.length === SOURCES.length) {
    lines.push(`sources: alchemy found ${bySource('alchemy')}, etherscan found ${bySource('etherscan')}; both ${both}, only alchemy ${only('alchemy').length}, only etherscan ${only('etherscan').length}`);
    for (const source of SOURCES) {
      const hashes = only(source);
      if (hashes.length > 0) lines.push(`  only ${source}: ${hashes.join(', ')}`);
    }
  } else lines.push(`sources: etherscan found ${bySource('etherscan')}; alchemy does not search an event (its eth_getLogs reads at most 10 blocks at a time on the free plan)`);
  if (run.otherEmitter.length > 0) lines.push(`not studied, the event logged only by another contract than the sender: ${run.otherEmitter.length}, e.g. ${examples(run.otherEmitter)}`);
  const mark = (hash: Hex): string => {
    const sources = run.found.get(hash) ?? [];
    return sources.length === searched.length ? hash : `${hash} [only ${sources[0]}]`;
  };

  const n = run.studies.length;
  const fits = run.studies.filter((s): s is Fit => s.kind === 'fit');
  const misfits = run.studies.filter((s): s is Misfit => s.kind === 'misfit');
  const bySafe = (s: { sender: Sender }) => s.sender.kind === 'safe';
  const safes = [...fits, ...misfits].filter(bySafe);
  const eoas = [...fits, ...misfits].filter((s) => !bySafe(s));
  const unproven = run.studies.filter((s) => s.kind === 'unproven');
  const other = run.studies.filter((s) => s.kind === 'not-studied');
  lines.push(`senders, of ${plural(n, 'transaction')} studied:`);
  lines.push(`  proven Safe: ${safes.length}, from ${plural(sendersOf(safes), 'Safe')}`);
  lines.push(`  contract, not a proven Safe: ${unproven.length}, from ${plural(distinct(unproven.map((s) => s.contract)), 'contract')}`);
  const unprovenGroups = new Map<string, Hex[]>();
  for (const s of unproven) unprovenGroups.set(s.why, [...(unprovenGroups.get(s.why) ?? []), s.hash]);
  for (const [why, hashes] of unprovenGroups) lines.push(`    ${hashes.length} ${why}: ${examples(hashes)}`);
  lines.push(`  EOA calling a function of the template directly: ${eoas.length}, from ${plural(sendersOf(eoas), 'EOA')}`);
  lines.push(`  neither: ${other.length}`);
  const whyGroups = new Map<string, Map<string, number>>();
  for (const s of other) {
    const selectors = whyGroups.get(s.why) ?? new Map<string, number>();
    selectors.set(s.selector, (selectors.get(s.selector) ?? 0) + 1);
    whyGroups.set(s.why, selectors);
  }
  for (const [why, selectors] of whyGroups) {
    const count = [...selectors.values()].reduce((a, b) => a + b, 0);
    const top = [...selectors].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([sel, k]) => `${sel} in ${k}`).join(', ');
    lines.push(`    ${count} ${why} (called ${top}${selectors.size > 4 ? ', …' : ''})`);
  }
  const unreadable = run.studies.filter((s) => s.kind === 'unreadable');
  const unreadableGroups = new Map<string, Hex[]>();
  for (const s of unreadable) unreadableGroups.set(s.reason, [...(unreadableGroups.get(s.reason) ?? []), s.hash]);
  for (const [reason, hashes] of [...unreadableGroups].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${hashes.length} unreadable, ${reason}: ${examples(hashes)}`);
  }

  renderAmounts(lines, run, registry);
  renderTraces(lines, run);
  lines.push('by proven Safes, the whole template in one transaction:');
  const otherOperation = misfits.filter((m) => isOtherOperation(m, template));
  if (otherOperation.length > 0) {
    lines.push(`another operation, making none of the template's calls: ${plural(otherOperation.length, 'transaction')} from ${plural(sendersOf(otherOperation), 'Safe')}; not counted below`);
    const names = functionNames(template);
    for (const m of otherOperation.slice(0, 3)) lines.push(`  e.g. ${mark(m.hash)}: ${misfitText(m.reason, registry, names)}`);
  }
  renderGroup(lines, { fits: fits.filter(bySafe), misfits: misfits.filter((m) => bySafe(m) && !isOtherOperation(m, template)), rules: run.shapes.whole.loosened.rules, senderLabel: 'the Safe', senderNoun: 'Safe' }, run, registry, mark);
  run.shapes.calls.forEach((shape, call) => {
    const ofCall = (s: { sender: Sender }) => s.sender.kind === 'eoa' && s.sender.call === call;
    const group = { fits: fits.filter(ofCall), misfits: misfits.filter(ofCall), rules: shape.loosened.rules, senderLabel: 'the sender', senderNoun: 'EOA' };
    if (group.fits.length + group.misfits.length === 0) return;
    const data = shape.template.calls[0]?.data;
    lines.push(`by EOAs, call ${call + 1} of ${run.shapes.calls.length} (${data === undefined || data === 'empty' ? 'no data' : data.fn.name}) as its own transaction:`);
    renderGroup(lines, group, run, registry, mark);
  });
  return `${lines.join('\n')}\n`;
}
