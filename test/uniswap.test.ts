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
import { loadRegistry } from '../src/registry.ts';
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
import { parseRegistryAt } from './registry-at.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const load = (dir: string, name: string) => JSON.parse(readFileSync(join(ROOT, 'testdata', dir, `${name}.json`), 'utf8'));
const registry = loadRegistry(ROOT);
const IDS = ['uniswap/swap', 'uniswap/swap-no-hook', 'uniswap/swap-permit', 'uniswap/approve-permit2', 'uniswap/allow-router'];
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

/** Where `word`, a 32-byte value, sits in `data` for the `nth` time, so a test can change that one field. */
function wordAt(tx: SafeTx, word: bigint | Address, nth: number): number {
  const hex = typeof word === 'bigint' ? word.toString(16).padStart(64, '0') : word.slice(2).padStart(64, '0');
  const data = tx.data.slice(2);
  let at = data.indexOf(hex);
  for (let i = 0; i < nth && at >= 0; i++) at = data.indexOf(hex, at + 1);
  assert.ok(at >= 0 && at % 2 === 0, `${word} is in the data`);
  return at / 2;
}

function changed(tx: SafeTx, from: bigint | Address, to: bigint | Address, nth = 0): SafeTx {
  const bytes = hexToBytes(tx.data.slice(2));
  const value = typeof to === 'bigint' ? to.toString(16).padStart(64, '0') : to.slice(2).padStart(64, '0');
  bytes.set(hexToBytes(value), wordAt(tx, from, nth));
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

const batchedCard = (amount: bigint, minBuy: bigint): Card => ({
  operations: [
    { template: 'uniswap/approve-permit2', values: { token: 'usdt' } },
    { template: 'uniswap/allow-router', values: { token: 'usdt' } },
    swapOp('usdt', 'usdc', amount, minBuy),
  ],
});

const BATCHED: Case = { name: 'uniswap-swap-hook-approve-usdt-usdc', sell: 2000000000n, minBuy: 1987680455n, bound: 30, card: batchedCard(2000000000n, 1987680455n) };

const HOOK_CASES: readonly Case[] = [
  BATCHED,
  { name: 'uniswap-swap-hook-usdc-usdt', sell: 20000000000n, minBuy: 19923502689n, bound: 21, card: { operations: [swapOp('usdc', 'usdt', 20000000000n, 19923502689n)] } },
  { name: 'uniswap-swap-hook-usdc-usdt-2', sell: 20000000000n, minBuy: 19917340573n, bound: 21, card: { operations: [swapOp('usdc', 'usdt', 20000000000n, 19917340573n)] } },
];

const NO_HOOK: Case = {
  name: 'uniswap-swap-no-hook-usdc-usdt',
  sell: 8029841n,
  minBuy: 7995463n,
  bound: 17,
  card: { operations: [swapOp('usdc', 'usdt', 8029841n, 7995463n, 'uniswap/swap-no-hook')] },
};

const CASES: readonly Case[] = [
  ...HOOK_CASES,
  NO_HOOK,
  {
    name: 'uniswap-swap-permit-usdc-usdt',
    sell: 24000000000n,
    minBuy: 23978654164n,
    bound: 18,
    card: { operations: [swapOp('usdc', 'usdt', 24000000000n, 23978654164n, 'uniswap/swap-permit')] },
  },
];

/** Executed swaps of the app's unhooked shape (V4_SWAP alone, SWAP_EXACT_IN then SETTLE and TAKE), which uniswap/swap and uniswap/swap-no-hook refuse. */
const UNHOOKED: readonly { readonly name: string; readonly card: Card }[] = [
  { name: 'uniswap-swap-approve-usdt-usdc', card: batchedCard(4342485506n, 4334865289n) },
  { name: 'uniswap-swap-usdc-usdt', card: { operations: [swapOp('usdc', 'usdt', 130000000n, 129893802n)] } },
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
  const swap = permits ? `${v4}.params[0].SWAP_EXACT_IN.params` : `${v4}.params[1].SWAP_EXACT_IN_SINGLE.params`;
  const sells = permits ? [`${swap}.amountIn`] : [`${v4}.params[0].SETTLE.amount`, `${swap}.amountIn`];
  const recipients = [`${v4}.params[2].TAKE.recipient`, ...(permits || c === NO_HOOK ? [] : [`${swapAt}.execute.inputs[1].SWEEP.recipient`])];

  test(`${c.name} matches its card`, () => {
    assert.deepEqual(check(tx, c.card), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    const result = checkMutations(tx, resolved(tx, c.card), templates, registry);
    assert.equal(result.kind, 'pass', JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v)).slice(0, 600));
    assert.equal(result.kind === 'pass' ? result.bound : -1, c.bound);
  });

  test(`${c.name}: a recipient other than the Safe is a mismatch at that recipient`, () => {
    recipients.forEach((at, nth) => assert.deepEqual(mismatchAt(check(changed(tx, tx.safe, OTHER, nth), c.card)), [at]));
  });

  test(`${c.name}: a lower minimum out than the card's, or a card asking more than the transaction's minimum, is a mismatch`, () => {
    assert.deepEqual(mismatchAt(check(changed(tx, c.minBuy, c.minBuy - 1n), c.card)), [`${swap}.amountOutMinimum`]);
    assert.deepEqual(mismatchAt(check(tx, withMinBuy(c.card, c.minBuy + 1n))), [`${swap}.amountOutMinimum`]);
    assert.deepEqual(check(changed(tx, c.minBuy, c.minBuy + 1n), c.card), { kind: 'match' });
    assert.deepEqual(check(tx, withMinBuy(c.card, c.minBuy - 1n)), { kind: 'match' });
  });

  test(`${c.name}: another sell amount is a mismatch at each place the transaction names it`, () => {
    sells.forEach((at, nth) => assert.deepEqual(mismatchAt(check(changed(tx, c.sell, c.sell + 1n, nth), c.card)), [at]));
  });
}

