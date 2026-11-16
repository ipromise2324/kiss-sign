import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { encodeCall, uintWord } from '../src/decode/codec.ts';
import { MULTISEND, OFFICIAL_MULTISEND } from '../src/decode/multisend.ts';
import { RegistryError, loadRegistry, parseRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { judgeEffects } from '../src/simulate/effects.ts';
import type { EffectVerdict, Observed } from '../src/simulate/effects.ts';
import { observeExecuted } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { TemplateError, loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const ROOT = repoWithTestFixtures();
const load = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>(
  ['erc20/transfer', 'eth/transfer', 'safe/cancel'].map((id) => [id, loadTemplate(ROOT, id, registry)]),
);
const OTHER = '0x1111111111111111111111111111111111111111' as Address;

function safeTx(name: string): SafeTx {
  const fixture = load('safe-tx', name);
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const withData = (tx: SafeTx, bytes: Uint8Array): SafeTx => ({ ...tx, data: `0x${bytesToHex(bytes)}` as Hex });

/** The recipient and amount words of an ERC-20 `transfer` call. */
function transferArgs(tx: SafeTx): { recipient: Address; amount: bigint } {
  const data = tx.data.slice(2);
  return { recipient: `0x${data.slice(32, 72)}` as Address, amount: BigInt(`0x${data.slice(72, 136)}`) };
}

function resolved(tx: SafeTx, card: Card, book: Record<string, Address> = {}): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(Object.entries(book)), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

type Case = { readonly name: string; readonly tx: SafeTx; readonly card: Card; readonly book: Record<string, Address>; readonly bound: number };

function erc20Case(name: string, token: string): Case {
  const tx = safeTx(name);
  const { recipient, amount } = transferArgs(tx);
  const card = { operations: [{ template: 'erc20/transfer', values: { token, amount: `${amount}`, recipient: 'payee' } }] };
  return { name, tx, card, book: { payee: recipient }, bound: 4 };
}

function ethCase(name: string): Case {
  const tx = safeTx(name);
  const card = { operations: [{ template: 'eth/transfer', values: { amount: `${tx.value}`, recipient: 'payee' } }] };
  return { name, tx, card, book: { payee: tx.to }, bound: 2 };
}

function cancelCase(name: string): Case {
  const tx = safeTx(name);
  return { name, tx, card: { operations: [{ template: 'safe/cancel', values: { nonce: `${tx.nonce}` } }] }, book: {}, bound: 3 };
}

const CASES: readonly Case[] = [
  erc20Case('erc20-transfer-usdc', 'usdc'),
  erc20Case('erc20-transfer-usdc-other-safe', 'usdc'),
  erc20Case('erc20-transfer-usdt', 'usdt'),
  ethCase('eth-transfer-null-data'),
  ethCase('eth-transfer-first-nonce'),
  cancelCase('safe-cancel'),
  cancelCase('safe-cancel-other-safe'),
];

const check = (c: Case, tx: SafeTx = c.tx, card: Card = c.card): FieldCheck => checkTemplateFields(tx, resolved(c.tx, card, c.book), templates, registry);

function mismatchAt(result: FieldCheck): string[] {
  assert.equal(result.kind, 'mismatch', JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v)));
  return (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => `${f.callPath}.${f.arg}`);
}

const caseNamed = (name: string): Case => CASES.find((c) => c.name === name) as Case;

for (const c of CASES) {
  test(`${c.name} matches its template with the card it implies`, () => {
    assert.deepEqual(check(c), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(c.tx, resolved(c.tx, c.card, c.book), templates, registry), { kind: 'pass', bound: c.bound, free: 0 });
  });
}

test('an ERC-20 transfer to another recipient, or of another amount, is a mismatch at that argument', () => {
  const c = caseNamed('erc20-transfer-usdc');
  const bytes = hexToBytes(c.tx.data.slice(2));
  const recipient = bytes.slice();
  recipient.set(hexToBytes(OTHER.slice(2)), 16);
  assert.deepEqual(mismatchAt(check(c, withData(c.tx, recipient))), ['call.transfer.to']);
  const amount = bytes.slice();
  amount.set(uintWord(transferArgs(c.tx).amount + 1n), 36);
  assert.deepEqual(mismatchAt(check(c, withData(c.tx, amount))), ['call.transfer.value']);
});

test('an ERC-20 transfer of another token than the card names is a mismatch at the call target', () => {
  const c = caseNamed('erc20-transfer-usdt');
  const card = { operations: [{ template: 'erc20/transfer', values: { ...c.card.operations[0]!.values, token: 'usdc' } }] };
  assert.deepEqual(mismatchAt(check(c, c.tx, card)), ['call.to']);
});

test('an ETH transfer to another recipient, of another amount, or with data, is a mismatch', () => {
  const c = caseNamed('eth-transfer-first-nonce');
  assert.deepEqual(mismatchAt(check(c, { ...c.tx, to: OTHER })), ['call.to']);
  assert.deepEqual(mismatchAt(check(c, { ...c.tx, value: c.tx.value + 1n })), ['call.value']);
  assert.deepEqual(mismatchAt(check(c, withData(c.tx, Uint8Array.of(0)))), ['call.data']);
});

test('a cancellation must carry the nonce the card names, go to the Safe, and send nothing', () => {
  const c = caseNamed('safe-cancel');
  const card = (nonce: bigint): Card => ({ operations: [{ template: 'safe/cancel', values: { nonce: `${nonce}` } }] });
  assert.deepEqual(mismatchAt(check(c, c.tx, card(c.tx.nonce + 1n))), ['safeTx.nonce']);
  assert.deepEqual(mismatchAt(check(c, { ...c.tx, to: OTHER })), ['call.to']);
  assert.deepEqual(mismatchAt(check(c, { ...c.tx, value: 1n })), ['call.value']);
  assert.deepEqual(mismatchAt(check(c, withData(c.tx, hexToBytes('a9059cbb')))), ['call.data']);
});

test('two ETH transfers in one official MultiSend match a card that lists both, in order', () => {
  const a = caseNamed('eth-transfer-null-data');
  const entry = (to: Address, value: bigint) => concatBytes(Uint8Array.of(0), hexToBytes(to.slice(2)), uintWord(value), uintWord(0n));
  const packed = concatBytes(entry(a.tx.to, 5n), entry(OTHER, 7n));
  const batch: SafeTx = {
    ...withData(a.tx, encodeCall({ fn: MULTISEND, args: [{ kind: 'bytes', value: packed, span: [0, 0] }], trailer: undefined })),
    to: OFFICIAL_MULTISEND[2]!.address,
    value: 0n,
    operation: 1,
  };
  const op = (amount: string, recipient: string) => ({ template: 'eth/transfer', values: { amount, recipient } });
  const book = { first: a.tx.to, second: OTHER };
  const judge = (card: Card) => checkTemplateFields(batch, resolved(a.tx, card, book), templates, registry);
  assert.deepEqual(judge({ operations: [op('5', 'first'), op('7', 'second')] }), { kind: 'match' });
  assert.deepEqual(mismatchAt(judge({ operations: [op('7', 'second'), op('5', 'first')] })), [
    'multiSend[0].to',
    'multiSend[0].value',
    'multiSend[1].to',
    'multiSend[1].value',
  ]);
});

type SimFixture = { transactionHash: Hex; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };
const ethSim: SimFixture = load('simulate', 'eth-transfer-null-data');

async function ethObservations(): Promise<{ simulated: Observed; receipt: Observed }> {
  const c = caseNamed('eth-transfer-null-data');
  const reader = replayReader(ethSim.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(ethSim.parent), await header(ethSim.executed)];
  const observedOf = (o: Observation): Observed => {
    assert.equal(o.kind, 'observed', o.kind === 'unverifiable' ? o.reasons.join('; ') : '');
    return (o as Extract<Observation, { kind: 'observed' }>).observed;
  };
  return {
    simulated: observedOf(await simulateSafeTx(reader, { tx: c.tx, parent, time: executed.time, watch: [], ends: [] })),
    receipt: observedOf(await observeExecuted(reader, ethSim.transactionHash, c.tx, [])),
  };
}

const ethOf = (observed: Observed): bigint => (observed as Extract<Observed, { kind: 'executed' }>).eth;

test('an executed ETH transfer gives exactly its card amount, measured by simulation and by the balance around its receipt', async () => {
  const c = caseNamed('eth-transfer-null-data');
  const { simulated, receipt } = await ethObservations();
  assert.equal(ethOf(simulated), -c.tx.value);
  assert.equal(ethOf(receipt), -c.tx.value);
  for (const observed of [simulated, receipt]) {
    assert.deepEqual(judgeEffects(observed, resolved(c.tx, c.card, c.book), templates, registry), { kind: 'match' });
  }
});

test('a card amount one wei higher than the ETH the Safe gave is a mismatch on ETH', async () => {
  const c = caseNamed('eth-transfer-null-data');
  const card = { operations: [{ template: 'eth/transfer', values: { amount: `${c.tx.value + 1n}`, recipient: 'payee' } }] };
  const { receipt } = await ethObservations();
  assert.deepEqual(judgeEffects(receipt, resolved(c.tx, card, c.book), templates, registry), {
    kind: 'mismatch',
    findings: [{ kind: 'balance', asset: 'eth', expected: { kind: 'exactly', change: -(c.tx.value + 1n) }, actual: -c.tx.value }],
  });
});

test('a transfer to the Safe itself expects no net change, and any change is a mismatch', () => {
  const c = caseNamed('eth-transfer-first-nonce');
  const executed = (eth: bigint, tokens: [Address, bigint][] = []): Observed => ({
    kind: 'executed',
    eth,
    tokens: new Map(tokens),
    allowances: [],
    permit2: [],
    ends: new Map(),
    safeState: { kind: 'receipt', logs: [] },
  });
  const usdc = registry.entries.get('usdc')!.address;
  const toSafe = (template: string, values: Record<string, string>): EffectVerdict =>
    judgeEffects(executed(0n, [[usdc, 0n]]), resolved(c.tx, { operations: [{ template, values: { ...values, recipient: 'safe' } }] }), templates, registry);
  assert.deepEqual(toSafe('eth/transfer', { amount: '100' }), { kind: 'match' });
  assert.deepEqual(toSafe('erc20/transfer', { token: 'usdc', amount: '100' }), { kind: 'match' });
  const card = resolved(c.tx, { operations: [{ template: 'eth/transfer', values: { amount: '100', recipient: 'safe' } }] });
  assert.equal(judgeEffects(executed(-100n), card, templates, registry).kind, 'mismatch');
});

test('a template names ETH as eth, never as a card field, and only what the Safe gives names a receiver', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'eth', 'transfer', 'template.json'), 'utf8'));
  const cases: [(t: any) => void, string][] = [
    [(t) => (t.calls[0].data = '0x'), 'calls[0].data'],
    [(t) => (t.calls[0].function = 'transfer(address to, uint256 value)'), 'calls[0].function'],
    [(t) => (t.effects.gives[0].token = 'card.eth'), 'effects.gives[0].token'],
    [(t) => (t.effects.gives[0].to = 'card.amount'), 'effects.gives[0].to'],
    [(t) => (t.effects.gets = [{ ...t.effects.gives[0] }]), 'effects.gets[0].to'],
    [(t) => (t.card.amount.of = 'recipient.asset'), 'card.amount.of'],
  ];
  for (const [edit, path] of cases) {
    const broken = structuredClone(raw);
    edit(broken);
    assert.throws(() => parseTemplate(broken, registry), (error: unknown) => error instanceof TemplateError && error.path === path, path);
  }
  assert.throws(() => parseRegistry({ eth: { address: OTHER, kind: 'token', source: 'https://example.com' } }), RegistryError);
});

test('a cancellation card refuses a value that is not a nonce', () => {
  const c = caseNamed('safe-cancel');
  const result = resolveCard({ operations: [{ template: 'safe/cancel', values: { nonce: '-1' } }] }, { templates, registry, addressBook: new Map(), safe: c.tx.safe });
  assert.deepEqual(result.kind === 'refused' ? [result.reason, result.at] : result.kind, ['not-a-nonce', 'operations[0].values.nonce']);
});

test('a transfer recipient must be the Safe or in the address book, never a registry contract', () => {
  const card: Card = { operations: [{ template: 'erc20/transfer', values: { token: 'usdc', amount: '1000000', recipient: 'usdt' } }] };
  const resolution = resolveCard(card, { templates, registry, addressBook: new Map(), safe: OTHER });
  assert.equal(resolution.kind, 'refused');
  assert.match(JSON.stringify(resolution), /not in the address book/);
  const toSelf = resolveCard({ operations: [{ template: 'eth/transfer', values: { amount: '1', recipient: 'safe' } }] }, { templates, registry, addressBook: new Map(), safe: OTHER });
  assert.equal(toSelf.kind, 'resolved');
});
