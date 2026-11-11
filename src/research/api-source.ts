import { request } from 'node:https';
import { fallbackLookup } from '../chain/dns.ts';
import { requestText, retried, transientError, transientStatus } from '../chain/https.ts';
import type { HttpAnswer, NoteUnread } from '../chain/https.ts';
import type { ApiPathStep, ApiSource, Json, RegistryEntry } from '../registry.ts';
import type { Address } from '../safe/types.ts';

/**
 * What an entry's `apiSource` answered. `answered` holds the JSON, which a recording prunes to what the entry's path
 * walks; `failed` is an answer that is not JSON, such as a 404, a redirect or an HTML page; `unread` is no answer at all,
 * which no check may read as a disagreement.
 */
export type ApiAnswer = { readonly kind: 'answered'; readonly json: Json } | { readonly kind: 'failed'; readonly why: string } | { readonly kind: 'unread'; readonly why: string };

export type ApiAnswers = ReadonlyMap<string, ApiAnswer>;

export type ApiSend = (api: ApiSource) => Promise<HttpAnswer>;

/** Where a JSON answer's path led: the address there, a step the answer has nothing at, or a value that is no address. */
export type Walked = { readonly kind: 'found'; readonly address: Address } | { readonly kind: 'missing'; readonly at: number } | { readonly kind: 'not-address' };

export const MAX_API_ANSWER_BYTES = 1024 * 1024;

/** One request, as a recording keys its answer: an entry whose request changes is not answered by the old recording. */
export const apiKey = (api: ApiSource): string => `${api.method} ${api.url}${api.method === 'POST' ? ` ${JSON.stringify(api.body)}` : ''}`;

export const pathText = (path: readonly ApiPathStep[]): string => path.map(String).join('.');

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isObject = (v: Json | undefined): v is { readonly [key: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);

function stepInto(value: Json | undefined, step: ApiPathStep): Json | undefined {
  if (typeof step === 'number') return Array.isArray(value) ? (value as readonly Json[])[step] : undefined;
  return isObject(value) && Object.hasOwn(value, step) ? value[step] : undefined;
}

export function walkPath(json: Json, path: readonly ApiPathStep[]): Walked {
  let value: Json | undefined = json;
  for (const [i, step] of path.entries()) {
    value = stepInto(value, step);
    if (value === undefined) return { kind: 'missing', at: i };
  }
  return typeof value === 'string' && ADDRESS.test(value) ? { kind: 'found', address: value.toLowerCase() as Address } : { kind: 'not-address' };
}

/**
 * The answer cut to what `paths` walk, so a recording holds no text the API wrote: each object keeps only the keys a
 * path steps into, each array only the items, the others null, an object or array where a path ends null, and a leaf
 * only an address, any other value null. Every path walks the pruned answer to the same result as the whole one.
 */
export function pruneAnswer(json: Json, paths: readonly (readonly ApiPathStep[])[]): Json {
  if (typeof json !== 'object' || json === null) return typeof json === 'string' && ADDRESS.test(json) ? json : null;
  paths = paths.filter((path) => path.length > 0);
  if (paths.length === 0) return null;
  const next = (step: ApiPathStep) => paths.filter((path) => path[0] === step).map((path) => path.slice(1));
  const steps = [...new Set(paths.map((path) => path[0] as ApiPathStep))];
  if (Array.isArray(json)) {
    const indexes = steps.filter((step): step is number => typeof step === 'number' && step < json.length);
    if (indexes.length === 0) return [];
    return Array.from({ length: Math.max(...indexes) + 1 }, (_, i) => (indexes.includes(i) ? pruneAnswer((json as readonly Json[])[i] as Json, next(i)) : null));
  }
  return Object.fromEntries(steps.filter((step): step is string => typeof step === 'string' && Object.hasOwn(json, step)).map((step) => [step, pruneAnswer((json as { readonly [key: string]: Json })[step] as Json, next(step))]));
}

/** Prunes each answer to the paths of the entries that asked it. */
export function pruneAnswers(entries: readonly RegistryEntry[], answers: ApiAnswers): Record<string, ApiAnswer> {
  return Object.fromEntries(
    [...answers].map(([key, answer]) => {
      if (answer.kind !== 'answered') return [key, answer];
      const paths = entries.flatMap((e) => (e.apiSource !== undefined && apiKey(e.apiSource) === key ? [e.apiSource.path] : []));
      return [key, { kind: 'answered', json: pruneAnswer(answer.json, paths) }];
    }),
  );
}

const header = (answer: HttpAnswer, name: string): string => {
  const value = answer.headers?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
};

/** Asks the API once; only a JSON answer with status 200 is an answer to walk. */
export async function readApi(api: ApiSource, send: ApiSend): Promise<ApiAnswer> {
  const host = new URL(api.url).hostname;
  let answer: HttpAnswer;
  try {
    answer = await send(api);
  } catch (error) {
    if (transientError(error)) return { kind: 'unread', why: `${host} unreachable or timed out` };
    const refused = (error as { code?: unknown }).code === 'ENOTPUBLIC' || (error as Error).message === 'answer too large';
    return { kind: 'failed', why: refused ? (error as Error).message : `${host} unreachable` };
  }
  const transient = transientStatus(answer);
  if (transient !== undefined) return { kind: 'unread', why: `${api.url} answered ${transient}` };
  if (answer.status !== 200) return { kind: 'failed', why: `${api.url} answered HTTP ${answer.status}` };
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(header(answer, 'content-type'))) return { kind: 'failed', why: `${api.url} answered with no JSON content type` };
  try {
    return { kind: 'answered', json: JSON.parse(answer.text) as Json };
  } catch {
    return { kind: 'failed', why: `${api.url} answered with text that is not JSON` };
  }
}

/** Each distinct request of the entries, asked once. */
export async function gatherApiAnswers(entries: readonly RegistryEntry[], send: ApiSend): Promise<Map<string, ApiAnswer>> {
  const answers = new Map<string, ApiAnswer>();
  for (const { apiSource } of entries) {
    if (apiSource !== undefined && !answers.has(apiKey(apiSource))) answers.set(apiKey(apiSource), await readApi(apiSource, send));
  }
  return answers;
}

/** `send`, asking again after each pause while it gets no answer, and noting each request that never got one. */
export const retryingSend =
  (send: ApiSend, note: NoteUnread, pausesMs?: readonly number[]): ApiSend =>
  (api) =>
    retried(`${api.method} ${api.url}`, () => send(api), (answer) => transientStatus(answer), note, pausesMs);

/**
 * The request as the registry states it, with no header but the content type, and no redirect followed. The host must
 * resolve to public addresses only, and the answer may hold at most `MAX_API_ANSWER_BYTES`.
 */
export const httpsApi: ApiSend = (api) => {
  const target = new URL(api.url);
  const body = api.method === 'POST' ? JSON.stringify(api.body) : undefined;
  return requestText(
    request,
    {
      method: api.method,
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers: {
        'user-agent': 'kiss-sign',
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
      },
      servername: target.hostname,
      rejectUnauthorized: true,
      lookup: fallbackLookup(undefined, true),
      signal: AbortSignal.timeout(30_000),
    },
    body,
    MAX_API_ANSWER_BYTES,
  );
};
