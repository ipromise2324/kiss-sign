import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, test } from 'node:test';
import type { AbiRefusal } from '../src/contracts/prove.ts';
import { loadRegistry } from '../src/registry.ts';
import { forSigner, judge, stateOf, worst } from '../src/research/ledger.ts';
import type { State } from '../src/research/ledger.ts';
import { NotesError, notesScope } from '../src/research/notes.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { buildPage } from '../src/research/report-page.ts';
import type { ArgRow, Body, HtmlInputs, Page } from '../src/research/report-page.ts';
import { replayInputs } from '../src/research/report.ts';
import type { ReportTitle } from '../src/research/report.ts';
import type { Address } from '../src/safe/types.ts';
import { firstRecordedTx, judgeFixtures } from '../src/template/perturb.ts';
import type { Template } from '../src/template/template.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const target = { template: 'morpho/market-supply' };
let inputs: HtmlInputs;
let title: ReportTitle;
let template: Template;

before(async () => {
  const compilers = await warmCompilers(reportCases(ROOT, registry, [target]));
  const replayed = await replayInputs(ROOT, registry, target, compilers, loadPublicSuffixList());
  title = replayed.title;
  template = replayed.inputs.subject.kind === 'template' ? replayed.inputs.subject.template : assert.fail('a template report');
  inputs = { ...replayed.inputs, fixtures: await judgeFixtures(ROOT, template, registry), example: firstRecordedTx(ROOT, template, registry) };
});

/** Notes that hold exactly what the scope requires, each text naming its key, so a page row can be traced to its note. */
function notesFor(of: HtmlInputs): Record<string, unknown> {
  const scope = notesScope(of, judge(of, of.fixtures), template);
  return {
    title: 'title',
    summary: 'summary',
    verdict: { status: 'caution', text: 'verdict' },
    flow: [{ after: 2, from: 'blue-bundles-v1', to: 'morpho-blue', text: 'supply' }],
    protocols: Object.fromEntries([...scope.protocols].map(([slug]) => [slug, { intro: `intro ${slug}`, audits: { text: 'audits' }, incidents: [] }])),
    judgments: [{ text: 'judgment', recommendation: 'small first' }],
    reviews: Object.fromEntries(scope.reviews.map((id) => [id, { status: 'concern', text: `review ${id}`, recommendation: 'look' }])),
    fields: Object.fromEntries(scope.fields.map((key) => [key, `field ${key}`])),
  };
}

const pageOf = (of: HtmlInputs): Page => buildPage(of, notesFor(of), title);
const body = <K extends Body['kind']>(page: Page, kind: K): Extract<Body, { kind: K }> => page.sections.find((s) => s.body.kind === kind)?.body as Extract<Body, { kind: K }>;
const args = (page: Page): ArgRow[] => body(page, 'flow').flow.calls.flatMap((call) => call.args);
const arg = (page: Page, key: string): ArgRow => args(page).find((a) => a.key === key) ?? assert.fail(`no row ${key}`);
const plain = (spans: readonly unknown[] | undefined): string =>
  (spans ?? []).map((s) => (typeof s === 'string' ? s : 'label' in (s as object) ? (s as { label: string }).label : Object.values(s as object)[0])).join('');

test('the page of morpho/market-supply puts its sections in the signer order', { timeout: 600_000 }, () => {
  const page = pageOf(inputs);
  assert.deepEqual(
    page.sections.map((s) => s.anchor),
    ['flow', 'protocol-morpho-blue', 'review', 'wallet', 'addresses', 'past', 'sign'],
  );
  assert.deepEqual(page.sections[0]?.count, { kind: 'text', text: '2 個呼叫' });
});

test('each argument says who decides it and prints what cast decode-calldata prints', () => {
  const page = pageOf(inputs);
  const spender = arg(page, '1.approve.spender');
  assert.deepEqual(spender.chips, [{ who: 'fixed', label: '固定' }]);
  assert.deepEqual(spender.value, { cast: '0x38B0C12AB81976e9417D4ebfe2A34DB6DF22e6AD', example: false });
  assert.equal(plain(spender.words), 'blue-bundles-v1');

  const value = arg(page, '1.approve.value');
  assert.deepEqual(value.chips, [{ who: 'you-type', label: '你填：金額' }]);
  assert.deepEqual(value.value, { cast: '72159646110', example: true });
  assert.equal(plain(value.words), '72,159.64611 usdc');
  assert.equal(plain(value.qualifier), '6 位小數');

  const market = arg(page, '2.blueBundlesV1Supply.marketParams');
  assert.deepEqual(market.chips, [{ who: 'you-pick', label: '你選：market' }]);
  assert.equal(market.value, undefined);
  assert.equal(plain(market.words), 'usdc / cbbtc，LLTV 86%');
  assert.match(plain(market.id), /0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64/);
  const parts = market.parts.flatMap((g) => g.rows);
  assert.deepEqual(
    parts.map((p) => [p.name, p.value?.cast, p.chips.length]),
    [
      ['loanToken', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 0],
      ['collateralToken', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 0],
      ['oracle', '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a', 0],
      ['irm', '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', 0],
      ['lltv', '860000000000000000', 0],
    ],
  );

  const permit = arg(page, '2.blueBundlesV1Supply.loanTokenPermit');
  assert.deepEqual(permit.chips, [
    { who: 'fixed', label: 'kind 固定' },
    { who: 'free', label: 'data 不限' },
  ]);
  assert.deepEqual(permit.value, { cast: '(0, 0x)', example: true });
  assert.deepEqual(arg(page, '2.blueBundlesV1Supply.deadline').chips, [{ who: 'free', label: 'app 填，不限' }]);
  assert.equal(plain(arg(page, '2.blueBundlesV1Supply.referralFeeRecipient').words), '無（零地址）');
  assert.equal(arg(page, '2.blueBundlesV1Supply.deadline').ai.ai, 'field 2.blueBundlesV1Supply.deadline');
});

