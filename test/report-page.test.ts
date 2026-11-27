import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import type { AbiRefusal } from '../src/contracts/prove.ts';
import { parseFunctionSignature } from '../src/decode/abi.ts';
import { MARKETS_PATH, REGISTRY_PATH, loadRegistry, registryFromTexts } from '../src/registry.ts';
import { weightOf } from '../src/research/grades.ts';
import type { Grade } from '../src/research/grades.ts';
import { forSigner, judge, stateOf, strip, worst } from '../src/research/ledger.ts';
import type { EntryReport, FieldFact } from '../src/research/erc7730.ts';
import type { State } from '../src/research/ledger.ts';
import { NotesError, argumentTree, notesInstance, notesPath, notesScope, readNotes } from '../src/research/notes.ts';
import { notesNeeded } from '../src/research/notes-needed.ts';
import type { ArgNode } from '../src/research/notes.ts';
import type { Kept, Misfit } from '../src/research/past-txs.ts';
import type { Measurement } from '../src/research/amounts.ts';
import { SUMMARIES_DIR, parseSummary, runOf } from '../src/research/past-txs-summary.ts';
import { factsScope } from '../src/research/protocol-facts.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { renderPage } from '../src/research/report-html.ts';
import { WORDS } from '../src/research/report-words.ts';
import { pastFields } from '../src/research/report-past.ts';
import { cardAddresses, shapesOf } from '../src/research/study.ts';
import { buildPage, constCast } from '../src/research/report-page.ts';
import type { AddressRow, ArgRow, Body, DocLine, HtmlInputs, Inline, Page, PastBlock, WalletCall } from '../src/research/report-page.ts';
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
import type { Rule, Template } from '../src/template/template.ts';
import type { TraceCall } from '../src/research/trace.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';
import { repoWithFrozenReports } from './frozen-reports.ts';
import { repoWithTestFixtures, tempDir } from './repo-with-test-fixtures.ts';
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
  depositNotes = readNotes(FROZEN, deposit.template, notesInstance(depositInputs.subject));
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
const past = (page: Page): PastBlock => body(page, 'past').past ?? assert.fail('no past transactions');
const freeItems = (page: Page) => body(page, 'flow').flow.key.flatMap((g) => g.items).filter((k) => k.who === 'free');
const fieldsOf = (template: Template): ArgNode[] => {
  const under = (node: ArgNode): ArgNode[] => [node, ...node.children.flatMap(under)];
  return argumentTree(template).flatMap((call) => call.args.flatMap(under));
};
const body = <K extends Body['kind']>(page: Page, kind: K): Extract<Body, { kind: K }> => page.sections.find((s) => s.body.kind === kind)?.body as Extract<Body, { kind: K }>;
/** 地址's rows across its groups, open and folded. */
const addressRows = (page: Page): { readonly open: readonly AddressRow[]; readonly folded: readonly AddressRow[] } => {
  const { groups } = body(page, 'addresses');
  return { open: groups.flatMap((g) => g.open), folded: groups.flatMap((g) => g.folded) };
};
const args = (page: Page): ArgRow[] => body(page, 'flow').flow.calls.flatMap((call) => call.args);
const everyRow = (rows: readonly ArgRow[]): ArgRow[] => rows.flatMap((row) => [row, ...everyRow(row.parts.flatMap((g) => g.rows))]);
const arg = (page: Page, key: string): ArgRow => args(page).find((a) => a.key === key) ?? assert.fail(`no row ${key}`);
const plain = (spans: readonly unknown[] | undefined): string =>
  (spans ?? []).map((s) => (typeof s === 'string' ? s : 'label' in (s as object) ? (s as { label: string }).label : Object.values(s as object)[0])).join('');

test('the page of morpho/market-supply puts its sections in the signer order', { timeout: 600_000 }, () => {
  const page = pageOf(inputs);
  assert.deepEqual(
    page.sections.map((s) => s.anchor),
    ['review', 'flow', 'protocol-morpho-blue', 'wallet', 'addresses', 'past', 'next', 'usage'],
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
  assert.equal(plain(value.qualifier), '卡片記著這個值，交易裡不同就 MISMATCH');

  const market = arg(page, '2.blueBundlesV1Supply.marketParams');
  assert.deepEqual(market.chips, [{ who: 'you-pick', label: '你選：市場' }]);
  assert.equal(market.value, undefined);
  assert.equal(plain(market.words), '你選的市場');
  assert.equal(market.id, undefined);
  const parts = market.parts.flatMap((g) => g.rows);
  assert.deepEqual(
    parts.map((p) => [p.name, p.value, p.chips.length]),
    [
      ['loanToken', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 1],
      ['collateralToken', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 1],
      ['oracle', '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a', 1],
      ['irm', '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', 1],
      ['lltv', '860000000000000000', 1],
      ['loanToken', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 1],
      ['collateralToken', '0x098697bA3Fee4eA76294C5d6A466a4e3b3E95FE6', 1],
      ['oracle', '0x5096642B7c7CD82198932f3FADd873EC2fcDeb6d', 1],
      ['irm', '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', 1],
      ['lltv', '860000000000000000', 1],
      ['loanToken', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 1],
      ['collateralToken', '0x098697bA3Fee4eA76294C5d6A466a4e3b3E95FE6', 1],
      ['oracle', '0x5096642B7c7CD82198932f3FADd873EC2fcDeb6d', 1],
      ['irm', '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', 1],
      ['lltv', '915000000000000000', 1],
      ['loanToken', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 1],
      ['collateralToken', '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', 1],
      ['oracle', '0xa3A7A3ceFee206f9d7Fe00eC3C83324ED4228411', 1],
      ['irm', '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', 1],
      ['lltv', '860000000000000000', 1],
    ],
  );

  const permit = arg(page, '2.blueBundlesV1Supply.loanTokenPermit');
  assert.deepEqual(permit.chips, [], 'an argument whose parts differ carries no chip of its own');
  assert.equal(permit.value, undefined);
  assert.equal(plain(permit.words), '2 個部分');
  assert.deepEqual(
    permit.parts.flatMap((g) => g.rows).map((p) => [p.name, p.value, p.chips]),
    [
      ['kind', '0', [{ who: 'fixed', label: '固定' }]],
      ['data', undefined, [{ who: 'free', label: '這裡不檢查' }]],
    ],
    'each part carries its own chip, as a plain argument does',
  );
  assert.deepEqual(arg(page, '2.blueBundlesV1Supply.deadline').chips, [{ who: 'free', label: '這裡不檢查' }]);
  assert.match(arg(page, '2.blueBundlesV1Supply.deadline').reason?.ai ?? '', /^模板為什麼不檢查它：./, "a free value shows the template's reason under its row");
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
  assert.ok(after.some((row) => plain(row.label) === `Safe 的 ${deposit.instance}` && plain(row.value) === '只能因捨入變動' && row.ai?.ai === WORDS['zh-TW'].aiChose(WORDS['zh-TW'].toleranceChosen, why['zh-TW'])), JSON.stringify(after.map((r) => r.label)));
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
  const { open, folded } = addressRows(page);
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
    ['review', 'flow', 'protocol-morpho-blue', 'vault-hyperithm-usdc-apex-v2-9e2f', 'wallet', 'addresses', 'past', 'next', 'usage'],
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
  assert.deepEqual(body(depositPage, 'review').rows.map((r) => [r.id, r.state, plain(r.why).replace(/0x[0-9a-fA-F]{40}/, '<address>')]), [
    ['hyperithm-usdc-apex-v2-9e2f/address', 'warn', '只在 工廠 找到 <address>；至少要 2 個地方。'],
  ]);
  const { open, folded } = addressRows(depositPage);
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
  const page = buildPage(of, readNotes(FROZEN, revoke.template, notesInstance(replayed.inputs.subject)), replayed.title, 'zh-TW');
  assert.ok(!body(page, 'review').rows.some((r) => r.id.startsWith('acuto-usdc-v2-4a57-market-adapter/')), 'the adapter is not for the signer');
  const { open, folded } = addressRows(page);
  const adapter = [...open, ...folded].find((r) => r.name === 'acuto-usdc-v2-4a57-market-adapter') ?? assert.fail('the adapter row');
  assert.equal(adapter.confirmed, '在 2 個地方確認：協議 API、工廠和它登記的每一項檢查');
  assert.deepEqual(
    adapter.sources.filter((s) => s.label === '工廠和它登記的每一項檢查').map((s) => s.state),
    ['ok'],
  );
});

test('each past-transactions recording names the entry its search anchored on', () => {
  const search = past(depositPage).search;
  assert.ok(search.length > 0);
  for (const r of search) assert.match(r.count, /^搜尋 [a-z0-9-]+ 的鑄造（存款），找到 \d+ 筆，研究 \d+ 筆$/);
});

test('a mint of a token that is not a vault is a mint, not a deposit', () => {
  const usdc = frozenRegistry.entries.get('usdc') ?? assert.fail('usdc');
  const pastTxs = depositInputs.pastTxs.map((r) => ({ ...r, query: { ...r.query, token: usdc.address } }));
  const page = buildPage({ ...depositInputs, pastTxs }, depositNotes, depositTitle, 'zh-TW');
  for (const r of past(page).search) assert.match(r.count, /^搜尋 usdc 的鑄造，/);
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
  assert.ok(body(depositPage, 'flow').flow.key.some((g) => g.title === 'kiss-sign' && g.items.some((k) => k.label === '程式算')), 'the key names the computed label');
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
  const addresses = addressRows(page);
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
      ['交易地址', 'warn', '7 / 10'],
      ['原始碼驗證', 'ok', '6 / 6'],
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
  const { worked, differ, search } = past(pageOf(inputs));
  assert.equal(worked.answer, '研究過的交易裡沒有 Safe 這樣做過。');
  assert.equal(plain(worked.rest), 'EOA：0 次。');
  assert.equal(differ.lead, '8 筆交易做了這個模板不允許的事。');
  assert.deepEqual(
    differ.folded?.table.rows.map((row) => row.slice(0, 3).map(plain)),
    [
      ['blueBundlesV1Supply.loanTokenPermit.kind 是 2 種別的值，模板要 0', '0', '7'],
      ['形狀一樣，但 blueBundlesV1Supply.marketParams 用的是 registry 外的市場', '0', '1'],
    ],
    'a supply to a market outside the registry has the template shape; one with a signed permit, which the template fixes to kind 0, has another shape',
  );
  assert.equal(plain(search[0]?.lines[0]), 'Alchemy 和 Etherscan 找到的完全一樣（528 = 528）。');
});

test('a bundle with another number of items is grouped and named by the functions its items call, each example linked to Etherscan', () => {
  const { differ, search } = past(depositPage);
  assert.equal(differ.lead, '336 筆交易做了這個模板不允許的事。');
  assert.deepEqual(
    differ.folded?.table.rows.map((row) => row.slice(0, 3).map(plain)),
    [
      ['multicall.bundle 有 3 項，模板是 2 項，呼叫 usdc.permit → general-adapter-1.erc20TransferFrom → general-adapter-1.erc4626Deposit', '0', '324'],
      ['multicall.bundle 有 5 項，模板是 2 項', '0', '7'],
      ['沒有 approve：只有 bundler3.multicall', '3', '0'],
      ['multicall.bundle 有 4 項，模板是 2 項，呼叫 general-adapter-1.erc20TransferFrom → general-adapter-1.erc4626Deposit → general-adapter-1.erc20Transfer → general-adapter-1.erc20Transfer', '0', '1'],
      ['multicall.bundle 有 3 項，模板是 2 項，呼叫 general-adapter-1.erc20TransferFrom → general-adapter-1.erc4626Redeem → general-adapter-1.erc4626Deposit', '0', '1'],
    ],
  );
  assert.match(JSON.stringify(differ.folded?.table.rows[0]?.[4]), /https:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}/);
  assert.ok(search.some((s) => s.lines.some((line) => /筆是別的操作，不列入：hyperithm-usdc-apex-v2-9e2f\.deposit \d+ 筆/.test(plain(line)))));
});

