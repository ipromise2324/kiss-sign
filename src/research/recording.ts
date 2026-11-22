import { replayReader, trimBlockAnswers } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import type { ProviderName } from '../chain/providers.ts';
import type { Registry } from '../registry.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { Template } from '../template/template.ts';
import { replayMessages } from './messages.ts';
import type { MessageExchange } from './messages.ts';
import { pastTxs } from './past-txs.ts';
import type { BlockRange, ExcludedHashes, PastTxs, PastTxsQuery } from './past-txs.ts';
import { RANGE_PAGES, anchorEvent, replayAsk } from './sources.ts';
import type { AnchorKind, SourceExchange } from './sources.ts';
import { replayTraces } from './trace.ts';
import type { RecordedTrace } from './trace.ts';

/** One `past-txs --record` run: its query, every search answer, and every chain read with each provider's answer. */
export type PastTxsRecording = {
  /** Which search the run made is `samplingOf(query)`. */
  readonly query: {
    readonly template: string;
    /** Absent only for an event each Safe logs about itself. */
    readonly token?: string;
    readonly anchor: string;
    readonly from?: string;
    readonly to?: string;
    /** The canonical signature of an `event` anchor. */
    readonly event?: string;
    readonly fromBlock?: string;
    readonly toBlock?: string;
    readonly head?: string;
    /** Legacy: the run asked the whole year in one page first, else searched the windows. */
    readonly wholeYear?: true;
    /** Legacy: the run paged the whole year up to this many pages per source, else searched the windows. */
    readonly yearPages?: number;
    /** The run paged back from the year's last block, newest first, until the year was read or its ranges took this many pages. */
    readonly maxPages?: number;
    readonly maxTxs: number;
  };
  readonly sources: readonly SourceExchange[];
  /** The transactions the run left out for touching the configured Safe; absent when it left out none. */
  readonly excluded?: { readonly found: readonly Hex[]; readonly sampled: readonly Hex[] };
  /** Each signed message read from a template's `lookup`; absent in a recording from before messages. */
  readonly messages?: readonly MessageExchange[];
  readonly providers: readonly ProviderName[];
  readonly exchanges: readonly Exchange[];
  /** Each traced transaction's calls from drpc, cut down; absent in a recording from before traces. */
  readonly traces?: readonly RecordedTrace[];
};

/** Legacy: the most pages of 1,000 a recording made before the newest-first search asked each source for the year. */
export const YEAR_PAGES = RANGE_PAGES;

/**
 * The pages of 1,000 a newest-first search's block ranges may take, each counted by the source that took the most: about
 * 30,000 transfers, 25 seconds of search and 2 minutes of party reads for USDC moving into Uniswap's PoolManager.
 */
export const MAX_PAGES = 50;
/** The fewest a query may hold: the whole year, asked first, may take `RANGE_PAGES` and not finish. */
export const MIN_PAGES = 2 * RANGE_PAGES;

/**
 * The search a run makes. `recent`: back from the year's last block, placed by the head block, newest first, until the
 * year is read or its ranges have taken `maxPages` pages; each anchor party is checked for a Safe and the Safes'
 * transactions studied first. `range`: one block range given by hand, refused when it holds more than a page.
 * Legacy until every summary is recorded again, these only replay older recordings: `year` (the year paged up to
 * `pages` pages, else the windows), `old-year` (the year in one page, no party check) and `old-windows` (the windows
 * alone).
 */
export type Sampling =
  | { readonly kind: 'recent'; readonly head?: bigint; readonly maxPages: number }
  | { readonly kind: 'year'; readonly head?: bigint; readonly pages: number }
  | { readonly kind: 'old-year'; readonly head?: bigint }
  | { readonly kind: 'old-windows'; readonly head?: bigint }
  | { readonly kind: 'range'; readonly range: BlockRange };

export const DEFAULT_SAMPLING: Extract<Sampling, { readonly kind: 'recent' }> = { kind: 'recent', maxPages: MAX_PAGES };

type SamplingFields = Pick<PastTxsRecording['query'], 'fromBlock' | 'toBlock' | 'head' | 'wholeYear' | 'yearPages' | 'maxPages'>;

