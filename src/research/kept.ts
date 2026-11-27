import { transientStatus } from '../chain/https.ts';
import type { HttpAnswer, NoteUnread } from '../chain/https.ts';
import type { Transport } from '../chain/rpc.ts';
import type { EtherscanGet } from '../contracts/etherscan.ts';
import type { Address } from '../safe/types.ts';
import { apiKey } from './api-source.ts';
import type { ApiSend } from './api-source.ts';
import { etherscanHints } from './deployer.ts';
import type { HttpGet } from './source-page.ts';

/**
 * `ask`, asked once per key while this process runs: a later or concurrent caller shares the answer. One that failed, or
 * is no answer, is forgotten and asked again. An undefined key is never kept.
 */
export function kept<A extends readonly unknown[], R>(ask: (...args: A) => Promise<R>, keyOf: (...args: A) => string | undefined, answered: (result: R) => boolean): (...args: A) => Promise<R> {
  const answers = new Map<string, Promise<R>>();
  return (...args) => {
    const key = keyOf(...args);
    if (key === undefined) return ask(...args);
    const known = answers.get(key);
    if (known !== undefined) return known;
    const asked = ask(...args);
    answers.set(key, asked);
    const forget = () => void answers.delete(key);
    asked.then((result) => (answered(result) ? undefined : forget()), forget);
    return asked;
  };
}

/** A JSON-RPC result. An error or a null result may be a provider's passing trouble, so it is asked again. */
function hasResult(answer: HttpAnswer): boolean {
  if (answer.status !== 200) return false;
  try {
    const body = JSON.parse(answer.text) as { result?: unknown; error?: unknown } | null;
    return body !== null && (body.error ?? undefined) === undefined && (body.result ?? undefined) !== undefined;
  } catch {
    return false;
  }
}

/**
 * `asked`, or the abort of `signal` once it fires: the caller stops waiting, and `asked` goes on for any other. The abort
 * lands a turn later, so an error the caller raises beside it, such as its own timeout, is the one it sees.
 */
function untilAborted<T>(asked: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => setImmediate(() => reject(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    asked.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * The head moves, so it alone is asked every time; every other request names the block or transaction it is about. A
 * kept request is shared, so it runs under its own `timeoutMs`, never a caller's signal: one caller that stops waiting
 * does not stop it for the others.
 */
export function keptTransport(inner: Transport, timeoutMs = 60_000): Transport {
  const head = (body: string) => (JSON.parse(body) as { method: string }).method === 'eth_blockNumber';
  const shared = kept((url: string, body: string) => inner(url, body, AbortSignal.timeout(timeoutMs)), (url, body) => (head(body) ? undefined : `${url}\n${body}`), hasResult);
  return (url, body, signal) => (head(body) ? inner(url, body, signal) : untilAborted(shared(url, body), signal));
}

export const keptGet = (get: HttpGet): HttpGet => {
  const isGitHubApi = (url: string) => new URL(url).hostname === 'api.github.com';
  const keyed = kept(async (url: string) => ({ url, answer: await get(url) }), (url) => url, ({ url, answer }) => transientStatus(answer, isGitHubApi(url)) === undefined);
  return async (url) => (await keyed(url)).answer;
};

export const keptSend = (send: ApiSend): ApiSend => kept(send, apiKey, (answer) => transientStatus(answer) === undefined);

/**
 * Etherscan answers a refusal, such as a rate limit, with status 200 too; only its `status` "1" is an answer. One request
 * goes out at a time, since `get` paces its requests only one after another.
 */
export function keptEtherscan(get: EtherscanGet): EtherscanGet {
  let last: Promise<unknown> = Promise.resolve();
  const inTurn: EtherscanGet = (address) => {
    const asked = last.then(() => get(address));
    last = asked.catch(() => {});
    return asked;
  };
  return kept(inTurn, (address) => address, ({ status, body }) => status === 200 && (body as { status?: unknown } | null | undefined)?.status === '1');
}

/** Etherscan's creation hints, shared by every noting caller; one that gets no answer throws, so each answer is one. */
export function keptHints(lookup: typeof etherscanHints = etherscanHints): typeof etherscanHints {
  const ask = kept(
    (addresses: readonly Address[], key: string, note: NoteUnread) => lookup(key, note)(addresses),
    (addresses) => addresses.join(),
    () => true,
  );
  return (key, note) => (addresses) => ask(addresses, key, note);
}
