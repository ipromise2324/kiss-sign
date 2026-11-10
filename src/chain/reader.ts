import type { Address, Hex } from '../safe/types.ts';
import type { Env } from '../keys.ts';
import { mainnetEndpoints } from './providers.ts';
import type { Endpoint, ProviderName } from './providers.ts';
import { httpsTransport } from './rpc.ts';
import type { Transport } from './rpc.ts';
import { parseBlockHeader, parseBlockRef, parseData, parseReceipt, parseSimulation, parseTransaction, hash32, quantity } from './types.ts';
import type { BlockHeader, BlockRef, BlockTag, CallResult, Receipt, SimulatedCall, SimulationRequest, Transaction } from './types.ts';

/** Closed values only, so no provider text (which may quote a keyed URL) can reach a reason. */
export type FailureCause = 'unreachable' | 'timeout' | 'refused' | 'rate-limited' | 'http-error' | 'no-answer';

export type ProviderOutcome =
  | { readonly provider: ProviderName; readonly kind: 'answered'; readonly value: unknown }
  | { readonly provider: ProviderName; readonly kind: 'failed'; readonly cause: FailureCause }
  | { readonly provider: ProviderName; readonly kind: 'malformed' };

/** A value exists only when both providers gave the same answer. */
export type Read<T> =
  | { readonly kind: 'agreed'; readonly value: T; readonly providers: readonly [ProviderName, ProviderName] }
  | { readonly kind: 'unverifiable'; readonly reason: string; readonly answers: readonly [ProviderOutcome, ProviderOutcome] };

export type Reader = {
  readonly providers: readonly [ProviderName, ProviderName];
  /** The number of `block('latest')`: the lower head, confirmed by both providers' hash at that height. */
  blockNumber(): Promise<Read<bigint>>;
  block(tag: BlockTag): Promise<Read<BlockRef>>;
  header(at: BlockRef): Promise<Read<BlockHeader>>;
  getCode(address: Address, at: BlockRef): Promise<Read<Hex>>;
  getBalance(address: Address, at: BlockRef): Promise<Read<bigint>>;
  call(request: { readonly to: Address; readonly data: Hex }, at: BlockRef): Promise<Read<CallResult>>;
  getStorageAt(address: Address, slot: bigint, at: BlockRef): Promise<Read<Hex>>;
  getTransactionReceipt(hash: Hex): Promise<Read<Receipt | null>>;
  getTransaction(hash: Hex): Promise<Read<Transaction | null>>;
  /** `eth_simulateV1` of one block on top of `at`, with `traceTransfers` on and validation off. */
  simulateV1(request: SimulationRequest, at: BlockRef): Promise<Read<readonly SimulatedCall[]>>;
};

export type ReaderOptions = {
  readonly timeoutMs?: number;
  readonly retryPausesMs?: readonly number[];
  /** Pauses after a rate-limited answer, long enough for a public endpoint's window to pass. */
  readonly rateLimitPausesMs?: readonly number[];
};

type Answer = { readonly kind: 'result'; readonly value: unknown } | { readonly kind: 'reverted' };
type Attempt = Answer | { readonly kind: 'failed'; readonly cause: FailureCause };

type Method = {
  readonly name: string;
  /** Null means "no such transaction" for lookups by hash, and a lagging backend everywhere else. */
  readonly nullIsAnswer: boolean;
  readonly parse: (answer: Answer) => unknown;
};

class Timeout extends Error {}

const resultOnly =
  <T>(parse: (raw: unknown) => T) =>
  (answer: Answer): T => {
    if (answer.kind === 'reverted') throw new Error('unexpected revert');
    return parse(answer.value);
  };

const hexQuantity = (n: bigint): string => `0x${n.toString(16)}`;

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v));

function statusCause(status: number): FailureCause {
  if (status === 401 || status === 403) return 'refused';
  if (status === 429) return 'rate-limited';
  return 'http-error';
}

