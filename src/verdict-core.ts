import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

export const CORE_ENTRY = 'bin/kiss-sign';
export const CORE_LIST = 'docs/verdict-core.txt';
export const SPLIT_GUARDS = ['src/verdict-core.ts', 'scripts/check-push.ts', '.githooks/', '.github/workflows/'];

export const PACKAGE_FILES = ['package.json', 'pnpm-lock.yaml'];
const TYPE_ONLY = /^\s*(?:import|export)\s+type\s[^;]*?from\s*'[^']*'\s*;?/gm;
const QUOTED = /'([^'\n]+)'/g;
const BARE_IMPORT = /\bfrom\s*'(?!node:|\.)[^']+'/;
const GENERATED = /\.generated(\.[A-Za-z-]+)?\.(md|html)$/;

/** Every repository path whose code the signing commands can run, walked from `bin/kiss-sign` through every import that is not type-only and every `.ts` file a core file names, such as the solc runner it spawns. */
export function verdictCore(read: (path: string) => string | undefined): string[] {
  const found = new Set<string>();
  const queue = [CORE_ENTRY];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (found.has(path)) continue;
    const text = read(path);
    if (text === undefined) continue;
    found.add(path);
    const code = text.replace(TYPE_ONLY, '');
    if (BARE_IMPORT.test(code)) queue.push(...PACKAGE_FILES);
    for (const [, literal] of code.matchAll(QUOTED)) {
      if (literal?.endsWith('.ts') && !literal.startsWith('/')) queue.push(normalize(join(dirname(path), literal)));
    }
  }
  return [...found].sort();
}

export const coreOnDisk = (root: string): string[] => verdictCore((path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined));

export const coreListText = (paths: readonly string[]): string =>
  `# The verdict core: every file the signing commands (bin/kiss-sign) can run. Written by pnpm verdict-core from the import graph; pnpm test fails when it is out of date.\n${paths.join('\n')}\n`;

const isProgramSide = (core: ReadonlySet<string>, path: string): boolean => core.has(path) || SPLIT_GUARDS.some((guard) => guard.endsWith('/') ? path.startsWith(guard) : path === guard);

/** A file a template or registry pull request writes by hand; the reports `pnpm report` renders from recordings are not, so a core change may render them again. */
const isTemplateData = (path: string): boolean => (path.startsWith('templates/') || path.startsWith('registry/')) && !GENERATED.test(path);

export type Split = { readonly core: string[]; readonly other: string[]; readonly data: string[] };

export function splitChanges(changed: readonly string[], core: ReadonlySet<string>): Split {
  const outside = changed.filter((path) => !['templates/', 'registry/', 'testdata/'].some((dir) => path.startsWith(dir)));
  return {
    core: outside.filter((path) => isProgramSide(core, path)),
    other: outside.filter((path) => !isProgramSide(core, path)),
    data: changed.filter(isTemplateData),
  };
}

/** The refusal for a branch that changes the verdict core and a template or the registry together, or undefined when it does not. */
export function mixedRefusal(head: string, split: Split): string | undefined {
  if (split.core.length === 0 || split.data.length === 0) return undefined;
  return [
    `${head} changes the verdict core and templates/ or registry/ together. Put the program change in a pull request of its own, reviewed as code and merged first, then the template in another.`,
    'verdict core:',
    ...split.core.map((path) => `  ${path}`),
    'templates/ and registry/:',
    ...split.data.map((path) => `  ${path}`),
  ].join('\n');
}

const gitText = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
};

/** What `head` changes since it left `base`, split into verdict core, other program files and template data; the core is walked at both ends, so a file the branch adds to the core or takes out of it counts. */
export function branchSplit(cwd: string, base: string, head: string): Split | undefined {
  const forkPoint = gitText(cwd, ['merge-base', base, head])?.trim();
  const changed = gitText(cwd, ['diff', '--name-only', '--no-renames', `${base}...${head}`]);
  if (forkPoint === undefined || changed === undefined) return undefined;
  const coreAt = (rev: string) => verdictCore((path) => gitText(cwd, ['show', `${rev}:${path}`]));
  const core = new Set([...coreAt(forkPoint), ...coreAt(head)]);
  return splitChanges(changed.split('\n').filter((path) => path !== ''), core);
}
