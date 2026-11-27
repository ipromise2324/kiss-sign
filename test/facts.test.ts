import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadRegistry } from '../src/registry.ts';
import { TemplateError, parseTemplate } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const registry = loadRegistry(ROOT);
const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'morpho', 'market-supply', 'template.json'), 'utf8'));
const MARKET = 'market(bytes32 id) returns (uint128 totalSupplyAssets, uint128, uint128 totalBorrowAssets, uint128, uint128, uint128)';
const LOAN = 'card.market.loanToken';
const fact = {
  to: { contract: 'morpho-blue' },
  function: MARKET,
  args: { id: { card: 'market.id' } },
  units: { totalSupplyAssets: LOAN, totalBorrowAssets: LOAN },
  ratio: ['totalBorrowAssets', 'totalSupplyAssets'],
  reason: 'Morpho Blue computes utilization as totalBorrowAssets / totalSupplyAssets in its IRM',
};
const parse = (change: Record<string, unknown>, card: Record<string, unknown> = raw.card) => parseTemplate({ ...raw, card, facts: [{ ...fact, ...change }] }, registry, 'committed');
const refused = (change: Record<string, unknown>, message: string, card?: Record<string, unknown>) =>
  assert.throws(() => parse(change, card), (e: unknown) => e instanceof TemplateError && e.message === message, message);

test('a fact is read for the one card field its arguments name, counts each named value in a token, and may name a ratio', () => {
  const [parsed] = parse({}).facts;
  assert.equal(parsed?.field, 'market');
  assert.equal(parsed?.to, 'morpho-blue');
  assert.deepEqual(parsed?.units, [
    { value: 0, unit: { field: 'market', attribute: 'loanToken' } },
    { value: 2, unit: { field: 'market', attribute: 'loanToken' } },
  ]);
  assert.deepEqual(parsed?.ratio, [2, 0]);
  const { facts, ...bare } = raw;
  assert.deepEqual(parseTemplate(bare, registry, 'committed').facts, []);
  const { ratio, reason, ...plain } = fact;
  assert.equal(parseTemplate({ ...raw, facts: [plain] }, registry, 'committed').facts[0]?.ratio, undefined);
});

test('a fact is refused for each broken rule, by its message', () => {
  refused({ to: { card: 'market.lending' } }, 'facts[0].to: must name a registry contract');
  refused({ extra: 1 }, 'facts[0].extra: unexpected field');
  refused(
    { to: { contract: 'usdc' }, function: 'f(bytes32 id) returns (uint128 totalSupplyAssets, uint128 totalBorrowAssets)' },
    'facts[0].to: usdc is not a contract of a DefiLlama protocol a call targets (morpho-blue), so the report would show the fact under no protocol',
  );
  refused({ function: 'position(bytes32 id, address user) returns (uint256 supplyShares)', args: { id: { card: 'market.id' }, user: { safe: true } }, units: { supplyShares: LOAN }, ratio: undefined, reason: undefined }, "facts[0].args: a fact never reads the Safe's state");
  refused({ args: { id: { const: `0x${'00'.repeat(32)}` } } }, 'facts[0].args: must name exactly one card field, not 0');
  refused({ function: 'f(bytes32 id, uint256 x) returns (uint128 totalSupplyAssets, uint128 totalBorrowAssets)', args: { id: { card: 'market.id' }, x: { card: 'amount' } } }, 'facts[0].args: must name exactly one card field, not 2');
  refused({ function: 'f(uint256 x) returns (uint128 totalSupplyAssets, uint128 totalBorrowAssets)', args: { x: { card: 'amount' } }, units: { totalSupplyAssets: 'eth', totalBorrowAssets: 'eth' } }, 'facts[0].args: card field amount is not a contract or a market field');
  refused({ units: { totalSupplyAssets: LOAN, totalBorrowAssets: LOAN, fee: LOAN } }, 'facts[0].units.fee: not a named return value of market');
  refused({ function: 'f(bytes32 id) returns (address loanToken)', units: { loanToken: LOAN }, ratio: undefined, reason: undefined }, 'facts[0].units.loanToken: address is not a number; only a number is counted in a token');
  refused({ units: { totalSupplyAssets: 'usdc', totalBorrowAssets: LOAN } }, 'facts[0].units.totalSupplyAssets: must be eth or card.<field>');
  refused({ units: { totalSupplyAssets: 'card.amount', totalBorrowAssets: LOAN } }, 'facts[0].units.totalSupplyAssets: must name a token');
  refused({ units: { totalSupplyAssets: 'card.token', totalBorrowAssets: LOAN } }, 'facts[0].units.totalSupplyAssets: must be a token of card field market, which the fact reads for', { ...raw.card, token: { kind: 'contract', registryKind: 'token', names: ['usdc'] } });
  refused({ units: { totalSupplyAssets: LOAN } }, 'facts[0].units: names no unit for totalBorrowAssets; leave a return value unnamed to leave it unshown');
  refused({ ratio: ['totalBorrowAssets'] }, 'facts[0].ratio: must name two different named return values');
  refused({ ratio: ['totalBorrowAssets', 'totalBorrowAssets'] }, 'facts[0].ratio: must name two different named return values');
  refused({ ratio: ['totalBorrowAssets', 'fee'] }, 'facts[0].ratio: must name two different named return values');
  refused({ units: { totalSupplyAssets: LOAN, totalBorrowAssets: 'eth' } }, 'facts[0].ratio: names two values counted in different tokens');
  refused({ reason: undefined }, 'facts[0].reason: missing: say where the protocol defines the ratio');
  refused({ ratio: undefined }, 'facts[0].reason: explains a ratio the fact does not name');
});
