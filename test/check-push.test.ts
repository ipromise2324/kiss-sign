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