test('過去交易 leads with how many past transactions were exactly the template, had its shape outside the registry, or another shape, each counted once, and the latest of them', () => {
  const { worked } = past(depositPage);
  assert.equal(worked.answer, '成功過，2 個 Safe 一共做過 6 次。');
  assert.match(plain(worked.rest), /^EOA：26 次，來自 17 個地址，各自送模板的一個呼叫。最近一次是 .+。全部成功執行。最近 3 筆：0x88258583… 0xa56ce3d8… 0x15133c00…$/);
  const noFits = depositInputs.pastTxs.map((p) => ({ ...p, run: { ...p.run, studies: p.run.studies.filter((s) => s.kind !== 'fit') } }));
  assert.equal(past(buildPage({ ...depositInputs, pastTxs: noFits }, depositNotes, depositTitle, 'zh-TW')).worked.answer, '研究過的交易裡沒有 Safe 這樣做過。');
  const onlyExact = depositInputs.pastTxs.map((p) => ({ ...p, run: { ...p.run, studies: p.run.studies.filter((s) => s.kind === 'fit') } }));
  assert.equal(past(buildPage({ ...depositInputs, pastTxs: onlyExact }, depositNotes, depositTitle, 'zh-TW')).differ.folded, undefined, 'no table of others when there are none');
  const twice = past(buildPage({ ...depositInputs, pastTxs: [...depositInputs.pastTxs, ...depositInputs.pastTxs] }, depositNotes, depositTitle, 'zh-TW'));
  assert.deepEqual([twice.worked, twice.numbers, twice.differ], [worked, past(depositPage).numbers, past(depositPage).differ]);
});

test('the values the app fills come from transactions that match and from those that differ elsewhere, by sender, with the block times that were not recorded', () => {
  const { template } = inputs.subject;
  const { key, rule } = fieldsOf(template).find(({ param, rule }) => rule.kind === 'free' && param?.type.kind === 'uint') ?? assert.fail('a free number');
  const field = shapesOf(template).whole.loosened.rules.findIndex((leaf) => leaf === rule);
  const study = (n: number, sender: 'safe' | 'eoa', time: bigint | undefined, seconds: bigint): Misfit => ({
    kind: 'misfit',
    hash: `0x${`${n}`.padStart(64, '0')}` as Hex,
    block: BigInt(n),
    sender: sender === 'safe' ? { kind: 'safe', address: '0x1111111111111111111111111111111111111111' as Address } : { kind: 'eoa', address: '0x2222222222222222222222222222222222222222' as Address, call: 0 },
    reason: { kind: 'other' },
    free: [{ field, type: { kind: 'uint', bits: 256 }, value: `${(time ?? 0n) + seconds}` }],
    time,
  });
  const values = (studies: readonly Misfit[], times: readonly string[]) => pastFields(studies, template, times).find((f) => f.key === key)?.past ?? assert.fail(key);
  const timed = values([study(1, 'safe', 1000n, 60n), study(2, 'safe', 2000n, 7200n), study(3, 'eoa', 3000n, 600n), study(4, 'safe', undefined, 5n)], [key]);
  assert.ok(timed.kind === 'time');
  assert.deepEqual(timed.rows.map((r) => [r.group, r.spread?.count, r.spread?.min, r.spread?.max]), [['safe-exact', undefined, undefined, undefined], ['safe-differs', 2, 60n, 7200n], ['eoa-differs', 1, 600n, 600n]]);
  assert.deepEqual(timed.rows.map((r) => r.unrecorded), [0, 1, 0]);
  const listed = values([study(1, 'safe', 0n, 7n), study(2, 'eoa', 0n, 7n), study(3, 'eoa', 0n, 8n)], []);
  assert.deepEqual(listed, {
    kind: 'values',
    groups: ['safe-exact', 'safe-differs', 'eoa-differs'],
    values: [
      { value: '7', counts: { 'safe-exact': 0, 'safe-differs': 1, 'eoa-exact': 0, 'eoa-differs': 1 } },
      { value: '8', counts: { 'safe-exact': 0, 'safe-differs': 0, 'eoa-exact': 0, 'eoa-differs': 1 } },
    ],
  });
  const many = values(Array.from({ length: 7 }, (_, i) => study(i, 'safe', 0n, BigInt(i))), []);
  assert.equal(many.kind, 'numbers', 'more different numbers than a list holds give their spread');
});

