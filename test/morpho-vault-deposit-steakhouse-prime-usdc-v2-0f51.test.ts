import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import type { SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldChain, FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadRecordedTx } from '../src/template/recorded-tx.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { liveRepo } from './repo-with-test-fixtures.ts';

const ID = 'morpho/vault-deposit';
const VAULT = 'steakhouse-prime-usdc-v2-0f51';
const ROOT = liveRepo();
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>([[ID, loadTemplate(ROOT, ID, registry)]]);

// Each card is the one `pnpm template implied-card` prints for the fixture.
const FIXTURES: Record<string, { amount: string; minShares: string }> = {
  'morpho-deposit-steakhouse-prime': { amount: '2300000000000', minShares: '2210831949963416019873263' },
  'morpho-deposit-steakhouse-prime-other-safe': { amount: '10000000000', minShares: '9609712613964437589511' },
  'morpho-deposit-steakhouse-prime-third-safe': { amount: '1573032793893', minShares: '1516197485933066798804727' },
};

const cardOf = (amount: string, minShares: string): Card => ({
  operations: [{ template: ID, values: { vault: VAULT, amount, 'min-shares': minShares } }],
});

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

function mismatchAt(result: FieldCheck): string[] {
  assert.equal(result.kind, 'mismatch', JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v)));
  return (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => `${f.callPath}.${f.arg}`);
}

for (const [name, { amount, minShares }] of Object.entries(FIXTURES)) {
  const recorded = loadRecordedTx(ROOT, name);
  const { tx } = recorded;
  const chain: FieldChain = { blockTime: { kind: 'read', ...recorded.executed } };
  const check = (card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry, [], chain);

  test(`${name} matches ${ID} for ${VAULT} with the card it implies`, () => {
    assert.deepEqual(check(cardOf(amount, minShares)), { kind: 'match' });
  });

  test(`${name}: every bound field, changed alone, gives a mismatch`, () => {
    const result = checkMutations(tx, resolved(tx, cardOf(amount, minShares)), templates, registry, [], chain);
    assert.equal(result.kind, 'pass', JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v)));
  });

  test(`${name}: one more share than the price bound guarantees is a mismatch at maxSharePriceE27`, () => {
    assert.deepEqual(mismatchAt(check(cardOf(amount, `${BigInt(minShares) + 1n}`))), ['multiSend[1].vaultBundlesV1Deposit.maxSharePriceE27']);
  });

  test(`${name}: another amount is a mismatch at the approval and the deposit`, () => {
    assert.deepEqual(mismatchAt(check(cardOf(`${BigInt(amount) + 1n}`, minShares))).sort(), [
      'multiSend[0].approve.value',
      'multiSend[1].vaultBundlesV1Deposit.assets',
    ]);
  });
}
