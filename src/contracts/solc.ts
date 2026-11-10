import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
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

type Emscripten = {
  cwrap(
    name: 'solidity_compile',
    returns: 'string',
    args: readonly ['string', 'number', 'number'],
  ): (input: string, callback: 0, context: 0) => string;
  cwrap(name: 'solidity_reset', returns: null, args: readonly []): () => void;
};

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Runs the emscripten build in a context with no Node globals, a null-prototype global (so `this.constructor` cannot
 * reach the host realm's Function), and no `eval` or `new Function`.
 */
function instantiate(version: string, source: string): Solc {
  const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: true } });
  runInContext(source, context, { filename: `soljson-${version}.js` });
  const module = (context as { Module?: Emscripten }).Module;
  if (module === undefined) throw new Error(`solc ${version} did not define Module`);
  const compile = module.cwrap('solidity_compile', 'string', ['string', 'number', 'number']);
  const reset = module.cwrap('solidity_reset', null, []);
  return {
    version,
    compile: (input) => {
      try {
        return compile(input, 0, 0);
      } finally {
        reset();
      }
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
