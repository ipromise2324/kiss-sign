import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AbiProof, AbiRefusal } from '../src/contracts/prove.ts';
import { loadRegistry } from '../src/registry.ts';
import type { HttpsUrl, Registry, RegistryEntry } from '../src/registry.ts';
import type { ApiAnswer } from '../src/research/api-source.ts';
import { STATE_OF, addressRows, confidence, forSigner, judge, sourcesOf, stateOf, strip } from '../src/research/ledger.ts';
import type { FindingKind, Ledger, State } from '../src/research/ledger.ts';
import type { CoinGeckoCoin, DefiLlamaProtocol } from '../src/research/listings.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { replayInputs } from '../src/research/report.ts';
import type { ReportInputs, SpanCheck } from '../src/research/report.ts';
import { pageUrlOf } from '../src/research/source-page.ts';
import type { CommitCheck, Page } from '../src/research/source-page.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { judgeFixtures } from '../src/template/perturb.ts';
import type { FixtureJudgement, PerturbationReport, Run } from '../src/template/perturb.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const suffixes = loadPublicSuffixList();
const ADDRESS = `0x${'ab'.repeat(20)}` as Address;
const OTHER = `0x${'cd'.repeat(20)}` as Address;
const PIN = `0x${'11'.repeat(32)}` as Hex;
const SOURCE = 'https://docs.example.org/addresses' as HttpsUrl;
const GITHUB = `https://github.com/example/repo/blob/${'a'.repeat(40)}/addresses.md` as HttpsUrl;
const API = { url: 'https://api.example.org/vault' as HttpsUrl, method: 'GET', path: ['address'] } as const;
const APPROVE = (loadTemplate(ROOT, 'morpho/market-supply', loadRegistry(ROOT)).calls[0]?.data as Exclude<Template['calls'][number]['data'], 'empty'>).fn;
const DOC = 'https://docs.example.org/approve' as HttpsUrl;

const ENTRY: RegistryEntry = {
  name: 'vault',
  address: ADDRESS,
  kind: 'token',
  source: SOURCE,
  sourceLabel: 'Vault',
  attributes: {},
  defillama: 'proto',
  coingecko: 'vault-coin',
  code: { earlier: [], current: { from: 100n, pin: { hash: PIN } } },
};

const without = (key: 'sourceLabel' | 'code' | 'coingecko', entry: RegistryEntry = ENTRY): RegistryEntry => {
  const { [key]: _, ...rest } = entry;
  return rest;
};

type Setup = {
  readonly entry: RegistryEntry;
  readonly protocol: DefiLlamaProtocol | undefined;
  readonly coins: readonly CoinGeckoCoin[];
  readonly page: Page | undefined;
  readonly commit: CommitCheck | undefined;
  readonly api: ApiAnswer | undefined;
  readonly doc: Page | undefined;
  readonly abi: AbiProof | AbiRefusal | undefined;
  readonly spans: readonly SpanCheck[] | undefined;
  readonly documented: boolean;
  readonly fixtures: readonly FixtureJudgement[];
};

const BASE: Setup = {
  entry: ENTRY,
  protocol: { slug: 'proto', name: 'Proto', url: new URL('https://example.org'), github: ['example'] },
  coins: [{ id: 'vault-coin', symbol: 'v', name: 'Vault', ethereum: ADDRESS }],
  page: { kind: 'served', blocks: [{ text: `Vault ${ADDRESS}` }] },
  commit: { kind: 'on-default', branch: 'main', status: 'behind' },
  api: { kind: 'answered', json: { address: ADDRESS } },
  doc: { kind: 'served', blocks: [{ text: 'function approve(address spender, uint256 value)' }] },
  abi: { kind: 'proven', proxy: { kind: 'none' }, codeHash: PIN } as unknown as AbiProof,
  spans: [{ kind: 'pass', text: '' }],
  documented: true,
  fixtures: [],
};

const proven = (codeHash: Hex): AbiProof => ({ kind: 'proven', proxy: { kind: 'none' }, codeHash }) as unknown as AbiProof;
const refused = (refusal: object): AbiRefusal => ({ kind: 'refused', refusal }) as unknown as AbiRefusal;
const judged = (mutations: object, perturbation: PerturbationReport): FixtureJudgement => ({
  name: 'safe-tx-1',
  outcome: { kind: 'judged', mutations: mutations as never, perturbation },
});
const MUTATIONS_PASS = { kind: 'pass', bound: 3, free: 1 };
const PERTURB_PASS: PerturbationReport = { kind: 'pass', runs: [] };
const failedRuns = (...outcomes: Run['outcome'][]): PerturbationReport => {
  const runs = outcomes.map((outcome) => ({ outcome, leaf: { rule: { kind: 'free', claim: 'scalar' } }, value: '1', detail: '' }) as unknown as Run);
  return { kind: 'fail', runs, failed: runs };
};

