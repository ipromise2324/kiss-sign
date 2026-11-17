import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

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
  operations: Array.from({ length: count }, () => ({ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc-v2-0f51', amount, 'min-shares': '1741863305677219101283940' } })),
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
    [(t) => (t.calls[0].merge = 'x'), 'calls[0].merge'],
    [(t) => ((t.calls[1].merge = 'x'), (t.calls[1].to = { card: 'vault' })), 'calls[1].merge'],
    [(t) => (t.effects.gets[0].amount = 'all'), 'effects.gets[0].amount'],
  ];
  for (const [edit, path] of cases) {
    const broken = structuredClone(rawTemplate);
    edit(broken);
    assert.throws(() => parseTemplate(broken, registry), (error: unknown) => error instanceof TemplateError && error.path === path, path);
  }
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
    assert.throws(() => parseTemplate(broken, registry), (error: unknown) => error instanceof TemplateError && error.path === path && problem.test(error.message), path);
  }
  const zero = structuredClone(rawTemplate);
  deposit(zero).receiver = { const: '0x0000000000000000000000000000000000000000' };
  assert.doesNotThrow(() => parseTemplate(zero, registry));
});

test('a computed card field reads one uint256 view with arguments bound to the card or the Safe, and a slippage in basis points', () => {
  const computed = (t: any) => t.card['min-shares'].computed;
  const at = 'card.min-shares.computed';
  const cases: [(t: any) => void, string, RegExp][] = [
    [(t) => (computed(t).read.args.assets = 'card.min-shares'), `${at}.read.args.assets`, /computed after this one or is this one/],
    [(t) => (computed(t).read.args.assets = 'card.vault'), `${at}.read.args.assets`, /is not an amount/],
    [(t) => (computed(t).read.args.assets = 'safe'), `${at}.read.args.assets`, /the Safe is an address/],
    [(t) => (computed(t).read.args.assets = '5'), `${at}.read.args.assets`, /must be "safe", card.<field> or a read/],
    [(t) => (computed(t).read.function = 'previewDeposit(uint256 assets) returns (uint256 shares, uint256 more)'), `${at}.read.function`, /exactly one uint256/],
    [(t) => (computed(t).read.function = 'convertToShares(bytes32 assets) returns (uint256 shares)'), `${at}.read.args.assets`, /neither address nor uint256/],
    [(t) => (computed(t).read.to = 'card.amount'), `${at}.read.to`, /must name a contract or market field/],
    [(t) => (computed(t).margin.why = 'ok\u001b[8m'), `${at}.margin.why`, /control or bidirectional character/],
    [(t) => (computed(t).bound = 'down'), `${at}.bound`, /not one of floor, ceiling/],
    [(t) => (computed(t).default.bps = 3.5), `${at}.default.bps`, /whole number of basis points/],
    [(t) => (computed(t).default.bps = 1001), `${at}.default.bps`, /from 0 to 1000/],
    [(t) => (computed(t).default.source = 'http://example.com'), `${at}.default.source`, /not an https URL/],
    [(t) => (computed(t).margin.why = ''), `${at}.margin.why`, /not a non-empty string/],
    [(t) => (computed(t).extra = 1), `${at}.extra`, /unexpected field/],
  ];
  for (const [edit, path, problem] of cases) {
    const broken = structuredClone(rawTemplate);
    edit(broken);
    assert.throws(() => parseTemplate(broken, registry), (error: unknown) => error instanceof TemplateError && error.path === path && problem.test(error.message), path);
  }
  const nested = structuredClone(rawTemplate);
  computed(nested).read.args.assets = { to: 'card.vault', function: 'balanceOf(address account) returns (uint256 shares)', args: { account: 'safe' } };
  assert.doesNotThrow(() => parseTemplate(nested, registry));
});

test('a template\'s reasons are keyed by language, each holding the same languages', () => {
  const margin = (t: any) => t.card['min-shares'].computed.margin;
  const mixed = structuredClone(rawTemplate);
  margin(mixed).why = { en: 'only English' };
  assert.throws(() => parseTemplate(mixed, registry), (error: unknown) => error instanceof TemplateError && error.path === 'template' && /same languages/.test(error.message));
  const unknown = structuredClone(rawTemplate);
  margin(unknown).why = { fr: 'non' };
  assert.throws(() => parseTemplate(unknown, registry), (error: unknown) => error instanceof TemplateError && error.path === 'card.min-shares.computed.margin.why');
});

