import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { parseFunctionSignature } from '../src/decode/abi.ts';
import type { AbiFunction } from '../src/decode/abi.ts';
import { encodeCall, encodeParams } from '../src/decode/codec.ts';
import type { AbiValue } from '../src/decode/codec.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { checksumAddress } from '../src/safe/types.ts';
import { EXECUTION_SUCCESS } from '../src/simulate/events.ts';
import { ResearchError, anchorEvent, replayAsk } from '../src/research/sources.ts';
import type { Ask, SourceExchange } from '../src/research/sources.ts';
import { pacedAsk, survey } from '../src/research/survey.ts';
import type { SafeTxCalls, Survey, SurveyTarget } from '../src/research/survey.ts';
import { renderSurvey } from '../src/research/survey-render.ts';
import type { Functions } from '../src/research/survey-render.ts';
import { bytesToHex } from '@noble/hashes/utils.js';

const ROOT = join(import.meta.dirname, '..');
type Page = { readonly status: string; readonly message: string; readonly result: readonly { readonly address: string; readonly topics: readonly string[]; readonly data: string; readonly transactionHash: Hex }[] };
/** 1,000 blocks searched live for CoW's PreSignature; of the pages of every Safe's ExecutionSuccess, only what the search found and a few more are kept. */
const recorded = readRecording<{ readonly head: string; readonly sources: readonly SourceExchange[]; readonly exchanges: readonly Exchange[] }>(join(ROOT, 'testdata', 'survey', 'presignature.json'));
const registry = loadRegistry(ROOT);
const SETTLEMENT = registry.entries.get('gpv2-settlement')?.address as Address;
const event = anchorEvent('PreSignature(address indexed owner, bytes orderUid, bool signed)');
const PRESIGN: SurveyTarget = { kind: 'event', event, contracts: [SETTLEMENT] };
const functions = (...signatures: string[]): Functions => ({ kind: 'proven', bySelector: new Map(signatures.map(parseFunctionSignature).map((fn): [string, AbiFunction] => [fn.selector, fn])) });
const ABIS = new Map([[SETTLEMENT, functions('setPreSignature(bytes orderUid, bool signed)')]]);

type Changes = { readonly sources?: readonly SourceExchange[]; readonly exchanges?: readonly Exchange[]; readonly exclude?: Address; readonly maxTxs?: number };
const surveyed = (changes: Changes = {}): Promise<Survey> =>
  survey(PRESIGN, { ask: replayAsk(changes.sources ?? recorded.sources), reader: replayReader(changes.exchanges ?? recorded.exchanges), exclude: changes.exclude, maxPages: 6, maxTxs: changes.maxTxs ?? 40, blocks: 1000n, head: BigInt(recorded.head) });

/** The recorded pages, each log of `topic0` changed by `change`, or dropped when it gives undefined. */
const withLogs = (topic0: string, change: (log: Page['result'][number]) => Page['result'][number] | undefined): SourceExchange[] =>
  recorded.sources.map((one) => {
    if (one.request.source !== 'etherscan' || one.request.query.topic0 !== topic0) return one;
    const page = one.answer as Page;
    return Array.isArray(page.result) ? { ...one, answer: { ...page, result: page.result.map(change).filter((log) => log !== undefined) } } : one;
  });
const hashes = (run: Survey) => run.txs.map((tx) => tx.hash).sort();

test('the recorded transactions are grouped by the calls the Safes made, with each Safe counted once', async () => {
  const run = await surveyed();
  assert.ok(run.txs.length >= 3, `${run.txs.length} studied`);
  const text = renderSurvey(run, { abis: ABIS, registry });
  assert.match(text, /^ORIENTATION ONLY/);
  const safes = new Set(run.txs.map((tx) => tx.safe)).size;
  assert.ok(text.includes(`${run.txs.length} executed Safe transactions of ${safes} Safes.`));
  const presign = /^ {2}(\d+) transactions?, \d+ Safes?: gpv2-settlement setPreSignature\(bytes,bool\)$/m.exec(text.split('Calls to the contract')[1] ?? '');
  assert.equal(Number(presign?.[1]), run.txs.length, text);
  assert.match(text, /^ {6}orderUid: 56 bytes/m);
  assert.match(text, /^ {6}signed: true/m);
  for (const { hash, calls, safe } of run.txs) {
    const tx = recorded.exchanges.find((e) => e.method === 'eth_getTransactionByHash' && JSON.stringify(e.params) === JSON.stringify([hash]));
    const raw = tx?.answers.alchemy as { to: string; input: string };
    assert.equal(raw.to, safe);
    for (const call of calls) assert.ok(raw.input.includes(call.to.slice(2)) && raw.input.includes(call.data.slice(2)));
  }
});

