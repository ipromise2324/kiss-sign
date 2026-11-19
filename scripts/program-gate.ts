import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCanary, runProcess } from '../src/canaries.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { CANARY_LIST, branchSplit, parseCanaryList } from '../src/verdict-core.ts';

const USAGE = 'usage: pnpm program-gate <branch>, run in a clone at origin/main, such as pnpm program-gate origin/my-branch';
const HELP = `usage: pnpm program-gate <branch>

Says whether the AI may merge a program pull request. Run it in a clone whose checkout is exactly
origin/main, such as pnpm program-gate origin/my-branch; it refuses to run anywhere else. It judges
the one commit the branch names, which must hold origin/main, and prints the verdict core files and
the other program files the branch changes.
Without running the branch's code it stops at NOT ELIGIBLE, naming each file or test, when the
branch changes a hand-written file under templates/ or registry/, adds or deletes a generated report
there, changes a gate file, or drops a test origin/main runs (a literal test, it, describe or suite
title deleted, renamed, moved to another file, commented out, or skipped). Otherwise it checks the
branch out into a temporary worktree and runs the typecheck, each canary of main's docs/canaries.txt
with what it guards and its counts, and every other test, then requires every tracked file to be as
committed.
It prints ELIGIBLE, with the merge command for exactly that commit, and exits 0 only when all pass.
NOT ELIGIBLE exits 3 when the only reason is a template, registry or gate file, or a dropped test
with no verdict core change, the signer's to merge, and 1 otherwise. A wrong argument exits 2.
CI runs it as the program-gate job on pull_request_target, from main's workflow and code; the job
passes on exit 3 with the notice "The signer merges this pull request", so red means a check failed.

Writes: no tracked file; a temporary worktree it removes, and into vendor/ any pinned solc or Public
Suffix List the tests need.
Keys: none.
Rules: docs/design/program-ownership.md, "The program gate" and "The verdict core".`;

exitOnHelp(HELP);
const ref = process.argv[2];
if (ref === undefined || process.argv.length > 3 || ref.startsWith('-')) {
  console.error(USAGE);
  process.exit(2);
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
const say = (line: string) => console.log(line);
const listed = (paths: readonly string[]) => paths.map((path) => `  ${path}`);

/** Exit 3 when the branch is the signer's to merge, so CI can show it apart from a branch that failed; 1 for any other refusal. */
function notEligible(reasons: readonly string[], status: 1 | 3 = 1): never {
  say(`NOT ELIGIBLE  the AI may not merge ${ref}:`);
  for (const reason of reasons) say(`  ${reason}`);
  process.exit(status);
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

/** One call of `test`, `it`, `describe` or `suite` whose title is a literal, and whether it is skipped. */
type TestCall = { readonly title: string; readonly skipped: boolean };
type Token = { readonly kind: 'name' | 'string' | 'punct'; readonly text: string };

const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

/** The tokens of a TypeScript source that matter for finding test calls, with comments dropped and each string, template and regular expression one token. */
function tokens(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const quoted = (quote: string) => {
    const start = i++;
    while (i < source.length && source[i] !== quote && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
    i++;
    return source.slice(start, i);
  };
  const template = () => {
    const start = i++;
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') i += 2;
      else if (source.startsWith('${', i)) {
        i += 2;
        const before = out.length;
        for (let depth = 0; i < source.length && !(depth === 0 && source[i] === '}'); ) {
          const count = out.length;
          step();
          const text = out.length > count ? out.at(-1)!.text : '';
          depth += text === '{' ? 1 : text === '}' ? -1 : 0;
        }
        out.splice(before);
        i++;
      } else i++;
    }
    i++;
    return source.slice(start, i);
  };
  const regex = () => {
    let inClass = false;
    for (i++; i < source.length && (inClass || source[i] !== '/') && source[i] !== '\n'; i++) {
      if (source[i] === '\\') i++;
      else if (source[i] === '[') inClass = true;
      else if (source[i] === ']') inClass = false;
    }
    for (i++; /[a-z]/.test(source[i] ?? ''); ) i++;
  };
  function step(): void {
    const c = source[i]!;
    const last = out.at(-1);
    if (/\s/.test(c)) i++;
    else if (source.startsWith('//', i)) i = source.includes('\n', i) ? source.indexOf('\n', i) : source.length;
    else if (source.startsWith('/*', i)) i = source.includes('*/', i + 2) ? source.indexOf('*/', i + 2) + 2 : source.length;
    else if (c === "'" || c === '"') out.push({ kind: 'string', text: quoted(c) });
    else if (c === '`') out.push({ kind: 'string', text: template() });
    else if (c === '/' && (last === undefined || (last.kind === 'punct' && !')]}'.includes(last.text)) || (last.kind === 'name' && REGEX_AFTER.has(last.text)))) regex();
    else if (/[\w$]/.test(c)) {
      const start = i;
      while (/[\w$]/.test(source[i] ?? '')) i++;
      out.push({ kind: 'name', text: source.slice(start, i) });
    } else if (c === '!' && /[\w$)\]]/.test(source[i - 1] ?? '')) out.push({ kind: 'name', text: source[i++]! });
    else out.push({ kind: 'punct', text: source[i++]! });
  }
  while (i < source.length) step();
  return out;
}

