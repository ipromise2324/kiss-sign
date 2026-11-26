import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Reader } from '../src/chain/reader.ts';
import type { BlockRef, BlockTag } from '../src/chain/types.ts';
import type { Hex } from '../src/safe/types.ts';
import { SETTLED_DEPTH, settledBlock } from '../src/research/settled.ts';

const providers = ['alchemy', 'drpc'] as const;
const at = (tag: BlockTag): BlockRef => ({ number: tag as bigint, hash: `0x${'aa'.repeat(32)}` as Hex });

test('a settled block is read by its number, behind the head both providers are at', async () => {
  const reader = { blockNumber: async () => ({ kind: 'agreed', value: 100n, providers }), block: async (tag: BlockTag) => ({ kind: 'agreed', value: at(tag), providers }) } as unknown as Reader;
  assert.deepEqual(await settledBlock(reader), { kind: 'agreed', value: at(100n - SETTLED_DEPTH), providers });
});

test('with no agreed head there is no settled block', async () => {
  const unread = { kind: 'unverifiable', reason: 'the providers disagree', answers: [] };
  const reader = { blockNumber: async () => unread, block: async () => assert.fail('no block is read') } as unknown as Reader;
  assert.deepEqual(await settledBlock(reader), unread);
});
