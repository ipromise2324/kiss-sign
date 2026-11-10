import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';
import { test } from 'node:test';
import { fallbackLookup } from '../src/chain/dns.ts';
import type { DohQuery, SystemLookup } from '../src/chain/dns.ts';
import type { RequestFn } from '../src/chain/https.ts';
import { httpsTransport } from '../src/chain/rpc.ts';

const failing =
  (code: string): SystemLookup =>
  async () => {
    throw Object.assign(new Error(`getaddrinfo ${code}`), { code });
  };

const dohAnswer =
  (address: string): DohQuery =>
  async (url) => {
    assert.match(url, /^https:\/\/(1\.1\.1\.1|8\.8\.8\.8)\//, 'DoH is asked by IP');
    return { Status: 0, Answer: [{ name: 'eth.drpc.org.', type: 5, data: 'cname.example.' }, { name: 'cname.example.', type: 1, data: address }] };
  };

type Connection = { options: RequestOptions; address: unknown };

/** Captures what https.request would connect to, resolving the host through the options' own lookup. */
function capture(): { request: RequestFn; connection: Promise<Connection> } {
  let done: (c: Connection) => void = () => {};
  const connection = new Promise<Connection>((resolve) => (done = resolve));
  const request = ((options: RequestOptions) => {
    const req = Object.assign(new EventEmitter(), {
      end: () => {
        options.lookup?.(String(options.hostname), { all: false }, (error, address) => {
          done({ options, address: error ?? address });
          req.emit('error', new Error('captured'));
        });
      },
      destroy: () => {},
    });
    return req;
  }) as unknown as RequestFn;
  return { request, connection };
}

test('when system DNS fails, the host resolves over DoH and TLS still checks the original host name', async () => {
  const { request, connection } = capture();
  const send = httpsTransport({ request, lookup: fallbackLookup({ system: failing('ENOTFOUND'), query: dohAnswer('203.0.113.7') }) });
  await assert.rejects(send('https://eth.drpc.org/', '{}', new AbortController().signal));
  const { options, address } = await connection;
  assert.equal(address, '203.0.113.7');
  assert.equal(options.hostname, 'eth.drpc.org');
  assert.equal(options.servername, 'eth.drpc.org');
  assert.notEqual(options.rejectUnauthorized, false);
});

test('EAI_AGAIN also falls back to DoH', async () => {
  const addresses = await new Promise((resolve, reject) =>
    fallbackLookup({ system: failing('EAI_AGAIN'), query: dohAnswer('203.0.113.8') })('eth.drpc.org', { all: true }, (error, address) =>
      error ? reject(error) : resolve(address),
    ),
  );
  assert.deepEqual(addresses, [{ address: '203.0.113.8', family: 4 }]);
});

test('a working system resolver is used and DoH is never asked', async () => {
  const query: DohQuery = async () => assert.fail('DoH asked');
  const address = await new Promise((resolve, reject) =>
    fallbackLookup({ system: async () => [{ address: '198.51.100.1', family: 4 }], query })('eth.drpc.org', {}, (error, a) =>
      error ? reject(error) : resolve(a),
    ),
  );
  assert.equal(address, '198.51.100.1');
});

test('other system errors are not retried over DoH', async () => {
  const query: DohQuery = async () => assert.fail('DoH asked');
  const error = await new Promise((resolve) =>
    fallbackLookup({ system: failing('ECONNREFUSED'), query })('eth.drpc.org', {}, (e) => resolve(e)),
  );
  assert.equal((error as NodeJS.ErrnoException).code, 'ECONNREFUSED');
});

test('a DoH answer with no A record fails the lookup', async () => {
  const error = await new Promise((resolve) =>
    fallbackLookup({ system: failing('ENOTFOUND'), query: async () => ({ Status: 3 }) })('nope.invalid', {}, (e) => resolve(e)),
  );
  assert.equal((error as NodeJS.ErrnoException).code, 'ENOTFOUND');
});
