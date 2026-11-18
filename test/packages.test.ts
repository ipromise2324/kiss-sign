import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packageProblems } from '../src/verify/packages.ts';

const ROOT = join(import.meta.dirname, '..');
const NOBLE = '@noble/hashes@2.4.0';

test('the packages this clone installed from pnpm-lock.yaml are the pinned ones', () => {
  assert.deepEqual(packageProblems(ROOT), []);
});

/** A copy of the program beside a copy of its installed packages, as a plain folder rather than pnpm's symlinks. */
function copyOfProgram(): { root: string; home: string; noble: string } {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-packages-'));
  for (const path of ['bin', 'src', 'package.json', 'pnpm-lock.yaml']) cpSync(join(ROOT, path), join(root, path), { recursive: true });
  const noble = join(root, 'node_modules', '@noble', 'hashes');
  cpSync(realpathSync(join(ROOT, 'node_modules', '@noble', 'hashes')), noble, { recursive: true });
  const home = join(root, 'home');
  mkdirSync(home);
  return { root, home, noble };
}

const run = (root: string, home: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(root, 'bin', 'kiss-sign'), ...args], { env: { ...process.env, KISS_SIGN_HOME: home }, encoding: 'utf8' });

test('bin/kiss-sign runs its command when every package holds its pinned files', () => {
  const { root, home } = copyOfProgram();
  const result = run(root, home);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /^Usage:/);
});

test('verify refuses a changed package file before it loads any package, and writes no verdict', () => {
  const { root, home, noble } = copyOfProgram();
  appendFileSync(join(noble, 'sha3.js'), '\nglobalThis.tampered = true;\n');
  const result = run(root, home, 'verify', '--card', 'x', '--tx', 'y.json');
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    `kiss-sign: the installed packages are not the ones pnpm-lock.yaml names, so nothing was run; remove node_modules, run pnpm install --frozen-lockfile, then run this again.\n  ${NOBLE}: changed: sha3.js\n`,
  );
  assert.ok(!existsSync(join(home, 'verdicts')));
});

test('a file added to or missing from a package is named, in the language of the config', () => {
  const { root, home, noble } = copyOfProgram();
  writeFileSync(join(noble, 'extra.js'), 'export {};\n');
  rmSync(join(noble, 'README.md'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ chainId: 1, language: 'zh-TW' }));
  const result = run(root, home, 'replay', 'v.json');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^kiss-sign: 安裝的套件和 pnpm-lock\.yaml 寫的不一樣/);
  assert.ok(result.stderr.endsWith(`  ${NOBLE}: added: extra.js\n  ${NOBLE}: missing: README.md\n`), result.stderr);
});

test('a package that is not installed, or whose tarball has no pin, is named', () => {
  const { root, noble } = copyOfProgram();
  const [unpinned, ...more] = packageProblems(root, {});
  assert.deepEqual(more, []);
  assert.match(unpinned!, new RegExp(`^${NOBLE}: no pin for its tarball sha512-\\S+; run node scripts/pin-packages.ts ${NOBLE}$`));
  rmSync(noble, { recursive: true });
  assert.deepEqual(packageProblems(root), [`${NOBLE}: not installed`]);
});

test('a lockfile the check cannot read is refused', () => {
  const { root } = copyOfProgram();
  const lines = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').split('\n').length;
  appendFileSync(join(root, 'pnpm-lock.yaml'), 'not a key\n');
  assert.deepEqual(packageProblems(root), [`pnpm-lock.yaml line ${lines} is not one this program reads`]);
  rmSync(join(root, 'pnpm-lock.yaml'));
  assert.deepEqual(packageProblems(root), ['there is no pnpm-lock.yaml']);
});

test('a node_modules folder under src, which Node would search before the root one, is refused before it loads', () => {
  const { root, home, noble } = copyOfProgram();
  cpSync(noble, join(root, 'src', 'safe', 'node_modules', '@noble', 'hashes'), { recursive: true });
  const result = run(root, home);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.endsWith('\n  a node_modules folder below the root: src/safe/node_modules\n'), result.stderr);
});

test('a symlink inside a package is named, and a list in the lockfile is read', () => {
  const { root, noble } = copyOfProgram();
  symlinkSync(join(noble, 'sha3.js'), join(noble, 'link.js'));
  const lock = join(root, 'pnpm-lock.yaml');
  writeFileSync(lock, readFileSync(lock, 'utf8').replace("  '@noble/hashes@2.4.0': {}\n", "  '@noble/hashes@2.4.0':\n    transitivePeerDependencies:\n      - left-pad\n"));
  assert.deepEqual(packageProblems(root), [`${NOBLE}: not a file: link.js`]);
});