test('a Safe is found by the address a log holds, or, where no log holds it, by its own ExecutionSuccess', async () => {
  const both = hashes(await surveyed());
  assert.ok(both.length > 0);
  assert.deepEqual(hashes(await surveyed({ sources: withLogs(EXECUTION_SUCCESS, () => undefined) })), both);
  const anonymous = withLogs(event.topic, (log) => ({ ...log, topics: [log.topics[0] as string, `0x${'00'.repeat(32)}`] }));
  assert.deepEqual(hashes(await surveyed({ sources: anonymous })), both);
});

test('the configured Safe is left out of every count and example', async () => {
  const all = await surveyed();
  const mine = all.txs[0] as SafeTxCalls;
  const run = await surveyed({ exclude: mine.safe });
  const text = renderSurvey(run, { abis: ABIS, registry });
  assert.ok(!run.txs.some((tx) => tx.safe === mine.safe));
  assert.ok(!text.toLowerCase().includes(mine.safe.slice(2)) && !text.includes(mine.hash));
  assert.ok(run.found < all.found && run.marked < all.marked);
  const last = all.txs.at(-1) as SafeTxCalls;
  assert.ok((await surveyed({ exclude: last.safe, maxTxs: 1 })).found < all.found, 'a transaction not read is left out by its logs');
});

test('a sender the providers do not prove a Safe is not counted, though it logged ExecutionSuccess', async () => {
  const run = await surveyed({ exchanges: recorded.exchanges.filter((e) => !['eth_simulateV1', 'eth_getStorageAt'].includes(e.method)) });
  assert.ok(run.marked > 0);
  assert.deepEqual(run.txs, []);
  assert.match(renderSurvey(run, { abis: ABIS, registry }), /transactions?: not read: whether it was sent to a Safe/);
});

test('a transaction or receipt the providers give differently is not counted, and the output says it was not read', async () => {
  for (const method of ['eth_getTransactionByHash', 'eth_getTransactionReceipt']) {
    const { hash } = (await surveyed()).txs[0] as SafeTxCalls;
    const exchanges = recorded.exchanges.map((e) =>
      e.method === method && JSON.stringify(e.params) === JSON.stringify([hash]) ? { ...e, answers: { ...e.answers, drpc: { ...(e.answers.drpc as object), from: `0x${'11'.repeat(20)}` } } } : e,
    );
    const run = await surveyed({ exchanges });
    assert.ok(!hashes(run).includes(hash));
    assert.match(renderSurvey(run, { abis: ABIS, registry }), new RegExp(`1 transaction: not read: ${method}: alchemy and drpc disagree, e\\.g\\. ${hash}`));
  }
});

test('a transaction whose Safe logged no ExecutionSuccess is not an executed one', async () => {
  const { hash } = (await surveyed()).txs[0] as SafeTxCalls;
  const exchanges = JSON.parse(JSON.stringify(recorded.exchanges), (_, v: unknown) => v) as Exchange[];
  const failed = exchanges.map((e) =>
    e.method === 'eth_getTransactionReceipt' && JSON.stringify(e.params) === JSON.stringify([hash]) ? (JSON.parse(JSON.stringify(e).replaceAll(EXECUTION_SUCCESS, `0x${'22'.repeat(32)}`)) as Exchange) : e,
  );
  const run = await surveyed({ exchanges: failed });
  assert.ok(!hashes(run).includes(hash));
  assert.deepEqual(run.leftOut.get('no ExecutionSuccess from the Safe'), [hash]);
});

test('past the cap on reading, the output says how many marked transactions were not read', async () => {
  const run = await surveyed({ maxTxs: 2 });
  assert.equal(run.read, 2);
  assert.match(renderSurvey(run, { abis: ABIS, registry }), new RegExp(`${run.marked - 2} marked transactions past the cap on reading`));
});

