import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Hex, SafeTx } from '../src/safe/types.ts';
import { judgeEffects, viewCalls } from '../src/simulate/effects.ts';
import type { EffectVerdict } from '../src/simulate/effects.ts';
import { observeExecuted, withSimulatedViews } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate, parseTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const templates = new Map([['morpho/market-supply', loadTemplate(ROOT, 'morpho/market-supply', registry)]]);
const USDC = registry.entries.get('usdc')!.address;

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const supply = (amount: string, market = 'usdc-cbbtc-86'): Card => ({
  operations: [{ template: 'morpho/market-supply', values: { market, amount } }],
});

const check = (tx: SafeTx, card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);
const mismatchedArgs = (result: FieldCheck) => (result.kind === 'mismatch' ? result.findings.map((f) => f.arg) : result);

const CASES = [
  { name: 'morpho-market-supply', amount: '72159646110' },
  { name: 'morpho-market-supply-other-safe', amount: '20000000000000' },
] as const;

for (const c of CASES) {
  const tx = safeTx(c.name);

  test(`${c.name} matches morpho/market-supply with the card it implies`, () => {
    assert.deepEqual(check(tx, supply(c.amount)), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, supply(c.amount)), templates, registry), { kind: 'pass', bound: 15, free: 2 });
  });

  test(`${c.name}: a card with another amount is a mismatch at the approval and the supply`, () => {
    assert.deepEqual(mismatchedArgs(check(tx, supply(`${BigInt(c.amount) + 1n}`))), ['value', 'assets']);
  });
}

test('a supply that approves 2^256-1 instead of the amount is a mismatch at the approval', () => {
  assert.deepEqual(mismatchedArgs(check(safeTx('morpho-market-supply-unlimited-approval'), supply('6522506459084'))), ['value']);
});

test('a card naming no registry market is refused', () => {
  const tx = safeTx(CASES[0].name);
  const result = resolveCard(supply(CASES[0].amount, 'usdc-cbbtc-91'), { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'refused');
});

type Fixture = { transactionHash: Hex; template?: unknown; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(ROOT, 'testdata', 'simulate', `${name}.json`), 'utf8'));

/** The recorded supply, simulated on its parent block and observed from its receipt, judged against the card. */
async function recordedVerdicts(name: string, card: Card): Promise<{ simulated: EffectVerdict; executed: EffectVerdict }> {
  const recorded = fixture(name);
  const tx = safeTx(CASES[0].name);
  const used = recorded.template === undefined ? templates : new Map([['morpho/market-supply', parseTemplate(recorded.template, registry)]]);
  const reader = replayReader(recorded.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(recorded.parent), await header(recorded.executed)];
  const views = viewCalls(resolved(tx, card), used, registry);
  const simulated = await simulateSafeTx(reader, { tx, parent, time: executed.time, watch: [USDC], ends: [], views });
  const fromReceipt = withSimulatedViews(await observeExecuted(reader, recorded.transactionHash, tx, [], views), simulated, views);
  const judged = (observation: Observation): EffectVerdict => {
    assert.equal(observation.kind, 'observed', observation.kind === 'unverifiable' ? observation.reasons.join('; ') : '');
    return judgeEffects((observation as Extract<Observation, { kind: 'observed' }>).observed, resolved(tx, card), used, registry);
  };
  return { simulated: judged(simulated), executed: judged(fromReceipt) };
}

test("the recorded supply gives USDC, raises the Safe's supply shares, and matches the card, simulated and from its receipt", async () => {
  assert.deepEqual(await recordedVerdicts('morpho-market-supply', supply(CASES[0].amount)), { simulated: { kind: 'match' }, executed: { kind: 'match' } });
});

test('the recorded supply does not match a card for a larger amount', async () => {
  const verdicts = await recordedVerdicts('morpho-market-supply', supply(`${BigInt(CASES[0].amount) + 1n}`));
  assert.deepEqual([verdicts.simulated.kind, verdicts.executed.kind], ['mismatch', 'mismatch']);
});

test('a template view that writes state, USDC approve, is read by STATICCALL in the simulated block and is unverifiable, never a match', async () => {
  const { simulated, executed } = await recordedVerdicts('morpho-market-supply-writing-view', supply(CASES[0].amount));
  const refused = `usdc ${USDC} approve(${registry.entries.get('blue-bundles-v1')!.address}, 1) could not be read before the transaction in a simulated block: it reverted in the simulated block, read by STATICCALL, where writing state or emitting a log reverts`;
  assert.deepEqual(simulated, { kind: 'unverifiable', reasons: [refused] });
  assert.equal(executed.kind, 'unverifiable');
  assert.ok(executed.kind === 'unverifiable' && executed.reasons.includes(refused));
});
