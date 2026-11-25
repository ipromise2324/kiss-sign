import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keccakCode } from '../src/contracts/code.ts';
import type { Hex } from '../src/safe/types.ts';

const ROOT = join(import.meta.dirname, '..');
const CODE = '0x00' as Hex;
const HASH = `0x${'ab'.repeat(32)}`;

const STUB = `
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
const header = { number: '0x64', hash: '${HASH}', timestamp: '0x1', gasLimit: '0x1', mixHash: '${HASH}' };
const answers = { eth_blockNumber: '0x64', eth_getBlockByNumber: header, eth_getBlockByHash: header, eth_getCode: '${CODE}', eth_getStorageAt: '0x${'0'.repeat(64)}' };
https.request = (options, answered) =>
  Object.assign(new EventEmitter(), {
    end: (body) => {
      const { id, method } = JSON.parse(body);
      if (answers[method] === undefined) throw new Error(method + ' is not stubbed');
      const text = JSON.stringify({ jsonrpc: '2.0', id, result: answers[method] });
      setImmediate(() => answered(Object.assign(Readable.from([Buffer.from(text)]), { statusCode: 200, headers: {} })));
    },
    destroy: () => {},
  });
syncBuiltinESMExports();`;

const feed = (address: string, code?: object) => ({
  address,
  kind: 'oracle',
  source: 'https://example.com/feeds',
  feed: { description: 'ABC / USD', decimals: 8, heartbeat: 3600, deviationBps: 50, sourceClass: 'cex_price', quote: 'usd' },
  ...(code === undefined ? {} : { code }),
});
const PINNED = { hash: keccakCode(CODE), from: 1 };

function pinCode(entries: Record<string, object>, ...names: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'kiss-sign-pin-code-'));
  mkdirSync(join(home, 'history'));
  const path = join(home, 'history', 'registry.json');
  writeFileSync(path, JSON.stringify(entries));
  const run = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(STUB)}`, join(ROOT, 'scripts', 'pin-code.ts'), '--history', ...names], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: home, KISS_SIGN_HOME: home, ALCHEMY_API_KEY: 'test-key' },
    encoding: 'utf8',
  });
  return { ...run, written: readFileSync(path, 'utf8') };
}

test('pin-code exits 1 and names the entry when the file it wrote holds another feed with no pin', () => {
  const run = pinCode({ 'abc-usd': feed(`0x${'12'.repeat(20)}`, PINNED), 'abd-usd': feed(`0x${'34'.repeat(20)}`) }, 'abc-usd');
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /abc-usd \S+ 0x[0-9a-f]{64} from block 1 \(unchanged\)/);
  assert.match(run.stdout, /Wrote .*\nREFUSED .* as written does not load, so no command that reads it runs: .*abd-usd\.code: missing, and a price is read from it; run pnpm pin-code abd-usd/);
});

test('pin-code exits 0 when the file it wrote loads', () => {
  const run = pinCode({ 'abc-usd': feed(`0x${'12'.repeat(20)}`, PINNED) });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /REFUSED/);
});
