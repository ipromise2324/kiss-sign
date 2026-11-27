import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import type { Endpoint } from '../src/chain/providers.ts';
import { replayTransport } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import type { Transport } from '../src/chain/rpc.ts';
import { loadRegistry } from '../src/registry.ts';
import { fillRecording } from '../src/research/fill-recording.ts';
import type { Filled, LiveReads } from '../src/research/fill-recording.ts';
import { studyRecording, summaryText } from '../src/research/past-txs-summary.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import type { RecordedTrace } from '../src/research/trace.ts';
import type { Hex } from '../src/safe/types.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const fixture = (name: string) => readRecording<PastTxsRecording>(join(ROOT, 'testdata', 'past-txs', `${name}.json`));
const transfers = fixture('erc20-transfer');
const anyContract = fixture('any-contract');
const ENDPOINTS: readonly [Endpoint, Endpoint] = [
  { provider: 'alchemy', company: 'Alchemy', url: 'https://alchemy.live' },
  { provider: 'drpc', company: 'drpc', url: 'https://drpc.live' },
];

/** A chain that answers from `exchanges`, makes up the header of any block, its number in its hash, and counts each request. */
function chain(exchanges: readonly Exchange[]): { readonly transport: Transport; readonly asked: string[] } {
  const asked: string[] = [];
  const recorded = replayTransport(exchanges, ENDPOINTS);
  const transport: Transport = async (url, body, signal) => {
    const { method, params } = JSON.parse(body) as { method: string; params: [string, boolean] };
    asked.push(method);
    if (method !== 'eth_getBlockByNumber' && method !== 'eth_getBlockByHash') return recorded(url, body, signal);
    const number = BigInt(params[0]);
    const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
    const result = { number: `0x${number.toString(16)}`, hash: word(number), parentHash: word(number - 1n), timestamp: `0x${(1_700_000_000n + number).toString(16)}`, gasLimit: '0x1c9c380', mixHash: word(7n) };
    return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
  };
  return { transport, asked };
}

const unreachable: Transport = async () => {
  throw new Error('unreachable');
};

/** Call traces served from `served`, each asked for counted. */
function tracesFrom(served: readonly RecordedTrace[]): LiveReads['traces'] & { readonly asked: Hex[] } {
  const asked: Hex[] = [];
  return {
    asked,
    source: async (hash) => {
      asked.push(hash);
      const trace = served.find((t) => t.hash === hash);
      return trace === undefined ? undefined : 'calls' in trace ? { kind: 'calls', calls: trace.calls } : { kind: 'unreadable', why: trace.unreadable };
    },
    recorded: () => served.filter((t) => asked.includes(t.hash)),
  };
}

const live = (transport: Transport, traces = tracesFrom([])): LiveReads => ({
  endpoints: ENDPOINTS,
  transport,
  traces,
  messages: { read: async () => ({ why: 'no message served' }), exchanges: () => [] },
  unread: () => [],
});

const kept = (filled: Filled) => (filled.kind === 'kept' ? filled : assert.fail(`lacking: ${filled.reads.join(', ')}`));
const withoutRuns = { ...transfers, exchanges: transfers.exchanges.filter((e) => e.method !== 'eth_simulateV1') };
const runs = transfers.exchanges.length - withoutRuns.exchanges.length;

test('a restudy of a recording that holds every read asks nothing live and keeps the recording as it was', async () => {
  const served = chain([]);
  const traces = tracesFrom([]);
  const filled = kept(await fillRecording(ROOT, transfers, registry, live(served.transport, traces), undefined));
  assert.deepEqual(served.asked, []);
  assert.deepEqual(traces.asked, []);
  assert.deepEqual(filled.read, { chain: 0, traces: 0, messages: 0 });
  assert.equal(filled.recording, transfers);
});

test('a restudy runs alone live each fitting transaction the recording holds no run of, and studies it as the full recording', async () => {
  assert.ok(runs > 0, 'the fixture runs transactions alone');
  const filled = kept(await fillRecording(ROOT, withoutRuns, registry, live(chain(transfers.exchanges).transport), undefined));
  assert.deepEqual(filled.read, { chain: runs, traces: 0, messages: 0 });
  assert.equal(summaryText(await studyRecording(ROOT, filled.recording, registry)), summaryText(await studyRecording(ROOT, transfers, registry)));
});

test('a restudy traces live a transaction exactly the template that the recording holds no trace of, and studies it as the full recording', async () => {
  const served = chain(anyContract.exchanges);
  const whole = kept(await fillRecording(ROOT, anyContract, registry, live(served.transport, tracesFrom(anyContract.traces ?? [])), undefined)).recording;
  const [trace] = whole.traces ?? [];
  if (trace === undefined) return assert.fail('a recording with a trace');
  const traces = tracesFrom([trace]);
  const filled = kept(await fillRecording(ROOT, { ...whole, traces: [] }, registry, live(chain(whole.exchanges).transport, traces), undefined));
  assert.deepEqual(traces.asked, [trace.hash]);
  assert.deepEqual(filled.read, { chain: 0, traces: 1, messages: 0 });
  assert.equal(summaryText(await studyRecording(ROOT, filled.recording, registry)), summaryText(await studyRecording(ROOT, whole, registry)));
});

test('a restudy writes nothing when a read the recording lacks gets no answer, naming each', async () => {
  const filled = await fillRecording(ROOT, withoutRuns, registry, live(unreachable), undefined);
  assert.equal(filled.kind, 'lacking');
  assert.ok(filled.kind === 'lacking' && filled.reads.length > 0 && filled.reads.every((read) => /eth_simulateV1/.test(read)), JSON.stringify(filled));
});

test('without the keys a restudy reads nothing live: a recording that holds every read is kept, one that lacks a read is refused', async () => {
  assert.equal(kept(await fillRecording(ROOT, transfers, registry, undefined, undefined)).recording, transfers);
  const filled = await fillRecording(ROOT, withoutRuns, registry, undefined, undefined);
  assert.ok(filled.kind === 'lacking' && filled.reads.length === runs && filled.reads.every((read) => /^eth_simulateV1 .*: not in the recording$/.test(read)), JSON.stringify(filled).slice(0, 400));
});