test('every shipped template holds each reason in English and Traditional Chinese', () => {
  const plain = (raw: unknown, path: string): string[] => {
    if (Array.isArray(raw)) return raw.flatMap((item, i) => plain(item, `${path}[${i}]`));
    if (typeof raw !== 'object' || raw === null) return [];
    return Object.entries(raw).flatMap(([key, value]) => {
      const at = `${path}.${key}`;
      const isReason = ['why', 'merge', 'reason', 'proof', 'unread', 'route'].includes(key) || (key === 'free' && (typeof value === 'string' || 'en' in (value as object) || 'zh-TW' in (value as object)));
      if (!isReason) return plain(value, at);
      return typeof value === 'object' && value !== null && Object.keys(value).sort().join() === 'en,zh-TW' ? [] : [at];
    });
  };
  for (const id of readdirSync(join(ROOT, 'templates')).flatMap((protocol) => readdirSync(join(ROOT, 'templates', protocol)).map((operation) => `${protocol}/${operation}`))) {
    assert.deepEqual(plain(JSON.parse(readFileSync(join(ROOT, 'templates', id, 'template.json'), 'utf8')), id), []);
  }
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
    assert.throws(() => parseTemplate(broken, registry), (error: unknown) => error instanceof TemplateError && error.path === path && problem.test(error.message), path);
  }
  const scalar = structuredClone(fluid);
  claim(scalar).cumulativeAmount_ = { free: { proof: 'the leaf amount' } };
  claim(scalar).metadata_ = { const: `0x${'0a'.repeat(19)}` };
  assert.equal(parseTemplate(scalar, registry).id, 'fluid/rewards-claim');
});

test('a trailer allowance is at most 19 bytes, so a whole address never fits', () => {
  const at = (maxBytes: number) => {
    const raw = structuredClone(rawTemplate);
    raw.calls[1].trailer.maxBytes = maxBytes;
    return () => parseTemplate(raw, registry);
  };
  assert.doesNotThrow(at(19));
  assert.throws(at(20), (error: unknown) => error instanceof TemplateError && error.path === 'calls[1].trailer.maxBytes' && /from 1 to 19/.test(error.message));
});

test('a share price bound or equals names a card amount or an earlier uint argument, or the template fails to load', () => {
  const deposit = (t: any) => t.calls[1].args.bundle.items[1].fields.data.call.args;
  const at = 'calls[1].args.bundle.items[1].fields.data.call.args';
  const cases: [(t: any) => void, string][] = [
    [(t) => (deposit(t).maxSharePriceE27 = { maxSharePrice: { assets: 'card.vault', shares: 'card.min-shares' } }), `${at}.maxSharePriceE27.maxSharePrice.assets`],
    [(t) => (deposit(t).maxSharePriceE27 = { maxSharePrice: { assets: 'card.amount', shares: `${at}.maxSharePriceE27` } }), `${at}.maxSharePriceE27.maxSharePrice.shares`],
    [(t) => (t.calls[0].args.value = { equals: `${at}.assets` }), 'calls[0].args.value.equals'],
    [(t) => (deposit(t).receiver = { maxSharePrice: { assets: 'card.amount', shares: 'card.min-shares' } }), `${at}.receiver.maxSharePrice`],
  ];
  for (const [edit, path] of cases) {
    const broken = structuredClone(rawTemplate);
    edit(broken);
    assert.throws(() => parseTemplate(broken, registry), (error: unknown) => error instanceof TemplateError && error.path === path, path);
  }
  const earlier = structuredClone(rawTemplate);
  deposit(earlier).assets = { equals: 'calls[0].args.value' };
  assert.equal(parseTemplate(earlier, registry).id, 'morpho/vault-deposit');
});

