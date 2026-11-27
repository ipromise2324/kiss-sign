import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../../src/card.ts';
import type { Card, ResolvedCard } from '../../src/card.ts';
import { encodeCall } from '../../src/decode/codec.ts';
import { MULTISEND, unwrapSafeTx } from '../../src/decode/multisend.ts';
import type { Unwrapped } from '../../src/decode/multisend.ts';
import { loadRegistry } from '../../src/registry.ts';
import { parseServiceTx } from '../../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../../src/safe/types.ts';
import { checkTemplateFields } from '../../src/template/check.ts';
import type { FieldCheck, Finding } from '../../src/template/check.ts';
import { TemplateError, loadTemplate, parseTemplate } from '../../src/template/template.ts';
import { repoWithTestFixtures } from '../repo-with-test-fixtures.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURES = repoWithTestFixtures();
const fixture = JSON.parse(readFileSync(join(FIXTURES, 'testdata', 'safe-tx', 'morpho-vault-deposit.json'), 'utf8'));
const deposit = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
const registry = loadRegistry(FIXTURES);
const template = loadTemplate(FIXTURES, 'morpho/vault-deposit-bundler3', registry);
const templates = new Map([[template.id, template]]);
const rawTemplate = JSON.parse(readFileSync(join(FIXTURES, 'templates', 'morpho', 'vault-deposit-bundler3', 'template.json'), 'utf8'));

const DEPOSIT_PATH = 'multiSend[1].multicall.bundle[1].data.erc4626Deposit';
const TRANSFER_PATH = 'multiSend[1].multicall.bundle[0].data.erc20TransferFrom';
const OTHER = '0x1111111111111111111111111111111111111111';

const depositCard = (amount = '1800000000180', count = 1): Card => ({
  operations: Array.from({ length: count }, () => ({ template: 'morpho/vault-deposit-bundler3', values: { vault: 'steakhouse-prime-usdc-v2-0f51', amount, 'min-shares': '1741863305677219101283940' } })),
});

function resolved(card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: deposit.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, card: Card = depositCard()): FieldCheck => checkTemplateFields(tx, resolved(card), templates, registry);

