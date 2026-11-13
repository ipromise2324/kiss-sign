import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, test } from 'node:test';
import type { AbiRefusal } from '../src/contracts/prove.ts';
import { loadRegistry } from '../src/registry.ts';
import { forSigner, judge, stateOf, worst } from '../src/research/ledger.ts';
import type { EntryReport, FieldFact } from '../src/research/erc7730.ts';
import type { State } from '../src/research/ledger.ts';
import { NotesError, notesScope, readNotes } from '../src/research/notes.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { buildPage, constCast } from '../src/research/report-page.ts';
import type { ArgRow, Body, HtmlInputs, Inline, Page, WalletCall } from '../src/research/report-page.ts';
import { replayInputs } from '../src/research/report.ts';
import type { ReportTitle } from '../src/research/report.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { firstRecordedTx, judgeFixtures } from '../src/template/perturb.ts';
import type { Template } from '../src/template/template.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const target = { template: 'morpho/market-supply' };
let inputs: HtmlInputs;
let title: ReportTitle;
let template: Template;
const deposit = { template: 'morpho/vault-deposit', cardVault: 'hyperithm-usdc-apex-v2-9e2f' };
let depositPage: Page;
let depositInputs: HtmlInputs;
let depositNotes: unknown;
let depositTitle: ReportTitle;

before(async () => {
  const compilers = await warmCompilers(reportCases(ROOT, registry, [target, deposit]));
  const depositReplayed = await replayInputs(ROOT, registry, deposit, compilers, loadPublicSuffixList());
  const depositTemplate = depositReplayed.inputs.subject.kind === 'template' ? depositReplayed.inputs.subject.template : assert.fail('a template report');
  depositInputs = { ...depositReplayed.inputs, fixtures: await judgeFixtures(ROOT, depositTemplate, registry), example: firstRecordedTx(ROOT, depositTemplate, depositReplayed.inputs.registry) };
  depositNotes = readNotes(ROOT, deposit.template, registry.entries.get(deposit.cardVault));
  depositTitle = depositReplayed.title;
  depositPage = buildPage(depositInputs, depositNotes, depositTitle);
  const replayed = await replayInputs(ROOT, registry, target, compilers, loadPublicSuffixList());
  title = replayed.title;
  template = replayed.inputs.subject.kind === 'template' ? replayed.inputs.subject.template : assert.fail('a template report');
  inputs = { ...replayed.inputs, fixtures: await judgeFixtures(ROOT, template, registry), example: firstRecordedTx(ROOT, template, registry) };
});

