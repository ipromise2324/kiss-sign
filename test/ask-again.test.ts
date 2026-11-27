import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Reader } from '../src/chain/reader.ts';
import { createReader } from '../src/chain/reader.ts';
import { REPLAY_ENDPOINTS } from '../src/chain/recording.ts';
import type { Transport } from '../src/chain/rpc.ts';
import type { BlockRef } from '../src/chain/types.ts';
import { askAgain, BlockReplacedError } from '../src/research/ask-again.ts';
import { keptTransport } from '../src/research/kept.ts';
import { parseAddress } from '../src/safe/types.ts';
import type { Hex } from '../src/safe/types.ts';

const block: BlockRef = { number: 300n, hash: `0x${'30'.repeat(32)}` as Hex };
const chainAt = (hash: Hex): Pick<Reader, 'block'> => ({ block: async (number) => ({ kind: 'agreed', value: { number: number as bigint, hash }, providers: ['alchemy', 'drpc'] }) });
const addresses = ['11', '22', '33'].map((byte) => parseAddress('a', `0x${byte.repeat(20)}`));
const quiet = () => {};

/** Reads each address's code; a request for the second fails while `down` requests are left to fail. */
function codeRun(down: number) {
  const asked: string[] = [];
  const network: Transport = async (url, body) => {
    const { params } = JSON.parse(body) as { params: [string] };
    asked.push(`${url} ${params[0]}`);
    if (params[0] === addresses[1] && url.includes('drpc') && down-- > 0) return { status: 503, text: '' };
    return { status: 200, text: JSON.stringify({ result: `0x60${params[0].slice(2, 4)}` }) };
  };
  const unread: string[] = [];
  const reader = createReader(REPLAY_ENDPOINTS, keptTransport(network), { retryPausesMs: [], note: (read) => void unread.push(read) });
  const run = async () => {
    const codes = [];
    for (const address of addresses) codes.push(await reader.getCode(address, block));
    return codes.map((code) => (code.kind === 'agreed' ? code.value : 'unread'));
  };
  return { asked, unread, run };
}

test('a section with a read that got no answer sends only that read again, and gives what an untroubled run gives', async () => {
  const troubled = codeRun(1);
  const codes = await askAgain(troubled.unread, chainAt(block.hash), [block], troubled.run, [0], quiet);
  assert.deepEqual(codes, await codeRun(0).run());
  assert.deepEqual(troubled.unread, []);
  assert.deepEqual(
    troubled.asked.filter((request, i) => troubled.asked.indexOf(request) !== i),
    [`https://drpc.replay ${addresses[1]}`],
  );
});

test('a read still without an answer after the last pause stays unread, and an earlier section keeps its own', async () => {
  const down = codeRun(Infinity);
  down.unread.push('earlier');
  assert.deepEqual(await askAgain(down.unread, chainAt(block.hash), [block], down.run, [0, 0], quiet), ['0x6011', 'unread', '0x6033']);
  assert.deepEqual(down.unread, ['earlier', 'drpc eth_getCode: http-error']);
});

test('a block replaced before the failed reads go out again refuses the run, so no run holds two blocks', async () => {
  const troubled = codeRun(1);
  await assert.rejects(askAgain(troubled.unread, chainAt(`0x${'31'.repeat(32)}` as Hex), [block], troubled.run, [0], quiet), BlockReplacedError);
  const untroubled = codeRun(0);
  assert.equal((await askAgain(untroubled.unread, chainAt(`0x${'31'.repeat(32)}` as Hex), [block], untroubled.run, [0], quiet)).length, 3, 'no read is asked again, so nothing is checked');
});

test('a section that throws over an unanswered read runs again; one that throws over an answer does not', async () => {
  const unread: string[] = [];
  let runs = 0;
  const overRead = async () => {
    if (runs++ === 0) {
      unread.push('read');
      throw new Error('no answer');
    }
    return 'read';
  };
  assert.equal(await askAgain(unread, chainAt(block.hash), [block], overRead, [0], quiet), 'read');
  runs = 0;
  const overAnswer = async () => {
    runs++;
    throw new Error('two entries');
  };
  await assert.rejects(askAgain(unread, chainAt(block.hash), [block], overAnswer, [0], quiet), /two entries/);
  assert.equal(runs, 1);
});

test('a block the chain cannot confirm is asked again after each pause and then refuses the run; a block confirmed on a later try lets it go on', async () => {
  let asked = 0;
  const unconfirmed = (good: number): Pick<Reader, 'block'> => ({
    block: async (number) => (asked++ < good ? { kind: 'unverifiable', reason: 'drpc failed (timeout)', answers: [{ kind: 'failed', provider: 'alchemy', cause: 'timeout' }, { kind: 'failed', provider: 'drpc', cause: 'timeout' }] } : { kind: 'agreed', value: { number: number as bigint, hash: block.hash }, providers: ['alchemy', 'drpc'] }),
  });
  const troubled = codeRun(1);
  await assert.rejects(askAgain(troubled.unread, unconfirmed(Infinity), [block], troubled.run, [0, 0], quiet), (error: unknown) => error instanceof BlockReplacedError && /could not be confirmed/.test(error.message));
  assert.equal(asked, 3, 'asked once and again after each pause');
  asked = 0;
  const later = codeRun(1);
  assert.deepEqual(await askAgain(later.unread, unconfirmed(1), [block], later.run, [0], quiet), await codeRun(0).run());
});
