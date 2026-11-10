import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { TemplateError, loadTemplate, parseTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const ALL = 'morpho/vault-migrate-all';
const templates = new Map([ALL].map((id) => [id, loadTemplate(ROOT, id, registry)]));
const SAFE = '0x1111111111111111111111111111111111111111' as Address;

const refusal = (card: Card) => {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: SAFE });
  return result.kind === 'refused' ? `${result.reason} at ${result.at}: ${result.detail}` : result.kind;
};

test('a migration between two vaults of one asset resolves, and between vaults of different assets is refused', () => {
  assert.equal(refusal({ operations: [{ template: ALL, values: { from: 'hyperithm-usdc-apex-7777', to: 'steakhouse-prime-usdc' } }] }), 'resolved');
  assert.equal(
    refusal({ operations: [{ template: ALL, values: { from: 'hyperithm-usdc-apex-7777', to: 'fluid-fusdt' } }] }),
    'not-the-same at operations[0]: morpho/vault-migrate-all needs one address for from.asset usdc and to.asset usdt',
  );
});

test('a template whose same list names fewer than two references fails to load', () => {
  const raw = { id: 'x/y', card: { from: { kind: 'contract', registryKind: 'vault' } }, same: ['from.asset'], calls: [{ to: { card: 'from' }, value: { const: '0' }, data: 'empty' }], effects: { gives: [], gets: [] } };
  assert.throws(() => parseTemplate(raw, registry), (error: unknown) => error instanceof TemplateError && /same: names fewer than two/.test(error.message));
});

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const MIGRATE: Card = { operations: [{ template: ALL, values: { from: 'smokehouse-usdc', to: 'steakhouse-high-yield-usdc' } }] };

function resolvedFor(tx: SafeTx, card: Card) {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

for (const name of ['morpho-migrate-all-smokehouse', 'morpho-migrate-all-smokehouse-other-safe']) {
  const tx = safeTx(name);

  test(`${name} matches ${ALL} with the card it implies`, () => {
    assert.deepEqual(checkTemplateFields(tx, resolvedFor(tx, MIGRATE), templates, registry), { kind: 'match' });
  });

  test(`${name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolvedFor(tx, MIGRATE), templates, registry), { kind: 'pass', bound: 26, free: 4 });
  });
}

test('a migration whose new shares go to someone else is a mismatch at the deposit receiver', () => {
  const tx = safeTx('morpho-migrate-all-smokehouse');
  const safe = tx.safe.slice(2).toLowerCase();
  assert.equal(tx.data.split(safe).length, 2, 'the Safe occurs once in the data');
  const other = { ...tx, data: tx.data.replace(safe, '1'.repeat(40)) as Hex };
  const result = checkTemplateFields(other, resolvedFor(tx, MIGRATE), templates, registry);
  assert.deepEqual(result.kind === 'mismatch' ? result.findings.map((f) => `${f.callPath}.${f.arg}`) : result, [
    'multiSend[1].multicall.bundle[2].data.erc4626Deposit.receiver',
  ]);
});
