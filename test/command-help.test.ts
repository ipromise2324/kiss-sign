import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const SEALED_OFF = pathToFileURL(join(import.meta.dirname, 'sealed-off.ts')).href;

const SIGNING = [[], ['init'], ['key'], ['key', 'add'], ['key', 'list'], ['key', 'remove'], ['book'], ['book', 'add'], ['book', 'list'], ['template', 'approve'], ['card'], ['card', 'new'], ['card', 'seal'], ['verify'], ['replay']];
const SCRIPTS = [
  'abi', 'api-source', 'attacks', 'check-sources', 'decode-tx', 'erc7730', 'events', 'fetch-vendored', 'find-sources', 'history', 'instance-evidence', 'notes-needed', 'past-txs', 'progress', 'perturb', 'pin-code', 'pin-packages',
  'pin-solc', 'pool-depth', 'prove-abi', 'prove-instance', 'read', 'record-abi-case', 'record-eoa-tx', 'record-safe-proxy', 'record-safe-tx', 'simulate', 'survey', 'template', 'verdict-core',
];

/** Runs a command with no key in the environment, no network, and its home, ~/.kiss-sign and vendor/ sealed: touching any of them throws. */
function runHelp(file: string, args: readonly string[]) {
  const sandbox = mkdtempSync(join(tmpdir(), 'kiss-sign-help-'));
  const home = join(sandbox, 'home');
  const sealed = [home, join(sandbox, '.kiss-sign'), join(ROOT, 'vendor')].join(':');
  try {
    const run = spawnSync(process.execPath, ['--import', SEALED_OFF, file, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: sandbox, KISS_SIGN_HOME: home, SEALED_PATHS: sealed },
      encoding: 'utf8',
    });
    return { ...run, homeTouched: existsSync(home) };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const tracked = (): string => execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });

for (const words of SIGNING) {
  test(`kiss-sign ${[...words, '--help'].join(' ')} prints its usage and exits 0 without a home, a key or the network`, () => {
    const before = tracked();
    const run = runHelp(join(ROOT, 'bin', 'kiss-sign'), [...words, '--help']);
    assert.equal(run.stderr, '');
    assert.equal(run.status, 0);
    assert.match(run.stdout, new RegExp(`^usage: pnpm kiss-sign ${words.length === 0 ? '<command>' : words.join(' ')}`));
    assert.equal(run.homeTouched, false);
    assert.equal(tracked(), before);
  });
}

test('kiss-sign verify -h prints the same help as --help', () => {
  assert.equal(runHelp(join(ROOT, 'bin', 'kiss-sign'), ['verify', '-h']).stdout, runHelp(join(ROOT, 'bin', 'kiss-sign'), ['verify', '--help']).stdout);
});

test('kiss-sign replay given a file named -h after -- reads no help and does not exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-replay-'));
  try {
    writeFileSync(join(dir, '-h'), '{}');
    const run = spawnSync(process.execPath, [join(ROOT, 'bin', 'kiss-sign'), 'replay', '--', '-h'], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, KISS_SIGN_HOME: join(dir, 'home') },
      encoding: 'utf8',
    });
    assert.doesNotMatch(run.stdout, /usage: pnpm kiss-sign replay/);
    assert.notEqual(run.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kiss-sign verify --card <hash> --help is not a request for help', () => {
  const run = runHelp(join(ROOT, 'bin', 'kiss-sign'), ['verify', '--card', '0x00', '--help']);
  assert.doesNotMatch(run.stdout, /^usage: pnpm kiss-sign verify/);
  assert.notEqual(run.status, 0);
});

for (const command of ['check', 'implied-card']) {
  test(`pnpm template ${command} --help prints the template help`, () => {
    const run = runHelp(join(ROOT, 'scripts', 'template.ts'), [command, '--help']);
    assert.equal(run.stderr, '');
    assert.equal(run.status, 0);
    assert.match(run.stdout, /^usage: pnpm template check /);
  });
}

test('pnpm history fetch -h prints the history help', () => {
  const run = runHelp(join(ROOT, 'scripts', 'history.ts'), ['fetch', '-h']);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /^usage: pnpm history /);
});

test('pnpm fetch-solc --help, which names a kind first, prints the fetch help', () => {
  const run = runHelp(join(ROOT, 'scripts', 'fetch-vendored.ts'), ['solc', '--help']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^usage: /);
  assert.equal(run.homeTouched, false);
});

test('kiss-sign card --help prints the help of both card commands', () => {
  const { stdout } = runHelp(join(ROOT, 'bin', 'kiss-sign'), ['card', '--help']);
  assert.match(stdout, /^usage: pnpm kiss-sign card new /m);
  assert.match(stdout, /^usage: pnpm kiss-sign card seal /m);
});

for (const script of SCRIPTS) {
  test(`scripts/${script}.ts --help prints its usage and exits 0 without a home, a key or the network`, () => {
    const before = tracked();
    const run = runHelp(join(ROOT, 'scripts', `${script}.ts`), ['--help']);
    assert.equal(run.stderr, '');
    assert.equal(run.status, 0);
    assert.match(run.stdout, /^usage: /);
    assert.equal(run.homeTouched, false);
    assert.equal(tracked(), before);
    assert.deepEqual(runHelp(join(ROOT, 'scripts', `${script}.ts`), ['-h']).stdout, run.stdout);
  });
}