for (const c of HOOK_CASES) {
  const tx = safeTx(c.name);

  test(`${c.name}: another hook in the pool key is a mismatch at hooks`, () => {
    const at = mismatchAt(check(changed(tx, addressOf('uniswap-stable-pair-hook'), OTHER), c.card));
    assert.equal(at.length, 1);
    assert.match(at[0]!, /\.V4_SWAP\.params\[1\]\.SWAP_EXACT_IN_SINGLE\.params\.poolKey\.hooks$/);
  });
}

for (const { name, card } of UNHOOKED) {
  test(`${name}: a swap of the app's unhooked shape is a mismatch, even under the card it was signed for`, () => {
    const tx = safeTx(name);
    const swapAt = card.operations.length === 1 ? 'call' : 'multiSend[2]';
    const at = mismatchAt(check(tx, card));
    assert.ok(at.includes(`${swapAt}.execute.commands`), at.join(', '));
    assert.equal(at.every((path) => path.startsWith(`${swapAt}.execute`)), true, at.join(', '));
  });
}

const under = (card: Card, from: string, to: string): Card => ({
  operations: card.operations.map((op) => (op.template === from ? { ...op, template: to } : op)),
});

const wordHex = (value: bigint | Address) => (typeof value === 'bigint' ? value.toString(16) : value.slice(2)).padStart(64, '0');

/** `tx` with the `word`th word from the pool key's start (fee 2, tickSpacing 3, hooks 4, then zeroForOne 5) set to `to`. */
function withPoolKeyWord(tx: SafeTx, word: 2 | 3 | 4 | 5, to: bigint | Address): SafeTx {
  const pair = wordHex(addressOf('usdc')) + wordHex(addressOf('usdt'));
  const key = tx.data.slice(2).indexOf(pair);
  assert.ok(key > 0 && key % 2 === 0, 'the pool key is in the data');
  const bytes = hexToBytes(tx.data.slice(2));
  bytes.set(hexToBytes(wordHex(to)), key / 2 + word * 32);
  return withData(tx, bytes);
}

test('each swap template refuses the other one\'s transaction, whatever card values it was signed for', () => {
  for (const c of HOOK_CASES) {
    const swapAt = c === BATCHED ? 'multiSend[2]' : 'call';
    const at = mismatchAt(check(safeTx(c.name), under(c.card, 'uniswap/swap', 'uniswap/swap-no-hook')));
    assert.ok(at.includes(`${swapAt}.execute.commands`), at.join(', '));
    assert.ok(at.every((path) => path.startsWith(`${swapAt}.execute`)), at.join(', '));
  }
  const at = mismatchAt(check(safeTx(NO_HOOK.name), under(NO_HOOK.card, 'uniswap/swap-no-hook', 'uniswap/swap')));
  assert.ok(at.includes('call.execute.commands'), at.join(', '));
  assert.ok(at.every((path) => path.startsWith('call.execute')), at.join(', '));
});

