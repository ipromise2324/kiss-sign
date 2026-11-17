import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = join(import.meta.dirname, '..', 'scripts', 'check-push.ts');
const safe = '0x1111111111111111111111111111111111111111';
const keyValue = 'planted-secret-value-123';

function setup(): { repo: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'check-push-'));
  const home = join(root, 'home');
  const state = join(home, '.kiss-sign');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'config.json'), JSON.stringify({ safe }));
  writeFileSync(join(state, '.env'), `PLANTED_API_KEY=${keyValue}\n`);
  writeFileSync(join(state, 'push-deny'), 'forbidden-word\n');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  commit(repo, 'README.md', 'hello\n');
  return { repo, home };
}

function git(repo: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
  assert.equal(result.status, 0, result.stderr.toString());
}

function commit(repo: string, file: string, content: string, message = 'change'): void {
  writeFileSync(join(repo, file), content);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', message);
}

function check(repo: string, home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KISS_SIGN_HOME;
  return spawnSync(process.execPath, [script, 'HEAD~1..HEAD'], { cwd: repo, env, encoding: 'utf8' });
}

test('a clean commit passes', () => {
  const { repo, home } = setup();
  commit(repo, 'a.txt', 'nothing here\n');
  const result = check(repo, home);
  assert.equal(result.status, 0, result.stderr);
});

test('the configured Safe address in any letter case is refused', () => {
  const { repo, home } = setup();
  commit(repo, 'a.txt', `owner ${safe.toUpperCase().replace('0X', '0x')}\n`);
  const result = check(repo, home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the configured Safe address/);
});

test('an API key value is refused without printing the key', () => {
  const { repo, home } = setup();
  commit(repo, 'a.txt', `key ${keyValue}\n`);
  const result = check(repo, home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PLANTED_API_KEY/);
  assert.ok(!result.stderr.includes(keyValue));
});

test('a GitHub token from the key file is refused without printing it', () => {
  const { repo, home } = setup();
  const token = 'github_pat_planted0value0for0the0push0check';
  writeFileSync(join(home, '.kiss-sign', '.env'), `GITHUB_TOKEN=${token}\n`);
  commit(repo, 'a.txt', `token ${token}\n`);
  const result = check(repo, home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GITHUB_TOKEN/);
  assert.ok(!result.stderr.includes(token));
});

test('a push-deny word in the commit message is refused', () => {
  const { repo, home } = setup();
  commit(repo, 'a.txt', 'fine\n', 'mention Forbidden-Word here');
  const result = check(repo, home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forbidden-word/);
});

function splitRepo(): { repo: string; home: string } {
  const { repo, home } = setup();
  mkdirSync(join(repo, 'bin'));
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'templates', 'x', 'op'), { recursive: true });
  writeFileSync(join(repo, 'bin', 'kiss-sign'), "import '../src/check.ts';\n");
  writeFileSync(join(repo, 'src', 'check.ts'), "import type { T } from './types.ts';\nexport const ok = 1;\n");
  writeFileSync(join(repo, 'src', 'types.ts'), 'export type T = 1;\n');
  writeFileSync(join(repo, 'src', 'research.ts'), 'export const r = 1;\n');
  writeFileSync(join(repo, 'templates', 'x', 'op', 'report.generated.md'), 'first\n');
  writeFileSync(join(repo, 'templates', 'x', 'op', 'report.generated.en.html'), '<p>first</p>\n');
  commit(repo, 'templates/x/op/template.json', '{}\n');
  git(repo, 'branch', '-M', 'main');
  git(repo, 'checkout', '-q', '-b', 'pr');
  return { repo, home };
}

function checkBranch(repo: string, home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KISS_SIGN_HOME;
  return spawnSync(process.execPath, [script, 'main..HEAD'], { cwd: repo, env, encoding: 'utf8' });
}

test('a branch that changes the verdict core and a template together is refused, naming both', () => {
  const { repo, home } = splitRepo();
  writeFileSync(join(repo, 'src', 'check.ts'), 'export const ok = 2;\n');
  commit(repo, 'templates/x/op/template.json', '{"a":1}\n');
  const result = checkBranch(repo, home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HEAD changes the verdict core and templates\/ or registry\/ together/);
  assert.match(result.stderr, /verdict core:\n {2}src\/check\.ts\ntemplates\/ and registry\/:\n {2}templates\/x\/op\/template\.json/);
});

test('research code or a type-only import beside a template passes, also when main changed the core after the branch left it', () => {
  const { repo, home } = splitRepo();
  writeFileSync(join(repo, 'src', 'research.ts'), 'export const r = 2;\n');
  writeFileSync(join(repo, 'src', 'types.ts'), 'export type T = 2;\n');
  commit(repo, 'templates/x/op/template.json', '{"a":1}\n');
  git(repo, 'checkout', '-q', 'main');
  commit(repo, 'src/check.ts', 'export const ok = 3;\n');
  git(repo, 'checkout', '-q', 'pr');
  assert.equal(checkBranch(repo, home).status, 0);
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'merge', '-q', '--no-edit', 'main');
  assert.equal(checkBranch(repo, home).status, 0);
});

test('a verdict core change may render the existing generated reports again', () => {
  const { repo, home } = splitRepo();
  writeFileSync(join(repo, 'src', 'check.ts'), 'export const ok = 2;\n');
  writeFileSync(join(repo, 'templates', 'x', 'op', 'report.generated.md'), 'again\n');
  commit(repo, 'templates/x/op/report.generated.en.html', '<p>again</p>\n');
  assert.equal(checkBranch(repo, home).status, 0);
});

test('a core change that adds a vault report beside it is refused, since that report lets verify accept the vault', () => {
  const { repo, home } = splitRepo();
  writeFileSync(join(repo, 'src', 'check.ts'), 'export const ok = 2;\n');
  mkdirSync(join(repo, 'templates', 'x', 'op', 'vaults', 'v'), { recursive: true });
  commit(repo, 'templates/x/op/vaults/v/report.generated.md', 'new\n');
  const result = checkBranch(repo, home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /templates\/x\/op\/vaults\/v\/report\.generated\.md/);
});

test('the hook refuses a push it cannot compare with origin/main', () => {
  const { repo, home } = splitRepo();
  commit(repo, 'templates/x/op/template.json', '{"a":1}\n');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KISS_SIGN_HOME;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(process.execPath, [script], { cwd: repo, env, encoding: 'utf8', input: `refs/heads/pr ${head} refs/heads/pr ${'0'.repeat(40)}\n` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git could not compare refs\/heads\/pr with origin\/main/);
});
