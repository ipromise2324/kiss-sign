import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCanary } from '../src/canaries.ts';
import { CANARY_LIST, branchSplit, parseCanaryList } from '../src/verdict-core.ts';

const USAGE = 'usage: pnpm program-gate <branch>, run in a clone at origin/main, such as pnpm program-gate origin/my-branch';
const ref = process.argv[2];
if (ref === undefined || process.argv.length > 3 || ref.startsWith('-')) {
  console.error(USAGE);
  process.exit(2);
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
const say = (line: string) => console.log(line);
const listed = (paths: readonly string[]) => paths.map((path) => `  ${path}`);

function notEligible(reasons: readonly string[]): never {
  say(`NOT ELIGIBLE  the AI may not merge ${ref}:`);
  for (const reason of reasons) say(`  ${reason}`);
  process.exit(1);
}

/** Every tracked file of `rev` whose bytes on disk under `dir` differ from the commit, hashed from disk without git's stat cache or filters. */
function changedOnDisk(dir: string, rev: string): string[] {
  const tree = git(dir, 'ls-tree', '-r', '-z', rev)
    .split('\0')
    .filter((line) => line !== '')
    .flatMap((line) => {
      const [meta, path] = line.split('\t') as [string, string];
      const [, type, blob] = meta.split(' ');
      return type === 'blob' ? [{ path, blob: blob! }] : [];
    });
  const present = tree.filter(({ path }) => existsSync(join(dir, path)));
  const hashes = present.length === 0 ? [] : execFileSync('git', ['hash-object', '--no-filters', '--stdin-paths'], { cwd: dir, input: present.map(({ path }) => path).join('\n'), encoding: 'utf8' }).trim().split('\n');
  return [...tree.filter(({ path }) => !existsSync(join(dir, path))).map(({ path }) => path), ...present.filter(({ blob }, i) => hashes[i] !== blob).map(({ path }) => path)].sort();
}

const head = git(root, 'rev-parse', 'HEAD').trim();
const main = (() => {
  try {
    return git(root, 'rev-parse', 'origin/main').trim();
  } catch {
    return undefined;
  }
})();
if (main === undefined || head !== main || changedOnDisk(root, 'HEAD').length > 0) {
  notEligible([`run program-gate in a clone whose checkout is exactly origin/main, so the gate that judges ${ref} is main's and not the branch's own; fetch, check out main, and run it again`]);
}

const split = branchSplit(root, 'origin/main', ref);
if (split === undefined) notEligible([`git could not compare ${ref} with origin/main; fetch both and run this again`]);
const verdict = split.core.filter((path) => !split.gate.includes(path));
say(`program-gate: ${ref} (${git(root, 'rev-parse', '--short', ref).trim()}) against origin/main (${main.slice(0, 7)})`);
say(verdict.length === 0 ? 'verdict core changed: none' : `verdict core changed (${verdict.length}), which changes what verify checks for every signing:`);
for (const line of listed(verdict)) say(line);
say(split.other.length === 0 ? 'other program files changed: none' : `other program files changed (${split.other.length}):`);
for (const line of listed(split.other)) say(line);

const refusals = [
  ...(split.data.length > 0 ? [`it changes templates/ or registry/, which only the signer merges: ${split.data.join(', ')}`] : []),
  ...(split.gate.length > 0 ? [`it changes the program gate (${CANARY_LIST} and the code that enforces it), which only the signer merges: ${split.gate.join(', ')}`] : []),
];
if (refusals.length > 0) notEligible(refusals);

const canaries = parseCanaryList(readFileSync(join(root, CANARY_LIST), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'kiss-sign-program-gate-'));
const tree = join(work, 'tree');
git(root, 'worktree', 'add', '--quiet', '--detach', tree, ref);
process.on('exit', () => {
  try {
    git(root, 'worktree', 'remove', '--force', tree);
  } catch {}
  rmSync(work, { recursive: true, force: true });
});
for (const shared of ['node_modules', 'vendor']) if (existsSync(join(root, shared))) symlinkSync(join(root, shared), join(tree, shared));
if (existsSync(join(root, '.cache'))) cpSync(join(root, '.cache'), join(tree, '.cache'), { recursive: true });

function run(command: string, args: readonly string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: tree, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => void (output += chunk));
    child.stderr.on('data', (chunk) => void (output += chunk));
    child.on('error', fail);
    child.on('close', (code) => done({ code, output }));
  });
}

const tail = (output: string) => output.trimEnd().split('\n').slice(-30).map((line) => `    ${line}`);
const failures: string[] = [];

const fetched = await run(process.execPath, [join(tree, 'scripts', 'fetch-vendored.ts'), '--missing', 'solc', 'psl']);
if (fetched.code !== 0) {
  failures.push('fetching the pinned solc builds and Public Suffix List the tests need failed');
  for (const line of tail(fetched.output)) say(line);
}

const typecheck = await run(join(tree, 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', '.']);
say(`typecheck: ${typecheck.code === 0 ? 'pass' : 'FAIL'}`);
if (typecheck.code !== 0) {
  failures.push('typecheck failed');
  for (const line of tail(typecheck.output)) say(line);
}

const runs = await Promise.all(canaries.map((canary) => runCanary(tree, canary)));
for (const run of runs) {
  say(`canary ${run.canary.file}: ${run.ok ? 'pass' : 'FAIL'}, ${run.passed} passed, ${run.failed} failed`);
  say(`  guards: ${run.canary.guards}`);
  if (!run.ok) {
    failures.push(`canary ${run.canary.file} failed`);
    for (const line of tail(run.output)) say(line);
  }
  if (run.unlisted.length > 0) {
    failures.push(`canary ${run.canary.file} read paths ${CANARY_LIST} does not name`);
    for (const line of listed(run.unlisted)) say(line);
  }
}

const testFiles = (dir: string): string[] =>
  readdirSync(join(tree, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith('.test.ts') && path !== 'test/canaries.test.ts' ? [path] : [];
  });
const tests = await run(process.execPath, ['--test', '--test-reporter=tap', ...testFiles('test')]);
const count = (label: string) => Number(new RegExp(`^# ${label} (\\d+)$`, 'm').exec(tests.output)?.[1] ?? 0);
const testsPass = tests.code === 0 && count('fail') === 0 && count('pass') > 0;
say(`tests: ${testsPass ? 'pass' : 'FAIL'}, ${count('pass')} passed, ${count('fail')} failed, the canaries apart`);
if (!testsPass) {
  failures.push('the test suite failed');
  for (const line of tail(tests.output.split('\n').filter((line) => /^\s*not ok /.test(line)).join('\n') || tests.output)) say(line);
}

const touched = [...changedOnDisk(root, 'HEAD').map((path) => `main's checkout: ${path}`), ...changedOnDisk(tree, ref).map((path) => `${ref}: ${path}`)];
if (touched.length > 0) {
  failures.push(`the run changed tracked files, so its results cannot be trusted: ${touched.join(', ')}`);
}

if (failures.length > 0) notEligible(failures);
say(`ELIGIBLE  ${ref} changes no template, registry entry or gate file, and typecheck, every canary (${runs.length}) and the test suite pass. The AI may merge it with a merge commit once a fresh reviewer finds no security regression.`);
