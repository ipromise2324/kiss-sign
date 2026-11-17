import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EngineChecks } from '../src/floor/summary.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { checkStates, decideVerdict } from '../src/verify/verdict.ts';
import type { AllChecks } from '../src/verify/verdict.ts';

const registry = loadRegistry(join(import.meta.dirname, '..'));
const HASH = `0x${'aa'.repeat(32)}` as Hex;
const OTHER_HASH = `0x${'bb'.repeat(32)}` as Hex;
const USDC = registry.entries.get('usdc')!.address;

const passing: AllChecks = {
  approvals: [{ template: 'morpho/vault-deposit', hash: HASH, approved: HASH }],
  staticFloor: { kind: 'pass' },
  fields: { kind: 'match' },
  assets: { kind: 'pass' },
  code: { kind: 'pass' },
  mutation: { kind: 'pass', bound: 12, free: 1 },
  simulation: { kind: 'observed', effects: { kind: 'match' }, floor: { kind: 'pass' } },
};
const verdictOf = (changes: Partial<AllChecks>) => decideVerdict({ ...passing, ...changes }, registry);
const refused = { kind: 'refused', findings: [{ rule: 'fee-fields', callPath: 'safeTx', detail: 'gasPrice is 1, must be zero', bytes: undefined }] } as const;
const fieldMismatch: EngineChecks['fields'] = {
  kind: 'mismatch',
  findings: [{ callPath: 'multiSend[1].multicall.bundle[1].data.erc4626Deposit', arg: 'receiver', bytes: [0, 32], expected: '0xsafe', actual: '0xother' }],
};
const observedWith = (effects: unknown, floor: unknown = { kind: 'pass' }) => ({ simulation: { kind: 'observed', effects, floor } as EngineChecks['simulation'] });

const rows: readonly { name: string; changes: Partial<AllChecks>; verdict: string; causes: Record<string, RegExp> }[] = [
  { name: 'every check passing', changes: {}, verdict: 'MATCH', causes: {} },
  {
    name: 'a template that differs from its approved hash',
    changes: { approvals: [{ template: 'morpho/vault-deposit', hash: OTHER_HASH, approved: HASH }] },
    verdict: 'MISMATCH',
    causes: { 'template-approval': /morpho\/vault-deposit hashes to 0xbb.*approved hash is 0xaa/ },
  },
  {
    name: 'a template never approved',
    changes: { approvals: [{ template: 'morpho/vault-deposit', hash: HASH, approved: undefined }] },
    verdict: 'UNVERIFIABLE',
    causes: { 'template-approval': /never approved/ },
  },
  { name: 'a refused static floor', changes: { staticFloor: refused }, verdict: 'MISMATCH', causes: { 'static-floor': /fee-fields at safeTx: gasPrice/ } },
  { name: 'a mismatched field', changes: { fields: fieldMismatch }, verdict: 'MISMATCH', causes: { fields: /erc4626Deposit receiver: expected 0xsafe, got 0xother/ } },
  {
    name: 'a vault whose asset() is not the registry asset',
    changes: { assets: { kind: 'mismatch', findings: ['smokehouse-usdc-v1-f5bc 0x1 holds 0x2 by its asset() at block 1, the registry says usdt 0x3'] } },
    verdict: 'MISMATCH',
    causes: { 'vault-asset': /smokehouse-usdc-v1-f5bc 0x1 holds 0x2 by its asset\(\) at block 1, the registry says usdt 0x3/ },
  },
  {
    name: 'a vault asset() the providers disagree on',
    changes: { assets: { kind: 'unverifiable', reasons: ['eth_call: alchemy and drpc disagree'] } },
    verdict: 'UNVERIFIABLE',
    causes: { 'vault-asset': /disagree/ },
  },
  {
    name: 'an unverifiable field',
    changes: { fields: { kind: 'unverifiable', reasons: ['the registry has no bundler3'] }, mutation: { kind: 'not-run', check: { kind: 'unverifiable', reasons: [] } } },
    verdict: 'UNVERIFIABLE',
    causes: { fields: /no bundler3/, mutation: /not run/ },
  },
  {
    name: 'a weak template',
    changes: {
      mutation: {
        kind: 'weak-template',
        bound: 12,
        free: 1,
        uncaught: [{ leaf: { callPath: 'multiSend[0].approve', arg: 'spender', bytes: [0, 32], rule: { kind: 'contract', name: 'general-adapter-1' }, type: { kind: 'address' } }, mutated: 'match' }],
      },
    },
    verdict: 'UNVERIFIABLE',
    causes: { mutation: /multiSend\[0\]\.approve spender gave match/ },
  },
  { name: 'an unverifiable simulation', changes: { simulation: { kind: 'unverifiable', reasons: ['alchemy and drpc disagree'] } }, verdict: 'UNVERIFIABLE', causes: { simulation: /disagree/ } },
  { name: 'a refused simulated floor', changes: observedWith({ kind: 'match' }, refused), verdict: 'MISMATCH', causes: { 'simulated-floor': /gasPrice/ } },
  {
    name: 'mismatched effects',
    changes: observedWith({ kind: 'mismatch', findings: [{ kind: 'balance', asset: USDC, expected: { kind: 'exactly', change: -5n }, actual: -6n }] }),
    verdict: 'MISMATCH',
    causes: { effects: /usdc .* changed by -6, the card explains -5/ },
  },
  { name: 'unverifiable effects', changes: observedWith({ kind: 'unverifiable', reasons: ['did not execute: reverted'] }), verdict: 'UNVERIFIABLE', causes: { effects: /reverted/ } },
  {
    name: 'a mismatch beside an unverifiable check',
    changes: { fields: fieldMismatch, simulation: { kind: 'unverifiable', reasons: ['alchemy failed (timeout)'] } },
    verdict: 'MISMATCH',
    causes: { fields: /receiver/ },
  },
];

