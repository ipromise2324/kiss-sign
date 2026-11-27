import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import type { Exchange } from '../src/chain/recording.ts';
import type { AbiCase } from '../src/contracts/abi-case.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { withBlockTimes } from './block-times.ts';
import { SUMMARY_FIXTURES, runOffline } from './run-offline.ts';
import type { Http, Run } from './run-offline.ts';

const ROOT = join(import.meta.dirname, '..');
const REFUSAL = /^\d+ read\(s\) got no answer after every retry, so nothing is recorded; run the command again later:$/;

/** The exchanges with every drpc answer to a request of `method` taken out, so drpc gives those reads no answer. */
const withheld = (exchanges: readonly Exchange[], method: string): Exchange[] =>
  exchanges.map((e) => {
    if (e.method !== method) return e;
    const drop = <T>(byProvider: Partial<Record<string, T>> | undefined) => Object.fromEntries(Object.entries(byProvider ?? {}).filter(([provider]) => provider !== 'drpc'));
    return { ...e, answers: drop(e.answers), errors: drop(e.errors), statuses: drop(e.statuses) };
  });

function assertRecorded(run: Run, file: string): void {
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.deepEqual(run.written, [file]);
}

function assertRefused(run: Run, read: string, prefix = ''): void {
  assert.equal(run.status, 1, run.stderr + run.stdout);
  assert.ok(run.stderr.split('\n').some((line) => line.startsWith(prefix) && REFUSAL.test(line.slice(prefix.length))), run.stderr);
  assert.ok(run.stderr.split('\n').includes(`  ${read}`), run.stderr);
  assert.deepEqual(run.written, []);
}

/** For a command that stops at a read with no answer before it reaches --record. */
function assertStopped(run: Run, why: RegExp): void {
  assert.equal(run.status, 1, run.stderr + run.stdout);
  assert.match(run.stdout + run.stderr, why);
  assert.deepEqual(run.written, []);
}

test('perturb --record writes the recording when every read is answered, and nothing when a read gets no answer', () => {
  const recording = readRecording<{ safeTx: string; card: unknown; exchanges: Exchange[] }>(join(ROOT, 'testdata', 'perturb', 'fluid-deposit-fusdc.json'));
  const args = [recording.safeTx, '--card', JSON.stringify(recording.card), '--record', 'offline'];
  assertRecorded(runOffline('perturb.ts', args, 'perturb', recording), 'offline.json');
  assertRefused(runOffline('perturb.ts', args, 'perturb', { exchanges: withheld(recording.exchanges, 'eth_simulateV1') }), 'drpc eth_simulateV1: unreachable');
});

test('simulate --record writes the recording when every read is answered, and nothing when a read gets no answer', () => {
  const recording = readRecording<{ safeTx: string; exchanges: Exchange[] }>(join(ROOT, 'testdata', 'simulate', 'safe-add-owner-1-3-0.json'));
  const args = [recording.safeTx, '--record', 'offline'];
  assertRecorded(runOffline('simulate.ts', args, 'simulate', recording), 'offline.json');
  assertRefused(runOffline('simulate.ts', args, 'simulate', { exchanges: withheld(recording.exchanges, 'eth_simulateV1') }), 'drpc eth_simulateV1: unreachable');
});

test('past-txs --record writes the study when every read is answered, and nothing when a read gets no answer', () => {
  const name = 'morpho-vault-deposit-windows';
  const recording = readRecording<PastTxsRecording>(join(ROOT, 'testdata', 'past-txs', `${name}.json`));
  const transfers: Exchange[] = [];
  const http: Http = {};
  for (const { request, answer } of recording.sources) {
    if (request.source === 'alchemy') transfers.push({ method: 'alchemy_getAssetTransfers', params: [request.params], answers: { alchemy: answer } });
    else http[new URL(`https://api.etherscan.io/v2/api?${new URLSearchParams(request.query)}`).href] = { status: 200, text: JSON.stringify(answer) };
  }
  const args = ['morpho/vault-deposit', '--token', 'steakhouse-prime-usdc-v2-0f51', '--anchor', 'mint', '--max-txs', '24', '--same-windows-as', name, '--record', 'offline'];
  const seed = [`${name}.json`];
  assertRecorded(runOffline('past-txs.ts', args, 'research', { exchanges: [...withBlockTimes(recording.exchanges), ...transfers], http }, seed, undefined, SUMMARY_FIXTURES), 'offline.json');
  const network = { exchanges: [...withheld(withBlockTimes(recording.exchanges), 'eth_getTransactionByHash'), ...transfers], http };
  assertRefused(runOffline('past-txs.ts', args, 'research', network, seed, undefined, SUMMARY_FIXTURES), 'drpc eth_getTransactionByHash: unreachable');
  const noBlocks = { exchanges: [...withheld(withBlockTimes(recording.exchanges), 'eth_getBlockByNumber'), ...transfers], http };
  assertRefused(runOffline('past-txs.ts', args, 'research', noBlocks, seed, undefined, SUMMARY_FIXTURES), 'drpc eth_getBlockByNumber: unreachable');
});

