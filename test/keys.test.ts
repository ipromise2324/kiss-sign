import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli/main.ts';
import type { Io } from '../src/cli/main.ts';

const KEY = 'planted-key-123';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'kiss-sign-keys-'));
}

async function run(argv: string[], env: Record<string, string>, typed?: string) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    readSecret: typed === undefined ? undefined : async () => typed,
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, all: stdout + stderr };
}

test('key add writes the key file with mode 0600 and keeps other lines', async () => {
  const home = freshHome();
  writeFileSync(join(home, '.env'), 'ETHERSCAN_API_KEY=other-key-456\n# a note\n', { mode: 0o644 });
  const result = await run(['key', 'add', 'alchemy'], { KISS_SIGN_HOME: home }, KEY);
  assert.equal(result.code, 0);
  assert.ok(!result.all.includes(KEY));
  const path = join(home, '.env');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8'), `ETHERSCAN_API_KEY=other-key-456\n# a note\nALCHEMY_API_KEY=${KEY}\n`);
});

test('key add replaces an existing key instead of adding a second line', async () => {
  const home = freshHome();
  await run(['key', 'add', 'alchemy'], { KISS_SIGN_HOME: home }, 'first-key-0001');
  await run(['key', 'add', 'alchemy'], { KISS_SIGN_HOME: home }, KEY);
  assert.equal(readFileSync(join(home, '.env'), 'utf8'), `ALCHEMY_API_KEY=${KEY}\n`);
});

test('key add refuses without a terminal and writes nothing', async () => {
  const home = freshHome();
  const result = await run(['key', 'add', 'alchemy'], { KISS_SIGN_HOME: home });
  assert.equal(result.code, 64);
  assert.match(result.stderr, /hidden prompt/);
  assert.throws(() => statSync(join(home, '.env')));
});

test('key add refuses a key given on the command line', async () => {
  const result = await run(['key', 'add', 'alchemy', KEY], { KISS_SIGN_HOME: freshHome() }, KEY);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /shell history/);
});

test('key list says where each key comes from and never shows any of it', async () => {
  const home = freshHome();
  assert.match((await run(['key', 'list'], { KISS_SIGN_HOME: home })).stdout, /ALCHEMY_API_KEY: not set/);
  await run(['key', 'add', 'etherscan'], { KISS_SIGN_HOME: home }, KEY);
  const listed = await run(['key', 'list'], { KISS_SIGN_HOME: home, ALCHEMY_API_KEY: KEY });
  assert.match(listed.stdout, /ALCHEMY_API_KEY: set \(environment\)/);
  assert.match(listed.stdout, /ETHERSCAN_API_KEY: set \(file\)/);
  for (const piece of [KEY, KEY.slice(-4), KEY.slice(0, 4)]) assert.ok(!listed.all.includes(piece), `shows ${piece}`);
});

test('a .env in the working directory is never read', async () => {
  const cwd = process.cwd();
  const dir = freshHome();
  writeFileSync(join(dir, '.env'), `ALCHEMY_API_KEY=${KEY}\n`);
  process.chdir(dir);
  try {
    const listed = await run(['key', 'list'], { KISS_SIGN_HOME: freshHome() });
    assert.match(listed.stdout, /ALCHEMY_API_KEY: not set/);
  } finally {
    process.chdir(cwd);
  }
});

test('key remove takes out only that key', async () => {
  const home = freshHome();
  await run(['key', 'add', 'alchemy'], { KISS_SIGN_HOME: home }, KEY);
  await run(['key', 'add', 'etherscan'], { KISS_SIGN_HOME: home }, 'other-key-456');
  const removed = await run(['key', 'remove', 'alchemy'], { KISS_SIGN_HOME: home });
  assert.equal(removed.code, 0);
  assert.equal(readFileSync(join(home, '.env'), 'utf8'), 'ETHERSCAN_API_KEY=other-key-456\n');
  assert.equal(statSync(join(home, '.env')).mode & 0o777, 0o600);
  assert.match((await run(['key', 'remove', 'alchemy'], { KISS_SIGN_HOME: home })).stdout, /No Alchemy key/);
});

test('an unknown command prints usage', async () => {
  const result = await run(['frobnicate'], {});
  assert.equal(result.code, 64);
  assert.match(result.stderr, /kiss-sign key add/);
});
