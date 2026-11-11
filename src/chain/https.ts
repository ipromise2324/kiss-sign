import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';

export type RequestFn = (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;

export type HttpAnswer = { readonly status: number; readonly text: string; readonly headers?: IncomingHttpHeaders };

export function requestText(request: RequestFn, options: RequestOptions, body: string | undefined, maxBytes: number): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const req = request(options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(new Error('answer too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * An answer that says the server could not answer now, not what the answer is: it is busy, down, or rate limiting,
 * as GitHub does with a 403 once its hourly limit is spent.
 */
export function transientStatus(answer: HttpAnswer): string | undefined {
  const header = answer.headers?.['x-ratelimit-remaining'];
  const remaining = Array.isArray(header) ? header[0] : header;
  const limited = answer.status === 429 || (answer.status === 403 && (remaining === '0' || /rate limit/i.test(answer.text)));
  if (limited) return `rate limited (HTTP ${answer.status})`;
  if (answer.status === 408 || answer.status >= 500) return `HTTP ${answer.status}`;
  return undefined;
}

/** Notes a read that ended with no answer: what was read, and why, never a URL that holds a key. */
export type NoteUnread = (read: string) => void;

export const RETRY_PAUSES_MS: readonly number[] = [2000, 8000, 20000];

/**
 * Runs `read` again after each pause while it throws or its answer is transient, then notes the read and returns the
 * last answer, or throws the last error. An answer is final, so a retry never swaps one answer for another.
 */
export async function retried<T>(label: string, read: () => Promise<T>, transient: (answer: T) => string | undefined, note: NoteUnread, pausesMs: readonly number[] = RETRY_PAUSES_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const answer = await read();
      const failed = transient(answer);
      if (failed === undefined) return answer;
      if (attempt >= pausesMs.length) {
        note(`${label}: ${failed}`);
        return answer;
      }
    } catch (error) {
      if (attempt >= pausesMs.length) {
        note(`${label}: unreachable or timed out`);
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pausesMs[attempt]));
  }
}

/** Why `--record` writes nothing: a recording holds answers only, so a read that failed is run again, not kept. */
export function unreadRefusal(unread: readonly string[]): string | undefined {
  if (unread.length === 0) return undefined;
  return [`${unread.length} read(s) got no answer after every retry, so nothing is recorded; run the command again later:`, ...unread.map((read) => `  ${read}`)].join('\n');
}
