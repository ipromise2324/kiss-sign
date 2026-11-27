import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turns } from '../src/research/turns.ts';

test('two streams through one turn never overlap, each request starts a pause after the one before, and a failed one frees the turn', async () => {
  const turn = turns(30);
  const spans: [number, number][] = [];
  let open = 0;
  let most = 0;
  const ask = (ms: number, fail = false) => async () => {
    const start = performance.now();
    most = Math.max(most, ++open);
    await new Promise((resolve) => setTimeout(resolve, ms));
    open--;
    spans.push([start, performance.now()]);
    if (fail) throw new Error('refused');
    return ms;
  };
  const stream = async (asks: readonly (() => Promise<number>)[]) => {
    const out: (number | string)[] = [];
    for (const a of asks) out.push(await turn(a).catch((error: Error) => error.message));
    return out;
  };
  const [a, b] = await Promise.all([stream([ask(5), ask(5, true), ask(5)]), stream([ask(5), ask(5)])]);
  assert.deepEqual([a, b], [[5, 'refused', 5], [5, 5]]);
  assert.equal(most, 1);
  const starts = spans.map(([start]) => start).sort((x, y) => x - y);
  for (let i = 1; i < starts.length; i++) assert.ok((starts[i] as number) - (starts[i - 1] as number) >= 29, `start ${i} only ${(starts[i] as number) - (starts[i - 1] as number)} ms after the one before`);
});
