import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WIDTH, box, colorWanted, paint, rows, table, visible, wrap } from '../src/cli/format.ts';

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
  assert.deepEqual(wrap('  multiSend[1] to usdc 0xA0b8', 20), ['  multiSend[1] to', '  usdc 0xA0b8'], 'a leading indent stays on every line');
});

test('a table row too wide for 100 columns puts its address on a line of its own', () => {
  const wide = 'x'.repeat(60);
  const lines = table([['1.', wide, ADDRESS]], 2);
  assert.deepEqual(lines, [`  1.  ${wide}`, `      ${ADDRESS}`]);
  assert.deepEqual(table([['1.', 'usdc', ADDRESS]], 2), [`  1.  usdc  ${ADDRESS}`]);
});

test('Chinese text counts two columns a character: rows and tables align by display width, wrap within 100 columns, and never split an address', () => {
  assert.equal(visible('卡片 usdc'), 9);
  assert.deepEqual(rows([['Safe', ADDRESS], ['儲存庫', 'x']], 2), [`  Safe    ${ADDRESS}`, '  儲存庫  x']);
  const cells = table([['1.', '金庫', ADDRESS], ['2.', 'usdc-vault', ADDRESS]], 2);
  assert.deepEqual(cells.map((line) => visible(line.slice(0, line.indexOf('0x')))), [18, 18]);
  const sentence = `${'這筆交易只簽了一則訊息的摘要，'.repeat(8)}地址 ${ADDRESS} ${'不在這筆交易裡。'.repeat(6)}`;
  const lines = rows([['滑價', sentence]], 4);
  assert.ok(lines.length > 2);
  assert.ok(lines.every((line) => visible(line) <= WIDTH), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes(ADDRESS)));
  const values = lines.map((line) => line.replace(/^ {4}(滑價)? */, ''));
  assert.ok(values.every((value) => !/^[，。、：]/.test(value)), 'a line never starts with closing punctuation');
  assert.equal(values.join('').replaceAll(' ', ''), sentence.replaceAll(' ', ''));
});