test('past-txs --record of a template reported per vault refuses a search anchored on no registry entry before any read', () => {
  const args = ['morpho/vault-deposit', '--token', `0x${'7e'.repeat(20)}`, '--anchor', 'mint', '--record', 'offline'];
  const run = runOffline('past-txs.ts', args, 'research', { exchanges: [] });
  assert.equal(run.status, 64, run.stderr + run.stdout);
  assert.match(run.stderr, /^--record offline: morpho\/vault-deposit is reported per vault, and the search anchors on no registry entry$/m);
  assert.doesNotMatch(run.stderr, /got no answer/);
  assert.deepEqual(run.written, []);
});

test('record-abi-case writes the case when every read is answered, and nothing when Etherscan gives no answer', () => {
  const recorded = readRecording<AbiCase>(join(ROOT, 'testdata', 'abi', 'usdc.json'));
  const block = { number: `0x${BigInt(recorded.block.number).toString(16)}`, hash: recorded.block.hash };
  const at = { blockHash: recorded.block.hash };
  const both = (answer: unknown) => ({ alchemy: answer, drpc: answer });
  const exchanges: Exchange[] = [
    { method: 'eth_getBlockByNumber', params: [block.number, false], answers: both(block) },
    ...recorded.reads.map(({ method, args, value }) =>
      method === 'getCode' ? { method: 'eth_getCode', params: [args[0], at], answers: both(value) } : { method: 'eth_getStorageAt', params: [args[0], args[1], at], answers: both(value) },
    ),
  ];
  const http: Http = {};
  for (const [address, { status, body }] of Object.entries(recorded.etherscan)) {
    http[`https://api.etherscan.io/v2/api?${new URLSearchParams({ chainid: '1', module: 'contract', action: 'getsourcecode', address })}`] = { status, text: JSON.stringify(body) };
  }
  const args = ['offline', recorded.address, recorded.block.number];
  assertRecorded(runOffline('record-abi-case.ts', args, 'abi', { exchanges, http }), 'offline.json');
  const [implementation] = Object.keys(recorded.etherscan);
  assertRefused(runOffline('record-abi-case.ts', args, 'abi', { exchanges }), `etherscan ${implementation}: unreachable or timed out`);
});

test('attacks --record writes nothing when a read gets no answer', () => {
  const recording = readRecording<{ service: { safe: string; nonce: number }; exchanges: Exchange[] }>(join(ROOT, 'testdata', 'attacks', 'wazirx', 'recording.json'));
  const service = `https://api.safe.global/tx-service/eth/api/v2/safes/${recording.service.safe}/multisig-transactions/?nonce=${recording.service.nonce}&executed=true`;
  const http = { [service]: { status: 200, text: JSON.stringify({ count: 1, results: [recording.service] }) } };
  const run = runOffline('attacks.ts', ['--record', 'wazirx'], 'attacks', { exchanges: withheld(recording.exchanges, 'eth_getBalance'), http }, ['wazirx/case.json']);
  assertRefused(run, 'drpc eth_getBalance: unreachable', 'attacks: wazirx: ');
});

test('prove-instance --record writes the recording when every read is answered, and nothing when a read gets no answer', () => {
  const recording = readRecording<{ exchanges: Exchange[] }>(join(ROOT, 'testdata', 'instance', 'uniswap-v3-usdc-weth-500.json'));
  const args = ['uniswap-v3-usdc-weth-500', '--registry', join(ROOT, 'test', 'fixtures', 'uniswap-v3', 'registry'), '--record', 'offline'];
  assertRecorded(runOffline('prove-instance.ts', args, 'instance', recording), 'offline.json');
  assertStopped(runOffline('prove-instance.ts', args, 'instance', { exchanges: withheld(recording.exchanges, 'eth_call') }), /^REFUSED .*drpc failed \(unreachable\)/m);
});

test('record-safe-proxy writes the recording when every read is answered, and nothing when a read gets no answer', () => {
  const recording = readRecording<{ transaction: string; exchanges: Exchange[] }>(join(ROOT, 'testdata', 'safe-proxy', 'proxy-factory-1-3-0.json'));
  const args = ['offline', recording.transaction];
  assertRecorded(runOffline('record-safe-proxy.ts', args, 'safe-proxy', recording), 'offline.json');
  assertStopped(runOffline('record-safe-proxy.ts', args, 'safe-proxy', { exchanges: withheld(recording.exchanges, 'eth_getCode') }), /drpc failed \(unreachable\)/);
});

test('record-safe-tx refuses the configured Safe before it reads anything and writes nothing', () => {
  const safe = '0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0';
  const run = runOffline('record-safe-tx.ts', ['offline', safe, '381'], 'safe-tx', { exchanges: [] }, [], { chainId: 1, safe: safe.toLowerCase() });
  assertStopped(run, /<safe> is the configured Safe; nothing written/);
  assert.doesNotMatch(run.stderr, /offline: /);
});
