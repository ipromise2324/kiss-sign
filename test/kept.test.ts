import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HttpAnswer } from '../src/chain/https.ts';
import { keptEtherscan, keptGet, keptHints, keptTransport } from '../src/research/kept.ts';
import { createReader } from '../src/chain/reader.ts';
import { REPLAY_ENDPOINTS, recordingTransport } from '../src/chain/recording.ts';
import type { Transport } from '../src/chain/rpc.ts';
import { readRunningCode } from '../src/contracts/code.ts';
import { CreationLookupError } from '../src/research/deployer.ts';
import { parseAddress } from '../src/safe/types.ts';
import type { Hex } from '../src/safe/types.ts';

const signal = new AbortController().signal;
const body = (method: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] });
const ok = (result: unknown) => ({ status: 200, text: JSON.stringify({ result }) });

/** Answers the given answers in turn, counting the requests that reach it. */
function inTurn(answers: readonly (HttpAnswer | Error)[]) {
  let asked = 0;
  const next = async () => {
    const answer = answers[Math.min(asked++, answers.length - 1)] as HttpAnswer | Error;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { next, asked: () => asked };
}

test('a chain answer is asked once, for a concurrent and a later reader alike, and each provider is asked for its own', async () => {
  const chain = inTurn([ok('0x01'), ok('0x02')]);
  const transport = keptTransport(chain.next);
  const [a, b] = await Promise.all([transport('https://one', body('eth_getCode'), signal), transport('https://one', body('eth_getCode'), signal)]);
  assert.deepEqual([a.text, b.text, (await transport('https://one', body('eth_getCode'), signal)).text], Array(3).fill(ok('0x01').text));
  assert.equal((await transport('https://two', body('eth_getCode'), signal)).text, ok('0x02').text, "the other provider's answer is never the first one's");
  assert.equal(chain.asked(), 2);
});

test('a request that failed, was refused, erred, held no JSON or answered null is asked again, and its answer then kept', async () => {
  for (const failed of [new Error('down'), { status: 429, text: '' }, { status: 200, text: '{"error":{"code":-32000}}' }, { status: 200, text: 'busy' }, ok(null)]) {
    const chain = inTurn([failed, ok('0x01')]);
    const transport = keptTransport(chain.next);
    const ask = () => transport('https://one', body('eth_getCode'), signal);
    await ask().catch(() => undefined);
    assert.equal((await ask()).text, ok('0x01').text);
    await ask();
    assert.equal(chain.asked(), 2);
  }
});

test('the head is never kept', async () => {
  const chain = inTurn([ok('0x1'), ok('0x2')]);
  const transport = keptTransport(chain.next);
  const head = async () => (await transport('https://one', body('eth_blockNumber'), signal)).text;
  assert.notEqual(await head(), await head());
});

test('a page that is busy or rate limited is asked again; an answer, such as 404, is kept', async () => {
  const limited = { status: 403, text: 'API rate limit exceeded' };
  const api = inTurn([limited, { status: 200, text: '{}' }]);
  const get = keptGet(api.next);
  assert.equal((await get('https://api.github.com/x')).status, 403);
  assert.equal((await get('https://api.github.com/x')).status, 200);
  const missing = inTurn([{ status: 404, text: '' }, { status: 200, text: '' }]);
  const page = keptGet(missing.next);
  await page('https://example.org/');
  assert.equal((await page('https://example.org/')).status, 404);
});

test('Etherscan is asked one address at a time, and a refusal sent with status 200 is asked again', async () => {
  const [a, b] = ['0x4e59b44847b379578588920ca78fbf26c0b4956c', '0x914d7fec6aac8cd542e72bca78b30650d45643d7'].map((address) => parseAddress('a', address));
  let open = 0;
  let most = 0;
  let refused = true;
  const get = keptEtherscan(async (address) => {
    most = Math.max(most, ++open);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open--;
    if (address === a && refused) return { status: 200, body: { status: '0', result: 'Max rate limit reached' } };
    return { status: 200, body: { status: '1', result: [address] } };
  });
  await Promise.all([get(a!), get(b!)]);
  assert.equal(most, 1);
  refused = false;
  assert.deepEqual((await get(a!)).body, { status: '1', result: [a] });
});

test('creation hints that got no answer are asked again, and the next answer is kept', async () => {
  let asked = 0;
  const hints = keptHints(() => async () => {
    if (asked++ === 0) throw new CreationLookupError('unreachable');
    return new Map();
  });
  const address = [parseAddress('a', '0x4e59b44847b379578588920ca78fbf26c0b4956c')];
  await assert.rejects(hints('key', () => {})(address), CreationLookupError);
  await hints('key', () => {})(address);
  await hints('key', () => {})(address);
  assert.equal(asked, 2);
});

test('a recording made after its reads were warmed several at a time is the one a run that asks them one by one makes', async () => {
  const at = { number: 300n, hash: `0x${'30'.repeat(32)}` as Hex };
  const addresses = ['11', '22', '33', '44'].map((byte) => parseAddress('a', `0x${byte.repeat(20)}`));
  let arrivals = 0;
  const atOnce: Transport = async (_url, sent) => {
    const { method, params } = JSON.parse(sent) as { method: string; params: [string] };
    return ok(method === 'eth_getCode' ? `0x60${params[0].slice(2, 4)}` : `0x${'00'.repeat(32)}`);
  };
  const outOfOrder: Transport = async (url, sent, abort) => {
    await new Promise((resolve) => setTimeout(resolve, (arrivals++ * 7) % 11));
    return atOnce(url, sent, abort);
  };
  const record = async (transport: Transport) => {
    const chain = recordingTransport(transport, REPLAY_ENDPOINTS);
    for (const address of addresses) await readRunningCode(createReader(REPLAY_ENDPOINTS, chain.transport), address, at);
    return JSON.stringify(chain.exchanges());
  };
  const warmed = keptTransport(outOfOrder);
  await Promise.all(addresses.toReversed().map((address) => readRunningCode(createReader(REPLAY_ENDPOINTS, warmed), address, at)));
  const kept = await record(warmed);
  assert.equal(kept, await record(atOnce));
});

test("a caller that stops waiting leaves a shared chain request running for the callers still waiting, and its answer is kept", async () => {
  let asked = 0;
  let release: () => void = () => {};
  const slow: Transport = (_url, _body, abort) => {
    asked++;
    return new Promise((resolve, reject) => {
      abort.addEventListener('abort', () => reject(new Error('aborted')));
      release = () => resolve(ok('0x01'));
    });
  };
  const transport = keptTransport(slow);
  const first = new AbortController();
  const gaveUp = transport('https://one', body('eth_getCode'), first.signal);
  const waiting = transport('https://one', body('eth_getCode'), signal);
  first.abort(new Error('the first caller gave up'));
  await assert.rejects(gaveUp, /the first caller gave up/);
  release();
  assert.equal((await waiting).text, ok('0x01').text);
  assert.equal((await transport('https://one', body('eth_getCode'), signal)).text, ok('0x01').text);
  assert.equal(asked, 1);
});

test('a reader whose own time runs out while a shared request is slow says it timed out', async () => {
  const never: Transport = () => new Promise(() => {});
  const reads: string[] = [];
  const reader = createReader(REPLAY_ENDPOINTS, keptTransport(never), { timeoutMs: 5, retryPausesMs: [], note: (read) => void reads.push(read) });
  await reader.getCode(parseAddress('a', '0x4e59b44847b379578588920ca78fbf26c0b4956c'), { number: 1n, hash: `0x${'01'.repeat(32)}` as Hex });
  assert.ok(reads.length > 0 && reads.every((read) => read.endsWith('timeout')), reads.join());
});
