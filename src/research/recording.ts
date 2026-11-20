import { trimBlockAnswers } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import type { ProviderName } from '../chain/providers.ts';
import type { MessageExchange } from './messages.ts';
import type { SourceExchange } from './sources.ts';
import type { RecordedTrace } from './trace.ts';
import type { BlockRange, ExcludedHashes } from './past-txs.ts';
import type { Hex } from '../safe/types.ts';

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
    /** The run asked the whole year in one page first; absent in a recording made before it did, or after it paged. */
    readonly wholeYear?: true;
    /** The run paged the whole year up to this many pages per source and checked each anchor party for a Safe. */
    readonly yearPages?: number;
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

/** The most pages of 1,000 a run asks each source for the year; Etherscan refuses a page beyond 10,000 results. */
export const YEAR_PAGES = 10;

/**
 * The search a run makes. `year`: the last year, placed by the head block, paged up to `pages` pages per source, and
 * when every source finished within them each anchor party is checked for a Safe and the Safes' transactions studied
 * first; otherwise the windows. `range`: one block range given by hand, refused when it holds more than a page.
 * `old-year` (the year in one page, no party check) and `old-windows` (the windows alone) only replay recordings made
 * before the year was paged.
 */
export type Sampling =
  | { readonly kind: 'year'; readonly head?: bigint; readonly pages: number }
  | { readonly kind: 'old-year'; readonly head?: bigint }
  | { readonly kind: 'old-windows'; readonly head?: bigint }
  | { readonly kind: 'range'; readonly range: BlockRange };

export const DEFAULT_SAMPLING: Sampling = { kind: 'year', pages: YEAR_PAGES };

type SamplingFields = Pick<PastTxsRecording['query'], 'fromBlock' | 'toBlock' | 'head' | 'wholeYear' | 'yearPages'>;

/** The search a recording's query made, so a replay or `--same-windows-as` makes it again; never a newer one. */
export function samplingOf(query: SamplingFields): Sampling {
  if (query.fromBlock !== undefined && query.toBlock !== undefined) return { kind: 'range', range: { fromBlock: BigInt(query.fromBlock), toBlock: BigInt(query.toBlock) } };
  const head = query.head === undefined ? {} : { head: BigInt(query.head) };
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
