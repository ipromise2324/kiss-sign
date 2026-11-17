import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOLC_PINS } from './solc-pins.ts';

export const SOLC_DIR = join(import.meta.dirname, '..', '..', 'vendor', 'solc');

/** Takes and returns solc standard JSON as text. */
export type Solc = { readonly version: string; readonly compile: (input: string) => string };

export type CompilerLoad =
  | { readonly kind: 'loaded'; readonly solc: Solc }
  | { readonly kind: 'not-pinned'; readonly version: string }
  | { readonly kind: 'missing'; readonly path: string }
  | { readonly kind: 'hash-mismatch'; readonly path: string; readonly expected: string; readonly actual: string };

export type Compilers = (version: string) => CompilerLoad;

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const RUNNER = join(import.meta.dirname, 'solc-run.ts');
const COMPILE_TIMEOUT_MS = 5 * 60_000;

/**
 * Each compile runs the build in a Node process of its own under the permission model: it may read only its runner and
 * write no file, start no process or worker, and gets an empty environment, so it holds no key. The build and the input
 * go in on its standard input and the output comes back on its standard output. The pin is the defense against a
 * hostile build; this only limits what one could reach (see the design's known limitations).
 */
export function instantiate(version: string, source: string, timeoutMs: number = COMPILE_TIMEOUT_MS): Solc {
  return {
    version,
    compile: (input) => {
      const run = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${RUNNER}`, RUNNER], {
        input: JSON.stringify({ version, source, input }),
        env: {},
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 1 << 30,
      });
      if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(`solc ${version} did not finish within ${timeoutMs / 1000} s`);
      if (run.error !== undefined) throw new Error(`solc ${version} could not run: ${run.error.message}`);
      let answer: unknown;
      try {
        answer = JSON.parse(run.stdout);
      } catch {
        answer = undefined;
      }
      const { output, error } = (typeof answer === 'object' && answer !== null ? answer : {}) as { output?: unknown; error?: unknown };
      if (typeof output === 'string') return output;
      if (typeof error === 'string') throw new Error(error);
      throw new Error(`solc ${version} gave no answer (exit ${run.status ?? run.signal}): ${run.stderr.trim().split('\n').at(-1) ?? ''}`);
    },
  };
}

/** Hashes and runs the same bytes, so the file cannot change between the check and the load. */
export function loadPinned(dir: string, version: string): CompilerLoad {
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

export function pinnedCompilers(dir: string = SOLC_DIR): Compilers {
  const loaded = new Map<string, CompilerLoad>();
  return (version) => {
    const known = loaded.get(version);
    if (known !== undefined) return known;
    const load = loadPinned(dir, version);
    if (load.kind === 'loaded') loaded.set(version, load);
    return load;
  };
}

/** The pinned compilers, with each compile kept, so a source proven twice, such as two vaults with one code, compiles once. */
export function cachedCompilers(dir: string = SOLC_DIR): Compilers {
  const pinned = pinnedCompilers(dir);
  const outputs = new Map<string, string>();
  return (version) => {
    const load = pinned(version);
    if (load.kind !== 'loaded') return load;
    const compile = (input: string) => {
      const key = `${version}\n${input}`;
      const output = outputs.get(key) ?? load.solc.compile(input);
      outputs.set(key, output);
      return output;
    };
    return { kind: 'loaded', solc: { version, compile } };
  };
}
