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

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const ENTRY_POINT = `var kissSignCompile = (function () {
  if (typeof Module !== 'object' || Module === null) return 'no-module';
  var compile =
    Module._solidity_compile !== undefined
      ? Module.cwrap('solidity_compile', 'string', ['string', 'number', 'number'])
      : Module._compileStandard !== undefined
        ? Module.cwrap('compileStandard', 'string', ['string', 'number'])
        : undefined;
  if (compile === undefined) return 'no-entry-point';
  var reset = Module._solidity_reset === undefined ? undefined : Module.cwrap('solidity_reset', null, []);
  return function (input) {
    try {
      return compile(input, 0, 0);
    } finally {
      if (reset !== undefined) reset();
    }
  };
})();
typeof kissSignCompile === 'function' ? 'ready' : kissSignCompile;`;

function runSandboxed(code: string, context: object, filename: string): unknown {
  try {
    return runInContext(code, context, { filename });
  } catch (error) {
    const message = (error as { message?: unknown } | null | undefined)?.message;
    throw new Error(typeof message === 'string' ? `${filename} threw: ${message}` : `${filename} threw`);
  }
}

/**
 * Runs the emscripten build in a context with no Node globals, a null-prototype global (so `this.constructor` cannot
 * reach the host realm's Function), and no `eval` or `new Function`. Only primitive strings cross into the context:
 * the arrays passed to `cwrap` and each call are built by code run inside it, and the input enters as a string literal.
 * A compile's output is used only when it is a primitive string, and a thrown value only for a `message` that is one.
 */
export function instantiate(version: string, source: string): Solc {
  const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: true } });
  const filename = `soljson-${version}.js`;
  // Old builds such as 0.4.18 see no known environment here and call a global `print` unless Module has one. Defined
  // inside the context, these functions reach only the context's Function.
  runSandboxed('var Module = { print: function () {}, printErr: function () {} };', context, filename);
  runSandboxed(source, context, filename);
  const status = runSandboxed(ENTRY_POINT, context, filename);
  if (status === 'no-module') throw new Error(`solc ${version} did not define Module`);
  if (status !== 'ready') throw new Error(`solc ${version} exports no standard JSON entry point`);
  return {
    version,
    compile: (input) => {
      const output = runSandboxed(`kissSignCompile(${JSON.stringify(input)});`, context, filename);
      if (typeof output !== 'string') throw new Error(`solc ${version} returned no text`);
      return output;
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
