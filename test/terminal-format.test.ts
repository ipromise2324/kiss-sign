import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WIDTH, box, colorWanted, paint, rows, table, wrap } from '../src/cli/format.ts';

const ADDRESS = '0x093272C07700d3cA5301C3Bf9B3A392624179E2F';
const ANSI = /\x1b\[[0-9;]*m/g;

test('colour only at a terminal, never with NO_COLOR set or TERM=dumb', () => {
  assert.equal(colorWanted(true, {}), true);
  assert.equal(colorWanted(true, { NO_COLOR: '' }), true);
  assert.equal(colorWanted(true, { NO_COLOR: '1' }), false);
  assert.equal(colorWanted(true, { TERM: 'dumb' }), false);
  assert.equal(colorWanted(false, {}), false);
  assert.equal(colorWanted(undefined, {}), false);
});

test('colour changes no character of the text, and plain paint adds none', () => {
  const lines = box('Your card', rows([['vault', `hyperithm-usdc-apex-v2-9e2f  ${ADDRESS}`, paint(true).picked]], 2, WIDTH - 2), paint(true).ok);
  assert.ok(lines.join('\n').includes('\x1b['));
  const plain = box('Your card', rows([['vault', `hyperithm-usdc-apex-v2-9e2f  ${ADDRESS}`, paint(false).picked]], 2, WIDTH - 2));
  assert.deepEqual(lines.map((line) => line.replace(ANSI, '')), plain);
  assert.ok(!plain.join('\n').includes('\x1b['));
});

test('a long value wraps at spaces within 100 columns and never splits an address', () => {
  const value = `${'word '.repeat(30)}${ADDRESS} ${'more '.repeat(10)}`.trim();
  const lines = rows([['margin', value]], 4);
  assert.ok(lines.every((line) => line.length <= WIDTH), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes(ADDRESS)));
  assert.deepEqual(wrap('a b', 1), ['a', 'b']);
});

test('a table row too wide for 100 columns puts its address on a line of its own', () => {
  const wide = 'x'.repeat(60);
  const lines = table([['1.', wide, ADDRESS]], 2);
  assert.deepEqual(lines, [`  1.  ${wide}`, `      ${ADDRESS}`]);
  assert.deepEqual(table([['1.', 'usdc', ADDRESS]], 2), [`  1.  usdc  ${ADDRESS}`]);
});
