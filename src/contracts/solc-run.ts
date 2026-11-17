import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

/**
 * Runs one compile in the process `instantiate` starts for it: reads `{ version, source, input }` as JSON from standard
 * input and writes `{ output }` or `{ error }` as JSON to standard output. It imports nothing outside Node, since the
 * permission model lets it read no file but this one.
 */

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
    let message: unknown;
    try {
      message = (error as { message?: unknown } | null | undefined)?.message;
    } catch {
      message = undefined;
    }
    throw new Error(typeof message === 'string' ? `${filename} threw: ${message}` : `${filename} threw`);
  }
}

/**
 * The context gives the build no Node globals, so it sees the same bare environment on every run, and only primitive
 * strings cross into it. It is no boundary: the process is.
 */
function compile(version: string, source: string, input: string): string {
  const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: true } });
  const filename = `soljson-${version}.js`;
  // Old builds such as 0.4.18 see no known environment here and call a global `print` unless Module has one.
  runSandboxed('var Module = { print: function () {}, printErr: function () {} };', context, filename);
  runSandboxed(source, context, filename);
  const status = runSandboxed(ENTRY_POINT, context, filename);
  if (status === 'no-module') throw new Error(`solc ${version} did not define Module`);
  if (status !== 'ready') throw new Error(`solc ${version} exports no standard JSON entry point`);
  const output = runSandboxed(`kissSignCompile(${JSON.stringify(input)});`, context, filename);
  if (typeof output !== 'string') throw new Error(`solc ${version} returned no text`);
  return output;
}

const { version, source, input } = JSON.parse(readFileSync(0, 'utf8')) as { version: string; source: string; input: string };
let answer: { output: string } | { error: string };
try {
  answer = { output: compile(version, source, input) };
} catch (error) {
  answer = { error: (error as Error).message };
}
process.stdout.write(JSON.stringify(answer));
