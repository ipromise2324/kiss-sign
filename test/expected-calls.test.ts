import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { checklist } from '../src/verify/checklist.ts';
import { callTree } from '../src/verify/expected.ts';
import type { CallTree } from '../src/verify/expected.ts';
import { evaluateTx } from '../src/verify/verify.ts';
import type { VerdictFile } from '../src/verify/verify.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const ROOT = repoWithTestFixtures();
const load = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));
const registry = loadRegistry(ROOT);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address;
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7' as Address;
const DECIMALS = new Map([
  [USDC, 6],
  [USDT, 6],
]);

function shown(fixture: string, card: Card, book: Record<string, Address> = {}): { tree: CallTree; text: string } {
  const recorded = load('safe-tx', fixture);
  const tx = parseServiceTx(recorded.service, { chainId: 1n, version: recorded.chain.version });
  const templates = new Map<string, Template>(card.operations.map((op) => [op.template, loadTemplate(ROOT, op.template, registry)]));
  const addressBook = new Map(Object.entries(book));
  const resolution = resolveCard(card, { templates, registry, addressBook, safe: tx.safe });
  assert.equal(resolution.kind, 'resolved');
  const resolved = (resolution as Extract<typeof resolution, { kind: 'resolved' }>).card;
  assert.deepEqual(checkTemplateFields(tx, resolved, templates, registry), { kind: 'match' });
  const tree = callTree(tx, { registry, safe: tx.safe, card: resolved, templates, addressBook, decimals: DECIMALS });
  assert.equal(tree.hashes.safeTxHash, recorded.service.safeTxHash.toLowerCase());
  return { tree, text: rowsText(tree) };
}

const rowsText = (tree: CallTree): string =>
  checklist(tree, 'zh-TW')
    .map((line) => (line.kind === 'group' ? `[${line.id}] ${line.title}` : `${line.id} ${line.value} | ${line.name}`))
    .join('\n');

