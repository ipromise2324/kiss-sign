import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const ID = 'uniswap/swap';
const registry = loadRegistry(ROOT);
const templates = new Map([[ID, loadTemplate(ROOT, ID, registry)]]);

/** Each test transaction of another Safe, with the card `pnpm template implied-card` printed for it. */
const CASES = [
  { name: 'uniswap-swap-usdc-usdt', values: { 'sell-token': 'usdc', 'buy-token': 'usdt', 'sell-amount': '20000000000', 'min-buy': '19923502689' } },
];

function load(name: string): { tx: SafeTx; blockTime: { kind: 'read'; number: bigint; time: bigint } } {
  const { service, chain } = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  const tx = parseServiceTx(service, { chainId: 1n, version: chain.version });
  return { tx, blockTime: { kind: 'read', number: BigInt(service.blockNumber), time: BigInt(Date.parse(service.executionDate) / 1000) } };
}

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

for (const { name, values } of CASES) {
  const { tx, blockTime } = load(name);
  const card = (changes: Record<string, string> = {}): Card => ({ operations: [{ template: ID, values: { ...values, ...changes } }] });
  const check = (c: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, c), templates, registry, [], { blockTime });

  test(`${name} matches ${ID} with the card it implies`, () => {
    assert.deepEqual(check(card()), { kind: 'match' });
  });

  test(`${name} is a mismatch when the card asks one more unit than the swap's minimum`, () => {
    assert.equal(check(card({ 'min-buy': `${BigInt(values['min-buy']) + 1n}` })).kind, 'mismatch');
  });

  test(`${name} is a mismatch when the card sells another amount or swaps the tokens`, () => {
    assert.equal(check(card({ 'sell-amount': `${BigInt(values['sell-amount']) + 1n}` })).kind, 'mismatch');
    assert.equal(check(card({ 'sell-token': values['buy-token'], 'buy-token': values['sell-token'] })).kind, 'mismatch');
  });

  test(`every bound field of ${name}, changed alone, gives a mismatch`, () => {
    const result = checkMutations(tx, resolved(tx, card()), templates, registry, [], { blockTime });
    assert.deepEqual(result, { kind: 'pass', bound: 21, free: 2 });
  });
}
