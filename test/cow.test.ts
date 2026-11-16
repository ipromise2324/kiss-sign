import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { judgeEffects } from '../src/simulate/effects.ts';
import type { Observed } from '../src/simulate/effects.ts';
import { checkTemplateFields, inspectTemplateFields } from '../src/template/check.ts';
import type { FieldCheck, Messages } from '../src/template/check.ts';
import { domainSeparator, readMessage, typedDataDigest } from '../src/template/eip712.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { SignedMessage, Template } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const load = (dir: string, name: string) => readFileSync(join(ROOT, 'testdata', dir, `${name}.json`), 'utf8');
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>(['cow/swap', 'cow/swap-approve'].map((id) => [id, loadTemplate(ROOT, id, registry)]));
const nameOf = (address: string): string => registry.byAddress.get(address.toLowerCase() as Address)!.name;

type Order = Record<string, unknown> & { uid: string; sellToken: string; buyToken: string; sellAmount: string; buyAmount: string };
type Case = { readonly name: string; readonly template: string; readonly bound: number };

const CASES: readonly Case[] = [
  { name: 'cow-swap-approve-usdt', template: 'cow/swap-approve', bound: 19 },
  { name: 'cow-swap-approve-cbbtc', template: 'cow/swap-approve', bound: 19 },
  { name: 'cow-swap-usdt', template: 'cow/swap', bound: 15 },
  { name: 'cow-swap-usdc', template: 'cow/swap', bound: 15 },
];

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(load('safe-tx', name));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const order = (name: string): Order => JSON.parse(load('messages', name));

/** The card the order implies: its tokens, its sell amount, and its buy amount as the least to receive. */
function impliedCard(c: Case, o: Order, minBuy = o.buyAmount): Card {
  return {
    operations: [{ template: c.template, values: { 'sell-token': nameOf(o.sellToken), 'buy-token': nameOf(o.buyToken), 'sell-amount': o.sellAmount, 'min-buy': minBuy } }],
  };
}

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, card: Card, messages: Messages): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry, messages);

const message = (id: string): SignedMessage => {
  const call = templates.get(id)!.calls.at(-1)!;
  const uid = call.data === 'empty' ? undefined : call.data.args[0];
  assert.equal(uid?.kind, 'packed');
  const digest = (uid as Extract<typeof uid, { kind: 'packed' }>).parts[0]!.rule;
  assert.equal(digest.kind, 'eip712');
  return (digest as Extract<typeof digest, { kind: 'eip712' }>).message;
};

/** The transaction with the order changed as `change` says and its uid's digest written again, as an attacker would sign it. */
function withOrder(tx: SafeTx, o: Order, change: Partial<Order>, id: string): { tx: SafeTx; text: string } {
  const changed = { ...o, ...change };
  const text = JSON.stringify(changed);
  const read = readMessage(message(id).struct, text);
  assert.ok(typeof read !== 'string', String(read));
  const digest = typedDataDigest(message(id).separator, message(id).struct, read.values);
  const data = tx.data.slice(2);
  const at = data.indexOf(o.uid.slice(2, 66));
  return { tx: { ...tx, data: `0x${data.slice(0, at)}${digest.slice(2)}${data.slice(at + 64)}` as Hex }, text };
}

test('the settlement contract hashes orders under the domain separator the template computes', () => {
  const settlement = registry.entries.get('gpv2-settlement')!.address;
  // GPv2Settlement.domainSeparator() on mainnet, read through both providers.
  assert.equal(domainSeparator({ name: 'Gnosis Protocol', version: 'v2', verifyingContract: settlement }), '0xc078f884a2676e1345748b1feace7b0abee5d00ecadb6e574dcdd109a63e8943');
});

for (const c of CASES) {
  test(`${c.name}: the order read by its digest matches the card it implies, and every bound field, order members included, is caught`, () => {
    const tx = safeTx(c.name);
    const o = order(c.name);
    const card = impliedCard(c, o);
    const messages = [load('messages', c.name)];
    assert.deepEqual(check(tx, card, messages), { kind: 'match' });
    assert.deepEqual(checkMutations(tx, resolved(tx, card), templates, registry, messages), { kind: 'pass', bound: c.bound, free: 2 });
  });

  test(`${c.name}: with no order given the field check is UNVERIFIABLE and names the URL to read it from`, () => {
    const tx = safeTx(c.name);
    const o = order(c.name);
    const inspection = inspectTemplateFields(tx, resolved(tx, impliedCard(c, o)), templates, registry, []);
    assert.equal(inspection.check.kind, 'unverifiable');
    assert.deepEqual(inspection.lookups, [`https://api.cow.fi/mainnet/api/v1/orders/${o.uid}`]);
  });
}

test('an order body that does not hash to the digest counts for nothing: a changed buy amount served for the real uid is UNVERIFIABLE', () => {
  const c = CASES[0]!;
  const tx = safeTx(c.name);
  const o = order(c.name);
  const forged = JSON.stringify({ ...o, buyAmount: `${BigInt(o.buyAmount) * 2n}` });
  const result = check(tx, impliedCard(c, o), [forged]);
  assert.equal(result.kind, 'unverifiable');
  assert.match((result as Extract<FieldCheck, { kind: 'unverifiable' }>).reasons[0]!, /no Order read from https:\/\/api\.cow\.fi\/mainnet\/api\/v1\/orders\/0x[0-9a-f]{112} hashes to 0x[0-9a-f]{64}/);
});

const findings = (result: FieldCheck): string[] => {
  assert.equal(result.kind, 'mismatch', JSON.stringify(result));
  return (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => `${f.callPath} ${f.arg}: expected ${f.expected}, got ${f.actual}`);
};

