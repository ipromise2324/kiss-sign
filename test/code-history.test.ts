import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Reader } from '../src/chain/reader.ts';
import type { BlockRef, BlockTag } from '../src/chain/types.ts';
import { keccakCode, readCodeHistory } from '../src/contracts/code.ts';
import type { Address, Hex } from '../src/safe/types.ts';

const CONTRACT = `0x${'c0'.repeat(20)}` as Address;
const HEAD = 400n;
const agreed = <T>(value: T) => ({ kind: 'agreed', value, providers: ['alchemy', 'drpc'] }) as const;

type Block = { readonly code: Hex } | 'disagree' | 'throws';

function chain(at: (n: bigint) => Block): Reader {
  const read = (n: bigint) => {
    const block = at(n);
    if (block === 'throws') throw new Error(`no answer for block ${n}`);
    return block;
  };
  return {
    providers: ['alchemy', 'drpc'],
    block: async (tag: BlockTag) => {
      const n = tag === 'latest' ? HEAD : (tag as bigint);
      return read(n) === 'disagree'
        ? { kind: 'unverifiable', reason: 'eth_getBlockByNumber: alchemy and drpc disagree', answers: [] }
        : agreed({ number: n, hash: `0x${'00'.repeat(32)}` as Hex });
    },
    getCode: async (_address: Address, ref: BlockRef) => agreed((read(ref.number) as { code: Hex }).code),
    getStorageAt: async () => agreed(`0x${'00'.repeat(32)}` as Hex),
  } as unknown as Reader;
}

const pin = (code: string) => ({ hash: keccakCode(code as Hex) });

test('pin-code finds every change of a code that changed many times, adjacent blocks included', async () => {
  const starts: readonly [bigint, string][] = [
    [100n, '0x6001'],
    [101n, '0x6002'],
    [150n, '0x6003'],
    [233n, '0x6001'],
    [250n, '0x6004'],
    [399n, '0x6005'],
  ];
  const codeAt = (n: bigint) => (starts.findLast(([from]) => from <= n)?.[1] ?? '0x') as Hex;
  const history = await readCodeHistory(chain((n) => ({ code: codeAt(n) })), CONTRACT, HEAD, pin('0x6005'));
  assert.deepEqual(history, {
    kind: 'read',
    pins: {
      earlier: starts.slice(0, -1).map(([from, code]) => ({ from, pin: pin(code) })),
      current: { from: 399n, pin: pin('0x6005') },
    },
    before: { why: 'no-code', at: CONTRACT },
  });
});

test('a block the providers disagree on refuses the whole history when the halving reaches it, and changes nothing when it does not', async () => {
  const deployedAtGenesis = (bad: bigint, how: 'disagree' | 'throws') => chain((n) => (n === bad ? how : { code: '0x6001' as Hex }));
  const held = { kind: 'read', pins: { earlier: [], current: { from: 0n, pin: pin('0x6001') } }, before: 'genesis' };
  assert.deepEqual(await readCodeHistory(deployedAtGenesis(49n, 'disagree'), CONTRACT, HEAD, pin('0x6001')), {
    kind: 'refused',
    refusal: { why: 'unverifiable', read: 'eth_getBlockByNumber: alchemy and drpc disagree' },
  });
  assert.deepEqual(await readCodeHistory(deployedAtGenesis(299n, 'disagree'), CONTRACT, HEAD, pin('0x6001')), held, 'halving from 400 toward 0 never reads block 299');
  assert.deepEqual(await readCodeHistory(deployedAtGenesis(299n, 'throws'), CONTRACT, HEAD, pin('0x6001')), held);
});