const numbers = (text: string) => [...text.matchAll(/\] 呼叫 #(\d+)/g)].map((m) => Number(m[1]));
const selectors = (text: string) => [...text.matchAll(/-fn \S+ (0x[0-9a-f]{8}) /g)].map((m) => m[1]);
const targets = (text: string) => [...text.matchAll(/-to (0x[0-9a-fA-F]{40})/g)].map((m) => m[1]!.toLowerCase());

test('a MultiSend of two calls is numbered #1 for the MultiSend, then #2 and #3, as check.sh numbers it', () => {
  const { tree, text } = shown('fluid-deposit-usdt-other-safe', { operations: [{ template: 'fluid/vault-deposit', values: { vault: 'fluid-fusdt', amount: '150003888850' } }] });
  assert.equal(tree.count, 3);
  assert.deepEqual(numbers(text), [1, 2, 3]);
  assert.deepEqual(selectors(text), ['0x8d80ff0a', '0x095ea7b3', '0x6e553f65']);
  assert.deepEqual(targets(text), ['0x9641d764fc13c8b624c04430c7356c1c7c8102e2', USDT, '0x5c20b550819128074fd538edf79791733ccedd18']);
  assert.match(text, /\nC1-op 1 DELEGATECALL \| \n/);
  assert.match(text, /\nC2-a2 150003888850 \| = 150003\.88885 usdt\n/);
  assert.match(text, /\nC3-a2 0x93BD8C5eb0eAB5BE7BfE156Ebfa0887AE7Dd0CEb \| 本 Safe\n/);
  assert.match(text, /\nend-count 3 \| $/);
});

test('a plain ERC-20 transfer is call #1 only', () => {
  const recorded = load('safe-tx', 'erc20-transfer-usdc');
  const data = String(recorded.service.data).slice(2);
  const recipient = `0x${data.slice(32, 72)}` as Address;
  const amount = BigInt(`0x${data.slice(72, 136)}`);
  const { tree, text } = shown('erc20-transfer-usdc', { operations: [{ template: 'erc20/transfer', values: { token: 'usdc', amount: `${amount}`, recipient: 'payee' } }] }, { payee: recipient });
  assert.equal(tree.count, 1);
  assert.deepEqual(numbers(text), [1]);
  assert.deepEqual(selectors(text), ['0xa9059cbb']);
  assert.deepEqual(targets(text), [USDC]);
  assert.match(text, new RegExp(`\\nC1-a2 ${amount} \\| = [0-9.]+ usdc\\n`));
  assert.match(text, /\nC1-a1 0x[0-9a-fA-F]{40} \| payee（地址簿）\n/);
});

test('an ETH transfer shows its value in wei and no data', () => {
  const recorded = load('safe-tx', 'eth-transfer-null-data');
  const { service } = recorded;
  const { tree, text } = shown('eth-transfer-null-data', { operations: [{ template: 'eth/transfer', values: { amount: service.value, recipient: 'payee' } }] }, { payee: service.to.toLowerCase() });
  assert.equal(tree.count, 1);
  assert.match(text, new RegExp(`\\nC1-value ${service.value} \\| \\nC1-op 0 CALL \\| \\nC1-data 無 \\| \\n`));
  assert.deepEqual(selectors(text), []);
});

test('a Bundler3 deposit lists its bundle calls and the trailers the template allows', () => {
  const { tree, text } = shown('morpho-deposit-approve-trailer-other-safe', {
    operations: [{ template: 'morpho/vault-deposit', values: { vault: 'hyperithm-usdc-apex-v1-7777', amount: '10001000000', 'min-shares': '9482917730630123475126' } }],
  });
  assert.equal(tree.count, 3);
  assert.deepEqual(numbers(text), [1, 2, 3]);
  assert.deepEqual(selectors(text), ['0x8d80ff0a', '0x095ea7b3', '0x374f435d', '0xd96ca0b9', '0x6ef5eeae']);
  assert.match(text, /\nC2-extra 0x6915469b25afea44 \| 模板允許這個呼叫最多 12 bytes，這裡 8 bytes，在範圍內\n/);
  assert.match(text, /\nC3-extra 0x6915469b25afea44 \| 模板允許這個呼叫最多 12 bytes，這裡 8 bytes，在範圍內\n/);
  assert.match(text, /\n\[C3\.1\] Bundler3 呼叫 1\/2\nC3\.1-to 0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0 \| general-adapter-1\nC3\.1-value 0 \| \n/);
  assert.match(text, /\n\[C3\.2\] Bundler3 呼叫 2\/2\n/);
  assert.match(text, /\nC3\.2-a3 1054633213541066 \| 每股價格上限\n/);
  assert.equal(text.match(/ 10001000000 \| = 10001 usdc/g)?.length, 3);
});

test('a Merkl claim of two tokens is one call with its arrays as cast prints them', () => {
  const { tree, text } = shown('merkl-claim-two-tokens', {
    operations: [
      { template: 'merkl/claim', values: { token: 'usdc' } },
      { template: 'merkl/claim', values: { token: 'morpho' } },
    ],
  });
  assert.equal(tree.count, 1);
  assert.deepEqual(selectors(text), ['0x71ee95c0']);
  assert.match(text, /\nC1-a2 \[0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 0x58D97B57BB95320F9a05dC918Aef65434969c2B2\] \| \n/);
  assert.match(text, /\nC1-a3 \[2430942374, 9032856318714151091\] \| \n/);
});

test('the recorded migration verify judged to MATCH shows the transaction it judged', async () => {
  const recorded: VerdictFile = load('verify', 'morpho-migrate-all');
  const { evaluation, tx, prepared } = await evaluateTx(recorded.inputs, replayReader(recorded.exchanges));
  assert.equal(evaluation.verdict.kind, 'MATCH');
  const tree = callTree(tx, { ...prepared, decimals: new Map() });
  const text = rowsText(tree);
  assert.deepEqual(tree.hashes, evaluation.hashes);
  assert.equal(tree.nonce, tx.nonce);
  assert.equal(tree.count, 3);
  assert.deepEqual(numbers(text), [1, 2, 3]);
  assert.deepEqual(selectors(text), ['0x8d80ff0a', '0x095ea7b3', '0x374f435d', '0xd96ca0b9', '0xa7f6e606', '0x6ef5eeae']);
  assert.deepEqual([...text.matchAll(/\] Bundler3 呼叫 (\d\/\d)/g)].map((m) => m[1]), ['1/3', '2/3', '3/3']);
  assert.match(text, /\nC3-extra 0x69f5ccb925afea44 \| 模板允許這個呼叫最多 8 bytes，這裡 8 bytes，在範圍內\n/);
  assert.doesNotMatch(text, /沒有範本可以解碼/);
});

test('a call no template decodes is shown as raw data', () => {
  const recorded = load('safe-tx', 'erc20-transfer-usdc');
  const tx = parseServiceTx(recorded.service, { chainId: 1n, version: recorded.chain.version });
  const tree = callTree(tx, { registry, safe: tx.safe, card: { safe: tx.safe, operations: [] }, templates: new Map(), addressBook: new Map(), decimals: DECIMALS });
  assert.match(rowsText(tree), new RegExp(`\\nC1-data ${String(recorded.service.data).toLowerCase()} \\| 沒有範本可以解碼\\n`));
});