test('the template parses its card fields and effects', () => {
  const [vault, amount, minShares] = [...template.card];
  assert.deepEqual(vault, ['vault', { kind: 'contract', scope: { registryKind: 'vault', protocol: 'morpho-blue' } }]);
  assert.deepEqual(amount, ['amount', { kind: 'amount', of: { field: 'vault', attribute: 'asset' }, computed: undefined, max: undefined }]);
  const [name, field] = minShares ?? assert.fail('min-shares');
  assert.equal(name, 'min-shares');
  assert.ok(field.kind === 'amount' && field.computed !== undefined);
  assert.deepEqual(field.of, { field: 'vault', attribute: undefined });
  assert.equal(field.computed.read.fn.signature, 'previewDeposit(uint256)');
  assert.deepEqual(field.computed.read.args, [{ kind: 'card', ref: { field: 'amount', attribute: undefined } }]);
  assert.equal(field.computed.bound, 'floor');
  assert.deepEqual(template.effects, {
    gives: [{ token: { field: 'vault', attribute: 'asset' }, amount: { kind: 'card', field: 'amount' }, to: undefined, tolerance: undefined }],
    gets: [{ token: { field: 'vault', attribute: undefined }, amount: { kind: 'positive' }, to: undefined, tolerance: undefined }],
    views: [],
    safe: undefined,
    approves: [],
    touches: [],
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
  assert.deepEqual(refusal(card({ vault: 'steakhouse-prime-usdc-v2-0f51', amount: '1.5' })), ['not-an-amount', 'operations[0].values.amount']);
  assert.deepEqual(refusal(card({ vault: 'steakhouse-prime-usdc-v2-0f51' })), ['missing-value', 'operations[0].values.amount']);
  assert.deepEqual(refusal({ operations: [{ template: 'morpho/vault-withdraw', values: {} }] }), ['unknown-template', 'operations[0]']);
});

test('a contract field that names its protocol takes only that protocol\'s entries of its kind', () => {
  const scoped = (slug: string) => parseTemplate({ ...rawTemplate, card: { ...rawTemplate.card, vault: { kind: 'contract', registryKind: 'vault', defillama: slug } } }, registry);
  const resolve = (slug: string, vault: string) => {
    const t = scoped(slug);
    const result = resolveCard({ operations: [{ template: t.id, values: { vault, amount: '1', 'min-shares': '1' } }] }, { ...context(), templates: new Map([[t.id, t]]) });
    return result.kind === 'refused' ? { reason: result.reason, at: result.at, detail: result.detail } : result.kind;
  };
  assert.equal(resolve('morpho-blue', 'steakhouse-prime-usdc-v2-0f51'), 'resolved');
  assert.deepEqual(resolve('morpho-blue', 'fluid-fusdc'), { reason: 'wrong-protocol', at: 'operations[0].values.vault', detail: 'fluid-fusdc is a vault of fluid-lending (its factory fluid-lending-factory), not of morpho-blue' });
  assert.deepEqual(resolve('fluid-lending', 'steakhouse-prime-usdc-v2-0f51'), { reason: 'wrong-protocol', at: 'operations[0].values.vault', detail: 'steakhouse-prime-usdc-v2-0f51 is a vault of morpho-blue (its factory vault-v2-factory), not of fluid-lending' });
  assert.deepEqual(resolve('fluid-lending', 'usdc'), { reason: 'wrong-contract-kind', at: 'operations[0].values.vault', detail: 'usdc is a token, not a vault' });
  assert.throws(() => scoped('fluid'), (e: unknown) => e instanceof TemplateError && e.message === 'card.vault.defillama: no registry vault belongs to the DefiLlama protocol "fluid"');
});

test('a card resolves an address kind through the Safe, the registry and the address book', () => {
  const recipients = parseTemplate({ ...rawTemplate, card: { ...rawTemplate.card, recipient: { kind: 'address' } } }, registry);
  const book = new Map([['alice', OTHER as Address]]);
  const resolveRecipient = (name: string, addressBook = book) => {
    const result = resolveCard(
      { operations: [{ template: recipients.id, values: { vault: 'steakhouse-prime-usdc-v2-0f51', amount: '1', 'min-shares': '1', recipient: name } }] },
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
  assert.equal(readFileSync(path, 'utf8'), '{"operations":[{"template":"morpho/vault-deposit","values":{"amount":"1800000000180","min-shares":"1741863305677219101283940","vault":"steakhouse-prime-usdc-v2-0f51"}}]}');
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
  raw['steakhouse-prime-usdc-v2-0f51'].attributes.asset = 'bundler3';
  assert.throws(() => parseRegistry(raw), (error: unknown) => error instanceof RegistryError && error.path === 'steakhouse-prime-usdc-v2-0f51.attributes.asset');
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