test('a swap with a signed Permit2 permit first is a mismatch under each shipped swap template', () => {
  for (const template of ['uniswap/swap', 'uniswap/swap-no-hook']) {
    const card: Card = { operations: [swapOp('usdc', 'usdt', 24000000000n, 23978654164n, template)] };
    const at = mismatchAt(check(safeTx('uniswap-swap-permit-usdc-usdt'), card));
    assert.ok(at.includes('call.execute.commands'), at.join(', '));
  }
});

test('uniswap/swap-no-hook refuses its own swap with a SWEEP added', () => {
  const c = HOOK_CASES[1]!;
  const unhooked = withPoolKeyWord(withPoolKeyWord(safeTx(c.name), 2, 35n), 4, 0n);
  const at = mismatchAt(check(unhooked, under(c.card, 'uniswap/swap', 'uniswap/swap-no-hook')));
  assert.deepEqual(at.toSorted(), ['call.execute.commands', 'call.execute.inputs']);
});

test('uniswap/swap-no-hook refuses a pool with a hook or another tick spacing, and leaves the fee free', () => {
  const tx = safeTx(NO_HOOK.name);
  const key = 'call.execute.inputs[0].V4_SWAP.params[1].SWAP_EXACT_IN_SINGLE.params.poolKey';
  for (const hook of [addressOf('uniswap-stable-pair-hook'), OTHER]) assert.deepEqual(mismatchAt(check(withPoolKeyWord(tx, 4, hook), NO_HOOK.card)), [`${key}.hooks`]);
  for (const spacing of [0n, 2n, 10n, 60n]) assert.deepEqual(mismatchAt(check(withPoolKeyWord(tx, 3, spacing), NO_HOOK.card)), [`${key}.tickSpacing`]);
  for (const fee of [7n, 100n, 3000n]) assert.deepEqual(check(withPoolKeyWord(tx, 2, fee), NO_HOOK.card), { kind: 'match' });
});

test('uniswap/swap-no-hook refuses another token at each place the transaction names one', () => {
  const tx = safeTx(NO_HOOK.name);
  const v4 = 'call.execute.inputs[0].V4_SWAP';
  const key = `${v4}.params[1].SWAP_EXACT_IN_SINGLE.params.poolKey`;
  const places = [
    ['usdc', [`${v4}.params[0].SETTLE.currency`, `${key}.currency0`]],
    ['usdt', [`${key}.currency1`, `${v4}.params[2].TAKE.currency`]],
  ] as const;
  for (const [token, paths] of places) paths.forEach((at, nth) => assert.deepEqual(mismatchAt(check(changed(tx, addressOf(token), addressOf('morpho'), nth), NO_HOOK.card)), [at]));
  const sold = `${v4}.params[0].SETTLE.currency`;
  const bought = `${v4}.params[2].TAKE.currency`;
  for (const [sell, buy, at] of [['morpho', 'usdt', [sold]], ['usdc', 'morpho', [bought]], ['usdt', 'usdc', [sold, bought]]] as const) {
    const card: Card = { operations: [swapOp(sell, buy, NO_HOOK.sell, NO_HOOK.minBuy, 'uniswap/swap-no-hook')] };
    assert.deepEqual(mismatchAt(check(tx, card)), at);
  }
});

test('uniswap/swap-no-hook matches the fields of a USDT to USDC swap, the recorded one with its two tokens and direction turned around', () => {
  const tx = safeTx(NO_HOOK.name);
  const [usdc, usdt] = [addressOf('usdc'), addressOf('usdt')];
  const reversed = withPoolKeyWord(changed(changed(tx, usdt, usdc, 1), usdc, usdt, 0), 5, 0n);
  const card: Card = { operations: [swapOp('usdt', 'usdc', NO_HOOK.sell, NO_HOOK.minBuy, 'uniswap/swap-no-hook')] };
  assert.deepEqual(check(reversed, card), { kind: 'match' });
  assert.deepEqual(mismatchAt(check(reversed, NO_HOOK.card)), ['call.execute.inputs[0].V4_SWAP.params[0].SETTLE.currency', 'call.execute.inputs[0].V4_SWAP.params[2].TAKE.currency']);
});

