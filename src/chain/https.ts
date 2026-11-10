import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';

export type RequestFn = (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;

export type HttpAnswer = { readonly status: number; readonly text: string };

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
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