/** The page of a template whose past transactions are exactly `studies`. */
const studiedPage = (studies: readonly Kept[], of: HtmlInputs = inputs, language: 'en' | 'zh-TW' = 'en'): PastBlock =>
  past(buildPage({ ...of, pastTxs: of.pastTxs.slice(0, 1).map((r) => ({ ...r, run: { ...r.run, studies } })) }, notesFor(of), title, language));

const hashOf = (n: number): Hex => `0x${`${n}`.padStart(64, '0')}` as Hex;
const SENDER: Misfit['sender'] = { kind: 'safe', address: '0x1111111111111111111111111111111111111111' as Address };
const misfitAt = (n: number, reason: Misfit['reason'], more: Partial<Misfit> = {}): Misfit => ({ kind: 'misfit', hash: hashOf(n), block: BigInt(n), sender: SENDER, reason, free: [], time: undefined, ...more });

test('the values of a free number show 99% only over 100 values, and never a length below the true one', () => {
  const { template } = inputs.subject;
  const { key, rule } = fieldsOf(template).find(({ param, rule }) => rule.kind === 'free' && param?.type.kind === 'uint') ?? assert.fail('a free number');
  const field = shapesOf(template).whole.loosened.rules.findIndex((leaf) => leaf === rule);
  const page = (count: number, seconds: (i: number) => bigint) => {
    const studies = Array.from({ length: count }, (_, i) => misfitAt(i + 1, { kind: 'other' }, { time: 1_000n, free: [{ field, type: { kind: 'uint', bits: 256 }, value: `${1_000n + seconds(i)}` }] }));
    const run = { ...inputs, pastTxs: inputs.pastTxs.slice(0, 1).map((r) => ({ ...r, run: { ...r.run, studies } })) };
    const block = past(buildPage(run, { ...notesFor(run), times: [key] }, title, 'en'));
    return block.numbers.find((n) => n.name === key.split('.').at(-1))?.table ?? assert.fail('a table');
  };
  const heads = (count: number) => page(count, (i) => BigInt(i)).head.map((h) => h.label);
  assert.ok(!heads(99).includes('99% at or under'));
  assert.ok(heads(100).includes('99% at or under'));
  const row = page(1, () => 5_436n).rows.find((r) => plain(r[0]) === 'Safe, differs elsewhere') ?? assert.fail('a row');
  assert.deepEqual(row.slice(1).map(plain), ['1', '1.5 hours', '1 hour 31 minutes', '1 hour 31 minutes'], '5,436 seconds are 1 hour 30 minutes 36 seconds');
});

test('a difference in a number shows it as a number, the largest uint256 by name, and bytes by their length', () => {
  const max = `${2n ** 256n - 1n}`;
  const { differ } = studiedPage([
    misfitAt(1, { kind: 'field', at: 'call.approve.value', expected: max, actual: '1234567' }),
    misfitAt(2, { kind: 'field', at: 'call.approve.value', expected: '1', actual: `${2n ** 255n}` }),
    misfitAt(3, { kind: 'field', at: 'call.approve.data', expected: '0x', actual: `0x${'ab'.repeat(128)}` }),
  ]);
  assert.deepEqual(differ.folded?.table.rows.map((r) => plain(r[0])).sort(), [
    `approve.data was 0x${'ab'.repeat(8)}…(128 bytes), the template wants 0x`,
    'approve.value was 1,234,567, the template wants uint256 max (2^256 - 1)',
    `approve.value was ${(2n ** 255n).toLocaleString('en-US')}, the template wants 1`,
  ]);
});

test('every difference folds under one line that counts its kinds, the commonest first', () => {
  const { differ } = studiedPage(Array.from({ length: 10 }, (_, i) => Array.from({ length: 11 - i }, (_, n) => misfitAt(i * 100 + n, { kind: 'field', at: `call.f.a${i}`, expected: '1', actual: '2' }))).flat());
  assert.equal(differ.folded?.label, 'Show the 10 kinds of difference');
  assert.deepEqual(differ.folded?.table.rows.map((r) => plain(r[1])), ['11', '10', '9', '8', '7', '6', '5', '4', '3', '2']);
});

test('a difference names its newest transaction and links the newest three, and names none as the newest when a block was not kept', () => {
  const reason = { kind: 'field', at: 'call.f.a', expected: '1', actual: '2' } as const;
  const row = (studies: readonly Misfit[]) => studiedPage(studies).differ.folded?.table.rows[0] ?? assert.fail('a row');
  const links = (spans: Inline | undefined) => (spans ?? []).flatMap((s) => (typeof s !== 'string' && 'href' in s ? [s.href] : []));
  const tx = (n: number) => `https://etherscan.io/tx/${hashOf(n)}`;
  const dated = row([misfitAt(2, reason), misfitAt(9, reason, { time: 1_700_000_000n }), misfitAt(1, reason), misfitAt(5, reason)]);
  assert.equal(plain(dated[3]), '2023-11-14');
  assert.deepEqual(links(dated[4]), [tx(9), tx(5), tx(2)]);
  const undated = row([misfitAt(2, reason, { block: undefined }), misfitAt(9, reason)]);
  assert.equal(plain(undated[3]), 'not recorded');
  assert.deepEqual(links(undated[4]), [tx(2), tx(9)]);
});

test('the amounts table has a receiver column only when the receiver was measured, and folds the tokens outside the registry', () => {
  const usdc = registry.entries.get('usdc')?.address ?? assert.fail('usdc');
  const outside = '0x7777777777777777777777777777777777777777' as Address;
  const file = `${SUMMARIES_DIR}/erc20-transfer-usdc.json`;
  const run = runOf(parseSummary(file, readFileSync(join(ROOT, file), 'utf8')), loadTemplate(ROOT, 'erc20/transfer', registry));
  const [first, second] = run.studies.filter((s) => s.kind === 'fit');
  assert.ok(first !== undefined && second !== undefined);
  const measured = (token: Address, receiver: boolean): Measurement => ({
    kind: 'measured',
    differences: [{ effect: 0, party: 'sender', token, by: -1n }, ...(receiver ? [{ effect: 0, party: 'receiver' as const, token, by: -1n }] : [])],
  });
  const amounts = (receiver: boolean) => {
    const measurements = new Map([[first.hash, measured(usdc, receiver)], [second.hash, measured(outside, receiver)]]);
    const recorded = inputs.pastTxs[0] ?? assert.fail('a recording');
    return past(buildPage({ ...inputs, pastTxs: [{ ...recorded, run: { ...run, studies: [first, second], measurements, traces: [] } }] }, notesFor(inputs), title, 'en')).amounts[0] ?? assert.fail('amounts');
  };
  assert.equal(amounts(true).tokens[0]?.table.head.length, 3);
  assert.equal(amounts(false).tokens[0]?.table.head.length, 2);
  assert.match(amounts(true).tokens[0]?.lead ?? '', /^usdc/);
  assert.equal(amounts(true).tokens.length, 1);
  assert.deepEqual(amounts(true).outside?.tokens.map((t) => t.lead.includes(checksumAddress(outside))), [true]);
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
  { what: 'a test transaction now refused', change: (of) => ({ ...of, fixtures: [{ name: 'morpho-market-supply', sender: 'safe', outcome: { kind: 'card-refused', why: 'wrong-kind' } }] }) },
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
    assert.deepEqual(new Set(addressRows(page).open.map((r) => r.anchor)), reviewed);
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
  assert.deepEqual(page.sections.map((s) => s.anchor), ['review', 'flow', 'wallet', 'past', 'next', 'usage']);
  assert.deepEqual(page.header.strip.map((s) => [s.line, s.state, s.count]), [['params', 'na', '沒有測試'], ['providers', 'ok', undefined]]);
  assert.match(page.header.strip[0]?.explain ?? '', /^模板沒有不限的參數/);
  const { flow } = body(page, 'flow');
  assert.deepEqual(flow.calls.map((c) => c.head), [{ kind: 'no-data', text: '轉 ETH 給收款人' }]);
  assert.deepEqual(flow.calls[0]?.args.map((a) => [a.name, a.chips.map((c) => c.label), plain(a.words), a.ai]), [
    ['to', ['你選：收款人'], '你選的收款人', undefined],
    ['value', ['你填：金額'], '你填的金額', undefined],
    ['data', ['固定'], '沒有資料', undefined],
  ]);
  assert.deepEqual(flow.key.map((g) => [g.title, g.items.map((k) => k.label)]), [['你', ['你填', '你選']], ['kiss-sign', ['固定']]]);
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
  const proof = freeItems(templatePage('cctp/receive'));
  assert.deepEqual(proof.map((k) => k.means), ['換成別的值，交易就失敗。']);
  const supply = freeItems(pageOf(inputs));
  assert.ok(supply.some((k) => k.means === '換成別的值，結果一樣或交易失敗。'), JSON.stringify(supply));
});

