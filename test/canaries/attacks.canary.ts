import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { replayCases } from '../../src/attacks/attacks.ts';
import type { CaseResult } from '../../src/attacks/attacks.ts';

const ROOT = join(import.meta.dirname, '..', '..');

/** Each run's catching checks, a floor check named with its rule, as the verdict gives them, or why verify gave none. */
const CAUGHT_BY: Record<string, Record<string, readonly string[] | string>> = {
  bybit: {
    'as proposed': ['static-floor fee-fields', 'static-floor delegatecall', 'fields'],
    'as executed': ['static-floor fee-fields', 'static-floor delegatecall', 'fields', 'effects'],
  },
  wazirx: {
    'as proposed': ['static-floor delegatecall', 'fields'],
    'as executed': ['static-floor delegatecall', 'fields', 'effects'],
  },
  radiant: {
    'as proposed': 'refused: the card is refused at operations[0]: no template "radiant/admin"',
  },
};

const catching = (result: CaseResult): Record<string, string[] | string> =>
  Object.fromEntries(
    result.judgements.map(({ label, outcome }) => {
      const run = label.split(',')[0]!;
      if (outcome.kind === 'refused') return [run, `refused: ${outcome.reason}`];
      if (outcome.verdict.kind === 'MATCH') return [run, 'MATCH'];
      const names = outcome.verdict.causes.flatMap(({ check, details }) =>
        check === 'static-floor' || check === 'simulated-floor' ? details.map((d) => `${check} ${d.split(' at ')[0]}`) : [check],
      );
      return [run, names];
    }),
  );

const results = await replayCases(ROOT);

test('every recorded attack has its expected catching checks listed here', () => {
  assert.deepEqual(results.map((r) => r.attack.id).sort(), Object.keys(CAUGHT_BY).sort());
});

for (const result of results) {
  test(`${result.attack.id}: no run is MATCH, and the checks that catch it are the expected ones`, () => {
    for (const { label, outcome } of result.judgements) assert.ok(outcome.kind === 'refused' || outcome.verdict.kind !== 'MATCH', `${label} is not MATCH`);
    assert.deepEqual(catching(result), CAUGHT_BY[result.attack.id]);
  });
}
