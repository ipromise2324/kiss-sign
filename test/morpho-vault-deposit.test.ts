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
import { repoWithBundler3Deposit } from './bundler3-deposit.ts';

const ROOT = repoWithBundler3Deposit();
const registry = loadRegistry(ROOT);
const templates = new Map([['morpho/vault-deposit', loadTemplate(ROOT, 'morpho/vault-deposit', registry)]]);

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const deposit = (vault: string, amount: string, minShares: string): Card => ({
  operations: [{ template: 'morpho/vault-deposit', values: { vault, amount, 'min-shares': minShares } }],
});

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);
const mismatchedArgs = (result: FieldCheck) => (result.kind === 'mismatch' ? result.findings.map((f) => f.arg) : result);

const VAULT = 'hyperithm-usdc-apex-v2-9e2f';
const CASES = [
  { name: 'morpho-vault-deposit-v2', amount: '1000611448606', minShares: '973551731159989631767877' },
  { name: 'morpho-vault-deposit-v2-other-safe', amount: '200060208382', minShares: '196232498267776029465926' },
] as const;

for (const c of CASES) {
  const tx = safeTx(c.name);
  const card = deposit(VAULT, c.amount, c.minShares);

  test(`${c.name} matches morpho/vault-deposit with the card it implies`, () => {
    assert.deepEqual(check(tx, card), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, card), templates, registry), { kind: 'pass', bound: 21, free: 0 });
  });

  test(`${c.name}: a card with another amount is a mismatch wherever the amount is bound`, () => {
    assert.deepEqual(mismatchedArgs(check(tx, deposit(VAULT, `${BigInt(c.amount) + 1n}`, c.minShares))), ['value', 'amount', 'assets']);
  });

  test(`${c.name}: a card asking for more shares than the transaction's price bound gives is a mismatch at the price bound`, () => {
    assert.deepEqual(mismatchedArgs(check(tx, deposit(VAULT, c.amount, `${BigInt(c.minShares) + 1n}`))), ['maxSharePriceE27']);
  });

  test(`${c.name}: a card naming the V1 vault of the same name is a mismatch at the vault`, () => {
    assert.deepEqual(mismatchedArgs(check(tx, deposit('hyperithm-usdc-apex-v1-7777', c.amount, c.minShares))), ['vault']);
  });
}
