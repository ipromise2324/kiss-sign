import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { checkFloor, standingSpenders } from '../src/floor/floor.ts';
import { checkSimulatedFloor } from '../src/floor/simulated.ts';
import { loadRegistry, parseRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { judgeEffects, keptSeen } from '../src/simulate/effects.ts';
import type { Observed } from '../src/simulate/effects.ts';
import { observeExecuted } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { TemplateError, loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const load = (dir: string, name: string) => JSON.parse(readFileSync(join(ROOT, 'testdata', dir, `${name}.json`), 'utf8'));
const registry = loadRegistry(ROOT);
const IDS = ['uniswap/swap', 'uniswap/swap-permit', 'uniswap/approve-permit2', 'uniswap/allow-router'];
const templates = new Map<string, Template>(IDS.map((id) => [id, loadTemplate(ROOT, id, registry)]));
const addressOf = (name: string): Address => registry.entries.get(name)!.address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const PERMIT2_MAX = (1n << 160n) - 1n;
const MAX = (1n << 256n) - 1n;

function safeTx(name: string): SafeTx {
  const fixture = load('safe-tx', name);
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const withData = (tx: SafeTx, bytes: Uint8Array): SafeTx => ({ ...tx, data: `0x${bytesToHex(bytes)}` as Hex });

/** Where `word`, a 32-byte value, first sits in `data`, so a test can change that one field. */
function wordAt(tx: SafeTx, word: bigint | Address): number {
  const hex = typeof word === 'bigint' ? word.toString(16).padStart(64, '0') : word.slice(2).padStart(64, '0');
  const at = tx.data.slice(2).indexOf(hex);
  assert.ok(at >= 0 && at % 2 === 0, `${word} is in the data`);
  return at / 2;
}

function changed(tx: SafeTx, from: bigint | Address, to: bigint | Address): SafeTx {
  const bytes = hexToBytes(tx.data.slice(2));
  const value = typeof to === 'bigint' ? to.toString(16).padStart(64, '0') : to.slice(2).padStart(64, '0');
  bytes.set(hexToBytes(value), wordAt(tx, from));
  return withData(tx, bytes);
}

type Case = {
  readonly name: string;
  readonly card: Card;
  readonly sell: bigint;
  readonly minBuy: bigint;
  readonly bound: number;
};

const swapOp = (sell: string, buy: string, amount: bigint, minBuy: bigint, template = 'uniswap/swap') => ({
  template,
  values: { 'sell-token': sell, 'buy-token': buy, 'sell-amount': `${amount}`, 'min-buy': `${minBuy}` },
});

const BATCHED: Case = {
  name: 'uniswap-swap-approve-usdt-usdc',
  sell: 4342485506n,
  minBuy: 4334865289n,
  bound: 24,
  card: {
    operations: [
      { template: 'uniswap/approve-permit2', values: { token: 'usdt' } },
      { template: 'uniswap/allow-router', values: { token: 'usdt' } },
      swapOp('usdt', 'usdc', 4342485506n, 4334865289n),
    ],
  },
};

const CASES: readonly Case[] = [
  BATCHED,
  { name: 'uniswap-swap-usdc-usdt', sell: 130000000n, minBuy: 129893802n, bound: 15, card: { operations: [swapOp('usdc', 'usdt', 130000000n, 129893802n)] } },
  {
    name: 'uniswap-swap-permit-usdc-usdt',
    sell: 24000000000n,
    minBuy: 23978654164n,
    bound: 18,
    card: { operations: [swapOp('usdc', 'usdt', 24000000000n, 23978654164n, 'uniswap/swap-permit')] },
  },
];

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);

function mismatchAt(result: FieldCheck): string[] {
  assert.equal(result.kind, 'mismatch', JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v)));
  return (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => `${f.callPath}.${f.arg}`);
}

const withMinBuy = (card: Card, minBuy: bigint): Card => ({
  operations: card.operations.map((op) => (op.template.startsWith('uniswap/swap') ? { ...op, values: { ...op.values, 'min-buy': `${minBuy}` } } : op)),
});

