import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AddressBookError, loadAddressBook, parseAddressBook, saveAddressBook } from '../src/address-book.ts';
import { CardError, cardsDir, loadSealed, parseCard, resolveCard, sealCard } from '../src/card.ts';
import type { Card, CardContext, ResolvedCard } from '../src/card.ts';
import { OFFICIAL_MULTISEND } from '../src/decode/multisend.ts';
import { RegistryError, loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck, Finding } from '../src/template/check.ts';
import { TemplateError, loadTemplate, parseTemplate } from '../src/template/template.ts';
import { repoWithBundler3Deposit } from './bundler3-deposit.ts';
import { parseRegistryAt } from './registry-at.ts';

const ROOT = join(import.meta.dirname, '..');
const BUNDLER3 = repoWithBundler3Deposit();
const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', 'morpho-vault-deposit.json'), 'utf8'));
const deposit = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
const registry = loadRegistry(ROOT);
const template = loadTemplate(BUNDLER3, 'morpho/vault-deposit', registry);
const templates = new Map([[template.id, template]]);
const rawTemplate = JSON.parse(readFileSync(join(BUNDLER3, 'templates', 'morpho', 'vault-deposit', 'template.json'), 'utf8'));

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

test('the Morpho deposit matches its template and card', () => {
  assert.deepEqual(check(deposit), { kind: 'match' });
});

test('a non-canonical encoding is a mismatch with a pointer', () => {
  const bytes = concatBytes(depositBytes(), Uint8Array.of(0));
  assert.deepEqual(findings(check(withData(bytes))).map((f) => [f.callPath, f.arg, f.bytes]), [['safeTx', 'data', [bytes.length - 1, bytes.length]]]);
});