test('uniswap/swap-no-hook refuses the multi-hop SWAP_EXACT_IN shape at its action list', () => {
  const at = mismatchAt(check(safeTx('uniswap-swap-usdc-usdt'), { operations: [swapOp('usdc', 'usdt', 130000000n, 129893802n, 'uniswap/swap-no-hook')] }));
  assert.ok(at.includes('call.execute.inputs[0].V4_SWAP.actions'), at.join(', '));
});

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
        ['permit2', addressOf('universal-router-2.1.2'), PERMIT2_MAX, 1794727413n],
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

test('the no-hook swap gives exactly the sell amount and gets at least the minimum, simulated and in its receipt, and leaves no new allowance', async () => {
  const { tx, simulated, receipt } = await observations(NO_HOOK.name, [addressOf('usdc'), addressOf('usdt')]);
  for (const observed of [simulated, receipt]) {
    const { tokens } = executedOf(observed);
    assert.equal(tokens.get(addressOf('usdc')), -NO_HOOK.sell);
    const got = tokens.get(addressOf('usdt')) ?? 0n;
    assert.ok(got >= NO_HOOK.minBuy);
    assert.deepEqual(judgeEffects(observed, resolved(tx, NO_HOOK.card), templates, registry), { kind: 'match' });
    assert.equal(judgeEffects(observed, resolved(tx, withMinBuy(NO_HOOK.card, got + 1n)), templates, registry).kind, 'mismatch');
    assert.deepEqual(checkSimulatedFloor(observed, tx.safe), { kind: 'pass' });
  }
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
  assert.throws(() => parseTemplate(allow, parseRegistryAt(ROOT, raw)), /declares no standing allowance through permit2/);
});

test('a trailer over 19 bytes is allowed only on a call to a registry contract that declares it ignores trailing calldata', () => {
  const swap = JSON.parse(readFileSync(join(ROOT, 'templates', 'uniswap', 'swap', 'template.json'), 'utf8'));
  assert.doesNotThrow(() => parseTemplate(swap, registry));
  const raw = JSON.parse(readFileSync(join(ROOT, 'registry', 'contracts.json'), 'utf8'));
  delete raw['universal-router-2.1.2'].ignoresTrailer;
  assert.throws(() => parseTemplate(swap, parseRegistryAt(ROOT, raw)), /an integer from 1 to 19; more only on a call to a registry contract that declares ignoresTrailer/);
});

test('a route claim needs every token the Safe gets bounded, since another pool gives another price', () => {
  const swap = JSON.parse(readFileSync(join(ROOT, 'templates', 'uniswap', 'swap-permit', 'template.json'), 'utf8'));
  swap.effects.gets[0].amount = 'positive';
  assert.throws(() => parseTemplate(swap, registry), /a template with a route claim must bound each token the Safe gives or gets/);
  const noHook = JSON.parse(readFileSync(join(ROOT, 'templates', 'uniswap', 'swap-no-hook', 'template.json'), 'utf8'));
  assert.doesNotThrow(() => parseTemplate(noHook, registry));
  noHook.effects.gets[0].amount = 'positive';
  assert.throws(() => parseTemplate(noHook, registry), /a template with a route claim must bound each token the Safe gives or gets/);
});

test('a router input whose bytes do not re-encode exactly is a mismatch at its encoding', () => {
  const cases = [
    { name: 'uniswap-swap-hook-usdc-usdt', actions: '0b060e00', at: 'call.execute.inputs[0].encoding' },
    { name: NO_HOOK.name, actions: '0b060e00', at: 'call.execute.inputs[0].encoding' },
    { name: 'uniswap-swap-permit-usdc-usdt', actions: '070b0e00', at: 'call.execute.inputs[1].encoding' },
  ];
  for (const { name, actions, at } of cases) {
    const tx = safeTx(name);
    const bytes = hexToBytes(tx.data.slice(2));
    const start = tx.data.slice(2).indexOf(actions);
    assert.ok(start > 0 && start % 2 === 0, 'the action list is in the data');
    bytes[start / 2 + 3] = 1;
    assert.deepEqual(mismatchAt(check(withData(tx, bytes), CASES.find((c) => c.name === name)!.card)), [at]);
  }
});
