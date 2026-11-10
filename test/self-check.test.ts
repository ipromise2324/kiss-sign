import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { main } from '../src/cli/main.ts';
import { fileAt, githubRepo, selfCheck } from '../src/verify/self-check.ts';

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

/** Points origin at the official URL and serves it offline from the local bare origin through core.sshCommand. */
function serveAsOfficial(origin: string, clone: string): void {
  const ssh = join(dirname(clone), 'ssh');
  write(dirname(ssh), 'ssh', `#!/bin/sh\nexec git-upload-pack '${origin}'\n`);
  chmodSync(ssh, 0o755);
  git(clone, 'remote', 'set-url', 'origin', 'git@github.com:ipromise2324/kiss-sign.git');
  git(clone, 'config', 'core.sshCommand', ssh);
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

test('a fetch refspec that maps an unmerged branch onto origin/main is ignored', () => {
  const { origin, clone } = cloneOfOrigin();
  const other = join(dirname(clone), 'other');
  git(dirname(clone), 'clone', '--quiet', origin, other);
  write(other, 'src/cli/main.ts', 'unmerged\n');
  git(other, 'commit', '--quiet', '-am', 'unmerged');
  git(other, 'push', '--quiet', 'origin', 'HEAD:refs/heads/evil');
  git(clone, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/evil:refs/remotes/origin/main');
  git(clone, 'fetch', '--quiet', 'origin');
  git(clone, 'reset', '--quiet', '--hard', 'origin/main');
  assert.match(problemsOf(clone).join('\n'), /^HEAD is /);
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
  const [head, ...rest] = problemsOf(clone);
  assert.match(head!, /^HEAD is [0-9a-f]{40}, origin\/main is [0-9a-f]{40}$/);
  assert.deepEqual(rest, ['changed: src/cli/main.ts']);
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
  const { origin, clone } = cloneOfOrigin();
  serveAsOfficial(origin, clone);
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
  assert.deepEqual(problemsOf(clone), ['changed: registry/contracts.json', 'changed: src/cli/main.ts']);
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

/** Writes a shell script and makes it executable. */
function script(path: string, body: string): string {
  write(dirname(path), basename(path), `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test('a loose object rewritten with other content under its name is refused', () => {
  const { clone } = cloneOfOrigin();
  const blob = git(clone, 'rev-parse', 'HEAD:registry/contracts.json').trim();
  const evil = Buffer.from('{"evil":true}\n');
  const file = join(clone, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  chmodSync(file, 0o644);
  writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`blob ${evil.length}\0`), evil])));
  assert.equal(fileAt(clone, 'HEAD', 'registry/contracts.json'), '{"evil":true}\n');
  assert.deepEqual(problemsOf(clone), [`object ${blob} does not hash to its name`]);
});

test('a clean filter in .git/info/attributes cannot hide a changed file', () => {
  const { clone } = cloneOfOrigin();
  write(clone, '.git/info/attributes', 'src/** filter=x\n');
  git(clone, 'config', 'filter.x.clean', 'git show HEAD:%f');
  write(clone, 'src/cli/main.ts', 'MATCH always\n');
  git(clone, 'add', 'src/cli/main.ts');
  assert.equal(git(clone, 'status', '--porcelain'), '');
  assert.deepEqual(problemsOf(clone), ['changed: src/cli/main.ts']);
});

test('core.worktree pointing at a pristine checkout cannot hide a changed file', () => {
  const { clone } = cloneOfOrigin();
  const pristine = join(dirname(clone), 'pristine');
  cpSync(clone, pristine, { recursive: true, filter: (path) => !path.includes('/.git') });
  git(clone, 'config', 'core.worktree', pristine);
  write(clone, 'src/cli/main.ts', 'MATCH always\n');
  assert.deepEqual(problemsOf(clone), ['changed: src/cli/main.ts']);
});

test('.git/info/exclude cannot hide an extra file', () => {
  const { clone } = cloneOfOrigin();
  write(clone, '.git/info/exclude', 'src/evil.ts\n.claude/\n');
  write(clone, 'src/evil.ts');
  write(clone, '.claude/settings.json');
  assert.deepEqual([...problemsOf(clone)].sort(), ['untracked: .claude/settings.json', 'untracked: src/evil.ts']);
});

test('a same-size edit with its mtime restored is named even when git trusts only mtime and size', () => {
  const { clone } = cloneOfOrigin();
  const file = join(clone, 'src/cli/main.ts');
  const past = new Date('2020-01-01T00:00:00Z');
  utimesSync(file, past, past);
  git(clone, 'update-index', '--refresh');
  git(clone, 'config', 'core.checkStat', 'minimal');
  git(clone, 'config', 'core.trustctime', 'false');
  writeFileSync(file, 'y\n');
  utimesSync(file, past, past);
  assert.equal(statSync(file).size, 2);
  assert.deepEqual(problemsOf(clone), ['changed: src/cli/main.ts']);
});

test('the clone\'s hooks and fsmonitor do not run during the self-check', () => {
  const { clone } = cloneOfOrigin();
  const base = dirname(clone);
  const ran = join(base, 'ran');
  script(join(base, 'hooks', 'reference-transaction'), `echo hook >> '${ran}'`);
  git(clone, 'config', 'core.hooksPath', join(base, 'hooks'));
  git(clone, 'config', 'core.fsmonitor', script(join(base, 'fsmonitor'), `echo fsmonitor >> '${ran}'; exit 1`));
  assert.equal(selfCheckTrustingBareOrigin(clone).kind, 'clean');
  assert.equal(existsSync(ran), false, existsSync(ran) ? readFileSync(ran, 'utf8') : '');
});

test('the global git config cannot hide files or run a hook', () => {
  const { clone } = cloneOfOrigin();
  const home = mkdtempSync(join(tmpdir(), 'kiss-sign-home-'));
  const ran = join(home, 'ran');
  script(join(home, 'hooks', 'reference-transaction'), `echo hook >> '${ran}'`);
  write(home, 'ignore', 'src/evil.ts\n');
  write(home, 'attributes', 'src/** filter=x\n');
  write(home, '.gitconfig', [
    '[core]',
    `\texcludesFile = ${join(home, 'ignore')}`,
    `\tattributesFile = ${join(home, 'attributes')}`,
    `\thooksPath = ${join(home, 'hooks')}`,
    '[filter "x"]',
    '\tclean = git show HEAD:%f',
    '',
  ].join('\n'));
  write(clone, 'src/cli/main.ts', 'MATCH always\n');
  write(clone, 'src/evil.ts');
  const saved = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = home;
  try {
    assert.deepEqual(problemsOf(clone), ['changed: src/cli/main.ts', 'untracked: src/evil.ts']);
  } finally {
    process.env.HOME = saved.home;
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.xdg;
  }
  assert.equal(existsSync(ran), false);
});

test('template approve refuses a clone whose origin is not the official repository and fetches nothing', async () => {
  const { origin, clone } = cloneOfOrigin();
  const other = join(dirname(clone), 'other');
  git(dirname(clone), 'clone', '--quiet', origin, other);
  write(other, 'templates/morpho/vault-deposit/template.json', '{"fork":true}\n');
  git(other, 'commit', '--quiet', '-am', 'fork');
  git(other, 'push', '--quiet', 'origin', 'main');
  const before = git(clone, 'rev-parse', 'refs/remotes/origin/main').trim();
  const home = mkdtempSync(join(tmpdir(), 'kiss-sign-home-'));
  let stderr = '';
  const code = await main(['template', 'approve', 'morpho/vault-deposit'], {
    env: { KISS_SIGN_HOME: home },
    stdout: () => {},
    stderr: (text) => void (stderr += text),
    readSecret: undefined,
    confirm: async () => assert.fail('a refused origin asks nothing'),
    repoRoot: clone,
    transport: async () => assert.fail('approve reads no chain'),
    fetchJson: async () => assert.fail('approve fetches nothing'),
  });
  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`origin is ${origin}, not github\\.com/ipromise2324/kiss-sign`));
  assert.equal(git(clone, 'rev-parse', 'refs/remotes/origin/main').trim(), before);
  assert.equal(existsSync(join(home, 'approved-templates.json')), false);
});

test('a node_modules folder below the root is named, since Node would load it before the root one', () => {
  const { clone } = cloneOfOrigin();
  write(clone, 'src/cli/node_modules/@noble/hashes/index.js');
  assert.deepEqual(problemsOf(clone), ['untracked: src/cli/node_modules/@noble/hashes/index.js']);
});

test('a clone whose git directory lives elsewhere, as a linked worktree has, fails the self-check', () => {
  const { clone } = cloneOfOrigin();
  const linked = join(dirname(clone), 'linked');
  git(clone, 'worktree', 'add', '--quiet', '--detach', linked, 'origin/main');
  assert.match(problemsOf(linked).join('\n'), /the git directory is .*, not .*; sign from a plain git clone/);
});