function findings(result: FieldCheck): readonly Finding[] {
  assert.equal(result.kind, 'mismatch', JSON.stringify(result));
  return (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings;
}

const depositBytes = (): Uint8Array => hexToBytes(deposit.data.slice(2));
const withData = (bytes: Uint8Array): SafeTx => ({ ...deposit, data: `0x${bytesToHex(bytes)}` as Hex });

function entries(): Uint8Array[] {
  const unwrapped = unwrapSafeTx(deposit) as Extract<Unwrapped, { kind: 'multisend' }>;
  return unwrapped.calls.map((call) => depositBytes().slice(...call.span));
}

const batch = (parts: readonly Uint8Array[]): SafeTx =>
  withData(encodeCall({ fn: MULTISEND, args: [{ kind: 'bytes', value: concatBytes(...parts), span: [0, 0] }], trailer: undefined }));

/** The 32-byte word that holds the Safe as the deposit's receiver, found by its value. */
function receiverWord(): number {
  const at = deposit.data.slice(2).indexOf(deposit.safe.slice(2));
  assert.ok(at > 0 && at % 2 === 0 && deposit.data.slice(2).indexOf(deposit.safe.slice(2), at + 1) === -1, 'the Safe appears once in the data');
  return at / 2 - 12;
}

test('a receiver changed to another address is a mismatch that points at the receiver bytes', () => {
  const bytes = depositBytes();
  const word = receiverWord();
  bytes.set(hexToBytes(OTHER.slice(2)), word + 12);
  assert.deepEqual(findings(check(withData(bytes))), [
    { callPath: DEPOSIT_PATH, arg: 'receiver', bytes: [word, word + 32], expected: deposit.safe, actual: OTHER },
  ]);
});

test('a transaction for another chain is a mismatch at chainId', () => {
  const found = findings(check({ ...deposit, chainId: 8453n }));
  assert.deepEqual(found.map((f) => [f.callPath, f.arg, f.expected, f.actual]), [['safeTx', 'chainId', '1', '8453']]);
});

test('a card with a different amount mismatches at every amount field', () => {
  const found = findings(check(deposit, depositCard('1800000000181')));
  assert.deepEqual(
    found.map((f) => [f.callPath, f.arg, f.expected, f.actual]),
    [
      ['multiSend[0].approve', 'value', '1800000000181', '1800000000180'],
      [TRANSFER_PATH, 'amount', '1800000000181', '1800000000180'],
      [DEPOSIT_PATH, 'assets', '1800000000181', '1800000000180'],
    ],
  );
});

test('a MultiSend call the card does not list is a mismatch', () => {
  const [approve, bundle] = entries();
  const found = findings(check(batch([approve!, bundle!, approve!])));
  assert.deepEqual(found.map((f) => [f.callPath, f.arg, f.expected]), [['multiSend[2]', 'call', 'no call']]);
});

test('a call the card needs but the MultiSend lacks is a mismatch', () => {
  const [approve] = entries();
  const found = findings(check(batch([approve!])));
  assert.deepEqual(found.map((f) => [f.callPath, f.arg, f.actual]), [['multiSend[1]', 'call', 'missing']]);
});

test('a batch card matches only the concatenation of its operations, in card order', () => {
  const [approve, bundle] = entries();
  assert.deepEqual(check(batch([approve!, bundle!, approve!, bundle!]), depositCard(undefined, 2)), { kind: 'match' });
  const swapped = findings(check(batch([approve!, approve!, bundle!, bundle!]), depositCard(undefined, 2)));
  assert.ok(swapped.some((f) => f.callPath === 'multiSend[1]' && f.arg === 'selector'));
  assert.ok(findings(check(deposit, depositCard(undefined, 2))).some((f) => f.callPath === 'multiSend[3]' && f.actual === 'missing'));
});

test('a function the template does not name, at a call it names, is a mismatch at the selector', () => {
  const bytes = depositBytes();
  const selector = receiverWord() - 3 * 32 - 4;
  assert.equal(bytesToHex(bytes.subarray(selector, selector + 4)), '6ef5eeae');
  bytes.set([0xde, 0xad, 0xbe, 0xef], selector);
  assert.deepEqual(findings(check(withData(bytes))).map((f) => [f.callPath, f.arg, f.bytes, f.actual]), [
    ['multiSend[1].multicall.bundle[1].data', 'selector', [selector, selector + 4], '0xdeadbeef'],
  ]);
});

test('a delegatecall to anything but an official MultiSend is a mismatch', () => {
  assert.deepEqual(findings(check({ ...deposit, to: OTHER as Address })).map((f) => [f.callPath, f.arg]), [['safeTx', 'to']]);
});

test('an address anywhere in the type tree is never free, and a constant address is only the zero address', () => {
  const deposit = (t: any) => t.calls[1].args.bundle.items[1].fields.data.call.args;
  const cases: [(t: any) => void, string, RegExp][] = [
    [(t) => (deposit(t).receiver = { free: 'x' }), 'calls[1].args.bundle.items[1].fields.data.call.args.receiver.free', /address is never free/],
    [(t) => (t.calls[1].args.bundle = { free: { proof: 'x' } }), 'calls[1].args.bundle.free', /address is never free/],
    [(t) => (t.calls[1].args.bundle.items[1] = { free: { unread: 'x' } }), 'calls[1].args.bundle.items[1].free', /address is never free/],
    [(t) => (deposit(t).receiver = { const: OTHER }), 'calls[1].args.bundle.items[1].fields.data.call.args.receiver.const', /zero address/],
    [(t) => (t.calls[0].to = { const: OTHER }), 'calls[0].to.const', /zero address/],
  ];
  for (const [edit, path, problem] of cases) {
    const broken = structuredClone(rawTemplate);
    edit(broken);
    assert.throws(() => parseTemplate(broken, registry, 'committed'), (error: unknown) => error instanceof TemplateError && error.path === path && problem.test(error.message), path);
  }
  const zero = structuredClone(rawTemplate);
  deposit(zero).receiver = { const: '0x0000000000000000000000000000000000000000' };
  assert.doesNotThrow(() => parseTemplate(zero, registry, 'committed'));
});

test('bytes, a string or an array is free only with a proof or unread claim, and constant bytes hold at most 19 bytes', () => {
  const fixtures = repoWithTestFixtures();
  const registry = loadRegistry(fixtures);
  const fluid = JSON.parse(readFileSync(join(fixtures, 'templates', 'fluid', 'rewards-claim', 'template.json'), 'utf8'));
  const claim = (t: any) => t.calls[0].args;
  const at = 'calls[0].args';
  const cases: [(t: any) => void, string, RegExp][] = [
    [(t) => (claim(t).merkleProof_ = { free: 'x' }), `${at}.merkleProof_.free`, /needs \{"proof": why\} or \{"unread": why\}/],
    [(t) => (claim(t).metadata_ = { free: 'x' }), `${at}.metadata_.free`, /needs \{"proof": why\} or \{"unread": why\}/],
    [(t) => (claim(t).merkleProof_ = { free: { trust: 'x' } }), `${at}.merkleProof_.free`, /exactly one of proof, unread/],
    [(t) => (claim(t).metadata_ = { const: `0x${'00'.repeat(20)}` }), `${at}.metadata_.const`, /at most 19 bytes, so no whole address fits/],
  ];
  for (const [edit, path, problem] of cases) {
    const broken = structuredClone(fluid);
    edit(broken);
    assert.throws(() => parseTemplate(broken, registry, 'committed'), (error: unknown) => error instanceof TemplateError && error.path === path && problem.test(error.message), path);
  }
  const scalar = structuredClone(fluid);
  claim(scalar).cumulativeAmount_ = { free: { proof: 'the leaf amount' } };
  claim(scalar).metadata_ = { const: `0x${'0a'.repeat(19)}` };
  assert.equal(parseTemplate(scalar, registry, 'committed').id, 'fluid/rewards-claim');
});

test('a trailer allowance is at most 19 bytes, so a whole address never fits', () => {
  const at = (maxBytes: number) => {
    const raw = structuredClone(rawTemplate);
    raw.calls[1].trailer.maxBytes = maxBytes;
    return () => parseTemplate(raw, registry, 'committed');
  };
  assert.doesNotThrow(at(19));
  assert.throws(at(20), (error: unknown) => error instanceof TemplateError && error.path === 'calls[1].trailer.maxBytes' && /from 1 to 19/.test(error.message));
});
