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
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';

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

type Fixture = { executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };
const recorded: Fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'simulate', 'morpho-market-supply.json'), 'utf8'));

async function simulatedVerdict(card: Card): Promise<EffectVerdict> {
  const tx = safeTx(CASES[0].name);
  const reader = replayReader(recorded.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(recorded.parent), await header(recorded.executed)];
  const views = viewCalls(resolved(tx, supply(CASES[0].amount)), templates, registry);
  const observation = await simulateSafeTx(reader, { tx, parent, time: executed.time, watch: [USDC], ends: [], views });
  assert.equal(observation.kind, 'observed', observation.kind === 'unverifiable' ? observation.reasons.join('; ') : '');
  return judgeEffects((observation as Extract<typeof observation, { kind: 'observed' }>).observed, resolved(tx, card), templates, registry);
}

test('the recorded simulation gives USDC, raises the Safe\'s supply shares, and matches the card', async () => {
  assert.deepEqual(await simulatedVerdict(supply(CASES[0].amount)), { kind: 'match' });
});

test('the recorded simulation does not match a card for a larger amount', async () => {
  const verdict = await simulatedVerdict(supply(`${BigInt(CASES[0].amount) + 1n}`));
  assert.equal(verdict.kind, 'mismatch');
});
