import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { LANGUAGES } from '../src/language.ts';
import type { Language } from '../src/language.ts';
import { checklist, checklistHtml, checklistLineHtml } from '../src/verify/checklist.ts';
import { checkCommand, checkHints } from '../src/verify/check-command.ts';
import { callTree } from '../src/verify/expected.ts';
import { verdictPage } from '../src/verify/page.ts';
import type { CheckName, CheckState } from '../src/verify/verdict.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const registry = loadRegistry(ROOT);
const PASSED: Record<CheckName, CheckState> = {
  'template-approval': 'passed',
  'static-floor': 'passed',
  fields: 'passed',
  'vault-asset': 'passed',
  'contract-code': 'passed',
  mutation: 'passed',
  simulation: 'passed',
  'simulated-floor': 'passed',
  effects: 'passed',
};

function iconLabelAndNote(page: string, name: string): string | undefined {
  const found = new RegExp(`aria-label="([^"]+)"><use href="#[a-z]+"/></svg>${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:<span class="n">(· [^<]+)</span>)?</li>`).exec(page);
  return found === null ? undefined : [found[1], found[2]].filter((part) => part !== undefined).join(' ');
}
const FIXTURE = 'morpho-deposit-approve-trailer-other-safe';
const CARD: Card = {
  operations: [{ template: 'morpho/vault-deposit', values: { vault: 'hyperithm-usdc-apex-v1-7777', amount: '10001000000', 'min-shares': '9482917730630123475126' } }],
};

