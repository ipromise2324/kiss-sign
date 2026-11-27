import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import { parseRegistry } from '../src/registry.ts';
import type { Address } from '../src/safe/types.ts';
import { TemplateError, calledProtocols, parseTemplate, scopeEntries } from '../src/template/template.ts';

const registry = parseRegistry({
  usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', kind: 'token', source: 'https://developers.circle.com/stablecoins/usdc-contract-addresses', defillama: 'circle-usdc' },
  'vault-v2-factory': {
    address: '0xA1D94F746dEfa1928926b84fB2596c06926C0405',
    kind: 'factory',
    source: 'https://docs.morpho.org/developers/contracts/addresses/',
    defillama: 'morpho-blue',
    instanceCheck: 'isVaultV2(address)',
  },
  'steakhouse-prime-usdc-v2-0f51': {
    address: '0xbeef088055857739C12CD3765F20b7679Def0f51',
    kind: 'vault',
    source: 'https://www.steakhouse.financial/docs/products/vault-products/current/prime-instant',
    defillama: 'steakhouse-financial',
    attributes: { asset: 'usdc', factory: 'vault-v2-factory' },
  },
  'fluid-fusdc': {
    address: '0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33',
    kind: 'vault',
    source: 'https://github.com/Instadapp/fluid-contracts-public/blob/404d73f91e6806f881f8dabeb30494f93f9e99b7/deployments/deployments.md',
    defillama: 'fluid-lending',
    attributes: { asset: 'usdc' },
  },
});

const scoped = (slug: string) =>
  parseTemplate(
    {
      id: 'scope/vault-deposit',
      card: { vault: { kind: 'contract', registryKind: 'vault', defillama: slug }, amount: { kind: 'amount', of: 'vault.asset' } },
      calls: [{ to: { card: 'vault' }, value: { const: '0' }, function: 'deposit(uint256 assets, address receiver)', args: { assets: { card: 'amount' }, receiver: { safe: true } } }],
      effects: { gives: [{ token: 'card.vault.asset', amount: 'card.amount' }], gets: [{ token: 'card.vault', amount: 'positive' }] },
    },
    registry,
    'committed',
  );

function resolve(slug: string, vault: string) {
  const template = scoped(slug);
  const context = { templates: new Map([[template.id, template]]), registry, addressBook: new Map(), safe: '0x1111111111111111111111111111111111111111' as Address };
  const result = resolveCard({ operations: [{ template: template.id, values: { vault, amount: '1' } }] }, context);
  return result.kind === 'refused' ? { reason: result.reason, detail: result.detail } : result.kind;
}

test('a vault with a factory belongs to its factory\'s protocol, not to the curator its own slug names', () => {
  assert.equal(resolve('morpho-blue', 'steakhouse-prime-usdc-v2-0f51'), 'resolved');
  assert.deepEqual(scopeEntries({ registryKind: 'vault', protocol: 'morpho-blue', marketPart: undefined, names: undefined }, registry).map((e) => e.name), ['steakhouse-prime-usdc-v2-0f51']);
  assert.deepEqual(resolve('fluid-lending', 'steakhouse-prime-usdc-v2-0f51'), {
    reason: 'wrong-protocol',
    detail: 'steakhouse-prime-usdc-v2-0f51 is a vault of morpho-blue (its factory vault-v2-factory), not of fluid-lending',
  });
});

test('a vault with no factory belongs to the protocol its own slug names', () => {
  assert.equal(resolve('fluid-lending', 'fluid-fusdc'), 'resolved');
  assert.deepEqual(resolve('morpho-blue', 'fluid-fusdc'), { reason: 'wrong-protocol', detail: 'fluid-fusdc is a vault of fluid-lending, not of morpho-blue' });
});

test('template load counts a slug carried only through a factory, and not a vault\'s own slug behind a factory', () => {
  assert.doesNotThrow(() => scoped('morpho-blue'));
  assert.throws(
    () => scoped('steakhouse-financial'),
    (e: unknown) => e instanceof TemplateError && e.message === 'card.vault.defillama: no registry vault belongs to the DefiLlama protocol "steakhouse-financial"',
  );
});

test("a vault called directly is grouped under its factory's protocol, a vault with no factory under its own", () => {
  const called = (slug: string) => [...calledProtocols(scoped(slug), registry)].map(([protocol, entries]) => [protocol, entries.map((e) => e.name)]);
  assert.deepEqual(called('morpho-blue'), [['morpho-blue', ['steakhouse-prime-usdc-v2-0f51']]]);
  assert.deepEqual(called('fluid-lending'), [['fluid-lending', ['fluid-fusdc']]]);
});
