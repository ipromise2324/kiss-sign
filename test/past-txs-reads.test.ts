import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import type { Read, Reader } from '../src/chain/reader.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import type { BlockRef, Transaction } from '../src/chain/types.ts';
import { proveParties } from '../src/research/safe-parties.ts';
import { sharedReads } from '../src/research/shared-reads.ts';
import { PAGE, RANGE_PAGES, pagesAhead } from '../src/research/sources.ts';
import { proveParty } from '../src/research/study.ts';
import type { Address, Hex } from '../src/safe/types.ts';

type Recorded = { readonly block: { readonly number: string; readonly hash: Hex }; readonly parties: readonly Address[]; readonly exchanges: readonly Exchange[] };
const recorded = readRecording<Recorded>(join(import.meta.dirname, '..', 'testdata', 'past-txs', 'safe-parties.json'));
const at: BlockRef = { number: BigInt(recorded.block.number), hash: recorded.block.hash };
const isBatch = ({ method }: Exchange) => method === 'eth_simulateV1';
const prove = (exchanges: readonly Exchange[]) => proveParties(replayReader(exchanges), recorded.parties, at);
const singly = () => Promise.all(recorded.parties.map((party) => proveParty(replayReader(recorded.exchanges), party, at)));

test('parties read in batches are proven as each read alone is, both providers answering live', async () => {
  const batched = await prove(recorded.exchanges.filter((e) => isBatch(e) || e.method === 'eth_getBlockByHash'));
  assert.deepEqual(batched, await singly());
  assert.deepEqual(batched.map((p) => p.kind), ['safe', 'safe', 'safe', 'not-safe', 'not-safe', 'not-safe', 'not-safe']);
});

test('a batch the providers disagree on, or that was never recorded, reads each of its parties alone', async () => {
  const lying = recorded.exchanges.map((e) => (isBatch(e) ? { ...e, answers: { ...e.answers, drpc: JSON.parse(JSON.stringify(e.answers.drpc).replaceAll('b89c1b3b', '00000000')) as unknown } } : e));
  assert.deepEqual(await prove(lying), await singly());
  assert.deepEqual(await prove(recorded.exchanges.filter((e) => !isBatch(e))), await singly());
});

test('a transaction is read once in a run, until both providers give the same answer', async () => {
  const hash = `0x${'11'.repeat(32)}` as Hex;
  const answers: Read<Transaction | null>[] = [
    { kind: 'unverifiable', reason: 'busy', answers: [{ provider: 'alchemy', kind: 'failed', cause: 'timeout' }, { provider: 'drpc', kind: 'malformed' }] },
    { kind: 'agreed', value: null, providers: ['alchemy', 'drpc'] },
  ];
  let asked = 0;
  const reader = sharedReads({ getTransaction: async () => answers[asked++] } as unknown as Reader);
  assert.equal((await reader.getTransaction(hash)).kind, 'unverifiable');
  const both = await Promise.all([reader.getTransaction(hash), reader.getTransaction(hash)]);
  assert.deepEqual([both.map((r) => r.kind), asked], [['agreed', 'agreed'], 2]);
});

const full = { status: '1', result: Array.from({ length: PAGE }, () => ({})) };
const query = (page: number) => ({ address: '0xa', page: String(page) });

test('a full Etherscan page asks the next ones early, each page once and none past the last one a range may hold', async () => {
  const asked: string[] = [];
  const ask = pagesAhead(async (q) => (asked.push(q.page as string), full), () => undefined);
  for (let page = 1; page <= RANGE_PAGES; page++) assert.equal(await ask(query(page), 'empty'), full);
  assert.deepEqual(asked, Array.from({ length: RANGE_PAGES }, (_, i) => String(i + 1)));
});

test('a short Etherscan page asks nothing early, and a page asked early that the search never reaches leaves no unread note', async () => {
  const asked: string[] = [];
  const unread: string[] = [];
  const ask = pagesAhead(async (q, note) => {
    asked.push(q.page as string);
    if (q.page === '1') return full;
    note(`page ${q.page}`);
    throw new Error('unreachable');
  }, (read) => void unread.push(read));
  await ask(query(1), 'empty');
  assert.deepEqual(unread, []);
  await assert.rejects(ask(query(2), 'empty'), /unreachable/);
  assert.deepEqual(unread, ['page 2']);
  const short = pagesAhead(async (q) => (asked.push(`short ${q.page}`), { status: '1', result: [{}] }), () => undefined);
  await short(query(1), 'empty');
  assert.equal(asked.filter((a) => a.startsWith('short')).length, 1);
});
