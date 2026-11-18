import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MissingKeyError, mainnetEndpoints } from '../src/chain/providers.ts';
import type { Endpoint } from '../src/chain/providers.ts';
import { createReader, openMainnetReader } from '../src/chain/reader.ts';
import type { Read } from '../src/chain/reader.ts';
import type { Transport } from '../src/chain/rpc.ts';
import type { BlockRef } from '../src/chain/types.ts';
import type { Address, Hex } from '../src/safe/types.ts';

const KEY = 'planted-key-123';
const ALCHEMY_URL = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
const ENDPOINTS: readonly [Endpoint, Endpoint] = [
  { provider: 'alchemy', company: 'Alchemy', url: ALCHEMY_URL },
  { provider: 'drpc', company: 'drpc', url: 'https://eth.drpc.org' },
];

type Rpc = { method: string; params: unknown[] };
type Fake = (rpc: Rpc, url: string) => unknown;

const ADDRESS = '0x4a6c312ec70e8747a587ee860a0353cd42be0ae0' as Address;
const HASH_A = `0x${'aa'.repeat(32)}`;
const HASH_B = `0x${'bb'.repeat(32)}`;
const AT: BlockRef = { number: 100n, hash: HASH_A as Hex };

/** A provider that answers like a node at `head` whose block hashes come from `hashAt`. */
function node(head: number, hashAt: (n: number) => string = () => HASH_A, code = '0x6001'): Fake {
  return ({ method, params }) => {
    if (method === 'eth_blockNumber') return { result: `0x${head.toString(16)}` };
    if (method === 'eth_getBlockByNumber') {
      const n = Number(params[0]);
      return { result: { number: `0x${n.toString(16)}`, hash: hashAt(n), miner: 'ignored' } };
    }
    if (method === 'eth_getCode') return { result: code };
    if (method === 'eth_call') return { result: '0x' + '00'.repeat(31) + '01' };
    throw new Error(`unexpected ${method}`);
  };
}

function transport(alchemy: Fake, drpc: Fake): Transport {
  return async (url, body) => {
    const rpc = JSON.parse(body) as Rpc;
    const answer = (url === ALCHEMY_URL ? alchemy : drpc)(rpc, url);
    if (answer === 'hang') return new Promise(() => {});
    return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, ...(answer as object) }) };
  };
}

const reader = (alchemy: Fake, drpc: Fake) => createReader(ENDPOINTS, transport(alchemy, drpc), { timeoutMs: 50, retryPausesMs: [] });

function unverifiable<T>(read: Read<T>): string {
  assert.equal(read.kind, 'unverifiable', `expected unverifiable, got ${JSON.stringify(read, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))}`);
  return read.kind === 'unverifiable' ? read.reason : '';
}

test('two agreeing providers give an agreed value naming both', async () => {
  const read = await reader(node(100), node(100)).getCode(ADDRESS, AT);
  assert.deepEqual(read, { kind: 'agreed', value: '0x6001', providers: ['alchemy', 'drpc'] });
});

test('answers are compared after normalizing hex case', async () => {
  const read = await reader(node(100, undefined, '0xABCD'), node(100, undefined, '0xabcd')).getCode(ADDRESS, AT);
  assert.equal(read.kind, 'agreed');
});

test('different answers are unverifiable, and the reason names both providers', async () => {
  const reason = unverifiable(await reader(node(100, undefined, '0x6001'), node(100, undefined, '0x6002')).getCode(ADDRESS, AT));
  assert.match(reason, /alchemy/);
  assert.match(reason, /drpc/);
  assert.match(reason, /disagree/);
});

test('a provider that throws makes the read unverifiable', async () => {
  const failing: Fake = () => {
    throw new Error('boom');
  };
  const reason = unverifiable(await reader(node(100), failing).getCode(ADDRESS, AT));
  assert.match(reason, /drpc failed/);
});

test('a provider that never answers times out and makes the read unverifiable', async () => {
  const reason = unverifiable(await reader(() => 'hang', node(100)).getCode(ADDRESS, AT));
  assert.match(reason, /alchemy failed \(timeout\)/);
});

function limitedFor(times: number): Transport {
  let refused = 0;
  const answering = transport(node(100), node(100));
  return async (url, body, signal) => (url !== ALCHEMY_URL && refused++ < times ? { status: 429, text: 'Too Many Requests' } : answering(url, body, signal));
}

test('a rate-limited provider is asked again after its own pauses, so a passing limit still gives an agreed value', async () => {
  const read = await createReader(ENDPOINTS, limitedFor(3), { timeoutMs: 50, retryPausesMs: [], rateLimitPausesMs: [1, 1, 1] }).getCode(ADDRESS, AT);
  assert.deepEqual(read, { kind: 'agreed', value: '0x6001', providers: ['alchemy', 'drpc'] });
});

