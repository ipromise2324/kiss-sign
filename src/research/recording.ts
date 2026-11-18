import type { Exchange } from '../chain/recording.ts';
import type { ProviderName } from '../chain/providers.ts';
import type { MessageExchange } from './messages.ts';
import type { SourceExchange } from './sources.ts';
import type { RecordedTrace } from './trace.ts';
import { trimBlockAnswers } from '../chain/recording.ts';
import type { PastTxs, RecordedSearch, YearSearch } from './past-txs.ts';
import { SOURCES } from './sources.ts';
import type { SourceName } from './sources.ts';
import { SafeTxParseError, parseAddress, parseHex } from '../safe/types.ts';
import type { Hex } from '../safe/types.ts';

type BlocksText = { readonly fromBlock: string; readonly toBlock: string };

/** A `RecordedSearch` as JSON: block numbers as decimal strings. */
export type SearchText = {
  readonly year?: BlocksText & { readonly covered: boolean };
  readonly perWindow: number;
  readonly windows: readonly { readonly asked: BlocksText; readonly range: BlocksText; readonly found: number; readonly studied: number }[];
  readonly sampled: readonly { readonly hash: string; readonly sources: readonly string[]; readonly emitters: readonly string[] }[];
  readonly unsampled: readonly { readonly sources: readonly string[]; readonly count: number }[];
};

/**
 * One `past-txs --record` run: its query, what the search found (`search`, or in a recording made before it, every
 * search answer in `sources`), and every chain read with each provider's answer.
 */
export type PastTxsRecording = {
  /** Without `fromBlock` and `toBlock`, the run used the default spread of windows. */
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
    /** The run asked the whole year first; absent in a recording made before it did. */
    readonly wholeYear?: true;
    readonly maxTxs: number;
  };
  /** Empty in a recording that keeps `search`. */
  readonly sources: readonly SourceExchange[];
  readonly search?: SearchText;
  /** Each signed message read from a template's `lookup`; absent in a recording from before messages. */
  readonly messages?: readonly MessageExchange[];
  readonly providers: readonly ProviderName[];
  readonly exchanges: readonly Exchange[];
  /** Each traced transaction's calls from drpc, cut down; absent in a recording from before traces. */
  readonly traces?: readonly RecordedTrace[];
};

const blocksText = (range: { readonly fromBlock: bigint; readonly toBlock: bigint }): BlocksText => ({ fromBlock: `${range.fromBlock}`, toBlock: `${range.toBlock}` });

export function searchText(search: RecordedSearch): SearchText {
  return {
    ...(search.year === undefined ? {} : { year: { ...blocksText(search.year.range), covered: search.year.covered } }),
    perWindow: search.perWindow,
    windows: search.windows.map((w) => ({ asked: blocksText(w.asked), range: blocksText(w.range), found: w.found, studied: w.studied })),
    sampled: search.sampled.map((s) => ({ hash: s.hash, sources: s.sources, emitters: s.emitters })),
    unsampled: search.unsampled,
  };
}

/** A recorded search parsed; throws on a value `--record` never writes. */
export function parseSearch(text: SearchText): RecordedSearch {
  const fail = (what: string): never => {
    throw new SafeTxParseError('search', what);
  };
  const block = (v: unknown): bigint => (typeof v === 'string' && /^[0-9]+$/.test(v) ? BigInt(v) : fail('a block is not a decimal number'));
  const range = (r: BlocksText) => ({ fromBlock: block(r.fromBlock), toBlock: block(r.toBlock) });
  const count = (n: unknown): number => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : fail('a count is not a whole number'));
  const sources = (list: readonly string[]): SourceName[] =>
    list.length > 0 && list.every((s, i) => SOURCES.includes(s as SourceName) && list.indexOf(s) === i) ? (list as SourceName[]) : fail('a source list names no or an unknown source');
  const year: YearSearch | undefined = text.year === undefined ? undefined : { range: range(text.year), covered: text.year.covered === true };
  return {
    year,
    perWindow: count(text.perWindow),
    windows: text.windows.map((w) => ({ asked: range(w.asked), range: range(w.range), found: count(w.found), studied: count(w.studied) })),
    sampled: text.sampled.map((s) => ({ hash: parseHex('hash', s.hash), sources: sources(s.sources), emitters: s.emitters.map((e) => parseAddress('emitter', e)) })),
    unsampled: text.unsampled.map((u) => ({ sources: sources(u.sources), count: count(u.count) })),
  };
}

const HASH = /0x[0-9a-f]{64}/g;

/**
 * Keeps of the chain reads each block cut to its header, and refuses a recording of a search that found a transaction
 * the configured Safe sent or is named in, or one the run could not check: the search can be run again by anyone, so the
 * gap such a transaction leaves in the counts or the sample would point at it. It also refuses a recording that still
 * names the Safe, or holds the hash of a transaction the search found and the run did not sample.
 */
export function scrubRecording(recording: PastTxsRecording, safes: readonly string[], run: Pick<PastTxs, 'found' | 'excluded' | 'search'>): PastTxsRecording {
  if (run.excluded.size > 0) {
    throw new Error(
      `the search found ${run.excluded.size} transaction(s) the configured Safe sent or is named in, or that could not be checked, and a recording would point at them; nothing written. Search other blocks with --from-block and --to-block`,
    );
  }
  const scrubbed = { ...recording, exchanges: recording.exchanges.map(trimBlockAnswers) };
  const sampled = new Set(run.search.sampled.map((s) => s.hash.toLowerCase()));
  const unsampled = new Set([...run.found.keys()].map((h) => h.toLowerCase()).filter((h) => !sampled.has(h)));
  const text = JSON.stringify(scrubbed).toLowerCase();
  const safe = safes.map((f) => f.toLowerCase().replace(/^0x/, '')).find((needle) => text.includes(needle));
  const hash = (text.match(HASH) ?? []).find((h) => unsampled.has(h));
  if (safe !== undefined || hash !== undefined) {
    throw new Error(`the recording still names ${safe !== undefined ? 'the configured Safe' : 'a transaction the run did not sample'}; nothing written`);
  }
  return scrubbed;
}
