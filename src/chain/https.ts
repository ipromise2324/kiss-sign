import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';

export type RequestFn = (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;

/** `bytes` holds the body as received, for an answer that is not text, such as a tarball. */
export type HttpAnswer = { readonly status: number; readonly text: string; readonly headers?: IncomingHttpHeaders; readonly bytes?: Uint8Array };

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
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, text: bytes.toString('utf8'), headers: response.headers, bytes });
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * An answer that says the server could not answer now, not what the answer is: it is busy, down, or rate limiting,
 * as GitHub does with a 403 once its hourly limit is spent. Only a server known to say so in a 403's text, GitHub's
 * API, has `rateLimitText` read, since any other page may hold those words.
 */
export function transientStatus(answer: HttpAnswer, rateLimitText = false): string | undefined {
  const header = answer.headers?.['x-ratelimit-remaining'];
  const remaining = Array.isArray(header) ? header[0] : header;
  const limited = answer.status === 429 || (answer.status === 403 && (remaining === '0' || (rateLimitText && /rate limit/i.test(answer.text))));
  if (limited) return `rate limited (HTTP ${answer.status})`;
  if (answer.status === 408 || answer.status >= 500) return `HTTP ${answer.status}`;
  return undefined;
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET']);

/**
 * A request that failed on the way, not by an answer: a dropped or refused connection, a timeout, or DNS that could not
 * answer now. A name that does not exist, a bad certificate, or an answer too large is an answer, and stays one.
 */
export function transientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (typeof code === 'string' && TRANSIENT_CODES.has(code)) || error.name === 'AbortError' || error.name === 'TimeoutError' || error.message === 'socket hang up';
}

/** Notes a read that ended with no answer: what was read, and why, never a URL that holds a key. */
export type NoteUnread = (read: string) => void;

export const RETRY_PAUSES_MS: readonly number[] = [2000, 8000, 20000];

/**
 * Runs `read` again after each pause while it fails on the way (`transientError`) or its answer is transient, then
 * notes the read and returns the last answer, or throws the last error. Any other error is thrown at once. An answer is
 * final, so a retry never swaps one answer for another.
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
      if (!transientError(error)) throw error;
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
