import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

export const CORE_ENTRY = 'bin/kiss-sign';
export const CORE_LIST = 'docs/verdict-core.txt';
export const CANARY_LIST = 'docs/canaries.txt';
export const SPLIT_GUARDS = ['src/verdict-core.ts', 'src/canaries.ts', 'src/canary-reads.ts', 'scripts/check-push.ts', 'scripts/report.ts', 'scripts/program-gate.ts', '.gitignore', '.githooks/', '.github/workflows/'];

export const PACKAGE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const TYPE_ONLY = /^\s*(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s*(['"])[^'"\n]*\1\s*;?/gm;
const QUOTED = /(['"`])([^'"`\n]+)\1/g;
const LOCAL_FILE = /\.(?:ts|mts|js|mjs|json)$/;
const BARE_IMPORT = /\b(?:from|import)\s*\(?\s*['"`](?!node:|\.|\/)/;
const GENERATED = /\.generated(\.[A-Za-z-]+)?\.(md|html)$/;

type Read = (path: string) => string | undefined;

/** Every repository path whose code the files at `entries` can run, through every import that is not type-only and every script or JSON file one of them names by a relative path, such as one it spawns or reads. */
function walkImports(entries: readonly string[], read: Read): string[] {
  const found = new Set<string>();
  const queue = [...entries];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (found.has(path)) continue;
    const text = read(path);
    if (text === undefined) continue;
    found.add(path);
    const code = text.replace(TYPE_ONLY, '');
    if (BARE_IMPORT.test(code)) queue.push(...PACKAGE_FILES);
    for (const [, , literal] of code.matchAll(QUOTED)) {
      if (literal !== undefined && LOCAL_FILE.test(literal) && !literal.startsWith('/')) queue.push(normalize(join(dirname(path), literal)));
    }
  }
  return [...found].sort();
}

/** Every repository path whose code the signing commands can run, walked from `bin/kiss-sign`. */
export const verdictCore = (read: Read): string[] => walkImports([CORE_ENTRY], read);

export const coreOnDisk = (root: string): string[] => verdictCore((path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined));

export const coreListText = (paths: readonly string[]): string =>
  `# The verdict core: every file the signing commands (bin/kiss-sign) can run. Written by pnpm verdict-core from the import graph; pnpm test fails when it is out of date.\n${paths.join('\n')}\n`;

/** Paths compare without letter case, since the signer's macOS clone writes `.Githooks/x` into `.githooks/`. */
const isProgramSide = (core: ReadonlySet<string>, path: string): boolean => core.has(path.toLowerCase()) || underAny(SPLIT_GUARDS, path);

const underAny = (paths: readonly string[], path: string): boolean => {
  const key = path.toLowerCase();
  return paths.some((entry) => (entry.endsWith('/') ? key.startsWith(entry.toLowerCase()) : key === entry.toLowerCase()));
};

/** One test the verdict must keep passing: the file it lives in, what it guards, and every path under `testdata/` or `test/` it reads, a directory ending in `/`. */
export type Canary = { readonly file: string; readonly guards: string; readonly reads: readonly string[] };

export class CanaryListError extends Error {}

/** Parses `docs/canaries.txt`: blocks of `canary <file>`, one `guards <text>`, and any `reads <path>` lines, separated by blank lines; `#` starts a comment line. */
export function parseCanaryList(text: string): Canary[] {
  const canaries: Canary[] = [];
  const blocks = text.split('\n').filter((line) => !line.startsWith('#')).join('\n').split(/\n\s*\n/).map((block) => block.trim()).filter((block) => block !== '');
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => /^(canary|guards|reads) (\S.*)$/.exec(line.trim()) ?? line);
    const bad = lines.find((line) => typeof line === 'string');
    if (bad !== undefined) throw new CanaryListError(`${CANARY_LIST}: "${bad}" is not a canary, guards or reads line`);
    const of = (key: string) => (lines as RegExpExecArray[]).filter((line) => line[1] === key).map((line) => line[2]!);
    const [file, ...files] = of('canary');
    const [guards, ...more] = of('guards');
    if (file === undefined || files.length > 0 || guards === undefined || more.length > 0) throw new CanaryListError(`${CANARY_LIST}: each block names exactly one canary and one guards line, not "${block.split('\n')[0]}"`);
    if (!/^test\/canaries\/[\w-]+\.canary\.ts$/.test(file)) throw new CanaryListError(`${CANARY_LIST}: ${file} is not a test/canaries/<name>.canary.ts file`);
    const reads = of('reads');
    const outside = reads.find((path) => !(path.startsWith('testdata/') || path.startsWith('test/')) || path.split('/').some((part) => part === '..' || part === '.'));
    if (outside !== undefined) throw new CanaryListError(`${CANARY_LIST}: ${file} reads ${outside}, which is not a path under testdata/ or test/`);
    canaries.push({ file, guards, reads });
  }
  if (new Set(canaries.map(({ file }) => file)).size !== canaries.length) throw new CanaryListError(`${CANARY_LIST}: a canary is listed twice`);
  return canaries;
}

/** The code that enforces the rules, beside the canaries, their list, the files they import and the paths they read. A dependency, a pnpm script or a looser typecheck is code no canary reads, so the package files and tsconfig.json count too. */
export const GATE_CODE = [...SPLIT_GUARDS, CANARY_LIST, 'test/canaries/', 'test/canaries.test.ts', '.claude/skills/kiss-sign/', 'tsconfig.json', '.npmrc', ...PACKAGE_FILES];

/**
 * Whether a path belongs to the program gate as the repository read through `read` declares it: the gate code, every canary,
 * every file a canary imports that the verdict core does not hold, and every path a canary reads.
 */
export function gateAt(read: Read): (path: string) => boolean {
  const list = read(CANARY_LIST);
  const canaries = list === undefined ? [] : parseCanaryList(list);
  const core = new Set(verdictCore(read));
  const paths = [...GATE_CODE, ...walkImports(canaries.map(({ file }) => file), read).filter((path) => !core.has(path)), ...canaries.flatMap(({ reads }) => reads)];
  return (path) => underAny(paths, path);
}

/** One file a branch changes; `modified` is false when the branch adds or deletes it. */
export type Change = { readonly path: string; readonly modified: boolean };

/**
 * A change to a template or the registry. A report `pnpm report` renders from recordings may be rendered again beside a core change,
 * but adding or deleting one is data, since a vault's report.generated.md decides which vaults `card seal` and `verify` accept.
 */
const isTemplateData = ({ path, modified }: Change): boolean => underAny(['templates/', 'registry/'], path) && !(modified && GENERATED.test(path));

/** A branch's changes: `core` holds the verdict core and the guards that keep it apart, `gate` every file of the program gate, in any directory. */
export type Split = { readonly core: string[]; readonly other: string[]; readonly data: string[]; readonly gate: string[] };

export function splitChanges(changed: readonly Change[], core: ReadonlySet<string>, isGate: (path: string) => boolean): Split {
  const outside = changed.map(({ path }) => path).filter((path) => !underAny(['templates/', 'registry/', 'testdata/'], path));
  return {
    core: outside.filter((path) => isProgramSide(core, path)),
    other: outside.filter((path) => !isProgramSide(core, path)),
    data: changed.filter(isTemplateData).map(({ path }) => path),
    gate: changed.map(({ path }) => path).filter(isGate),
  };
}

const listed = (paths: readonly string[]) => paths.map((path) => `  ${path}`);

/** The refusal for a branch that changes the verdict core beside a template or the registry, or beside the program gate, or undefined when it does neither. */
export function mixedRefusal(base: string, head: string, split: Split): string | undefined {
  const counted = `counted from where it left ${base} (if ${base} is behind GitHub, fetch it and run this again)`;
  const verdict = split.core.filter((path) => !split.gate.includes(path));
  const refusals = [
    ...(split.core.length > 0 && split.data.length > 0
      ? [
          `${head} changes the verdict core and templates/ or registry/ together, ${counted}. Put the program change in a pull request of its own, reviewed as code and merged first, then the template in another.`,
          'verdict core:',
          ...listed(split.core),
          'templates/ and registry/:',
          ...listed(split.data),
        ]
      : []),
    ...(verdict.length > 0 && split.gate.length > 0
      ? [
          `${head} changes the verdict core and the program gate together, ${counted}. The gate is what lets the AI merge a program change without the signer: the canaries in ${CANARY_LIST}, the files they import and read, and the code that enforces these rules. Put the gate change in a pull request of its own, which the signer reviews and merges, then the verdict core change in another.`,
          'verdict core:',
          ...listed(verdict),
          'program gate:',
          ...listed(split.gate),
        ]
      : []),
  ];
  return refusals.length === 0 ? undefined : refusals.join('\n');
}
const gitText = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
};

/** What `head` changes since it left `base`, split into verdict core, other program files, template data and the program gate, or undefined when git cannot tell; the core and the gate are read at both ends, so a file the branch adds to either or takes out of it counts. */
export function branchSplit(cwd: string, base: string, head: string): Split | undefined {
  const forkPoint = gitText(cwd, ['merge-base', base, head])?.trim();
  const changed = gitText(cwd, ['diff', '-z', '--name-status', '--no-renames', `${base}...${head}`]);
  if (!forkPoint || changed === undefined) return undefined;
  const readAt = (rev: string): Read => (path) => gitText(cwd, ['show', `${rev}:${path}`]);
  const core = new Set([...verdictCore(readAt(forkPoint)), ...verdictCore(readAt(head))]);
  const gates = [gateAt(readAt(forkPoint)), gateAt(readAt(head))];
  const fields = changed.split('\0');
  const changes = Array.from({ length: Math.floor(fields.length / 2) }, (_, i) => ({ path: fields[2 * i + 1]!, modified: fields[2 * i] === 'M' }));
  return splitChanges(changes, core, (path) => gates.some((isGate) => isGate(path)));
}