function isRevert(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === 3 || (code === -32000 && typeof message === 'string' && /execution reverted/i.test(message));
}

function attemptOf(text: string, method: Method): Attempt {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'failed', cause: 'no-answer' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { kind: 'failed', cause: 'no-answer' };
  const { result, error } = body as { result?: unknown; error?: unknown };
  if (error !== undefined && error !== null) {
    return method.name === 'eth_call' && isRevert(error) ? { kind: 'reverted' } : { kind: 'failed', cause: 'no-answer' };
  }
  if (result === undefined || (result === null && !method.nullIsAnswer)) return { kind: 'failed', cause: 'no-answer' };
  return { kind: 'result', value: result };
}

function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Timeout());
    }, ms);
  });
  return Promise.race([run(controller.signal), expired]).finally(() => clearTimeout(timer));
}

const describe = (outcome: ProviderOutcome): string | undefined => {
  if (outcome.kind === 'failed') return `${outcome.provider} failed (${outcome.cause})`;
  if (outcome.kind === 'malformed') return `${outcome.provider} sent a malformed answer`;
  return undefined;
};

function judge<T>(label: string, outcomes: readonly [ProviderOutcome, ProviderOutcome]): Read<T> {
  const [a, b] = outcomes;
  if (a.kind === 'answered' && b.kind === 'answered') {
    if (canonical(a.value) === canonical(b.value)) return { kind: 'agreed', value: a.value as T, providers: [a.provider, b.provider] };
    return { kind: 'unverifiable', reason: `${label}: ${a.provider} and ${b.provider} disagree`, answers: outcomes };
  }
  const problems = outcomes.map(describe).filter((text) => text !== undefined);
  return { kind: 'unverifiable', reason: `${label}: ${problems.join('; ')}`, answers: outcomes };
}

