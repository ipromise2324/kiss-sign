import type { ApiSource, HttpsUrl } from '../registry.ts';
import { httpsApi, readApi, retryingSend } from '../research/api-source.ts';
import type { MessageReader } from './verify.ts';

/**
 * A GET of the `lookup` URL as an `apiSource` is read, asked again after a pause while it gets no answer: no header but
 * `accept` and `user-agent`, no redirect followed, at most 1 MiB, a
 * host that resolves only to public addresses, status 200 and a JSON content type. The answer is data; the field check
 * counts it only when it hashes to the digest the transaction holds.
 */
export const httpsMessage: MessageReader = async (url) => {
  const answer = await readApi({ url: url as HttpsUrl, method: 'GET', path: [] } satisfies ApiSource, retryingSend(httpsApi, () => undefined));
  return answer.kind === 'answered' ? { text: JSON.stringify(answer.json) } : { why: answer.why, noAnswer: answer.kind === 'unread' };
};
