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
const templates = new Map([['morpho/vault-deposit', loadTemplate(ROOT, 'morpho/vault-deposit', registry)]]);

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const deposit = (vault: string, amount: string): Card => ({ operations: [{ template: 'morpho/vault-deposit', values: { vault, amount } }] });

const CASES = [
  { name: 'morpho-deposit-metamorpho-1-0', vault: 'smokehouse-usdc', amount: '1464958248813' },
  { name: 'morpho-deposit-metamorpho-1-0-other-safe', vault: 'smokehouse-usdc', amount: '200000000000' },
  { name: 'morpho-deposit-approve-trailer', vault: 'hyperithm-usdc-apex-7777', amount: '20000000000' },
  { name: 'morpho-deposit-approve-trailer-other-safe', vault: 'hyperithm-usdc-apex-7777', amount: '10001000000' },
] as const;

const check = (tx: SafeTx, card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);

for (const c of CASES) {
  const tx = safeTx(c.name);
  const card = deposit(c.vault, c.amount);

  test(`${c.name} matches morpho/vault-deposit with the card it implies`, () => {
    assert.deepEqual(check(tx, card), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, card), templates, registry), { kind: 'pass', bound: 20, free: 1 });
  });
}
