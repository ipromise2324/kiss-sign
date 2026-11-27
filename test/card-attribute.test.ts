import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import { parseRegistry } from '../src/registry.ts';
import type { Address } from '../src/safe/types.ts';
import { parseTemplate } from '../src/template/template.ts';

const SOURCE = 'https://docs.morpho.org/get-started/resources/addresses';
const registry = parseRegistry({
  usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', kind: 'token', source: SOURCE },
  'vault-with-asset': { address: `0x${'0a'.repeat(20)}`, kind: 'vault', source: SOURCE, attributes: { asset: 'usdc' } },
  'vault-without-asset': { address: `0x${'0b'.repeat(20)}`, kind: 'vault', source: SOURCE },
});
const template = parseTemplate(
  {
    id: 'x/approve-vault',
    card: { vault: { kind: 'contract', registryKind: 'vault' }, amount: { kind: 'amount', of: 'vault.asset' } },
    calls: [{ to: { card: 'vault.asset' }, value: { const: '0' }, function: 'approve(address spender, uint256 value)', args: { spender: { card: 'vault' }, value: { card: 'amount' } } }],
    effects: { gives: [], gets: [] },
  },
  registry,
  'committed',
);
const resolve = (vault: string) =>
  resolveCard({ operations: [{ template: template.id, values: { vault, amount: '1' } }] }, { templates: new Map([[template.id, template]]), registry, addressBook: new Map(), safe: `0x${'11'.repeat(20)}` as Address });

test('a card naming an entry that lacks an attribute its template reads is refused, naming the attribute and the template', () => {
  assert.equal(resolve('vault-with-asset').kind, 'resolved');
  assert.deepEqual(resolve('vault-without-asset'), {
    kind: 'refused',
    reason: 'missing-attribute',
    at: 'operations[0].values.vault',
    field: 'vault',
    detail: 'the registry has no asset for vault-without-asset, which x/approve-vault reads as vault.asset',
  });
});
