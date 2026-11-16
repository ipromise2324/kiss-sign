import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadRegistry } from '../src/registry.ts';
import type { Ledger, Result } from '../src/research/ledger.ts';
import { NotesError, fieldKeys, mergeNotes, notesChanges, notesPath, notesScope, parseNotes, readNotes } from '../src/research/notes.ts';
import type { NotesScope } from '../src/research/notes.ts';
import type { ProtocolFacts } from '../src/research/protocol-facts.ts';
import { entriesOf, loadReport } from '../src/research/report.ts';
import type { ReportInputs } from '../src/research/report.ts';
import { loadTemplate } from '../src/template/template.ts';
import { vaultReportDir } from '../src/template/vault-reports.ts';
import { fixtureRoot } from './fixture-root.ts';

const ROOT = fixtureRoot();
const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, 'morpho/market-supply', registry);

const SCOPE: NotesScope = {
  calls: 2,
  contracts: new Set(['usdc', 'blue-bundles-v1', 'morpho-blue']),
  entries: new Set(['usdc', 'morpho-blue', 'cbbtc']),
  protocols: new Map([['morpho-blue', 1]]),
  fields: ['1.approve.spender', '2.blueBundlesV1Supply.marketParams', '2.blueBundlesV1Supply.marketParams.oracle'],
  reviews: ['morpho-oracle/source.page'],
};

const NOTE = { text: '說明', sources: ['https://docs.morpho.org/'] };
const VALID = {
  title: '供應 USDC 到 Morpho 市場',
  summary: '摘要',
  verdict: { status: 'caution', text: '要小心' },
  flow: [{ after: 2, from: 'blue-bundles-v1', to: 'morpho-blue', text: 'Bundler 呼叫 supply' }],
  protocols: { 'morpho-blue': { intro: '借貸協議', audits: NOTE, incidents: [NOTE] } },
  judgments: [{ text: '判斷', recommendation: '建議' }],
  reviews: { 'morpho-oracle/source.page': { status: 'concern', text: '頁面要跑 JavaScript', recommendation: '在瀏覽器打開' } },
  entries: { usdc: { role: '借出的代幣', sources: [{ text: 'Etherscan', url: 'https://etherscan.io/', result: 'pass' }] }, cbbtc: {} },
  fields: { '1.approve.spender': '誰可以拿走代幣', '2.blueBundlesV1Supply.marketParams': '市場', '2.blueBundlesV1Supply.marketParams.oracle': '價格來源' },
};