export function createReader(endpoints: readonly [Endpoint, Endpoint], transport: Transport, options: ReaderOptions = {}): Reader {
  if (endpoints[0].company === endpoints[1].company) throw new Error('the two providers must be run by different companies');
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pauses = options.retryPausesMs ?? [250, 750];
  const rateLimitPauses = options.rateLimitPausesMs ?? [1000, 2000, 4000, 8000, 16000];

  async function attempt(endpoint: Endpoint, method: Method, params: readonly unknown[]): Promise<Attempt> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: method.name, params });
    try {
      const answer = await withTimeout(timeoutMs, (signal) => transport(endpoint.url, body, signal));
      if (answer.status < 200 || answer.status > 299) return { kind: 'failed', cause: statusCause(answer.status) };
      return attemptOf(answer.text, method);
    } catch (error) {
      return { kind: 'failed', cause: error instanceof Timeout ? 'timeout' : 'unreachable' };
    }
  }

  /** Only a missing answer is asked again. An answer is final, so a retry never swaps one answer for another. */
  async function ask(endpoint: Endpoint, method: Method, params: readonly unknown[]): Promise<ProviderOutcome> {
    for (let failed = 0, limited = 0; ; ) {
      const result = await attempt(endpoint, method, params);
      if (result.kind === 'failed') {
        const pause = result.cause === 'rate-limited' ? rateLimitPauses[limited++] : pauses[failed++];
        if (pause === undefined) return { provider: endpoint.provider, kind: 'failed', cause: result.cause };
        await new Promise((resolve) => setTimeout(resolve, pause));
        continue;
      }
      try {
        return { provider: endpoint.provider, kind: 'answered', value: method.parse(result) };
      } catch {
        return { provider: endpoint.provider, kind: 'malformed' };
      }
    }
  }

  async function both(method: Method, params: readonly unknown[]): Promise<readonly [ProviderOutcome, ProviderOutcome]> {
    const [a, b] = await Promise.all([ask(endpoints[0], method, params), ask(endpoints[1], method, params)]);
    return [a, b];
  }

  async function read<T>(method: Method, params: readonly unknown[], label = method.name): Promise<Read<T>> {
    return judge<T>(label, await both(method, params));
  }

  const method = <T>(name: string, parse: (raw: unknown) => T): Method => ({ name, nullIsAnswer: false, parse: resultOnly(parse) });
  const byHash = <T>(name: string, parse: (raw: unknown) => T): Method => ({
    name,
    nullIsAnswer: true,
    parse: resultOnly((raw) => (raw === null ? null : parse(raw))),
  });

  const blockAt = (number: bigint): Promise<Read<BlockRef>> =>
    read(
      method('eth_getBlockByNumber', (raw) => {
        const block = parseBlockRef(raw);
        if (block.number !== number) throw new Error('another block');
        return block;
      }),
      [hexQuantity(number), false],
      `block ${number}`,
    );

  async function block(tag: BlockTag): Promise<Read<BlockRef>> {
    if (tag !== 'latest') return blockAt(tag);
    const heads = await both(method('eth_blockNumber', quantity), []);
    const [a, b] = heads;
    if (a.kind !== 'answered' || b.kind !== 'answered') return judge('latest block', heads);
    const [x, y] = [a.value as bigint, b.value as bigint];
    return blockAt(x < y ? x : y);
  }

  // EIP-1898: name the block by hash, so both providers read the very block they agreed on.
  const pinned = (at: BlockRef) => ({ blockHash: at.hash });

  const simulatePayload = (request: SimulationRequest) => ({
    blockStateCalls: [
      {
        blockOverrides: {
          number: hexQuantity(request.block.number),
          time: hexQuantity(request.block.time),
          gasLimit: hexQuantity(request.block.gasLimit),
          prevRandao: request.block.prevRandao,
          baseFeePerGas: '0x0',
          feeRecipient: `0x${'00'.repeat(20)}`,
        },
        stateOverrides: request.stateOverrides,
        calls: request.calls.map((call) => ({ from: call.from, to: call.to, data: call.data, gas: hexQuantity(call.gas) })),
      },
    ],
    traceTransfers: true,
    validation: false,
  });

  return {
    providers: [endpoints[0].provider, endpoints[1].provider],
    blockNumber: async () => {
      const latest = await block('latest');
      return latest.kind === 'agreed' ? { ...latest, value: latest.value.number } : latest;
    },
    block,
    getCode: (address, at) => read(method('eth_getCode', parseData), [address, pinned(at)]),
    getBalance: (address, at) => read(method('eth_getBalance', quantity), [address, pinned(at)]),
    getStorageAt: (address, slot, at) =>
      read(method('eth_getStorageAt', hash32), [address, hexQuantity(slot), pinned(at)]),
    call: (request, at) =>
      read(
        {
          name: 'eth_call',
          nullIsAnswer: false,
          parse: (answer): CallResult =>
            answer.kind === 'reverted' ? { kind: 'reverted' } : { kind: 'returned', data: parseData(answer.value) },
        },
        [{ to: request.to, data: request.data }, pinned(at)],
      ),
    header: (at) =>
      read(
        method('eth_getBlockByHash', (raw) => {
          const header = parseBlockHeader(raw);
          if (header.hash !== at.hash || header.number !== at.number) throw new Error('another block');
          return header;
        }),
        [at.hash, false],
        `block ${at.number}`,
      ),
    simulateV1: (request, at) =>
      read(
        method('eth_simulateV1', (raw) => parseSimulation(raw, request, at)),
        [simulatePayload(request), pinned(at)],
      ),
    getTransactionReceipt: (hash) => read(byHash('eth_getTransactionReceipt', parseReceipt), [hash]),
    getTransaction: (hash) => read(byHash('eth_getTransactionByHash', parseTransaction), [hash]),
  };
}

/** Alchemy and drpc on Ethereum mainnet. Throws `MissingKeyError` before any read when the Alchemy key is not set. */
export function openMainnetReader(env: Env, transport: Transport = httpsTransport(), options: ReaderOptions = {}): Reader {
  return createReader(mainnetEndpoints(env), transport, options);
}
