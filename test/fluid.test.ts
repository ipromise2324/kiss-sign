import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { uintWord } from '../src/decode/codec.ts';
import { unwrapSafeTx } from '../src/decode/multisend.ts';
import type { Unwrapped } from '../src/decode/multisend.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { expectedChanges, judgeEffects } from '../src/simulate/effects.ts';
import type { EffectVerdict, Observed } from '../src/simulate/effects.ts';
import { observeExecuted } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const ROOT = repoWithTestFixtures();
const load = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>(
  ['fluid/vault-deposit', 'fluid/vault-withdraw', 'fluid/vault-redeem'].map((id) => [id, loadTemplate(ROOT, id, registry)]),
);
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const addressOf = (name: string): Address => registry.entries.get(name)!.address;

function safeTx(name: string): SafeTx {
  const fixture = load('safe-tx', name);
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const withData = (tx: SafeTx, bytes: Uint8Array): SafeTx => ({ ...tx, data: `0x${bytesToHex(bytes)}` as Hex });

/** Where the vault call's arguments start in `data`: after the selector of a direct call, or inside the MultiSend's last entry. */
function vaultArgs(tx: SafeTx): number {
  const unwrapped = unwrapSafeTx(tx) as Extract<Unwrapped, { kind: 'direct' | 'multisend' }>;
  return unwrapped.calls.at(-1)!.data.start + 4;
}

/** The first argument of the vault call: the assets of a deposit or withdrawal, the shares of a redemption. */
const firstArg = (tx: SafeTx): bigint => BigInt(`0x${bytesToHex(hexToBytes(tx.data.slice(2)).slice(vaultArgs(tx), vaultArgs(tx) + 32))}`);

type Case = { readonly name: string; readonly template: string; readonly vault: string; readonly bound: number };

const CASES: readonly Case[] = [
  { name: 'fluid-deposit-usdt-base', template: 'fluid/vault-deposit', vault: 'fluid-fusdt', bound: 8 },
  { name: 'fluid-deposit-usdt-other-safe-base', template: 'fluid/vault-deposit', vault: 'fluid-fusdt', bound: 8 },
  { name: 'fluid-deposit-usdc-base', template: 'fluid/vault-deposit', vault: 'fluid-fusdc', bound: 8 },
  { name: 'fluid-withdraw-usdc', template: 'fluid/vault-withdraw', vault: 'fluid-fusdc', bound: 5 },
  { name: 'fluid-withdraw-usdt-other-safe', template: 'fluid/vault-withdraw', vault: 'fluid-fusdt', bound: 5 },
  { name: 'fluid-redeem-usdt', template: 'fluid/vault-redeem', vault: 'fluid-fusdt', bound: 5 },
  { name: 'fluid-redeem-usdt-other-safe', template: 'fluid/vault-redeem', vault: 'fluid-fusdt', bound: 5 },
];

/** The card a past transaction implies: its vault, and the amount its vault call names. */
function impliedCard(c: Case, tx: SafeTx, amount: bigint = firstArg(tx)): Card {
  const field = c.template === 'fluid/vault-redeem' ? 'shares' : 'amount';
  return { operations: [{ template: c.template, values: { vault: c.vault, [field]: `${amount}` } }] };
}

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

const caseNamed = (name: string): Case => CASES.find((c) => c.name === name) as Case;

for (const c of CASES) {
  const tx = safeTx(c.name);

  test(`${c.name} matches ${c.template} with the card it implies`, () => {
    assert.deepEqual(check(tx, impliedCard(c, tx)), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, impliedCard(c, tx)), templates, registry), { kind: 'pass', bound: c.bound, free: 0 });
  });

  test(`${c.name}: a receiver other than the Safe, or another amount, is a mismatch at that argument`, () => {
    const call = c.template === 'fluid/vault-deposit' ? 'multiSend[1].deposit' : `call.${c.template === 'fluid/vault-redeem' ? 'redeem' : 'withdraw'}`;
    const first = c.template === 'fluid/vault-redeem' ? 'shares' : 'assets';
    const receiver = hexToBytes(tx.data.slice(2));
    receiver.set(hexToBytes(OTHER.slice(2)), vaultArgs(tx) + 44);
    assert.deepEqual(mismatchAt(check(withData(tx, receiver), impliedCard(c, tx))), [`${call}.receiver`]);
    const amount = hexToBytes(tx.data.slice(2));
    amount.set(uintWord(firstArg(tx) + 1n), vaultArgs(tx));
    const found = mismatchAt(check(withData(tx, amount), impliedCard(c, tx)));
    assert.ok(found.includes(`${call}.${first}`), found.join());
  });
}

test('a deposit whose card names another vault is a mismatch at every call target and at the spender', () => {
  const c = caseNamed('fluid-deposit-usdt-base');
  const tx = safeTx(c.name);
  const card = impliedCard({ ...c, vault: 'fluid-fusdc' }, tx);
  assert.deepEqual(mismatchAt(check(tx, card)), ['multiSend[0].to', 'multiSend[0].approve.spender', 'multiSend[1].to']);
});

test('a deposit whose card amount differs from the approval and the deposit mismatches at both', () => {
  const c = caseNamed('fluid-deposit-usdc-base');
  const tx = safeTx(c.name);
  assert.deepEqual(mismatchAt(check(tx, impliedCard(c, tx, firstArg(tx) - 1n))), ['multiSend[0].approve.value', 'multiSend[1].deposit.assets']);
});

