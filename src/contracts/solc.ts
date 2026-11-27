import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOLC_PINS } from './solc-pins.ts';

export const SOLC_DIR = join(import.meta.dirname, '..', '..', 'vendor', 'solc');

/** Takes and returns solc standard JSON as text. */
export type Solc = { readonly version: string; readonly compile: (input: string) => string };

/** A pinned build, which can also compile while the caller goes on. */
export type PinnedSolc = Solc & { readonly compileAside: (input: string) => Promise<string> };

export type CompilerLoad =
  | { readonly kind: 'loaded'; readonly solc: Solc }
  | LoadRefusal;

export type LoadRefusal =
  | { readonly kind: 'not-pinned'; readonly version: string }
  | { readonly kind: 'missing'; readonly path: string }
  | { readonly kind: 'hash-mismatch'; readonly path: string; readonly expected: string; readonly actual: string };

type PinnedLoad = { readonly kind: 'loaded'; readonly solc: PinnedSolc } | LoadRefusal;

export type Compilers = (version: string) => CompilerLoad;

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const RUNNER = join(import.meta.dirname, 'solc-run.ts');
const COMPILE_TIMEOUT_MS = 5 * 60_000;
/** Compiles run ahead at a time. */
const AHEAD_WIDTH = 2;
const RUNNER_ARGS = ['--permission', `--allow-fs-read=${RUNNER}`, RUNNER];
const RUNNER_OPTIONS = { env: {}, killSignal: 'SIGKILL', maxBuffer: 1 << 30 } as const;

/**
 * Each compile runs the build in a Node process of its own under the permission model: it may read only its runner and
 * write no file, start no process or worker, and gets an empty environment, so it holds no key. The build and the input
 * go in on its standard input and the output comes back on its standard output. The pin is the defense against a
 * hostile build; this only limits what one could reach (see the design's known limitations).
 */
export function instantiate(version: string, source: string, timeoutMs: number = COMPILE_TIMEOUT_MS): PinnedSolc {
  return {
    version,
    compile: (input) => {
      const run = spawnSync(process.execPath, RUNNER_ARGS, { ...RUNNER_OPTIONS, input: JSON.stringify({ version, source, input }), encoding: 'utf8', timeout: timeoutMs });
      if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(`solc ${version} did not finish within ${timeoutMs / 1000} s`);
      if (run.error !== undefined) throw new Error(`solc ${version} could not run: ${run.error.message}`);
      return outputOf(version, run.stdout, `exit ${run.status ?? run.signal}`, run.stderr);
    },
    compileAside: (input) =>
      new Promise((resolve, reject) => {
        const child = execFile(process.execPath, RUNNER_ARGS, { ...RUNNER_OPTIONS, encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
          if (error !== null) return reject(error);
          try {
            resolve(outputOf(version, stdout, 'exit 0', stderr));
          } catch (failure) {
            reject(failure);
          }
        });
        child.stdin?.on('error', () => {});
        child.stdin?.end(JSON.stringify({ version, source, input }));
      }),
  };
}

function outputOf(version: string, stdout: string, ended: string, stderr: string): string {
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    answer = undefined;
  }
  const { output, error } = (typeof answer === 'object' && answer !== null ? answer : {}) as { output?: unknown; error?: unknown };
  if (typeof output === 'string') return output;
  if (typeof error === 'string') throw new Error(error);
  throw new Error(`solc ${version} gave no answer (${ended}): ${stderr.trim().split('\n').at(-1) ?? ''}`);
}

/** Hashes and runs the same bytes, so the file cannot change between the check and the load. */
export function loadPinned(dir: string, version: string): PinnedLoad {
  const pin = SOLC_PINS[version];
  if (pin === undefined) return { kind: 'not-pinned', version };
  const path = join(dir, pin.file);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', path };
    throw error;
  }
  const actual = sha256Hex(bytes);
  if (actual !== pin.sha256) return { kind: 'hash-mismatch', path, expected: pin.sha256, actual };
  return { kind: 'loaded', solc: instantiate(version, bytes.toString('utf8')) };
}

export function pinnedCompilers(dir: string = SOLC_DIR): (version: string) => PinnedLoad {
  const loaded = new Map<string, PinnedLoad>();
  return (version) => {
    const known = loaded.get(version);
    if (known !== undefined) return known;
    const load = loadPinned(dir, version);
    if (load.kind === 'loaded') loaded.set(version, load);
    return load;
  };
}

/** The pinned compilers, with each compile kept, so a source proven twice, such as two vaults with one code, compiles once. */
export const cachedCompilers = (dir: string = SOLC_DIR): Compilers => compilersAhead(dir).compilers;

const keyOf = (version: string, input: string): string => `${version}\n${input}`;

/**
 * `cachedCompilers`, and `ahead`, which runs `prove` with compilers that answer only what is compiled already, compiles
 * what it asked for, `AHEAD_WIDTH` at a time, in the same sandboxed process, and runs it again until it asks for no
 * more. `compilers` then finds those outputs. What `prove` gives is for the caller to drop: a compile that fails here is
 * left to `compilers`, which compiles it again.
 */
export function compilersAhead(dir: string = SOLC_DIR): { readonly compilers: Compilers; readonly ahead: (prove: (compilers: Compilers) => Promise<unknown>) => Promise<void> } {
  const pinned = pinnedCompilers(dir);
  const outputs = new Map<string, string>();
  const tried = new Map<string, Promise<void>>();
  const slots = Array.from({ length: AHEAD_WIDTH }, () => Promise.resolve());
  const compilersWith =
    (missing: (solc: PinnedSolc, input: string) => string): Compilers =>
    (version) => {
      const load = pinned(version);
      if (load.kind !== 'loaded') return load;
      return { kind: 'loaded', solc: { version, compile: (input) => outputs.get(keyOf(version, input)) ?? missing(load.solc, input) } };
    };
  const compileAside = (solc: PinnedSolc, input: string): Promise<void> => {
    const key = keyOf(solc.version, input);
    const known = tried.get(key);
    if (known !== undefined) return known;
    const slot = tried.size % AHEAD_WIDTH;
    const run = (slots[slot] as Promise<void>).then(async () => {
      outputs.set(key, await solc.compileAside(input));
    });
    slots[slot] = run.catch(() => {});
    tried.set(key, slots[slot]);
    return slots[slot];
  };
  return {
    compilers: compilersWith((solc, input) => {
      const output = solc.compile(input);
      outputs.set(keyOf(solc.version, input), output);
      return output;
    }),
    ahead: async (prove) => {
      for (;;) {
        const asked: Promise<void>[] = [];
        const before = outputs.size;
        const trial = compilersWith((solc, input) => {
          asked.push(compileAside(solc, input));
          throw new Error('not compiled yet');
        });
        await prove(trial).catch(() => undefined);
        if (asked.length === 0) return;
        await Promise.all(asked);
        if (outputs.size === before) return;
      }
    },
  };
}
