import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli/main.ts';
import { selfCheck } from '../src/verify/self-check.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function write(root: string, path: string, text = 'x\n'): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A bare origin and a clone of it whose main is pushed, as kiss-sign's own clone would be. */
function cloneOfOrigin(): { origin: string; clone: string } {
  const base = mkdtempSync(join(tmpdir(), 'kiss-sign-self-check-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  const clone = join(base, 'clone');
  git(base, 'clone', '--quiet', origin, clone);
  write(clone, '.gitignore', 'node_modules/\nvendor/\n.worktrees/\n');
  write(clone, 'src/cli/main.ts');
  write(clone, 'templates/morpho/vault-deposit/template.json', '{}\n');
  write(clone, 'registry/contracts.json', '{}\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '--quiet', '-m', 'first');
  git(clone, 'push', '--quiet', 'origin', 'main');
  return { origin, clone };
}

const problemsOf = (root: string) => {
  const result = selfCheck(root);
  return result.kind === 'clean' ? [] : result.problems;
};

test('a clone exactly at origin/main passes the self-check', () => {
  const { clone } = cloneOfOrigin();
  assert.deepEqual(selfCheck(clone), { kind: 'clean', commit: git(clone, 'rev-parse', 'HEAD').trim() });
});

test('a changed tracked file and an extra template are named', () => {
  const { clone } = cloneOfOrigin();
  write(clone, 'src/cli/main.ts', 'changed\n');
  write(clone, 'templates/evil/op/template.json', '{}\n');
  assert.deepEqual(problemsOf(clone), ['changed: src/cli/main.ts', 'untracked: templates/evil/op/template.json']);
});

test('an extra untracked file in the registry or the settings is named', () => {
  const { clone } = cloneOfOrigin();
  write(clone, 'registry/extra.json');
  write(clone, '.claude/settings.json');
  assert.deepEqual([...problemsOf(clone)].sort(), ['untracked: .claude/settings.json', 'untracked: registry/extra.json']);
});

test('ignored paths such as vendor, node_modules and .worktrees do not count', () => {
  const { clone } = cloneOfOrigin();
  write(clone, 'vendor/solc/soljson.js');
  write(clone, 'node_modules/x/index.js');
  write(clone, '.worktrees/pr/file.ts');
  assert.equal(selfCheck(clone).kind, 'clean');
});

test('a local commit not on origin/main fails the self-check', () => {
  const { clone } = cloneOfOrigin();
  write(clone, 'src/cli/main.ts', 'committed locally\n');
  git(clone, 'commit', '--quiet', '-am', 'local');
  assert.match(problemsOf(clone).join('\n'), /^HEAD is [0-9a-f]{40}, origin\/main is [0-9a-f]{40}$/);
});

test('a newer origin/main is fetched, so a clone left behind fails the self-check', () => {
  const { origin, clone } = cloneOfOrigin();
  const other = join(dirname(clone), 'other');
  git(dirname(clone), 'clone', '--quiet', origin, other);
  write(other, 'templates/morpho/vault-deposit/template.json', '{"changed":true}\n');
  git(other, 'commit', '--quiet', '-am', 'merged elsewhere');
  git(other, 'push', '--quiet', 'origin', 'main');
  assert.match(problemsOf(clone).join('\n'), /^HEAD is /);
});

test('verify stops on a changed checkout, names the file, and verifies nothing', async () => {
  const { clone } = cloneOfOrigin();
  write(clone, 'templates/morpho/vault-deposit/template.json', '{"edited":true}\n');
  const home = mkdtempSync(join(tmpdir(), 'kiss-sign-home-'));
  let stdout = '';
  let stderr = '';
  const code = await main(['verify', '--card', `0x${'00'.repeat(32)}`, '--tx', 'tx.json'], {
    env: { KISS_SIGN_HOME: home },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    readSecret: undefined,
    confirm: undefined,
    repoRoot: clone,
    transport: async () => assert.fail('a failed self-check reads no chain'),
    fetchJson: async () => assert.fail('a failed self-check fetches nothing'),
  });
  assert.equal(code, 1);
  assert.match(stderr, /not exactly origin\/main, so nothing was verified/);
  assert.match(stderr, /changed: templates\/morpho\/vault-deposit\/template\.json/);
  assert.equal(stdout, '');
  assert.equal(existsSync(join(home, 'verdicts')), false);
});
