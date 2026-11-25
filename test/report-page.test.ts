import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import type { AbiRefusal } from '../src/contracts/prove.ts';
import { parseFunctionSignature } from '../src/decode/abi.ts';
import { MARKETS_PATH, REGISTRY_PATH, loadRegistry } from '../src/registry.ts';
import { weightOf } from '../src/research/grades.ts';
import type { Grade } from '../src/research/grades.ts';
import { forSigner, judge, stateOf, strip, worst } from '../src/research/ledger.ts';
import type { EntryReport, FieldFact } from '../src/research/erc7730.ts';
import type { State } from '../src/research/ledger.ts';
import { NotesError, notesScope, readNotes } from '../src/research/notes.ts';
import { factsScope } from '../src/research/protocol-facts.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { renderPage } from '../src/research/report-html.ts';
import { buildPage, constCast } from '../src/research/report-page.ts';
import type { ArgRow, Body, DocLine, HtmlInputs, Inline, Page, WalletCall } from '../src/research/report-page.ts';
import { pageUrlOf } from '../src/research/source-page.ts';
import { STANDARDS } from '../src/research/standards.ts';
import type { HttpsUrl, RegistryEntry } from '../src/registry.ts';
import { entriesOf, parseDocs, readDocs, renderReport, replayInputs } from '../src/research/report.ts';
import type { ReportTitle, TodayCheck } from '../src/research/report.ts';
import { checksumAddress } from '../src/safe/types.ts';
import { OFFICIAL_MULTISEND } from '../src/decode/multisend.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { judgeFixtures } from '../src/template/perturb.ts';
import { loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';
import { repoWithFrozenReports } from './frozen-reports.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';
import { parseRegistryAt } from './registry-at.ts';

const ROOT = repoWithTestFixtures();
const registry = loadRegistry(ROOT);
const FROZEN = repoWithFrozenReports();
const frozenRegistry = loadRegistry(FROZEN);
const target = { template: 'morpho/market-supply' };
let inputs: HtmlInputs;
let title: ReportTitle;
let template: Template;
const deposit = { template: 'morpho/vault-deposit', instance: 'hyperithm-usdc-apex-v2-9e2f' };
let depositPage: Page;
let depositInputs: HtmlInputs;
let depositNotes: unknown;
let depositTitle: ReportTitle;

before(async () => {
  const compilers = await warmCompilers([...reportCases(ROOT, registry, [target]), ...reportCases(FROZEN, frozenRegistry, [deposit])]);
  const depositReplayed = await replayInputs(FROZEN, frozenRegistry, deposit, compilers, loadPublicSuffixList());
  const depositTemplate = depositReplayed.inputs.subject.kind === 'template' ? depositReplayed.inputs.subject.template : assert.fail('a template report');
  depositInputs = { ...depositReplayed.inputs, fixtures: await judgeFixtures(FROZEN, depositTemplate, frozenRegistry) };
  depositNotes = readNotes(FROZEN, deposit.template, frozenRegistry.entries.get(deposit.instance));
  depositTitle = depositReplayed.title;
  depositPage = buildPage(depositInputs, depositNotes, depositTitle, 'zh-TW');
  const replayed = await replayInputs(ROOT, registry, target, compilers, loadPublicSuffixList());
  title = replayed.title;
  template = replayed.inputs.subject.kind === 'template' ? replayed.inputs.subject.template : assert.fail('a template report');
  inputs = { ...replayed.inputs, fixtures: await judgeFixtures(ROOT, template, registry) };
});

/** One AI text, the same in both languages. */
const both = (text: string) => ({ en: text, 'zh-TW': text });

/** Notes that hold exactly what the scope requires, each text naming its key, so a page row can be traced to its note. */
function notesFor(of: HtmlInputs): Record<string, unknown> {
  const scope = notesScope(of, judge(of, of.fixtures), of.subject.kind === 'template' ? of.subject.template : assert.fail('a template report'), 'zh-TW');
  return {
    title: both('title'),
    summary: both('summary'),
    verdict: { status: 'caution', text: both('verdict') },
    flow: [{ after: 2, from: 'blue-bundles-v1', to: 'morpho-blue', function: 'supply((address,address,address,address,uint256),uint256,uint256,address,bytes)', text: both('supply'), sources: ['https://example.org/Morpho.sol'] }],
    protocols: Object.fromEntries([...scope.protocols].map(([slug]) => [slug, { intro: both(`intro ${slug}`), audits: { text: both('audits') }, incidents: [] }])),
    judgments: [{ text: both('judgment'), recommendation: both('small first') }],
    reviews: Object.fromEntries(scope.reviews.map((id) => [id, { status: 'concern', text: both(`review ${id}`), recommendation: both('look') }])),
    entries: Object.fromEntries([...scope.routed].map((name) => [name, { role: both(`role ${name}`), sources: [{ text: both('implementation history'), url: 'https://etherscan.io/', result: 'pass' }] }])),
    fields: Object.fromEntries(scope.fields.map((key) => [key, both(`field ${key}`)])),
  };
}

const pageOf = (of: HtmlInputs): Page => buildPage(of, notesFor(of), title, 'zh-TW');

function oneCall(of: HtmlInputs, n: number): HtmlInputs {
  const subject = of.subject.kind === 'template' ? of.subject : assert.fail('a template report');
  const call = subject.template.calls[n - 1] ?? assert.fail(`no call ${n}`);
  return { ...of, subject: { ...subject, template: { ...subject.template, calls: [call] } }, fixtures: [] };
}

const oneCallPage = (of: HtmlInputs): Page => buildPage(of, { ...notesFor(of), flow: [] }, title, 'zh-TW');

function templatePage(id: string): Page {
  const subject = inputs.subject.kind === 'template' ? inputs.subject : assert.fail('a template report');
  const other = loadTemplate(ROOT, id, registry);
  return oneCallPage({ ...inputs, subject: { ...subject, template: other, docs: parseDocs(readDocs(ROOT, id), other, registry) }, fixtures: [] });
}
const body = <K extends Body['kind']>(page: Page, kind: K): Extract<Body, { kind: K }> => page.sections.find((s) => s.body.kind === kind)?.body as Extract<Body, { kind: K }>;
const args = (page: Page): ArgRow[] => body(page, 'flow').flow.calls.flatMap((call) => call.args);
const arg = (page: Page, key: string): ArgRow => args(page).find((a) => a.key === key) ?? assert.fail(`no row ${key}`);
const plain = (spans: readonly unknown[] | undefined): string =>
  (spans ?? []).map((s) => (typeof s === 'string' ? s : 'label' in (s as object) ? (s as { label: string }).label : Object.values(s as object)[0])).join('');

test('the page of morpho/market-supply puts its sections in the signer order', { timeout: 600_000 }, () => {
  const page = pageOf(inputs);
  assert.deepEqual(
    page.sections.map((s) => s.anchor),
    ['review', 'flow', 'protocol-morpho-blue', 'wallet', 'addresses', 'past', 'next'],
  );
  assert.deepEqual(page.sections[1]?.count, { kind: 'text', text: '2 個呼叫' });
});

test('each argument says who decides it and prints what cast decode-calldata prints', () => {
  const page = pageOf(inputs);
  const spender = arg(page, '1.approve.spender');
  assert.deepEqual(spender.chips, [{ who: 'fixed', label: '固定' }]);
  assert.equal(spender.value, '0x38B0C12AB81976e9417D4ebfe2A34DB6DF22e6AD');
  assert.equal(plain(spender.words), 'blue-bundles-v1');

  const value = arg(page, '1.approve.value');
  assert.deepEqual(value.chips, [{ who: 'you-type', label: '你填：金額' }]);
  assert.equal(value.value, undefined);
  assert.equal(plain(value.words), '你填的金額');
  assert.equal(value.qualifier, undefined);

  const market = arg(page, '2.blueBundlesV1Supply.marketParams');
  assert.deepEqual(market.chips, [{ who: 'you-pick', label: '你選：市場' }]);
  assert.equal(market.value, undefined);
  assert.equal(plain(market.words), '你選的市場');
  assert.equal(market.id, undefined);
  const parts = market.parts.flatMap((g) => g.rows);
  assert.deepEqual(
    parts.map((p) => [p.name, p.value, p.chips.length]),
    [
      ['loanToken', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 0],
      ['collateralToken', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 0],
      ['oracle', '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a', 0],
      ['irm', '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', 0],
      ['lltv', '860000000000000000', 0],
      ['loanToken', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 0],
      ['collateralToken', '0x098697bA3Fee4eA76294C5d6A466a4e3b3E95FE6', 0],
      ['oracle', '0x5096642B7c7CD82198932f3FADd873EC2fcDeb6d', 0],
      ['irm', '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', 0],
      ['lltv', '860000000000000000', 0],
      ['loanToken', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 0],
      ['collateralToken', '0x098697bA3Fee4eA76294C5d6A466a4e3b3E95FE6', 0],
      ['oracle', '0x5096642B7c7CD82198932f3FADd873EC2fcDeb6d', 0],
      ['irm', '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', 0],
      ['lltv', '915000000000000000', 0],
      ['loanToken', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 0],
      ['collateralToken', '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', 0],
      ['oracle', '0xa3A7A3ceFee206f9d7Fe00eC3C83324ED4228411', 0],
      ['irm', '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', 0],
      ['lltv', '860000000000000000', 0],
    ],
  );

  const permit = arg(page, '2.blueBundlesV1Supply.loanTokenPermit');
  assert.deepEqual(permit.chips, [
    { who: 'fixed', label: 'kind 固定' },
    { who: 'free', label: 'data 不限' },
  ]);
  assert.equal(permit.value, undefined);
  assert.equal(plain(permit.words), '2 個部分');
  assert.deepEqual(
    permit.parts.flatMap((g) => g.rows).map((p) => [p.name, p.value]),
    [
      ['kind', '0'],
      ['data', undefined],
    ],
  );
  assert.deepEqual(arg(page, '2.blueBundlesV1Supply.deadline').chips, [{ who: 'free', label: 'app 填，不限' }]);
  assert.equal(plain(arg(page, '2.blueBundlesV1Supply.referralFeeRecipient').words), '無（零地址）');
  assert.equal(arg(page, '2.blueBundlesV1Supply.deadline').ai?.ai, 'field 2.blueBundlesV1Supply.deadline');
});

test('a container prints its summary in place of the hex and nests its parts; a leaf prints what cast prints', () => {
  const rows = (row: ArgRow): ArgRow[] => row.parts.flatMap((g) => g.rows);
  const bundle = arg(depositPage, '2.multicall.bundle');
  assert.equal(bundle.value, undefined);
  assert.equal(plain(bundle.words), '2 項');
  const [first, second] = rows(bundle);
  assert.deepEqual([first?.key, first?.value, plain(first?.words)], ['2.multicall.bundle[0]', undefined, '5 個部分']);
  const data = (item: ArgRow | undefined): ArgRow => rows(item ?? assert.fail('an item')).find((p) => p.name === 'data') ?? assert.fail('no data');
  assert.equal(data(first).value, undefined);
  assert.equal(plain(data(first).words), 'erc20TransferFrom (0xd96ca0b9)');
  assert.equal(plain(data(second).words), 'erc4626Deposit (0x6ef5eeae)');

  const adapter = (frozenRegistry.entries.get('general-adapter-1') ?? assert.fail('general-adapter-1')).address;
  const leaf = (item: ArgRow | undefined, name: string): string | undefined => rows(item ?? assert.fail('an item')).find((p) => p.name === name)?.value;
  assert.equal(leaf(first, 'to')?.toLowerCase(), adapter);
  assert.equal(leaf(first, 'value'), '0');
  assert.equal(leaf(first, 'skipRevert'), 'false');
  assert.equal(leaf(first, 'callbackHash'), `0x${'0'.repeat(64)}`);
  assert.equal(arg(depositPage, '1.approve.value').value, undefined);
  assert.equal(leaf(data(first), 'amount'), undefined);
  assert.equal(leaf(data(second), 'assets'), undefined);
  assert.equal(leaf(data(first), 'receiver')?.toLowerCase(), adapter);

  const all = (row: ArgRow): ArgRow[] => [row, ...rows(row).flatMap(all)];
  for (const row of args(depositPage).flatMap(all)) {
    if (row.parts.length > 0) assert.equal(row.value, undefined, `${row.key} is a container`);
    else assert.ok(row.value === undefined || !/^[[(]/.test(row.value), `${row.key} is a leaf`);
  }
});

test('without a recorded test transaction a card or free value prints its rule only', () => {
  const page = pageOf(inputs);
  assert.equal(arg(page, '1.approve.value').value, undefined);
  assert.equal(plain(arg(page, '1.approve.value').words), '你填的金額');
  assert.equal(arg(page, '2.blueBundlesV1Supply.deadline').value, undefined);
  assert.equal(arg(page, '1.approve.spender').value, '0x38B0C12AB81976e9417D4ebfe2A34DB6DF22e6AD');
});

test('a per-vault report takes its example from a test transaction of its own vault, or says that vault has none', () => {
  const all = (rows: readonly ArgRow[]): ArgRow[] => rows.flatMap((r) => [r, ...all(r.parts.flatMap((p) => p.rows))]);
  const decided = all(args(depositPage)).filter((r) => r.chips.some((c) => c.who === 'you-type' || c.who === 'free'));
  assert.ok(decided.length > 0 && decided.every((r) => r.value === undefined), decided.map((r) => `${r.key} ${r.value}`).join(' / '));
});

test("an example value that is the test transaction's Safe says it is another Safe, and a long amount shows six places with its base units", () => {
  const all = (rows: readonly ArgRow[]): ArgRow[] => rows.flatMap((r) => [r, ...all(r.parts.flatMap((p) => p.rows))]);
  const toSafe = all(args(depositPage)).filter((r) => plain(r.words) === '你的 Safe');
  assert.ok(toSafe.length > 0 && toSafe.every((r) => r.value === undefined), toSafe.map((r) => r.key).join(' / '));
});

test('交易後 says which way a token the Safe gives or gets more than nothing of moves', () => {
  const subject = depositInputs.subject.kind === 'template' ? depositInputs.subject : assert.fail('a template report');
  const { effects } = subject.template;
  const gives = effects.gives.map((e) => ({ ...e, amount: { kind: 'positive' as const } }));
  const gets = effects.gives.map((e) => ({ ...e, to: undefined, amount: { kind: 'positive' as const } }));
  const template = { ...subject.template, effects: { ...effects, gives, gets } };
  const page = buildPage({ ...depositInputs, subject: { ...subject, template } }, { ...(depositNotes as object), flow: [] }, depositTitle, 'zh-TW');
  const values = body(page, 'flow').flow.after.map((row) => plain(row.value));
  assert.ok(values.includes('給出多於 0') && values.includes('收到多於 0'), values.join(' / '));
});

test('a token the Safe may get any amount of reads so in the diagram, after the transaction, in the automatic checks and in the Markdown report, in both languages', () => {
  const subject = depositInputs.subject.kind === 'template' ? depositInputs.subject : assert.fail('a template report');
  const { effects } = subject.template;
  const gets = effects.gives.map((e) => ({ ...e, to: undefined, amount: { kind: 'any' as const } }));
  const inputs = { ...depositInputs, subject: { ...subject, template: { ...subject.template, effects: { ...effects, gets } } } };
  const words = {
    en: ['you may get usdc', 'receives 0 or more', 'may rise or stay the same, never fall', "After simulation, the Safe's usdc may rise or stay the same, never fall"],
    'zh-TW': ['你可能得到 usdc', '收到 0 或更多', '可以增加或不變，不能減少', '模擬後 Safe 的 usdc 可以增加或不變，不能減少'],
  };
  for (const language of ['en', 'zh-TW'] as const) {
    const page = buildPage(inputs, { ...(depositNotes as object), flow: [] }, depositTitle, language);
    const { after, diagram } = body(page, 'flow').flow;
    const [arrow, value, note, automatic] = words[language];
    assert.ok(diagram.arrows.some((a) => a.kind === 'gets' && a.text === arrow), JSON.stringify(diagram.arrows));
    assert.ok(after.some((row) => plain(row.value) === value && plain(row.note) === note), JSON.stringify(after));
    assert.ok(body(page, 'next').automatic.some((line) => plain(line) === automatic), JSON.stringify(body(page, 'next').automatic));
  }
  assert.match(renderReport(inputs, depositTitle), /\| the Safe gets \| [^|]+ \| any amount, none included \|/);
});

test('交易後 and the Markdown report show an atMost, a tolerance and a touched token, each tolerance with the template\'s reason as AI text', () => {
  const subject = depositInputs.subject.kind === 'template' ? depositInputs.subject : assert.fail('a template report');
  const { effects } = subject.template;
  const why = { en: 'stETH rounds shares down', 'zh-TW': 'stETH 換算份額時無條件捨去' };
  const tolerance = { less: 2n, more: 0n, why };
  const gives = [...effects.gives.map((e) => ({ ...e, amount: { kind: 'at-most' as const, field: 'amount' } })), ...effects.gives.map((e) => ({ ...e, token: 'eth' as const, tolerance: { less: 0n, more: 1n, why } }))];
  const gets = effects.gives.map((e) => ({ ...e, to: undefined, tolerance }));
  const touches = [{ token: deposit.instance, tolerance: { less: 0n, more: 1n, why } }];
  const template = { ...subject.template, effects: { ...effects, gives, gets, touches } };
  const inputs = { ...depositInputs, subject: { ...subject, template } };
  const page = buildPage(inputs, depositNotes, depositTitle, 'zh-TW');
  const after = body(page, 'flow').flow.after;
  const notes = after.map((row) => plain(row.note));
  assert.ok(notes.some((n) => n.startsWith('給出的不能多於你填的')), notes.join(' / '));
  assert.ok(notes.some((n) => n.endsWith('因為捨入，Safe 最後的餘額可以低最多 2 個最小單位')), notes.join(' / '));
  assert.ok(after.some((row) => plain(row.label) === `Safe 的 ${deposit.instance}` && plain(row.value) === '只能因捨入變動' && row.ai?.ai === why['zh-TW']), JSON.stringify(after.map((r) => r.label)));
  const markdown = renderReport(inputs, depositTitle);
  assert.ok(markdown.includes("; the Safe's balance may end up to 2 base units lower than that, for rounding; written by the AI in the template: stETH rounds shares down; in Traditional Chinese: stETH 換算份額時無條件捨去 |"), markdown);
  assert.ok(markdown.includes("| the Safe gives | ETH | the card's `amount`; the Safe's balance may end up to 1 base unit higher than that, for rounding;"), markdown.split('## Effects')[1]?.slice(0, 900));
  assert.ok(markdown.includes(`| the Safe keeps | \`${deposit.instance}\``) && markdown.includes("| unchanged; the Safe's balance may end up to 1 base unit higher than that, for rounding; written by the AI"));
  assert.ok(markdown.includes("at most the card's `amount`, and none gained"));
});

test('下一步 asks for each card field by its Chinese word with the key card new prints, and a typed amount of vault shares is 股份數', () => {
  const subject = depositInputs.subject.kind === 'template' ? depositInputs.subject : assert.fail('a template report');
  const card = new Map([...subject.template.card].map(([name, field]) => [name, field.kind === 'amount' ? { ...field, computed: undefined } : field]));
  const typed = buildPage({ ...depositInputs, subject: { ...subject, template: { ...subject.template, card } } }, depositNotes, depositTitle, 'zh-TW');
  const asked = body(typed, 'next').steps.map((s) => plain(s.say).split('：')[0]);
  assert.ok(asked.includes('金庫（vault）'), asked.join(' / '));
  assert.ok(asked.includes('金額（amount）'), asked.join(' / '));
  assert.ok(asked.includes('股份數（min-shares）'), asked.join(' / '));
});

test('two official pages of one entry that share a short URL are each named with their file name', () => {
  const bundler3 = depositInputs.registry.entries.get('bundler3') ?? assert.fail('bundler3');
  const more = bundler3.moreSources?.[0] ?? assert.fail('a second page');
  const moved = { ...bundler3, source: more.url.replace(/addresses\.ts$/, 'README.md') as typeof bundler3.source };
  const entries = new Map([...depositInputs.registry.entries].map(([name, entry]) => [name, name === 'bundler3' ? moved : entry]));
  const moved3 = { ...depositInputs, registry: { ...depositInputs.registry, entries, byAddress: new Map([...entries.values()].map((e) => [e.address, e])) } };
  const page = buildPage(moved3, { ...notesFor(moved3), flow: [] }, depositTitle, 'zh-TW');
  const { open, folded } = body(page, 'addresses');
  const row = [...open, ...folded].find((r) => r.name === 'bundler3') ?? assert.fail('the bundler3 row');
  assert.deepEqual(row.sources.slice(0, 2).map((s) => s.label), ['github.com/morpho-org/sdks/…/README.md', 'github.com/morpho-org/sdks/…/addresses.ts']);
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

function walletCall(page: Page): { readonly call: WalletCall; readonly lines: readonly Inline[] } {
  const { view } = body(page, 'wallet');
  if (view.kind !== 'calls') return assert.fail('a one-call template lists its call');
  return { call: view.calls[0] ?? assert.fail('one call'), lines: view.lines };
}

test('a template of two or more calls goes through MultiSend, so its wallet section only says to compare the safeTxHash', () => {
  for (const page of [pageOf(inputs), depositPage]) {
    const { view } = body(page, 'wallet');
    assert.equal(view.kind, 'multisend');
    assert.equal(view.kind === 'multisend' ? view.calls : 0, 2);
    assert.ok(Array.isArray(view.safeTx), 'the SafeTx row is described');
    assert.deepEqual(
      view.safeTx.map((r) => [plain(r.label), plain(r.value)]).slice(0, 4),
      [
        ['to', `官方 MultiSend，是這 8 個 Safe 部署之一：${OFFICIAL_MULTISEND.map((d) => checksumAddress(d.address)).join('')}`],
        ['value', '0'],
        ['operation', 'Delegate Call（1），呼叫官方 MultiSend'],
        ['data', 'MultiSend 打包的呼叫，只顯示原始資料'],
      ],
    );
  }
});

test('the wallet rows match a descriptor by each array item, by argument name without underscores, and show a token with no descriptor as raw data', () => {
  const rowsOf = (of: HtmlInputs, n: number) => {
    const { call } = walletCall(oneCallPage(oneCall(of, n)));
    return call.rows === 'no-descriptor' ? call.rows : call.rows.map((r) => [plain(r.label), plain(r.value)]);
  };
  assert.equal(rowsOf(depositInputs, 1), 'no-descriptor');
  assert.deepEqual(rowsOf(depositInputs, 2), [['bundle.[0].data', '呼叫 erc20TransferFrom，參數見流程'], ['bundle.[1].data', '呼叫 erc4626Deposit，參數見流程']]);
  const usdc = frozenRegistry.entries.get('usdc') ?? assert.fail('usdc');
  const field = (path: string) => ({ kind: 'field', path, format: 'raw', visible: 'always' }) as const;
  const usdtLike = { kind: 'calldata', functions: [{ selector: '0x095ea7b3', signature: 'approve(address,uint256)', fields: [field('_spender'), field('_value')], notShown: [] }] } as unknown as EntryReport['descriptors'][number];
  const reports = [...depositInputs.erc7730.reports, { entry: usdc, factory: undefined, index: undefined, eip712Index: [], descriptors: [usdtLike] }];
  assert.deepEqual(rowsOf({ ...depositInputs, erc7730: { ...depositInputs.erc7730, reports } }, 1), [['被授權者', 'general-adapter-1'], ['金額', '你填的金額']]);
});

test("a per-vault report shows its vault as the card's value, with or without a test transaction", () => {
  const vault = (page: Page) => arg(page, '2.multicall.bundle').parts.flatMap((g) => g.rows)[1]?.parts.flatMap((g) => g.rows).find((r) => r.name === 'data')?.parts.flatMap((g) => g.rows).find((r) => r.name === 'vault');
  const hyperithm = frozenRegistry.entries.get('hyperithm-usdc-apex-v2-9e2f') ?? assert.fail('the vault');
  const row = vault(depositPage) ?? assert.fail('the vault row');
  assert.equal(row.value?.toLowerCase(), hyperithm.address);
  assert.equal(plain(row.words), 'hyperithm-usdc-apex-v2-9e2f');
  assert.equal(depositPage.id, 'morpho/vault-deposit · hyperithm-usdc-apex-v2-9e2f');
});

test("a per-vault report shows the vault's stored evidence after the protocol, with no USD value", () => {
  assert.deepEqual(
    depositPage.sections.map((s) => s.anchor),
    ['review', 'flow', 'protocol-morpho-blue', 'vault-hyperithm-usdc-apex-v2-9e2f', 'wallet', 'addresses', 'past', 'next'],
  );
  const { vault } = body(depositPage, 'vault');
  assert.deepEqual(
    vault.rows.map((r) => [r.label, plain(r.value)]),
    [
      ['工廠', 'vault-v2-factory 回答 isVaultV2(address) = true'],
      ['現在的 totalAssets', '6,849,805.81 usdc'],
      ['持有人', '167 個地址持有，曾經收過的 355 個'],
      ['最大持有人', '56.74%'],
      ['前 10 名', '90.75%'],
    ],
  );
  assert.equal(vault.bars.length, 13);
  assert.deepEqual(vault.bars[0], { date: '2025-11-20', words: '3,337.55 usdc', share: 3337_556921 / 13799662_790530 });
  assert.deepEqual(vault.bars.at(-1)?.date, '2026-11-17');
  assert.equal(vault.most, '13,799,662.79 usdc');
  assert.ok(!JSON.stringify(vault).includes('$'), 'no USD value');
});

test('a month the providers disagree on reads 讀不到 and draws no bar', () => {
  const name = 'hyperithm-usdc-apex-v2-9e2f';
  const text = (depositInputs.vaults.get(name) ?? assert.fail('stored evidence')).replace(/(2026-07-20 {2}block \d+ {2}).*/, '$1UNVERIFIABLE eth_call: alchemy and drpc disagree');
  const { vault } = body(buildPage({ ...depositInputs, vaults: new Map([[name, text]]) }, depositNotes, depositTitle, 'zh-TW'), 'vault');
  assert.deepEqual(vault.bars.find((b) => b.date === '2026-07-20'), { date: '2026-07-20', words: '讀不到', share: undefined });
  assert.equal(vault.most, '10,509,191.98 usdc');
});

test('the vault its factory alone confirms is the one 待確認; every address row names where its address was confirmed', () => {
  assert.deepEqual(body(depositPage, 'review').rows.map((r) => [r.id, r.state, plain(r.subject ?? [])]), [
    ['hyperithm-usdc-apex-v2-9e2f/address', 'warn', '只在 1 個地方確認：工廠'],
  ]);
  const { open, folded } = body(depositPage, 'addresses');
  assert.deepEqual(
    [...open, ...folded].map((r) => [r.name, r.confidence, r.confirmed]),
    [
      ['hyperithm-usdc-apex-v2-9e2f', 'low', '只在 1 個地方確認：工廠'],
      ['usdc', 'high', '在 2 個地方確認：官方頁、CoinGecko'],
      ['bundler3', 'high', '在 2 個地方確認：官方頁、github.com/morpho-org/sdks'],
      ['vault-v2-factory', 'high', '在 2 個地方確認：官方頁、github.com/morpho-org/sdks'],
      ['general-adapter-1', 'high', '在 2 個地方確認：官方頁、github.com/morpho-org/sdks'],
    ],
  );
  const vault = open[0] ?? assert.fail('the vault row');
  assert.deepEqual(
    vault.sources.map((s) => [s.label, s.state, s.phrase, s.site === undefined ? undefined : [s.site.state, s.site.slug, s.site.places[0]?.href]]),
    [
      ['app.morpho.org/ethereum/vault', 'na', 'url-holds-address', ['ok', 'morpho-blue', 'https://defillama.com/protocol/morpho-blue']],
      ['CoinGecko', 'na', 'nothing-to-compare', undefined],
      ['工廠', 'ok', undefined, undefined],
      ['Immunefi 漏洞賞金範圍', 'na', 'not-listed', undefined],
      ['部署者', 'na', 'creation-unproven', undefined],
    ],
  );
  assert.deepEqual(vault.aiSources.map((s) => [s.text.tag, s.result]), [['ai', 'attention']]);
});

test("a Vault V2's market adapter is confirmed by the protocol API and, as one place, by its factory, the vault that names it and its own answer", { timeout: 600_000 }, async () => {
  const revoke = { template: 'morpho/vault-v2-revoke', instance: 'acuto-usdc-v2-4a57' };
  const replayed = await replayInputs(FROZEN, frozenRegistry, revoke, await warmCompilers(reportCases(FROZEN, frozenRegistry, [revoke])), loadPublicSuffixList());
  const revokeTemplate = replayed.inputs.subject.kind === 'template' ? replayed.inputs.subject.template : assert.fail('a template report');
  const of = { ...replayed.inputs, fixtures: await judgeFixtures(FROZEN, revokeTemplate, frozenRegistry) };
  const page = buildPage(of, readNotes(FROZEN, revoke.template, frozenRegistry.entries.get(revoke.instance)), replayed.title, 'zh-TW');
  assert.ok(!body(page, 'review').rows.some((r) => r.id.startsWith('acuto-usdc-v2-4a57-market-adapter/')), 'the adapter is not for the signer');
  const { open, folded } = body(page, 'addresses');
  const adapter = [...open, ...folded].find((r) => r.name === 'acuto-usdc-v2-4a57-market-adapter') ?? assert.fail('the adapter row');
  assert.equal(adapter.confirmed, '在 2 個地方確認：協議 API、工廠和它登記的每一項檢查');
  assert.deepEqual(
    adapter.sources.filter((s) => s.label === '工廠和它登記的每一項檢查').map((s) => s.state),
    ['ok'],
  );
});

test('each past-transactions recording names the entry its search anchored on', () => {
  const { recordings } = body(depositPage, 'past');
  assert.ok(recordings.length > 0);
  for (const r of recordings) assert.match(r.count, /^搜尋 [a-z0-9-]+ 的鑄造（存款），找到 \d+ 筆，研究 \d+ 筆$/);
});

test('a mint of a token that is not a vault is a mint, not a deposit', () => {
  const usdc = frozenRegistry.entries.get('usdc') ?? assert.fail('usdc');
  const pastTxs = depositInputs.pastTxs.map((r) => ({ ...r, query: { ...r.query, token: usdc.address } }));
  const page = buildPage({ ...depositInputs, pastTxs }, depositNotes, depositTitle, 'zh-TW');
  for (const r of body(page, 'past').recordings) assert.match(r.count, /^搜尋 usdc 的鑄造，/);
});

test('a contract a flow line names gets its own lifeline, so every inside arrow ends on one', () => {
  const { diagram } = body(depositPage, 'flow').flow;
  assert.deepEqual(diagram.lifelines.map((l) => l.name), ['你的 Safe', 'usdc', 'bundler3', 'general-adapter-1', 'hyperithm-usdc-apex-v2-9e2f']);
  const inside = diagram.arrows.flatMap((a) => (a.kind === 'inside' ? [[a.from, a.to]] : []));
  assert.deepEqual(inside, [[3, 1], [3, 4]]);
});

test('the green arrow for shares the Safe gets starts at the vault, on a lifeline of its own when no call targets it', () => {
  const { diagram } = body(depositPage, 'flow').flow;
  const gets = diagram.arrows.flatMap((a) => (a.kind === 'gets' ? [diagram.lifelines[a.from]?.name] : []));
  assert.deepEqual(gets, ['hyperithm-usdc-apex-v2-9e2f']);
});

test('a share price bounded by the computed fewest shares is labelled computed, by that field, not typed', () => {
  const nested = (row: ArgRow): ArgRow[] => [row, ...row.parts.flatMap((part) => part.rows).flatMap(nested)];
  const price = args(depositPage).flatMap(nested).find((row) => row.name === 'maxSharePriceE27') ?? assert.fail('no maxSharePriceE27 row');
  assert.deepEqual(price.chips, [{ who: 'computed', label: '程式算：最少收到的數量' }]);
  assert.ok(body(depositPage, 'flow').flow.key.some((k) => k.label === '程式算'), 'the key names the computed label');
});

test('the protocol block holds the recorded facts and the market reading with its ratio', () => {
  const { block } = body(pageOf(inputs), 'protocol');
  const row = (label: string) => block.rows.find((r) => r.label === label) ?? assert.fail(`no ${label} row`);
  assert.equal(plain(row('TVL').value), '$10.06 B');
  assert.equal(plain(row('上線').value), '2024-01-14');
  assert.equal(plain(row('proxy').value), '不是 proxy');
  assert.equal(plain(row('事故').value), '0 起');
  assert.deepEqual(
    row('usdc-cbbtc-86').nested.map((n) => plain(n.value)),
    ['333,278,088.96 usdc', '294,523,917.68 usdc', '88.37%'],
  );
  assert.deepEqual(
    block.sources.map((s) => s.href),
    ['https://defillama.com/protocol/morpho-blue', 'https://defillama.com/hacks', undefined, 'https://api.morpho.org/graphql'],
  );
});

test('without recorded protocol facts each protocol still shows its AI notes and one line that the program read nothing', () => {
  const page = pageOf({ ...inputs, facts: undefined });
  const { block } = body(page, 'protocol');
  assert.equal(block.intro.ai, 'intro morpho-blue');
  assert.deepEqual(
    block.rows.map((r) => [r.label, plain(r.value), r.ai?.ai]),
    [
      ['協議資料', '沒讀到', undefined],
      ['稽核', '', 'audits'],
      ['事故', '沒讀到', undefined],
    ],
  );
});

test('the three oracles only the protocol API confirms are the rows to review, open in 地址, and the verdict icon is amber', () => {
  const page = pageOf(inputs);
  assert.deepEqual(
    body(page, 'review').rows.map((r) => [r.id, r.state, r.entry]),
    [
      ['morpho-oracle-cbbtc-usdc-86/address', 'warn', 'a-morpho-oracle-cbbtc-usdc-86'],
      ['morpho-oracle-usp-usdc/address', 'warn', 'a-morpho-oracle-usp-usdc'],
      ['morpho-oracle-weeth-usdc-86/address', 'warn', 'a-morpho-oracle-weeth-usdc-86'],
    ],
  );
  const addresses = body(page, 'addresses');
  assert.deepEqual(
    addresses.open.map((r) => [r.name, r.confidence, r.reviewed, r.confirmed]),
    [
      ['morpho-oracle-cbbtc-usdc-86', 'low', 'concern', '只在 1 個地方確認：協議 API'],
      ['morpho-oracle-usp-usdc', 'low', 'concern', '只在 1 個地方確認：協議 API'],
      ['morpho-oracle-weeth-usdc-86', 'low', 'concern', '只在 1 個地方確認：協議 API'],
    ],
  );
  assert.equal(addresses.folded.length, 7);
  assert.equal(page.header.verdict.state, 'warn');
  assert.deepEqual(
    page.header.strip.map((s) => [s.name, s.state, s.count]),
    [
      ['地址來源', 'warn', '7 / 10'],
      ['原始碼驗證', 'ok', '4 / 4'],
      ['合約沒被換掉', 'ok', '10 / 10'],
      ['參數保護', 'ok', '1 / 1'],
      ['雙節點比對', 'ok', undefined],
    ],
  );
});

test('the wallet table shows the template rule, and names the bound arguments the wallet hides', () => {
  assert.equal(walletCall(oneCallPage(oneCall(inputs, 1))).call.rows, 'no-descriptor');
  const wallet = walletCall(oneCallPage(oneCall(inputs, 2)));
  const rows = wallet.call.rows;
  assert.ok(Array.isArray(rows));
  assert.deepEqual(
    rows.map((r) => [plain(r.label), plain(r.value)]),
    [
      ['送出的 ETH', '0'],
      ['金額', '你填的金額'],
      ['抵押代幣', '你選的市場的抵押代幣'],
      ['LLTV', '你選的市場的 LLTV'],
      ['推薦費比例', '0'],
      ['推薦費收款地址', '無（零地址）'],
      ['期限', '不限'],
    ],
  );
  assert.deepEqual(
    wallet.lines.map((line) => plain(line)),
    [
      '你的 Safe 是 proxy：Ledger 透過 Ledger 自己的伺服器把它解析成 safe-1.3.0 或 safe-1.4.1，才用得上這些描述檔；不解析 proxy 的錢包只顯示原始資料。',
      'SafeTx：錢包不顯示 safeTxGas、nonce，只有 hash 涵蓋它們。',
      'Safe 交易也可以把這一個呼叫包進官方 MultiSend（Delegate Call（1）），verify 一樣接受：這時 to 是官方 MultiSend、value 是 0，呼叫只顯示原始資料。',
      '呼叫 1：錢包不顯示 marketParams.loanToken、marketParams.oracle、marketParams.irm、loanTokenPermit.kind。',
      '呼叫 1：同樣兩種代幣的不同 market，只看錢包分不出來。',
      '用 Ledger 簽的話，先在 Ethereum app 的設定打開「Transaction hash」：套用描述檔時，要打開它裝置才會顯示 domain hash 和 message hash。比對這兩個 hash 才是 kiss-sign 靠的檢查，解讀看起來再對也要比。',
    ],
  );
});

test('a wallet row is labelled by the argument it shows, never by a descriptor path that names no argument', () => {
  const extra: FieldFact[] = ['constructor', '#.marketParams.toString', '#.loanTokenPermit'].map((path) => ({ kind: 'field', path, format: 'raw', visible: 'always' }));
  const reports = inputs.erc7730.reports.map((report) => ({
    ...report,
    descriptors: report.descriptors.map((d) => (d.kind === 'calldata' ? { ...d, functions: d.functions.map((f) => ({ ...f, fields: [...f.fields, ...extra] })) } : d)),
  }));
  const rows = walletCall(oneCallPage(oneCall({ ...inputs, erc7730: { ...inputs.erc7730, reports } }, 2))).call.rows;
  assert.ok(Array.isArray(rows));
  assert.deepEqual(
    rows.slice(-3).map((r) => [plain(r.label), plain(r.value)]),
    [
      ['不是這個函式的參數', '—'],
      ['不是這個函式的參數', '—'],
      ['loanTokenPermit', '見流程'],
    ],
  );
});

test('a constant prints as cast decode-calldata prints it', () => {
  assert.equal(constCast({ kind: 'string', value: '0x6869' as Hex }), '"hi"');
  assert.equal(constCast({ kind: 'bytes', value: '0x6869' as Hex }), '0x6869');
  assert.equal(constCast({ kind: 'address', value: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address }), '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  assert.equal(constCast({ kind: 'uint', value: 5n }), '5');
  assert.equal(constCast({ kind: 'bool', value: false }), 'false');
});

test('past transactions count, per kind of sender, those using the operation and those with the template shape', () => {
  const [recording] = body(pageOf(inputs), 'past').recordings;
  assert.deepEqual(
    recording?.blocks.map((b) => [b.title, plain(b.lead)]),
    [
      ['Safe', '0 筆用了這個操作的呼叫（0 個 Safe），0 筆跟模板一模一樣。'],
      ['EOA 直接呼叫 blueBundlesV1Supply', '8 筆用了這個操作的呼叫（8 個地址），0 筆跟模板一模一樣，1 筆形狀一樣、但用的是 registry 外的市場。'],
    ],
  );
  assert.deepEqual(
    recording?.blocks[1]?.groups.map((g) => [g.count, g.senders, plain(g.reason)]),
    [
      [1, 1, '形狀一樣，但 marketParams 用的是 registry 外的市場'],
      [4, 4, 'call.blueBundlesV1Supply.loanTokenPermit.kind 的值跟模板不同：模板要 0，交易是 1'],
      [3, 3, 'call.blueBundlesV1Supply.loanTokenPermit.kind 的值跟模板不同：模板要 0，交易是 2'],
    ],
    'a supply to a market outside the registry has the template shape; one with a signed permit, which the template fixes to kind 0, has another shape',
  );
  assert.equal(plain(recording?.search), 'Alchemy 和 Etherscan 找到的完全一樣（528 = 528）。');
});

test('a bundle with another number of items is grouped and named by the functions its items call, each example linked to Etherscan', () => {
  const [early] = body(depositPage, 'past').recordings;
  const [safe, eoa] = early?.blocks ?? assert.fail('two blocks');
  assert.equal(plain(safe?.lead), '8 筆用了這個操作的呼叫（4 個 Safe），6 筆跟模板一模一樣。');
  assert.deepEqual(
    safe?.groups.map((g) => [g.count, plain(g.calls), plain(g.reason)]),
    [[2, 'bundler3.multicall', '呼叫跟模板不同，模板是 approve → multicall']],
  );
  assert.equal(plain(eoa?.lead), '354 筆用了這個操作的呼叫（150 個地址），25 筆跟模板一模一樣。');
  assert.deepEqual(
    eoa?.groups.map((g) => [g.count, g.senders, plain(g.calls), plain(g.reason)]),
    [
      [321, 126, 'usdc.permit → general-adapter-1.erc20TransferFrom → general-adapter-1.erc4626Deposit', 'bundle 有 3 項，模板是 2 項'],
      [7, 7, 'usdc.permit → general-adapter-1.erc20TransferFrom → general-adapter-1.erc4626Deposit → general-adapter-1.erc20Transfer → general-adapter-1.erc20Transfer', 'bundle 有 5 項，模板是 2 項'],
      [1, 1, 'general-adapter-1.erc20TransferFrom → general-adapter-1.erc4626Deposit → general-adapter-1.erc20Transfer → general-adapter-1.erc20Transfer', 'bundle 有 4 項，模板是 2 項'],
    ],
  );
  assert.deepEqual(eoa?.groups[0]?.examples[0], { href: 'https://etherscan.io/tx/0x94ba5b792613b7a04c2235f47062cf3f991524be9dffadd0fa595a16783a73ea', label: '0x94ba5b79…' });
  assert.match(plain(early?.others[0]), /^另外 127 筆是別的操作，不列入：hyperithm-usdc-apex-v2-9e2f\.deposit 62 筆、0x3151cEE0cdb517C0E7Db2B55FF5085e7D1809d90\.0xbaae8abf 32 筆、/);
  assert.ok(!JSON.stringify(early).includes('符合'), 'no verdict word');
});

test('過去交易 leads with how many past transactions were exactly the template, had its shape outside the registry, or another shape, each counted once, and the latest of them', () => {
  assert.equal(
    plain(body(depositPage, 'past').same),
    '過去的記錄裡，跟模板一模一樣、也就是跟你這筆做法相同的有 32 筆：Safe 6 筆（2 個 Safe）、EOA 26 筆（17 個地址，各自送模板的一個呼叫）。這些交易全部成功執行：它們是從 hyperithm-usdc-apex-v2-9e2f 鑄造（存款）時的事件紀錄（log）找到的，失敗的交易不會留下這種紀錄。一模一樣的最近 3 筆：0x88258583…、0xa56ce3d8…、0x15133c00…。',
  );
  assert.equal(plain(body(depositPage, 'past').others), '另外 336 筆跟你這筆不一樣：形狀一樣、但有地址不在 registry 裡的 0 筆，形狀不同的 336 筆');
  const noFits = depositInputs.pastTxs.map((p) => ({ ...p, run: { ...p.run, studies: p.run.studies.filter((s) => s.kind !== 'fit') } }));
  assert.equal(plain(body(buildPage({ ...depositInputs, pastTxs: noFits }, depositNotes, depositTitle, 'zh-TW'), 'past').same), '過去的記錄裡，跟模板一模一樣、也就是跟你這筆做法相同的有 0 筆。');
  assert.equal(plain(body(pageOf(inputs), 'past').same), '過去的記錄裡，跟模板一模一樣、也就是跟你這筆做法相同的有 0 筆。');
  assert.equal(plain(body(pageOf(inputs), 'past').others), '另外 8 筆跟你這筆不一樣：形狀一樣、但用的是 registry 外的市場的 1 筆，形狀不同的 7 筆');
  const onlyExact = depositInputs.pastTxs.map((p) => ({ ...p, run: { ...p.run, studies: p.run.studies.filter((s) => s.kind === 'fit') } }));
  assert.equal(body(buildPage({ ...depositInputs, pastTxs: onlyExact }, depositNotes, depositTitle, 'zh-TW'), 'past').others, undefined, 'no line counts others when there are none');
  const twice = [...depositInputs.pastTxs, ...depositInputs.pastTxs];
  assert.deepEqual(body(buildPage({ ...depositInputs, pastTxs: twice }, depositNotes, depositTitle, 'zh-TW'), 'past').same, body(depositPage, 'past').same);
  assert.deepEqual(body(buildPage({ ...depositInputs, pastTxs: twice }, depositNotes, depositTitle, 'zh-TW'), 'past').others, body(depositPage, 'past').others);
});

test('待確認 counts the program results apart from the AI judgments, in the rail and the heading', () => {
  assert.deepEqual(depositPage.sections.find((s) => s.anchor === 'review')?.count, { kind: 'states', counts: [{ state: 'warn', n: 1, grade: 'key' }, { state: 'ask', n: 3 }] });
});

test('待確認 lists key results before reference ones, each marked, and counts the two apart', () => {
  const usdc = registry.entries.get('usdc') ?? assert.fail('usdc');
  const { coingecko: _, ...unnamed } = usdc;
  const entries = new Map([...inputs.registry.entries].map(([name, entry]) => [name, name === 'usdc' ? unnamed : entry]));
  const of: HtmlInputs = {
    ...inputs,
    registry: { ...inputs.registry, entries, byAddress: new Map([...inputs.registry.byAddress].map(([a, entry]) => [a, entry.name === 'usdc' ? unnamed : entry])) },
    abi: new Map([...inputs.abi].filter(([a]) => a !== usdc.address)),
  };
  const page = pageOf(of);
  const rows = body(page, 'review').rows.filter((r) => r.id.startsWith('usdc/'));
  assert.deepEqual(
    rows.map((r) => [r.id, r.grade]),
    [
      ['usdc/address', 'key'],
      ['usdc/abi', 'key'],
      ['usdc/source.coingecko', 'reference'],
    ],
  );
  const all = body(page, 'review').rows;
  assert.ok(all.findIndex((r) => r.grade === 'reference') > all.findLastIndex((r) => r.grade === 'key'), 'every key row comes first');
  const count = page.sections.find((s) => s.anchor === 'review')?.count;
  assert.deepEqual(
    count?.kind === 'states' ? count.counts.map((c) => [c.grade, c.n]) : [],
    [
      ['key', all.filter((r) => r.grade === 'key').length],
      ['reference', 1],
      [undefined, 1],
    ],
  );
  const html = renderPage(page);
  assert.match(html, /data-grade="reference" data-result="usdc\/source.coingecko">[\s\S]*?<span class="grade"><span class="vh">等級：<\/span>參考<\/span>/);
  assert.match(html, /<span class="cnt" data-state="warn">[^]*?參考 1<\/span>/);
});

test('notes.json that leaves out a review the page needs is refused', () => {
  const notes = notesFor(inputs);
  assert.throws(
    () => buildPage(inputs, { ...notes, reviews: {} }, title, 'zh-TW'),
    (e: unknown) => e instanceof NotesError && /morpho-oracle-cbbtc-usdc-86\/address is missing/.test(e.message),
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
    assert.deepEqual(ids, [...forSigner(ledger).filter((r) => weightOf(r) === 'key'), ...forSigner(ledger).filter((r) => weightOf(r) === 'reference')].map((r) => r.id));
    assert.ok(review.rows.every((r) => r.state === 'bad' || r.state === 'warn'));
    for (const item of page.header.strip.filter((s) => s.line !== 'providers')) {
      const rows = review.rows.filter((r) => ledger.results.find((x) => x.id === r.id)?.line === item.line);
      const expected = rows.length === 0 ? undefined : rows.reduce<State>((acc, r) => (RANK[r.state] > RANK[acc] ? r.state : acc), 'na');
      if (expected === undefined) assert.ok(item.state === 'ok' || item.state === 'na', `${item.name} is ${item.state} with nothing to review`);
      else assert.equal(item.state, expected, item.name);
    }
    const rail = page.sections.find((s) => s.anchor === 'review')?.count;
    const graded = (grade: Grade) => forSigner(ledger).filter((r) => weightOf(r) === grade);
    const counts = (['key', 'reference'] as const).flatMap((grade) => (graded(grade).length > 0 ? [{ state: worst(graded(grade)), n: graded(grade).length, grade }] : []));
    assert.deepEqual(rail, { kind: 'states', counts: [...counts, { state: 'ask', n: review.judgments.length }] });
    const reviewed = new Set(review.rows.flatMap((r) => (r.entry === undefined ? [] : [r.entry])));
    assert.deepEqual(new Set(body(page, 'addresses').open.map((r) => r.anchor)), reviewed);
    assert.equal(page.header.verdict.state, worst(ledger.results));
    assert.ok(review.rows.every((r) => stateOf(ledger.results.find((x) => x.id === r.id) ?? assert.fail(r.id)) === r.state));
  });
}

/** A template with no contract call: its page, from the template's report recording and notes that hold only what the scope requires. */
async function bareCase(id: string): Promise<Page> {
  const of = { template: id };
  const replayed = await replayInputs(ROOT, registry, of, await warmCompilers(reportCases(ROOT, registry, [of])), loadPublicSuffixList());
  const subject = replayed.inputs.subject.kind === 'template' ? replayed.inputs.subject : assert.fail('a template report');
  const html = { ...replayed.inputs, fixtures: await judgeFixtures(ROOT, subject.template, registry) };
  return buildPage(html, { ...notesFor(html), flow: [] }, replayed.title, 'zh-TW');
}

test('an ETH transfer: no address section or address strip lines, its to/value/data rules in words, and a wallet line for a call with no data', async () => {
  const page = await bareCase('eth/transfer');
  assert.deepEqual(page.sections.map((s) => s.anchor), ['review', 'flow', 'wallet', 'past', 'next']);
  assert.deepEqual(page.header.strip.map((s) => [s.line, s.state, s.count]), [['params', 'na', '沒有測試'], ['providers', 'ok', undefined]]);
  assert.match(page.header.strip[0]?.explain ?? '', /^模板沒有不限的參數/);
  const { flow } = body(page, 'flow');
  assert.deepEqual(flow.calls.map((c) => c.head), [{ kind: 'no-data', text: '轉 ETH 給收款人' }]);
  assert.deepEqual(flow.calls[0]?.args.map((a) => [a.name, a.chips.map((c) => c.label), plain(a.words), a.ai]), [
    ['to', ['你選：收款人'], '你選的收款人', undefined],
    ['value', ['你填：金額'], '你填的金額', undefined],
    ['data', ['固定'], '沒有資料', undefined],
  ]);
  assert.deepEqual(flow.key.map((k) => k.label), ['你填', '你選', '固定']);
  assert.deepEqual(flow.diagram.lifelines.map((l) => l.name), ['你的 Safe', '收款人']);
  assert.deepEqual(flow.after.map((r) => plain(r.note)), ['剛好你填的金額，給收款人']);
  const { view } = body(page, 'wallet');
  assert.equal(view.kind, 'no-data');
  assert.ok(Array.isArray(view.safeTx), 'the SafeTx row is described');
  assert.deepEqual(
    view.safeTx.map((r) => [plain(r.label), plain(r.value)]),
    [
      ['to', '你選的收款人'],
      ['value', '你填的金額'],
      ['operation', 'Call（0）'],
      ['data', '空'],
      ['baseGas', '0'],
      ['gasPrice', '0'],
      ['gasToken', '無（零地址）'],
      ['refundReceiver', '無（零地址）'],
    ],
  );
  assert.deepEqual(
    view.lines.map((line) => plain(line)),
    [
      '你的 Safe 是 proxy：Ledger 透過 Ledger 自己的伺服器把它解析成 safe-1.3.0 或 safe-1.4.1，才用得上這些描述檔；不解析 proxy 的錢包只顯示原始資料。',
      'SafeTx：錢包不顯示 safeTxGas、nonce，只有 hash 涵蓋它們。',
      'Safe 交易也可以把這一個呼叫包進官方 MultiSend（Delegate Call（1）），verify 一樣接受：這時 to 是官方 MultiSend、value 是 0，呼叫只顯示原始資料。',
      '用 Ledger 簽的話，先在 Ethereum app 的設定打開「Transaction hash」：套用描述檔時，要打開它裝置才會顯示 domain hash 和 message hash。比對這兩個 hash 才是 kiss-sign 靠的檢查，解讀看起來再對也要比。',
    ],
  );
  const next = body(page, 'next');
  assert.ok(next.steps.some((s) => plain(s.say).includes('先用小額')), 'a typed amount keeps the small first trial');
  const book = next.steps.findIndex((s) => s.command === 'pnpm kiss-sign book add <name> <address>');
  assert.ok(book !== -1 && book < next.steps.findIndex((s) => s.command === 'pnpm kiss-sign card new eth/transfer'), 'a recipient is added to the address book before the card');
  assert.ok(!next.automatic.some((line) => plain(line).includes('code pin')), 'no code pin line without a registry entry');
});

test("a call to the Safe shows the singleton's descriptor reached through the proxy, and a target with no descriptor anywhere still shows raw data", async () => {
  const { call, lines } = walletCall(await bareCase('safe/add-owner'));
  assert.equal(plain(call.title), '1 你的 Safe.addOwnerWithThreshold');
  assert.ok(Array.isArray(call.rows), 'the call is described through the Safe singletons');
  assert.deepEqual(
    call.rows.map((r) => [plain(r.label), plain(r.value)]),
    [
      ['owner', '你選的簽署人'],
      ['_threshold', '你填的門檻'],
    ],
  );
  const proxy = lines.map((line) => plain(line)).filter((line) => line.startsWith('你的 Safe 是 proxy'));
  assert.deepEqual(proxy, ['你的 Safe 是 proxy：Ledger 透過 Ledger 自己的伺服器把它解析成 safe-1.3.0 或 safe-1.4.1，才用得上這些描述檔；不解析 proxy 的錢包只顯示原始資料。']);
  assert.ok(lines.some((line) => plain(line).includes('「Transaction hash」')), 'the Ledger hash setting');
  assert.equal(walletCall(oneCallPage(oneCall(inputs, 1))).call.rows, 'no-descriptor');
});

test('a cancellation: a self-call of 0 ETH is no transfer, its nonce rule has its own row, and no effect says the Safe gives and gets nothing', async () => {
  const page = await bareCase('safe/cancel');
  const { flow } = body(page, 'flow');
  assert.deepEqual(flow.diagram.lifelines.map((l) => l.name), ['你的 Safe']);
  assert.deepEqual(flow.diagram.arrows, [{ kind: 'call', n: 1, to: 0, fn: '0 ETH、沒有資料' }]);
  assert.match(flow.diagram.narration, /Safe 呼叫自己，0 ETH、沒有資料/);
  assert.deepEqual(flow.calls.map((c) => c.head), [{ kind: 'no-data', text: '呼叫你的 Safe，0 ETH、沒有資料' }]);
  assert.deepEqual(flow.safeTx.map((r) => [r.name, r.chips.map((c) => c.label), plain(r.words)]), [['nonce', ['你填：nonce'], '你填的 nonce']]);
  assert.deepEqual(flow.after, []);
  const next = body(page, 'next');
  assert.ok(!next.steps.some((s) => plain(s.say).includes('先用小額')), 'no amount, so no small first trial');
  assert.ok(!next.steps.some((s) => s.command?.startsWith('pnpm kiss-sign book add')), 'no recipient, so no address-book step');
  assert.ok(next.automatic.some((line) => plain(line) === 'Safe 交易的 nonce 是你填的 nonce'));
  assert.ok(next.automatic.some((line) => plain(line) === '模擬後 Safe 的餘額一點都不能變'));
  assert.ok(!JSON.stringify(page).includes('card.'), 'no internal name');
});

test('the who-decides key gives a free field the meaning of the claim the template makes for it', async () => {
  const proof = body(templatePage('cctp/receive'), 'flow').flow.key.filter((k) => k.who === 'free');
  assert.deepEqual(proof.map((k) => k.means), ['換成別的值，交易就失敗']);
  const supply = body(pageOf(inputs), 'flow').flow.key.filter((k) => k.who === 'free');
  assert.ok(supply.some((k) => k.means === '換成別的值，結果一樣或交易失敗'), JSON.stringify(supply));
});

test('no strip explanation counts one thing as many', async () => {
  for (const page of [depositPage, pageOf(inputs)]) {
    for (const item of page.header.strip) assert.doesNotMatch(item.explain, /(^|[^\d])1 個(地址)?都|其餘 1 個|這 1 個/, item.explain);
  }
});

const LAYER = `0x${'52'.repeat(20)}` as Address;
const ROUTED_TO = `0x${'0a'.repeat(20)}` as Address;
const ROUTE_HASH = `0x${'0a'.repeat(32)}` as Hex;
const TODAY_BLOCK = { number: 24_000_000n, hash: `0x${'24'.repeat(32)}` as Hex };

function withLiquidityLayer(today: TodayCheck | undefined, { pinned = true }: { readonly pinned?: boolean } = {}): HtmlInputs {
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  raw['liquidity-layer'] = {
    address: LAYER,
    kind: 'lending',
    source: 'https://docs.example.org/liquidity',
    defillama: 'morpho-blue',
    routes: { implementationOf: 'getSigsImplementation(bytes4)', selectorsOf: 'getImplementationSigs(address)', seeds: ['0x00000001'] },
    ...(pinned ? { code: { hash: `0x${'52'.repeat(32)}`, routes: [{ address: ROUTED_TO, hash: ROUTE_HASH, selectors: ['0x00000002', '0x00000001'] }], from: 100 } } : {}),
  };
  raw['blue-bundles-v1'] = { ...raw['blue-bundles-v1'], dependsOn: ['liquidity-layer'] };
  const withLayer = parseRegistryAt(ROOT, raw, JSON.parse(readFileSync(join(ROOT, MARKETS_PATH), 'utf8')));
  return {
    ...inputs,
    registry: withLayer,
    spans: new Map([...inputs.spans, [LAYER, [{ kind: 'pass', text: 'PASS' }]]]),
    today: today === undefined ? undefined : { block: TODAY_BLOCK, checks: new Map([...(inputs.today?.checks ?? []), [LAYER, today]]) },
  };
}

test('an entry reached only through dependsOn shows its routes, seeds and code at the latest block, and its missing ABI proof is grey, not amber', () => {
  const of = withLiquidityLayer({ kind: 'pass', text: 'PASS' });
  assert.ok(entriesOf(of.subject, of.registry).some((entry) => entry.name === 'liquidity-layer'));

  const markdown = renderReport(of, title);
  const layerHash = `0x${'52'.repeat(32)}`;
  const routedTo = checksumAddress(ROUTED_TO);
  assert.ok(markdown.includes(`| \`liquidity-layer\` | 100 | \`${layerHash}\` | none; routes \`${routedTo}\` \`${ROUTE_HASH}\` (2 selectors) | PASS |`), 'the code pin lists the route');
  assert.ok(markdown.includes("### Today's code\n"), 'the report reads its code at the latest block');
  assert.ok(markdown.includes(`| \`liquidity-layer\` | PASS | 24000000 |`), 'its code at the latest block is its current pin');
  assert.ok(markdown.includes('`liquidity-layer` seeds: `0x00000001`.'), 'the seeds print');
  assert.ok(markdown.includes(`| \`liquidity-layer\` | 100 | \`${routedTo}\` | \`0x00000002\`, \`0x00000001\` |`), 'each route prints every selector it serves');
  assert.ok(markdown.includes(`| \`liquidity-layer\` | \`${checksumAddress(LAYER)}\` | not proved: no call targets it and nothing the program reads is decoded with its ABI; its code pin is above |`), 'the ABI row says why it is not proved');

  const ledger = judge(of, of.fixtures);
  assert.ok(notesScope(of, ledger, of.subject.kind === 'template' ? of.subject.template : assert.fail('a template report'), 'zh-TW').contracts.has('liquidity-layer'), 'a flow line may name what a called contract depends on');
  const factContracts = factsScope(of.subject.kind === 'template' ? of.subject.template : assert.fail('a template report'), of.registry, []).protocols.flatMap((p) => p.contracts.map((e) => e.name));
  assert.deepEqual(factContracts.slice(factContracts.indexOf('blue-bundles-v1'), factContracts.indexOf('blue-bundles-v1') + 2), ['blue-bundles-v1', 'liquidity-layer'], 'the protocol facts say whether what a called contract depends on is a proxy');
  const siteRow = body(pageOf(of), 'review').rows.find((r) => r.id === 'liquidity-layer/source.site') ?? assert.fail('no site review row');
  assert.equal(plain(siteRow.subject ?? []), 'docs.example.org/liquidity', 'a source result names its page as the address row does, and nothing the title says');
  assert.equal(stateOf(ledger.results.find((r) => r.id === 'liquidity-layer/abi') ?? assert.fail('no ABI result')), 'na');
  assert.equal(stateOf(ledger.results.find((r) => r.id === 'liquidity-layer/code.today') ?? assert.fail('no result at the latest block')), 'ok');
  const abiItem = (ledgerOf: typeof ledger) => strip(ledgerOf).find((item) => item.line === 'abi');
  assert.deepEqual(abiItem(ledger), abiItem(judge(inputs, inputs.fixtures)), '原始碼驗證 counts and colours the same without the dependency');

  const page = pageOf(of);
  const explain = (line: string) => page.header.strip.find((item) => item.line === line)?.explain ?? '';
  assert.match(explain('abi'), /liquidity-layer 沒有呼叫直接打到，也不用它的函式定義解碼，所以沒有證明，不算在內；它跑的程式碼在「合約沒被換掉」比對。/);
  assert.match(explain('code'), /liquidity-layer 沒有 ABI 證明比對它今天的程式碼，報告另外在最新區塊讀它跑的程式碼/);
  assert.match(explain('code'), /seeds 接到的每個實作和它的函式清單也一樣確認，沒有 seed 接到的實作不檢查。/);
  const addresses = body(page, 'addresses');
  const row = [...addresses.open, ...addresses.folded].find((r) => r.name === 'liquidity-layer') ?? assert.fail('no address row');
  assert.equal(page.header.strip.find((item) => item.line === 'code')?.state, pageOf(inputs).header.strip.find((item) => item.line === 'code')?.state);
  assert.deepEqual(row.codeLines.map(plain), [
    '沒有呼叫直接打到這個合約，所以沒有 ABI 證明。每次簽名碰到 blue-bundles-v1 時，程式也確認它的程式碼還是 code pin 記錄的那份。',
    '它依函式選擇器把呼叫分給各自的實作。code pin 的 seeds 接到 1 個實作：',
    `${routedTo}，程式碼 hash ${ROUTE_HASH}，2 個函式`,
    '沒有 seed 接到的實作，code pin 沒有記錄，程式也不檢查。',
  ]);
  const html = renderPage(page);
  assert.ok(html.includes(`<div class="confirmed"><span class="addr">${routedTo}</span>，程式碼 hash <span class="addr">${ROUTE_HASH}</span>，2 個函式</div>`), 'the HTML row prints the route in full');
});

test('a dependency that runs other code at the latest block is red in 合約沒被換掉 and in 待確認; one with no read there is amber', () => {
  const finding = withLiquidityLayer({ kind: 'finding', text: 'FINDING: runs something else' });
  const page = pageOf(finding);
  assert.equal(page.header.strip.find((item) => item.line === 'code')?.state, 'bad');
  const review = body(page, 'review').rows.find((r) => r.id === 'liquidity-layer/code.today') ?? assert.fail('no review row');
  assert.equal(review.state, 'bad');
  assert.equal(plain(review.subject ?? []), '最新區塊');
  assert.ok(renderReport(finding, title).includes('| `liquidity-layer` | FINDING: runs something else | 24000000 |'));

  const unread = withLiquidityLayer(undefined);
  assert.equal(stateOf(judge(unread, unread.fixtures).results.find((r) => r.id === 'liquidity-layer/code.today') ?? assert.fail('no result')), 'warn');
  assert.ok(renderReport(unread, title).includes('| `liquidity-layer` | not read |  |'));
});

test("a dependency with no code pin says only that it has no ABI proof, not that each signing checks its code", () => {
  const of = withLiquidityLayer(undefined, { pinned: false });
  const addresses = body(pageOf(of), 'addresses');
  const row = [...addresses.open, ...addresses.folded].find((r) => r.name === 'liquidity-layer') ?? assert.fail('no address row');
  assert.deepEqual(row.codeLines.map(plain), ['沒有呼叫直接打到這個合約，所以沒有 ABI 證明。']);
  assert.ok(!judge(of, of.fixtures).results.some((r) => r.id === 'liquidity-layer/code.today'), 'an unpinned entry has only its not-pinned result');
  assert.ok(renderReport(of, title).includes('| `liquidity-layer` | not pinned |  |'));
});

const callDoc = (page: Page, n: number): DocLine => {
  const head = body(page, 'flow').flow.calls[n - 1]?.head;
  return head?.kind === 'fn' ? head.doc : assert.fail(`call ${n} has no function`);
};
const nestedDocs = (page: Page): [string, string | undefined][] => {
  const all = (rows: readonly ArgRow[]): ArgRow[] => rows.flatMap((row) => [row, ...all(row.parts.flatMap((g) => g.rows))]);
  return all(args(page)).flatMap((row) => (row.doc === undefined ? [] : [[plain(row.words), row.doc.label] as [string, string | undefined]]));
};
const APPROVE_PAGE = 'https://github.com/circlefin/stablecoin-evm/blob/fc85788bc7c23cefe3df1a757133048bfddadeaa/contracts/v1/FiatTokenV1.sol';

test("each call shows its function's documentation page under its heading, and a nested call in its data row", () => {
  assert.deepEqual(callDoc(depositPage, 1), { state: 'ok', phrase: undefined, href: APPROVE_PAGE, label: 'github.com/circlefin/stablecoin-evm', note: undefined });
  assert.equal(callDoc(depositPage, 2).label, 'github.com/morpho-org/bundler3/…/Bundler3.sol');
  assert.deepEqual(nestedDocs(depositPage), [
    ['erc20TransferFrom (0xd96ca0b9)', 'github.com/morpho-org/bundler3/…/GeneralAdapter1.sol'],
    ['erc4626Deposit (0x6ef5eeae)', 'github.com/morpho-org/bundler3/…/GeneralAdapter1.sol'],
  ]);
  const html = renderPage(depositPage);
  assert.ok(html.includes(`<div class="doc" data-state="ok"><svg class="i ok" role="img" aria-label="通過"><use href="#ok"/></svg><span><span class="f3">文件：</span><a href="${APPROVE_PAGE}">github.com/circlefin/stablecoin-evm</a></span></div>`));
});

test("a function named by its standard shows the standard's page, with the caveat that the contract may not follow it", () => {
  const subject = depositInputs.subject.kind === 'template' ? depositInputs.subject : assert.fail('a template report');
  const erc20 = STANDARDS.get('erc-20') ?? assert.fail('erc-20');
  const docs = subject.docs.map((d) => (d.fn.signature === 'approve(address,uint256)' ? { ...d, url: erc20.page, standard: erc20 } : d));
  const pages = new Map([...depositInputs.pages.pages, [pageUrlOf(erc20.page), { kind: 'served', blocks: [{ text: 'function approve(address _spender, uint256 _value) public returns (bool success)' }] }]]);
  const commits = new Map([...depositInputs.pages.commits, ['ethereum/ercs@ae65e89408f387ffb47d220879925c4ab384dfc2', { kind: 'on-default', branch: 'master', status: 'behind' }]]);
  const page = buildPage({ ...depositInputs, subject: { ...subject, docs }, pages: { ...depositInputs.pages, pages, commits } as HtmlInputs['pages'] }, depositNotes, depositTitle, 'zh-TW');
  assert.deepEqual(callDoc(page, 1), { state: 'ok', phrase: undefined, href: erc20.page, label: 'ERC-20 標準頁', note: '標準定義這個函式，不代表合約照標準做' });
  assert.ok(renderPage(page).includes(`<a href="${erc20.page}">ERC-20 標準頁</a>`));
});

test('a documentation page read that does not name the function shows its amber icon and 頁上沒有這個函式 under the call', () => {
  const pages = new Map([...depositInputs.pages.pages].map(([url, page]) => [url, url === pageUrlOf(APPROVE_PAGE as HttpsUrl) ? { kind: 'served', blocks: [{ text: 'a page about something else' }] } : page] as const));
  const lacking = { ...depositInputs, pages: { ...depositInputs.pages, pages } } as HtmlInputs;
  const notes = depositNotes as { readonly reviews: Record<string, unknown> };
  const reviews = { ...notes.reviews, 'usdc/doc.0x095ea7b3.page': { status: 'concern', text: both('review'), recommendation: both('look') } };
  const page = buildPage(lacking, { ...notes, reviews }, depositTitle, 'zh-TW');
  assert.deepEqual(callDoc(page, 1), { state: 'warn', phrase: 'not-on-page', href: APPROVE_PAGE, label: 'github.com/circlefin/stablecoin-evm', note: undefined });
  assert.ok(renderPage(page).includes(`<div class="doc" data-state="warn"><svg class="i warn" role="img" aria-label="注意"><use href="#warn"/></svg><span><span class="f3">文件：</span><a href="${APPROVE_PAGE}">github.com/circlefin/stablecoin-evm</a><span class="res">頁上沒有這個函式</span>`));
});

test('a documentation page the program has no copy of shows its amber icon and 讀不到 under the call', () => {
  const pages = new Map([...depositInputs.pages.pages].filter(([url]) => url !== pageUrlOf(APPROVE_PAGE as HttpsUrl)));
  const unread = { ...depositInputs, pages: { ...depositInputs.pages, pages } };
  const notes = depositNotes as { readonly reviews: Record<string, unknown> };
  const reviews = { ...notes.reviews, 'usdc/doc.0x095ea7b3.page': { status: 'concern', text: both('review'), recommendation: both('look') } };
  const page = buildPage(unread, { ...notes, reviews }, depositTitle, 'zh-TW');
  assert.deepEqual(callDoc(page, 1), { state: 'warn', phrase: 'unread', href: APPROVE_PAGE, label: 'github.com/circlefin/stablecoin-evm', note: undefined });
  assert.ok(renderPage(page).includes(`<div class="doc" data-state="warn"><svg class="i warn" role="img" aria-label="注意"><use href="#warn"/></svg><span><span class="f3">文件：</span><a href="${APPROVE_PAGE}">github.com/circlefin/stablecoin-evm</a><span class="res">讀不到</span>`));
});

function withComputingFactory(first: string): { readonly of: HtmlInputs; readonly notes: unknown; readonly vault: RegistryEntry } {
  const subject = depositInputs.subject.kind === 'template' ? depositInputs.subject : assert.fail('a template report');
  const vault = subject.vault ?? assert.fail('a per-vault report');
  const name = vault.attributes.factory ?? assert.fail('a vault with a factory');
  const factory = depositInputs.registry.entries.get(name) as RegistryEntry;
  const computing: RegistryEntry = {
    ...factory,
    instanceCheck: [
      {
        ask: { kind: 'factory' },
        fn: parseFunctionSignature('computeToken(address,string)'),
        args: [{ kind: 'party', party: { kind: 'attribute', attribute: 'asset' } }, { kind: 'string', value: 'fToken' }],
        answers: { kind: 'party', party: { kind: 'instance' } },
        word: undefined,
      },
    ],
  };
  const swap = (entry: RegistryEntry) => (entry.name === name ? computing : entry);
  const registry = {
    ...depositInputs.registry,
    entries: new Map([...depositInputs.registry.entries].map(([key, entry]) => [key, swap(entry)])),
    byAddress: new Map([...depositInputs.registry.byAddress].map(([key, entry]) => [key, swap(entry)])),
  };
  const stored = depositInputs.vaults.get(vault.name) ?? assert.fail('stored vault evidence');
  const of: HtmlInputs = { ...depositInputs, registry, vaults: new Map([[vault.name, [first, ...stored.split('\n').slice(1)].join('\n')]]) };
  const given = (depositNotes as { readonly reviews: Record<string, unknown> }).reviews;
  const reviews = notesScope(of, judge(of, of.fixtures), subject.template, 'zh-TW').reviews.map((id) => [id, given[id] ?? { status: 'concern', text: both(`review ${id}`), recommendation: both('look') }]);
  return { of, notes: { ...(depositNotes as object), reviews: Object.fromEntries(reviews) }, vault };
}

test('a vault its factory admits by computing its address renders in both reports, its 工廠 line confirming it', () => {
  const vault = (depositInputs.subject.kind === 'template' ? depositInputs.subject.vault : undefined) ?? assert.fail('a per-vault report');
  const first = `admitted     vault-v2-factory answered computeToken(${vault.attributes.asset},"fToken") = ${checksumAddress(vault.address)} at block 26404800`;
  const { of, notes } = withComputingFactory(first);
  assert.ok(renderReport(of, depositTitle).includes(`\`\`\`text\n${first}\n`), 'the Markdown report prints the stored line');
  const page = buildPage(of, notes, depositTitle, 'zh-TW');
  const factoryRow = body(page, 'vault').vault.rows.find((row) => row.label === '工廠') ?? assert.fail('no 工廠 row');
  assert.equal(plain(factoryRow.value), `vault-v2-factory 回答 computeToken(usdc,"fToken") = ${checksumAddress(vault.address)}`);
  const addresses = body(page, 'addresses');
  const row = [...addresses.open, ...addresses.folded].find((r) => r.name === vault.name) ?? assert.fail('no address row');
  assert.deepEqual(row.sources.find((line) => line.label === '工廠'), { label: '工廠', href: undefined, state: 'ok', phrase: undefined, others: [], site: undefined, newest: undefined });
  assert.ok(renderPage(page).includes('computeToken(usdc,&#34;fToken&#34;)'), 'the HTML report escapes the quoted constant');
});

test("a vault its factory computed another address for renders in both reports, its 工廠 line red", () => {
  const vault = (depositInputs.subject.kind === 'template' ? depositInputs.subject.vault : undefined) ?? assert.fail('a per-vault report');
  const first = `REFUSED vault-v2-factory answered computeToken(usdc,"fToken") = 0x5C20B550819128074FD538Edf79791733ccEdd18, not ${vault.name}: its official contract is another; the vault's code is not read`;
  const { of, notes } = withComputingFactory(first);
  assert.ok(renderReport(of, depositTitle).includes(`\`\`\`text\n${first}\n`), 'the Markdown report prints the stored line');
  const page = buildPage(of, notes, depositTitle, 'zh-TW');
  const addresses = body(page, 'addresses');
  const row = addresses.open.find((r) => r.name === vault.name) ?? assert.fail('the vault row is not open');
  assert.deepEqual(row.sources.find((line) => line.label === '工廠'), { label: '工廠', href: undefined, state: 'bad', phrase: 'not-created', others: [], site: undefined, newest: undefined });
  const review = body(page, 'review').rows.find((r) => r.id === `${vault.name}/factory.admitted`) ?? assert.fail('no review row');
  assert.equal(review.state, 'bad');
  assert.equal(plain(body(page, 'vault').vault.rows.find((r) => r.label === '工廠')?.value ?? []), `沒有記錄到 vault-v2-factory 回答它建立了這個合約`);
});

test('an address held as a 32-byte word reads as its address rule, left-padded, in both languages, and a fixed one prints the padded word', () => {
  const subject = inputs.subject.kind === 'template' ? inputs.subject : assert.fail('a template report');
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'cctp', 'deposit-for-burn', 'template.json'), 'utf8'));
  const pageOfBurn = (language: 'en' | 'zh-TW', mintRecipient?: unknown): ArgRow => {
    if (mintRecipient !== undefined) raw.calls[1].args.mintRecipient = mintRecipient;
    const burn = parseTemplate(raw, registry);
    const of = { ...inputs, subject: { ...subject, template: burn, docs: parseDocs(readDocs(ROOT, burn.id), burn, registry) }, fixtures: [] };
    return arg(buildPage(of, { ...notesFor(of), flow: [] }, title, language), '2.depositForBurn.mintRecipient');
  };
  const zh = pageOfBurn('zh-TW');
  assert.equal(plain(zh.words), '你選的收款人，放在 32 bytes 裡、前面補 12 個 0 byte');
  assert.equal(zh.value, undefined);
  assert.equal(plain(pageOfBurn('en').words), 'the recipient you pick, as a 32-byte word left-padded with 12 zero bytes');
  const messenger = registry.entries.get('cctp-token-messenger-v2') ?? assert.fail('the messenger');
  const fixed = pageOfBurn('en', { addressWord: { contract: 'cctp-token-messenger-v2' } });
  assert.equal(fixed.value, `0x${'00'.repeat(12)}${messenger.address.slice(2)}`);
  assert.equal(plain(fixed.words), 'cctp-token-messenger-v2, as a 32-byte word left-padded with 12 zero bytes');
});

test('a withinSeconds field says in plain words, in both languages and in the Markdown report, how far after the block time it may be', () => {
  const subject = inputs.subject.kind === 'template' ? inputs.subject : assert.fail('a template report');
  const [n, at] = subject.template.calls.flatMap((call, n) => (call.data === 'empty' ? [] : call.data.fn.params.flatMap((param, i) => (param.type.kind === 'uint' ? [[n, i] as const] : [])))).at(-1) ?? assert.fail('a uint argument');
  const calls = subject.template.calls.map((call, i) => {
    if (i !== n || call.data === 'empty') return call;
    return { ...call, data: { ...call.data, args: call.data.args.map((rule, a) => (a === at ? { kind: 'within-seconds' as const, seconds: 604800n } : rule)) } };
  });
  const bounded: HtmlInputs = { ...inputs, subject: { ...subject, template: { ...subject.template, calls } }, fixtures: [] };
  const rowOf = (language: 'en' | 'zh-TW') => {
    const page = buildPage(bounded, notesFor(bounded), title, language);
    const rows = body(page, 'flow').flow.calls.flatMap((call) => call.args);
    return { row: rows.find((r) => r.chips.some((c) => c.who === 'bounded')) ?? assert.fail('a bounded row'), key: body(page, 'flow').flow.key };
  };
  const zh = rowOf('zh-TW');
  assert.equal(plain(zh.row.words), '最多比區塊時間晚 604800 秒（約 7 天）');
  assert.match(plain(zh.row.qualifier), /還沒執行的交易用 verify 讀到的最新區塊，已執行的用它所在的區塊；更晚就 MISMATCH$/);
  assert.deepEqual(zh.row.chips.map((c) => c.label), ['app 填，有上限']);
  assert.ok(zh.key.some((k) => k.who === 'bounded' && k.means === '超過上限就 MISMATCH'));
  const en = rowOf('en');
  assert.equal(plain(en.row.words), "at most 604800 s (about 7 d) after the block's time");
  assert.deepEqual(en.row.chips.map((c) => c.label), ['app fills, up to a limit']);
  const markdown = renderReport(bounded, title);
  assert.ok(markdown.includes('a time at most 604800 seconds after the time of the block the transaction is judged on: the latest block for a pending transaction, the block it ran in for an executed one; a later time is a MISMATCH'));
});

test('a source page whose label binds another address shows that address in full, red, on its source line and in 待確認, in both languages', () => {
  const usdc = depositInputs.registry.entries.get('usdc') ?? assert.fail('usdc');
  const other = '0x5C20B550819128074FD538Edf79791733ccEdd18';
  const served = { kind: 'served', blocks: [{ text: `Ethereum ${other.toLowerCase()}`, heading: 'Mainnet' }] } as const;
  const pages = new Map([...depositInputs.pages.pages].map(([url, page]) => [url, url === pageUrlOf(usdc.source) ? served : page] as const));
  const of = { ...depositInputs, pages: { ...depositInputs.pages, pages } } as HtmlInputs;
  const subject = of.subject.kind === 'template' ? of.subject : assert.fail('a template report');
  const given = (depositNotes as { readonly reviews: Record<string, unknown> }).reviews;
  const reviews = notesScope(of, judge(of, of.fixtures), subject.template, 'zh-TW').reviews.map((id) => [id, given[id] ?? { status: 'concern', text: both(`review ${id}`), recommendation: both('look') }]);
  const notes = { ...(depositNotes as object), reviews: Object.fromEntries(reviews) };
  const page = buildPage(of, notes, depositTitle, 'zh-TW');
  const addresses = body(page, 'addresses');
  const row = addresses.open.find((r) => r.name === 'usdc') ?? assert.fail('the usdc row is not open');
  const line = row.sources.find((l) => l.href === usdc.source) ?? assert.fail('no source line');
  assert.deepEqual([line.state, line.others], ['bad', [other]]);
  const review = body(page, 'review').rows.find((r) => r.id === 'usdc/source.page') ?? assert.fail('no review row for the page');
  assert.equal(review.state, 'bad');
  assert.equal(review.grade, 'key');
  const zh = renderPage(page);
  assert.ok(zh.includes(`標籤旁列的是 ${other}`), 'the source line names the other address');
  assert.ok(zh.includes(`不是這個地址： ${other}`), '待確認 names the other address');
  const en = renderPage(buildPage(of, notes, depositTitle, 'en'));
  assert.ok(en.includes(`lists ${other} under the label`));
  assert.ok(en.includes(`next to the label the registry names: ${other}`));
});
