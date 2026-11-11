import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export type SelfCheck = { readonly kind: 'clean'; readonly commit: string } | { readonly kind: 'differs'; readonly problems: readonly string[] };

export type OriginMain =
  | { readonly kind: 'fetched'; readonly commit: string }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'refused'; readonly problems: readonly string[] };

/**
 * `fetch` reads the system and global git config, since a private repository needs the signer's credential helper, and
 * the origin URL is read the same way so it names the URL that fetch uses. Every other call reads only the clone's own
 * config. No call takes a GIT_* variable from the caller, follows replace refs, runs a hook, or asks an fsmonitor.
 */
type ConfigScope = 'fetch' | 'clone-only';

const gitEnv = (config: ConfigScope, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
  ...(config === 'clone-only' ? { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } : {}),
  ...extra,
});

function gitRun(root: string, config: ConfigScope, args: readonly string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): Buffer {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', `--work-tree=${root}`, ...args], {
    cwd: root,
    env: gitEnv(config, options.env),
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
  });
}

const git = (root: string, ...args: string[]): string => gitRun(root, 'clone-only', args).toString('utf8');

declare const githubRepoBrand: unique symbol;
/** `github.com/<owner>/<repo>`, lowercased since GitHub ignores case there. */
export type GithubRepo = string & { readonly [githubRepoBrand]: true };

/** The repository a GitHub https or ssh URL names; otherwise undefined. */
export function githubRepo(url: string): GithubRepo | undefined {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return match === null ? undefined : (`github.com/${match[1]!.toLowerCase()}` as GithubRepo);
}

export type OriginRepo = { readonly kind: 'github'; readonly repo: GithubRepo } | { readonly kind: 'refused'; readonly problems: readonly string[] };

/** The one GitHub repository every URL of `origin` names, read as the fetch reads it. `init` records it as the repository to trust. */
export function originRepo(root: string): OriginRepo {
  const urls = originUrls(root);
  if (urls.length === 0) return { kind: 'refused', problems: ['there is no origin remote'] };
  const foreign = urls.filter((url) => githubRepo(url) === undefined);
  if (foreign.length > 0) return { kind: 'refused', problems: foreign.map((url) => `origin is ${url}, not a GitHub https or ssh URL`) };
  const repos = [...new Set(urls.map((url) => githubRepo(url)!))];
  if (repos.length > 1) return { kind: 'refused', problems: [`origin names more than one repository: ${repos.join(', ')}`] };
  return { kind: 'github', repo: repos[0]! };
}

/**
 * Requires every URL of `origin` to be `repo`, the repository the signer's config names, fetches its main into
 * origin/main, and requires every object of that commit to hash to its name, so a template or the registry read from it
 * is what origin serves. An origin elsewhere is never fetched.
 */