test('an order that pays another receiver is MISMATCH at the order member, though its uid is genuine for that order', () => {
  const c = CASES[0]!;
  const o = order(c.name);
  const changed = withOrder(safeTx(c.name), o, { receiver: '0x000000000000000000000000000000000000dead' }, c.template);
  assert.deepEqual(findings(check(changed.tx, impliedCard(c, o), [changed.text])), [
    `multiSend[1].setPreSignature orderUid.digest.receiver: expected ${safeTx(c.name).safe}, got 0x000000000000000000000000000000000000dead`,
  ]);
});

test('an order buying less than the card minimum is MISMATCH; buying more matches', () => {
  const c = CASES[2]!;
  const o = order(c.name);
  const less = withOrder(safeTx(c.name), o, { buyAmount: `${BigInt(o.buyAmount) - 1n}` }, c.template);
  assert.deepEqual(findings(check(less.tx, impliedCard(c, o), [less.text])), [`call.setPreSignature orderUid.digest.buyAmount: expected at least ${o.buyAmount}, got ${BigInt(o.buyAmount) - 1n}`]);
  const more = withOrder(safeTx(c.name), o, { buyAmount: `${BigInt(o.buyAmount) + 1n}` }, c.template);
  assert.deepEqual(check(more.tx, impliedCard(c, o), [more.text]), { kind: 'match' });
});

test('a buy order, a partly fillable order and an order with a fee are each MISMATCH at that member', () => {
  const c = CASES[3]!;
  const o = order(c.name);
  for (const [change, expected] of [
    [{ kind: 'buy' }, 'kind: expected 0x73656c6c, got 0x627579'],
    [{ partiallyFillable: true }, 'partiallyFillable: expected false, got true'],
    [{ feeAmount: '1' }, 'feeAmount: expected 0, got 1'],
    [{ sellTokenBalance: 'external' }, 'sellTokenBalance: expected 0x6572633230, got 0x65787465726e616c'],
  ] as const) {
    const changed = withOrder(safeTx(c.name), o, change, c.template);
    assert.deepEqual(findings(check(changed.tx, impliedCard(c, o), [changed.text])), [`call.setPreSignature orderUid.digest.${expected}`]);
  }
});

test("a uid whose owner part is another address is MISMATCH at the owner, even with the order given", () => {
  const c = CASES[3]!;
  const tx = safeTx(c.name);
  const o = order(c.name);
  const other = `0x${tx.data.slice(2).replace(tx.safe.slice(2), '000000000000000000000000000000000000dead')}` as Hex;
  assert.deepEqual(findings(check({ ...tx, data: other }, impliedCard(c, o), [load('messages', c.name)])), [
    `call.setPreSignature orderUid.owner: expected ${tx.safe}, got 0x000000000000000000000000000000000000dead`,
  ]);
});

test('an approval of more than the card sell amount is MISMATCH at the approve value', () => {
  const c = CASES[0]!;
  const tx = safeTx(c.name);
  const o = order(c.name);
  const amount = BigInt(o.sellAmount).toString(16).padStart(64, '0');
  const data = tx.data.replace(amount, (BigInt(o.sellAmount) + 1n).toString(16).padStart(64, '0')) as Hex;
  assert.deepEqual(findings(check({ ...tx, data }, impliedCard(c, o), [load('messages', c.name)])), [
    `multiSend[0].approve value: expected ${o.sellAmount}, got ${BigInt(o.sellAmount) + 1n}`,
  ]);
});

const observed = (tx: SafeTx, o: Order, after: bigint): Observed => ({
  kind: 'executed',
  safeState: { kind: 'unchanged' } as unknown as Extract<Observed, { kind: 'executed' }>['safeState'],
  eth: 0n,
  tokens: new Map(),
  allowances: [{ token: o.sellToken.toLowerCase() as Address, spender: registry.entries.get('gpv2-vault-relayer')!.address, before: 0n, after }],
  permit2: [],
  ends: new Map(),
});

test('the approval to the vault relayer may stay open up to the card sell amount, and no further', () => {
  const c = CASES[0]!;
  const tx = safeTx(c.name);
  const o = order(c.name);
  const card = resolved(tx, impliedCard(c, o));
  assert.deepEqual(judgeEffects(observed(tx, o, BigInt(o.sellAmount)), card, templates, registry), { kind: 'match' });
  const above = judgeEffects(observed(tx, o, BigInt(o.sellAmount) + 1n), card, templates, registry);
  assert.equal(above.kind, 'mismatch');
  assert.equal((above as Extract<typeof above, { kind: 'mismatch' }>).findings[0]?.kind, 'open-allowance');
  const plain = resolved(tx, impliedCard(CASES[2]!, o));
  assert.equal(judgeEffects(observed(tx, o, 1n), plain, templates, registry).kind, 'mismatch', 'cow/swap leaves no approval open');
});

test('the uid is the packed digest, owner and validTo of its order', () => {
  for (const c of CASES) {
    const o = order(c.name);
    const read = readMessage(message(c.template).struct, load('messages', c.name));
    assert.ok(typeof read !== 'string');
    const digest = typedDataDigest(message(c.template).separator, message(c.template).struct, read.values);
    const validTo = Number(o.validTo).toString(16).padStart(8, '0');
    assert.equal(o.uid, `${digest}${safeTx(c.name).safe.slice(2)}${validTo}`);
    assert.equal(bytesToHex(hexToBytes(o.uid.slice(2))).length, 112);
  }
});
