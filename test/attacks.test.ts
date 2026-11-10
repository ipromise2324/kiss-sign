import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { attacks, replayCases } from '../src/attacks/attacks.ts';
import type { CaseResult } from '../src/attacks/attacks.ts';

const ROOT = join(import.meta.dirname, '..');

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

test('pnpm attacks prints, per case, the card with full addresses, the decoded call, and each verdict, offline', async () => {
  let stdout = '';
  const code = await attacks([], {
    env: {},
    stdout: (text) => void (stdout += text),
    stderr: () => undefined,
    readSecret: undefined,
    ask: undefined,
    repoRoot: ROOT,
    transport: async () => assert.fail('a replay reads no provider'),
    fetchJson: async () => assert.fail('a replay reads no Transaction Service'),
  });
  assert.equal(code, 0);
  assert.match(stdout, /recipient  bybit-warm-wallet 0xf89d7b9c864f589bbF53a82105107622B35EaA40 \(the case's address book\)/);
  assert.match(stdout, /operation   1, delegatecall/);
  assert.match(stdout, /call        transfer\(address,uint256\) \(selector 0xa9059cbb\)\n    to        0xbDd077f651EBe7f7b3cE16fe5F2b025BE2969516 /);
  assert.match(stdout, /call        selector 0x804e1f0a, no published signature\n    word 0    0x000000000000000000000000ef279c2ab14960aa319008cbea384b9f8ac35fc6/);
  assert.match(stdout, /newOwner  0x57ba8957ed2ff2e7AE38F4935451E81Ce1eEFbf5 /);
  assert.deepEqual(stdout.match(/^Floor rules alone: .*$/gm), ['Floor rules alone: refused by fee-fields, delegatecall', 'Floor rules alone: pass', 'Floor rules alone: refused by delegatecall']);
  const verdicts = stdout.match(/^Verdict .*$/gm) ?? [];
  assert.equal(verdicts.length, results.flatMap((r) => r.judgements).length);
  for (const line of verdicts) assert.match(line, /: (MISMATCH|UNVERIFIABLE|no verdict, verify stopped: .*)$/);
});