test('without a recorded test transaction a card or free value prints its rule only', () => {
  const page = pageOf({ ...inputs, example: undefined });
  assert.equal(arg(page, '1.approve.value').value, undefined);
  assert.equal(plain(arg(page, '1.approve.value').words), '你填的金額');
  assert.equal(arg(page, '2.blueBundlesV1Supply.deadline').value, undefined);
  assert.deepEqual(arg(page, '1.approve.spender').value, { cast: '0x38B0C12AB81976e9417D4ebfe2A34DB6DF22e6AD', example: false });
  assert.equal(body(page, 'flow').flow.example, undefined);
});

test('the diagram has a lifeline for the Safe, each call target and each view target, and a green arrow from the view', () => {
  const { diagram } = body(pageOf(inputs), 'flow').flow;
  assert.deepEqual(
    diagram.lifelines.map((l) => l.name),
    ['你的 Safe', 'usdc', 'blue-bundles-v1', 'morpho-blue'],
  );
  assert.deepEqual(
    diagram.arrows.map((a) => [a.kind, 'to' in a ? a.to : a.from]),
    [
      ['call', 1],
      ['call', 2],
      ['inside', 3],
      ['gets', 3],
    ],
  );
});

test('the protocol block holds the recorded facts and the market reading with its ratio', () => {
  const { block } = body(pageOf(inputs), 'protocol');
  const row = (label: string) => block.rows.find((r) => r.label === label) ?? assert.fail(`no ${label} row`);
  assert.equal(plain(row('TVL').value), '$10.81 B');
  assert.equal(plain(row('上線').value), '2024-01-14');
  assert.equal(plain(row('proxy').value), '不是 proxy');
  assert.equal(plain(row('事故').value), '0 起');
  assert.deepEqual(
    row('usdc-cbbtc-86').nested.map((n) => plain(n.value)),
    ['348,946,131.99 usdc', '304,650,857.92 usdc', '87.30%'],
  );
  assert.deepEqual(
    block.sources.map((s) => s.href),
    ['https://defillama.com/protocol/morpho-blue', 'https://defillama.com/hacks', undefined, 'https://api.morpho.org/graphql'],
  );
});

test('the oracle the program cannot read on its page is the one row to review, open in 地址, and the verdict icon is amber', () => {
  const page = pageOf(inputs);
  assert.deepEqual(
    body(page, 'review').rows.map((r) => [r.id, r.state, r.entry]),
    [['morpho-oracle-cbbtc-usdc-86/source.page', 'warn', 'a-morpho-oracle-cbbtc-usdc-86']],
  );
  const addresses = body(page, 'addresses');
  assert.deepEqual(
    addresses.open.map((r) => [r.name, r.confidence, r.reviewed]),
    [['morpho-oracle-cbbtc-usdc-86', 'low', 'AI 有疑慮']],
  );
  assert.equal(addresses.folded.length, 5);
  assert.equal(page.header.verdict.state, 'warn');
  assert.deepEqual(
    page.header.strip.map((s) => [s.name, s.state, s.count]),
    [
      ['地址來源', 'warn', '5 / 6'],
      ['原始碼驗證', 'ok', '6 / 6'],
      ['合約沒被換掉', 'ok', '6 / 6'],
      ['參數保護', 'ok', '1 / 1'],
      ['雙節點比對', 'ok', undefined],
    ],
  );
});

