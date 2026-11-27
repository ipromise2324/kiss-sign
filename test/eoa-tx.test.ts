import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Reader } from '../src/chain/reader.ts';
import type { SimulationRequest } from '../src/chain/types.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { simulateTx } from '../src/simulate/simulate.ts';
import { judgeFixtures } from '../src/template/perturb.ts';
import { loadRecordedTx } from '../src/template/recorded-tx.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { baseRepo, tempDir } from './repo-with-test-fixtures.ts';
import { runOffline } from './run-offline.ts';

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'eoa');
const EOA_TXS = join(FIXTURES, 'safe-tx');
const TRANSFER = 'erc20-transfer-usdc-eoa';
const SWAP = 'uniswap-swap-usdt-eoa';
const SENDER = '0xf379753004d6f4df2e1adf7fb6898dc4479b95f0';
const TRANSFER_CARD = '{"operations":[{"template":"erc20/transfer","values":{"token":"usdc","amount":"5020000","recipient":"recipient"}}]}';
const TRANSFER_BOOK = '{"recipient":"0xf1d7b495371956bd07cadf1b8d85461c5a88866e"}';

type Captured = { readonly transaction: string; readonly exchanges: readonly Exchange[] };
const captured = readRecording<Captured>(join(FIXTURES, 'record-eoa-tx.json'));

/** The captured answers with `edit` applied to both providers' answer to each request of `method`. */
function editedAnswers(method: string, edit: (answer: Record<string, unknown>) => Record<string, unknown>, from: Captured = captured): Captured {
  const exchanges = from.exchanges.map((e) =>
    e.method === method ? { ...e, answers: Object.fromEntries(Object.entries(e.answers).map(([p, a]) => [p, edit(a as Record<string, unknown>)])) } : e,
  );
  return { ...from, exchanges };
}

/** Runs `script` offline with the EOA's recorded transactions as the only `testdata/safe-tx` fixtures. */
const withEoaTxs = (script: string, args: readonly string[], network: { readonly exchanges: readonly Exchange[] }) =>
  runOffline(script, args, 'safe-tx', network, [`${TRANSFER}.json`, `${SWAP}.json`], undefined, EOA_TXS, baseRepo());

test("record-eoa-tx writes the EOA's call, block and providers as both providers agree on them", () => {
  const run = runOffline('record-eoa-tx.ts', ['offline', captured.transaction], 'safe-tx', captured);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.written, ['offline.json']);
  assert.match(run.stdout, new RegExp(`${SENDER}'s call to 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 at block 26500064, agreed by alchemy and drpc`));
});

test('record-eoa-tx writes nothing when the recording mentions the configured Safe, when a read gets no answer, or for a bad name', () => {
  const configured = runOffline('record-eoa-tx.ts', ['offline', captured.transaction], 'safe-tx', captured, [], { chainId: 1, safe: SENDER });
  assert.equal(configured.status, 1);
  assert.match(configured.stderr, /the recording mentions the configured Safe; nothing written/);
  assert.deepEqual(configured.written, []);
  const unanswered = runOffline('record-eoa-tx.ts', ['offline', captured.transaction], 'safe-tx', { exchanges: captured.exchanges.filter((e) => e.method !== 'eth_getCode') });
  assert.equal(unanswered.status, 1);
  assert.deepEqual(unanswered.written, []);
  const named = runOffline('record-eoa-tx.ts', [`a-${SENDER.slice(2)}`, captured.transaction], 'safe-tx', captured, [], { chainId: 1, safe: SENDER });
  assert.match(named.stderr, /the name mentions the configured Safe; nothing written/);
  assert.deepEqual(named.written, []);
  for (const args of [['Offline', captured.transaction], ['offline'], ['offline', captured.transaction, 'more'], ['offline', '0x1234']]) {
    const refused = runOffline('record-eoa-tx.ts', args, 'safe-tx', { exchanges: [] });
    assert.match(refused.stderr, /^usage: pnpm record-eoa-tx <name> <transaction hash>/, args.join(' '));
    assert.deepEqual(refused.written, []);
  }
});