for (const row of rows) {
  test(`verdict table: ${row.name} gives ${row.verdict}`, () => {
    const verdict = verdictOf(row.changes);
    assert.equal(verdict.kind, row.verdict);
    const causes = verdict.kind === 'MATCH' ? [] : verdict.causes;
    assert.deepEqual(causes.map((c) => c.check), Object.keys(row.causes));
    for (const cause of causes) assert.match(cause.details.join('\n'), row.causes[cause.check]!);
  });
}

test('an unexplained token in the effects names the token address', () => {
  const stray = '0x1111111111111111111111111111111111111111' as Address;
  const verdict = verdictOf(observedWith({ kind: 'mismatch', findings: [{ kind: 'balance', asset: stray, expected: { kind: 'exactly', change: 0n }, actual: 1n }] }));
  assert.equal(verdict.kind, 'MISMATCH');
  assert.match(JSON.stringify(verdict), new RegExp(stray));
});

test("a mismatch's page states say which checks passed, which failed, which did not run and which the card does not need", () => {
  const checks: AllChecks = { ...passing, assets: { kind: 'not-needed' }, fields: fieldMismatch, mutation: { kind: 'not-run', check: fieldMismatch }, simulation: { kind: 'unverifiable', reasons: ['the nonce was used'] } };
  assert.deepEqual(checkStates(checks, registry), {
    'template-approval': 'passed',
    'static-floor': 'passed',
    fields: 'failed',
    'vault-asset': 'not-needed',
    'contract-code': 'passed',
    mutation: 'not-run',
    simulation: 'unverifiable',
    'simulated-floor': 'not-run',
    effects: 'not-run',
  });
  const verdict = verdictOf(checks);
  assert.deepEqual(verdict.kind === 'MISMATCH' ? verdict.causes.map((c) => c.check) : verdict.kind, ['fields']);
});

test('a balance finding reads in whole tokens beside its base units when the token decimals are known', () => {
  const findings = { kind: 'mismatch', findings: [{ kind: 'balance', asset: USDC, expected: { kind: 'at-least', change: 0n }, actual: -1500000n }] };
  const verdict = decideVerdict({ ...passing, ...observedWith(findings) }, registry, new Map([[USDC, 6]]));
  assert.deepEqual(verdict.kind === 'MISMATCH' ? verdict.causes : [], [
    { check: 'effects', details: [`usdc ${USDC} changed by -1.5 (-1500000 base units), the card explains at least 0`] },
  ]);
  const bare = verdictOf(observedWith(findings));
  assert.deepEqual(bare.kind === 'MISMATCH' ? bare.causes[0]?.details : [], [`usdc ${USDC} changed by -1500000, the card explains at least 0`]);
});
