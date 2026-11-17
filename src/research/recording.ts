import type { Exchange } from '../chain/recording.ts';
import type { ProviderName } from '../chain/providers.ts';
import type { MessageExchange } from './messages.ts';
import type { SourceExchange } from './sources.ts';

/** One `past-txs --record` run: its query, every search answer, and every chain read with each provider's answer. */
export type PastTxsRecording = {
  /** Without `fromBlock` and `toBlock`, the run used the default spread of windows. */
  readonly query: {
    readonly template: string;
    readonly token: string;
    readonly anchor: string;
    readonly from?: string;
    readonly to?: string;
    /** The canonical signature of an `event` anchor. */
    readonly event?: string;
    readonly fromBlock?: string;
    readonly toBlock?: string;
    readonly head?: string;
    readonly maxTxs: number;
  };
  readonly sources: readonly SourceExchange[];
  /** Each signed message read from a template's `lookup`; absent in a recording from before messages. */
  readonly messages?: readonly MessageExchange[];
  readonly providers: readonly ProviderName[];
  readonly exchanges: readonly Exchange[];
};

const mentions = (value: unknown, needles: readonly string[]): boolean => {
  const text = JSON.stringify(value).toLowerCase();
  return needles.some((needle) => text.includes(needle));
};

/**
 * Drops every search entry and chain read that mentions a forbidden address or transaction hash, then refuses a
 * recording that still mentions one. The configured Safe and its transactions never reach a fixture.
 */
export function scrubRecording(recording: PastTxsRecording, forbidden: readonly string[]): PastTxsRecording {
  const needles = forbidden.map((f) => f.toLowerCase().replace(/^0x/, ''));
  const keep = (list: unknown) => (Array.isArray(list) ? list.filter((item) => !mentions(item, needles)) : list);
  const sources = recording.sources.map(({ request, answer }) => {
    if (typeof answer !== 'object' || answer === null) return { request, answer };
    const fields = answer as Record<string, unknown>;
    return { request, answer: { ...fields, ...('transfers' in fields ? { transfers: keep(fields.transfers) } : {}), ...('result' in fields ? { result: keep(fields.result) } : {}) } };
  });
  const messages = recording.messages === undefined ? {} : { messages: recording.messages.filter((m) => !mentions(m, needles)) };
  const scrubbed = { ...recording, sources, ...messages, exchanges: recording.exchanges.filter((e) => !mentions(e, needles)) };
  if (mentions(scrubbed, needles)) throw new Error('the recording still mentions the configured Safe or one of its transactions; nothing written');
  return scrubbed;
}
