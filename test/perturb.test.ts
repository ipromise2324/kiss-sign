import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { topic } from '../src/simulate/events.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { PERTURB_DIR, checkPerturbations, replayPerturbRecording } from '../src/template/perturb.ts';
import type { PerturbationReport } from '../src/template/perturb.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

function setUp(card: Card, tx: SafeTx): { templates: Map<string, Template>; resolved: ResolvedCard } {
  const templates = new Map(card.operations.map((op) => [op.template, loadTemplate(ROOT, op.template, registry)]));
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved');
  return { templates, resolved: (result as Extract<typeof result, { kind: 'resolved' }>).card };
}

const replayed = (name: string): Promise<PerturbationReport> => replayPerturbRecording(ROOT, name, registry);

const summary = (report: PerturbationReport) =>
  report.kind === 'not-run' ? report.reason : report.runs.map((r) => `${r.leaf.callPath} ${r.leaf.arg} = ${r.value}: ${r.outcome}`);

const recorded = readdirSync(join(ROOT, PERTURB_DIR)).map((f) => f.replace(/\.json$/, ''));

for (const name of recorded.filter((n) => n !== 'morpho-deposit-free-assets')) {
  test(`${name}: every free field, changed, reverts, is refused, or changes nothing its claim forbids`, async () => {
    const report = await replayed(name);
    assert.equal(report.kind, 'pass', JSON.stringify(summary(report)));
  });
}

test('a Merkle proof or amount changed makes the claim revert', async () => {
  const report = await replayed('merkl-claim');
  assert.deepEqual(new Set(report.kind === 'pass' ? report.runs.map((r) => r.outcome) : []), new Set(['reverted']));
});

test('a deposit whose assets were left free fails, naming the field and the value that left a wei behind', async () => {
  const report = await replayed('morpho-deposit-free-assets');
  assert.equal(report.kind, 'fail');
  assert.deepEqual(
    report.kind === 'fail' ? report.failed.map((r) => [r.leaf.callPath, r.leaf.arg, r.value, r.outcome, r.detail]) : [],
    [['multiSend[1].multicall.bundle[1].data.erc4626Deposit', 'assets', '1800000000179', 'changed', 'the logs differ']],
  );
});

const APPROVE_HASH = topic('ApproveHash(bytes32,address)');
const WITHDRAW = 'morpho-withdraw-apex';
const WITHDRAW_CARD: Card = {
  operations: [{ template: 'morpho/vault-withdraw', values: { vault: 'hyperithm-usdc-apex-v1-7777', amount: '583913520554', 'max-shares': '555874861469460312138864' } }],
};

const WITHDRAWN = new Map([
  [registry.entries.get('hyperithm-usdc-apex-v1-7777')!.address, -1n],
  [registry.entries.get('usdc')!.address, 583913520554n],
]);

function fakeSimulation(tx: SafeTx, addsApproveHash: (copy: SafeTx) => boolean): (copy: SafeTx) => Promise<Observation> {
  return async (copy) => ({
    kind: 'observed',
    observed: { kind: 'executed', eth: 0n, tokens: WITHDRAWN, allowances: [], permit2: [], ends: new Map(), safeState: { kind: 'receipt', logs: [] } },
    logs: addsApproveHash(copy) ? [{ address: tx.safe, topics: [APPROVE_HASH, `0x${'11'.repeat(32)}` as Hex], data: '0x' as Hex }] : [],
  });
}

test('a free field whose change adds an approveHash the effects do not see fails, naming the field', async () => {
  const tx = safeTx(WITHDRAW);
  const { templates, resolved } = setUp(WITHDRAW_CARD, tx);
  const honest = await checkPerturbations(tx, resolved, templates, registry, fakeSimulation(tx, () => false));
  assert.equal(honest.kind, 'pass');
  const sneaky = await checkPerturbations(tx, resolved, templates, registry, fakeSimulation(tx, (copy) => copy.data !== tx.data));
  assert.equal(sneaky.kind, 'fail');
  assert.deepEqual(new Set(sneaky.kind === 'fail' ? sneaky.failed.map((r) => `${r.leaf.arg} ${r.outcome}`) : []), new Set(['value changed']));
});

test('a field claimed as a proof fails when a changed copy still executes', async () => {
  const tx = safeTx('merkl-claim');
  const { templates, resolved } = setUp({ operations: [{ template: 'merkl/claim', values: { token: 'morpho' } }] }, tx);
  const unchecked = async (): Promise<Observation> => ({
    kind: 'observed',
    observed: {
      kind: 'executed',
      eth: 0n,
      tokens: new Map([[registry.entries.get('morpho')!.address, 1n]]),
      allowances: [],
      permit2: [],
      ends: new Map(),
      safeState: { kind: 'receipt', logs: [] },
    },
    logs: [],
  });
  const report = await checkPerturbations(tx, resolved, templates, registry, unchecked);
  assert.deepEqual(new Set(report.kind === 'fail' ? report.failed.map((r) => `${r.leaf.arg} ${r.outcome}`) : []), new Set(['proofs[0] same']));
});
