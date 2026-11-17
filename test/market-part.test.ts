import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Address } from '../src/safe/types.ts';
import { TemplateError, loadTemplate, parseTemplate, scopeEntries } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, 'morpho/vault-v2-collateral-cap-submit', registry);
const collateral = template.card.get('collateral');

function resolve(token: string) {
  const context = { templates: new Map([[template.id, template]]), registry, addressBook: new Map(), safe: '0x1111111111111111111111111111111111111111' as Address };
  const values = { vault: 'kpk-usdc-prime-v2-9ee6', collateral: token, 'absolute-cap': '1', 'relative-cap': '1' };
  const result = resolveCard({ operations: [{ template: template.id, values }] }, context);
  return result.kind === 'refused' ? { reason: result.reason, at: result.at, detail: result.detail } : result.kind;
}

test("a collateral field lists only the tokens a market of registry/markets.json takes as collateral", () => {
  assert.equal(collateral?.kind, 'contract');
  if (collateral?.kind !== 'contract') return;
  const collaterals = new Set([...registry.markets.values()].map((market) => market.collateralToken.name));
  assert.deepEqual(scopeEntries(collateral.scope, registry).map((e) => e.name).sort(), [...collaterals].sort());
  assert.ok(!collaterals.has('usdc') && !collaterals.has('morpho'));
});

test('card seal and verify refuse a token no market takes as collateral, naming the field and the part', () => {
  assert.equal(resolve('weeth'), 'resolved');
  assert.deepEqual(resolve('morpho'), { reason: 'not-in-markets', at: 'operations[0].values.collateral', detail: 'morpho is not the collateralToken of any market in registry/markets.json' });
  assert.deepEqual(resolve('usdc'), { reason: 'not-in-markets', at: 'operations[0].values.collateral', detail: 'usdc is not the collateralToken of any market in registry/markets.json' });
});

test('template load refuses a market part that is not one, is of another kind, or that no registry entry fills', () => {
  const load = (field: Record<string, unknown>) =>
    parseTemplate(
      {
        id: 'scope/transfer',
        card: { token: { kind: 'contract', ...field }, amount: { kind: 'amount', of: 'token' } },
        calls: [{ to: { card: 'token' }, value: { const: '0' }, function: 'transfer(address to, uint256 amount)', args: { to: { safe: true }, amount: { card: 'amount' } } }],
        effects: { gives: [], gets: [] },
      },
      registry,
    );
  const refused = (field: Record<string, unknown>, message: string) => assert.throws(() => load(field), (e: unknown) => e instanceof TemplateError && e.message === message);
  refused({ registryKind: 'token', marketPart: 'lltv' }, 'card.token.marketPart: not one of lending, loanToken, collateralToken, oracle, irm');
  refused({ registryKind: 'token', marketPart: 'oracle' }, "card.token.marketPart: a market's oracle is of kind oracle, not token");
  refused({ registryKind: 'token', marketPart: 'collateralToken', defillama: 'circle-usdc' }, 'card.token.marketPart: no registry token this field accepts is the collateralToken of a market in registry/markets.json');
});
