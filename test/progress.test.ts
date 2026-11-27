import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { progress } from '../src/research/progress.ts';

test('a long run says on every beat what it has read and what it waits for, and nothing once stopped', async () => {
  const lines: string[] = [];
  const shown = progress((line) => void lines.push(line), 5);
  let answer = (_: unknown): void => undefined;
  const transport = shown.transport(() => new Promise((resolve) => (answer = resolve as typeof answer)));
  const read = transport('https://provider.test', '{}', AbortSignal.timeout(1000));
  await wait(20);
  answer({ status: 200, text: '' });
  await read;
  await wait(20);
  shown.stop();
  const stopped = lines.length;
  await wait(20);
  assert.equal(lines[0], '0 s: 0 search pages, 0 chain answers, 0 call traces; 1 waiting for an answer\n');
  assert.equal(lines.at(-1), '0 s: 0 search pages, 1 chain answers, 0 call traces; nothing open: pausing before a retry, or computing\n');
  assert.equal(lines.length, stopped);
});
