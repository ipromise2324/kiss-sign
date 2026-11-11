import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { replayAbiCase } from '../src/contracts/abi-case.ts';
import type { AbiCase } from '../src/contracts/abi-case.ts';
import { SOLC_TEST_CACHE_DIR, warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'abi', 'bundler3.json'), 'utf8')) as AbiCase;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

type Entry = { outputSha256: string; output: string };
const entryOf = (dir: string): { path: string; entry: Entry } => {
  const files = readdirSync(dir);
  assert.equal(files.length, 1, `one cache entry, not ${files.join(', ')}`);
  const path = join(dir, files[0] as string);
  return { path, entry: JSON.parse(readFileSync(path, 'utf8')) as Entry };
};
const proveWith = async (dir: string) => (await replayAbiCase(fixture, await warmCompilers([fixture], dir))).kind;

test('no command under src/, scripts/ or bin/ names the test-only solc cache', () => {
  const cacheName = relative(ROOT, SOLC_TEST_CACHE_DIR);
  for (const dir of ['src', 'scripts', 'bin']) {
    for (const file of readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })) {
      if (!/\.(ts|js)$|^kiss-sign$/.test(file)) continue;
      const text = readFileSync(join(ROOT, dir, file), 'utf8');
      for (const name of [cacheName, 'solc-test', 'solc-pool', 'SOLC_TEST_CACHE']) assert.ok(!text.includes(name), `${dir}/${file} names ${name}`);
    }
  }
});

test('a cache miss compiles and writes an entry; a corrupt or mismatched entry is compiled again and overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'solc-cache-'));
  assert.equal(await proveWith(dir), 'proven');
  const { path, entry } = entryOf(dir);
  assert.equal(entry.outputSha256, sha256(entry.output));

  writeFileSync(path, '{"outputSha256":');
  assert.equal(await proveWith(dir), 'proven');
  assert.deepEqual(entryOf(dir).entry, entry);

  writeFileSync(path, JSON.stringify({ outputSha256: entry.outputSha256, output: entry.output.replace(/"object":"6/g, '"object":"7') }));
  assert.equal(await proveWith(dir), 'proven');
  assert.deepEqual(entryOf(dir).entry, entry);
});

test('a cache entry is still compared with the code on chain: a consistent entry with other bytecode is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'solc-cache-'));
  await proveWith(dir);
  const { path, entry } = entryOf(dir);
  const output = entry.output.replace(/"object":"6/g, '"object":"7');
  assert.notEqual(output, entry.output);
  writeFileSync(path, JSON.stringify({ outputSha256: sha256(output), output }));
  assert.equal(await proveWith(dir), 'refused');
});
