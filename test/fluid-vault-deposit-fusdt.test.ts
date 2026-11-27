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
const registry = loadRegistry(ROOT);
const templates = new Map([['fluid/vault-deposit', loadTemplate(ROOT, 'fluid/vault-deposit', registry)]]);

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

// min-shares is held by the effects check alone, never by the calldata, so any value leaves the fields unchanged.
const deposit = (vault: string, amount: string): Card => ({
  operations: [{ template: 'fluid/vault-deposit', values: { vault, amount, 'min-shares': '1' } }],
});

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);
const mismatchedArgs = (result: FieldCheck) => (result.kind === 'mismatch' ? result.findings.map((f) => f.arg) : result);

const VAULT = 'fluid-fusdt';
const CASES = [
  { name: 'fluid-deposit-usdt', amount: '811406247' },
  { name: 'fluid-deposit-usdt-other-safe', amount: '95464729724' },
] as const;

for (const c of CASES) {
  const tx = safeTx(c.name);
  const card = deposit(VAULT, c.amount);

  test(`${c.name} matches fluid/vault-deposit on fluid-fusdt with the card it implies`, () => {
    assert.deepEqual(check(tx, card), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, card), templates, registry), { kind: 'pass', bound: 8, free: 0 });
  });

  test(`${c.name}: a card with another amount is a mismatch wherever the amount is bound`, () => {
    assert.deepEqual(mismatchedArgs(check(tx, deposit(VAULT, `${BigInt(c.amount) + 1n}`))), ['value', 'assets_']);
  });

  test(`${c.name}: a card naming fUSDC is a mismatch at the token approved, the spender and the vault called`, () => {
    assert.deepEqual(mismatchedArgs(check(tx, deposit('fluid-fusdc', c.amount))), ['to', 'spender', 'to']);
  });
}
