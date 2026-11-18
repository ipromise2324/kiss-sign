import type { Exchange } from '../chain/recording.ts';
import type { ProviderName } from '../chain/providers.ts';
import type { MessageExchange } from './messages.ts';
import type { SourceExchange } from './sources.ts';
import type { RecordedTrace } from './trace.ts';
import type { PastTxs } from './past-txs.ts';
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
  /** The withheld hashes of sampled transactions the run left out because they touch the configured Safe. */
  readonly excluded?: readonly Hex[];
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

/**
 * What a recording writes in place of a found transaction's hash it did not study: a number no real hash holds, the
 * same for every answer that found that transaction, so a replay finds and samples the same.
 */
const withheld = (n: number): Hex => `0x${'00'.repeat(28)}${n.toString(16).padStart(8, '0')}` as Hex;
export const isWithheld = (hash: Hex): boolean => /^0x0{56}[0-9a-f]{8}$/.test(hash);

type Studied = Pick<PastTxs, 'studies' | 'otherEmitter' | 'excluded'>;

/**
 * The search answers with only the hashes of the transactions the run studied. A transaction it found but did not study
 * keeps its place under a withheld hash, so the found counts and the sample replay the same; one the run left out
 * because it touches the configured Safe is listed in `excluded` under that hash; and every entry of a transaction one
 * of whose entries names the Safe is dropped, as the search dropped it before sampling.
 */
function withholdHashes(sources: readonly SourceExchange[], needles: readonly string[], run: Studied): { sources: SourceExchange[]; excluded: Hex[] } {
  const studied = new Set<string>([...run.studies.map((s) => s.hash), ...run.otherEmitter]);
  const hashOf = (entry: Record<string, unknown>): string => String(entry.hash ?? entry.transactionHash).toLowerCase();
  const isEntry = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && ('hash' in item || 'transactionHash' in item);
  const lists = sources.map(({ answer }) => {
    const fields = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {};
    return [fields.transfers, fields.result].flatMap((list) => (Array.isArray(list) ? list.filter(isEntry) : []));
  });
  const dropped = new Set(lists.flat().filter((entry) => mentions(entry, needles)).map(hashOf));
  const placeholders = new Map<string, Hex>();
  const replace = (entry: Record<string, unknown>): Record<string, unknown> => {
    const hash = hashOf(entry);
    if (studied.has(hash)) return entry;
    const placeholder = placeholders.get(hash) ?? withheld(placeholders.size);
    placeholders.set(hash, placeholder);
    return 'hash' in entry ? { ...entry, hash: placeholder } : { ...entry, transactionHash: placeholder };
  };
  const keep = (list: unknown) => (Array.isArray(list) ? list.flatMap((item) => (!isEntry(item) ? [item] : dropped.has(hashOf(item)) ? [] : [replace(item)])) : list);
  const scrubbed = sources.map(({ request, answer }) => {
    if (typeof answer !== 'object' || answer === null) return { request, answer };
    const fields = answer as Record<string, unknown>;
    return { request, answer: { ...fields, ...('transfers' in fields ? { transfers: keep(fields.transfers) } : {}), ...('result' in fields ? { result: keep(fields.result) } : {}) } };
  });
  return { sources: scrubbed, excluded: [...run.excluded].flatMap((hash) => placeholders.get(hash.toLowerCase()) ?? []) };
}

/**
 * Keeps no hash of a transaction the run did not study (see `withholdHashes`), drops every chain read, message and call
 * trace that mentions the configured Safe or one of its transactions, then refuses a recording that still mentions
 * one. The configured Safe and its transactions never reach a fixture.
 */
export function scrubRecording(recording: PastTxsRecording, safes: readonly string[], run: Studied): PastTxsRecording {
  const needles = [...safes, ...run.excluded].map((f) => f.toLowerCase().replace(/^0x/, ''));
  const { sources, excluded } = withholdHashes(recording.sources, safes.map((f) => f.toLowerCase().replace(/^0x/, '')), run);
  const messages = recording.messages === undefined ? {} : { messages: recording.messages.filter((m) => !mentions(m, needles)) };
  const traces = recording.traces === undefined ? {} : { traces: recording.traces.filter((t) => !mentions(t, needles)) };
  const scrubbed = {
    ...recording,
    sources,
    ...(excluded.length === 0 ? {} : { excluded }),
    ...messages,
    ...traces,
    exchanges: recording.exchanges.filter((e) => !mentions(e, needles)),
  };
  if (mentions(scrubbed, needles)) throw new Error('the recording still mentions the configured Safe or one of its transactions; nothing written');
  return scrubbed;
}