/** Etherscan over a chain with `perBlock` logs of the searched kind in each block, none of a Safe. */
function chainOf(perBlock: number, asked: { from: number; to: number; page: number }[] = []): Ask {
  return async (request) => {
    const query = request.source === 'etherscan' ? request.query : {};
    const [from, to, page] = [Number(query.fromBlock), Number(query.toBlock), Number(query.page)];
    if (query.topic0 === EXECUTION_SUCCESS) return { status: '0', message: 'No records found', result: [] };
    asked.push({ from, to, page });
    if (page > 10) throw new ResearchError('etherscan refuses a page beyond its first 10,000 results');
    const first = Math.ceil(from * perBlock) + (page - 1) * 1000;
    const count = Math.max(0, Math.min(1000, Math.ceil((to + 1) * perBlock) - first));
    if (count <= 0) return { status: '0', message: 'No records found', result: [] };
    const log = (n: number) => ({ address: SETTLEMENT, topics: [event.topic], data: '0x', blockNumber: `0x${Math.floor(n / perBlock).toString(16)}`, transactionHash: `0x${n.toString(16).padStart(64, '0')}` });
    return { status: '1', message: 'OK', result: Array.from({ length: count }, (_, i) => log(first + i)) };
  };
}
const HEAD = 1_000_000n;
const onlyBlocks = replayReader(
  [{ method: 'eth_getBlockByNumber', params: [`0x${(HEAD - 64n).toString(16)}`, false], answers: Object.fromEntries(['alchemy', 'drpc'].map((p) => [p, { number: `0x${(HEAD - 64n).toString(16)}`, hash: `0x${'33'.repeat(32)}` }])) }] as unknown as Exchange[],
);
const busy = (perBlock: number, maxPages: number, ask = chainOf(perBlock)) => survey(PRESIGN, { ask, reader: onlyBlocks, exclude: undefined, maxPages, maxTxs: 1, blocks: 500_000n, head: HEAD });

test('a search that reaches its page cap claims only the blocks it listed whole, newest first, and says it stopped', async () => {
  const run = await busy(4, 20);
  const [query] = run.queries;
  assert.ok(query?.fromBlock !== undefined && query.fromBlock > run.range.fromBlock);
  assert.equal(BigInt(query.logs), (run.range.toBlock - query.fromBlock + 1n) * 4n, 'every log of the blocks it claims, and no other');
  assert.equal(run.found, query.logs);
  assert.ok(query.logs >= 8000 && query.pages <= 20, `${query.logs} logs in ${query.pages} pages`);
  assert.match(renderSurvey(run, { abis: ABIS, registry }), /NOT older, stopped by its cap of 20 pages/);
});

test('a search the page cap stops warns before any Safe is checked, and the output says how to narrow it', async () => {
  const warned: string[] = [];
  const ask = chainOf(4);
  const run = await survey(PRESIGN, { ask, reader: onlyBlocks, exclude: undefined, maxPages: 20, maxTxs: 1, blocks: 500_000n, head: HEAD, warn: (w) => void warned.push(w) });
  assert.equal(warned.length, 1);
  assert.match(warned[0] as string, /^WARNING: the search is short\. PreSignature\(address,bytes,bool\) logged by 0x[0-9a-f]{40} read \d+ of 500000 blocks, about \d+ (minutes|hours), stopped by its cap of 20 pages\. /);
  assert.ok(renderSurvey(run, { abis: ABIS, registry }).includes(warned[0] as string));
  const transfers: SurveyTarget = { kind: 'transfers', tokens: [SETTLEMENT], contracts: [] };
  const busyToken: string[] = [];
  await survey(transfers, { ask, reader: onlyBlocks, exclude: undefined, maxPages: 20, maxTxs: 1, blocks: 500_000n, head: HEAD, warn: (w) => void busyToken.push(w) });
  assert.match(busyToken[0] as string, /Narrow it with --to <the contract the token moves into>/);
});

test('one survey searches the transfers of each --token given, every search with the same --to, in one report', async () => {
  const asked: Record<string, string>[] = [];
  const ask: Ask = async (request) => {
    if (request.source === 'etherscan' && request.query.topic0 !== EXECUTION_SUCCESS) asked.push(request.query);
    return { status: '0', message: 'No records found', result: [] };
  };
  const [USDC, USDT, ROUTER] = ['usdc', 'usdt', 'gpv2-settlement'].map((name) => registry.entries.get(name)?.address as Address);
  const warned: string[] = [];
  const run = await survey({ kind: 'transfers', tokens: [USDC as Address, USDT as Address], to: ROUTER as Address, contracts: [] }, { ask, reader: onlyBlocks, exclude: undefined, maxPages: 20, maxTxs: 1, blocks: 500_000n, head: HEAD, warn: (w) => void warned.push(w) });
  assert.deepEqual(asked.map((q) => [q.address, q.topic2]).sort(), [[USDC, `0x${'00'.repeat(12)}${(ROUTER as string).slice(2)}`], [USDT, `0x${'00'.repeat(12)}${(ROUTER as string).slice(2)}`]].sort());
  assert.deepEqual(run.queries.map((q) => q.label), [`Transfer of ${USDC} to ${ROUTER}`, `Transfer of ${USDT} to ${ROUTER}`]);
  assert.deepEqual(warned, [], 'a search that reached its first block warns of nothing');
  const text = renderSurvey(run, { abis: ABIS, registry });
  assert.match(text, new RegExp(`Transfer of ${USDC} to ${ROUTER}: .*\n {2}Transfer of ${USDT} to ${ROUTER}: `));
  assert.doesNotMatch(text, /WARNING/);
});

