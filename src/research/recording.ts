import type { Exchange } from '../chain/recording.ts';
import type { ProviderName } from '../chain/providers.ts';
import type { MessageExchange } from './messages.ts';
import type { SourceExchange } from './sources.ts';
import type { RecordedTrace } from './trace.ts';
import type { ExcludedHashes } from './past-txs.ts';
import type { Hex } from '../safe/types.ts';

/** One `past-txs --record` run: its query, every search answer, and every chain read with each provider's answer. */
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
 * trace that holds the address is dropped: those are the reads that left a transaction out. A recording that still
 * holds the address is refused.
 */
export function scrubRecording(recording: PastTxsRecording, safes: readonly string[], excluded: ExcludedHashes): PastTxsRecording {
  const needles = safes.map((f) => f.toLowerCase().replace(/^0x/, ''));
  const sources = recording.sources.map(({ request, answer }) => ({ request, answer: redact(answer, needles) }));
  const messages = recording.messages === undefined ? {} : { messages: recording.messages.filter((m) => !mentions(m, needles)) };
  const traces = recording.traces === undefined ? {} : { traces: recording.traces.filter((t) => !mentions(t, needles)) };
  const left = excluded.found.size + excluded.sampled.size === 0 ? {} : { excluded: { found: [...excluded.found], sampled: [...excluded.sampled] } };
  const scrubbed = { ...recording, sources, ...left, ...messages, ...traces, exchanges: recording.exchanges.filter((e) => !mentions(e, needles)) };
  if (mentions(scrubbed, needles)) throw new Error('the recording still holds the configured Safe\'s address; nothing written');
  return scrubbed;
}
