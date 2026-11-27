import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import type { SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { loadRecordedTx } from '../src/template/recorded-tx.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { liveRepo } from './repo-with-test-fixtures.ts';

// No Safe deposited into this vault through VaultBundlesV1 in the year studied, and the template's two calls
// cannot come from an EOA, so these tests take other Safes' deposits into another vault of the template and
// require that a card naming this vault refuses them at the vault.

const ID = 'morpho/vault-deposit';
const VAULT = 'hyperithm-usdc-apex-v2-9e2f';
const ROOT = liveRepo();
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>([[ID, loadTemplate(ROOT, ID, registry)]]);

const FIXTURES = [
  { name: 'morpho-deposit-steakhouse-prime', amount: '2300000000000', minShares: '2210831949963416019873263' },
  { name: 'morpho-deposit-steakhouse-prime-other-safe', amount: '10000000000', minShares: '9609712613964437589511' },
];

const card = (vault: string, amount: string, minShares: string): Card => ({
  operations: [{ template: ID, values: { vault, amount, 'min-shares': minShares } }],
});

function resolved(tx: SafeTx, c: Card): ResolvedCard {
  const result = resolveCard(c, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const findings = (result: FieldCheck): string[] => {
  assert.equal(result.kind, 'mismatch', JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v)));
  return (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => `${f.callPath}.${f.arg}`);
};

test(`the registry admits ${VAULT} with its market adapter`, () => {
  assert.equal(registry.entries.get(VAULT)!.address, '0x093272c07700d3ca5301c3bf9b3a392624179e2f');
  assert.equal(registry.entries.get(`${VAULT}-market-adapter`)!.address, '0x92872b97d89b54646d036e3afd2bccb84d8e3ca1');
});

for (const { name, amount, minShares } of FIXTURES) {
  const recorded = loadRecordedTx(ROOT, name);
  const { tx } = recorded;
  const blockTime = { kind: 'read', ...recorded.executed } as const;

  test(`${name} matches ${ID} with the card naming its own vault`, () => {
    const result = checkTemplateFields(tx, resolved(tx, card('steakhouse-prime-usdc-v2-0f51', amount, minShares)), templates, registry, [], { blockTime });
    assert.deepEqual(result, { kind: 'match' });
  });

  test(`${name}: a card naming ${VAULT} is a mismatch at the vault`, () => {
    const result = checkTemplateFields(tx, resolved(tx, card(VAULT, amount, minShares)), templates, registry, [], { blockTime });
    assert.ok(findings(result).some((at) => at.endsWith('.vault')), JSON.stringify(findings(result)));
  });
}