/** A one-entry report: the entry, documented by one page for `approve`, as the template's only contract. */
function ledgerOf(change: Partial<Setup>): Ledger {
  const s = { ...BASE, ...change };
  const registry: Registry = { entries: new Map([[s.entry.name, s.entry]]), byAddress: new Map([[s.entry.address, s.entry]]), markets: new Map() };
  const template = { id: 'test/op', card: new Map(), nonce: undefined, same: [], calls: [], effects: { gives: [], gets: [], views: [] }, facts: [] } as Template;
  const inputs = {
    subject: s.documented ? { kind: 'template', template, docs: [{ fn: APPROVE, contract: s.entry, url: DOC }] } : { kind: 'vault', vault: s.entry },
    registry,
    listings: { protocols: new Map(s.protocol === undefined ? [] : [['proto', [s.protocol]]]), coinsByAddress: new Map([[ADDRESS, s.coins]]), suffixes },
    pages: {
      pages: new Map([...(s.page === undefined ? [] : [[pageUrlOf(s.entry.source), s.page] as const]), ...(s.doc === undefined ? [] : [[DOC, s.doc] as const])]),
      commits: new Map(s.commit === undefined ? [] : [[`example/repo@${'a'.repeat(40)}`, s.commit]]),
      apis: new Map(s.api === undefined ? [] : [[`GET ${API.url}`, s.api]]),
    },
    abi: new Map(s.abi === undefined ? [] : [[ADDRESS, s.abi]]),
    spans: new Map(s.spans === undefined ? [] : [[ADDRESS, s.spans]]),
  } as unknown as ReportInputs;
  return judge(inputs, s.fixtures);
}

const resultOf = (ledger: Ledger, id: string) => ledger.results.find((r) => r.id === id) ?? assert.fail(`no result ${id}: ${ledger.results.map((r) => r.id).join(', ')}`);

type Row = { readonly what: string; readonly change: Partial<Setup>; readonly id: string; readonly kind: FindingKind; readonly state: State };

