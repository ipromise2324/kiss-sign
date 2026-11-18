import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const script = join(ROOT, 'scripts', 'program-gate.ts');
const GUARDS = 'guards the check still answers 1';

function git(repo: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
  assert.equal(result.status, 0, result.stderr.toString());
}

function write(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

/** A small repository at its origin/main with a verdict core, one canary that requires `ok` to be 1, and one other test, beside this repository's node_modules. */
function gateRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'program-gate-'));
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, '.gitignore', 'node_modules\n');
  write(repo, 'tsconfig.json', JSON.stringify({ compilerOptions: { module: 'nodenext', strict: true, noEmit: true, allowImportingTsExtensions: true, types: ['node'] }, include: ['src', 'test'] }));
  write(repo, 'bin/kiss-sign', "import '../src/check.ts';\n");
  write(repo, 'src/check.ts', 'export const ok: number = 1;\n');
  write(repo, 'scripts/fetch-vendored.ts', '');
  write(repo, 'docs/canaries.txt', `canary test/canaries/x.canary.ts\n${GUARDS}\nreads testdata/x.json\n`);
  write(repo, 'test/canaries/x.canary.ts', "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { test } from 'node:test';\nimport { ok } from '../../src/check.ts';\n\ntest('x', () => {\n  assert.equal(ok, 1);\n  assert.equal(readFileSync('testdata/x.json', 'utf8'), '1\\n');\n});\n");
  write(repo, 'testdata/x.json', '1\n');
  write(repo, 'test/a.test.ts', "import { test } from 'node:test';\n\ntest('a', () => {});\n");
  write(repo, 'templates/x/op/template.json', '{}\n');
  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'main');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

function branch(repo: string, name: string, files: Record<string, string>): void {
  git(repo, 'checkout', '-q', '-b', name);
  for (const [path, text] of Object.entries(files)) write(repo, path, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', name);
  git(repo, 'checkout', '-q', 'main');
}

const gate = (repo: string, ref: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [script, ref], { cwd: repo, env, encoding: 'utf8' });
};

test('a core change that keeps every canary and test passing is ELIGIBLE, with each canary named beside what it guards', () => {
  const repo = gateRepo();
  branch(repo, 'core', { 'src/check.ts': 'export const ok: number = 2 - 1;\n', 'docs/notes.md': 'why\n' });
  const result = gate(repo, 'core');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^program-gate: core at [0-9a-f]{40} against origin\/main \([0-9a-f]{7}\)\nverdict core changed \(1\), which changes what verify checks for every signing:\n {2}src\/check\.ts\nother program files changed \(1\):\n {2}docs\/notes\.md\n/);
  assert.match(result.stdout, /\ntypecheck: pass\ncanary test\/canaries\/x\.canary\.ts: pass, 1 passed, 0 failed\n {2}guards: the check still answers 1\ntests: pass, 1 passed, 0 failed, the canaries apart\n/);
  assert.match(result.stdout, /\nELIGIBLE {2}core at ([0-9a-f]{40}) changes no template, registry entry or gate file, and typecheck, every canary \(1\) and the test suite pass\. The AI may merge exactly this commit with a merge commit once a fresh reviewer finds no security regression: gh pr merge <number> --merge --match-head-commit \1\n$/);
});

test('a core change a canary catches is NOT ELIGIBLE, naming the canary', () => {
  const repo = gateRepo();
  branch(repo, 'weak', { 'src/check.ts': 'export const ok: number = 2;\n' });
  const result = gate(repo, 'weak');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\ncanary test\/canaries\/x\.canary\.ts: FAIL, 0 passed, 1 failed\n/);
  assert.match(result.stdout, /\nNOT ELIGIBLE {2}the AI may not merge weak:\n {2}canary test\/canaries\/x\.canary\.ts failed\n$/);
});

test('a branch that changes the gate or a template is NOT ELIGIBLE, exit 3 for the signer to merge, before any of its code runs', () => {
  const repo = gateRepo();
  branch(repo, 'gate', { 'testdata/x.json': '2\n', 'test/canaries/x.canary.ts': "import { test } from 'node:test';\n\ntest('x', () => {});\n" });
  branch(repo, 'template', { 'templates/x/op/template.json': '{"a":1}\n' });
  const gated = gate(repo, 'gate');
  assert.equal(gated.status, 3);
  assert.match(gated.stdout, /\nNOT ELIGIBLE {2}the AI may not merge gate:\n {2}it changes the program gate \(docs\/canaries\.txt and the code that enforces it\), which only the signer merges: test\/canaries\/x\.canary\.ts, testdata\/x\.json\n$/);
  assert.doesNotMatch(gated.stdout, /typecheck|canary test/);
  const template = gate(repo, 'template');
  assert.equal(template.status, 3);
  assert.match(template.stdout, /\n {2}it changes templates\/ or registry\/, which only the signer merges: templates\/x\/op\/template\.json\n$/);
});

