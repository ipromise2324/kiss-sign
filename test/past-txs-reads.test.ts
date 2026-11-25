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

const PROXY_HASH = 'b89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000';
const SINGLETON = 'd9db270c1b5e3bd161e8c8503c55ceabee709552';

for (const [batch, word] of [['code hash', PROXY_HASH], ['slot', SINGLETON]] as const)
  for (const provider of ['alchemy', 'drpc'] as const)
    test(`a ${batch} only ${provider} changes is accepted from neither provider: its batch is read party by party`, async () => {
      let changed = 0;
      const lying = recorded.exchanges.map((e) => {
        const answer = JSON.stringify(e.answers[provider]);
        if (!isBatch(e) || !answer.includes(word)) return e;
        changed++;
        return { ...e, answers: { ...e.answers, [provider]: JSON.parse(answer.replaceAll(word, '0'.repeat(word.length))) as unknown } };
      });
      assert.equal(changed, 1);
      assert.deepEqual(await prove(lying), await singly());
      const batchesOnly = lying.filter((e) => isBatch(e) || e.method === 'eth_getBlockByHash');
      assert.deepEqual((await prove(batchesOnly)).map((p) => p.kind), recorded.parties.map(() => 'unreadable'));
    });

test('batches that were never recorded leave every party read alone', async () => {
  assert.deepEqual(await prove(recorded.exchanges.filter((e) => !isBatch(e))), await singly());
});

test('more than one batch of parties is proven in the order asked, whichever batch answers first', async () => {
  const addressOf = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address;
  const isSafe = (i: number) => i % 3 === 0 || i === 1000;
  let batches = 0;
  const reader = {
    header: async () => ({ kind: 'agreed', value: { ...at, time: 1n, gasLimit: 30_000_000n, mixHash: at.hash }, providers: ['alchemy', 'drpc'] }),
    simulateV1: async ({ stateOverrides, calls }: Parameters<Reader['simulateV1']>[0]) => {
      const asked = (calls[0]?.data ?? '0x').slice(2).match(/.{64}/g) ?? [];
      await new Promise((resolve) => setTimeout(resolve, asked.length / 10 - 2 * batches++));
      const slots = Object.keys(stateOverrides).length > 1;
      const words = asked.map((word) => (slots ? SINGLETON.padStart(64, '0') : isSafe(Number(BigInt(`0x${word}`)) - 1) ? PROXY_HASH : '0'.repeat(64)));
      return { kind: 'agreed', value: [{ status: 'success', returnData: `0x${words.join('')}` }], providers: ['alchemy', 'drpc'] };
    },
    getStorageAt: () => assert.fail('a party was read alone'),
  } as unknown as Reader;
  const proofs = await proveParties(reader, Array.from({ length: 1001 }, (_, i) => addressOf(i)), at);
  assert.deepEqual(proofs.map((p) => p.kind === 'safe'), Array.from({ length: 1001 }, (_, i) => isSafe(i)));
});

test('a batch with no answer, which the batch reader notes nowhere, leaves every party read alone and proven', async () => {
  const failing = replayReader([]);
  assert.deepEqual(await proveParties(replayReader(recorded.exchanges), recorded.parties, at, failing), await singly());
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
