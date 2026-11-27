import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadRecordedTx } from '../src/template/recorded-tx.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { liveRepo } from './repo-with-test-fixtures.ts';

const ID = 'cow/swap';
const ROOT = liveRepo();
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>([[ID, loadTemplate(ROOT, ID, registry)]]);

/** Each test transaction, other Safes' CoW Swap Safe app orders, with the card `pnpm template implied-card` prints for it. */
const CASES = [
  { name: 'cow-swap-usdc', sell: 'usdc', buy: 'usdt', sellAmount: '15000000000', minBuy: '15013362936' },
  { name: 'cow-swap-usdt', sell: 'usdt', buy: 'usdc', sellAmount: '3000000000', minBuy: '2994786659' },
] as const;

const swap = (sell: string, buy: string, sellAmount: string, minBuy: string): Card => ({
  operations: [{ template: ID, values: { 'sell-token': sell, 'buy-token': buy, 'sell-amount': sellAmount, 'min-buy': minBuy } }],
});

for (const c of CASES) {
  const recorded = loadRecordedTx(ROOT, c.name);
  const { tx } = recorded;
  const messages = [readFileSync(join(ROOT, 'testdata', 'messages', `${c.name}.json`), 'utf8')];
  const chain = { blockTime: { kind: 'read', ...recorded.executed } as const };
  const resolved = (card: Card): ResolvedCard => {
    const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
    assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
    return (result as Extract<typeof result, { kind: 'resolved' }>).card;
  };
  const check = (card: Card, given = messages): FieldCheck => checkTemplateFields(tx, resolved(card), templates, registry, given, chain);
  const card = swap(c.sell, c.buy, c.sellAmount, c.minBuy);

  test(`${c.name}: the order read by its digest matches ${ID} with the card it implies`, () => {
    assert.deepEqual(check(card), { kind: 'match' });
  });

  test(`${c.name}: every bound field, order members included, changed alone, gives a mismatch`, () => {
    const result = checkMutations(tx, resolved(card), templates, registry, messages, chain);
    assert.equal(result.kind, 'pass', JSON.stringify(result));
  });

  test(`${c.name}: a minimum above the order's buy amount is a mismatch; the sold amount and tokens are bound`, () => {
    assert.equal(check(swap(c.sell, c.buy, c.sellAmount, `${BigInt(c.minBuy) + 1n}`)).kind, 'mismatch');
    assert.equal(check(swap(c.sell, c.buy, `${BigInt(c.sellAmount) + 1n}`, c.minBuy)).kind, 'mismatch');
    assert.equal(check(swap(c.buy, c.sell, c.sellAmount, c.minBuy)).kind, 'mismatch');
  });

  test(`${c.name}: with no order given the field check is UNVERIFIABLE`, () => {
    assert.equal(check(card, []).kind, 'unverifiable');
  });
}