test('program-gate refuses to judge a branch from a checkout that is not origin/main', () => {
  const repo = gateRepo();
  branch(repo, 'core', { 'src/check.ts': 'export const ok: number = 1;\n// changed\n' });
  git(repo, 'checkout', '-q', 'core');
  const onBranch = gate(repo, 'core');
  assert.equal(onBranch.status, 1);
  assert.match(onBranch.stdout, /^NOT ELIGIBLE {2}the AI may not merge core:\n {2}run program-gate in a clone whose checkout is exactly origin\/main, so the gate that judges core is main's and not the branch's own/);
  git(repo, 'checkout', '-q', 'main');
  write(repo, 'docs/canaries.txt', 'canary test/canaries/x.canary.ts\nguards nothing\n');
  assert.equal(gate(repo, 'core').status, 1);
});

test('a run that changes a tracked file is NOT ELIGIBLE, naming the file', () => {
  const repo = gateRepo();
  branch(repo, 'tamper', {
    'src/check.ts': 'export const ok: number = 1;\n// changed\n',
    'test/a.test.ts': "import { appendFileSync } from 'node:fs';\nimport { test } from 'node:test';\n\ntest('a', () => appendFileSync('docs/canaries.txt', '\\n'));\n",
  });
  const result = gate(repo, 'tamper');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\n {2}the run changed tracked files, so its results cannot be trusted: tamper: docs\/canaries\.txt\n$/);
});

test('a branch that does not hold origin/main is NOT ELIGIBLE, since main may have changed its canaries since', () => {
  const repo = gateRepo();
  branch(repo, 'behind', { 'src/check.ts': 'export const ok: number = 1;\n// changed\n' });
  write(repo, 'test/a.test.ts', "import { test } from 'node:test';\n\ntest('a', () => {});\ntest('b', () => {});\n");
  git(repo, 'commit', '-q', '-am', 'main moves on');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const result = gate(repo, 'behind');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^NOT ELIGIBLE {2}the AI may not merge behind:\n {2}behind does not hold origin\/main \([0-9a-f]{7}\), so it would be judged by canaries and tests main has since changed; merge origin\/main into it and run this again\n$/);
});

test('a core change that drops a test main runs is NOT ELIGIBLE, exit 1, naming each test, before any of its code runs', () => {
  const repo = gateRepo();
  const core = { 'src/check.ts': 'export const ok: number = 1;\n// changed\n' };
  const withA = (body: string) => ({ ...core, 'test/a.test.ts': `import { test } from 'node:test';\n\n${body}\n` });
  const dropped = {
    deleted: withA("test('b', () => {});"),
    renamed: withA("test('a, renamed', () => {});"),
    commented: withA("/* test('a', () => {}); */\ntest(`b ${'/'}`, () => {});"),
    'test-skip': withA("test.skip('a', () => {});"),
    'skip-option': withA("test('a', { skip: true }, () => {});"),
    'todo-option': withA("test('a', { todo: 'later' }, () => {});"),
    'skip-inside': withA("test('a', (t) => { t.skip(); });"),
  };
  for (const [name, files] of Object.entries(dropped)) branch(repo, name, files);
  for (const [name, how] of [['deleted', 'removed'], ['renamed', 'removed'], ['commented', 'removed'], ['test-skip', 'skipped'], ['skip-option', 'skipped'], ['todo-option', 'skipped'], ['skip-inside', 'skipped']] as const) {
    const result = gate(repo, name);
    assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, new RegExp(`\\nNOT ELIGIBLE {2}the AI may not merge ${name}:\\n {2}it changes the verdict core and drops tests origin/main runs; rename, move or remove a test in a pull request that leaves the core alone:\\n {4}test/a\\.test\\.ts: ${how}: a\\n$`));
    assert.doesNotMatch(result.stdout, /typecheck|canary test/, name);
  }
});

test('a core change that keeps every test of main, its quotes changed and tests added, is judged on its run, and a branch that leaves the core alone may drop a test', () => {
  const repo = gateRepo();
  branch(repo, 'kept', { 'src/check.ts': 'export const ok: number = 1;\n// changed\n', 'test/a.test.ts': "import { test } from 'node:test';\n\n// test('gone', () => {});\ntest(\"a\", () => {});\ntest('b', () => {});\n" });
  branch(repo, 'tests-only', { 'test/a.test.ts': "import { test } from 'node:test';\n\ntest('b', () => {});\n" });
  const kept = gate(repo, 'kept');
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.match(kept.stdout, /\ntests: pass, 2 passed, 0 failed, the canaries apart\n/);
  const testsOnly = gate(repo, 'tests-only');
  assert.equal(testsOnly.status, 0, testsOnly.stdout + testsOnly.stderr);
});