test("an EOA's test transaction is named as one in its row and in the parameter checks line", () => {
  const of = { ...inputs, fixtures: [{ name: 'morpho-market-supply-eoa', sender: 'eoa', outcome: { kind: 'card-refused', why: 'wrong-kind' } }] } satisfies HtmlInputs;
  const page = pageOf(of);
  assert.ok(body(page, 'review').rows.some((r) => r.title.endsWith('· morpho-market-supply-eoa（EOA 的交易）')), JSON.stringify(body(page, 'review').rows.map((r) => r.title)));
  const params = page.header.strip.find((item) => item.line === 'params')?.explain ?? '';
  assert.match(params, /其中 1 筆是 EOA 送的，不是 Safe：它們測得到模板的呼叫，測不到只有 Safe 才有的設定、nonce、delegatecall，以及 Safe 交易自己的欄位（gas 和退款欄位都填 0）。$/);
  assert.doesNotMatch(pageOf(inputs).header.strip.find((item) => item.line === 'params')?.explain ?? '', /EOA/, 'a Safe-only test set says nothing of EOAs');
});

test('a free number says a test tried other values only when one did', () => {
  const words = (of: HtmlInputs) => args(pageOf(of)).flatMap((row) => (row.chips.some((c) => c.who === 'free') ? [plain(row.qualifier)] : []));
  assert.ok(words(inputs).includes(`${WORDS['zh-TW'].freeCaught.scalar}換成別的值測過，結果不變或交易失敗`), JSON.stringify(words(inputs)));
  const untested = { ...inputs, fixtures: [] };
  assert.ok(words(untested).some((text) => text.endsWith('測試看到的：沒有測試換過別的值')), JSON.stringify(words(untested)));
  assert.ok(!words(untested).some((text) => text.includes('測過')));
  assert.ok(freeItems(pageOf(untested)).some((k) => k.means === '模板允許任何值，沒有測試換過別的值。'));
  const failed = inputs.fixtures.map(({ name, sender, outcome }) =>
    outcome.kind === 'card-refused' || outcome.perturbation.kind === 'not-run'
      ? { name, sender, outcome }
      : { name, sender, outcome: { ...outcome, perturbation: { ...outcome.perturbation, runs: outcome.perturbation.runs.map((run) => ({ ...run, outcome: 'reverted' as const })) } } },
  );
  assert.ok(words({ ...inputs, fixtures: failed }).some((text) => text.endsWith('測試看到的：換成別的值測過，每次交易都失敗或不符合卡片')));
  assert.ok(freeItems(pageOf({ ...inputs, fixtures: failed })).some((k) => k.means === '換成別的值測過，每次交易都失敗或不符合卡片。'), 'the legend says so too');
});

test('a money call no line covers is titled by who pays whom, with full addresses', () => {
  const at = (name: string): Address => (registry.entries.get(name) ?? assert.fail(name)).address;
  const [safe, usdc, bundles, morpho] = ['0x1111111111111111111111111111111111111111' as Address, at('usdc'), at('blue-bundles-v1'), at('morpho-blue')];
  const supply = inputs.subject.template.calls[1]?.data;
  const call = (depth: number, from: Address, to: Address, selector: string, callArgs?: Address[]): TraceCall => ({ depth, type: 'CALL', from, to, selector: selector as Hex, ...(callArgs === undefined ? {} : { args: callArgs }) });
  const calls = [
    call(0, usdc, safe, '0x6a761202'),
    call(1, safe, usdc, '0x095ea7b3', [bundles]),
    call(1, safe, bundles, supply === undefined || supply === 'empty' ? assert.fail('a supply call') : supply.fn.selector),
    call(2, bundles, morpho, '0xa99aad89'),
    call(3, morpho, usdc, '0x23b872dd', [safe, morpho]),
  ];
  const pastTxs = inputs.pastTxs.map((r) => ({ ...r, run: { ...r.run, traces: [{ kind: 'traced' as const, hash: `0x${'ab'.repeat(32)}` as Hex, sender: { kind: 'safe' as const, address: safe }, calls }] } }));
  const traced = { ...inputs, pastTxs };
  const raw = notesFor(traced);
  const id = 'trace.2.morpho-blue.usdc.transferFrom';
  const page = buildPage(traced, { ...raw, flow: [], reviews: { ...(raw.reviews as object), [id]: { status: 'confirmed', text: both('checked'), recommendation: both('none') } } }, title, 'zh-TW');
  const row = body(page, 'review').rows.find((r) => r.id === id) ?? assert.fail('the trace row');
  assert.equal(row.title, `1 筆過去交易裡，送出方付了 usdc 給 morpho-blue ${checksumAddress(morpho)}，模板沒有說明這一步`);
  const english = body(buildPage(traced, { ...raw, flow: [], reviews: { ...(raw.reviews as object), [id]: { status: 'confirmed', text: both('checked'), recommendation: both('none') } } }, title, 'en'), 'review').rows.find((r) => r.id === id);
  assert.equal(english?.title, `In 1 past transaction, the sender paid usdc to morpho-blue ${checksumAddress(morpho)}; the template does not describe this step`);
  const unread = [...calls.slice(0, -1), call(3, safe, usdc, '0xa9059cbb')];
  const untold = { ...traced, pastTxs: pastTxs.map((r) => ({ ...r, run: { ...r.run, traces: r.run.traces.map((t) => (t.kind === 'traced' ? { ...t, calls: unread } : t)) } })) };
  const untoldId = 'trace.2.safe.usdc.transfer';
  const untoldRow = body(buildPage(untold, { ...notesFor(untold), flow: [], reviews: { ...(notesFor(untold).reviews as object), [untoldId]: { status: 'confirmed', text: both('checked'), recommendation: both('none') } } }, title, 'en'), 'review').rows.find((r) => r.id === untoldId);
  assert.equal(untoldRow?.title, "In 1 past transaction, a step under call 2 moved the sender's usdc, to whom was not read; the template does not describe this step");
});

