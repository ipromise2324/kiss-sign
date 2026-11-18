import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const SEALED_OFF = pathToFileURL(join(import.meta.dirname, 'sealed-off.ts')).href;

const SIGNING = [[], ['init'], ['key'], ['key', 'add'], ['key', 'list'], ['key', 'remove'], ['book'], ['book', 'add'], ['book', 'list'], ['template', 'approve'], ['card'], ['card', 'new'], ['card', 'seal'], ['verify'], ['replay']];
const SCRIPTS = [
  'attacks', 'check-sources', 'erc7730', 'fetch-vendored', 'history', 'instance-evidence', 'past-txs', 'perturb', 'pin-code', 'pin-packages',
  'pin-solc', 'prove-abi', 'prove-instance', 'record-abi-case', 'record-safe-proxy', 'record-safe-tx', 'simulate', 'verdict-core',
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

test('kiss-sign verify -h prints the same help as --help, after an option value too', () => {
  const help = runHelp(join(ROOT, 'bin', 'kiss-sign'), ['verify', '--help']).stdout;
  assert.equal(runHelp(join(ROOT, 'bin', 'kiss-sign'), ['verify', '-h']).stdout, help);
  assert.equal(runHelp(join(ROOT, 'bin', 'kiss-sign'), ['verify', '--card', '0x00', '--help']).stdout, help);
});

test('kiss-sign --language zh-TW --help prints every command, in English', () => {
  const run = runHelp(join(ROOT, 'bin', 'kiss-sign'), ['--language', 'zh-TW', '--help']);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, runHelp(join(ROOT, 'bin', 'kiss-sign'), ['--help']).stdout);
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