type Json = Record<string, unknown>;
/** VALID with the value at `path` replaced, or removed when `value` is undefined. */
function edited(path: readonly (string | number)[], value: unknown): Json {
  const copy = structuredClone(VALID) as Json;
  let at = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  const last = path.at(-1) as string | number;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

const refused = (raw: unknown, message: string) =>
  assert.throws(
    () => parseNotes(raw, SCOPE),
    (error: unknown) => error instanceof NotesError && error.message === message,
  );

test('valid notes parse, in the scope order, with fields as plain strings', () => {
  const notes = parseNotes(VALID, SCOPE);
  assert.equal(notes.verdict.status, 'caution');
  assert.equal(notes.fields.get('2.blueBundlesV1Supply.marketParams.oracle'), '價格來源');
  assert.deepEqual([...notes.fields.keys()], SCOPE.fields);
  assert.equal(notes.entries?.get('usdc')?.role, '借出的代幣');
  assert.equal(notes.entries?.get('cbbtc')?.role, undefined);
  assert.deepEqual(notes.entries?.get('cbbtc')?.sources, []);
  assert.equal(notes.reviews.get('morpho-oracle/source.page')?.status, 'concern');
});

test('flow, judgments and entries may be left out', () => {
  const notes = parseNotes(edited(['entries'], undefined), SCOPE);
  assert.equal(notes.entries, undefined);
  assert.deepEqual(parseNotes(edited(['flow'], undefined), SCOPE).flow, []);
  assert.deepEqual(parseNotes(edited(['judgments'], undefined), SCOPE).judgments, []);
});

test('an unknown key is refused, at any level', () => {
  refused(edited(['overview'], []), 'notes.json: unknown key "overview"');
  refused(edited(['entries', 'usdc', 'notes'], []), 'notes.json.entries.usdc: unknown key "notes"');
  refused(edited(['protocols', 'morpho-blue', 'audits', 'title'], 'x'), 'notes.json.protocols.morpho-blue.audits: unknown key "title"');
});

test('a key an object inherits is refused as unknown, at any level', () => {
  refused(edited(['constructor'], 'x'), 'notes.json: unknown key "constructor"');
  refused(edited(['verdict', 'toString'], 'x'), 'notes.json.verdict: unknown key "toString"');
  refused(JSON.parse(`{"__proto__": {}, ${JSON.stringify(VALID).slice(1)}`), 'notes.json: unknown key "__proto__"');
  refused(edited(['protocols', 'constructor'], {}), 'notes.json.protocols: "constructor" is not a protocol the protocol facts cover');
  refused(edited(['fields', 'hasOwnProperty'], 'x'), 'notes.json.fields: "hasOwnProperty" is not an argument of the template');
});

test('a missing title, summary or verdict is refused', () => {
  refused(edited(['title'], undefined), 'notes.json: title is missing');
  refused(edited(['verdict', 'text'], undefined), 'notes.json.verdict: text is missing');
});

test('a flow line after a call the template does not make is refused', () => {
  refused(edited(['flow', 0, 'after'], 3), "notes.json.flow[0].after: not one of the template's 2 calls");
});

test('a flow line naming a contract no call or view targets is refused', () => {
  refused(edited(['flow', 0, 'to'], 'cbbtc'), 'notes.json.flow[0].to: "cbbtc" is not a contract the calls or the effects\' views target, nor a token the effects move');
});

test('more than four flow lines or judgments are refused', () => {
  refused(edited(['flow'], Array(5).fill(VALID.flow[0])), 'notes.json.flow: more than 4 items');
  refused(edited(['judgments'], Array(5).fill(VALID.judgments[0])), 'notes.json.judgments: more than 4 items');
});

test('a protocol the facts do not cover is refused, and a covered one must have notes', () => {
  refused(edited(['protocols', 'aave'], VALID.protocols['morpho-blue']), 'notes.json.protocols: "aave" is not a protocol the protocol facts cover');
  refused(edited(['protocols', 'morpho-blue'], undefined), 'notes.json.protocols: morpho-blue is missing');
});

test('an incident list whose length differs from the hacks DefiLlama lists is refused', () => {
  refused(edited(['protocols', 'morpho-blue', 'incidents'], []), 'notes.json.protocols.morpho-blue: incidents lists 0; DefiLlama lists 1 hacks');
  assert.doesNotThrow(() => parseNotes(edited(['protocols', 'morpho-blue', 'incidents'], []), { ...SCOPE, protocols: new Map([['morpho-blue', 'unread']]) }));
});

test('an entry the report does not cover is refused', () => {
  refused(edited(['entries', 'weth'], {}), 'notes.json.entries: "weth" is not a registry entry this report covers');
});

test('a field key the template lacks is refused, and every argument needs a line', () => {
  refused(edited(['fields', '1.approve.amount'], 'x'), 'notes.json.fields: "1.approve.amount" is not an argument of the template');
  refused(edited(['fields', '2.blueBundlesV1Supply.marketParams.oracle'], undefined), 'notes.json.fields: 2.blueBundlesV1Supply.marketParams.oracle is missing');
});

test('a review of a result not for the signer is refused, and each result for the signer needs one', () => {
  refused(edited(['reviews', 'usdc/source.page'], VALID.reviews['morpho-oracle/source.page']), 'notes.json.reviews: "usdc/source.page" is not a result the signer must look at');
  refused(edited(['reviews', 'morpho-oracle/source.page'], undefined), 'notes.json.reviews: morpho-oracle/source.page is missing');
});

test('a source that is not an https URL is refused', () => {
  refused(edited(['protocols', 'morpho-blue', 'audits', 'sources'], ['http://docs.morpho.org/']), 'notes.json.protocols.morpho-blue.audits.sources[0]: not an https URL in RFC 3986 characters');
});

test('a control or bidirectional character is refused', () => {
  for (const mark of ['\u202e', '\u200e', '\u200f', '\u061c']) refused(edited(['summary'], `a${mark}b`), 'notes.json.summary: holds a control or bidirectional character');
});

test('text over its limit is refused: 2,000, 300 for a review, 200 for a judgment, role, recommendation, intro or AI source, 100 for a title, flow line or verdict', () => {
  const over = (n: number) => 'x'.repeat(n + 1);
  refused(edited(['summary'], over(2000)), 'notes.json.summary: longer than 2000 characters');
  refused(edited(['fields', '1.approve.spender'], over(2000)), 'notes.json.fields.1.approve.spender: longer than 2000 characters');
  refused(edited(['reviews', 'morpho-oracle/source.page', 'text'], over(300)), 'notes.json.reviews.morpho-oracle/source.page.text: longer than 300 characters');
  refused(edited(['judgments', 0, 'text'], over(200)), 'notes.json.judgments[0].text: longer than 200 characters');
  refused(edited(['entries', 'usdc', 'role'], over(200)), 'notes.json.entries.usdc.role: longer than 200 characters');
  refused(edited(['reviews', 'morpho-oracle/source.page', 'recommendation'], over(200)), 'notes.json.reviews.morpho-oracle/source.page.recommendation: longer than 200 characters');
  refused(edited(['protocols', 'morpho-blue', 'intro'], over(200)), 'notes.json.protocols.morpho-blue.intro: longer than 200 characters');
  refused(edited(['entries', 'usdc', 'sources', 0, 'text'], over(200)), 'notes.json.entries.usdc.sources[0].text: longer than 200 characters');
  refused(edited(['title'], over(100)), 'notes.json.title: longer than 100 characters');
  refused(edited(['flow', 0, 'text'], over(100)), 'notes.json.flow[0].text: longer than 100 characters');
  refused(edited(['verdict', 'text'], over(100)), 'notes.json.verdict.text: longer than 100 characters');
});

test('a backtick code span around one identifier is accepted, and its backticks do not count toward the limit', () => {
  for (const text of ['依序呼叫 `erc20TransferFrom` 和 `erc4626Deposit`', '`supply()` 進 market', '`_spender` 是 adapter']) assert.equal(parseNotes(edited(['flow', 0, 'text'], text), SCOPE).flow[0]?.text, text);
  const full = `\`${'x'.repeat(98)}\``;
  assert.equal(parseNotes(edited(['flow', 0, 'text'], full), SCOPE).flow[0]?.text, full);
});

test('a backtick that is not closed or wraps anything but one identifier is refused', () => {
  const message = 'notes.json.summary: holds a backtick that does not open or close a code span around one identifier, such as `erc4626Deposit`';
  for (const text of ['呼叫 `multicall', '`a b`', '`<b>x</b>`', '``', '`1abc`', '`f(x)`', '`a.b`', '`https://x`']) refused(edited(['summary'], text), message);
});

test('a status, verdict or AI source result outside its words is refused', () => {
  refused(edited(['verdict', 'status'], 'ok'), 'notes.json.verdict.status: not one of safe, caution');
  refused(edited(['entries', 'usdc', 'sources', 0, 'result'], 'ok'), 'notes.json.entries.usdc.sources[0].result: not one of pass, attention, fail');
});

const VAULT_PATH = 'templates/morpho/vault-deposit/vaults/v/notes.json';
/** What these vault notes may name, as if each entry they review or describe were the vault or its factory. */
const OWNED = new Set(['usdc', 'cbbtc', 'morpho-oracle']);
const SHARED = Object.fromEntries(Object.entries(VALID).filter(([key]) => key !== 'verdict'));
const mergeRefused = (vault: unknown, message: string) =>
  assert.throws(
    () => mergeNotes(SHARED, vault, VAULT_PATH, OWNED),
    (error: unknown) => error instanceof NotesError && error.message === message,
  );

test("a vault's notes join the template's: its verdict, judgments after the shared ones, and reviews and entries by name", () => {
  const shared = { ...SHARED, reviews: {}, entries: { usdc: { role: '借出的代幣' } } };
  const vault = { verdict: VALID.verdict, judgments: [{ text: '這個 vault', recommendation: '先送小額' }], reviews: VALID.reviews, entries: { cbbtc: { role: '抵押品' } } };
  const notes = parseNotes(mergeNotes(shared, vault, VAULT_PATH, OWNED), SCOPE);
  assert.equal(notes.verdict.text, '要小心');
  assert.deepEqual(notes.judgments.map((j) => j.text), ['判斷', '這個 vault']);
  assert.deepEqual([...notes.reviews.keys()], ['morpho-oracle/source.page']);
  assert.deepEqual([...(notes.entries?.keys() ?? [])], ['usdc', 'cbbtc']);
});

test("a key or name both notes define is refused, and a vault's notes hold only verdict, judgments, reviews and entries", () => {
  mergeRefused({ verdict: VALID.verdict, entries: { usdc: { role: '又一次' } } }, `${VAULT_PATH}.entries: "usdc" is in the template's notes.json too`);
  mergeRefused({ reviews: { 'morpho-oracle/source.page': VALID.reviews['morpho-oracle/source.page'] } }, `${VAULT_PATH}.reviews: "morpho-oracle/source.page" is in the template's notes.json too`);
  assert.throws(() => mergeNotes(VALID, { verdict: VALID.verdict }, VAULT_PATH, OWNED), (e: unknown) => e instanceof NotesError && e.message === `${VAULT_PATH}: verdict is in the template's notes.json too`);
  mergeRefused({ title: '別的標題' }, `${VAULT_PATH}: "title" belongs in the template's notes.json, which every vault's report shares`);
  mergeRefused(['verdict'], `${VAULT_PATH}: not a JSON object`);
});

test("a vault's notes review and describe only the vault and the entries its attributes name", () => {
  const owned = new Set(['vault-a', 'vault-factory']);
  const review = VALID.reviews['morpho-oracle/source.page'];
  const vault = { verdict: VALID.verdict, reviews: { 'vault-a/source.url': review, 'vault-factory/abi': review }, entries: { 'vault-a': { role: '金庫' }, 'vault-factory': { role: '工廠' } } };
  const merged = mergeNotes(SHARED, vault, VAULT_PATH, owned) as { entries: Record<string, unknown> };
  assert.deepEqual(Object.keys(merged.entries).slice(-2), ['vault-a', 'vault-factory']);
  const refusedFor = (notes: unknown, message: string) =>
    assert.throws(() => mergeNotes(SHARED, notes, VAULT_PATH, owned), (e: unknown) => e instanceof NotesError && e.message === message);
  const shared = "is not about vault-a or vault-factory; a shared contract belongs in the template's notes.json";
  refusedFor({ entries: { 'bundler3': { role: '共用' } } }, `${VAULT_PATH}.entries: "bundler3" ${shared}`);
  refusedFor({ reviews: { 'bundler3/abi': review } }, `${VAULT_PATH}.reviews: "bundler3/abi" ${shared}`);
  refusedFor({ reviews: { 'fixture.deposit': review } }, `${VAULT_PATH}.reviews: "fixture.deposit" ${shared}`);
});

test("a vault's notes may also describe the entries its attributes name, such as its asset, and no other", () => {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-notes-'));
  mkdirSync(join(root, vaultReportDir('fluid/vault-deposit', 'fluid-fusdt')), { recursive: true });
  writeFileSync(join(root, notesPath('fluid/vault-deposit')), JSON.stringify(SHARED));
  const write = (entries: unknown) => writeFileSync(join(root, notesPath('fluid/vault-deposit', 'fluid-fusdt')), JSON.stringify({ entries }));
  const fusdt = registry.entries.get('fluid-fusdt') ?? assert.fail('fluid-fusdt');
  write({ 'fluid-fusdt': { role: '金庫' }, usdt: { role: '存進去的代幣' } });
  assert.deepEqual(Object.keys((readNotes(root, 'fluid/vault-deposit', fusdt) as { entries: Record<string, unknown> }).entries).slice(-2), ['fluid-fusdt', 'usdt']);
  write({ usdc: { role: '別的代幣' } });
  assert.throws(() => readNotes(root, 'fluid/vault-deposit', fusdt), /entries: "usdc" is not about fluid-fusdt or usdt;/);
});

test('the judgments of both notes count toward the limit of four', () => {
  const judgment = { text: '判斷', recommendation: '建議' };
  const merged = mergeNotes({ ...SHARED, judgments: [judgment, judgment, judgment] }, { verdict: VALID.verdict, judgments: [judgment, judgment] }, VAULT_PATH, OWNED);
  assert.throws(() => parseNotes(merged, SCOPE), (e: unknown) => e instanceof NotesError && e.message === 'notes.json.judgments: more than 4 items');
});

test("a vault's flow lines join the template's after them, and both count toward the limit of four", () => {
  const line = (text: string) => ({ after: 2, from: 'blue-bundles-v1', to: 'morpho-blue', text });
  const merged = mergeNotes({ ...SHARED, flow: [line('共用')] }, { verdict: VALID.verdict, flow: [line('這個金庫')] }, VAULT_PATH, OWNED);
  assert.deepEqual(parseNotes(merged, SCOPE).flow.map((f) => f.text), ['共用', '這個金庫']);
  const tooMany = mergeNotes({ ...SHARED, flow: [line('a'), line('b'), line('c')] }, { verdict: VALID.verdict, flow: [line('d'), line('e')] }, VAULT_PATH, OWNED);
  assert.throws(() => parseNotes(tooMany, SCOPE), (e: unknown) => e instanceof NotesError && e.message === 'notes.json.flow: more than 4 items');
});

test("a template's flow line that names the vault or its asset is refused, since another vault's report could not name it", () => {
  const shared = { ...SHARED, flow: [{ after: 2, from: 'blue-bundles-v1', to: 'usdc', text: '拉走資產' }] };
  assert.throws(() => mergeNotes(shared, undefined, VAULT_PATH, OWNED), (e: unknown) => e instanceof NotesError && e.message === `notes.json.flow: "usdc" differs per vault; its flow line belongs in ${VAULT_PATH}`);
});

test("--compare names a vault's notes.json too", () => {
  assert.deepEqual(notesChanges(['templates/morpho/vault-deposit/vaults/steakhouse-prime-usdc-v2-0f51/notes.json', 'templates/morpho/vault-deposit/vaults/x/report.generated.html']), [
    'templates/morpho/vault-deposit/vaults/steakhouse-prime-usdc-v2-0f51/notes.json',
  ]);
});

test('field keys walk every argument, tuple part, array item and nested call of the template', () => {
  assert.deepEqual(fieldKeys(template).slice(0, 4), ['1.approve.spender', '1.approve.value', '2.blueBundlesV1Supply.marketParams', '2.blueBundlesV1Supply.marketParams.loanToken']);
  assert.ok(fieldKeys(template).includes('2.blueBundlesV1Supply.loanTokenPermit.data'));
  const bundles = fieldKeys(loadTemplate(ROOT, 'morpho/vault-withdraw-all', registry));
  assert.ok(bundles.includes('2.multicall.bundle[0].data.erc4626Redeem.shares'));
  assert.ok(bundles.includes('2.multicall.bundle[0].callbackHash'));
});

test('the scope of morpho/market-supply: its calls, their targets and views, its protocols, every field, and the results for the signer', () => {
  const subject = loadReport(ROOT, registry, { template: 'morpho/market-supply' }).subject;
  const entries = entriesOf(subject, registry);
  const result = (id: string, kind: 'agrees' | 'no-answer'): Result => ({ id, line: 'sources', about: { kind: 'entry', entry: entries[0]! }, source: { of: 'page', part: 'address' }, link: undefined, finding: { kind } });
  const ledger: Ledger = { entries, results: [result('usdc/source.page', 'agrees'), result('usdc/source.api', 'no-answer')] };
  const scope = notesScope({ registry, facts: undefined } as unknown as ReportInputs, ledger, template);
  assert.equal(scope.calls, 2);
  assert.deepEqual([...scope.contracts].sort(), ['blue-bundles-v1', 'morpho-blue', 'usdc']);
  assert.deepEqual(scope.entries, new Set(entries.map((e) => e.name)));
  assert.deepEqual(scope.protocols, new Map([['morpho-blue', 'unread']]));
  assert.deepEqual(scope.fields, fieldKeys(template));
  assert.deepEqual(scope.reviews, ['usdc/source.api']);
  const facts = { protocols: [{ slug: 'morpho-blue', listing: { kind: 'read', value: {} }, hacks: [{ date: '2024-10-01', amount: 230000 }], contracts: [] }] } as unknown as ProtocolFacts;
  assert.deepEqual(notesScope({ registry, facts } as unknown as ReportInputs, ledger, template).protocols, new Map([['morpho-blue', 1]]));
});