test('a group of money calls that go both ways says what the sender paid, what it was paid, and what was not read', () => {
  const at = (name: string): Address => (registry.entries.get(name) ?? assert.fail(name)).address;
  const [safe, usdc, bundles, morpho, other] = ['0x1111111111111111111111111111111111111111' as Address, at('usdc'), at('blue-bundles-v1'), at('morpho-blue'), '0x2222222222222222222222222222222222222222' as Address];
  const supply = inputs.subject.template.calls[1]?.data;
  const call = (depth: number, from: Address, to: Address, selector: string, callArgs?: Address[]): TraceCall => ({ depth, type: 'CALL', from, to, selector: selector as Hex, ...(callArgs === undefined ? {} : { args: callArgs }) });
  const base = [call(0, usdc, safe, '0x6a761202'), call(1, safe, usdc, '0x095ea7b3', [bundles]), call(1, safe, bundles, supply === undefined || supply === 'empty' ? assert.fail('a supply call') : supply.fn.selector)];
  const titles = (id: string, language: 'en' | 'zh-TW', ...traces: readonly (readonly TraceCall[])[]) => {
    const run = traces.map((inner, i) => ({ kind: 'traced' as const, hash: `0x${String(i + 1).repeat(64)}` as Hex, sender: { kind: 'safe' as const, address: safe }, calls: [...base, call(2, bundles, morpho, '0xa99aad89'), ...inner] }));
    const of = { ...inputs, pastTxs: inputs.pastTxs.slice(0, 1).map((r) => ({ ...r, run: { ...r.run, traces: run } })) };
    const raw = notesFor(of);
    const page = buildPage(of, { ...raw, flow: [], reviews: { ...(raw.reviews as object), [id]: { status: 'confirmed', text: both('checked'), recommendation: both('none') } } }, title, language);
    return body(page, 'review').rows.find((r) => r.id === id)?.title;
  };
  const pulls = 'trace.2.morpho-blue.usdc.transferFrom';
  const out = call(3, morpho, usdc, '0x23b872dd', [safe, morpho]);
  const back = call(3, morpho, usdc, '0x23b872dd', [other, safe]);
  const [M, O] = [`morpho-blue ${checksumAddress(morpho)}`, checksumAddress(other)];
  assert.equal(titles(pulls, 'en', [out, back]), `In 1 past transaction, the sender paid usdc to ${M}; ${O} paid usdc to the sender; the template does not describe this step`);
  assert.equal(titles(pulls, 'zh-TW', [back], [out]), `2 筆過去交易裡，其中 1 筆裡，送出方付了 usdc 給 ${M}；其中 1 筆裡，${O} 付了 usdc 給送出方，模板沒有說明這一步`);
  const sends = 'trace.2.safe.usdc.transfer';
  const [told, untold] = [call(3, safe, usdc, '0xa9059cbb', [other]), call(3, safe, usdc, '0xa9059cbb')];
  assert.equal(titles(sends, 'en', [told], [untold]), `In 2 past transactions, in 1 of them the sender paid usdc to ${O}; in 1 of them a step under call 2 moved the sender's usdc, to whom was not read; the template does not describe this step`);
  assert.equal(titles('trace.2.safe.usdc.approve', 'en', [call(3, safe, usdc, '0x095ea7b3')]), "In 1 past transaction, a step under call 2 let a spender that was not read spend the sender's usdc; the template does not describe this step");
  assert.equal(titles('trace.2.safe.usdc.approve', 'zh-TW', [call(3, safe, usdc, '0x095ea7b3')]), '1 筆過去交易裡，呼叫 2 底下有一步授權別人動用送出方的 usdc，授權給誰沒有讀到，模板沒有說明這一步');
  assert.equal(titles('trace.2.safe.usdc.transferFrom', 'en', [call(3, safe, usdc, '0x23b872dd')]), 'In 1 past transaction, a transferFrom the sender made under call 2 moved usdc, from whom to whom was not read; the template does not describe this step');
});

test("an argument the program reads from the Safe's owners is tagged as read on chain, not fixed, on its row and in the key, in both languages", async () => {
  const repo = join(import.meta.dirname, '..');
  const shipped = loadRegistry(repo);
  const target = { template: 'safe/remove-owner' };
  const replayed = await replayInputs(repo, shipped, target, await warmCompilers(reportCases(repo, shipped, [target])), loadPublicSuffixList());
  for (const [language, label, means] of [
    ['en', 'program reads', "verify reads it on chain from the Safe's getOwners() at each check. Any other value is a MISMATCH."],
    ['zh-TW', '程式讀鏈上', 'verify 每次檢查時在鏈上讀 Safe 的 getOwners() 算出。換成別的值就 MISMATCH。'],
  ] as const) {
    const page = buildPage(replayed.inputs, readNotes(repo, target.template, undefined), replayed.title, language);
    const prevOwner = everyRow(args(page)).find((row) => row.name === 'prevOwner') ?? assert.fail('the prevOwner row');
    assert.deepEqual(prevOwner.chips.map((c) => c.label), [label]);
    assert.equal(prevOwner.fixed, false, 'shown, not folded away with the fixed rows');
    const key = body(page, 'flow').flow.key.flatMap((g) => g.items);
    assert.deepEqual(key.filter((k) => k.label === label).map((k) => k.means), [means]);
  }
});

test("a swap's page draws a line on the token the card names, says with which tokens it was seen, and leaves a token with no trace unconfirmed", async () => {
  const repo = join(import.meta.dirname, '..');
  const shipped = loadRegistry(repo);
  const target = { template: 'uniswap/swap' };
  const replayed = await replayInputs(repo, shipped, target, await warmCompilers(reportCases(repo, shipped, [target])), loadPublicSuffixList());
  const swap = { ...replayed.inputs, fixtures: [] };
  const line = { after: 1, from: 'permit2', to: 'card.sell-token', function: 'transferFrom(address,address,uint256)', text: both('pull'), sources: ['https://example.org/Permit2.sol'] };
  const dependsOn = new Map([...shipped.entries].map(([name, entry]) => [name, name === 'universal-router-2.1.2' ? { ...entry, dependsOn: [...new Set([...(entry.dependsOn ?? []), 'permit2'])] } : entry] as const));
  const of = () => ({ ...swap, registry: { ...swap.registry, entries: dependsOn }, pastTxs: swap.pastTxs.map((r) => ({ ...r, run: { ...r.run, traces: r.run.traces.filter((t) => sells(t.hash) === sold) } })) });
  const shapes = shapesOf(swap.subject.template);
  const sells = (hash: Hex): string | undefined => {
    const fit = swap.pastTxs.flatMap(({ run }) => run.studies).find((s) => s.kind === 'fit' && s.hash === hash);
    const token = fit?.kind === 'fit' ? cardAddresses(fit, shapes).get('sell-token') : undefined;
    return token === undefined ? undefined : shipped.byAddress.get(token)?.name;
  };
  const [first] = swap.pastTxs.flatMap(({ run }) => run.traces).filter((t) => t.kind === 'traced');
  const sold = sells(first?.hash ?? assert.fail('the recordings hold a trace')) ?? assert.fail('a sold token');
  for (const [language, seenWith, none] of [['en', new RegExp(`seen only with ${sold}\\)`), /no transaction with /], ['zh-TW', new RegExp(`只看過 ${sold}`), /沒有交易用過/]] as const) {
    const raw = notesFor(of());
    const reviews = { ...(raw.reviews as Record<string, unknown>) };
    const build = (): Page => {
      try {
        return buildPage(of(), { ...raw, flow: [line], reviews }, title, language);
      } catch (error) {
        const id = /reviews: (trace\S+) is missing/.exec((error as Error).message)?.[1] ?? assert.fail((error as Error).message);
        reviews[id] = { status: 'confirmed', text: both('checked'), recommendation: both('none') };
        return build();
      }
    };
    const page = build();
    assert.ok(!Object.keys(reviews).some((id) => id.startsWith('trace.1.permit2.')), 'the line explains the pull');
    const { diagram } = body(page, 'flow').flow;
    const arrow = diagram.arrows.find((a) => a.kind === 'inside') ?? assert.fail('the line');
    assert.ok(arrow.kind === 'inside' && arrow.seen?.state === 'some-tokens' && arrow.seen.seen === arrow.seen.of);
    assert.deepEqual(arrow.seen.tokens, [sold]);
    assert.match(diagram.lifelines[arrow.to]?.name ?? '', /sell-token/);
    const html = renderPage(page);
    assert.match(html, seenWith);
    assert.match(html, none);
  }
});

