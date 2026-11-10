import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AddressBookError, loadAddressBook, parseAddressBook, saveAddressBook } from '../src/address-book.ts';
import { CardError, cardsDir, loadSealed, parseCard, resolveCard, sealCard } from '../src/card.ts';
import type { Card, CardContext, ResolvedCard } from '../src/card.ts';
import { encodeCall } from '../src/decode/codec.ts';
import { MULTISEND, OFFICIAL_MULTISEND, unwrapSafeTx } from '../src/decode/multisend.ts';
import type { Unwrapped } from '../src/decode/multisend.ts';
import { RegistryError, loadRegistry, parseRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck, Finding } from '../src/template/check.ts';
import { TemplateError, loadTemplate, parseTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', 'morpho-vault-deposit.json'), 'utf8'));
const deposit = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, 'morpho/vault-deposit', registry);
const templates = new Map([[template.id, template]]);
const rawTemplate = JSON.parse(readFileSync(join(ROOT, 'templates', 'morpho', 'vault-deposit', 'template.json'), 'utf8'));

const DEPOSIT_PATH = 'multiSend[1].multicall.bundle[1].data.erc4626Deposit';
const TRANSFER_PATH = 'multiSend[1].multicall.bundle[0].data.erc20TransferFrom';
const OTHER = '0x1111111111111111111111111111111111111111';