test('record-eoa-tx refuses an EIP-7702 transaction, a receipt of another block, a call to the sender itself, and a header that does not hash to its block', () => {
  const cases: [string, Captured, RegExp][] = [
    ['type 4', editedAnswers('eth_getTransactionByHash', (a) => ({ ...a, type: '0x4' })), /an EIP-7702 one/],
    ['an authorization list', editedAnswers('eth_getTransactionByHash', (a) => ({ ...a, authorizationList: [{}] })), /an EIP-7702 one/],
    ['an unknown type', editedAnswers('eth_getTransactionByHash', (a) => ({ ...a, type: '0x7f' })), /type 0x7f, not legacy/],
    ['another block', editedAnswers('eth_getTransactionReceipt', (a) => ({ ...a, blockHash: `0x${'11'.repeat(32)}` })), /disagree on its block, sender or target/],
    ['a target only its receipt names', editedAnswers('eth_getTransactionByHash', (a) => ({ ...a, to: SENDER })), /disagree on its block, sender or target/],
    ['itself', editedAnswers('eth_getTransactionReceipt', (a) => ({ ...a, to: SENDER }), editedAnswers('eth_getTransactionByHash', (a) => ({ ...a, to: SENDER }))), /a call of the sender to itself/],
    ['a changed header', editedAnswers('eth_getBlockByHash', (a) => ({ ...a, timestamp: '0x1' })), /does not hash to the block hash its receipt names/],
  ];
  for (const [what, network, refusal] of cases) {
    const run = runOffline('record-eoa-tx.ts', ['offline', captured.transaction], 'safe-tx', network);
    assert.equal(run.status, 1, what);
    assert.match(run.stderr, refusal, what);
    assert.deepEqual(run.written, [], what);
  }
});

test("template implied-card checks an EOA's recorded call with the EOA as the Safe and gives MATCH", () => {
  const run = withEoaTxs('template.ts', ['implied-card', 'erc20/transfer', TRANSFER], { exchanges: [] });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(
    run.stdout,
    `${TRANSFER}: an EOA's transaction, its call checked with safe the EOA ${SENDER}\n  card ${TRANSFER_CARD}\n  book ${TRANSFER_BOOK}\n  MATCH  judged at block 26500064, time 1795704407\n`,
  );
});

const transferSimulation = readRecording<{ exchanges: Exchange[] }>(join(FIXTURES, 'simulate', `${TRANSFER}.json`));

test("simulate runs an EOA's recorded call as its own, judges its effects MATCH, and never passes the floor on Safe settings it cannot read", () => {
  const run = withEoaTxs('simulate.ts', [TRANSFER, '--card', TRANSFER_CARD, '--book', TRANSFER_BOOK], transferSimulation);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^simulated as the EOA's own call at block 26500063\n {2}ETH 0\n {2}usdc -5020000\n {2}safe settings: not read, an EOA sent the transaction\n {2}simulated floor REFUSED\n {4}safe-state: an EOA sent the transaction, so no Safe's settings were read\n {2}effects MATCH$/m);
  assert.match(run.stdout, /from the receipt of 0x035f99bb[0-9a-f]{56}: effects not read, since the EOA paid gas and may have sent other transactions in the block; its logs match the simulation in address and topics/);
  assert.doesNotMatch(run.stdout, /nonce \d|verdict/);
});

test("simulate gives UNVERIFIABLE when an EOA's simulated call emits other logs than its receipt holds", () => {
  const exchanges = transferSimulation.exchanges.map((e) =>
    e.method === 'eth_getTransactionReceipt'
      ? { ...e, answers: Object.fromEntries(Object.entries(e.answers).map(([p, a]) => [p, { ...(a as object), logs: [] }])) }
      : e,
  );
  const run = withEoaTxs('simulate.ts', [TRANSFER, '--card', TRANSFER_CARD, '--book', TRANSFER_BOOK], { exchanges });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^simulated as the EOA's own call at block 26500063\n {2}UNVERIFIABLE: the simulated call is not the one its receipt records: log 0 of the 1 it emitted differs in address or topics from the receipt's 0$/m);
  assert.match(run.stdout, /its logs differ from the simulation/);
});

test("simulate refuses a card whose template an EOA's transaction cannot test", () => {
  const run = withEoaTxs('simulate.ts', [TRANSFER, '--card', '{"operations":[{"template":"safe/add-owner","values":{"owner":"0x0000000000000000000000000000000000000001","threshold":"1"}}]}'], transferSimulation);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /safe\/add-owner changes the Safe's settings, which an EOA does not have/);
});

/** A copy of the repository whose only perturb recording is the EOA's swap. */
function rootWithEoaPerturbation(): string {
  const root = tempDir('kiss-sign-eoa-');
  for (const dir of ['templates', 'registry']) cpSync(join(baseRepo(), dir), join(root, dir), { recursive: true });
  mkdirSync(join(root, 'testdata', 'perturb'), { recursive: true });
  cpSync(EOA_TXS, join(root, 'testdata', 'safe-tx'), { recursive: true });
  copyFileSync(join(FIXTURES, 'perturb', `${SWAP}.json`), join(root, 'testdata', 'perturb', `${SWAP}.json`));
  return root;
}