test('a deposit card naming a Morpho vault is refused before any check', () => {
  const tx = safeTx('fluid-deposit-usdc-base');
  const result = resolveCard({ operations: [{ template: 'fluid/vault-deposit', values: { vault: 'steakhouse-prime-usdc-v2-0f51', amount: '1' } }] }, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.deepEqual(result.kind === 'refused' ? [result.reason, result.detail] : result.kind, ['wrong-protocol', 'steakhouse-prime-usdc-v2-0f51 is a vault of morpho-blue (its factory vault-v2-factory), not of fluid-lending']);
});

test('a withdrawal from shares the Safe does not own is a mismatch at the owner', () => {
  const c = caseNamed('fluid-withdraw-usdt-other-safe');
  const tx = safeTx(c.name);
  const bytes = hexToBytes(tx.data.slice(2));
  bytes.set(hexToBytes(OTHER.slice(2)), vaultArgs(tx) + 76);
  assert.deepEqual(mismatchAt(check(withData(tx, bytes), impliedCard(c, tx))), ['call.withdraw.owner']);
});

type SimFixture = { safeTx: string; transactionHash: Hex; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };

async function observations(name: string): Promise<{ tx: SafeTx; simulated: Observed; receipt: Observed }> {
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
  const expected = expectedChanges(resolved(tx, impliedCard(caseNamed(fixture.safeTx), tx)), templates, registry);
  assert.equal(expected.kind, 'expected');
  const watch = [...(expected as Extract<typeof expected, { kind: 'expected' }>).changes.keys()].filter((asset): asset is Address => asset !== 'eth');
  return {
    tx,
    simulated: observedOf(await simulateSafeTx(reader, { tx, parent, time: executed.time, watch, ends: [] })),
    receipt: observedOf(await observeExecuted(reader, fixture.transactionHash, tx, [])),
  };
}

const executedOf = (observed: Observed) => observed as Extract<Observed, { kind: 'executed' }>;
const judge = (tx: SafeTx, observed: Observed, card: Card): EffectVerdict => judgeEffects(observed, resolved(tx, card), templates, registry);

test('a USDT deposit gives exactly the card amount for fUSDT, and its exact approval, which returns no value, is spent', async () => {
  const c = caseNamed('fluid-deposit-usdt-base');
  const { tx, simulated, receipt } = await observations('fluid-deposit-usdt-base');
  for (const observed of [simulated, receipt]) {
    const { tokens, allowances } = executedOf(observed);
    assert.equal(tokens.get(addressOf('usdt')), -firstArg(tx));
    assert.ok((tokens.get(addressOf('fluid-fusdt')) ?? 0n) > 0n);
    assert.deepEqual(allowances, [{ token: addressOf('usdt'), spender: addressOf('fluid-fusdt'), before: 0n, after: 0n }]);
    assert.deepEqual(judge(tx, observed, impliedCard(c, tx)), { kind: 'match' });
  }
  const verdict = judge(tx, receipt, impliedCard(c, tx, firstArg(tx) + 1n));
  assert.deepEqual(verdict, {
    kind: 'mismatch',
    findings: [{ kind: 'balance', asset: addressOf('usdt'), expected: { kind: 'exactly', change: -(firstArg(tx) + 1n) }, actual: -firstArg(tx) }],
  });
});

test('an approval the deposit leaves open is a mismatch', async () => {
  const c = caseNamed('fluid-deposit-usdt-base');
  const { tx, receipt } = await observations('fluid-deposit-usdt-base');
  const open = { token: addressOf('usdt'), spender: addressOf('fluid-fusdt'), before: 0n, after: 1n };
  assert.deepEqual(judge(tx, { ...executedOf(receipt), allowances: [open] }, impliedCard(c, tx)), { kind: 'mismatch', findings: [{ kind: 'open-allowance', ...open }] });
});

test('a withdrawal gets exactly the card amount of USDT and must give up some fUSDT', async () => {
  const c = caseNamed('fluid-withdraw-usdt-other-safe');
  const { tx, simulated, receipt } = await observations('fluid-withdraw-usdt-other-safe');
  for (const observed of [simulated, receipt]) {
    assert.equal(executedOf(observed).tokens.get(addressOf('usdt')), firstArg(tx));
    assert.deepEqual(judge(tx, observed, impliedCard(c, tx)), { kind: 'match' });
  }
  const kept = new Map(executedOf(receipt).tokens);
  kept.delete(addressOf('fluid-fusdt'));
  assert.deepEqual(judge(tx, { ...executedOf(receipt), tokens: kept }, impliedCard(c, tx)), {
    kind: 'mismatch',
    findings: [{ kind: 'balance', asset: addressOf('fluid-fusdt'), expected: { kind: 'less-than', change: 0n }, actual: 0n }],
  });
});

test('a redemption gives exactly the card shares and must get some USDT back', async () => {
  const c = caseNamed('fluid-redeem-usdt');
  const { tx, simulated, receipt } = await observations('fluid-redeem-usdt');
  for (const observed of [simulated, receipt]) {
    assert.equal(executedOf(observed).tokens.get(addressOf('fluid-fusdt')), -firstArg(tx));
    assert.deepEqual(judge(tx, observed, impliedCard(c, tx)), { kind: 'match' });
  }
  const verdict = judge(tx, receipt, impliedCard(c, tx, firstArg(tx) - 1n));
  assert.equal(verdict.kind, 'mismatch');
});

test('a card that both deposits into and withdraws from one vault cannot state the shares, so it is unverifiable', async () => {
  const { tx, receipt } = await observations('fluid-withdraw-usdt-other-safe');
  const values = { vault: 'fluid-fusdt', amount: '1' };
  const card: Card = { operations: [{ template: 'fluid/vault-deposit', values }, { template: 'fluid/vault-withdraw', values }] };
  assert.equal(judge(tx, receipt, card).kind, 'unverifiable');
});