const context = (safe: Address = deposit.safe): CardContext => ({ templates, registry, addressBook: new Map(), safe });
const depositCard = (amount = '1800000000180', count = 1): Card => ({
  operations: Array.from({ length: count }, () => ({ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc', amount } })),
});

function resolved(card: Card): ResolvedCard {
  const result = resolveCard(card, context());
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

/** The deposit's packed MultiSend entries, so a test can rebuild the batch with entries added, dropped or repeated. */
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

test('the Morpho deposit matches its template and card', () => {
  assert.deepEqual(check(deposit), { kind: 'match' });
});

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

test('a non-canonical encoding is a mismatch with a pointer', () => {
  const bytes = concatBytes(depositBytes(), Uint8Array.of(0));
  assert.deepEqual(findings(check(withData(bytes))).map((f) => [f.callPath, f.arg, f.bytes]), [['safeTx', 'data', [bytes.length - 1, bytes.length]]]);
});

test('a delegatecall to anything but an official MultiSend is a mismatch', () => {
  assert.deepEqual(findings(check({ ...deposit, to: OTHER as Address })).map((f) => [f.callPath, f.arg]), [['safeTx', 'to']]);
});

test('a template that leaves an argument without a rule fails to load, naming the path', () => {
  const broken = structuredClone(rawTemplate);
  delete broken.calls[1].args.bundle.items[1].fields.data.call.args.receiver;
  assert.throws(() => parseTemplate(broken, registry), (error: unknown) => {
    assert.ok(error instanceof TemplateError);
    assert.equal(error.path, 'calls[1].args.bundle.items[1].fields.data.call.args.receiver');
    assert.match(error.message, /missing/);
    return true;
  });
});

test('a template rule that cannot bind its argument fails to load, naming the path', () => {
  const cases: [(t: any) => void, string][] = [
    [(t) => (t.calls[0].args.spender = { card: 'amount' }), 'calls[0].args.spender'],
    [(t) => (t.calls[0].args.value = { contract: 'not-registered' }), 'calls[0].args.value.contract'],
    [(t) => (t.calls[0].args.extra = { free: 'x' }), 'calls[0].args.extra'],
    [(t) => (t.calls[1].args.bundle.items[0].fields.skipRevert = { const: 'no' }), 'calls[1].args.bundle.items[0].fields.skipRevert.const'],
    [(t) => (t.calls[0].to = { card: 'amount.asset' }), 'calls[0].to.card'],
    [(t) => (t.calls[0].function = 'approve(address spender, uint7 value)'), 'calls[0].function'],
  ];
  for (const [edit, path] of cases) {
    const broken = structuredClone(rawTemplate);
    edit(broken);
    assert.throws(() => parseTemplate(broken, registry), (error: unknown) => error instanceof TemplateError && error.path === path, path);
  }
});

test('the template parses its card fields and effects', () => {
  assert.deepEqual([...template.card], [
    ['vault', { kind: 'contract', registryKind: 'vault' }],
    ['amount', { kind: 'amount', of: { field: 'vault', attribute: 'asset' } }],
  ]);
  assert.deepEqual(template.effects, {
    gives: [{ token: { field: 'vault', attribute: 'asset' }, amount: { kind: 'card', field: 'amount' } }],
    gets: [{ token: { field: 'vault', attribute: undefined }, amount: { kind: 'positive' } }],
  });
});

test('a card name the registry and address book do not know is refused', () => {
  const card = (values: Record<string, string>): Card => ({ operations: [{ template: 'morpho/vault-deposit', values }] });
  const refusal = (c: Card) => {
    const result = resolveCard(c, context());
    return result.kind === 'refused' ? [result.reason, result.at] : result.kind;
  };
  assert.deepEqual(refusal(card({ vault: 'no-such-vault', amount: '1' })), ['unknown-name', 'operations[0].values.vault']);
  assert.deepEqual(refusal(card({ vault: 'usdc', amount: '1' })), ['wrong-contract-kind', 'operations[0].values.vault']);
  assert.deepEqual(refusal(card({ vault: 'steakhouse-prime-usdc', amount: '1.5' })), ['not-an-amount', 'operations[0].values.amount']);
  assert.deepEqual(refusal(card({ vault: 'steakhouse-prime-usdc' })), ['missing-value', 'operations[0].values.amount']);
  assert.deepEqual(refusal({ operations: [{ template: 'morpho/vault-withdraw', values: {} }] }), ['unknown-template', 'operations[0]']);
});

test('a card resolves an address kind through the Safe, the registry and the address book', () => {
  const recipients = parseTemplate({ ...rawTemplate, card: { ...rawTemplate.card, recipient: { kind: 'address' } } }, registry);
  const book = new Map([['alice', OTHER as Address]]);
  const resolveRecipient = (name: string, addressBook = book) => {
    const result = resolveCard(
      { operations: [{ template: recipients.id, values: { vault: 'steakhouse-prime-usdc', amount: '1', recipient: name } }] },
      { templates: new Map([[recipients.id, recipients]]), registry, addressBook, safe: deposit.safe },
    );
    return result.kind === 'resolved' ? result.card.operations[0]?.values.get('recipient') : result.reason;
  };
  assert.deepEqual(resolveRecipient('alice'), { kind: 'address', name: 'alice', address: OTHER, from: 'address-book' });
  assert.deepEqual(resolveRecipient('safe'), { kind: 'address', name: 'safe', address: deposit.safe, from: 'safe' });
  assert.deepEqual(resolveRecipient('bundler3'), { kind: 'address', name: 'bundler3', address: '0x6566194141eefa99af43bb5aa71460ca2dc90245', from: 'registry' });
  assert.equal(resolveRecipient('bob'), 'unknown-name');
  assert.equal(resolveRecipient('usdc', new Map([['usdc', OTHER as Address]])), 'ambiguous-name');
});

test('a sealed card loads back, and a modified sealed file is refused', () => {
  const home = mkdtempSync(join(tmpdir(), 'kiss-sign-home-'));
  const card = depositCard();
  const hash = sealCard(home, card);
  const path = join(cardsDir(home), `${hash}.json`);
  assert.equal(readFileSync(path, 'utf8'), '{"operations":[{"template":"morpho/vault-deposit","values":{"amount":"1800000000180","vault":"steakhouse-prime-usdc"}}]}');
  assert.equal(sealCard(home, parseCard(JSON.parse(readFileSync(path, 'utf8')))), hash, 'sealing is idempotent');
  assert.deepEqual(loadSealed(home, hash), card);
  writeFileSync(path, readFileSync(path, 'utf8').replace('1800000000180', '1800000000181'));
  assert.throws(() => loadSealed(home, hash), (error: unknown) => error instanceof CardError && /was modified/.test(error.message));
  assert.throws(() => loadSealed(home, '../config'), CardError);
});

test('the registry lists exactly the official MultiSend deployments, and refuses an asset that is not a token', () => {
  const multisends = [...registry.entries.values()].filter((e) => e.kind === 'multisend').map((e) => e.address).sort();
  assert.deepEqual(multisends, OFFICIAL_MULTISEND.map((d) => d.address).sort());
  const raw = JSON.parse(readFileSync(join(ROOT, 'registry', 'contracts.json'), 'utf8'));
  raw['steakhouse-prime-usdc'].attributes.asset = 'bundler3';
  assert.throws(() => parseRegistry(raw), (error: unknown) => error instanceof RegistryError && error.path === 'steakhouse-prime-usdc.attributes.asset');
});

test('the address book saves and loads, and refuses a bad checksum', () => {
  const home = mkdtempSync(join(tmpdir(), 'kiss-sign-home-'));
  assert.deepEqual(loadAddressBook(home), new Map());
  const book = new Map([['alice', OTHER as Address], ['bob', deposit.safe]]);
  saveAddressBook(home, book);
  assert.deepEqual(loadAddressBook(home), book);
  assert.throws(() => parseAddressBook({ carol: '0xAf177c57e369bBD30F47745DbAAF1D225f4B74D0' }), AddressBookError);
  assert.throws(() => parseAddressBook({ safe: OTHER }), AddressBookError);
});

