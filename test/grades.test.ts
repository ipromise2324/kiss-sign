import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WEIGHT_OF } from '../src/research/grades.ts';
import { STATE_OF } from '../src/research/ledger.ts';
import type { FindingKind } from '../src/research/ledger.ts';

const kinds = Object.keys(STATE_OF) as FindingKind[];

test('every result the signer must look at is graded key or reference, so 待確認 never drops one', () => {
  for (const kind of kinds.filter((k) => STATE_OF[k] === 'bad' || STATE_OF[k] === 'warn')) assert.ok(WEIGHT_OF[kind] === 'key' || WEIGHT_OF[kind] === 'reference', kind);
});

test('only a grey result can be neutral, and only a passed one passes', () => {
  for (const kind of kinds.filter((k) => WEIGHT_OF[k] === 'neutral')) assert.equal(STATE_OF[kind], 'na', kind);
  for (const kind of kinds) assert.equal(WEIGHT_OF[kind] === 'pass', STATE_OF[kind] === 'ok', kind);
});