const recordedTx = (fixture: string) => JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${fixture}.json`), 'utf8'));

function treeOf(card: Card, fixture = FIXTURE, book: Record<string, Address> = {}) {
  const recorded = recordedTx(fixture);
  const tx = parseServiceTx(recorded.service, { chainId: 1n, version: recorded.chain.version });
  const templates = new Map<string, Template>(card.operations.map((op) => [op.template, loadTemplate(ROOT, op.template, registry)]));
  const addressBook = new Map(Object.entries(book));
  const resolution = resolveCard(card, { templates, registry, addressBook, safe: tx.safe });
  assert.equal(resolution.kind, 'resolved');
  const resolved = (resolution as Extract<typeof resolution, { kind: 'resolved' }>).card;
  const decimals = new Map([['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address, 6]]);
  return { tree: callTree(tx, { registry, safe: tx.safe, card: resolved, templates, addressBook, decimals }), card: resolved, templates, decimals };
}

const ethPayee = String(recordedTx('eth-transfer-null-data').service.to).toLowerCase() as Address;
const PINNED: readonly { readonly fixture: string; readonly card: Card; readonly book?: Record<string, Address> }[] = [
  { fixture: FIXTURE, card: CARD },
  { fixture: 'eth-transfer-null-data', card: { operations: [{ template: 'eth/transfer', values: { amount: String(recordedTx('eth-transfer-null-data').service.value), recipient: 'payee' } }] }, book: { payee: ethPayee } },
  { fixture: 'merkl-claim-two-tokens', card: { operations: [{ template: 'merkl/claim', values: { token: 'usdc' } }, { template: 'merkl/claim', values: { token: 'morpho' } }] } },
  { fixture: 'cow-swap-usdc', card: { operations: [{ template: 'cow/swap', values: { 'sell-token': 'usdc', 'buy-token': 'usdt', 'sell-amount': '100000000000', 'min-buy': '99084887371' } }] } },
  {
    fixture: 'uniswap-swap-hook-approve-usdt-usdc',
    card: {
      operations: [
        { template: 'uniswap/approve-permit2', values: { token: 'usdt' } },
        { template: 'uniswap/allow-router', values: { token: 'usdt' } },
        { template: 'uniswap/swap', values: { 'sell-token': 'usdt', 'buy-token': 'usdc', 'sell-amount': '2000000000', 'min-buy': '1987680455' } },
      ],
    },
  },
  {
    fixture: 'vault-v2-cap-submit-flowmark',
    card: { operations: [{ template: 'morpho/vault-v2-cap-submit', values: { vault: 'flowmark-fgenesis-v2-6439', market: 'usdc-cbbtc-86', 'absolute-cap': '50000000000', 'relative-cap': '50000000000000000' } }] },
  },
  {
    fixture: 'vault-v2-reallocate-back',
    card: { operations: [{ template: 'morpho/vault-v2-reallocate', values: { vault: 'acuto-usdc-v2-4a57', from: 'usdc-usp-86', to: 'usdc-usp-915', amount: '1000000' } }] },
  },
];

const namesAside = (block: string): string => `${block.replace(/<span class="nm">.*<\/span><\/div>$/gm, '</div>')}\n`;
const checkSh = (language: Language, fixture: string): string => readFileSync(join(ROOT, 'testdata', 'checklist', language, `${fixture}.checklist.html`), 'utf8');
const pinnedHints = (fixture: string): string => readFileSync(join(ROOT, 'testdata', 'checklist', 'hints', `${fixture}.txt`), 'utf8');

for (const { fixture, card, book } of PINNED) {
  for (const language of LANGUAGES) {
    test(`the ${language} 比對清單 of ${fixture} is, byte for byte, the block check.sh writes for it in ${language}, names aside`, () => {
      const { tree } = treeOf(card, fixture, book);
      assert.equal(namesAside(checklistHtml(checklist(tree, language), language)), checkSh(language, fixture));
    });
  }
}

for (const { fixture, card, book } of PINNED) {
  test(`the --hints for ${fixture} are those kiss-sign-check runs check.sh with on it`, () => {
    const { tree } = treeOf(card, fixture, book);
    assert.equal(`${checkHints(tree) ?? ''}\n`, pinnedHints(fixture));
  });
}

test('the check.sh command carries --hints only when a template reads bytes no ABI describes', () => {
  const swap = PINNED.find((p) => p.fixture === 'uniswap-swap-hook-approve-usdt-usdc');
  const { tree: swapTree } = treeOf(swap?.card ?? CARD, swap?.fixture);
  assert.equal(
    checkCommand(swapTree),
    "./check.sh 1 --hints 'v1 C4-a2.1=abi(bytes,bytes[]) C4-a2.1.2.1=abi(address,uint256,bool) C4-a2.1.2.2=abi(((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)) C4-a2.1.2.3=abi(address,address,uint256) C4-a2.2=abi(address,address,uint256)'",
  );
  const { tree } = treeOf(CARD);
  assert.equal(checkCommand(tree), `./check.sh ${tree.nonce}`);
});

test('a page in one language and check.sh in the other differ in every row with words, so the signer stops', () => {
  const { tree } = treeOf(CARD);
  const ours = namesAside(checklistHtml(checklist(tree, 'en'), 'en')).split('\n');
  const theirs = checkSh('zh-TW', FIXTURE).split('\n');
  const differing = ours.filter((line, i) => line !== theirs[i]).map((line) => /<span class="id">([^<]+)<\/span>/.exec(line)?.[1]);
  assert.deepEqual(differing, ['tx', 'C1', 'C1-value', 'C1-fn', 'C1-a1', 'C2', 'C2-value', 'C2-fn', 'C2-a1', 'C2-a2', 'C2-extra', 'C3', 'C3-value', 'C3-fn', 'C3-a1', 'C3-extra', 'C3.1', 'C3.1-value', 'C3.1-fn', 'C3.1-a1', 'C3.1-a2', 'C3.1-a3', 'C3.2', 'C3.2-value', 'C3.2-fn', 'C3.2-a1', 'C3.2-a2', 'C3.2-a3', 'C3.2-a4', 'end', 'end-count']);
});

test('the -extra row names the template\'s allowance as a program fact and its reason as AI text, its value as check.sh writes it', () => {
  const { tree, card, templates, decimals } = treeOf(CARD);
  const page = verdictPage({
    verdict: { kind: 'MATCH' },
    states: PASSED,
    nonce: tree.nonce,
    card,
    cardHash: `0x${'00'.repeat(32)}`,
    registry,
    templates,
    decimals,
    expected: { kind: 'expected', changes: new Map() },
    calls: { kind: 'scanned', movesNothing: [] },
    tree,
    kept: [],
    verdictFile: '/verdicts/x.json',
    language: 'zh-TW',
  });
  const extra = page.split('\n').find((line) => line.includes('<span class="id">C3-extra</span>'));
  assert.match(
    extra ?? '',
    /<span class="v">0x[0-9a-f]{16}<\/span><span class="nm">模板允許這個呼叫最多 12 bytes，這裡 8 bytes，在範圍內 <span class="aiw" data-ai><span class="byai">AI<\/span><span>Morpho app 會在後面附上[^<]*<\/span><\/span><\/span><\/div>$/,
  );
  assert.match(page, /<p class="lead">各列是繁體中文。獨立電腦上 check\.sh 的 config 也要設 LANGUAGE=zh-TW，不然各列會不同。<\/p>\n<!-- 比對清單 -->/);
  assert.match(page, new RegExp(`<title>kiss-sign verify · nonce ${tree.nonce} · MATCH</title>`));
  assert.match(page, new RegExp(`<h1><span class="prog">kiss-sign verify</span> · nonce ${tree.nonce} · MATCH</h1>`));
});

test('a row value from outside is escaped as jq @html escapes it, and characters that hide or reorder text are replaced', () => {
  const line = checklistLineHtml({ kind: 'row', id: 'C1-a1', key: '引數 1', value: '"><img src=x onerror=alert(1)><script>\u202eevil\u200f\u0007', name: "it's\u2066" }, 'zh-TW');
  assert.equal(
    line,
    '<div class="r"><span class="id">C1-a1</span><span class="k">引數 1</span><span class="v">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;�evil��</span><span class="nm">it&apos;s�</span></div>',
  );
});

test('a long value folds to its length and keccak256, with the full text inside a closed details element', () => {
  const bytes = checklistLineHtml({ kind: 'row', id: 'C1-data', key: 'data', value: `0x${'ab'.repeat(33)}`, name: '' }, 'zh-TW');
  assert.match(bytes, /<details><summary>33 bytes，keccak256 0x[0-9a-f]{64}<\/summary><span class="full">0x(ab){33}<\/span><\/details>/);
  const exact = checklistLineHtml({ kind: 'row', id: 'C1-a1', key: '引數 1', value: `0x${'ab'.repeat(32)}`, name: '' }, 'zh-TW');
  assert.doesNotMatch(exact, /<details>/);
  const text = checklistLineHtml({ kind: 'row', id: 'C1-a1', key: '引數 1', value: `[${'1, '.repeat(40)}1]`, name: '' }, 'zh-TW');
  assert.match(text, /<summary>123 字元，keccak256 0x[0-9a-f]{64}<\/summary>/);
  const english = (value: string) => checklistLineHtml({ kind: 'row', id: 'C1-a1', key: 'argument 1', value, name: '' }, 'en');
  assert.match(english(`0x${'ab'.repeat(33)}`), /<summary>33 bytes, keccak256 0x[0-9a-f]{64}<\/summary>/);
  assert.match(english(`[${'1, '.repeat(40)}1]`), /<summary>123 characters, keccak256 0x[0-9a-f]{64}<\/summary>/);
});

test('the verify page holds no script, loads nothing, and shows text from a cause as inert text', () => {
  const { tree, card, templates, decimals } = treeOf(CARD);
  const page = verdictPage({
    verdict: { kind: 'MISMATCH', causes: [{ check: 'effects', details: ['<script>alert(1)</script> "><img src=x onerror=alert(1)> \u202eevil'] }] },
    states: { ...PASSED, effects: 'failed' },
    nonce: tree.nonce,
    card,
    cardHash: `0x${'00'.repeat(32)}`,
    registry,
    templates,
    decimals,
    expected: { kind: 'expected', changes: new Map() },
    calls: { kind: 'scanned', movesNothing: [] },
    tree: undefined,
    kept: [],
    verdictFile: '/verdicts/x.json',
    language: 'zh-TW',
  });
  assert.match(page, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
  assert.doesNotMatch(page, /<script|<img|<link|\u202e/i);
  assert.match(page, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/);
  assert.match(page, /不顯示任何 hash。不要簽這筆交易。/);
});

test('when the simulation could not run, the page does not show the checks that read it as passed', () => {
  const { tree, card, templates, decimals } = treeOf(CARD);
  const page = verdictPage({
    verdict: { kind: 'UNVERIFIABLE', causes: [{ check: 'simulation', details: ['no agreed block'] }] },
    states: { ...PASSED, simulation: 'unverifiable', 'simulated-floor': 'not-run', effects: 'not-run' },
    nonce: tree.nonce,
    card,
    cardHash: `0x${'00'.repeat(32)}`,
    registry,
    templates,
    decimals,
    expected: { kind: 'expected', changes: new Map() },
    calls: { kind: 'unverifiable', reasons: ['no agreed block'] },
    tree: undefined,
    kept: [],
    verdictFile: '/verdicts/x.json',
    language: 'zh-TW',
  });
  assert.equal(iconLabelAndNote(page, '模擬'), '注意 · 沒完成');
  assert.equal(iconLabelAndNote(page, '模擬後的底線規則'), '沒資料可比 · 沒有執行');
  assert.equal(iconLabelAndNote(page, 'Safe 的資產變化符合卡片'), '沒資料可比 · 沒有執行');
  assert.equal(iconLabelAndNote(page, '每個欄位符合模板和卡片'), '通過');
});

test("on a mismatch page a check that passed, one that failed, one that did not run and one the card does not need each look different", () => {
  const { tree, card, templates, decimals } = treeOf(CARD);
  const page = verdictPage({
    verdict: { kind: 'MISMATCH', causes: [{ check: 'fields', details: ['call.transfer to: expected 0x1, got 0x2'] }] },
    states: { ...PASSED, fields: 'failed', mutation: 'not-run', 'contract-code': 'not-needed' },
    nonce: tree.nonce,
    card,
    cardHash: `0x${'00'.repeat(32)}`,
    registry,
    templates,
    decimals,
    expected: { kind: 'expected', changes: new Map() },
    calls: { kind: 'scanned', movesNothing: [] },
    tree: undefined,
    kept: [],
    verdictFile: '/verdicts/x.json',
    language: 'en',
  });
  assert.equal(iconLabelAndNote(page, 'Template approved'), 'pass');
  assert.equal(iconLabelAndNote(page, 'Every field fits the template and the card'), 'fail');
  assert.equal(iconLabelAndNote(page, 'Changed fields are caught'), 'nothing to compare · not run');
  assert.equal(iconLabelAndNote(page, 'Contract code unchanged'), 'nothing to compare · not needed for this card');
});

test('the card and the expected changes show each amount in whole tokens with its registry name, full address and exact base units', () => {
  const { tree, card, templates, decimals } = treeOf(CARD);
  const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address;
  const vault = '0x777791c4d6dc2ce140d00d2828a7c93503c67777' as Address;
  const page = verdictPage({
    verdict: { kind: 'MATCH' },
    states: PASSED,
    nonce: tree.nonce,
    card,
    cardHash: `0x${'00'.repeat(32)}`,
    registry,
    templates,
    decimals: new Map([...decimals, [vault, 18]]),
    expected: { kind: 'expected', changes: new Map([[usdc, { kind: 'exactly', change: -10001000000n }], [vault, { kind: 'more-than', change: 0n }]]) },
    calls: { kind: 'scanned', movesNothing: [] },
    tree,
    kept: [],
    verdictFile: '/verdicts/x.json',
    language: 'zh-TW',
  });
  const text = page.slice(page.indexOf('<h2>卡片</h2>')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, / amount 10,001 usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 10001000000 最小單位，6 位小數 /);
  assert.match(text, / min-shares 9,482.917730630123475126 hyperithm-usdc-apex-v1-7777 0x777791C4d6DC2CE140D00D2828a7C93503c67777 9482917730630123475126 最小單位，18 位小數 /);
  assert.match(text, / 給出 剛好 10,001 usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 10001000000 最小單位，6 位小數 /);
  assert.match(text, / 收到 多於 0 hyperithm-usdc-apex-v1-7777 0x777791C4d6DC2CE140D00D2828a7C93503c67777 不移動資產的呼叫 /);
});

test('a range of expected changes shows both ends in whole tokens, as what the Safe gives or gets', () => {
  const { tree, card, templates, decimals } = treeOf(CARD);
  const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address;
  const vault = '0x777791c4d6dc2ce140d00d2828a7c93503c67777' as Address;
  const page = (language: 'en' | 'zh-TW') =>
    verdictPage({
      verdict: { kind: 'MATCH' },
      states: PASSED,
      nonce: tree.nonce,
      card,
      cardHash: `0x${'00'.repeat(32)}`,
      registry,
      templates,
      decimals: new Map([...decimals, [vault, 18]]),
      expected: { kind: 'expected', changes: new Map([[usdc, { kind: 'between', low: -10001000000n, high: 0n }], [vault, { kind: 'between', low: 998n, high: 1000n }]]) },
      calls: { kind: 'scanned', movesNothing: [] },
      tree,
      kept: [],
      verdictFile: '/verdicts/x.json',
      language,
    });
  const text = (language: 'en' | 'zh-TW') => page(language).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text('zh-TW'), / 給出 介於 0 usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 和 10,001 usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 10001000000 最小單位，6 位小數 之間 /);
  assert.match(text('en'), / Gets between 0\.000000000000000998 hyperithm-usdc-apex-v1-7777 0x777791C4d6DC2CE140D00D2828a7C93503c67777 998 base units, 18 decimals and 0\.000000000000001 /);
});

test('an amount whose token decimals() was not read shows its base units and says so', () => {
  const { tree, card, templates } = treeOf(CARD);
  const page = verdictPage({
    verdict: { kind: 'MATCH' },
    states: PASSED,
    nonce: tree.nonce,
    card,
    cardHash: `0x${'00'.repeat(32)}`,
    registry,
    templates,
    decimals: new Map(),
    expected: { kind: 'expected', changes: new Map() },
    calls: { kind: 'scanned', movesNothing: [] },
    tree,
    kept: [],
    verdictFile: '/verdicts/x.json',
    language: 'zh-TW',
  });
  const text = page.slice(page.indexOf('<h2>卡片</h2>')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, / amount 10001000000 最小單位 的 usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 decimals\(\) 沒讀到 /);
});

test('format characters, tag characters and variation selectors become U+FFFD too', () => {
  const hidden = [0xad, 0x34f, 0x115f, 0x180e, 0x2028, 0x206a, 0x3164, 0xfe0f, 0xffa0, 0xfffb, 0xe0041, 0xe0100].map((c) => String.fromCodePoint(c)).join('');
  const line = checklistLineHtml({ kind: 'row', id: 'C1-a1', key: '引數 1', value: `a${hidden}b`, name: '' }, 'en');
  assert.match(line, new RegExp(`<span class="v">a${'\ufffd'.repeat(12)}b</span>`, 'u'));
});

test('a call that moves no asset is named by its function only when a template on the card calls that function on that address', () => {
  const { tree, card, templates, decimals } = treeOf(CARD);
  const usdc = registry.entries.get('usdc')!.address;
  const other = '0x1111111111111111111111111111111111111111' as Address;
  const page = verdictPage({
    verdict: { kind: 'MATCH' },
    states: PASSED,
    nonce: tree.nonce,
    card,
    cardHash: `0x${'00'.repeat(32)}`,
    registry,
    templates,
    decimals,
    expected: { kind: 'expected', changes: new Map() },
    calls: { kind: 'scanned', movesNothing: [{ path: 'multiSend[0]', to: usdc, selector: '0x095ea7b3' as Hex }, { path: 'multiSend[1]', to: other, selector: '0x095ea7b3' as Hex }] },
    tree,
    kept: [],
    verdictFile: '/verdicts/x.json',
    language: 'en',
  });
  assert.match(page, /<p class="lead">The rows are in English\. check\.sh&#39;s config on the independent computer must say LANGUAGE=en too, or the rows differ\.<\/p>\n<!-- 比對清單 -->/);
  const text = page.slice(page.indexOf('<h2>Calls that move no asset</h2>')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, / multiSend\[0\] usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 approve\(address,uint256\) 0x095ea7b3 /);
  assert.match(text, / multiSend\[1\] not registered 0x1111111111111111111111111111111111111111 selector 0x095ea7b3 /);
});