test('a search that reaches its first block says nothing stopped it', async () => {
  const run = await busy(0.001, 20);
  assert.equal(run.queries[0]?.fromBlock, run.range.fromBlock);
  assert.equal(run.queries[0]?.stopped, undefined);
  assert.equal(run.found, 500);
});

test('a search of logs that name a contract starts short and still reaches the first block within its cap', async () => {
  const run = await survey({ kind: 'contracts', contracts: [{ address: SETTLEMENT, events: [] }] }, { ask: chainOf(0.001), reader: onlyBlocks, exclude: undefined, maxPages: 20, maxTxs: 1, blocks: 500_000n, head: HEAD });
  assert.deepEqual(run.queries.map((q) => [q.fromBlock, q.logs]), Array.from({ length: 4 }, () => [run.range.fromBlock, 500]));
});

test('a source that refuses stops its search at the blocks read, and one that times out is asked a shorter range', async () => {
  const refusing: Ask = async () => ({ status: '0', message: 'NOTOK', result: 'Invalid API Key' });
  assert.match(renderSurvey(await busy(1, 20, refusing), { abis: ABIS, registry }), /nothing read, 0 pages; NOT older, stopped by etherscan refused: NOTOK Invalid API Key/);
  const plain = chainOf(0.001);
  const slow: Ask = async (request, end) => {
    const query = request.source === 'etherscan' ? request.query : {};
    return Number(query.toBlock) - Number(query.fromBlock) > 100_000 ? { status: '0', message: 'Query Timeout occured', result: null } : plain(request, end);
  };
  const run = await busy(0.001, 40, slow);
  assert.equal(run.found, 500);
  assert.equal(run.queries[0]?.fromBlock, run.range.fromBlock);
});

const SAFE = `0x${'a1'.repeat(20)}` as Address;
const ROUTER = `0x${'b2'.repeat(20)}` as Address;
const TOKEN = `0x${'c3'.repeat(20)}` as Address;
const bytes = (hex: string): AbiValue => ({ kind: 'bytes', value: Uint8Array.from(Buffer.from(hex, 'hex')), span: [0, 0] });
const address = (value: Address): AbiValue => ({ kind: 'address', value, span: [0, 0] });
const uint = (value: bigint): AbiValue => ({ kind: 'uint', value, span: [0, 0] });
const list = (...items: AbiValue[]): AbiValue => ({ kind: 'array', items, span: [0, 0] });
const hexOf = (fn: string, args: AbiValue[]): Hex => `0x${bytesToHex(encodeCall({ fn: parseFunctionSignature(fn), args, trailer: undefined }))}` as Hex;
const inner = (fn: string, ...args: AbiValue[]): string => bytesToHex(encodeParams(parseFunctionSignature(fn), args));

function routed(commands: string, actions: string, amount: bigint, n: number): SafeTxCalls {
  const params = bytes(inner('f(address,uint256)', address(TOKEN), uint(amount)));
  const input = bytes(inner('f(bytes,bytes[])', bytes(actions), list(params)));
  const approve = hexOf('approve(address,uint256)', [address(ROUTER), uint(amount)]);
  return {
    hash: `0x${n.toString(16).padStart(64, '0')}` as Hex,
    block: BigInt(n),
    safe: SAFE,
    wrapped: 'batch',
    calls: [{ operation: 0, to: TOKEN, value: 0n, data: approve }, { operation: 0, to: ROUTER, value: 5n, data: hexOf('run(bytes,bytes[])', [bytes(commands), list(input)]) }],
    foundBy: new Set(['x']),
  };
}
const rendered = (txs: readonly SafeTxCalls[], abis: ReadonlyMap<Address, Functions>, target: SurveyTarget = { kind: 'contracts', contracts: [{ address: ROUTER, events: [] }] }): string => {
  const run = { label: 'x', fromBlock: 1n, pages: 1, logs: 1 };
  return renderSurvey({ target, range: { fromBlock: 1n, toBlock: 9n }, queries: [run], executions: run, found: 1, parties: { checked: 0, safes: 0, unreadable: 0 }, marked: 1, read: 1, txs, leftOut: new Map() }, { abis, registry });
};