/**
 * The deposit report with a floor in place of its computed field, between the vault's asset and the vault, USD feeds
 * on both when `feeds`, and with `pool` a pool of the two whose mean price is a second source.
 */
function floored(feeds: boolean, pool?: string): { readonly of: HtmlInputs; readonly name: string; readonly sells: string } {
  const subject = depositInputs.subject.kind === 'template' ? depositInputs.subject : assert.fail('a template report');
  const { template } = subject;
  const [name, field] = [...template.card].find(([, f]) => f.kind === 'amount' && f.computed !== undefined) ?? assert.fail('a computed field');
  const [sells] = [...template.card].find(([, f]) => f.kind === 'amount' && f.computed === undefined) ?? assert.fail('a typed field');
  const card = new Map([[name, { ...field, computed: undefined, floor: { sells } } as typeof field], ['late', field], ...[...template.card].filter(([n]) => n !== name)]);
  const vault = subject.vault ?? assert.fail('a per-vault report');
  const asset = vault.attributes.asset ?? assert.fail('a vault asset');
  const read = (file: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'swap-floor', 'registry', file), 'utf8');
  const fixture = registryFromTexts(read('contracts.json'), undefined, read('attributes.json'));
  const priced = new Map([
    [asset, { feed: 'usdc-usd', peg: 'usd' }],
    [vault.name, { feed: 'usdt-usd', peg: 'usd' }],
  ]);
  const entries = new Map([...depositInputs.registry.entries].map(([key, entry]) => [key, feeds && priced.has(key) ? { ...entry, price: priced.get(key) } : entry] as const));
  if (feeds) for (const feed of ['usdc-usd', 'usdt-usd']) entries.set(feed, fixture.entries.get(feed) ?? assert.fail(feed));
  const twap = fixture.entries.get('v3-usdc-usdt-100') ?? assert.fail('a pool');
  if (pool !== undefined) entries.set(pool, { ...twap, name: pool, attributes: { token0: asset, token1: vault.name } });
  const registry = { ...depositInputs.registry, entries: entries as typeof depositInputs.registry.entries };
  return { of: { ...depositInputs, registry, subject: { ...subject, template: { ...template, card } }, fixtures: [] }, name, sells };
}

test('the who-decides key says a computed value is read from the chain, and a floor computed from prices only when this report has them', () => {
  const means = (of: HtmlInputs, language: 'en' | 'zh-TW') =>
    body(buildPage(of, { ...notesFor(of), flow: [] }, depositTitle, language), 'flow').flow.key.flatMap((g) => g.items).filter((k) => k.who === 'computed').map((k) => k.means);
  assert.deepEqual(means({ ...depositInputs, fixtures: [] }, 'en'), ['card new reads it from the chain at each signing. You check it.']);
  const floor = WORDS.en.whoMeans.floor;
  assert.ok(means(floored(true).of, 'en').includes(floor));
  assert.ok(means(floored(true).of, 'zh-TW').includes('card new 每次簽名用價格來源和池子算，你核對；沒有獨立價格可用時，你自己填。'));
  assert.ok(!means(floored(false).of, 'en').includes(floor), 'with no feed for any pair, the key does not say the program computes it');
});

test('a displayed limit is never above the real one, and a longest value never below it', () => {
  const years = 2n * 365n * 86400n;
  for (const [seconds, en, zh] of [[5436n, '1 hour 30 minutes 36 seconds', '1 小時 30 分鐘 36 秒'], [years + 1n, '2 years 1 second', '2 年 1 秒'], [5400n, '1.5 hours', '1.5 小時'], [604800n, '7 days', '7 天']] as const) {
    assert.equal(WORDS.en.within(seconds), `at most ${en} after the block's time`);
    assert.equal(WORDS['zh-TW'].within(seconds), `最多比區塊時間晚 ${zh}`);
    assert.equal(WORDS.en.pastLimit(seconds)[1], en);
  }
  assert.equal(WORDS.en.duration(5436n, 'up'), '1 hour 31 minutes');
  assert.equal(WORDS.en.duration(5436n, 'down'), '1.5 hours');
  assert.equal(WORDS.en.duration(years + 1n, 'up'), '2 years 1 day');
  assert.equal(WORDS.en.duration(years + 1n, 'down'), '2 years');
  assert.equal(WORDS.en.duration(86399n, 'up'), '1 day');
  assert.equal(WORDS.en.duration(0n, 'up'), '0 seconds');
  assert.equal(WORDS.en.duration(-95n, 'up'), '1 minute 35 seconds before');
});