const TEST_NAMES = ['test', 'it', 'describe', 'suite'];
const SKIPS = ['skip', 'todo'];

/**
 * Every test call in a source, read as text: nothing of the branch runs. A call is skipped when it is `.skip` or `.todo`, names `skip`
 * or `todo` as an option key, calls `t.skip()` or `t.todo()` in its own body, or sits inside a skipped call.
 */
function testCalls(source: string): TestCall[] {
  const all = tokens(source);
  const calls = all.flatMap((token, at) => {
    if (token.kind !== 'name' || !TEST_NAMES.includes(token.text) || all[at - 1]?.text === '.') return [];
    const member = all[at + 1]?.text === '.' && all[at + 2]?.kind === 'name' ? all[at + 2]!.text : undefined;
    const open = member === undefined ? at + 1 : at + 3;
    const title = all[open + 1];
    if (all[open]?.text !== '(' || title?.kind !== 'string') return [];
    let end = open;
    let own = SKIPS.includes(member ?? '');
    for (let parens = 0, braces = 0; end < all.length; end++) {
      const { kind, text } = all[end]!;
      parens += text === '(' ? 1 : text === ')' ? -1 : 0;
      braces += text === '{' ? 1 : text === '}' ? -1 : 0;
      if (parens === 0) break;
      const before = all[end - 1]?.text;
      const owner = all[end - 2];
      const option = (before === '{' || before === ',') && [':', ',', '}'].includes(all[end + 1]?.text ?? '');
      const selfCall = before === '.' && all[end + 1]?.text === '(' && owner?.kind === 'name' && !TEST_NAMES.includes(owner.text);
      if (kind === 'name' && SKIPS.includes(text) && parens === 1 && braces <= 1 && (option || selfCall)) own = true;
    }
    const literal = title.text.slice(1, -1);
    return [{ title: title.text[0] === '`' ? literal : literal.replace(/\\(['"])/g, '$1'), own, start: at, end }];
  });
  return calls.map(({ title, own, start, end }) => ({ title, skipped: own || calls.some((outer) => outer.own && outer.start < start && end <= outer.end) }));
}

/** The test files under test/ at a commit, each with its test calls, read from git's objects. */
function testsAt(rev: string): Map<string, TestCall[]> {
  const files = git(root, 'ls-tree', '-r', '-z', '--name-only', rev, '--', 'test/').split('\0').filter((path) => path.endsWith('.test.ts'));
  return new Map(files.map((path) => [path, testCalls(git(root, 'show', `${rev}:${path}`))]));
}

/** Each test origin/main runs that the branch no longer runs in the same file as often, as `file: removed|skipped: title`. */
function droppedTests(base: string, branch: string): string[] {
  const after = testsAt(branch);
  return [...testsAt(base)].flatMap(([path, calls]) => {
    const later = after.get(path) ?? [];
    const running = (list: readonly TestCall[], title: string) => list.filter((call) => call.title === title && !call.skipped).length;
    return [...new Set(calls.map(({ title }) => title))].flatMap((title) => {
      const missing = running(calls, title) - running(later, title);
      const how = later.some((call) => call.title === title && call.skipped) ? 'skipped' : 'removed';
      return Array.from({ length: Math.max(0, missing) }, () => `${path}: ${how}: ${title}`);
    });
  });
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

const sha = (() => {
  try {
    return git(root, 'rev-parse', '--verify', `${ref}^{commit}`).trim();
  } catch {
    return notEligible([`git has no commit ${ref}; fetch it and run this again`]);
  }
})();
const mergeBase = (() => {
  try {
    return git(root, 'merge-base', 'origin/main', sha).trim();
  } catch {
    return undefined;
  }
})();
if (mergeBase !== main) notEligible([`${ref} does not hold origin/main (${main.slice(0, 7)}), so it would be judged by canaries and tests main has since changed; merge origin/main into it and run this again`]);
const split = branchSplit(root, 'origin/main', sha);
if (split === undefined) notEligible([`git could not compare ${ref} with origin/main; fetch both and run this again`]);
const verdict = split.core.filter((path) => !split.gate.includes(path));
say(`program-gate: ${ref} at ${sha} against origin/main (${main.slice(0, 7)})`);
say(verdict.length === 0 ? 'verdict core changed: none' : `verdict core changed (${verdict.length}), which changes what verify checks for every signing:`);
for (const line of listed(verdict)) say(line);
say(split.other.length === 0 ? 'other program files changed: none' : `other program files changed (${split.other.length}):`);
for (const line of listed(split.other)) say(line);

const dropped = droppedTests(main, sha);
const refused = verdict.length > 0 && dropped.length > 0;
const refusals = [
  ...(split.data.length > 0 ? [`it changes templates/ or registry/, which only the signer merges: ${split.data.join(', ')}`] : []),
  ...(split.gate.length > 0 ? [`it changes the program gate (${CANARY_LIST} and the code that enforces it), which only the signer merges: ${split.gate.join(', ')}`] : []),
  ...(refused ? ['it changes the verdict core and drops tests origin/main runs; rename, move or remove a test in a pull request that leaves the core alone, which the signer merges:'] : []),
  ...(dropped.length > 0 && !refused ? ['it drops tests origin/main runs, which only the signer merges:'] : []),
  ...listed(dropped),
];
if (refusals.length > 0) notEligible(refusals, refused ? 1 : 3);

const canaries = parseCanaryList(readFileSync(join(root, CANARY_LIST), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'kiss-sign-program-gate-'));
const tree = join(work, 'tree');
git(root, 'worktree', 'add', '--quiet', '--detach', tree, sha);
process.on('exit', () => {
  try {
    git(root, 'worktree', 'remove', '--force', tree);
  } catch {}
  rmSync(work, { recursive: true, force: true });
});
for (const shared of ['node_modules', 'vendor']) if (existsSync(join(root, shared))) symlinkSync(join(root, shared), join(tree, shared));
if (existsSync(join(root, '.cache'))) cpSync(join(root, '.cache'), join(tree, '.cache'), { recursive: true });

const run = (command: string, args: readonly string[]) => runProcess(command, args, tree);

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

const touched = [...changedOnDisk(root, 'HEAD').map((path) => `main's checkout: ${path}`), ...changedOnDisk(tree, sha).map((path) => `${ref}: ${path}`)];
if (touched.length > 0) {
  failures.push(`the run changed tracked files, so its results cannot be trusted: ${touched.join(', ')}`);
}

if (failures.length > 0) notEligible(failures);
say(`ELIGIBLE  ${ref} at ${sha} changes no template, registry entry or gate file, and typecheck, every canary (${runs.length}) and the test suite pass. The AI may merge exactly this commit with a merge commit once a fresh reviewer finds no security regression: gh pr merge <number> --merge --match-head-commit ${sha}`);