/** The search a recording's query made, so a replay or `--same-windows-as` makes it again; never a newer one. */
export function samplingOf(query: SamplingFields): Sampling {
  if (query.fromBlock !== undefined && query.toBlock !== undefined) return { kind: 'range', range: { fromBlock: BigInt(query.fromBlock), toBlock: BigInt(query.toBlock) } };
  const head = query.head === undefined ? {} : { head: BigInt(query.head) };
  if (query.maxPages !== undefined) return { kind: 'recent', maxPages: query.maxPages, ...head };
  if (query.yearPages !== undefined) return { kind: 'year', pages: query.yearPages, ...head };
  return { kind: query.wholeYear === true ? 'old-year' : 'old-windows', ...head };
}

/** The query fields that record `sampling` as run from `head`. */
export function samplingFields(sampling: Sampling, head: bigint | undefined): SamplingFields {
  if (sampling.kind === 'range') return { fromBlock: sampling.range.fromBlock.toString(), toBlock: sampling.range.toBlock.toString() };
  return {
    ...(head === undefined ? {} : { head: head.toString() }),
    ...(sampling.kind === 'old-year' ? { wholeYear: true as const } : {}),
    ...(sampling.kind === 'year' ? { yearPages: sampling.pages } : {}),
    ...(sampling.kind === 'recent' ? { maxPages: sampling.maxPages } : {}),
  };
}

const mentions = (value: unknown, needles: readonly string[]): boolean => {
  const text = JSON.stringify(value).toLowerCase();
  return needles.some((needle) => text.includes(needle));
};

const redact = (value: unknown, needles: readonly string[]): unknown => {
  if (typeof value === 'string') return needles.reduce((text, needle) => text.replace(new RegExp(needle, 'gi'), '0'.repeat(needle.length)), value);
  if (Array.isArray(value)) return value.map((item) => redact(item, needles));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, needles)]));
  return value;
};

/**
 * Writes the configured Safe's address nowhere. In each search answer it is replaced by zeros, so every transaction the
 * search found keeps its place, the Safe's own included; `excluded` lists the transactions the run left out for
 * touching the Safe, so a replay leaves out the same without the address. Every chain read, signed message and call
 * trace that holds the address is dropped, after each block is cut to its header, which is all a replay reads of it. A
 * recording that still holds the address is refused.
 */
export function scrubRecording(recording: PastTxsRecording, safes: readonly string[], excluded: ExcludedHashes): PastTxsRecording {
  const needles = safes.map((f) => f.toLowerCase().replace(/^0x/, ''));
  const sources = recording.sources.map(({ request, answer }) => ({ request, answer: redact(answer, needles) }));
  const messages = recording.messages === undefined ? {} : { messages: recording.messages.filter((m) => !mentions(m, needles)) };
  const traces = recording.traces === undefined ? {} : { traces: recording.traces.filter((t) => !mentions(t, needles)) };
  const left = excluded.found.size + excluded.sampled.size === 0 ? {} : { excluded: { found: [...excluded.found], sampled: [...excluded.sampled] } };
  const scrubbed = { ...recording, sources, ...left, ...messages, ...traces, exchanges: recording.exchanges.map(trimBlockAnswers).filter((e) => !mentions(e, needles)) };
  if (mentions(scrubbed, needles)) throw new Error('the recording still holds the configured Safe\'s address; nothing written');
  return scrubbed;
}

/** The anchor a recording's query searched. */
export const anchorOf = (query: PastTxsRecording['query']): PastTxsQuery['anchor'] => ({
  ...(query.token === undefined ? {} : { token: query.token as Address }),
  kind: query.anchor as AnchorKind,
  ...(query.from === undefined ? {} : { from: query.from as Address }),
  ...(query.to === undefined ? {} : { to: query.to as Address }),
  ...(query.event === undefined ? {} : { event: anchorEvent(query.event) }),
});

/** The run a recording holds, studied again from its answers alone with `template` and `registry`. */
export function replayPastTxs(recording: PastTxsRecording, template: Template, registry: Registry): Promise<PastTxs> {
  const { query } = recording;
  return pastTxs(
    { template, anchor: anchorOf(query), sampling: samplingOf(query) },
    {
      ask: replayAsk(recording.sources),
      reader: replayReader(recording.exchanges),
      registry,
      readMessage: replayMessages(recording.messages ?? []),
      exclude: undefined,
      maxTxs: query.maxTxs,
      traces: replayTraces(recording.traces),
      excludedByRecording: { found: new Set(recording.excluded?.found ?? []), sampled: new Set(recording.excluded?.sampled ?? []) },
    },
  );
}
