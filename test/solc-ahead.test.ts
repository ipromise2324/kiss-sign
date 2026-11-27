import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { compilersAhead, instantiate, pinnedCompilers } from '../src/contracts/solc.ts';
import type { Compilers } from '../src/contracts/solc.ts';

const VERSION = '0.8.17+commit.8df45f5f';
const input = (name: string) =>
  JSON.stringify({ language: 'Solidity', sources: { 'a.sol': { content: `contract ${name} {}` } }, settings: { outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } } } });

const compileWith = (compilers: Compilers, text: string): string => {
  const load = compilers(VERSION);
  assert.equal(load.kind, 'loaded');
  return load.kind === 'loaded' ? load.solc.compile(text) : '';
};

test('a compile run ahead gives the very output the pinned compiler gives, and is not run again', async () => {
  const { compilers, ahead } = compilersAhead();
  const inputs = [input('First'), input('Second')];
  const asked: string[] = [];
  await ahead(async (trial) => {
    for (const text of inputs) {
      asked.push(text);
      compileWith(trial, text);
    }
  });
  assert.equal(asked.at(-1), inputs[1], 'a prove that stops at its first compile runs on to the next');
  let outputs: string[] = [];
  await ahead(async (trial) => {
    outputs = inputs.map((text) => compileWith(trial, text));
  });
  assert.deepEqual(outputs, inputs.map((text) => compileWith(pinnedCompilers(), text)), 'a kept output is answered without compiling');
  for (const text of inputs) assert.equal(compileWith(compilers, text), compileWith(pinnedCompilers(), text));
});

test('a version that is not pinned is refused ahead as it is in order', async () => {
  const { compilers, ahead } = compilersAhead(join(import.meta.dirname, 'no-such-folder'));
  await ahead(async (trial) => assert.equal(trial(VERSION).kind, 'missing'));
  assert.equal(compilers(VERSION).kind, 'missing');
});

test('a build that compiles aside is held by the same sandbox, time limit and refusals', async () => {
  const solc = instantiate('0.0.0-echo', "Module._solidity_compile = 1; Module.cwrap = function () { return function (input) { return input; }; };");
  assert.equal(await solc.compileAside('{"a":1}'), solc.compile('{"a":1}'));
  await assert.rejects(instantiate('0.0.0-loop', 'for (;;) {}', 1_500).compileAside('{}'));
  await assert.rejects(instantiate('0.0.0-empty', '').compileAside('{}'), /exports no standard JSON entry point/);
});