test('a template that leaves an argument without a rule fails to load, naming the path', () => {
  const broken = structuredClone(rawTemplate);
  delete broken.calls[1].args.bundle.items[1].fields.data.call.args.receiver;
  assert.throws(() => parseTemplate(broken, registry, 'committed'), (error: unknown) => {
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
    assert.throws(() => parseTemplate(broken, registry, 'committed'), (error: unknown) => error instanceof TemplateError && error.path === path, path);
  }
});

test('a computed card field reads a view with every argument bound as a view\'s is, picks one unsigned number, and adds a slippage in basis points', () => {
  const computed = (t: any) => t.card['min-shares'].computed;
  const at = 'card.min-shares.computed';
  const balance = { read: { to: { card: 'vault' }, function: 'balanceOf(address account) returns (uint256 shares)', args: { account: { safe: true } } } };
  const cases: [(t: any) => void, string, RegExp][] = [
    [(t) => (computed(t).read.args.assets = { card: 'min-shares' }), `${at}.read.args.assets`, /computed after this one or is this one/],
    [(t) => (computed(t).read.args.assets = { card: 'vault' }), `${at}.read.args.assets`, /a card rule cannot bind a uint256/],
    [(t) => (computed(t).read.args.assets = { safe: true }), `${at}.read.args.assets`, /a safe rule cannot bind a uint256/],
    [(t) => (computed(t).read.args.assets = { free: 'any' }), `${at}.read.args.assets`, /a view's argument is bound by card, safe, contract or const, not free/],
    [(t) => (computed(t).read.args.assets = 'amount'), `${at}.read.args.assets`, /not a JSON object/],
    [(t) => (computed(t).read.function = 'previewDeposit(uint128 assets) returns (uint256 shares)', (computed(t).read.args.assets = balance)), `${at}.read.args.assets.read`, /answers a uint256, which a uint128 parameter cannot hold/],
    [(t) => (computed(t).read.function = 'previewDeposit(uint256 assets) returns (uint256 shares, uint256 more)'), `${at}.read.output`, /names none of the 2 values the function returns/],
    [(t) => (computed(t).read.output = 'assets'), `${at}.read.output`, /"assets" is not a named return value or tuple component/],
    [(t) => (computed(t).read.function = 'asset(uint256 assets) returns (address token)'), `${at}.read.output`, /picks a value of type address; a computed amount is an unsigned integer/],
    [(t) => (computed(t).read.function = 'quote(uint256 assets) returns (int256 shares)'), `${at}.read.output`, /picks a value of type int256/],
    [(t) => (computed(t).read.function = 'previewDeposit(uint128 assets) returns (uint256 shares)'), `${at}.read.args.assets`, /card\.amount is a number passed whole, so only to a uint256, not a uint128/],
    [(t) => (computed(t).read.args.assets = { ...balance, card: 'amount' }), `${at}.read.args.assets.card`, /unexpected field/],
    [(t) => (computed(t).read.to = { card: 'amount' }), `${at}.read.to`, /a card rule cannot bind a address/],
    [(t) => (computed(t).read.to = { safe: true }), `${at}.read.to`, /must name a registry contract, or a contract or market field/],
    [(t) => (computed(t).read.to = { contract: 'no-such-contract' }), `${at}.read.to.contract`, /not in the contract registry/],
    [(t) => (computed(t).read.to = 'vault'), `${at}.read.to`, /not a JSON object/],
    [(t) => (computed(t).read.to = 'safe'), `${at}.read.to`, /must name a registry contract, or a contract or market field/],
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
    assert.throws(() => parseTemplate(broken, registry, 'committed'), (error: unknown) => error instanceof TemplateError && error.path === path && problem.test(error.message), path);
  }
  const nested = structuredClone(rawTemplate);
  computed(nested).read.args.assets = balance;
  assert.doesNotThrow(() => parseTemplate(nested, registry, 'committed'));
  const older = structuredClone(rawTemplate);
  computed(older).read = { to: 'card.vault', function: 'previewRedeem(uint256 shares) returns (uint256 assets)', args: { shares: { to: 'card.vault', function: 'balanceOf(address account) returns (uint256 shares)', args: { account: 'safe' } } } };
  const newer = structuredClone(rawTemplate);
  computed(newer).read = { to: { card: 'vault' }, function: 'previewRedeem(uint256 shares) returns (uint256 assets)', args: { shares: { read: { to: { card: 'vault' }, function: 'balanceOf(address account) returns (uint256 shares)', args: { account: { safe: true } } } } } };
  assert.deepEqual(parseTemplate(older, registry, 'committed'), parseTemplate(newer, registry, 'committed'), 'a template written before reads took rules reads the same');
  const curve = structuredClone(rawTemplate);
  computed(curve).read = {
    to: { contract: 'bundler3' },
    function: 'get_dy(int128 i, int128 j, uint256 dx) returns (uint256 dy)',
    args: { i: { const: '0' }, j: { const: '-1' }, dx: { card: 'amount' } },
  };
  assert.doesNotThrow(() => parseTemplate(curve, registry, 'committed'));
  const tuple = structuredClone(rawTemplate);
  computed(tuple).read.function = 'quote(uint256 assets) returns (address token, (uint128 fee, uint64 shares) best)';
  computed(tuple).read.output = 'best.shares';
  const field = parseTemplate(tuple, registry, 'committed').card.get('min-shares');
  assert.deepEqual(field?.kind === 'amount' ? field.computed?.read.output : undefined, [1, 1]);
});

test('a template\'s reasons are keyed by language, each holding the same languages', () => {
  const margin = (t: any) => t.card['min-shares'].computed.margin;
  const mixed = structuredClone(rawTemplate);
  margin(mixed).why = { en: 'only English' };
  assert.throws(() => parseTemplate(mixed, registry, 'committed'), (error: unknown) => error instanceof TemplateError && error.path === 'template' && /same languages/.test(error.message));
  const unknown = structuredClone(rawTemplate);
  margin(unknown).why = { fr: 'non' };
  assert.throws(() => parseTemplate(unknown, registry, 'committed'), (error: unknown) => error instanceof TemplateError && error.path === 'card.min-shares.computed.margin.why');
});

test('every shipped template holds each reason in English and Traditional Chinese', () => {
  const plain = (raw: unknown, path: string): string[] => {
    if (Array.isArray(raw)) return raw.flatMap((item, i) => plain(item, `${path}[${i}]`));
    if (typeof raw !== 'object' || raw === null) return [];
    return Object.entries(raw).flatMap(([key, value]) => {
      const at = `${path}.${key}`;
      const isReason = ['why', 'merge', 'reason', 'proof', 'unread', 'route', 'time'].includes(key) || (key === 'free' && (typeof value === 'string' || 'en' in (value as object) || 'zh-TW' in (value as object)));
      if (!isReason) return plain(value, at);
      return typeof value === 'object' && value !== null && Object.keys(value).sort().join() === 'en,zh-TW' ? [] : [at];
    });
  };
  for (const id of readdirSync(join(ROOT, 'templates')).flatMap((protocol) => readdirSync(join(ROOT, 'templates', protocol)).map((operation) => `${protocol}/${operation}`))) {
    assert.deepEqual(plain(JSON.parse(readFileSync(join(ROOT, 'templates', id, 'template.json'), 'utf8')), id), []);
  }
});

test('a share price bound or equals names a card amount or an earlier uint argument, or the template fails to load', () => {
  const deposit = (t: any) => t.calls[1].args.bundle.items[1].fields.data.call.args;
  const at = 'calls[1].args.bundle.items[1].fields.data.call.args';
  const cases: [(t: any) => void, string][] = [
    [(t) => (deposit(t).maxSharePriceE27 = { maxSharePrice: { assets: 'card.vault', shares: 'card.min-shares', scale: 27 } }), `${at}.maxSharePriceE27.maxSharePrice.assets`],
    [(t) => (deposit(t).maxSharePriceE27 = { maxSharePrice: { assets: 'card.amount', shares: `${at}.maxSharePriceE27`, scale: 27 } }), `${at}.maxSharePriceE27.maxSharePrice.shares`],
    [(t) => (t.calls[0].args.value = { equals: `${at}.assets` }), 'calls[0].args.value.equals'],
    [(t) => (deposit(t).receiver = { maxSharePrice: { assets: 'card.amount', shares: 'card.min-shares' } }), `${at}.receiver.maxSharePrice`],
  ];
  for (const [edit, path] of cases) {
    const broken = structuredClone(rawTemplate);
    edit(broken);
    assert.throws(() => parseTemplate(broken, registry, 'committed'), (error: unknown) => error instanceof TemplateError && error.path === path, path);
  }
  const earlier = structuredClone(rawTemplate);
  deposit(earlier).assets = { equals: 'calls[0].args.value' };
  assert.equal(parseTemplate(earlier, registry, 'committed').id, 'morpho/vault-deposit');
});

test('the template parses its card fields and effects', () => {
  const [vault, amount, minShares] = [...template.card];
  assert.deepEqual(vault, ['vault', { kind: 'contract', scope: { registryKind: 'vault', protocol: 'morpho-blue', marketPart: undefined, names: undefined } }]);
  assert.deepEqual(amount, ['amount', { kind: 'amount', of: { field: 'vault', attribute: 'asset' }, computed: undefined, max: undefined }]);
  const [name, field] = minShares ?? assert.fail('min-shares');
  assert.equal(name, 'min-shares');
  assert.ok(field.kind === 'amount' && field.computed !== undefined);
  assert.deepEqual(field.of, { field: 'vault', attribute: undefined });
  assert.equal(field.computed.read.fn.signature, 'previewDeposit(uint256)');
  assert.deepEqual(field.computed.read.args, [{ kind: 'bound', rule: { kind: 'card', ref: { field: 'amount', attribute: undefined } } }]);
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
  const scoped = (slug: string) => parseTemplate({ ...rawTemplate, card: { ...rawTemplate.card, vault: { kind: 'contract', registryKind: 'vault', defillama: slug } } }, registry, 'committed');
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
  const recipients = parseTemplate({ ...rawTemplate, card: { ...rawTemplate.card, recipient: { kind: 'address' } } }, registry, 'committed');
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
  assert.throws(() => parseRegistryAt(ROOT, raw), (error: unknown) => error instanceof RegistryError && error.path === 'steakhouse-prime-usdc-v2-0f51.attributes.asset');
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


test('a free number may be declared a time, and only a number may', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'cow', 'swap', 'template.json'), 'utf8'));
  const fields = (t: any) => t.calls[0].args.orderUid.packed[0].rule.eip712.fields;
  const why = { en: 'When the order expires.', 'zh-TW': '訂單到期的時間。' };
  const timed = structuredClone(raw);
  fields(timed).validTo = { free: { time: why } };
  const rule = parseTemplate(timed, registry, 'committed');
  assert.equal(rule.id, 'cow/swap');
  const bytes = structuredClone(raw);
  fields(bytes).appData = { free: { time: why } };
  assert.throws(
    () => parseTemplate(bytes, registry, 'committed'),
    (error: unknown) => error instanceof TemplateError && error.path.endsWith('fields.appData.free') && /a time is a number of seconds/.test(error.message),
  );
});

test('every committed template keeps each reason card new prints, a max\'s and a margin\'s, to at most 200 characters per language', () => {
  const root = join(import.meta.dirname, '..', 'templates');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('template.json') && !path.includes('instances'));
  assert.ok(files.length > 0);
  const long: string[] = [];
  for (const file of files) {
    const card: Record<string, any> = JSON.parse(readFileSync(join(root, file), 'utf8')).card ?? {};
    for (const [name, field] of Object.entries(card)) {
      for (const [at, why] of [['max.why', field?.max?.why], ['computed.margin.why', field?.computed?.margin?.why]] as const) {
        if (why === undefined) continue;
        for (const [language, written] of Object.entries(typeof why === 'string' ? { en: why } : why)) {
          if ((written as string).length > 200) long.push(`${file}: card.${name}.${at}.${language} has ${(written as string).length}`);
        }
      }
    }
  }
  assert.deepEqual(long, []);
});
