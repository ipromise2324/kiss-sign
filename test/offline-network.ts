/**
 * Loaded with `--import` into a command run by a test: every HTTPS request and every `fetch` is answered from the file
 * `OFFLINE_ANSWERS` names, and nothing reaches the network. A JSON-RPC request to either chain provider gets its
 * provider's answer in `exchanges`; any other URL, its `apikey` left out, gets its answer in `http`, or `otherwise` when given. A request with no
 * answer fails as a refused connection, which the program reads as no answer.
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { RequestOptions } from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { replayTransport } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';

type Answer = { readonly status: number; readonly text: string };
type Answers = { readonly exchanges: readonly Exchange[]; readonly http: Readonly<Record<string, Answer>>; readonly otherwise?: Answer };

const answers = JSON.parse(readFileSync(process.env.OFFLINE_ANSWERS ?? '', 'utf8')) as Answers;
const endpoints = mainnetEndpoints(process.env);
const chain = replayTransport(answers.exchanges, endpoints);

function withoutKey(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('apikey');
  return parsed.href;
}

const refused = (url: string) => Object.assign(new Error(`offline: ${new URL(url).host}`), { code: 'ECONNREFUSED' });

async function answer(url: string, body: string): Promise<Answer> {
  const endpoint = endpoints.find((e) => new URL(e.url).href === new URL(url).href);
  if (endpoint !== undefined) return chain(endpoint.url, body, new AbortController().signal).catch(() => Promise.reject(refused(url)));
  const served = answers.http[withoutKey(url)] ?? answers.otherwise;
  if (served !== undefined) return served;
  throw refused(url);
}

function request(options: RequestOptions, onResponse?: (response: Readable) => void): EventEmitter {
  const req = Object.assign(new EventEmitter(), {
    destroy: (error?: Error) => void (error === undefined || req.emit('error', error)),
    end: (body?: string | Buffer) => {
      const url = `https://${options.hostname}${options.port === undefined || options.port === 443 ? '' : `:${options.port}`}${options.path ?? '/'}`;
      answer(url, body === undefined ? '' : body.toString()).then(
        ({ status, text }) => {
          const response = Object.assign(Readable.from([Buffer.from(text)]), { statusCode: status, headers: {} });
          onResponse?.(response);
        },
        (error: unknown) => req.emit('error', error),
      );
    },
  });
  return req;
}

https.request = request as unknown as typeof https.request;
syncBuiltinESMExports();

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const { status, text } = await answer(url, typeof init?.body === 'string' ? init.body : '');
  return new Response(text, { status });
};