const ROWS: readonly Row[] = [
  { what: 'the address next to its label', change: {}, id: 'vault/source.page', kind: 'agrees', state: 'ok' },
  { what: 'a source domain DefiLlama lists another site for', change: { protocol: { ...BASE.protocol!, url: new URL('https://other.org') } }, id: 'vault/source.site', kind: 'site-differs', state: 'bad' },
  { what: 'a GitHub org DefiLlama does not name', change: { entry: { ...ENTRY, source: GITHUB }, protocol: { ...BASE.protocol!, github: ['someone'] } }, id: 'vault/source.site', kind: 'site-differs', state: 'bad' },
  { what: 'another coin at the address', change: { coins: [{ id: 'other-coin', symbol: 'o', name: 'Other', ethereum: ADDRESS }] }, id: 'vault/source.coingecko', kind: 'other-coin', state: 'bad' },
  { what: 'an API answering another address', change: { entry: { ...ENTRY, apiSource: API }, api: { kind: 'answered', json: { address: OTHER } } }, id: 'vault/source.api', kind: 'other-answer', state: 'bad' },
  { what: 'an API answering nothing at its path', change: { entry: { ...ENTRY, apiSource: API }, api: { kind: 'answered', json: {} } }, id: 'vault/source.api', kind: 'other-answer', state: 'bad' },
  { what: 'an API answering a 404', change: { entry: { ...ENTRY, apiSource: API }, api: { kind: 'failed', why: 'HTTP 404' } }, id: 'vault/source.api', kind: 'other-answer', state: 'bad' },
  { what: 'an API with no answer', change: { entry: { ...ENTRY, apiSource: API }, api: { kind: 'unread', why: 'timeout' } }, id: 'vault/source.api', kind: 'no-answer', state: 'warn' },
  { what: 'a code pin the chain did not run', change: { spans: [{ kind: 'finding', text: '' }] }, id: 'vault/code.1', kind: 'pin-not-run', state: 'bad' },
  { what: 'a proof of code other than the pin', change: { abi: proven(`0x${'22'.repeat(32)}` as Hex) }, id: 'vault/abi', kind: 'proof-not-pin', state: 'bad' },
  { what: 'a proof refused for a reason other than its compiler', change: { abi: refused({ why: 'bytecode-mismatch' }) }, id: 'vault/abi', kind: 'refused', state: 'bad' },
  { what: 'a card the template now refuses', change: { fixtures: [{ name: 'safe-tx-1', outcome: { kind: 'card-refused', why: 'wrong-kind' } }] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'fields that no longer match', change: { fixtures: [judged({ kind: 'not-run', check: { kind: 'mismatch' } }, PERTURB_PASS)] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'fields the template or registry leaves UNVERIFIABLE', change: { fixtures: [judged({ kind: 'not-run', check: { kind: 'unverifiable', reasons: ['the registry has no usdc'] } }, PERTURB_PASS)] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'a bound field changed and not caught', change: { fixtures: [judged({ kind: 'weak-template', bound: 3, free: 1, uncaught: [{}] }, PERTURB_PASS)] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'a perturbation its claim forbids', change: { fixtures: [judged(MUTATIONS_PASS, failedRuns('changed', 'unverifiable'))] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'a perturbation whose transaction no longer executes', change: { fixtures: [judged(MUTATIONS_PASS, { kind: 'not-run', cause: 'not-executed', reason: 'reverted' })] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'a perturbation whose transaction as recorded got no answer', change: { fixtures: [judged(MUTATIONS_PASS, { kind: 'not-run', cause: 'unverifiable', reason: 'providers disagree' })] }, id: 'fixture.safe-tx-1', kind: 'no-answer', state: 'warn' },
  { what: 'perturbations failed only for want of an answer', change: { fixtures: [judged(MUTATIONS_PASS, failedRuns('unverifiable'))] }, id: 'fixture.safe-tx-1', kind: 'no-answer', state: 'warn' },
  { what: 'a recorded transaction judged as before', change: { fixtures: [judged(MUTATIONS_PASS, PERTURB_PASS)] }, id: 'fixture.safe-tx-1', kind: 'agrees', state: 'ok' },
  { what: 'a source page with no answer', change: { page: { kind: 'unread', why: 'timeout' } }, id: 'vault/source.page', kind: 'no-answer', state: 'warn' },
  { what: 'a page served without the address', change: { page: { kind: 'served', blocks: [{ text: 'Vault' }] } }, id: 'vault/source.page', kind: 'page-unread', state: 'warn' },
  { what: 'a page that answered a 404', change: { page: { kind: 'failed', why: 'HTTP 404' } }, id: 'vault/source.page', kind: 'page-unread', state: 'warn' },
  { what: 'an entry with no label', change: { entry: without('sourceLabel') }, id: 'vault/source.page', kind: 'page-unread', state: 'warn' },
  { what: 'a source URL holding the address', change: { entry: { ...ENTRY, source: `${SOURCE}/${ADDRESS}` as HttpsUrl } }, id: 'vault/source.url', kind: 'url-holds-address', state: 'warn' },
  { what: 'a slug DefiLlama does not list', change: { protocol: undefined }, id: 'vault/source.site', kind: 'site-not-compared', state: 'warn' },
  { what: 'no site listed and no coin to vouch', change: { protocol: { ...BASE.protocol!, url: undefined }, coins: [] }, id: 'vault/source.site', kind: 'no-second-source', state: 'warn' },
  { what: 'no coin at the address', change: { coins: [] }, id: 'vault/source.coingecko', kind: 'no-coin', state: 'warn' },
  { what: 'a commit off the default branch', change: { entry: { ...ENTRY, source: GITHUB }, commit: { kind: 'off-default', branch: 'main', status: 'diverged' } }, id: 'vault/source.commit', kind: 'commit-unconfirmed', state: 'warn' },
  { what: 'a documentation page not fetched', change: { doc: undefined }, id: 'vault/doc.0x095ea7b3.page', kind: 'page-not-fetched', state: 'warn' },
  { what: 'a documentation page without the name', change: { doc: { kind: 'served', blocks: [{ text: 'transfer' }] } }, id: 'vault/doc.0x095ea7b3.page', kind: 'name-not-on-page', state: 'warn' },
  { what: 'a documentation page naming the function', change: {}, id: 'vault/doc.0x095ea7b3.page', kind: 'agrees', state: 'ok' },
  { what: 'a span with no chain result', change: { spans: undefined }, id: 'vault/code.1', kind: 'no-chain-result', state: 'warn' },
  { what: 'a span with no answer', change: { spans: [{ kind: 'unverifiable', text: '' }] }, id: 'vault/code.1', kind: 'no-answer', state: 'warn' },
  { what: 'no ABI case', change: { abi: undefined }, id: 'vault/abi', kind: 'no-abi-case', state: 'warn' },
  { what: 'an entry with no code pin', change: { entry: without('code'), abi: undefined }, id: 'vault/code', kind: 'not-pinned', state: 'warn' },
  { what: 'a proof of an entry with no pin', change: { entry: without('code') }, id: 'vault/abi', kind: 'not-pinned', state: 'warn' },
  { what: 'no site listed, and CoinGecko vouches', change: { protocol: { ...BASE.protocol!, url: undefined } }, id: 'vault/source.site', kind: 'unlisted', state: 'na' },
  { what: 'a compiler not pinned', change: { abi: refused({ why: 'compiler-not-pinned', version: '0.8.99' }) }, id: 'vault/abi', kind: 'compiler-not-pinned', state: 'warn' },
  { what: 'a pin recorded before spans', change: { spans: [{ kind: 'not-read', text: '' }] }, id: 'vault/code.1', kind: 'pinned-before-spans', state: 'warn' },
];

for (const row of ROWS) {
  test(`${row.what}: ${row.id} is ${row.kind}, ${row.state}`, () => {
    const result = resultOf(ledgerOf(row.change), row.id);
    assert.equal(result.finding.kind, row.kind);
    assert.equal(stateOf(result), row.state);
  });
}

test('every finding kind has a row', () => {
  assert.deepEqual(new Set(ROWS.map((row) => row.kind)), new Set(Object.keys(STATE_OF)));
});

test('a source site DefiLlama lists nothing for is vouched by CoinGecko only, never by a documentation page or the API site', () => {
  const github = { entry: { ...ENTRY, source: GITHUB, apiSource: API }, protocol: { ...BASE.protocol!, github: [] } } as const;
  const ledger = ledgerOf({ ...github, coins: [] });
  assert.equal(resultOf(ledger, 'vault/doc.0x095ea7b3.site').finding.kind, 'agrees');
  assert.equal(resultOf(ledger, 'vault/source.api.site').finding.kind, 'agrees');
  assert.equal(resultOf(ledger, 'vault/source.site').finding.kind, 'no-second-source');
  assert.equal(resultOf(ledgerOf(github), 'vault/source.site').finding.kind, 'unlisted', 'CoinGecko lists the coin at the address');
});

test("a documentation page's site DefiLlama lists nothing for is vouched by the source page's site", () => {
  const github = { entry: { ...ENTRY, source: GITHUB }, protocol: { ...BASE.protocol!, url: undefined }, coins: [] } as const;
  const ledger = ledgerOf(github);
  assert.equal(resultOf(ledger, 'vault/source.site').finding.kind, 'agrees');
  assert.equal(resultOf(ledger, 'vault/doc.0x095ea7b3.site').finding.kind, 'unlisted');
  const unvouched = ledgerOf({ ...github, protocol: { ...BASE.protocol!, url: undefined, github: ['someone'] } });
  assert.equal(resultOf(unvouched, 'vault/doc.0x095ea7b3.site').finding.kind, 'no-second-source');
});

test('an API that agrees moves no other result: a page the program cannot read stays for the signer', () => {
  const ledger = ledgerOf({ entry: { ...ENTRY, apiSource: API }, page: { kind: 'served', blocks: [{ text: 'Vault' }] } });
  assert.equal(stateOf(resultOf(ledger, 'vault/source.api')), 'ok');
  assert.equal(stateOf(resultOf(ledger, 'vault/source.page')), 'warn');
  assert.equal(confidence(ledger, ENTRY), 'low');
  assert.deepEqual(
    sourcesOf(ledger, ENTRY).map((s) => [s.source, s.state, s.phrase, s.link]),
    [
      ['page', 'warn', '讀不到', SOURCE],
      ['api', 'ok', undefined, API.url],
      ['coingecko', 'ok', undefined, 'https://www.coingecko.com/en/coins/vault-coin'],
      ['defillama', 'ok', undefined, 'https://defillama.com/protocol/proto'],
    ],
  );
});

test('an address source line names a differing site, another address, or nothing to compare', () => {
  const phrase = (change: Partial<Setup>, source: string) => sourcesOf(ledgerOf(change), change.entry ?? ENTRY).find((s) => s.source === source)?.phrase;
  assert.equal(phrase({ protocol: { ...BASE.protocol!, url: new URL('https://other.org') } }, 'defillama'), '是另一個網站');
  assert.equal(phrase({ entry: { ...ENTRY, apiSource: API }, api: { kind: 'answered', json: { address: OTHER } } }, 'api'), '是另一個地址');
  assert.equal(phrase({ protocol: { ...BASE.protocol!, url: undefined } }, 'defillama'), '沒資料可比');
});

test('confidence: high when every result passed with a source page and a span, medium with a result not compared, low for the signer', () => {
  assert.equal(confidence(ledgerOf({}), ENTRY), 'high');
  assert.equal(confidence(ledgerOf({ protocol: { ...BASE.protocol!, url: undefined } }), ENTRY), 'medium');
  assert.equal(confidence(ledgerOf({ abi: refused({ why: 'compiler-not-pinned', version: '0.8.99' }) }), ENTRY), 'low');
  assert.equal(confidence(ledgerOf({ spans: [{ kind: 'not-read', text: '' }] }), ENTRY), 'low');
  assert.equal(confidence(ledgerOf({ spans: [{ kind: 'unverifiable', text: '' }] }), ENTRY), 'low');
});

test('the strip counts addresses and recorded transactions, each by the worst of its results on that line', () => {
  const ledger = ledgerOf({ protocol: { ...BASE.protocol!, url: new URL('https://other.org') }, abi: refused({ why: 'compiler-not-pinned', version: '0.8.99' }), fixtures: [judged(MUTATIONS_PASS, PERTURB_PASS)] });
  assert.deepEqual(strip(ledger), [
    { line: 'sources', state: 'bad', passed: 0, counted: 1 },
    { line: 'abi', state: 'warn', passed: 0, counted: 1 },
    { line: 'code', state: 'ok', passed: 1, counted: 1 },
    { line: 'params', state: 'ok', passed: 1, counted: 1 },
  ]);
});

test('待確認 lists red before amber, and an entry with no result for the signer folds', () => {
  const ledger = ledgerOf({ page: { kind: 'unread', why: 'timeout' }, spans: [{ kind: 'finding', text: '' }] });
  assert.deepEqual(forSigner(ledger).map((r) => r.id), ['vault/code.1', 'vault/source.page']);
  assert.deepEqual(addressRows(ledger).open.map((e) => e.name), ['vault']);
  assert.deepEqual(addressRows(ledgerOf({})).folded.map((e) => e.name), ['vault']);
  assert.deepEqual(forSigner(ledgerOf({})), []);
});

test('morpho/market-supply from its recordings: one address for the signer, the rest folded', { timeout: 600_000 }, async () => {
  const registry = loadRegistry(ROOT);
  const target = { template: 'morpho/market-supply' };
  const compilers = await warmCompilers(reportCases(ROOT, registry, [target]));
  const { inputs } = await replayInputs(ROOT, registry, target, compilers, suffixes);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail('a template report');
  const ledger = judge(inputs, await judgeFixtures(ROOT, template, registry));
  assert.deepEqual(forSigner(ledger).map((r) => [r.id, r.finding.kind]), [['morpho-oracle-cbbtc-usdc-86/source.page', 'page-unread']]);
  assert.equal(stateOf(resultOf(ledger, 'morpho-oracle-cbbtc-usdc-86/source.api')), 'ok');
  assert.equal(stateOf(resultOf(ledger, 'fixture.morpho-market-supply')), 'ok');
  assert.equal(resultOf(ledger, 'cbbtc/source.site').finding.kind, 'unlisted');
  assert.deepEqual(strip(ledger).map((s) => [s.line, s.state, `${s.passed}/${s.counted}`]), [
    ['sources', 'warn', '5/6'],
    ['abi', 'ok', '6/6'],
    ['code', 'ok', '6/6'],
    ['params', 'ok', '1/1'],
  ]);
  const rows = addressRows(ledger);
  assert.deepEqual(rows.open.map((e) => e.name), ['morpho-oracle-cbbtc-usdc-86']);
  assert.equal(rows.folded.length, 5);
  assert.deepEqual(
    ledger.entries.map((e) => [e.name, confidence(ledger, e)]),
    [
      ['usdc', 'medium'],
      ['morpho-blue', 'high'],
      ['blue-bundles-v1', 'high'],
      ['adaptive-curve-irm', 'high'],
      ['morpho-oracle-cbbtc-usdc-86', 'low'],
      ['cbbtc', 'medium'],
    ],
  );
});
