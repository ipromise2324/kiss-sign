import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address } from '../src/safe/types.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { checklist, checklistHtml, checklistLineHtml } from '../src/verify/checklist.ts';
import { callTree } from '../src/verify/expected.ts';
import { verdictPage } from '../src/verify/page.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
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
  return { tree: callTree(tx, { registry, safe: tx.safe, card: resolved, templates, addressBook, decimals }), card: resolved };
}

const ethPayee = String(recordedTx('eth-transfer-null-data').service.to).toLowerCase() as Address;
const PINNED: readonly { readonly fixture: string; readonly card: Card; readonly book?: Record<string, Address> }[] = [
  { fixture: FIXTURE, card: CARD },
  { fixture: 'eth-transfer-null-data', card: { operations: [{ template: 'eth/transfer', values: { amount: String(recordedTx('eth-transfer-null-data').service.value), recipient: 'payee' } }] }, book: { payee: ethPayee } },
  { fixture: 'merkl-claim-two-tokens', card: { operations: [{ template: 'merkl/claim', values: { token: 'usdc' } }, { template: 'merkl/claim', values: { token: 'morpho' } }] } },
];

for (const { fixture, card, book } of PINNED) {
  test(`the 比對清單 of ${fixture} is, byte for byte, the block check.sh writes for it, names aside`, () => {
    const { tree } = treeOf(card, fixture, book);
    const ours = `${checklistHtml(checklist(tree)).replace(/<span class="nm">[^<]*<\/span>/g, '')}\n`;
    const theirs = readFileSync(join(ROOT, 'testdata', 'checklist', `${fixture}.checklist.html`), 'utf8');
    assert.equal(ours, theirs);
  });
}

test('a row value from outside is escaped as jq @html escapes it, and characters that hide or reorder text are replaced', () => {
  const line = checklistLineHtml({ kind: 'row', id: 'C1-a1', key: '引數 1', value: '"><img src=x onerror=alert(1)><script>\u202eevil\u200f\u0007', name: "it's\u2066" });
  assert.equal(
    line,
    '<div class="r"><span class="id">C1-a1</span><span class="k">引數 1</span><span class="v">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;�evil��</span><span class="nm">it&apos;s�</span></div>',
  );
});

test('a long value folds to its length and keccak256, with the full text inside a closed details element', () => {
  const bytes = checklistLineHtml({ kind: 'row', id: 'C1-data', key: 'data', value: `0x${'ab'.repeat(33)}`, name: '' });
  assert.match(bytes, /<details><summary>33 bytes，keccak256 0x[0-9a-f]{64}<\/summary><span class="full">0x(ab){33}<\/span><\/details>/);
  const exact = checklistLineHtml({ kind: 'row', id: 'C1-a1', key: '引數 1', value: `0x${'ab'.repeat(32)}`, name: '' });
  assert.doesNotMatch(exact, /<details>/);
  const text = checklistLineHtml({ kind: 'row', id: 'C1-a1', key: '引數 1', value: `[${'1, '.repeat(40)}1]`, name: '' });
  assert.match(text, /<summary>123 字元，keccak256 0x[0-9a-f]{64}<\/summary>/);
});

test('the verify page holds no script, loads nothing, and shows text from a cause as inert text', () => {
  const { tree, card } = treeOf(CARD);
  const page = verdictPage({
    verdict: { kind: 'MISMATCH', causes: [{ check: 'effects', details: ['<script>alert(1)</script> "><img src=x onerror=alert(1)> \u202eevil'] }] },
    nonce: tree.nonce,
    card,
    cardHash: `0x${'00'.repeat(32)}`,
    registry,
    expected: { kind: 'expected', changes: new Map() },
    calls: { kind: 'scanned', movesNothing: [] },
    tree: undefined,
    verdictFile: '/verdicts/x.json',
  });
  assert.match(page, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
  assert.doesNotMatch(page, /<script|<img|<link|\u202e/i);
  assert.match(page, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/);
  assert.match(page, /不顯示任何 hash。不要簽這筆交易。/);
});

test('when the simulation could not run, the page does not show the checks that read it as passed', () => {
  const { tree, card } = treeOf(CARD);
  const page = verdictPage({
    verdict: { kind: 'UNVERIFIABLE', causes: [{ check: 'simulation', details: ['no agreed block'] }] },
    nonce: tree.nonce,
    card,
    cardHash: `0x${'00'.repeat(32)}`,
    registry,
    expected: { kind: 'expected', changes: new Map() },
    calls: { kind: 'unverifiable', reasons: ['no agreed block'] },
    tree: undefined,
    verdictFile: '/verdicts/x.json',
  });
  const state = (name: string) => new RegExp(`aria-label="([^"]+)"><use href="#[a-z]+"/></svg>${name}</li>`).exec(page)?.[1];
  assert.equal(state('模擬'), '注意');
  assert.equal(state('模擬後的底線規則'), '沒資料可比');
  assert.equal(state('Safe 的資產變化符合卡片'), '沒資料可比');
  assert.equal(state('每個欄位符合模板和卡片'), '通過');
});

test('format characters, tag characters and variation selectors become U+FFFD too', () => {
  const hidden = [0xad, 0x34f, 0x115f, 0x180e, 0x2028, 0x206a, 0x3164, 0xfe0f, 0xffa0, 0xfffb, 0xe0041, 0xe0100].map((c) => String.fromCodePoint(c)).join('');
  const line = checklistLineHtml({ kind: 'row', id: 'C1-a1', key: '引數 1', value: `a${hidden}b`, name: '' });
  assert.match(line, new RegExp(`<span class="v">a${'\ufffd'.repeat(12)}b</span>`, 'u'));
});
