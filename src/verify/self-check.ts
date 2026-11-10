import { execFileSync } from 'node:child_process';

export type SelfCheck = { readonly kind: 'clean'; readonly commit: string } | { readonly kind: 'differs'; readonly problems: readonly string[] };

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });

/**
 * Fetches origin and requires the checkout at `root` to be exactly origin/main: the same commit, no change to a tracked
 * file, and no untracked file that git does not ignore.
 */
export function selfCheck(root: string): SelfCheck {
  const main = fetchOriginMain(root);
  if (main === undefined) return { kind: 'differs', problems: ['could not fetch origin'] };
  const head = git(root, 'rev-parse', 'HEAD').trim();
  const problems: string[] = [];
  if (head !== main) problems.push(`HEAD is ${head}, origin/main is ${main}`);
  const status = git(root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=no').split('\n').filter(Boolean);
  for (const line of status) problems.push(`${line.startsWith('??') ? 'untracked' : 'changed'}: ${line.slice(3)}`);
  return problems.length === 0 ? { kind: 'clean', commit: main } : { kind: 'differs', problems };
}

/** Fetches origin and returns the commit origin/main names, or undefined when the fetch fails. */
export function fetchOriginMain(root: string): string | undefined {
  try {
    git(root, 'fetch', '--quiet', 'origin');
    return git(root, 'rev-parse', 'refs/remotes/origin/main').trim();
  } catch {
    return undefined;
  }
}

/** A file's text at `commit`, so a template or the registry counts only once it is merged. */
export function fileAt(root: string, commit: string, path: string): string {
  return git(root, 'show', `${commit}:${path}`);
}