export function fetchOriginMain(root: string, repo: GithubRepo): OriginMain {
  const origins = originUrls(root);
  const problems = origins.length === 0 ? ['there is no origin remote'] : origins.filter((url) => githubRepo(url) !== repo).map((url) => `origin is ${url}, not ${repo}`);
  if (problems.length > 0) return { kind: 'refused', problems };
  try {
    // --refmap= ignores remote.origin.fetch, which could map another branch onto origin/main.
    gitRun(root, 'fetch', ['fetch', '--quiet', '--refmap=', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  } catch {
    return { kind: 'unreachable' };
  }
  const commit = localOriginMain(root);
  const corrupt = corruptObjects(root, commit);
  return corrupt.length === 0 ? { kind: 'fetched', commit } : { kind: 'refused', problems: corrupt.map((id) => `object ${id} does not hash to its name`) };
}

/**
 * Requires the checkout at `root` to be exactly origin/main, as `fetchOriginMain` fetched it: HEAD at that commit, every
 * file of it on disk with the same bytes and mode, and no other file that its .gitignore does not ignore. Files are
 * hashed from disk rather than asked of git status, whose answer the index, filters and stat settings can change.
 */
export function selfCheck(root: string, repo: GithubRepo): SelfCheck {
  const origin = fetchOriginMain(root, repo);
  if (origin.kind === 'refused') return { kind: 'differs', problems: origin.problems };
  if (origin.kind === 'unreachable') return { kind: 'differs', problems: [`could not fetch ${repo}`] };
  const { commit } = origin;
  const problems: string[] = [];
  const own = realpathSync(join(root, '.git'));
  const dirs = new Set(['--absolute-git-dir', '--git-common-dir'].map((flag) => realpathSync(resolve(root, git(root, 'rev-parse', flag).trim()))));
  for (const dir of dirs) if (dir !== own) problems.push(`the git directory is ${dir}, not ${own}; sign from a plain git clone`);
  const head = git(root, 'rev-parse', 'HEAD').trim();
  if (head !== commit) problems.push(`HEAD is ${head}, origin/main is ${commit}`);
  for (const path of changedFiles(root, commit)) problems.push(`changed: ${path}`);
  for (const path of untrackedFiles(root, commit)) problems.push(`untracked: ${path}`);
  for (const ref of git(root, 'replace', '-l').split('\n').filter(Boolean)) problems.push(`git replace ref: ${ref}`);
  return problems.length === 0 ? { kind: 'clean', commit } : { kind: 'differs', problems };
}

function originUrls(root: string): string[] {
  try {
    // get-url applies url.<base>.insteadOf, so it names the URL a fetch would really use.
    return gitRun(root, 'fetch', ['remote', 'get-url', '--all', 'origin']).toString('utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

type TreeEntry = { readonly mode: string; readonly type: string; readonly id: string; readonly path: string };

function treeEntries(root: string, commit: string): TreeEntry[] {
  return git(root, 'ls-tree', '-r', '-t', '-z', commit)
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, id] = line.slice(0, tab).split(' ') as [string, string, string];
      return { mode, type, id, path: line.slice(tab + 1) };
    });
}

const objectId = (type: string, content: Buffer): string => createHash('sha1').update(`${type} ${content.length}\0`).update(content).digest('hex');

/** The objects of `commit` (itself, its trees and blobs) whose content does not hash to their id; git does not check on read. */
function corruptObjects(root: string, commit: string): string[] {
  const tree = git(root, 'rev-parse', `${commit}^{tree}`).trim();
  const ids = [...new Set([commit, tree, ...treeEntries(root, commit).filter((entry) => entry.type !== 'commit').map((entry) => entry.id)])];
  const out = gitRun(root, 'clone-only', ['cat-file', '--batch'], { input: `${ids.join('\n')}\n` });
  const corrupt: string[] = [];
  let at = 0;
  for (const id of ids) {
    const end = out.indexOf(10, at);
    const [, type, size] = out.subarray(at, end).toString('utf8').split(' ');
    if (size === undefined) {
      corrupt.push(id);
      at = end + 1;
      continue;
    }
    const content = out.subarray(end + 1, end + 1 + Number(size));
    if (objectId(type!, content) !== id) corrupt.push(id);
    at = end + 1 + Number(size) + 1;
  }
  return corrupt;
}

/** Each file of `commit` whose bytes or mode on disk differ from the commit's, or that is missing. */
function changedFiles(root: string, commit: string): string[] {
  return treeEntries(root, commit)
    .filter((entry) => entry.type === 'blob' && !onDiskAs(join(root, entry.path), entry))
    .map((entry) => entry.path);
}

function onDiskAs(file: string, entry: TreeEntry): boolean {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return false;
  }
  if (entry.mode === '120000') return stat.isSymbolicLink() && objectId('blob', Buffer.from(readlinkSync(file))) === entry.id;
  const executable = (stat.mode & 0o111) !== 0;
  return stat.isFile() && executable === (entry.mode === '100755') && objectId('blob', readFileSync(file)) === entry.id;
}

/**
 * Files on disk that are not in `commit` and that the commit's root .gitignore does not ignore. It lists them against a
 * fresh index of the commit and only that .gitignore, so the clone's index, .git/info/exclude, core.excludesFile and an
 * untracked .gitignore cannot hide a file.
 */
function untrackedFiles(root: string, commit: string): string[] {
  const patterns = gitignoreAt(root, commit)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    // A directory pattern such as `node_modules/` would also exempt src/node_modules/, which Node resolves before the
    // root one, so directories are ignored only at the root.
    .map((line) => (line.endsWith('/') && !line.startsWith('/') ? `/${line}` : line));
  const scratch = mkdtempSync(join(tmpdir(), 'kiss-sign-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    gitRun(root, 'clone-only', ['read-tree', commit], { env });
    const args = ['ls-files', '-z', '--others', ...patterns.map((pattern) => `--exclude=${pattern}`)];
    return gitRun(root, 'clone-only', args, { env }).toString('utf8').split('\0').filter(Boolean);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function gitignoreAt(root: string, commit: string): string {
  try {
    return fileAt(root, commit, '.gitignore');
  } catch {
    return '';
  }
}

/** The commit origin/main names in this clone, without fetching. */
export function localOriginMain(root: string): string {
  return git(root, 'rev-parse', 'refs/remotes/origin/main').trim();
}

/** A file's text at `commit`, so a template or the registry counts only once it is merged. */
export function fileAt(root: string, commit: string, path: string): string {
  return git(root, 'show', `${commit}:${path}`);
}
