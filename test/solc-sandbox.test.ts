import assert from 'node:assert/strict';
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
  assert.throws(() => instantiate('0.0.0-empty', ''), /exports no standard JSON entry point/);
  assert.throws(() => instantiate('0.0.0-nomodule', 'Module = undefined;'), /did not define Module/);
});
