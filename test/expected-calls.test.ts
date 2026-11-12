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
import { callTree, renderCallTree } from '../src/verify/expected.ts';
import type { CallTree } from '../src/verify/expected.ts';
import { evaluateTx } from '../src/verify/verify.ts';
import type { VerdictFile } from '../src/verify/verify.ts';

const ROOT = join(import.meta.dirname, '..');
const load = (dir: string, name: string) => JSON.parse(readFileSync(join(ROOT, 'testdata', dir, `${name}.json`), 'utf8'));
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
  assert.equal(tree.safeTxHash, recorded.service.safeTxHash.toLowerCase());
  return { tree, text: renderCallTree(tree).join('\n') };
}

const numbers = (text: string) => [...text.matchAll(/── 呼叫 #(\d+)/g)].map((m) => Number(m[1]));
const selectors = (text: string) => [...text.matchAll(/cast sig = (0x[0-9a-f]{8})/g)].map((m) => m[1]);
const targets = (text: string) => [...text.matchAll(/to: +(0x[0-9a-fA-F]{40})/g)].map((m) => m[1]!.toLowerCase());

test('a MultiSend of two calls is numbered #1 for the MultiSend, then #2 and #3, as check.sh numbers it', () => {
  const { tree, text } = shown('fluid-deposit-usdt-other-safe', { operations: [{ template: 'fluid/vault-deposit', values: { vault: 'fluid-fusdt', amount: '150003888850' } }] });
  assert.equal(tree.count, 3);
  assert.deepEqual(numbers(text), [1, 2, 3]);
  assert.deepEqual(selectors(text), ['0x8d80ff0a', '0x095ea7b3', '0x6e553f65']);
  assert.deepEqual(targets(text), ['0x9641d764fc13c8b624c04430c7356c1c7c8102e2', USDT, '0x5c20b550819128074fd538edf79791733ccedd18']);
  assert.match(text, /operation: 1 DELEGATECALL（官方 MultiSend）\n/);
  assert.match(text, /\n {10}引數 2: {2}150003888850 {2}（= 150003\.88885 usdt）\n/);
  assert.match(text, /\n {10}引數 2: {2}0x93BD8C5eb0eAB5BE7BfE156Ebfa0887AE7Dd0CEb\n {10}地址: 0x93BD8C5eb0eAB5BE7BfE156Ebfa0887AE7Dd0CEb {2}本 Safe\n/);
  assert.match(text, /\n呼叫數: 3$/);
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
  assert.match(text, new RegExp(`引數 2: {2}${amount} {2}（= [0-9.]+ usdc）\\n`));
  assert.match(text, /地址: 0x[0-9a-fA-F]{40} {2}payee（地址簿）\n/);
});

test('an ETH transfer shows its value in wei and no data', () => {
  const recorded = load('safe-tx', 'eth-transfer-null-data');
  const { service } = recorded;
  const { tree, text } = shown('eth-transfer-null-data', { operations: [{ template: 'eth/transfer', values: { amount: service.value, recipient: 'payee' } }] }, { payee: service.to.toLowerCase() });
  assert.equal(tree.count, 1);
  assert.match(text, new RegExp(`value: {5}${service.value} wei（4\\.988797943068499801 ETH）\\n {3}operation: 0 CALL\\n {3}data: {6}無（只轉 ETH）\\n`));
  assert.deepEqual(selectors(text), []);
});

test('a Bundler3 deposit lists its bundle calls and the trailers the template allows', () => {
  const { tree, text } = shown('morpho-deposit-approve-trailer-other-safe', {
    operations: [{ template: 'morpho/vault-deposit', values: { vault: 'hyperithm-usdc-apex-7777', amount: '10001000000', 'min-shares': '9482917730630123475126' } }],
  });
  assert.equal(tree.count, 3);
  assert.deepEqual(numbers(text), [1, 2, 3]);
  assert.deepEqual(selectors(text), ['0x8d80ff0a', '0x095ea7b3', '0x374f435d', '0xd96ca0b9', '0x6ef5eeae']);
  assert.match(text, /注意: 呼叫 #2 的資料在引數之後多出 8 bytes: 0x6915469b25afea44\n/);
  assert.match(text, /注意: 呼叫 #3 的資料在引數之後多出 8 bytes: 0x6915469b25afea44\n/);
  assert.match(text, /── Bundler3 呼叫 1\/2\n {13}to: {4}0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0 {2}general-adapter1\n {13}value: 0 wei\n/);
  assert.match(text, /── Bundler3 呼叫 2\/2\n/);
  assert.match(text, /引數 3: {2}1054633213541066\n/);
  assert.equal(text.match(/10001000000 {2}（= 10001 usdc）/g)?.length, 3);
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
  assert.match(text, /引數 2: {2}\[0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 0x58D97B57BB95320F9a05dC918Aef65434969c2B2\]\n/);
  assert.match(text, /引數 3: {2}\[2430942374, 9032856318714151091\]\n/);
});

test('the recorded migration verify judged to MATCH shows the transaction it judged', async () => {
  const recorded: VerdictFile = load('verify', 'morpho-migrate-all');
  const { evaluation, tx, prepared } = await evaluateTx(recorded.inputs, replayReader(recorded.exchanges));
  assert.equal(evaluation.verdict.kind, 'MATCH');
  const tree = callTree(tx, { ...prepared, decimals: new Map() });
  const text = renderCallTree(tree).join('\n');
  assert.equal(tree.safeTxHash, evaluation.hashes.safeTxHash);
  assert.equal(tree.nonce, tx.nonce);
  assert.equal(tree.count, 3);
  assert.deepEqual(numbers(text), [1, 2, 3]);
  assert.deepEqual(selectors(text), ['0x8d80ff0a', '0x095ea7b3', '0x374f435d', '0xd96ca0b9', '0xa7f6e606', '0x6ef5eeae']);
  assert.deepEqual([...text.matchAll(/── Bundler3 呼叫 (\d\/\d)/g)].map((m) => m[1]), ['1/3', '2/3', '3/3']);
  assert.match(text, /注意: 呼叫 #3 的資料在引數之後多出 8 bytes: 0x69f5ccb925afea44\n/);
  assert.doesNotMatch(text, /沒有範本可以解碼/);
});

test('a call no template decodes is shown as raw data', () => {
  const recorded = load('safe-tx', 'erc20-transfer-usdc');
  const tx = parseServiceTx(recorded.service, { chainId: 1n, version: recorded.chain.version });
  const tree = callTree(tx, { registry, safe: tx.safe, card: { safe: tx.safe, operations: [] }, templates: new Map(), addressBook: new Map(), decimals: DECIMALS });
  assert.match(renderCallTree(tree).join('\n'), new RegExp(`data: {6}${String(recorded.service.data).toLowerCase()}\\n {5}注意: 這段資料沒有範本可以解碼\\n`));
});
