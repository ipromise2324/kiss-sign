import { request } from 'node:https';
import { fallbackLookup } from './dns.ts';
import { requestText } from './https.ts';
import type { HttpAnswer, RequestFn } from './https.ts';

export type Transport = (url: string, body: string, signal: AbortSignal) => Promise<HttpAnswer>;

const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

export function httpsTransport(deps: { request?: RequestFn; lookup?: ReturnType<typeof fallbackLookup> } = {}): Transport {
  const send = deps.request ?? request;
  const lookup = deps.lookup ?? fallbackLookup();
  return (url, body, signal) => {
    const target = new URL(url);
    return requestText(
      send,
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port === '' ? 443 : Number(target.port),
        path: target.pathname + target.search,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        servername: target.hostname,
        rejectUnauthorized: true,
        lookup,
        signal,
      },
      body,
      MAX_ANSWER_BYTES,
    );
  };
}
