import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli/main.ts';
import { githubRepo, selfCheck } from '../src/verify/self-check.ts';

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

const selfCheckTrustingBareOrigin = (root: string) => selfCheck(root, (url) => url.endsWith('/origin.git'));

const problemsOf = (root: string) => {
  const result = selfCheckTrustingBareOrigin(root);
  return result.kind === 'clean' ? [] : result.problems;
};

test('a clone exactly at origin/main passes the self-check', () => {
  const { clone } = cloneOfOrigin();
  assert.deepEqual(selfCheckTrustingBareOrigin(clone), { kind: 'clean', commit: git(clone, 'rev-parse', 'HEAD').trim() });
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
  assert.equal(selfCheckTrustingBareOrigin(clone).kind, 'clean');
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

test('a change hidden by skip-worktree or assume-unchanged is still named', () => {
  const { clone } = cloneOfOrigin();
  git(clone, 'update-index', '--skip-worktree', 'src/cli/main.ts');
  git(clone, 'update-index', '--assume-unchanged', 'registry/contracts.json');
  write(clone, 'src/cli/main.ts', 'MATCH always\n');
  write(clone, 'registry/contracts.json', '{"evil":true}\n');
  assert.deepEqual(problemsOf(clone), ['hidden from git status: registry/contracts.json', 'hidden from git status: src/cli/main.ts']);
});

test('a git replace ref fails the self-check', () => {
  const { clone } = cloneOfOrigin();
  const blob = git(clone, 'rev-parse', 'HEAD:registry/contracts.json').trim();
  write(clone, '../evil.json', '{"evil":true}\n');
  const evil = git(clone, 'hash-object', '-w', '../evil.json').trim();
  git(clone, 'replace', blob, evil);
  assert.deepEqual(problemsOf(clone), [`git replace ref: ${blob}`]);
});

test('GIT_DIR and GIT_WORK_TREE in the environment cannot point the self-check at another clone', () => {
  const edited = cloneOfOrigin().clone;
  const clean = cloneOfOrigin().clone;
  write(edited, 'src/cli/main.ts', 'MATCH always\n');
  const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(clean, '.git');
  process.env.GIT_WORK_TREE = clean;
  try {
    assert.deepEqual(problemsOf(edited), ['changed: src/cli/main.ts']);
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
    if (saved.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.tree;
  }
});

test('a clone whose origin points to a fork is refused and the fork is never fetched', () => {
  const { clone } = cloneOfOrigin();
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/attacker/kiss-sign.git');
  assert.deepEqual(selfCheck(clone), {
    kind: 'differs',
    problems: ['origin is https://github.com/attacker/kiss-sign.git, not github.com/ipromise2324/kiss-sign'],
  });
});

test('a url.insteadOf rewrite that sends the official URL to a fork is refused', () => {
  const { clone } = cloneOfOrigin();
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/ipromise2324/kiss-sign.git');
  git(clone, 'config', 'url.https://github.com/attacker/.insteadOf', 'https://github.com/ipromise2324/');
  assert.deepEqual(selfCheck(clone), {
    kind: 'differs',
    problems: ['origin is https://github.com/attacker/kiss-sign.git, not github.com/ipromise2324/kiss-sign'],
  });
});

test('a second fetch URL on origin pointing elsewhere is refused', () => {
  const { clone } = cloneOfOrigin();
  git(clone, 'remote', 'set-url', 'origin', 'git@github.com:ipromise2324/kiss-sign.git');
  git(clone, 'remote', 'set-url', '--add', 'origin', 'git@github.com:attacker/kiss-sign.git');
  assert.deepEqual(selfCheck(clone), {
    kind: 'differs',
    problems: ['origin is git@github.com:attacker/kiss-sign.git, not github.com/ipromise2324/kiss-sign'],
  });
});

test('the official repository is recognised in its https and ssh forms, with or without .git', () => {
  for (const url of [
    'https://github.com/ipromise2324/kiss-sign',
    'https://github.com/ipromise2324/kiss-sign.git',
    'https://github.com/ipromise2324/kiss-sign/',
    'https://ipromise2324@github.com/ipromise2324/kiss-sign.git',
    'https://GitHub.com/IPromise2324/Kiss-Sign.git',
    'git@github.com:ipromise2324/kiss-sign.git',
    'git@github.com:ipromise2324/kiss-sign',
    'ssh://git@github.com/ipromise2324/kiss-sign.git',
    'ssh://git@github.com:22/ipromise2324/kiss-sign',
  ]) {
    assert.equal(githubRepo(url), 'github.com/ipromise2324/kiss-sign', url);
  }
  for (const url of [
    'https://github.com/attacker/kiss-sign.git',
    'https://github.com/ipromise2324/kiss-sign-fork.git',
    'https://github.com.evil.example/ipromise2324/kiss-sign.git',
    'https://github.com@evil.example/ipromise2324/kiss-sign.git',
    'http://github.com/ipromise2324/kiss-sign.git',
    'git://github.com/ipromise2324/kiss-sign.git',
    'file:///tmp/kiss-sign.git',
    '/tmp/origin.git',
  ]) {
    assert.notEqual(githubRepo(url), 'github.com/ipromise2324/kiss-sign', url);
  }
});