test('a provider still rate-limited after every pause is a failed provider, not a disagreement, and is noted for --record to refuse', async () => {
  const unread: string[] = [];
  const read = await createReader(ENDPOINTS, limitedFor(4), { timeoutMs: 50, retryPausesMs: [250], rateLimitPausesMs: [1, 1, 1], note: (r) => unread.push(r) }).getCode(ADDRESS, AT);
  assert.equal(unverifiable(read), 'eth_getCode: drpc failed (rate-limited)');
  assert.deepEqual(unread, ['drpc eth_getCode: rate-limited']);
});

test('a provider rate-limited until its last pause and then answering is noted nowhere', async () => {
  const unread: string[] = [];
  const read = await createReader(ENDPOINTS, limitedFor(3), { timeoutMs: 50, retryPausesMs: [], rateLimitPausesMs: [1, 1, 1], note: (r) => unread.push(r) }).getCode(ADDRESS, AT);
  assert.equal(read.kind, 'agreed');
  assert.deepEqual(unread, []);
});

test('a malformed answer makes the read unverifiable', async () => {
  const reason = unverifiable(await reader(node(100), node(100, undefined, 'not hex')).getCode(ADDRESS, AT));
  assert.match(reason, /drpc sent a malformed answer/);
});

test('latest takes the lower head and requires the same block hash there', async () => {
  const read = await reader(node(105), node(103)).block('latest');
  assert.deepEqual(read, { kind: 'agreed', value: { number: 103n, hash: HASH_A }, providers: ['alchemy', 'drpc'] });
});

test('different block hashes at the pinned block are unverifiable', async () => {
  const reason = unverifiable(await reader(node(103, () => HASH_A), node(103, () => HASH_B)).block('latest'));
  assert.match(reason, /block 103: alchemy and drpc disagree/);
});

test('a state read names the agreed block by hash for both providers', async () => {
  const seen: unknown[] = [];
  const recording: Fake = (rpc) => {
    seen.push(rpc.params.at(-1));
    return { result: '0x' };
  };
  await reader(recording, recording).getCode(ADDRESS, AT);
  assert.deepEqual(seen, [{ blockHash: HASH_A }, { blockHash: HASH_A }]);
});

test('a revert from both providers is an agreed revert', async () => {
  const reverting: Fake = () => ({ error: { code: 3, message: 'execution reverted', data: '0x' } });
  const read = await reader(reverting, reverting).call({ to: ADDRESS, data: '0x' as Hex }, AT);
  assert.deepEqual(read, { kind: 'agreed', value: { kind: 'reverted' }, providers: ['alchemy', 'drpc'] });
});

test('a missing Alchemy key names the variable, the signup URL, and key add in your own terminal', () => {
  const env = { KISS_SIGN_HOME: '/nonexistent/kiss-sign-home' };
  assert.throws(() => openMainnetReader(env), (error: unknown) => {
    assert.ok(error instanceof MissingKeyError);
    assert.match(error.message, /ALCHEMY_API_KEY/);
    assert.match(error.message, /https:\/\/dashboard\.alchemy\.com\//);
    assert.match(error.message, /`pnpm kiss-sign key add alchemy` in your own terminal, not in a chat/);
    return true;
  });
});

test('the key never appears in a reason, even when the provider error quotes the URL', async () => {
  const leaky: Transport = async (url) => {
    throw new Error(`request to ${url} failed`);
  };
  const r = createReader(mainnetEndpoints({ ALCHEMY_API_KEY: KEY }), leaky, { timeoutMs: 50, retryPausesMs: [] });
  const reads = [await r.getCode(ADDRESS, AT), await r.block('latest'), await r.getTransaction(HASH_A as Hex)];
  for (const read of reads) {
    const text = JSON.stringify(read, (_k, v) => (typeof v === 'bigint' ? `${v}` : v));
    assert.equal(read.kind, 'unverifiable');
    assert.ok(!text.includes(KEY), `key leaked: ${text}`);
  }
});

test('the same key on an HTTP error body never reaches the reason', async () => {
  const leaky: Transport = async (url) => ({ status: 401, text: `bad key in ${url}` });
  const read = await createReader(ENDPOINTS, leaky, { timeoutMs: 50, retryPausesMs: [] }).getCode(ADDRESS, AT);
  assert.ok(!JSON.stringify(read).includes(KEY));
  assert.match(unverifiable(read), /alchemy failed \(refused\)/);
});

/** drpc refuses any request that arrives while `capacity` others are still open, as a public endpoint does. */
function busyAbove(capacity: number): Transport {
  let open = 0;
  const answering = transport(node(100), node(100));
  return async (url, body, signal) => {
    if (url === ALCHEMY_URL) return answering(url, body, signal);
    if (open >= capacity) return { status: 429, text: 'Too Many Requests' };
    open++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    open--;
    return answering(url, body, signal);
  };
}

test('a burst of reads to a provider that refuses more than a few at once all get an answer, since a refusal halves how many are sent at once', async () => {
  const unread: string[] = [];
  const reader = createReader(ENDPOINTS, busyAbove(3), { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [5, 5, 5], note: (r) => unread.push(r) });
  const reads = await Promise.all(Array.from({ length: 200 }, () => reader.getCode(ADDRESS, AT)));
  assert.deepEqual(unread, []);
  assert.ok(reads.every((read) => read.kind === 'agreed'));
});
