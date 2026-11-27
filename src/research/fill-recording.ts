import { createReader } from '../chain/reader.ts';
import { REPLAY_ENDPOINTS, recordingTransport, replayTransport } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import type { Endpoint } from '../chain/providers.ts';
import type { Transport } from '../chain/rpc.ts';
import type { NoteUnread } from '../chain/https.ts';
import type { Registry } from '../registry.ts';
import { loadTemplate } from '../template/template.ts';
import { replayMessages } from './messages.ts';
import type { MessageExchange, ReadMessage } from './messages.ts';
import { pastTxs } from './past-txs.ts';
import { anchorOf, samplingOf, scrubRecording } from './recording.ts';
import type { PastTxsRecording } from './recording.ts';
import { replayAsk } from './sources.ts';
import { studyRegistry } from './study-registry.ts';
import { replayTraces } from './trace.ts';
import type { RecordedTrace, TraceSource } from './trace.ts';
import type { Hex } from '../safe/types.ts';

/** Where a read the recording lacks is asked: the chain providers, drpc for a call trace, and a template's lookup for a signed message. */
export type LiveReads = {
  readonly endpoints: readonly [Endpoint, Endpoint];
  readonly transport: Transport;
  readonly traces: { readonly source: TraceSource; readonly recorded: () => RecordedTrace[] };
  readonly messages: { readonly read: ReadMessage; readonly exchanges: () => MessageExchange[] };
  /** Each read of `traces` and `messages` that got no answer. */
  readonly unread: () => readonly string[];
};

export type Filled =
  /** The recording with every answer read live added; the same recording, with nothing read, when it lacked nothing. */
  | { readonly kind: 'kept'; readonly recording: PastTxsRecording; readonly read: { readonly chain: number; readonly traces: number; readonly messages: number } }
  /** Each read the study needs that the recording lacks and that got no answer, or holds the configured Safe's address, which no recording keeps. */
  | { readonly kind: 'lacking'; readonly reads: readonly string[] };

const requestKey = (exchange: Pick<Exchange, 'method' | 'params'>): string => `${exchange.method} ${JSON.stringify(exchange.params)}`;

/**
 * Studies `recording` with the checkout's template and registry, reading through `live` only what it lacks, such as the
 * trace, the run alone or the signed message of a transaction that fits the template now and did not when it was
 * recorded. The search and its anchor parties are never read again. Without `live`, nothing is read and each read the
 * recording lacks is `lacking`.
 */
export async function fillRecording(repoRoot: string, recording: PastTxsRecording, registry: Registry, live: LiveReads | undefined, safe: string | undefined): Promise<Filled> {
  const { query } = recording;
  const lacking = new Set<string>();
  const note: NoteUnread = (read) => void lacking.add(read);
  const endpoints = live?.endpoints ?? REPLAY_ENDPOINTS;
  const recorded = replayTransport(recording.exchanges, endpoints);
  const fetched = recordingTransport(
    live?.transport ??
      (async (_url, body) => {
        const { method, params } = JSON.parse(body) as { method: string; params: unknown };
        note(`${method} ${JSON.stringify(params)}: not in the recording`);
        throw new Error('not in the recording');
      }),
    endpoints,
  );
  const transport: Transport = (url, body, signal) => recorded(url, body, signal).catch(() => fetched.transport(url, body, signal));
  const replayed = replayTraces(recording.traces);
  const traces: TraceSource = async (hash: Hex) => {
    const trace = await replayed(hash);
    if (trace !== undefined) return trace;
    if (live !== undefined) return live.traces.source(hash);
    note(`debug_traceTransaction ${hash}: not in the recording`);
    return undefined;
  };
  const replayedMessages = replayMessages(recording.messages ?? []);
  const readMessage: ReadMessage = async (url, message) => {
    if ((recording.messages ?? []).some((m) => m.url === url)) return replayedMessages(url, message);
    if (live !== undefined) return live.messages.read(url, message);
    note(`${url}: not in the recording`);
    return { why: 'not recorded' };
  };
  await pastTxs(
    { template: loadTemplate(repoRoot, query.template, studyRegistry(registry)), anchor: anchorOf(query), sampling: samplingOf(query), ...(query.txParty === true ? { txParty: true } : {}) },
    {
      ask: replayAsk(recording.sources),
      reader: createReader(endpoints, transport, live === undefined ? { retryPausesMs: [], rateLimitPausesMs: [] } : { note }),
      batches: createReader(REPLAY_ENDPOINTS, replayTransport(recording.exchanges, REPLAY_ENDPOINTS), { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] }),
      registry,
      readMessage,
      exclude: undefined,
      maxTxs: query.maxTxs,
      traces,
      excludedByRecording: { found: new Set(recording.excluded?.found ?? []), sampled: new Set(recording.excluded?.sampled ?? []) },
    },
  );
  for (const read of live?.unread() ?? []) lacking.add(read);
  if (lacking.size > 0) return { kind: 'lacking', reads: [...lacking].sort() };

  const before = new Map<string, Exchange>();
  for (const exchange of recording.exchanges) if (!before.has(requestKey(exchange))) before.set(requestKey(exchange), exchange);
  const answered = fetched
    .exchanges()
    .map((e): Exchange => ({ method: e.method, params: e.params, answers: { ...before.get(requestKey(e))?.answers, ...e.answers } }))
    .filter((e) => recording.providers.every((p) => p in e.answers));
  const newTraces = live?.traces.recorded() ?? [];
  const newMessages = live?.messages.exchanges() ?? [];
  if (answered.length + newTraces.length + newMessages.length === 0) return { kind: 'kept', recording, read: { chain: 0, traces: 0, messages: 0 } };

  const replaced = new Map(answered.filter((e) => before.has(requestKey(e))).map((e) => [requestKey(e), e]));
  const added = answered.filter((e) => !before.has(requestKey(e)));
  const candidate: PastTxsRecording = {
    ...recording,
    exchanges: [...recording.exchanges.map((e) => replaced.get(requestKey(e)) ?? e), ...added],
    traces: [...(recording.traces ?? []), ...newTraces],
    messages: [...(recording.messages ?? []), ...newMessages],
  };
  const excluded = { found: new Set(recording.excluded?.found ?? []), sampled: new Set(recording.excluded?.sampled ?? []) };
  const filled = scrubRecording(candidate, safe === undefined ? [] : [safe], excluded);
  const kept = new Set(filled.exchanges.map(requestKey));
  const keptTraces = new Set((filled.traces ?? []).map((t) => t.hash));
  const keptMessages = new Set((filled.messages ?? []).map((m) => m.url));
  const dropped = [
    ...answered.filter((e) => !kept.has(requestKey(e))).map((e) => requestKey(e)),
    ...newTraces.filter((t) => !keptTraces.has(t.hash)).map((t) => `debug_traceTransaction ${t.hash}`),
    ...newMessages.filter((m) => !keptMessages.has(m.url)).map((m) => m.url),
  ];
  if (dropped.length > 0) return { kind: 'lacking', reads: dropped.map((read) => `${read}: its answer holds the configured Safe's address, which no recording keeps`).sort() };
  return { kind: 'kept', recording: filled, read: { chain: answered.length, traces: newTraces.length, messages: newMessages.length } };
}