test("perturb changes each free field of an EOA's recorded swap and passes, from its recording", () => {
  const recording = readRecording<{ card: unknown; exchanges: Exchange[] }>(join(FIXTURES, 'perturb', `${SWAP}.json`));
  const run = withEoaTxs('perturb.ts', [SWAP, '--card', JSON.stringify(recording.card)], recording);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^${SWAP} \\(an EOA's transaction\\): every free field changed, simulated on block 26479665 by alchemy and drpc$`, 'm'));
  assert.match(run.stdout, /^PASS$/m);
});

test("the report's judgement of an EOA's recording names its sender, and refuses a template that binds the Safe's nonce or changes its settings", async () => {
  const root = rootWithEoaPerturbation();
  const registry = loadRegistry(root);
  const template = loadTemplate(root, 'uniswap/swap', registry);
  const [judged] = await judgeFixtures(root, template, registry);
  assert.equal(judged?.sender, 'eoa');
  assert.equal(judged?.outcome.kind === 'judged' && judged.outcome.perturbation.kind, 'pass');
  const withNonce = { ...template, nonce: { kind: 'card', field: 'nonce' } } as unknown as Template;
  const [refused] = await judgeFixtures(root, withNonce, registry);
  assert.deepEqual(refused, { name: SWAP, sender: 'eoa', outcome: { kind: 'card-refused', why: "uniswap/swap binds the Safe's nonce, which an EOA's transaction does not have" } });
  const withSettings = { ...template, effects: { ...template.effects, safe: { add: undefined, remove: undefined, threshold: { field: 'threshold' } } } } as unknown as Template;
  const [settings] = await judgeFixtures(root, withSettings, registry);
  assert.deepEqual(settings, { name: SWAP, sender: 'eoa', outcome: { kind: 'card-refused', why: "uniswap/swap changes the Safe's settings, which an EOA does not have" } });
});

const EOA = SENDER as Address;
const TARGET = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address;

/** A reader whose every simulated call reverts, keeping each request it was sent. */
function revertingReader(): { reader: Reader; requests: SimulationRequest[] } {
  const requests: SimulationRequest[] = [];
  const reader = {
    providers: ['alchemy', 'drpc'],
    simulateV1: async (request: SimulationRequest) => {
      requests.push(request);
      return { kind: 'agreed', value: request.calls.map(() => ({ status: 'reverted', returnData: '0x', logs: [] })), providers: ['alchemy', 'drpc'] };
    },
  } as unknown as Reader;
  return { reader, requests };
}

const PARENT = { number: 1n, hash: `0x${'22'.repeat(32)}` as Hex, time: 12n, gasLimit: 30_000_000n, mixHash: `0x${'33'.repeat(32)}` as Hex };
const eoaCall = (value: bigint, to = TARGET): SafeTx => ({
  ...loadRecordedTx(ROOT, 'erc20-transfer-usdc').tx,
  safe: EOA,
  to,
  value,
  data: '0xa9059cbb' as Hex,
  operation: 0,
});

test("an EOA's call without ETH is sent from the EOA itself, with no code put at it, and its revert is the call's own", async () => {
  const { reader, requests } = revertingReader();
  const observation = await simulateTx('eoa', reader, { tx: eoaCall(0n), parent: PARENT, time: 13n, watch: [], ends: [] });
  assert.deepEqual(observation, { kind: 'observed', observed: { kind: 'not-executed', why: 'reverted' }, logs: [] });
  assert.deepEqual(requests[0]?.calls.map(({ from, to }) => [from, to]), [[EOA, TARGET]]);
  assert.equal(requests[0]?.stateOverrides[EOA], undefined);
});

test("an EOA's call that sends ETH runs through a forwarder at the EOA, so its revert is unverifiable; a call to itself is not simulated", async () => {
  const { reader, requests } = revertingReader();
  const observation = await simulateTx('eoa', reader, { tx: eoaCall(1n), parent: PARENT, time: 13n, watch: [], ends: [] });
  assert.equal(observation.kind, 'unverifiable');
  assert.match(observation.kind === 'unverifiable' ? observation.reasons.join() : '', /forwarder that gives the EOA code a contract may read/);
  assert.notEqual(requests[0]?.stateOverrides[EOA]?.code, undefined);
  const itself = await simulateTx('eoa', reader, { tx: eoaCall(0n, EOA), parent: PARENT, time: 13n, watch: [], ends: [] });
  assert.deepEqual(itself, { kind: 'unverifiable', reasons: ["an EOA's call to itself is not simulated"] });
});

test('a Safe fixture keeps reading as a Safe transaction', () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', 'erc20-transfer-usdc.json'), 'utf8')) as { sender?: unknown };
  assert.equal(fixture.sender, undefined);
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'template.ts'), 'implied-card', 'erc20/transfer', 'erc20-transfer-usdc'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(run.stdout, /^erc20-transfer-usdc:\n/);
});