/** Notes that hold exactly what the scope requires, each text naming its key, so a page row can be traced to its note. */
function notesFor(of: HtmlInputs): Record<string, unknown> {
  const scope = notesScope(of, judge(of, of.fixtures), of.subject.kind === 'template' ? of.subject.template : assert.fail('a template report'));
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

function oneCall(of: HtmlInputs, n: number): HtmlInputs {
  const subject = of.subject.kind === 'template' ? of.subject : assert.fail('a template report');
  const call = subject.template.calls[n - 1] ?? assert.fail(`no call ${n}`);
  return { ...of, subject: { ...subject, template: { ...subject.template, calls: [call] } }, example: undefined, fixtures: [] };
}

const oneCallPage = (of: HtmlInputs): Page => buildPage(of, { ...notesFor(of), flow: [] }, title);
const body = <K extends Body['kind']>(page: Page, kind: K): Extract<Body, { kind: K }> => page.sections.find((s) => s.body.kind === kind)?.body as Extract<Body, { kind: K }>;
const args = (page: Page): ArgRow[] => body(page, 'flow').flow.calls.flatMap((call) => call.args);
const arg = (page: Page, key: string): ArgRow => args(page).find((a) => a.key === key) ?? assert.fail(`no row ${key}`);
const plain = (spans: readonly unknown[] | undefined): string =>
  (spans ?? []).map((s) => (typeof s === 'string' ? s : 'label' in (s as object) ? (s as { label: string }).label : Object.values(s as object)[0])).join('');

test('the page of morpho/market-supply puts its sections in the signer order', { timeout: 600_000 }, () => {
  const page = pageOf(inputs);
  assert.deepEqual(
    page.sections.map((s) => s.anchor),
    ['flow', 'protocol-morpho-blue', 'review', 'wallet', 'addresses', 'past', 'next'],
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
  assert.equal(permit.value, undefined);
  assert.equal(plain(permit.words), '2 個部分');
  assert.deepEqual(
    permit.parts.flatMap((g) => g.rows).map((p) => [p.name, p.value?.cast]),
    [
      ['kind', '0'],
      ['data', '0x'],
    ],
  );
  assert.deepEqual(arg(page, '2.blueBundlesV1Supply.deadline').chips, [{ who: 'free', label: 'app 填，不限' }]);
  assert.equal(plain(arg(page, '2.blueBundlesV1Supply.referralFeeRecipient').words), '無（零地址）');
  assert.equal(arg(page, '2.blueBundlesV1Supply.deadline').ai.ai, 'field 2.blueBundlesV1Supply.deadline');
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

  const adapter = (registry.entries.get('general-adapter-1') ?? assert.fail('general-adapter-1')).address;
  const leaf = (item: ArgRow | undefined, name: string): string | undefined => rows(item ?? assert.fail('an item')).find((p) => p.name === name)?.value?.cast;
  assert.equal(leaf(first, 'to')?.toLowerCase(), adapter);
  assert.equal(leaf(first, 'value'), '0');
  assert.equal(leaf(first, 'skipRevert'), 'false');
  assert.equal(leaf(first, 'callbackHash'), `0x${'0'.repeat(64)}`);
  const amount = arg(depositPage, '1.approve.value').value;
  assert.equal(amount?.example, true);
  assert.deepEqual(leaf(data(first), 'amount'), amount?.cast);
  assert.deepEqual(leaf(data(second), 'assets'), amount?.cast);
  assert.equal(leaf(data(first), 'receiver')?.toLowerCase(), adapter);

  const all = (row: ArgRow): ArgRow[] => [row, ...rows(row).flatMap(all)];
  for (const row of args(depositPage).flatMap(all)) {
    if (row.parts.length > 0) assert.equal(row.value, undefined, `${row.key} is a container`);
    else assert.ok(row.value === undefined || !/^[[(]/.test(row.value.cast), `${row.key} is a leaf`);
  }
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

function walletCall(page: Page): { readonly call: WalletCall; readonly lines: readonly Inline[] } {
  const { view } = body(page, 'wallet');
  if (view.kind !== 'calls') return assert.fail('a one-call template lists its call');
  return { call: view.calls[0] ?? assert.fail('one call'), lines: view.lines };
}

test('a template of two or more calls goes through MultiSend, so its wallet section only says to compare the safeTxHash', () => {
  assert.deepEqual(body(pageOf(inputs), 'wallet').view, { kind: 'multisend', calls: 2 });
  assert.deepEqual(body(depositPage, 'wallet').view, { kind: 'multisend', calls: 2 });
});

test('the wallet rows match a descriptor by each array item, by argument name without underscores, and show a token with no descriptor as raw data', () => {
  const rowsOf = (of: HtmlInputs, n: number) => {
    const { call } = walletCall(oneCallPage(oneCall(of, n)));
    return call.rows === 'no-descriptor' ? call.rows : call.rows.map((r) => [plain(r.label), plain(r.value)]);
  };
  assert.equal(rowsOf(depositInputs, 1), 'no-descriptor');
  assert.deepEqual(rowsOf(depositInputs, 2), [['bundle.[0].data', '呼叫 erc20TransferFrom，參數見流程'], ['bundle.[1].data', '呼叫 erc4626Deposit，參數見流程']]);
  const usdc = registry.entries.get('usdc') ?? assert.fail('usdc');
  const field = (path: string) => ({ kind: 'field', path, format: 'raw', visible: 'always' }) as const;
  const usdtLike = { functions: [{ selector: '0x095ea7b3', signature: 'approve(address,uint256)', fields: [field('_spender'), field('_value')], notShown: [] }] } as unknown as EntryReport['descriptors'][number];
  const reports = [...depositInputs.erc7730.reports, { entry: usdc, factory: undefined, index: undefined, descriptors: [usdtLike] }];
  assert.deepEqual(rowsOf({ ...depositInputs, erc7730: { ...depositInputs.erc7730, reports } }, 1), [['被授權者', 'general-adapter-1'], ['金額', '你填的 amount']]);
});

test("a per-vault report shows its vault as the card's value, with or without a test transaction", () => {
  const vault = (page: Page) => arg(page, '2.multicall.bundle').parts.flatMap((g) => g.rows)[1]?.parts.flatMap((g) => g.rows).find((r) => r.name === 'data')?.parts.flatMap((g) => g.rows).find((r) => r.name === 'vault');
  const hyperithm = registry.entries.get('hyperithm-usdc-apex-v2-9e2f') ?? assert.fail('the vault');
  for (const page of [depositPage, buildPage({ ...depositInputs, example: undefined }, depositNotes, depositTitle)]) {
    const row = vault(page) ?? assert.fail('the vault row');
    assert.equal(row.value?.cast.toLowerCase(), hyperithm.address);
    assert.equal(row.value?.example, false);
    assert.equal(plain(row.words), 'hyperithm-usdc-apex-v2-9e2f');
  }
  assert.equal(depositPage.id, 'morpho/vault-deposit · hyperithm-usdc-apex-v2-9e2f');
});

test("a per-vault report shows the vault's stored evidence after the protocol, with no USD value", () => {
  assert.deepEqual(
    depositPage.sections.map((s) => s.anchor),
    ['flow', 'protocol-morpho-blue', 'vault-hyperithm-usdc-apex-v2-9e2f', 'review', 'wallet', 'addresses', 'past', 'next'],
  );
  const { vault } = body(depositPage, 'vault');
  assert.deepEqual(
    vault.rows.map((r) => [r.label, plain(r.value)]),
    [
      ['工廠', 'vault-v2-factory 回答 isVaultV2(address) = true'],
      ['現在的 totalAssets', '7,501,013.23 usdc'],
      ['持有人', '170 個地址持有，曾經收過的 354 個'],
      ['最大持有人', '51.77%'],
      ['前 10 名', '90.10%'],
    ],
  );
  assert.equal(vault.bars.length, 13);
  assert.deepEqual(vault.bars[0], { date: '2025-11-16', words: '3,329.1 usdc', share: 3329_104017 / 12646299_801537 });
  assert.deepEqual(vault.bars.at(-1)?.date, '2026-11-13');
  assert.equal(vault.most, '12,646,299.8 usdc');
  assert.ok(!JSON.stringify(vault).includes('$'), 'no USD value');
});

test('a month the providers disagree on reads 讀不到 and draws no bar', () => {
  const name = 'hyperithm-usdc-apex-v2-9e2f';
  const text = (depositInputs.vaults.get(name) ?? assert.fail('stored evidence')).replace(/(2026-07-15 {2}block \d+ {2}).*/, '$1UNVERIFIABLE eth_call: alchemy and drpc disagree');
  const { vault } = body(buildPage({ ...depositInputs, vaults: new Map([[name, text]]) }, depositNotes, depositTitle), 'vault');
  assert.deepEqual(vault.bars.find((b) => b.date === '2026-07-15'), { date: '2026-07-15', words: '讀不到', share: undefined });
  assert.equal(vault.most, '10,963,761.48 usdc');
});

test('the vault its factory alone confirms is the one 待確認; every address row names where its address was confirmed', () => {
  assert.deepEqual(body(depositPage, 'review').rows.map((r) => [r.id, r.state, plain(r.title)]), [
    ['hyperithm-usdc-apex-v2-9e2f/address', 'warn', 'hyperithm-usdc-apex-v2-9e2f：地址只在 1 個地方確認：工廠'],
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
    vault.sources.flatMap((s) => (s.by === 'program' ? [[s.label, s.state, s.phrase]] : [])),
    [
      ['app.morpho.org/ethereum/vault', 'na', '讀不到'],
      ['CoinGecko', 'na', '沒資料可比'],
      ['工廠', 'ok', undefined],
      ['DefiLlama', 'ok', undefined],
    ],
  );
});

test('each past-transactions recording names the entry its search anchored on', () => {
  const { recordings } = body(depositPage, 'past');
  assert.ok(recordings.length > 0);
  for (const r of recordings) assert.match(r.count, /^搜尋 [a-z0-9-]+ 的 鑄造（存款），找到 \d+ 筆，研究 \d+ 筆$/);
});

test('a contract a flow line names gets its own lifeline, so every inside arrow ends on one', () => {
  const { diagram } = body(depositPage, 'flow').flow;
  assert.deepEqual(diagram.lifelines.map((l) => l.name), ['你的 Safe', 'usdc', 'bundler3', 'general-adapter-1']);
  const inside = diagram.arrows.flatMap((a) => (a.kind === 'inside' ? [[a.from, a.to]] : []));
  assert.deepEqual(inside, [[2, 3], [3, 1]]);
});

test('the protocol block holds the recorded facts and the market reading with its ratio', () => {
  const { block } = body(pageOf(inputs), 'protocol');
  const row = (label: string) => block.rows.find((r) => r.label === label) ?? assert.fail(`no ${label} row`);
  assert.equal(plain(row('TVL').value), '$10.47 B');
  assert.equal(plain(row('上線').value), '2024-01-14');
  assert.equal(plain(row('proxy').value), '不是 proxy');
  assert.equal(plain(row('事故').value), '0 起');
  assert.deepEqual(
    row('usdc-cbbtc-86').nested.map((n) => plain(n.value)),
    ['353,557,246.53 usdc', '302,305,558.99 usdc', '85.50%'],
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

test('the oracle only the protocol API confirms is the one row to review, open in 地址, and the verdict icon is amber', () => {
  const page = pageOf(inputs);
  assert.deepEqual(
    body(page, 'review').rows.map((r) => [r.id, r.state, r.entry]),
    [['morpho-oracle-cbbtc-usdc-86/address', 'warn', 'a-morpho-oracle-cbbtc-usdc-86']],
  );
  const addresses = body(page, 'addresses');
  assert.deepEqual(
    addresses.open.map((r) => [r.name, r.confidence, r.reviewed, r.confirmed]),
    [['morpho-oracle-cbbtc-usdc-86', 'low', 'AI 有疑慮', '只在 1 個地方確認：協議 API']],
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
  assert.equal(walletCall(oneCallPage(oneCall(inputs, 1))).call.rows, 'no-descriptor');
  const wallet = walletCall(oneCallPage(oneCall(inputs, 2)));
  const rows = wallet.call.rows;
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
  assert.deepEqual(
    wallet.lines.map((line) => plain(line)),
    ['呼叫 1：錢包不顯示 marketParams.loanToken、marketParams.oracle、marketParams.irm、loanTokenPermit.kind。', '呼叫 1：同樣兩種代幣的不同 market，只看錢包分不出來。'],
  );
});

test('a wallet row is labelled by the argument it shows, never by a descriptor path that names no argument', () => {
  const extra: FieldFact[] = ['constructor', '#.marketParams.toString', '#.loanTokenPermit'].map((path) => ({ kind: 'field', path, format: 'raw', visible: 'always' }));
  const reports = inputs.erc7730.reports.map((report) => ({
    ...report,
    descriptors: report.descriptors.map((d) => ({ ...d, functions: d.functions.map((f) => ({ ...f, fields: [...f.fields, ...extra] })) })),
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
      ['Safe', '0 筆用了這個操作的呼叫（0 個 Safe），0 筆跟模板一樣。'],
      ['EOA 直接呼叫 blueBundlesV1Supply', '8 筆用了這個操作的呼叫（8 個地址），8 筆跟模板一樣。'],
    ],
  );
  assert.equal(plain(recording?.search), 'Alchemy 和 Etherscan 找到的完全一樣（528 = 528）。');
});

test('a bundle with another number of items is grouped and named by the functions its items call, each example linked to Etherscan', () => {
  const [early] = body(depositPage, 'past').recordings;
  const [safe, eoa] = early?.blocks ?? assert.fail('two blocks');
  assert.equal(plain(safe?.lead), '8 筆用了這個操作的呼叫（4 個 Safe），6 筆跟模板一樣。');
  assert.deepEqual(
    safe?.groups.map((g) => [g.count, plain(g.calls), plain(g.reason)]),
    [[2, 'bundler3.multicall', '呼叫跟模板不同，模板是 approve → multicall']],
  );
  assert.equal(plain(eoa?.lead), '354 筆用了這個操作的呼叫（150 個地址），25 筆跟模板一樣。');
  assert.deepEqual(
    eoa?.groups.map((g) => [g.count, g.senders, plain(g.calls), plain(g.reason)]),
    [
      [321, 126, 'usdc.permit → general-adapter-1.erc20TransferFrom → general-adapter-1.erc4626Deposit', 'bundle 有 3 項，模板是 2 項'],
      [7, 7, 'usdc.permit → general-adapter-1.erc20TransferFrom → general-adapter-1.erc4626Deposit → general-adapter-1.erc20Transfer → general-adapter-1.erc20Transfer', 'bundle 有 5 項，模板是 2 項'],
      [1, 1, 'general-adapter-1.erc20TransferFrom → general-adapter-1.erc4626Deposit → general-adapter-1.erc20Transfer → general-adapter-1.erc20Transfer', 'bundle 有 4 項，模板是 2 項'],
    ],
  );
  assert.deepEqual(eoa?.groups[0]?.examples[0], { href: 'https://etherscan.io/tx/0x94ba5b792613b7a04c2235f47062cf3f991524be9dffadd0fa595a16783a73ea', label: '0x94ba5b79…' });
  assert.match(plain(early?.others[0]), /^另外 127 筆是別的操作，不列入：deposit 62 筆、/);
  assert.ok(!JSON.stringify(early).includes('符合'), 'no verdict word');
});

test('過去交易 leads with how many past transactions had exactly the template shape, each counted once, and the latest of them', () => {
  assert.equal(
    plain(body(depositPage, 'past').same),
    '過去有 32 筆交易跟模板一模一樣：Safe 6 筆（2 個 Safe）、EOA 26 筆（17 個地址，各自送模板的一個呼叫）。全部成功執行：它們是從 hyperithm-usdc-apex-v2-9e2f 鑄造（存款）時的 Transfer 紀錄找到的，失敗的交易不會留下紀錄。最近 3 筆：0x88258583…、0xa56ce3d8…、0x15133c00…。',
  );
  const noFits = depositInputs.pastTxs.map((p) => ({ ...p, run: { ...p.run, studies: p.run.studies.filter((s) => s.kind !== 'fit') } }));
  assert.equal(plain(body(buildPage({ ...depositInputs, pastTxs: noFits }, depositNotes, depositTitle), 'past').same), '過去的記錄裡，沒有一筆交易跟模板一模一樣。');
  const twice = [...depositInputs.pastTxs, ...depositInputs.pastTxs];
  assert.deepEqual(body(buildPage({ ...depositInputs, pastTxs: twice }, depositNotes, depositTitle), 'past').same, body(depositPage, 'past').same);
});

test('待確認 counts the program results apart from the AI judgments, in the rail and the heading', () => {
  assert.deepEqual(depositPage.sections.find((s) => s.anchor === 'review')?.count, { kind: 'states', counts: [{ state: 'warn', n: 1 }, { state: 'ask', n: 3 }] });
});

test('notes.json that leaves out a review the page needs is refused', () => {
  const notes = notesFor(inputs);
  assert.throws(
    () => buildPage(inputs, { ...notes, reviews: {} }, title),
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
    assert.deepEqual(ids, forSigner(ledger).map((r) => r.id));
    assert.ok(review.rows.every((r) => r.state === 'bad' || r.state === 'warn'));
    for (const item of page.header.strip.filter((s) => s.line !== 'providers')) {
      const rows = review.rows.filter((r) => ledger.results.find((x) => x.id === r.id)?.line === item.line);
      const expected = rows.length === 0 ? undefined : rows.reduce<State>((acc, r) => (RANK[r.state] > RANK[acc] ? r.state : acc), 'na');
      if (expected === undefined) assert.ok(item.state === 'ok' || item.state === 'na', `${item.name} is ${item.state} with nothing to review`);
      else assert.equal(item.state, expected, item.name);
    }
    const rail = page.sections.find((s) => s.anchor === 'review')?.count;
    assert.deepEqual(rail, { kind: 'states', counts: [...(ids.length > 0 ? [{ state: worst(forSigner(ledger)), n: ids.length }] : []), { state: 'ask', n: review.judgments.length }] });
    const reviewed = new Set(review.rows.flatMap((r) => (r.entry === undefined ? [] : [r.entry])));
    assert.deepEqual(new Set(body(page, 'addresses').open.map((r) => r.anchor)), reviewed);
    assert.equal(page.header.verdict.state, worst(ledger.results));
    assert.ok(review.rows.every((r) => stateOf(ledger.results.find((x) => x.id === r.id) ?? assert.fail(r.id)) === r.state));
  });
}