for (const c of CASES) {
  const tx = safeTx(c.name);
  const swapAt = c.card.operations.length === 1 ? 'call' : `multiSend[${c.card.operations.length - 1}]`;
  const permits = c.card.operations.some((op) => op.template === 'uniswap/swap-permit');
  const v4 = `${swapAt}.execute.inputs[${permits ? 1 : 0}].V4_SWAP`;

  test(`${c.name} matches its card`, () => {
    assert.deepEqual(check(tx, c.card), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    const result = checkMutations(tx, resolved(tx, c.card), templates, registry);
    assert.equal(result.kind, 'pass', JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v)).slice(0, 600));
    assert.equal(result.kind === 'pass' ? result.bound : -1, c.bound);
  });

  test(`${c.name}: a recipient other than the Safe is a mismatch at TAKE's recipient`, () => {
    assert.deepEqual(mismatchAt(check(changed(tx, tx.safe, OTHER), c.card)), [`${v4}.params[2].TAKE.recipient`]);
  });

  test(`${c.name}: a lower minimum out than the card's, or a card asking more than the transaction's minimum, is a mismatch`, () => {
    assert.deepEqual(mismatchAt(check(changed(tx, c.minBuy, c.minBuy - 1n), c.card)), [`${v4}.params[0].SWAP_EXACT_IN.params.amountOutMinimum`]);
    assert.deepEqual(mismatchAt(check(tx, withMinBuy(c.card, c.minBuy + 1n))), [`${v4}.params[0].SWAP_EXACT_IN.params.amountOutMinimum`]);
    assert.deepEqual(check(changed(tx, c.minBuy, c.minBuy + 1n), c.card), { kind: 'match' });
    assert.deepEqual(check(tx, withMinBuy(c.card, c.minBuy - 1n)), { kind: 'match' });
  });

  test(`${c.name}: another sell amount is a mismatch at amountIn`, () => {
    assert.deepEqual(mismatchAt(check(changed(tx, c.sell, c.sell + 1n), c.card)), [`${v4}.params[0].SWAP_EXACT_IN.params.amountIn`]);
  });
}

type SimFixture = { safeTx: string; transactionHash: Hex; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };

async function observations(name: string, watch: readonly Address[]): Promise<{ tx: SafeTx; simulated: Observed; receipt: Observed }> {
  const fixture: SimFixture = load('simulate', name);
  const tx = safeTx(fixture.safeTx);
  const reader = replayReader(fixture.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(fixture.parent), await header(fixture.executed)];
  const observedOf = (o: Observation): Observed => {
    assert.equal(o.kind, 'observed', o.kind === 'unverifiable' ? o.reasons.join('; ') : '');
    return (o as Extract<Observation, { kind: 'observed' }>).observed;
  };
  return {
    tx,
    simulated: observedOf(await simulateSafeTx(reader, { tx, parent, time: executed.time, watch, ends: [] })),
    receipt: observedOf(await observeExecuted(reader, fixture.transactionHash, tx, [])),
  };
}

const executedOf = (observed: Observed) => observed as Extract<Observed, { kind: 'executed' }>;

test('the batched swap leaves USDT approved to Permit2 and a Permit2 allowance to the router; the card keeps both, so the effects match and the floor passes', async () => {
  const { tx, simulated, receipt } = await observations(BATCHED.name, [addressOf('usdt'), addressOf('usdc')]);
  const card = resolved(tx, BATCHED.card);
  for (const observed of [simulated, receipt]) {
    const { tokens, allowances, permit2 } = executedOf(observed);
    assert.equal(tokens.get(addressOf('usdt')), -BATCHED.sell);
    assert.ok((tokens.get(addressOf('usdc')) ?? 0n) >= BATCHED.minBuy);
    assert.deepEqual(allowances, [{ token: addressOf('usdt'), spender: addressOf('permit2'), before: 0n, after: MAX }]);
    assert.deepEqual(
      permit2.map((p) => [p.token, p.spender, p.after.amount]),
      [[addressOf('usdt'), addressOf('universal-router-2.1.2'), PERMIT2_MAX]],
    );
    assert.deepEqual(judgeEffects(observed, card, templates, registry), { kind: 'match' });
    assert.deepEqual(checkSimulatedFloor(observed, tx.safe, { standing: standingSpenders(registry) }), { kind: 'pass' });
    assert.equal(checkSimulatedFloor(observed, tx.safe).kind, 'refused');
    assert.deepEqual(
      keptSeen(observed, card, templates, registry).map((k) => [k.via, k.spender, k.amount, k.expiration]),
      [
        ['erc20', addressOf('permit2'), MAX, undefined],
        ['permit2', addressOf('universal-router-2.1.2'), PERMIT2_MAX, 1797234694n],
      ],
    );
  }
  assert.deepEqual(checkFloor(tx, { standing: standingSpenders(registry) }), { kind: 'pass' });
  assert.equal(checkFloor(tx).kind, 'refused');
});

