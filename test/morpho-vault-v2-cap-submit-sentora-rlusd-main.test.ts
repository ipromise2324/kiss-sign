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

const ID = 'morpho/vault-v2-cap-submit';
const ROOT = liveRepo();
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>([[ID, loadTemplate(ROOT, ID, registry)]]);
const VAULT = 'sentora-rlusd-main-v2-e6bf';
const MARKET = 'rlusd-kbtc-86';
const CAP = '265000000000000000000000000';

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const submit = (market: string, cap: string): Card => ({
  operations: [{ template: ID, values: { vault: VAULT, market, 'absolute-cap': cap } }],
});

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);

for (const name of ['sentora-rlusd-main-cap-submit-kbtc-284', 'sentora-rlusd-main-cap-submit-kbtc-273']) {
  const tx = safeTx(name);

  test(`${name} matches ${ID} with the card it implies`, () => {
    assert.deepEqual(check(tx, submit(MARKET, CAP)), { kind: 'match' });
  });

  test(`${name}: every bound field, changed alone, gives a mismatch`, () => {
    const result = checkMutations(tx, resolved(tx, submit(MARKET, CAP)), templates, registry);
    assert.equal(result.kind, 'pass');
  });

  test(`${name}: a card with another cap is a mismatch`, () => {
    assert.equal(check(tx, submit(MARKET, `${BigInt(CAP) + 1n}`)).kind, 'mismatch');
  });
}

test(`a card naming a USDC market is refused for the RLUSD vault`, () => {
  const tx = safeTx('sentora-rlusd-main-cap-submit-kbtc-284');
  const result = resolveCard(submit('usdc-cbbtc-86', CAP), { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'refused');
});