test('a floor is said to be computed from the feeds this report names, after the amount it is for and before any other computed field, and typed with nothing to compare when no pair has feeds', () => {
  for (const [language, said, pair, how, typed, none] of [
    ['zh-TW', /獨立價格，替 (\S+) 算最少要收到多少/, /usdc 換 \S+：即時檢查都通過時程式算，價格來源是 usdc-usd、usdt-usd；只有一個價格來源：/, /按 Enter 是 0\.50%，最多 1\.00%.*0\.25% 餘裕.*這個餘裕是程式定的/, /：填 \S+ 最少要收到多少，用整顆幣。/, /沒有任何一組兩邊都有價格來源，所以程式不算/],
    ['en', /computes the least to receive for (\S+) from an independent price/, /usdc for \S+: computed when the live checks pass, from the price feeds usdc-usd, usdt-usd; one price source only: /, /Enter is 0\.50%, at most 1\.00%.*a 0\.25% margin.*The margin is the program's/, /: type the least to receive for \S+, in whole tokens\./, /no pair of tokens the card can name has a price feed for both, so the program computes nothing/],
  ] as const) {
    const { of, name } = floored(true);
    const page = buildPage(of, { ...notesFor(of), flow: [] }, depositTitle, language);
    const { steps } = body(page, 'next');
    const says = steps.map((s) => plain(s.say));
    const at = says.findIndex((say) => said.test(say));
    assert.ok(at > says.findIndex((say) => /1250\.5/.test(say)), 'after the amount typed');
    assert.ok(at < says.findIndex((say) => /所以程式自己算|so the program computes it/.test(say)), 'before the computed field');
    assert.equal(steps[at]?.id, `next-${name}`, 'the step is the one place a row links to');
    const then = (steps[at]?.then ?? []).map(plain).join(' ');
    assert.match(then, pair);
    assert.match(then, how);
    assert.ok(then.includes(WORDS[language].floorLive), 'a computed floor holds only while the live checks pass; else the signer types it');
    const linked = everyRow(args(page)).filter((row) => (row.qualifier ?? []).some((span) => typeof span === 'object' && span !== null && 'href' in span && span.href === `next-${name}`));
    assert.ok(linked.length > 0, 'a row that checks the floor links to the step that says how it is filled');

    const bare = floored(false);
    const plainPage = buildPage(bare.of, { ...notesFor(bare.of), flow: [] }, depositTitle, language);
    const step = body(plainPage, 'next').steps.find((s) => s.id === `next-${bare.name}`) ?? assert.fail('the floor step');
    assert.match(plain(step.say), typed);
    assert.match(step.then.map(plain).join(' '), none);
    assert.ok(!everyRow(args(plainPage)).some((row) => row.chips.some((c) => c.who === 'computed')), 'no chip says the program computes it');
  }
});

test("a floor's second-source pool shows the minimum liquidity the AI chose, with the notes' reason or that none gives it, and notes-needed asks for it", () => {
  const pool = 'twap-pool';
  const { of, name } = floored(true, pool);
  const why = { en: 'At the lowest calm and stressed 30-minute measure.', 'zh-TW': '取平穩與壓力區塊 30 分鐘量測的最低值。' };
  const notes = notesFor(of);
  const described = { ...notes, flow: [], entries: { ...(notes.entries as object), [pool]: { minLiquidity: why } } };
  const said = {
    en: [`The AI chose the minimum liquidity 20000000000000 of the pool ${pool}, not the protocol or its app. Why: ${why.en}`, `The AI chose the minimum liquidity 20000000000000 of the pool ${pool}, not the protocol or its app; no note gives its reason.`],
    'zh-TW': [`池子 ${pool} 的最低流動性 20000000000000：由 AI 選定，不是協議或它的 app 定的。理由：${why['zh-TW']}`, `池子 ${pool} 的最低流動性 20000000000000：由 AI 選定，不是協議或它的 app 定的；說明裡沒有寫理由。`],
  } as const;
  for (const language of ['en', 'zh-TW'] as const) {
    const ai = (page: Page) => (body(page, 'next').steps.find((s) => s.id === `next-${name}`) ?? assert.fail('the floor step')).ai?.map((a) => [a.ai, a.tag]);
    const page = buildPage(of, described, depositTitle, language);
    assert.deepEqual(ai(page), [[said[language][0], 'ai']]);
    assert.ok(renderPage(page).includes(said[language][0]), 'the page shows it');
    assert.deepEqual(ai(buildPage(of, { ...notes, flow: [] }, depositTitle, language)), [[said[language][1], 'ai']], 'a pool whose reason the notes lack says so');
  }

  const { template, vault } = of.subject;
  const shared = notesPath('', template.id);
  const repo = tempDir('kiss-sign-floor-notes-');
  const write = (file: string, json: unknown) => {
    mkdirSync(join(repo, dirname(file)), { recursive: true });
    writeFileSync(join(repo, file), JSON.stringify(json));
  };
  const mine = vault === undefined ? undefined : notesPath('', template.id, vault.name);
  const files = [shared, ...(mine === undefined ? [] : [mine])].map((file) => [file, JSON.parse(readFileSync(join(FROZEN, file), 'utf8'))] as const);
  for (const [file, json] of files) write(file, json);
  const asked = notesNeeded(repo, of, ['zh-TW']);
  assert.deepEqual((asked.skeleton[shared] as { entries?: Record<string, unknown> }).entries?.[pool], { minLiquidity: { en: '', 'zh-TW': '' } });
  assert.match(asked.about[`entries ${pool} minLiquidity`] ?? '', /twap\.minLiquidity 20000000000000.*pnpm pool-depth twap-pool --auto.*\[en 600, zh-TW 200\]/);
  const [, notesJson] = files[0] ?? assert.fail('the template notes');
  write(shared, { ...notesJson, entries: { ...notesJson.entries, [pool]: { minLiquidity: why } } });
  assert.equal((notesNeeded(repo, of, ['zh-TW']).skeleton[shared] as { entries?: Record<string, unknown> } | undefined)?.entries?.[pool], undefined, 'asked no more once written');
});

test('a computed field the transaction does not carry is never said to be typed or filled by the app', () => {
  const { template } = depositInputs.subject;
  const field = [...template.card].find(([, f]) => f.kind === 'amount' && f.computed !== undefined)?.[0] ?? assert.fail('a computed field');
  const step = (of: HtmlInputs) => body(buildPage(of, { ...notesFor(of), flow: [] }, depositTitle, 'zh-TW'), 'next').steps.map((s) => plain(s.say)).find((say) => say.includes('所以程式自己算')) ?? assert.fail('the computed step');
  assert.match(step({ ...depositInputs, fixtures: [] }), /協議的 app 自己會填這個值/);
  const without = (rule: Rule): Rule => {
    if (rule.kind === 'share-price') return { kind: 'free', reason: both('any'), claim: 'unread' };
    if (rule.kind === 'call') return { ...rule, call: { ...rule.call, args: rule.call.args.map(without) } };
    if (rule.kind === 'items') return { ...rule, items: rule.items.map(without) };
    if (rule.kind === 'fields') return { ...rule, fields: rule.fields.map(without) };
    return rule;
  };
  const calls = template.calls.map((c) => (c.data === 'empty' ? c : { ...c, data: { ...c.data, args: c.data.args.map(without) } }));
  const gets = template.effects.gives.slice(0, 1).map((e) => ({ ...e, to: undefined, amount: { kind: 'at-least' as const, field } }));
  const of: HtmlInputs = { ...depositInputs, subject: { ...depositInputs.subject, template: { ...template, calls, effects: { ...template.effects, gets } } }, fixtures: [] };
  assert.match(step(of), /交易裡沒有這個值/);
  const after = body(buildPage(of, { ...notesFor(of), flow: [] }, depositTitle, 'zh-TW'), 'flow').flow.after.map((r) => plain(r.note));
  assert.ok(after.includes('收到的不能少於程式算的最少收到的數量；這份報告裡 card new 怎麼填'), JSON.stringify(after));
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
  const addresses = addressRows(page);
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
  const addresses = addressRows(pageOf(of));
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
  const addresses = addressRows(page);
  const row = [...addresses.open, ...addresses.folded].find((r) => r.name === vault.name) ?? assert.fail('no address row');
  const factory = `https://etherscan.io/address/${of.registry.entries.get('vault-v2-factory')?.address ?? assert.fail('no factory')}`;
  assert.deepEqual(row.sources.find((line) => line.label === '工廠'), { label: '工廠', href: factory, state: 'ok', phrase: undefined, why: undefined, others: [], site: undefined, newest: undefined });
  assert.ok(renderPage(page).includes('computeToken(usdc,&#34;fToken&#34;)'), 'the HTML report escapes the quoted constant');
});

test("a vault its factory computed another address for renders in both reports, its 工廠 line red", () => {
  const vault = (depositInputs.subject.kind === 'template' ? depositInputs.subject.vault : undefined) ?? assert.fail('a per-vault report');
  const first = `REFUSED vault-v2-factory answered computeToken(usdc,"fToken") = 0x5C20B550819128074FD538Edf79791733ccEdd18, not ${vault.name}: its official contract is another; the vault's code is not read`;
  const { of, notes } = withComputingFactory(first);
  assert.ok(renderReport(of, depositTitle).includes(`\`\`\`text\n${first}\n`), 'the Markdown report prints the stored line');
  const page = buildPage(of, notes, depositTitle, 'zh-TW');
  const addresses = addressRows(page);
  const row = addresses.open.find((r) => r.name === vault.name) ?? assert.fail('the vault row is not open');
  const line = row.sources.find((l) => l.label === '工廠') ?? assert.fail('no 工廠 line');
  assert.deepEqual([line.state, line.phrase, plain(line.why)], ['bad', 'not-created', '登記的工廠合約回答，這個地址不是它建立的，所以它不屬於工廠的協議。見「待確認」。']);
  assert.match(line.href ?? '', /^https:\/\/etherscan\.io\/address\/0x[0-9a-f]{40}$/, "the factory's page");
  const review = body(page, 'review').rows.find((r) => r.id === `${vault.name}/factory.admitted`) ?? assert.fail('no review row');
  assert.equal(review.state, 'bad');
  assert.equal(plain(body(page, 'vault').vault.rows.find((r) => r.label === '工廠')?.value ?? []), `沒有記錄到 vault-v2-factory 回答它建立了這個合約`);
});

test('an address held as a 32-byte word reads as its address rule, left-padded, in both languages, and a fixed one prints the padded word', () => {
  const subject = inputs.subject.kind === 'template' ? inputs.subject : assert.fail('a template report');
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'cctp', 'deposit-for-burn', 'template.json'), 'utf8'));
  const pageOfBurn = (language: 'en' | 'zh-TW', mintRecipient?: unknown): ArgRow => {
    if (mintRecipient !== undefined) raw.calls[1].args.mintRecipient = mintRecipient;
    const burn = parseTemplate(raw, registry, 'committed');
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
    return { row: rows.find((r) => r.chips.some((c) => c.who === 'bounded')) ?? assert.fail('a bounded row'), key: body(page, 'flow').flow.key.flatMap((g) => g.items) };
  };
  const zh = rowOf('zh-TW');
  assert.equal(plain(zh.row.words), '最多比區塊時間晚 7 天');
  assert.equal(zh.row.qualifier, undefined);
  assert.match(zh.row.more?.text ?? '', /^剛好 604800 秒。.*還沒執行的交易用 verify 讀到的最新區塊，已執行的用它所在的區塊；更晚就 MISMATCH。$/);
  assert.deepEqual(zh.row.chips.map((c) => c.label), ['有上限']);
  assert.ok(zh.key.some((k) => k.who === 'bounded' && k.means === '超過上限就 MISMATCH。'));
  const en = rowOf('en');
  assert.equal(plain(en.row.words), "at most 7 days after the block's time");
  assert.deepEqual(en.row.chips.map((c) => c.label), ['up to a limit']);
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
  const addresses = addressRows(page);
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