test('a card for the swap alone keeps neither allowance, so the same transaction leaves two open allowances and is a mismatch', async () => {
  const { tx, receipt } = await observations(BATCHED.name, [addressOf('usdt'), addressOf('usdc')]);
  const card = resolved(tx, { operations: [swapOp('usdt', 'usdc', BATCHED.sell, BATCHED.minBuy)] });
  const verdict = judgeEffects(receipt, card, templates, registry);
  assert.equal(verdict.kind, 'mismatch');
  assert.deepEqual(
    (verdict as Extract<typeof verdict, { kind: 'mismatch' }>).findings.map((f) => f.kind),
    ['open-allowance', 'open-permit2-allowance'],
  );
});

test('the Safe must get at least the card minimum of the token it buys', async () => {
  const { tx, receipt } = await observations(BATCHED.name, [addressOf('usdt'), addressOf('usdc')]);
  const got = executedOf(receipt).tokens.get(addressOf('usdc')) ?? 0n;
  const asking = (minBuy: bigint) => judgeEffects(receipt, resolved(tx, withMinBuy(BATCHED.card, minBuy)), templates, registry).kind;
  assert.equal(asking(got), 'match');
  assert.equal(asking(got + 1n), 'mismatch');
});

test('an unlimited kept allowance needs a registry spender that declares a standing allowance through the same route', () => {
  const allow = JSON.parse(readFileSync(join(ROOT, 'templates', 'uniswap', 'allow-router', 'template.json'), 'utf8'));
  const refused = (edit: (t: any) => void, problem: RegExp) => {
    const broken = structuredClone(allow);
    edit(broken);
    assert.throws(() => parseTemplate(broken, registry), (error: unknown) => error instanceof TemplateError && problem.test(error.message));
  };
  refused((t) => (t.effects.approves[0].spender = 'permit2'), /permit2 declares no standing allowance through permit2/);
  refused((t) => (t.effects.approves[0].spender = 'bundler3'), /bundler3 declares no standing allowance through permit2/);
  refused((t) => (t.effects.approves[0].via = 'erc20'), /universal-router-2\.1\.2 declares no standing allowance through erc20/);
  const raw = JSON.parse(readFileSync(join(ROOT, 'registry', 'contracts.json'), 'utf8'));
  delete raw['universal-router-2.1.2'].standingAllowance;
  assert.throws(() => parseTemplate(allow, parseRegistry(raw)), /declares no standing allowance through permit2/);
});

test('a trailer over 19 bytes is allowed only on a call to a registry contract that declares it ignores trailing calldata', () => {
  const swap = JSON.parse(readFileSync(join(ROOT, 'templates', 'uniswap', 'swap', 'template.json'), 'utf8'));
  assert.doesNotThrow(() => parseTemplate(swap, registry));
  const raw = JSON.parse(readFileSync(join(ROOT, 'registry', 'contracts.json'), 'utf8'));
  delete raw['universal-router-2.1.2'].ignoresTrailer;
  assert.throws(() => parseTemplate(swap, parseRegistry(raw)), /an integer from 1 to 19; more only on a call to a registry contract that declares ignoresTrailer/);
});

test('a route claim needs every token the Safe gets bounded, since another pool gives another price', () => {
  const swap = JSON.parse(readFileSync(join(ROOT, 'templates', 'uniswap', 'swap', 'template.json'), 'utf8'));
  swap.effects.gets[0].amount = 'positive';
  assert.throws(() => parseTemplate(swap, registry), /a template with a route claim must bound each token the Safe gives or gets/);
});

test('a router input whose bytes do not re-encode exactly is a mismatch at its encoding', () => {
  const tx = safeTx('uniswap-swap-usdc-usdt');
  const card = { operations: [swapOp('usdc', 'usdt', 130000000n, 129893802n)] };
  const bytes = hexToBytes(tx.data.slice(2));
  const actions = tx.data.slice(2).indexOf('070b0e00');
  assert.ok(actions > 0 && actions % 2 === 0, 'the action list is in the data');
  bytes[actions / 2 + 3] = 1;
  assert.deepEqual(mismatchAt(check(withData(tx, bytes), card)), ['call.execute.inputs[0].encoding']);
});
