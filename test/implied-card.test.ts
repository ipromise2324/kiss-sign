import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card } from '../src/card.ts';
import { parseRegistry } from '../src/registry.ts';
import { impliedCard } from '../src/research/implied-card.ts';
import { leafValue, loosen } from '../src/research/study.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields, inspectTemplateFields } from '../src/template/check.ts';
import { parseTemplate } from '../src/template/template.ts';

const SOURCE = 'https://www.circle.com/usdc';
const registry = parseRegistry({
  usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', kind: 'token', source: SOURCE },
});
const SAFE = `0x${'11'.repeat(20)}` as Address;
const ZERO = `0x${'00'.repeat(20)}` as Address;

/** A one-call template to the card's token whose arguments `a`, `b`, `c` and `d` take the rules given, over the card amounts named in `card`. */
function templateOf(card: readonly string[], args: Record<string, unknown>) {
  return parseTemplate(
    {
      id: 'x/bounds',
      card: { token: { kind: 'contract', registryKind: 'token', names: ['usdc'] }, ...Object.fromEntries(card.map((name) => [name, { kind: 'amount', of: 'token' }])) },
      calls: [{ to: { card: 'token' }, value: { const: '0' }, function: 'f(uint256 a, uint256 b, uint256 c, uint256 d)', args }],
      effects: { gives: [], gets: [] },
    },
    registry,
    'committed',
  );
}

const word = (n: bigint): string => n.toString(16).padStart(64, '0');
const txOf = (args: readonly bigint[]): SafeTx => ({
  chainId: 1n,
  safe: SAFE,
  version: '1.4.1',
  to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address,
  value: 0n,
  data: `0x70cb9605${args.map(word).join('')}` as Hex,
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: ZERO,
  refundReceiver: ZERO,
  nonce: 0n,
});

const FREE = { free: 'not part of the case' };
const SCALE = 10n ** 27n;

/** The implied card of `args` under `template`, and the verdict of that card with `field` changed to `value`. */
function implied(template: ReturnType<typeof templateOf>, args: readonly bigint[]) {
  const loosened = loosen(template);
  const tx = txOf(args);
  const shape = inspectTemplateFields(tx, { safe: SAFE, operations: [{ template: template.id, values: new Map() }] }, new Map([[template.id, loosened.shape]]), registry, []);
  assert.equal(shape.leaves.length, loosened.rules.length);
  const { rules } = loosened;
  const values = shape.leaves.map((leaf) => leafValue(leaf, tx));
  const result = impliedCard(template, rules, values, SAFE, registry);
  const templates = new Map([[template.id, template]]);
  const verdict = (field: string, value: bigint): string => {
    const operation = result.card.operations[0] as Card['operations'][number];
    const card: Card = { operations: [{ ...operation, values: { ...operation.values, [field]: String(value) } }] };
    const resolution = resolveCard(card, { templates, registry, addressBook: result.book, safe: SAFE });
    return resolution.kind === 'refused' ? 'refused' : checkTemplateFields(tx, resolution.card, templates, registry).kind;
  };
  return { ...result, verdict };
}

/** The card holds `value` for `field` at the `side` end, MATCHes there and gives MISMATCH one step past it. */
function assertBoundary(result: ReturnType<typeof implied>, field: string, side: 'least' | 'most', value: bigint): void {
  assert.deepEqual(result.missing, []);
  assert.equal(result.card.operations[0]?.values[field], String(value));
  assert.deepEqual(result.boundaries.filter((b) => b.field === field), [{ field, side, value }]);
  assert.equal(result.verdict(field, value), 'match');
  assert.equal(result.verdict(field, side === 'most' ? value + 1n : value - 1n), 'mismatch');
}

test('a min share price bound gives the fewest shares the card may state', () => {
  const template = templateOf(['amount', 'max-shares'], { a: { card: 'amount' }, b: FREE, c: FREE, d: { minSharePrice: { assets: 'card.amount', shares: 'card.max-shares', scale: 27 } } });
  const [amount, price] = [1_000_000n, (SCALE * 3n) / 7n];
  assertBoundary(implied(template, [amount, 0n, 0n, price]), 'max-shares', 'least', (amount * SCALE + price - 1n) / price);
});

test('a max share price bound over stated shares gives the fewest assets the card may state', () => {
  const template = templateOf(['min-assets', 'shares'], { a: { card: 'shares' }, b: FREE, c: FREE, d: { maxSharePrice: { assets: 'card.min-assets', shares: 'card.shares', scale: 27 } } });
  const [shares, price] = [123_456_789n, (SCALE * 11n) / 10n + 1n];
  assertBoundary(implied(template, [shares, 0n, 0n, price]), 'min-assets', 'least', (price * shares + SCALE - 1n) / SCALE);
});

test('atMost gives the least the card may state, the largest of several', () => {
  const template = templateOf(['max-in'], { a: { atMost: 'card.max-in' }, b: { atMost: 'card.max-in' }, c: FREE, d: FREE });
  assertBoundary(implied(template, [500n, 700n, 0n, 0n]), 'max-in', 'least', 700n);
});

test('atLeast and a share price bound on one amount intersect, the stricter end taken', () => {
  const template = templateOf(['in', 'out'], { a: { card: 'in' }, b: { atLeast: 'card.out' }, c: { atLeast: 'card.out' }, d: { maxSharePrice: { assets: 'card.in', shares: 'card.out', scale: 27 } } });
  const amountIn = 1_000_000n;
  const looser = implied(template, [amountIn, 900n, 950n, (amountIn * SCALE) / 2000n]);
  assertBoundary(looser, 'out', 'most', 900n);
  const priced = implied(template, [amountIn, 900n, 950n, (amountIn * SCALE) / 850n]);
  assertBoundary(priced, 'out', 'most', 850n);
});

test('an amount no card value can meet, or none bounds, is missing with why', () => {
  const both = templateOf(['x'], { a: { atLeast: 'card.x' }, b: { atMost: 'card.x' }, c: FREE, d: FREE });
  assert.deepEqual(implied(both, [5n, 9n, 0n, 0n]).missing, [{ field: 'x', why: 'the transaction needs it at least 9 and at most 5' }]);
  const zero = templateOf(['amount', 'min-shares'], { a: { card: 'amount' }, b: FREE, c: FREE, d: { maxSharePrice: { assets: 'card.amount', shares: 'card.min-shares', scale: 27 } } });
  assert.deepEqual(implied(zero, [10n, 0n, 0n, 0n]).missing, [{ field: 'min-shares', why: 'no value of the transaction is bound to it, at a bound or a share price' }]);
});