test('the wallet table shows the template rule, and names the bound arguments the wallet hides', () => {
  const wallet = body(pageOf(inputs), 'wallet');
  assert.equal(wallet.calls[0]?.rows, 'no-descriptor');
  const rows = wallet.calls[1]?.rows;
  assert.ok(Array.isArray(rows));
  assert.deepEqual(
    rows.map((r) => [plain(r.label), plain(r.value)]),
    [
      ['送出的 ETH', '0'],
      ['金額', '你填的 amount'],
      ['抵押代幣', '你選的 market 的 collateralToken'],
      ['LLTV', '你選的 market 的 lltv'],
      ['推薦費比例', '0'],
      ['推薦費收款地址', '無（零地址）'],
      ['期限', '不限'],
    ],
  );
  assert.match(plain(wallet.lines[0]), /marketParams\.oracle/);
  assert.match(plain(wallet.lines[1]), /分不出來/);
});

test('past transactions count the fitting ones of EOAs and of proven Safes', () => {
  const [recording] = body(pageOf(inputs), 'past').recordings;
  assert.deepEqual(
    recording?.rows.map((r) => [r.label, plain(r.value), plain(r.note)]),
    [
      ['EOA 直接呼叫', '8 / 8 符合', '8 個地址'],
      ['Safe', '0 / 2 符合', '2 個 Safe'],
      ['搜尋來源', 'Alchemy 和 Etherscan 找到的完全一樣', '528 = 528'],
    ],
  );
});

test('notes.json that leaves out a review the page needs is refused', () => {
  const notes = notesFor(inputs);
  assert.throws(
    () => buildPage(inputs, { ...notes, reviews: {} }, title),
    (e: unknown) => e instanceof NotesError && /morpho-oracle-cbbtc-usdc-86\/source\.page is missing/.test(e.message),
  );
});

const address = (name: string): Address => registry.entries.get(name)?.address ?? assert.fail(name);

/** One change to the recorded inputs per kind of result: red, amber and grey, on each strip line. */
const VARIANTS: readonly { readonly what: string; readonly change: (of: HtmlInputs) => HtmlInputs }[] = [
  { what: 'as recorded', change: (of) => of },
  { what: 'a code span the chain did not run', change: (of) => ({ ...of, spans: new Map([...of.spans, [address('morpho-blue'), [{ kind: 'finding', text: '' }]]]) }) },
  {
    what: 'an ABI proof refused',
    change: (of) => ({ ...of, abi: new Map([...of.abi, [address('blue-bundles-v1'), { kind: 'refused', refusal: { why: 'bytecode-mismatch' } } as unknown as AbiRefusal]]) }),
  },
  { what: 'no ABI case', change: (of) => ({ ...of, abi: new Map([...of.abi].filter(([a]) => a !== address('usdc'))) }) },
  {
    what: 'a source page with no answer',
    change: (of) => ({ ...of, pages: { ...of.pages, pages: new Map([...of.pages.pages, ['https://developers.circle.com/stablecoins/usdc-contract-addresses', { kind: 'unread', why: 'timeout' }]]) } }),
  },
  { what: 'a test transaction now refused', change: (of) => ({ ...of, fixtures: [{ name: 'morpho-market-supply', outcome: { kind: 'card-refused', why: 'wrong-kind' } }] }) },
];

const RANK: Readonly<Record<State, number>> = { na: 0, ok: 1, warn: 2, bad: 3 };

for (const variant of VARIANTS) {
  test(`待確認, the strip, the rail and 地址 agree: ${variant.what}`, () => {
    const of = variant.change(inputs);
    const ledger = judge(of, of.fixtures);
    const page = pageOf(of);
    const review = body(page, 'review');
    const ids = review.rows.map((r) => r.id);
    assert.deepEqual(ids, forSigner(ledger).map((r) => r.id));
    assert.ok(review.rows.every((r) => r.state === 'bad' || r.state === 'warn'));
    for (const item of page.header.strip.filter((s) => s.line !== 'providers')) {
      const rows = review.rows.filter((r) => ledger.results.find((x) => x.id === r.id)?.line === item.line);
      const expected = rows.length === 0 ? undefined : rows.reduce<State>((acc, r) => (RANK[r.state] > RANK[acc] ? r.state : acc), 'na');
      if (expected === undefined) assert.ok(item.state === 'ok' || item.state === 'na', `${item.name} is ${item.state} with nothing to review`);
      else assert.equal(item.state, expected, item.name);
    }
    const rail = page.sections.find((s) => s.anchor === 'review')?.count;
    assert.deepEqual(rail, { kind: 'state', state: ids.length > 0 ? worst(forSigner(ledger)) : 'ask', n: ids.length + review.judgments.length });
    const reviewed = new Set(review.rows.flatMap((r) => (r.entry === undefined ? [] : [r.entry])));
    assert.deepEqual(new Set(body(page, 'addresses').open.map((r) => r.anchor)), reviewed);
    assert.equal(page.header.verdict.state, worst(ledger.results));
    assert.ok(review.rows.every((r) => stateOf(ledger.results.find((x) => x.id === r.id) ?? assert.fail(r.id)) === r.state));
  });
}
