import { execFileSync } from 'node:child_process';

export type SelfCheck = { readonly kind: 'clean'; readonly commit: string } | { readonly kind: 'differs'; readonly problems: readonly string[] };

/** Git without any GIT_* variable from the caller, which could point it at another repository, and without replace refs. */
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_NO_REPLACE_OBJECTS: '1',
});

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: root, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });

export const OFFICIAL_REPO = 'github.com/ipromise2324/kiss-sign';

/** `github.com/<owner>/<repo>` for a GitHub https or ssh URL, lowercased since GitHub ignores case there; otherwise undefined. */
export function githubRepo(url: string): string | undefined {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return match === null ? undefined : `github.com/${match[1]!.toLowerCase()}`;
}

/**
 * Requires every URL of `origin` to be the official repository, then fetches it and requires the checkout at `root` to
 * be exactly origin/main: the same commit, no change to a tracked file, and no untracked file that git does not ignore.
 * An origin elsewhere is never fetched.
 */
export function selfCheck(root: string, isOfficial: (url: string) => boolean = (url) => githubRepo(url) === OFFICIAL_REPO): SelfCheck {
  const problems: string[] = [];
  // get-url applies url.<base>.insteadOf, so it names the URL a fetch would really use.
  const origins = originUrls(root);
  if (origins.length === 0) problems.push('there is no origin remote');
  for (const url of origins.filter((url) => !isOfficial(url))) problems.push(`origin is ${url}, not ${OFFICIAL_REPO}`);
  let main: string | undefined;
  if (problems.length === 0) {
    main = fetchOriginMain(root);
    if (main === undefined) return { kind: 'differs', problems: ['could not fetch origin'] };
    const head = git(root, 'rev-parse', 'HEAD').trim();
    if (head !== main) problems.push(`HEAD is ${head}, origin/main is ${main}`);
  }
  const status = git(root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=no').split('\n').filter(Boolean);
  for (const line of status) problems.push(`${line.startsWith('??') ? 'untracked' : 'changed'}: ${line.slice(3)}`);
  // A skip-worktree (S) or assume-unchanged (lowercase) flag hides a changed file from git status.
  const hidden = git(root, 'ls-files', '-v').split('\n').filter((line) => line !== '' && (line[0] === 'S' || line[0] !== line[0]!.toUpperCase()));
  for (const line of hidden) problems.push(`hidden from git status: ${line.slice(2)}`);
  for (const ref of git(root, 'replace', '-l').split('\n').filter(Boolean)) problems.push(`git replace ref: ${ref}`);
  return problems.length === 0 && main !== undefined ? { kind: 'clean', commit: main } : { kind: 'differs', problems };
}

function originUrls(root: string): string[] {
  try {
    return git(root, 'remote', 'get-url', '--all', 'origin').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Fetches origin and returns the commit origin/main names, or undefined when the fetch fails. */
export function fetchOriginMain(root: string): string | undefined {
  try {
    // --refmap= ignores remote.origin.fetch, which could map another branch onto origin/main.
    git(root, 'fetch', '--quiet', '--refmap=', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    return localOriginMain(root);
  } catch {
    return undefined;
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
