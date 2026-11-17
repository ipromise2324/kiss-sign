import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { instantiate } from '../src/contracts/solc.ts';

const HOSTILE_SOLC = `
var reached = [];
function reachesProcess(label, value) {
  var tries = [
    function () { return value.constructor.constructor('return process')(); },
    function () { return Object.getPrototypeOf(value).constructor.constructor('return process')(); },
    function () { return value.__proto__.constructor.constructor('return process')(); },
  ];
  for (var i = 0; i < tries.length; i++) {
    try {
      var found = tries[i]();
      if (typeof found === 'object' && found !== null && typeof found.pid === 'number') reached.push(label + '#' + i);
    } catch (error) {}
  }
}
var seen = 0;
Module._solidity_compile = 1;
Module._solidity_reset = 1;
Module.cwrap = function (name, returns, args) {
  seen++;
  reachesProcess('cwrap this', this);
  reachesProcess('cwrap args', args);
  reachesProcess('cwrap arguments', arguments);
  return function (input, callback, context) {
    seen++;
    reachesProcess('call this', this);
    reachesProcess('call input', input);
    reachesProcess('call arguments', arguments);
    reachesProcess('call caller', arguments.callee.caller);
    return JSON.stringify({ seen: seen, reached: reached, input: input });
  };
};
`;

test('a compiler that probes every value it is handed for the host Function cannot reach process', () => {
  const solc = instantiate('0.0.0-hostile', HOSTILE_SOLC);
  const output = JSON.parse(solc.compile('{"language":"Solidity"}')) as { seen: number; reached: string[]; input: string };
  assert.equal(output.seen, 3, 'cwrap ran for compile and reset, and the compile was called');
  assert.equal(output.input, '{"language":"Solidity"}');
  assert.deepEqual(output.reached, []);
});

test('a compiler that returns anything but a string, or throws an object, is refused without reading it', () => {
  const returnsObject = instantiate(
    '0.0.0-object',
    "Module._solidity_compile = 1; Module.cwrap = function () { return function () { return { toString: function () { return 'x'; } }; }; };",
  );
  assert.throws(() => returnsObject.compile('{}'), /solc 0\.0\.0-object returned no text/);
  const throwsObject = instantiate(
    '0.0.0-throws',
    'Module._solidity_compile = 1; Module.cwrap = function () { return function () { throw { message: 42 }; }; };',
  );
  assert.throws(() => throwsObject.compile('{}'), /^Error: soljson-0\.0\.0-throws\.js threw$/);
  const throwsFromGetter = instantiate(
    '0.0.0-getter',
    'Module._solidity_compile = 1; Module.cwrap = function () { return function () { throw { get message() { throw {}; } }; }; };',
  );
  assert.throws(
    () => throwsFromGetter.compile('{}'),
    (error: unknown) => error instanceof Error && /^soljson-0\.0\.0-getter\.js threw$/.test(error.message),
  );
});

test('a build with no standard JSON entry point is refused', () => {
  assert.throws(() => instantiate('0.0.0-empty', '').compile('{}'), /exports no standard JSON entry point/);
  assert.throws(() => instantiate('0.0.0-nomodule', 'Module = undefined;').compile('{}'), /did not define Module/);
});

test('a build that reaches the host process through a dynamic import finds no key, and may not read, write, spawn or start a worker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-solc-'));
  const escape = `
Module._solidity_compile = 1;
Module.cwrap = function () { return function () { return 'ok'; }; };
import('x').catch(function (e) {
  var host = e.constructor.constructor('return process')();
  var seen = { pid: typeof host.pid, env: Object.keys(host.env) };
  var attempt = function (name, act) { try { act(); seen[name] = 'done'; } catch (x) { seen[name] = x.code || String(x.message); } };
  attempt('write', function () { host.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(join(dir, 'written'))}, 'x'); });
  attempt('read', function () { host.getBuiltinModule('node:fs').readFileSync(${JSON.stringify(import.meta.filename)}); });
  attempt('spawn', function () { host.getBuiltinModule('node:child_process').execFileSync('/usr/bin/touch', [${JSON.stringify(join(dir, 'spawned'))}]); });
  attempt('worker', function () { new (host.getBuiltinModule('node:worker_threads').Worker)('1', { eval: true }); });
  host.stderr.write(JSON.stringify(seen));
  host.stdout.write('x');
});`;
  const key = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = 'a-key-the-compiler-must-not-see';
  let message = '';
  try {
    instantiate('0.0.0-escape', escape).compile('{}');
  } catch (error) {
    message = (error as Error).message;
  } finally {
    if (key === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = key;
  }
  const seen = JSON.parse(/gave no answer \(exit 0\): (\{.*\})$/.exec(message)?.[1] ?? 'null') as Record<string, unknown> & { env: string[] };
  assert.equal(seen.pid, 'number', 'the dynamic import still reaches the process the build runs in');
  assert.equal(seen.env.includes('ALCHEMY_API_KEY'), false);
  assert.deepEqual([seen.write, seen.read, seen.spawn, seen.worker], ['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED']);
  assert.deepEqual(readdirSync(dir), []);
});

test('a build that never finishes is killed and refused, even one that reaches its process and ignores SIGTERM', () => {
  assert.throws(() => instantiate('0.0.0-loop', 'for (;;) {}', 2_000).compile('{}'), /^Error: solc 0\.0\.0-loop did not finish within 2 s$/);
  const stubborn = `
Module._solidity_compile = 1;
Module.cwrap = function () { return function () { return 'ok'; }; };
import('x').catch(function (e) {
  var host = e.constructor.constructor('return process')();
  host.on('SIGTERM', function () {});
  for (;;) {}
});`;
  assert.throws(() => instantiate('0.0.0-stubborn', stubborn, 2_000).compile('{}'), /^Error: solc 0\.0\.0-stubborn did not finish within 2 s$/);
});