test('a command router is grouped by its commands and the actions inside an input, each nested value shown', () => {
  const abis = new Map([[ROUTER, functions('run(bytes commands, bytes[] inputs)')]]);
  const text = rendered([routed('10', '060c0f', 100n, 1), routed('10', '060c0f', 250n, 2), routed('0a10', '0b', 7n, 3)], abis);
  const name = checksumAddress(ROUTER);
  assert.match(text, new RegExp(`3 transactions, 1 Safe: MultiSend: another contract approve\\(address,uint256\\), then ${name} run\\(bytes,bytes\\[\\]\\) with ETH`));
  const group = text.split(`  2 transactions, 1 Safe: ${name} run(bytes,bytes[]) with ETH`)[1]?.split('  1 transaction')[0] ?? '';
  for (const line of ['ETH value: 5', 'commands: 0x10', 'inputs: 1 item', 'inputs[0]~commands: 0x060c0f', `inputs[0]~inputs[0].word0: ${checksumAddress(TOKEN)}`, 'inputs[0]~inputs[0].word1: 100 (1), 250 (1)']) {
    assert.ok(group.includes(`      ${line}\n`), `${line}\n${group}`);
  }
  assert.ok(text.includes('commands: 0x0a10') && text.includes(`3 transactions, 1 Safe: another contract approve(address,uint256)`));
});

test('a contract with no proven ABI shows its selector and its words, and why no ABI was proven', () => {
  const text = rendered([routed('10', '060c0f', 100n, 1)], new Map([[ROUTER, { kind: 'unproven', why: 'no verified source' } as const]]));
  const { selector } = parseFunctionSignature('run(bytes,bytes[])');
  assert.ok(text.includes(`${checksumAddress(ROUTER)} ${selector} with ETH`), text);
  assert.match(text, /not proven, so its functions print as selectors: no verified source/);
});

test("a Safe's own functions are named for every Safe, whichever Safe's ABI was proven", () => {
  const own = (n: number, safe: Address): SafeTxCalls => ({ hash: `0x${n.toString(16).padStart(64, '0')}` as Hex, block: 1n, safe, wrapped: 'direct', foundBy: new Set(), calls: [{ operation: 0, to: safe, value: 0n, data: hexOf('changeThreshold(uint256)', [uint(2n)]) }] });
  const target: SurveyTarget = { kind: 'event', event: anchorEvent('ChangedThreshold(uint256)'), contracts: [] };
  const text = rendered([own(1, SAFE), own(2, TOKEN)], new Map([[SAFE, functions('changeThreshold(uint256 _threshold)')]]), target);
  assert.match(text, /2 transactions, 2 Safes: the Safe itself changeThreshold\(uint256\)/);
  assert.match(text, /^ {6}_threshold: 2$/m);
});

test('searches run side by side start no closer together than the pace', async () => {
  const starts: number[] = [];
  const ask = pacedAsk(async () => void starts.push(Date.now()), 40);
  await Promise.all(Array.from({ length: 4 }, () => ask({ source: 'etherscan', query: {} })));
  for (let i = 1; i < starts.length; i++) assert.ok((starts[i] as number) - (starts[i - 1] as number) >= 35, String(starts));
});

test('a search that names nothing, or two searches at once, is refused before any key or read', () => {
  for (const args of [[], ['--event', 'A(uint256)', '--token', 'usdc'], ['usdc', '--from', 'usdt'], ['no-such-entry'], ['usdc', '--pages', '0'], ['usdc', '--event', 'A('], ['--token', 'usdc', '--token', 'no-such-entry']]) {
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'survey.ts'), ...args], { env: { PATH: process.env.PATH, HOME: '/nonexistent', KISS_SIGN_HOME: '/nonexistent' }, encoding: 'utf8' });
    assert.equal(run.status, 64, `${args.join(' ')}: ${run.stderr}`);
    assert.match(run.stderr, /usage: pnpm survey/);
  }
});
