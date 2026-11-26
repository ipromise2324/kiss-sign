import type { Endpoint, ProviderName } from './providers.ts';
import { createReader } from './reader.ts';
import type { Reader } from './reader.ts';
import type { Transport } from './rpc.ts';

type ByProvider<T> = Partial<Record<ProviderName, T>>;

/**
 * A request and each provider's answer: its JSON-RPC `result` in `answers`, its JSON-RPC `error` in `errors`, or, when
 * the body held neither, its HTTP status in `statuses`. Never a URL, so a recording holds no key.
 */
export type Exchange = {
  readonly method: string;
  readonly params: unknown;
  readonly answers: ByProvider<unknown>;
  readonly errors?: ByProvider<unknown>;
  readonly statuses?: ByProvider<number>;
};

const BLOCK_FIELDS = ['number', 'hash', 'timestamp', 'gasLimit', 'mixHash'];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The exchange with each block it answers cut to the fields a block header is read from, leaving the transaction hashes and the rest out. */
export function trimBlockAnswers(exchange: Exchange): Exchange {
  if (exchange.method !== 'eth_getBlockByNumber' && exchange.method !== 'eth_getBlockByHash') return exchange;
  const pick = (block: unknown) => (isObject(block) ? Object.fromEntries(BLOCK_FIELDS.map((f) => [f, block[f]])) : block);
  return { ...exchange, answers: Object.fromEntries(Object.entries(exchange.answers).map(([provider, block]) => [provider, pick(block)])) };
}

type Recorded = { answers: ByProvider<unknown>; errors: ByProvider<unknown>; statuses: ByProvider<number> };

const sameRequest = (exchange: { method: string; params: unknown }, method: string, params: unknown): boolean =>
  exchange.method === method && JSON.stringify(exchange.params) === JSON.stringify(params);

function keep(exchange: Recorded, provider: ProviderName, status: number, text: string): void {
  delete exchange.answers[provider];
  delete exchange.errors[provider];
  delete exchange.statuses[provider];
  if (status >= 200 && status <= 299) {
    try {
      const body = JSON.parse(text) as { result?: unknown; error?: unknown };
      if (body.error !== undefined && body.error !== null) {
        exchange.errors[provider] = body.error;
        return;
      }
      if (body.result !== undefined) {
        exchange.answers[provider] = body.result;
        return;
      }
    } catch {
      // An unparseable body replays as an empty one, which the reader reads the same way.
    }
  }
  exchange.statuses[provider] = status;
}

/** Passes every request through and keeps each provider's last answer, less any key of the provider's that it quotes. `exchanges()` leaves out empty maps. */
export function recordingTransport(inner: Transport, endpoints: readonly Endpoint[]): { transport: Transport; exchanges: () => Exchange[] } {
  const recorded: (Recorded & { method: string; params: unknown })[] = [];
  const endpointAt = new Map(endpoints.map((e) => [e.url, e]));
  const transport: Transport = async (url, body, signal) => {
    const answer = await inner(url, body, signal);
    const endpoint = endpointAt.get(url);
    if (endpoint === undefined) return answer;
    const { method, params } = JSON.parse(body) as { method: string; params: unknown };
    let exchange = recorded.find((e) => sameRequest(e, method, params));
    if (exchange === undefined) {
      exchange = { method, params, answers: {}, errors: {}, statuses: {} };
      recorded.push(exchange);
    }
    keep(exchange, endpoint.provider, answer.status, endpoint.key === undefined ? answer.text : answer.text.replaceAll(endpoint.key, '<key>'));
    return answer;
  };
  const exchanges = (): Exchange[] =>
    recorded.map(({ method, params, answers, errors, statuses }) => ({
      method,
      params,
      answers,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
      ...(Object.keys(statuses).length > 0 ? { statuses } : {}),
    }));
  return { transport, exchanges };
}

export const REPLAY_ENDPOINTS: readonly [Endpoint, Endpoint] = [
  { provider: 'alchemy', company: 'Alchemy', url: 'https://alchemy.replay' },
  { provider: 'drpc', company: 'drpc', url: 'https://drpc.replay' },
];

/** Serves each endpoint its provider's recorded answer. A request that was never recorded fails as unreachable. */
export function replayTransport(exchanges: readonly Exchange[], endpoints: readonly Endpoint[]): Transport {
  return async (url, body) => {
    const provider = endpoints.find((e) => e.url === url)?.provider;
    const { method, params } = JSON.parse(body) as { method: string; params: unknown };
    const exchange = provider === undefined ? undefined : exchanges.find((e) => sameRequest(e, method, params));
    if (provider === undefined || exchange === undefined) throw new Error('not recorded');
    const reply = (fields: object) => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, ...fields }) });
    if (Object.hasOwn(exchange.answers, provider)) return reply({ result: exchange.answers[provider] });
    if (exchange.errors !== undefined && Object.hasOwn(exchange.errors, provider)) return reply({ error: exchange.errors[provider] });
    const status = exchange.statuses?.[provider];
    if (status !== undefined) return { status, text: '' };
    throw new Error('not recorded');
  };
}

/** A reader on recorded answers only, so the reader parses and compares them as it did live. */
export function replayReader(exchanges: readonly Exchange[]): Reader {
  return createReader(REPLAY_ENDPOINTS, replayTransport(exchanges, REPLAY_ENDPOINTS), { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] });
}