test("the signer's requests open the page as given, labelled as theirs, above the AI's title and summary, and a template that kept none shows none", () => {
  const said = 'I want to deposit USDC into the vault \u2764\ufe0f.\n<b>build me the template</b>';
  for (const [language, label] of [['en', 'Your request, as you wrote it, when this template was built'], ['zh-TW', '你的要求（建立這個模板時，原文）']] as const) {
    const page = buildPage(depositInputs, { ...(depositNotes as object), request: said, instanceRequest: 'add this vault' }, depositTitle, language);
    assert.deepEqual(page.header.requests, [
      { label, text: said },
      { label: WORDS[language].instanceRequest, text: 'add this vault' },
    ]);
    const html = renderPage(page);
    assert.ok(html.includes('I want to deposit USDC into the vault \u2764\ufe0f.\n&#60;b&#62;build me the template&#60;/b&#62;'), 'verbatim, escaped, line break and emoji kept');
    assert.ok(html.indexOf(label) < html.indexOf('<h1>'), 'above the title');
  }
  assert.deepEqual(buildPage(depositInputs, depositNotes, depositTitle, 'en').header.requests, []);
  const once = buildPage(depositInputs, { ...(depositNotes as object), request: 'build it', instanceRequest: 'build it' }, depositTitle, 'en');
  assert.deepEqual(once.header.requests.map((r) => r.text), ['build it'], 'one request that built both the template and this instance shows once');
});

test('a number the AI chose is said to be its choice with its reason, where the row uses it and in 下一步', () => {
  const subject = depositInputs.subject.kind === 'template' ? depositInputs.subject : assert.fail('a template report');
  const [name, field] = [...subject.template.card].find(([, f]) => f.kind === 'amount' && f.computed?.margin !== undefined) ?? assert.fail('a computed field with a margin');
  const margin = (field.kind === 'amount' ? field.computed?.margin : undefined) ?? assert.fail('a margin');
  for (const language of ['en', 'zh-TW'] as const) {
    const w = WORDS[language];
    const page = buildPage(depositInputs, depositNotes, depositTitle, language);
    const said = w.aiChose(w.marginChosen('0.07%'), margin.why[language] as string);
    const step = body(page, 'next').steps.find((s) => s.id === `next-${name}`) ?? assert.fail('the computed step');
    assert.deepEqual(step.ai?.map((a) => [a.ai, a.tag]), [[said, 'ai']], '下一步 says the AI chose the margin, and why');
    const rows = everyRow(args(page));
    assert.ok(rows.some((row) => row.reason?.ai === said), 'the row bound to the computed field says it too');
    const trailer = body(page, 'flow').flow.calls.find((call) => call.trailer !== undefined) ?? assert.fail('a call with a trailer');
    assert.match(trailer.trailer?.ai ?? '', language === 'en' ? /^The AI chose to let through at most 12 bytes after the arguments, not the protocol or its app\. Why: / : /^參數後面最多放行 12 bytes：由 AI 選定/);
  }
});

test('an effect bounded by a computed card amount links to the step that says how card new fills it, in both languages', () => {
  const subject = depositInputs.subject.kind === 'template' ? depositInputs.subject : assert.fail('a template report');
  const { template } = subject;
  const [name] = [...template.card].find(([, f]) => f.kind === 'amount' && f.computed !== undefined) ?? assert.fail('a computed field');
  const gets = template.effects.gets.map((e) => ({ ...e, amount: { kind: 'at-least' as const, field: name } }));
  const of = { ...depositInputs, subject: { ...subject, template: { ...template, effects: { ...template.effects, gets } } } };
  for (const language of ['en', 'zh-TW'] as const) {
    const page = buildPage(of, depositNotes, depositTitle, language);
    const step = body(page, 'next').steps.find((s) => s.id === `next-${name}`) ?? assert.fail('the computed step');
    const links = body(page, 'flow').flow.after.flatMap((row) => row.note.filter((span) => typeof span === 'object' && span !== null && 'href' in span));
    assert.deepEqual(links, [{ href: step.id, label: WORDS[language].howFilled }], 'only the row naming the computed amount links, to its step');
  }
});

test("a free value says the effects check bounds it only through the card's amount rules, apart from what the tests saw", () => {
  for (const [language, bound, gone] of [
    ['en', /^Only the effects check limits it, and only through the card's amount rules: .* What tests saw: \S/, /does not check it|allows any value/],
    ['zh-TW', /^只有效果檢查限制它，而且只透過卡片的數量規則：.*測試看到的：\S/, /模板不檢查它|模板允許任何值/],
  ] as const) {
    const free = everyRow(args(buildPage(inputs, notesFor(inputs), title, language))).filter((row) => row.chips.some((c) => c.who === 'free'));
    const said = free.map((row) => plain(row.qualifier));
    assert.ok(said.some((text) => bound.test(text)), said.join('\n'));
    assert.ok(!said.some((text) => gone.test(text)), 'the chip already says it is not checked here');
  }
});

test('a nested call carries the chip its arguments agree on, and a container counts what is inside its nested calls', () => {
  const rows = everyRow(args(depositPage));
  const nested = rows.filter((row) => row.doc !== undefined);
  assert.ok(nested.length > 0, 'the deposit report binds a nested call');
  for (const row of nested) {
    const inside = everyRow(row.parts.flatMap((g) => g.rows)).filter((r) => r.parts.length === 0);
    const whos = new Set(inside.flatMap((r) => r.chips.map((c) => `${c.who}/${c.label}`)));
    assert.equal(row.chips.length, whos.size === 1 ? 1 : 0, `${row.key}: one chip only when every argument agrees`);
  }
  const bundle = arg(depositPage, '2.multicall.bundle');
  const leaves = new Set(everyRow(bundle.parts.flatMap((g) => g.rows)).filter((r) => r.parts.length === 0).flatMap((r) => r.chips.map((c) => c.who)));
  assert.ok(leaves.size > 1, 'the bundle holds values decided differently');
  assert.deepEqual(bundle.chips, [], 'so the bundle carries no chip of its own');
});

test("a time limit's row says the AI chose it and that its note says why, the Safe transaction's nonce row included, whose note the notes must hold", () => {
  const subject = inputs.subject.kind === 'template' ? inputs.subject : assert.fail('a template report');
  const limited: HtmlInputs = { ...inputs, subject: { ...subject, template: { ...subject.template, nonce: { kind: 'within-seconds', seconds: 3600n } } }, fixtures: [] };
  const notes = notesFor(limited);
  for (const language of ['en', 'zh-TW'] as const) {
    const w = WORDS[language];
    const [nonce] = body(buildPage(limited, notes, title, language), 'flow').flow.safeTx;
    assert.equal(nonce?.name, 'nonce');
    assert.equal(nonce?.ai?.ai, 'field nonce', "the row shows the note that gives the limit's reason");
    assert.equal(nonce?.reason?.ai, w.aiChoseNoted(w.limitChosen(3600n), true));
  }
  const { nonce: _, ...others } = notes.fields as Record<string, unknown>;
  assert.throws(() => buildPage(limited, { ...notes, fields: others }, title, 'en'), /nonce/);
  assert.match(WORDS.en.aiChoseNoted(WORDS.en.limitChosen(3600n), false), /no note gives its reason\.$/);
});
