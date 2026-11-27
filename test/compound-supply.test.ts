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
import type { Template } from '../src/template/template.ts';
import { liveRepo } from './repo-with-test-fixtures.ts';

const ID = 'compound/supply';
const MARKET = 'compound-v3-cusdcv3';
const ROOT = liveRepo();
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>([[ID, loadTemplate(ROOT, ID, registry)]]);

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const supply = (amount: string): Card => ({ operations: [{ template: ID, values: { market: MARKET, amount } }] });

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);
const mismatchedArgs = (result: FieldCheck) => (result.kind === 'mismatch' ? result.findings.map((f) => f.arg) : result);

const CASES = [
  { name: 'compound-supply-usdc', amount: '1050000000000' },
  { name: 'compound-supply-usdc-other-safe', amount: '4500000000000' },
] as const;

for (const c of CASES) {
  const tx = safeTx(c.name);
  const card = supply(c.amount);

  test(`${c.name} matches compound/supply with the card it implies`, () => {
    assert.deepEqual(check(tx, card), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, card), templates, registry), { kind: 'pass', bound: 8, free: 0 });
  });

  test(`${c.name}: a card with another amount is a mismatch at the approval and the supply`, () => {
    assert.deepEqual(mismatchedArgs(check(tx, supply(`${BigInt(c.amount) + 1n}`))), ['value', 'amount']);
  });
}
