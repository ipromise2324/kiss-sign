import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { unreadRefusal } from '../src/chain/https.ts';
import { createReader } from '../src/chain/reader.ts';
import type { Reader } from '../src/chain/reader.ts';
import { REPLAY_ENDPOINTS, recordingTransport, replayReader, replayTransport } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import type { Transport } from '../src/chain/rpc.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Registry } from '../src/registry.ts';
import { foundBy, pastTxs } from '../src/research/past-txs.ts';
import { withBlockTimes } from './block-times.ts';
import { renderPastTxs, spreadOf } from '../src/research/past-txs-render.ts';
import { DEFAULT_SAMPLING, MAX_PAGES, YEAR_PAGES, samplingFields, samplingOf, scrubRecording } from '../src/research/recording.ts';
import { replayMessages } from '../src/research/messages.ts';
import { pastTxsRecordings, summarizePastTxs } from '../src/research/report.ts';
import { parseSummary, studyRecording, summaryText } from '../src/research/past-txs-summary.ts';
import type { Subject } from '../src/research/report.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { anchorEvent, recordingAsk, replayAsk, search } from '../src/research/sources.ts';
import type { Anchor, AnchorKind, Ask, Hits, SourceExchange, SourceRequest } from '../src/research/sources.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { repoWithBundler3Deposit } from './bundler3-deposit.ts';
import { SUMMARY_FIXTURES, runOffline } from './run-offline.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const ROOT = repoWithBundler3Deposit();

/** The text of a summary of `query` that studied nothing. */
const summaryOf = (query: PastTxsRecording['query']): string =>
  JSON.stringify({
    query,
    ...(query.fromBlock === undefined ? { head: query.head ?? '1' } : {}),
    studiedWith: { template: `0x${'00'.repeat(32)}`, registry: `0x${'00'.repeat(32)}`, study: `0x${'00'.repeat(32)}` },
    search: { windows: [], perWindow: 0, found: { total: 0, only: { alchemy: [], etherscan: [] } }, otherEmitter: [] },
    studies: [],
    measurements: [],
    traces: [],
  });
const SCRIPTS = join(import.meta.dirname, '..', 'scripts');
const recording: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit.json'));
const registry = loadRegistry(ROOT);

const FIT = '0x88a65493c62cfc17be33cbc587fca29edf71d0984b6ba2295873dfb1a9a38c4c';
const MISFIT = '0xbd242bf8e4ff0a45a27468a62553bae8770bd456c12420028de0f82e28e18a80';

/** The Safe that executed `hash`, as the recorded chain read says. */
function safeOf(hash: string): Address {
  const read = recording.exchanges.find((e) => e.method === 'eth_getTransactionByHash' && JSON.stringify(e.params) === JSON.stringify([hash]));
  return (read?.answers.alchemy as { to: Address }).to;
}

async function report(
  options: { exclude?: Address; sources?: readonly SourceExchange[]; template?: Template; exchanges?: PastTxsRecording['exchanges']; recorded?: PastTxsRecording; registry?: Registry; reader?: Reader } = {},
): Promise<string> {
  const recorded = options.recorded ?? recording;
  const seen = options.registry ?? registry;
  const { query } = recorded;
  const run = await pastTxs(
    {
      template: options.template ?? loadTemplate(ROOT, query.template, registry),
      anchor: { token: query.token as Address, kind: query.anchor as AnchorKind, ...(query.from === undefined ? {} : { from: query.from as Address }) },
      sampling: samplingOf(query),
    },
    { ask: replayAsk(options.sources ?? recorded.sources), reader: options.reader ?? replayReader(options.exchanges ?? recorded.exchanges), registry: seen, readMessage: replayMessages([]), exclude: options.exclude, maxTxs: query.maxTxs },
  );
  return renderPastTxs(run, seen);
}

function withAnswersReplaced(method: string, address: string, answer: unknown): PastTxsRecording['exchanges'] {
  return recording.exchanges.map((e) =>
    e.method === method && (e.params as unknown[])[0] === address ? { ...e, answers: Object.fromEntries(Object.keys(e.answers).map((p) => [p, answer])) } : e,
  );
}

test('a recorded search reports both sources, senders by type, and how each template field was filled', async () => {
  const text = await report();
  assert.match(text, /^ {2}blocks 26044000 to 26052000: 65 found, 65 studied$/m);
  assert.match(text, /^sources: alchemy found 65, etherscan found 65; both 65, only alchemy 0, only etherscan 0$/m);
  assert.match(text, /^ {2}proven Safe: 3, from 1 Safe$/m);
  assert.match(text, /^ {2}contract, not a proven Safe: 0, from 0 contracts$/m);
  assert.match(text, /^ {4}37 calls no function the template calls \(called 0x22cfce7b in 16, /m);
  assert.match(text, /^fit the template's shape: 2 transactions from 1 Safe; misfits: 1 from 1 Safe$/m);
  assert.match(text, /erc4626Deposit\.receiver {2}\[the Safe\]\n {4}equalled the Safe in 2 of 2 \(1 Safe\); values: the Safe in 2$/m);
  assert.match(text, /erc4626Deposit\.assets {2}\[card amount\]\n {4}same as the other leaves bound to card amount in 2 of 2; /m);
  assert.match(text, /approve\.spender {2}\[contract general-adapter-1\]\n {4}equalled contract general-adapter-1 in 2 of 2 /m);
  assert.match(text, new RegExp(`^ {2}1 from 1 Safe: calls usdc\\.approve, vault-bundles-v1\\.0x6bbba4e0\\n {4}e\\.g\\. ${MISFIT}$`, 'm'));
  assert.match(text, new RegExp(`^examples that fit: ${FIT}, `, 'm'));
});

test('an EOA making one of the template\'s calls directly is counted as an EOA and checked against that call, with itself as the Safe', async () => {
  const text = await report();
  assert.match(text, /^ {2}EOA calling a function of the template directly: 25, from 24 EOAs$/m);
  assert.match(text, /^by EOAs, call 2 of 2 \(multicall\) as its own transaction:\nfit the call's shape: 2 transactions from 2 EOAs; misfits: 23 from 22 EOAs$/m);
  assert.match(text, /^ {2}call\.multicall\.bundle\[1\]\.data\.erc4626Deposit\.receiver {2}\[the sender\]\n {4}equalled the sender in 2 of 2 \(2 EOAs\); /m);
  assert.match(text, /^ {2}13 from 12 EOAs: call\.multicall\.bundle: expected 2 items, got 3 items, calling usdc\.0xd505accf, general-adapter-1\.erc20TransferFrom, general-adapter-1\.erc4626Deposit$/m);
  assert.doesNotMatch(text, /^by EOAs, call 1 of 2/m);
});

test('a contract that runs execTransaction and emits ExecutionSuccess is not a Safe unless its code is a Safe proxy and its singleton official', async () => {
  const safe = safeOf(FIT);
  const proxy = recording.exchanges.find((e) => e.method === 'eth_getCode' && (e.params as unknown[])[0] === safe)?.answers.alchemy as string;
  const notAProxy = await report({ exchanges: withAnswersReplaced('eth_getCode', safe, `${proxy}00`) });
  assert.match(notAProxy, /^ {2}proven Safe: 0, from 0 Safes$/m);
  assert.match(notAProxy, /^ {2}contract, not a proven Safe: 3, from 1 contract$/m);
  assert.match(notAProxy, new RegExp(`^ {4}3 its code is not a known Safe proxy: .*${FIT}`, 'm'));
  assert.match(notAProxy, /^fit the template's shape: 0 transactions from 0 Safes; misfits: 0 from 0 Safes$/m);

  const foreignSingleton = await report({ exchanges: withAnswersReplaced('eth_getStorageAt', safe, `0x${'00'.repeat(12)}${'de'.repeat(20)}`) });
  assert.match(foreignSingleton, /^ {2}proven Safe: 0, from 0 Safes$/m);
  assert.match(foreignSingleton, new RegExp(`^ {4}3 its singleton is not an official Safe singleton: .*${FIT}`, 'm'));
});

test('the same function called on a contract other than the one the template names is not counted as the template call', async () => {
  const direct = '0x8b418f72564aac961208cf6f6aea83a99d26d4a385f2f40b9087161ac205efd1';
  const exchanges = recording.exchanges.map((e) =>
    e.method === 'eth_getTransactionByHash' && JSON.stringify(e.params) === JSON.stringify([direct])
      ? { ...e, answers: Object.fromEntries(Object.entries(e.answers).map(([p, a]) => [p, { ...(a as object), to: `0x${'de'.repeat(20)}` }])) }
      : e,
  );
  const text = await report({ exchanges });
  assert.match(text, /^ {2}EOA calling a function of the template directly: 24, from 24 EOAs$/m);
  assert.match(text, /^ {4}38 calls no function the template calls \(/m);
});

test('a deposit into the vault whose mint found it, when the registry does not hold that vault, has the template\'s shape outside the registry', async () => {
  const vault = recording.query.token as Address;
  const kept = [...registry.entries.values()].filter((entry) => entry.address !== vault);
  const text = await report({ registry: { attributes: registry.attributes, entries: new Map(kept.map((e) => [e.name, e])), byAddress: new Map(kept.map((e) => [e.address, e])), markets: registry.markets } });
  assert.match(text, /^fit the template's shape: 2 transactions from 1 Safe; misfits: 1 from 1 Safe\n {2}exactly the template: 0 from 0 Safes; outside the registry: 2 from 1 Safe \(a vault outside the registry at \S+\.erc4626Deposit\.vault in 2\)$/m);
});

test('the template\'s function called on another contract than the vault whose mint found it, such as a wrapper, is a misfit named by that contract', async () => {
  const vault = (recording.query.token as Address).slice(2);
  const wrapper = 'de'.repeat(20);
  const exchanges = recording.exchanges.map((e) =>
    e.method === 'eth_getTransactionByHash' && JSON.stringify(e.params) === JSON.stringify([FIT])
      ? { ...e, answers: Object.fromEntries(Object.entries(e.answers).map(([p, a]) => [p, { ...(a as object), input: (a as { input: string }).input.replaceAll(vault, wrapper) }])) }
      : e,
  );
  const text = await report({ exchanges });
  assert.match(text, /^fit the template's shape: 1 transaction from 1 Safe; misfits: 2 from 1 Safe$/m);
  assert.match(text, new RegExp(`^ {2}1 from 1 Safe: \\S+\\.erc4626Deposit\\.vault: expected [^,]+, got 0x(de){20}\\n {4}e\\.g\\. ${FIT}$`, 'im'));
});

test('a window with more transfers than one page is halved, and the report names the blocks left out', async () => {
  const windowed: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit-windows.json'));
  const [full, half] = [26373601n, 26377201n];
  const replay = replayAsk(windowed.sources);
  const fromBlockOf = (r: SourceRequest) => (r.source === 'alchemy' ? BigInt(r.params.fromBlock as string) : BigInt(r.query.fromBlock as string));
  const ask = async (request: SourceRequest) => {
    if (request.source === 'alchemy' && fromBlockOf(request) === full) return { ...((await replay(request)) as object), pageKey: 'more' };
    if (fromBlockOf(request) !== half) return replay(request);
    return replay(request.source === 'alchemy' ? { ...request, params: { ...request.params, fromBlock: `0x${full.toString(16)}` } } : { ...request, query: { ...request.query, fromBlock: full.toString() } });
  };
  const { query } = windowed;
  const run = await pastTxs(
    { template: loadTemplate(ROOT, query.template, registry), anchor: { token: query.token as Address, kind: query.anchor as AnchorKind }, sampling: samplingOf(query) },
    { ask, reader: replayReader(windowed.exchanges), registry, readMessage: replayMessages([]), exclude: undefined, maxTxs: query.maxTxs },
  );
  const text = renderPastTxs(run, registry);
  assert.match(text, /^ {2}blocks 26377201 to 26380800: 45 found, 2 studied; halved, too many transfers in 26373601 to 26380800, so 26373601 to 26377200 not searched$/m);
  assert.equal(text.match(/halved/g)?.length, 1);
});

test('a recording keeps only what the search reads, so a busy token\'s halved windows, overflowing in either source alone, replay the same report at a size bounded by the answers and transfers found', async () => {
  for (const overflowing of ['alchemy', 'etherscan'] as const) {
    const windowed: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit-windows.json'));
    const [full, half] = [26373601n, 26377201n];
    const replay = replayAsk(windowed.sources);
    const fromBlockOf = (r: SourceRequest) => (r.source === 'alchemy' ? BigInt(r.params.fromBlock as string) : BigInt(r.query.fromBlock as string));
    const bulk = { metadata: 'x'.repeat(2000) };
    const live = async (request: SourceRequest): Promise<unknown> => {
      if (fromBlockOf(request) === full && request.source === overflowing) {
        const page = Array.from({ length: 1000 }, () => bulk);
        return request.source === 'alchemy' ? { transfers: page, pageKey: 'more' } : { status: '1', message: 'OK', result: page };
      }
      const answer = (await replay(
        fromBlockOf(request) !== half ? request : request.source === 'alchemy' ? { ...request, params: { ...request.params, fromBlock: `0x${full.toString(16)}` } } : { ...request, query: { ...request.query, fromBlock: full.toString() } },
      )) as Record<string, unknown>;
      const padded = (list: unknown) => (Array.isArray(list) ? list.map((item) => ({ ...(item as object), ...bulk })) : list);
      return { ...answer, ...('transfers' in answer ? { transfers: padded(answer.transfers) } : {}), ...('result' in answer ? { result: padded(answer.result) } : {}) };
    };
    const { query } = windowed;
    const study = (ask: Ask) =>
      pastTxs(
        { template: loadTemplate(ROOT, query.template, registry), anchor: { token: query.token as Address, kind: query.anchor as AnchorKind }, sampling: samplingOf(query) },
        { ask, reader: replayReader(windowed.exchanges), registry, readMessage: replayMessages([]), exclude: undefined, maxTxs: query.maxTxs },
      );
    const recorder = recordingAsk(live);
    const run = await study(recorder.ask);
    const recorded = recorder.exchanges();
    assert.equal(renderPastTxs(await study(replayAsk(recorded)), registry), renderPastTxs(run, registry));
    assert.match(renderPastTxs(run, registry), /halved, too many transfers in 26373601 to 26380800/);
    const hits = foundBy(run.found, 'alchemy') + foundBy(run.found, 'etherscan');
    assert.ok(JSON.stringify(recorded).length < recorded.length * 3_000 + hits * 300, `${JSON.stringify(recorded).length} bytes for ${recorded.length} answers and ${hits} transfers`);
  }
});

test('--max-txs below one transaction per window is refused', () => {
  const run = spawnSync(process.execPath, [join(SCRIPTS, 'past-txs.ts'), 'morpho/vault-deposit', '--token', 'steakhouse-prime-usdc-v2-0f51', '--anchor', 'mint', '--max-txs', '11'], { encoding: 'utf8' });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /--max-txs must be at least 12, one transaction per window/);
});

test('by default the windows are spread over the last year from the head block, and each window is sampled to its share', async () => {
  const windowed: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit-windows.json'));
  const text = await report({ recorded: windowed });
  assert.match(text, /^windows: 12 of up to 7200 blocks, one every 219000 blocks over the last year; at most 2 studied per window$/m);
  const windows = [...text.matchAll(/^ {2}blocks (\d+) to (\d+): (\d+) found, (\d+) studied$/gm)].map((m) => m.slice(1).map(Number));
  assert.equal(windows.length, 12);
  for (const [from, to, found, studied] of windows as number[][]) {
    assert.equal((to as number) - (from as number) + 1, 7200);
    assert.equal(studied, Math.min(found as number, 2));
  }
  const ends = windows.map((w) => w[1] as number);
  assert.deepEqual(ends.slice(1).map((end, i) => end - (ends[i] as number)), new Array(11).fill(219000));
  assert.match(text, /^ {2}blocks 26373601 to 26380800: 45 found, 2 studied$/m);
});

test('a whole year holding more than one page of a source falls back to the windows, and the report says so', async () => {
  const windowed: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit-windows.json'));
  const replay = replayAsk(windowed.sources);
  const fromBlockOf = (r: SourceRequest) => (r.source === 'alchemy' ? BigInt(r.params.fromBlock as string) : BigInt(r.query.fromBlock as string));
  const yearStart = 26380800n - 2628000n + 1n;
  const asked: bigint[] = [];
  const ask = async (request: SourceRequest) => {
    asked.push(fromBlockOf(request));
    if (fromBlockOf(request) !== yearStart) return replay(request);
    return request.source === 'alchemy' ? { transfers: [], pageKey: 'more' } : { status: '1', message: 'OK', result: [] };
  };
  const { query } = windowed;
  const run = await pastTxs(
    { template: loadTemplate(ROOT, query.template, registry), anchor: { token: query.token as Address, kind: query.anchor as AnchorKind }, sampling: { kind: 'old-year' } },
    { ask, reader: replayReader(windowed.exchanges), registry, readMessage: replayMessages([]), exclude: undefined, maxTxs: query.maxTxs },
  );
  const text = renderPastTxs(run, registry);
  assert.match(text, /^whole year: blocks 23752801 to 26380800 hold more than one page of a source, so the windows are searched\nwindows: 12 of up to 7200 blocks/m);
  assert.equal(asked.filter((block) => block === yearStart).length, 2);
  assert.equal(text.replace(/^whole year: .*\n/m, ''), await report({ recorded: windowed }));
});

const recordedRun = (recorded: PastTxsRecording, sources: readonly SourceExchange[] = recorded.sources) => {
  const { query } = recorded;
  return pastTxs(
    {
      template: loadTemplate(ROOT, query.template, registry),
      anchor: { ...(query.token === undefined ? {} : { token: query.token as Address }), kind: 'event', event: anchorEvent(query.event as string) },
      sampling: samplingOf(query),
    },
    { ask: replayAsk(sources), reader: replayReader(recorded.exchanges), registry, readMessage: replayMessages([]), exclude: undefined, maxTxs: query.maxTxs },
  );
};

test('a year whose every answer fits one page is searched whole in one request, and sampled evenly by block', async () => {
  const year: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'whole-year.json'));
  assert.equal(year.query.wholeYear, true);
  assert.deepEqual(year.sources.map(({ request }) => (request.source === 'etherscan' ? [request.query.fromBlock, request.query.toBlock] : [])), [['23810401', '26438400']]);
  const run = await recordedRun(year);
  const text = renderPastTxs(run, registry);
  assert.match(text, /^whole year: blocks 23810401 to 26438400, every source's answer in one page, so the search covers the year with no gap; at most 12 studied, taken evenly in block order\n {2}blocks 23810401 to 26438400: 16 found, 12 studied\nsources: /m);
  assert.doesNotMatch(text, /^windows:/m);
  const logs = (year.sources[0]?.answer as { result: { transactionHash: string; blockNumber: string }[] }).result;
  const firstBlock = new Map<string, number>();
  for (const log of logs) if (!firstBlock.has(log.transactionHash)) firstBlock.set(log.transactionHash, Number(log.blockNumber));
  const byBlock = [...firstBlock.keys()].sort((a, b) => (firstBlock.get(a) as number) - (firstBlock.get(b) as number));
  assert.deepEqual(new Set(run.studies.map((s) => s.hash)), new Set(Array.from({ length: 12 }, (_, i) => byBlock[Math.floor((i * 16) / 12)])));
});

test('the report takes a recording that asked the whole year first, or searched an event with no token, and refuses a transfer anchor with no token', () => {
  const year: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'whole-year.json'));
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-past-txs-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'testdata', 'research'), { recursive: true });
  const write = (name: string, query: PastTxsRecording['query']) => writeFileSync(join(root, 'testdata', 'research', `${name}.json`), summaryOf(query));
  const { token: _, ...anyContract } = year.query;
  const { event: __, ...anyTransfer } = anyContract;
  write('whole-year', year.query);
  write('any-contract', anyContract);
  const subject = { template: { id: year.query.template }, vault: undefined } as unknown as Subject;
  assert.deepEqual(pastTxsRecordings(root, subject).map((r) => r.file), ['testdata/research/any-contract.json', 'testdata/research/whole-year.json']);
  write('any-transfer', { ...anyTransfer, anchor: 'any' });
  assert.throws(() => pastTxsRecordings(root, subject), /any-transfer\.json: its name or query holds a value `pnpm past-txs --record` never writes/);
});

test('an event searched over every contract is studied only where the sending Safe logged it itself', async () => {
  const anyContract: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'any-contract.json'));
  assert.equal(anyContract.query.token, undefined);
  const fit = '0xbbacd35d8517f742df5e20dea15c4504782846b81d3ced4fdb36334dd088aeb4';
  const text = renderPastTxs(await recordedRun(anyContract), registry);
  assert.match(text, /^anchor: AddedOwner\(address\) logged by any contract, studied only where the sender logged it itself$/m);
  assert.match(text, /^ {2}blocks 24244400 to 24244600: 4 found, 3 studied$/m);
  assert.match(text, /^not studied, the event logged only by another contract than the sender: 1, e\.g\. 0x2b854e652f87b788a5220cfac9ad5cdc7488e497c65b4a1c4b249df5fb8582e0$/m);
  assert.match(text, /^fit the template's shape: 1 transaction from 1 Safe; misfits: 1 from 1 Safe$/m);
  assert.match(text, new RegExp(`^examples that fit: ${fit}$`, 'm'));
  const otherLogger = anyContract.sources.map(({ request, answer }) => {
    const { result } = answer as { result: { transactionHash: string; address: string }[] };
    return { request, answer: { ...(answer as object), result: result.map((log) => (log.transactionHash === fit ? { ...log, address: `0x${'5a'.repeat(20)}` } : log)) } };
  });
  const moved = renderPastTxs(await recordedRun(anyContract, otherLogger), registry);
  assert.match(moved, new RegExp(`^not studied, the event logged only by another contract than the sender: 2, e\\.g\\. .*${fit}`, 'm'));
  assert.match(moved, /^fit the template's shape: 0 transactions from 0 Safes; misfits: 1 from 1 Safe$/m);
});

test('the configured Safe is left out of every count and example, and never printed', async () => {
  const safe = safeOf(FIT);
  const text = await report({ exclude: safe });
  assert.match(text, /^sources: alchemy found 62, etherscan found 62; both 62, /m);
  assert.match(text, /^ {2}proven Safe: 0, from 0 Safes$/m);
  assert.doesNotMatch(text, new RegExp(`${safe.slice(2)}|${FIT}|${MISFIT}`, 'i'));
});

test('a transaction only one source found is still studied, and marked', async () => {
  const sources = recording.sources.map(({ request, answer }) =>
    request.source === 'etherscan'
      ? { request, answer: { ...(answer as object), result: (answer as { result: { transactionHash: string }[] }).result.filter((log) => log.transactionHash !== FIT) } }
      : { request, answer },
  );
  const text = await report({ sources });
  assert.match(text, /^sources: alchemy found 65, etherscan found 64; both 64, only alchemy 1, only etherscan 0$/m);
  assert.match(text, new RegExp(`^ {2}only alchemy: ${FIT}$`, 'm'));
  assert.match(text, new RegExp(`^examples that fit: ${FIT} \\[only alchemy\\], `, 'm'));
});

test('a transaction a provider would not serve is unreadable for that reason, apart from one the providers disagree on', async () => {
  const exchanges = recording.exchanges.map((e) => {
    if (e.method !== 'eth_getTransactionByHash') return e;
    if (JSON.stringify(e.params) === JSON.stringify([FIT])) return { ...e, answers: { alchemy: e.answers.alchemy }, statuses: { drpc: 429 } };
    if (JSON.stringify(e.params) === JSON.stringify([MISFIT])) return { ...e, answers: { ...e.answers, drpc: { ...(e.answers.drpc as object), nonce: '0x0' } } };
    return e;
  });
  const text = await report({ exchanges });
  assert.match(text, new RegExp(`^ {2}1 unreadable, eth_getTransactionByHash: drpc failed \\(rate-limited\\): ${FIT}$`, 'm'));
  assert.match(text, new RegExp(`^ {2}1 unreadable, eth_getTransactionByHash: alchemy and drpc disagree: ${MISFIT}$`, 'm'));
});

test("a recording keeps the configured Safe's found transactions with its address removed, and replays the run that left them out", async () => {
  const safe = safeOf(FIT);
  const { query } = recording;
  const run = (exclude: Address | undefined, recorded: PastTxsRecording) =>
    pastTxs(
      { template: loadTemplate(ROOT, query.template, registry), anchor: { token: query.token as Address, kind: query.anchor as AnchorKind }, sampling: samplingOf(query) },
      {
        ask: replayAsk(recorded.sources),
        reader: replayReader(recorded.exchanges),
        registry,
        readMessage: replayMessages([]),
        exclude,
        maxTxs: query.maxTxs,
        excludedByRecording: { found: new Set(recorded.excluded?.found ?? []), sampled: new Set(recorded.excluded?.sampled ?? []) },
      },
    );
  const live = await run(safe, recording);
  assert.ok(live.excluded.found.has(FIT as Hex));
  const written = scrubRecording(recording, [safe], live.excluded);
  const text = JSON.stringify(written);
  assert.doesNotMatch(text, new RegExp(safe.slice(2), 'i'));
  assert.ok(text.includes(FIT), 'the Safe\'s transaction is kept by hash');
  assert.deepEqual(written.excluded?.found, [...live.excluded.found]);
  assert.equal(renderPastTxs(await run(undefined, written), registry), renderPastTxs(live, registry));
});

test("a transaction the configured Safe sent, found without its address in the search, is left out after sampling and replays left out without a chain read", async () => {
  const year: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'whole-year.json'));
  const senders = year.exchanges.filter((e) => e.method === 'eth_getTransactionByHash').map((e) => (e.answers.alchemy as { to: string }).to.toLowerCase());
  const safe = senders.find((to, i) => senders.indexOf(to) !== i) as Address;
  const { query } = year;
  const run = (exclude: Address | undefined, recorded: PastTxsRecording) =>
    pastTxs(
      { template: loadTemplate(ROOT, query.template, registry), anchor: { token: query.token as Address, kind: 'event', event: anchorEvent(query.event as string) }, sampling: samplingOf(query) },
      {
        ask: replayAsk(recorded.sources),
        reader: replayReader(recorded.exchanges),
        registry,
        readMessage: replayMessages([]),
        exclude,
        maxTxs: query.maxTxs,
        excludedByRecording: { found: new Set(recorded.excluded?.found ?? []), sampled: new Set(recorded.excluded?.sampled ?? []) },
      },
    );
  const live = await run(safe, year);
  assert.ok(live.excluded.sampled.size > 0);
  const written = scrubRecording(year, [safe], live.excluded);
  assert.doesNotMatch(JSON.stringify(written), new RegExp(safe.slice(2), 'i'));
  for (const hash of live.excluded.sampled) assert.ok(JSON.stringify(written.sources).includes(hash), 'its search entry keeps its place and hash');
  assert.equal(renderPastTxs(await run(undefined, written), registry), renderPastTxs(live, registry));
});

test('a recording that would name the configured Safe loses those entries, or is refused', () => {
  const safe = `0x${'5a'.repeat(20)}`;
  const none = { found: new Set<never>(), sampled: new Set<never>() };
  assert.throws(() => scrubRecording({ ...recording, query: { ...recording.query, token: safe } }, [safe], none), /still holds the configured Safe's address; nothing written/);
  const upper = scrubRecording({ ...recording, sources: [{ request: recording.sources[0]!.request, answer: { transfers: [{ hash: FIT, from: `0x${'5A'.repeat(20)}`, to: safe }] } }] }, [safe], none);
  assert.doesNotMatch(JSON.stringify(upper), /5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a/i);
});

test('a template whose trailer allowance is shorter than real use lists those transactions as misfits, with the reason', async () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'morpho', 'vault-deposit', 'template.json'), 'utf8'));
  raw.calls[1].trailer.maxBytes = 1;
  const text = await report({ template: parseTemplate(raw, registry) });
  assert.match(text, /^fit the template's shape: 0 transactions from 0 Safes; misfits: 3 from 1 Safe$/m);
  assert.match(text, /^ {2}2 from 1 Safe: more bytes after the arguments than the template allows, at multiSend\[1\]$/m);
});

test('a transaction whose leaf the template binds to the Safe holds another address is a misfit naming that leaf', async () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'morpho', 'vault-deposit', 'template.json'), 'utf8'));
  raw.calls[0].args.spender = { safe: true };
  const text = await report({ template: parseTemplate(raw, registry) });
  assert.match(text, /^fit the template's shape: 0 transactions from 0 Safes; misfits: 3 from 1 Safe$/m);
  assert.match(text, /^ {2}2 from 1 Safe: multiSend\[0\]\.approve\.spender: not the sender$/m);
});

test('a call to another contract than the template binds is named by that contract, even where a rule also breaks', async () => {
  const bundler3 = (registry.entries.get('bundler3')?.address as Address).slice(2).toLowerCase();
  const safe = safeOf(FIT).slice(2).toLowerCase();
  const exchanges = recording.exchanges.map((e) =>
    e.method === 'eth_getTransactionByHash' && JSON.stringify(e.params) === JSON.stringify([FIT])
      ? { ...e, answers: Object.fromEntries(Object.entries(e.answers).map(([p, a]) => [p, { ...(a as object), input: (a as { input: string }).input.replaceAll(bundler3, 'de'.repeat(20)).replaceAll(safe, 'ef'.repeat(20)) }])) }
      : e,
  );
  const text = await report({ exchanges });
  assert.match(text, new RegExp(`^ {2}1 from 1 Safe: multiSend\\[1\\]\\.to: expected bundler3, got 0x(de){20}\\n {4}e\\.g\\. ${FIT}$`, 'im'));
});

test('two leaves bound to one card value that hold different values make the transaction a misfit naming both', async () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'morpho', 'vault-deposit', 'template.json'), 'utf8'));
  raw.calls[1].args.bundle.items[0].fields.value = { card: 'amount' };
  const text = await report({ template: parseTemplate(raw, registry) });
  assert.match(text, /^fit the template's shape: 0 transactions from 0 Safes; misfits: 3 from 1 Safe$/m);
  assert.match(text, /^ {2}2 from 1 Safe: \S+: differs from \S+$/m);
});

test('an EOA making one call is not judged by an equals rule naming a leaf of a call it did not make', async () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'morpho', 'vault-deposit', 'template.json'), 'utf8'));
  raw.calls[1].args.bundle.items[1].fields.data.call.args.assets = { equals: 'calls[0].args.value' };
  const text = await report({ template: parseTemplate(raw, registry) });
  assert.match(text, /^fit the template's shape: 2 transactions from 1 Safe; misfits: 1 from 1 Safe$/m);
  assert.match(text, /^by EOAs, call 2 of 2 \(multicall\) as its own transaction:\nfit the call's shape: 2 transactions from 2 EOAs; /m);
});

test('an anchor with a sender asks both sources only for transfers out of it, and the report names it', async () => {
  const claims: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'merkl-claim.json'));
  const text = await report({ recorded: claims });
  assert.match(text, /^anchor: Transfer of morpho 0x58D97B57BB95320F9a05dC918Aef65434969c2B2 moved out of merkl-distributor$/m);
  assert.match(text, /^ {2}blocks 24020000 to 24030000: 120 found, 120 studied$/m);
  assert.match(text, /^sources: alchemy found 120, etherscan found 120; both 120, /m);
  assert.match(text, /^fit the template's shape: 1 transaction from 1 Safe; misfits: 2 from 2 Safes$/m);
  const { from, ...unfiltered } = claims.query;
  assert.ok(from !== undefined);
  await assert.rejects(report({ recorded: { ...claims, query: unfiltered } }), /request not recorded/);
});

const LOAN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address;
const LENDING = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb' as Address;
const DISTRIBUTOR = '0x3ef3d8ba38ebe18db133cec108f4d14ce00dd9ae' as Address;

/** The requests a search sends for `anchor`, each answered as finding nothing. */
async function requestsFor(anchor: Omit<Anchor, 'token' | 'kind' | 'fromBlock' | 'toBlock'>): Promise<SourceRequest[]> {
  const sent: SourceRequest[] = [];
  await searchBoth({ token: LOAN, kind: 'any', fromBlock: 10n, toBlock: 20n, ...anchor }, async (request) => {
    sent.push(request);
    return request.source === 'alchemy' ? { transfers: [] } : { status: '0', message: 'No records found', result: [] };
  });
  return sent;
}

async function searchBoth(anchor: Anchor, ask: Ask): Promise<Hits> {
  const found = await search(anchor, ask, 1, 'short');
  if (found.kind !== 'covered') throw new Error(`${found.sources.join(' and ')} overflowed`);
  return found.hits;
}

const word = (address: Address): string => `0x${'00'.repeat(12)}${address.slice(2)}`;
const alchemyBase = { fromBlock: '0xa', toBlock: '0x14', contractAddresses: [LOAN], category: ['erc20'], excludeZeroValue: false, withMetadata: false, order: 'asc', maxCount: '0x3e8' };
const etherscanBase = { chainid: '1', module: 'logs', action: 'getLogs', address: LOAN, fromBlock: '10', toBlock: '20', topic0: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' };

test('--to searches transfers into the address: toAddress on Alchemy, the second topic on Etherscan', async () => {
  assert.deepEqual(await requestsFor({ to: LENDING }), [
    { source: 'alchemy', params: { ...alchemyBase, toAddress: LENDING } },
    { source: 'etherscan', query: { ...etherscanBase, topic0_2_opr: 'and', topic2: word(LENDING), offset: '1000', page: '1' } },
  ]);
});

test('--from with --to searches transfers from one address into the other, every topic joined by and', async () => {
  assert.deepEqual(await requestsFor({ from: DISTRIBUTOR, to: LENDING }), [
    { source: 'alchemy', params: { ...alchemyBase, fromAddress: DISTRIBUTOR, toAddress: LENDING } },
    {
      source: 'etherscan',
      query: { ...etherscanBase, topic0_1_opr: 'and', topic1: word(DISTRIBUTOR), topic0_2_opr: 'and', topic2: word(LENDING), topic1_2_opr: 'and', offset: '1000', page: '1' },
    },
  ]);
});

test('--from alone sends the query it always sent, so its recordings still replay', async () => {
  assert.deepEqual(
    (await requestsFor({ from: DISTRIBUTOR })).map((r) => JSON.stringify(r)),
    [
      JSON.stringify({ source: 'alchemy', params: { ...alchemyBase, fromAddress: DISTRIBUTOR } }),
      JSON.stringify({ source: 'etherscan', query: { ...etherscanBase, topic0_1_opr: 'and', topic1: word(DISTRIBUTOR), offset: '1000', page: '1' } }),
    ],
  );
});

test('the report names where the anchor transfers move', async () => {
  const template = loadTemplate(ROOT, 'erc20/transfer', registry);
  const run = (anchor: Omit<Anchor, 'token' | 'kind' | 'fromBlock' | 'toBlock'>) =>
    pastTxs(
      { template, anchor: { token: LOAN, kind: 'any', ...anchor }, sampling: { kind: 'range', range: { fromBlock: 10n, toBlock: 20n } } },
      { ask: async (r) => (r.source === 'alchemy' ? { transfers: [] } : { status: '0', message: 'No records found' }), reader: replayReader([]), registry, readMessage: replayMessages([]), exclude: undefined, maxTxs: 12 },
    );
  assert.match(renderPastTxs(await run({ to: LENDING }), registry), /^anchor: Transfer of usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 moved into morpho-blue$/m);
  assert.match(renderPastTxs(await run({ from: DISTRIBUTOR, to: LENDING }), registry), /moved out of merkl-distributor into morpho-blue$/m);
});

test('--to goes with --anchor any only', () => {
  const run = spawnSync(process.execPath, [join(SCRIPTS, 'past-txs.ts'), 'morpho/vault-deposit', '--token', 'steakhouse-prime-usdc-v2-0f51', '--anchor', 'mint', '--to', 'bundler3'], { encoding: 'utf8' });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /--to goes with --anchor any/);
});

test("a Safe's transaction that makes none of the template's calls is another operation, counted on its own and not among the misfits", async () => {
  const transfers: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'erc20-transfer.json'));
  const text = await report({ recorded: transfers });
  assert.match(
    text,
    /^by proven Safes, the whole template in one transaction:\nanother operation, making none of the template's calls: 1 transaction from 1 Safe; not counted below\n {2}e\.g\. 0x76b2080d079470fd25ea8724b2aaf1f1d951e50ec48501d990f500105d3901bb: calls 0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2\.0x1d7d4ebc\nfit the template's shape: 1 transaction from 1 Safe; misfits: 0 from 0 Safes\n {2}exactly the template: 0 from 0 Safes; outside the registry: 1 from 1 Safe \(a token outside the registry at call\.to in 1\)$/m,
  );
  assert.doesNotMatch(text, /^misfits, by reason:\n {2}1 from 1 Safe: calls /m);
});

/** The deposit template stating no amount, so the study reads only what this recording, made before amounts were measured, holds. */
const noAmounts = (): Template => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'morpho', 'vault-deposit', 'template.json'), 'utf8'));
  return parseTemplate({ ...raw, effects: { ...raw.effects, gives: [] } }, registry);
};

function replayDroppingDrpc(hash: string, fails: number): Transport {
  const replay = replayTransport(withBlockTimes(recording.exchanges), REPLAY_ENDPOINTS);
  let left = fails;
  return async (url, body, signal) => {
    if (url === REPLAY_ENDPOINTS[1].url && body.includes(hash) && left-- > 0) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return replay(url, body, signal);
  };
}

test('a read that fails on the way is asked again, so a dropped connection that heals changes nothing', async () => {
  const unread: string[] = [];
  const reader = createReader(REPLAY_ENDPOINTS, replayDroppingDrpc(FIT, 2), { retryPausesMs: [0, 0], note: (read) => void unread.push(read) });
  assert.equal(await report({ reader, template: noAmounts() }), await report({ reader: replayReader(withBlockTimes(recording.exchanges)), template: noAmounts() }));
  assert.deepEqual(unread, []);
});

test('a read that still fails on the way after every retry is named, and --record refuses to keep the study', async () => {
  const unread: string[] = [];
  const reader = createReader(REPLAY_ENDPOINTS, replayDroppingDrpc(FIT, Infinity), { retryPausesMs: [0, 0], note: (read) => void unread.push(read) });
  const text = await report({ reader, template: noAmounts() });
  assert.match(text, new RegExp(`^ {2}1 unreadable, eth_getTransactionByHash: drpc failed \\(unreachable\\): ${FIT}$`, 'm'));
  assert.deepEqual(unread, ['drpc eth_getTransactionByHash: unreachable']);
  assert.equal(unreadRefusal(unread), '1 read(s) got no answer after every retry, so nothing is recorded; run the command again later:\n  drpc eth_getTransactionByHash: unreachable');
});

test('a recording\'s head places the spread windows without reading the chain head, so a run again searches the same windows', async () => {
  const windowed: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit-windows.json'));
  const head = await replayReader(windowed.exchanges).blockNumber();
  assert.equal(head.kind, 'agreed');
  const kept = { ...windowed, query: { ...windowed.query, head: String(head.kind === 'agreed' ? head.value : '') } };
  const noHead = { ...replayReader(windowed.exchanges), blockNumber: () => assert.fail('the head block is not read again') };
  assert.equal(await report({ recorded: kept, reader: noHead }), await report({ recorded: windowed }));
});

const pastTxsRun = (...args: string[]) =>
  spawnSync(process.execPath, [join(SCRIPTS, 'past-txs.ts'), 'morpho/vault-deposit', '--token', 'steakhouse-prime-usdc-v2-0f51', '--anchor', 'mint', ...args], { encoding: 'utf8' });

test('--same-windows-as goes with the spread windows only, not with a block range', () => {
  const run = pastTxsRun('--same-windows-as', 'morpho-vault-deposit-windows', '--from-block', '1', '--to-block', '2');
  assert.equal(run.status, 64);
  assert.match(run.stderr, /--same-windows-as <name>/);
});

test('--same-windows-as refuses a recording of one block range, and a name with no recording', () => {
  const old = runOffline('past-txs.ts', ['morpho/vault-deposit', '--token', 'steakhouse-prime-usdc-v2-0f51', '--anchor', 'mint', '--same-windows-as', 'morpho-vault-deposit'], 'research', { exchanges: [] }, ['morpho-vault-deposit.json'], undefined, SUMMARY_FIXTURES);
  assert.equal(old.status, 64);
  assert.equal(old.stderr, '--same-windows-as morpho-vault-deposit: the summary searched one block range and keeps no head block, so it has no windows to search again\n');
  const missing = pastTxsRun('--same-windows-as', 'no-such-study');
  assert.equal(missing.status, 64);
  assert.equal(missing.stderr, '--same-windows-as no-such-study: no summary testdata/research/no-such-study.json\n');
});

test('a free number is summarized by nearest rank: the smallest, the 50th, 90th and 99th percentile, and the largest', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => BigInt(100 - i));
  assert.deepEqual(spreadOf(hundred), { count: 100, min: 1n, percentiles: [50n, 90n, 99n], max: 100n });
  assert.deepEqual(spreadOf([7n, -3n, 1800n]), { count: 3, min: -3n, percentiles: [7n, 1800n, 1800n], max: 1800n });
  assert.equal(spreadOf([]), undefined);
});

test('an event anchor is searched by Etherscan alone, under the topic of its canonical signature', async () => {
  const asked: SourceRequest[] = [];
  const ask: Ask = async (request) => {
    asked.push(request);
    return { status: '1', message: 'OK', result: [{ transactionHash: `0x${'ab'.repeat(32)}`, topics: [`0x${'00'.repeat(32)}`, `0x${'00'.repeat(12)}${'11'.repeat(20)}`] }] };
  };
  const event = anchorEvent('PreSignature(address indexed owner, bytes orderUid, bool signed)');
  assert.deepEqual(event, { signature: 'PreSignature(address,bytes,bool)', topic: '0x01bf7c8b0ca55deecbea89d7e58295b7ffbf685fd0d96801034ba8c6ffe1c68d' });
  const hits = await searchBoth({ token: `0x${'90'.repeat(20)}` as Address, kind: 'event', event, fromBlock: 1n, toBlock: 2n }, ask);
  assert.deepEqual(asked.map((r) => r.source), ['etherscan']);
  assert.equal(asked[0]?.source === 'etherscan' ? asked[0].query.topic0 : undefined, event.topic);
  assert.deepEqual(hits, { alchemy: [], etherscan: [{ hash: `0x${'ab'.repeat(32)}`, from: `0x${'11'.repeat(20)}`, to: `0x${'00'.repeat(20)}` }] });
});

test('an event with no --token is searched by its topic alone over every contract, keeping the contract that logged each', async () => {
  const asked: SourceRequest[] = [];
  const emitter = `0x${'5a'.repeat(20)}`;
  const ask: Ask = async (request) => {
    asked.push(request);
    return { status: '1', message: 'OK', result: [{ address: emitter, blockNumber: '0x10', transactionHash: `0x${'ab'.repeat(32)}`, topics: [`0x${'00'.repeat(32)}`], data: '0x' }] };
  };
  const event = anchorEvent('AddedOwner(address)');
  const recorder = recordingAsk(ask);
  const hits = await searchBoth({ kind: 'event', event, fromBlock: 1n, toBlock: 2n }, recorder.ask);
  assert.equal(asked.length, 1);
  assert.ok(asked[0]?.source === 'etherscan' && !('address' in asked[0].query) && asked[0].query.topic0 === event.topic);
  assert.deepEqual(hits.etherscan, [{ hash: `0x${'ab'.repeat(32)}`, from: `0x${'00'.repeat(20)}`, to: `0x${'00'.repeat(20)}`, block: 16n, emitter }]);
  assert.deepEqual(await searchBoth({ kind: 'event', event, fromBlock: 1n, toBlock: 2n }, replayAsk(recorder.exchanges())), hits);
});

test('--event goes only with --anchor event, and --anchor event needs it', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [join(SCRIPTS, 'past-txs.ts'), 'cow/swap', '--token', 'gpv2-settlement', ...args], { encoding: 'utf8' });
  for (const args of [['--anchor', 'event'], ['--anchor', 'any', '--event', 'PreSignature(address,bytes,bool)']]) {
    const refused = run(...args);
    assert.equal(refused.status, 64);
    assert.equal(refused.stderr, '--event goes with --anchor event, and --anchor event needs --event\n');
  }
});

const cow: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'cow-swap-presign.json'));

async function cowRun(options: { time?: boolean; withinSeconds?: number; messages?: PastTxsRecording['messages']; reader?: Reader } = {}) {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'cow', 'swap', 'template.json'), 'utf8'));
  const fields = raw.calls[0].args.orderUid.packed[0].rule.eip712.fields;
  if (options.time === true) fields.validTo = { free: { time: { en: 'When the order expires.', 'zh-TW': '訂單到期的時間。' } } };
  if (options.withinSeconds !== undefined) fields.validTo = { withinSeconds: options.withinSeconds };
  const { query } = cow;
  return pastTxs(
    { template: parseTemplate(raw, registry), anchor: { token: query.token as Address, kind: 'event', event: anchorEvent(query.event as string) }, sampling: samplingOf(query) },
    { ask: replayAsk(cow.sources), reader: options.reader ?? replayReader(cow.exchanges), registry, readMessage: replayMessages(options.messages ?? cow.messages ?? []), exclude: undefined, maxTxs: query.maxTxs },
  );
}

test('a signed message read from the lookup is studied member by member, so an order paying its own Safe fits', async () => {
  const text = renderPastTxs(await cowRun(), registry);
  assert.match(text, /^anchor: PreSignature\(address,bytes,bool\) logged by gpv2-settlement 0x9008D19f58AAbD9eD0D60971565AA8510560ab41$/m);
  assert.match(text, /^sources: etherscan found \d+; alchemy does not search an event/m);
  const fits = /^fit the template's shape: (\d+) transactions from \d+ Safes;/m.exec(text)?.[1];
  assert.ok(Number(fits) > 0, 'some Safe orders fit');
  assert.match(text, new RegExp(`digest\\.receiver {2}\\[the Safe\\]\\n {4}equalled the Safe in ${fits} of ${fits} `));
});

test('a transaction whose signed message the recording does not hold is unreadable, saying where it was read from', async () => {
  const text = renderPastTxs(await cowRun({ messages: [] }), registry);
  assert.match(text, /^ {2}\d+ unreadable, no Order read from api\.cow\.fi: not recorded: 0x[0-9a-f]{64}/m);
  assert.match(text, /^fit the template's shape: 0 transactions from 0 Safes;/m);
});

test('a free number declared a time is spread less the time of the block each transaction ran in', async () => {
  const run = await cowRun();
  const reader = replayReader(cow.exchanges);
  const fits = run.studies.filter((s) => s.kind === 'fit' && s.sender.kind === 'safe');
  const relative = await Promise.all(
    fits.map(async (fit) => {
      if (fit.kind !== 'fit') throw new Error('a fit');
      const block = await reader.block(fit.block);
      const header = block.kind === 'agreed' ? await reader.header(block.value) : undefined;
      const time = header?.kind === 'agreed' ? header.value.time : assert.fail('the block time is recorded');
      return BigInt(fit.values[fit.paths.findIndex((p) => p.endsWith('digest.validTo'))] as string) - time;
    }),
  );
  const spread = spreadOf(relative);
  assert.ok(spread !== undefined);
  const text = renderPastTxs(await cowRun({ time: true }), registry);
  const expected = `less the block's time, in seconds: ${spread.count} transactions, min ${spread.min}, p50 ${spread.percentiles[0]}, p90 ${spread.percentiles[1]}, p99 ${spread.percentiles[2]}, max ${spread.max}`;
  assert.ok(text.includes(`digest.validTo  [free]\n    values: ${expected}\n`), expected);
});

test('a time whose block the recording does not hold is counted as not recorded, not guessed', async () => {
  const reader = replayReader(cow.exchanges.filter((e) => e.method !== 'eth_getBlockByHash'));
  const text = renderPastTxs(await cowRun({ time: true, reader }), registry);
  assert.match(text, /digest\.validTo {2}\[free\]\n {4}values: less the block's time: none; block time not recorded for \d+\n/);
});

test('an order expiring later than withinSeconds after its block is a misfit with that reason, and the fits spread within the bound', async () => {
  const relative = (run: Awaited<ReturnType<typeof cowRun>>) =>
    run.studies.flatMap((s) => (s.kind === 'fit' && s.sender.kind === 'safe' && s.time !== undefined ? [BigInt(s.values[s.paths.findIndex((p) => p.endsWith('digest.validTo'))] as string) - s.time] : []));
  const all = relative(await cowRun({ time: true }));
  const later = all.filter((seconds) => seconds > 1800n).length;
  assert.ok(later > 0 && later < all.length, 'some recorded orders expire more than 30 minutes after their block, and some do not');
  const bounded = await cowRun({ withinSeconds: 1800 });
  const late = bounded.studies.filter((s) => s.kind === 'misfit' && s.sender.kind === 'safe' && s.reason.kind === 'late');
  assert.equal(late.length, later);
  const text = renderPastTxs(bounded, registry);
  assert.match(text, new RegExp(`^ {2}${later} from \\d+ Safes?: call\\.setPreSignature\\.orderUid\\.digest\\.validTo: more than 1800 seconds after its block's time$`, 'm'));
  const spread = spreadOf(relative(bounded));
  assert.ok(spread !== undefined && spread.max <= 1800n && spread.count === all.length - later);
  assert.ok(text.includes(`digest.validTo  [at most 1800 seconds after its block's time]\n    values: less the block's time, in seconds: ${spread.count} transactions, min ${spread.min}, `));
});

const VAULT = `0x${'9a'.repeat(20)}` as Address;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as Address;
const HEAD = 26438464n;
const [YEAR_FROM, YEAR_TO] = [23810401n, 26438400n];
const PROXY = recording.exchanges.find((e) => e.method === 'eth_getCode' && (e.params as unknown[])[0] === safeOf(FIT))?.answers.alchemy as Hex;
const SINGLETON = `0x${'00'.repeat(12)}d9db270c1b5e3bd161e8c8503c55ceabee709552` as Hex;

type Mint = { readonly hash: Hex; readonly from: Address; readonly to: Address; readonly block: bigint; readonly emitter: Address };
const nth = (i: number, prefix: string) => `0x${prefix}${(i + 1).toString(16).padStart(40 - prefix.length, '0')}` as Address;
const mints = (n: number): Mint[] =>
  Array.from({ length: n }, (_, i) => ({ hash: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex, from: nth(i, 'f'), to: nth(i, 'e'), block: YEAR_FROM + BigInt(i) * 10n, emitter: nth(i, 'c') }));
const hexBlock = (n: bigint) => `0x${n.toString(16)}`;

function yearAsk(listed: readonly Mint[], options: { endless?: boolean; etherscanRefusesPage?: number } = {}): { ask: Ask; asked: SourceRequest[] } {
  const asked: SourceRequest[] = [];
  const ask: Ask = async (request) => {
    asked.push(request);
    if (request.source === 'alchemy') {
      const inYear = request.params.fromBlock === hexBlock(YEAR_FROM);
      const page = request.params.pageKey === undefined ? 0 : Number(String(request.params.pageKey).slice(1));
      const of = inYear ? listed : [];
      const transfers = of.slice(page * 1000, (page + 1) * 1000).map((m) => ({ hash: m.hash, from: m.from, to: m.to, blockNum: hexBlock(m.block), value: 1 }));
      const more = inYear && (options.endless === true || (page + 1) * 1000 < of.length);
      return { transfers, ...(more ? { pageKey: `p${page + 1}` } : {}) };
    }
    const of = request.query.fromBlock === String(YEAR_FROM) ? listed : [];
    const page = Number(request.query.page) - 1;
    if (of === listed && page + 1 === options.etherscanRefusesPage) return { status: '0', message: 'NOTOK', result: 'Max rate limit reached' };
    const result = of.slice(page * 1000, (page + 1) * 1000).map((m) => ({ address: m.emitter, transactionHash: m.hash, topics: [etherscanBase.topic0, word(m.from), word(m.to)], blockNumber: hexBlock(m.block) }));
    return result.length === 0 ? { status: '0', message: 'No records found', result: [] } : { status: '1', message: 'OK', result };
  };
  return { ask, asked };
}

/** The time the fake chain gives a block: 12 seconds apart, block 26438400 at 2026-09-21T14:13:20Z. */
const timeOf = (block: bigint): bigint => 1_790_000_000n + (block - 26438400n) * 12n;

function chain(options: { safes?: readonly Address[]; singletonOnly?: readonly Address[]; unreadable?: readonly Address[] } = {}): { reader: Reader; exchanges: () => Exchange[] } {
  const transport: Transport = async (_url, body) => {
    const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
    const reply = (result: unknown) => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
    const listed = (list: readonly Address[] | undefined) => list?.includes(params[0] as Address) === true;
    if (method === 'eth_getBlockByNumber') return reply({ number: params[0], hash: `0x${BigInt(params[0] as string).toString(16).padStart(64, '0')}` });
    if (method === 'eth_getBlockByHash') {
      const number = BigInt(params[0] as string);
      return reply({ number: `0x${number.toString(16)}`, hash: params[0], timestamp: `0x${timeOf(number).toString(16)}`, gasLimit: '0x1c9c380', mixHash: `0x${'00'.repeat(32)}` });
    }
    if (method === 'eth_getStorageAt' && !listed(options.unreadable)) return reply(listed(options.safes) || listed(options.singletonOnly) ? SINGLETON : `0x${'00'.repeat(32)}`);
    if (method === 'eth_getCode') return reply(listed(options.safes) ? PROXY : '0x6000');
    return { status: 500, text: '' };
  };
  const recorder = recordingTransport(transport, REPLAY_ENDPOINTS);
  return { reader: createReader(REPLAY_ENDPOINTS, recorder.transport, { retryPausesMs: [], rateLimitPausesMs: [] }), exchanges: recorder.exchanges };
}

const yearRun = (ask: Ask, reader: Reader, options: { maxTxs?: number; exclude?: Address; anchor?: Omit<Anchor, 'fromBlock' | 'toBlock'>; sampling?: Parameters<typeof pastTxs>[0]['sampling']; excludedByRecording?: { found: Set<Hex>; sampled: Set<Hex> } } = {}) =>
  pastTxs(
    { template: loadTemplate(ROOT, 'morpho/vault-deposit', registry), anchor: options.anchor ?? { token: VAULT, kind: 'mint' }, sampling: options.sampling ?? { kind: 'year', pages: YEAR_PAGES, head: HEAD } },
    { ask, reader, registry, readMessage: replayMessages([]), exclude: options.exclude, maxTxs: options.maxTxs ?? 240, ...(options.excludedByRecording === undefined ? {} : { excludedByRecording: options.excludedByRecording }) },
  );

const studied = (run: Awaited<ReturnType<typeof pastTxs>>) => run.studies.map((s) => s.hash);

test('a year of 2500 mints is paged in 3 pages of each source, covering the year without the windows', async () => {
  const { ask, asked } = yearAsk(mints(2500));
  const run = await yearRun(ask, chain().reader);
  const text = renderPastTxs(run, registry);
  assert.match(text, /^whole year: blocks 23810401 to 26438400, alchemy in 3 pages and etherscan in 3 pages of up to 1000, so the search covers the year with no gap\n {2}blocks 23810401 to 26438400: 2500 found, 240 studied$/m);
  assert.match(text, /^sources: alchemy found 2500, etherscan found 2500; both 2500, /m);
  assert.doesNotMatch(text, /^windows:/m);
  assert.deepEqual(asked.map((r) => (r.source === 'alchemy' ? `alchemy ${r.params.pageKey ?? 'first'}` : `etherscan ${r.query.page}`)).sort(), ['alchemy first', 'alchemy p1', 'alchemy p2', 'etherscan 1', 'etherscan 2', 'etherscan 3']);
  assert.ok(asked.every((r) => (r.source === 'alchemy' ? r.params.fromBlock === hexBlock(YEAR_FROM) && r.params.toBlock === hexBlock(YEAR_TO) : r.query.fromBlock === String(YEAR_FROM))), 'only the year is asked');
});

test('a source whose next page answers "No records found" has finished, so the year is covered', async () => {
  const { ask } = yearAsk(mints(2000));
  const text = renderPastTxs(await yearRun(ask, chain().reader), registry);
  assert.match(text, /^whole year: blocks 23810401 to 26438400, alchemy in 2 pages and etherscan in 3 pages of up to 1000, so the search covers the year with no gap$/m);
  assert.match(text, /^ {2}blocks 23810401 to 26438400: 2000 found, 240 studied$/m);
});

test('a year still holding more after 10 pages of a source is searched in the windows, checks no party, and is recorded without its transfers, the finished source as finished', async () => {
  const listed = mints(2500);
  const { ask, asked } = yearAsk(listed, { endless: true });
  const recorder = recordingAsk(ask);
  const text = renderPastTxs(await yearRun(recorder.ask, chain().reader), registry);
  assert.match(text, /^whole year: blocks 23810401 to 26438400 hold more than 10 pages of 1000 in alchemy, so the windows are searched\nwindows: 12 of up to 7200 blocks/m);
  assert.doesNotMatch(text, /^anchor parties/m);
  assert.equal(asked.filter((r) => r.source === 'alchemy' && r.params.fromBlock === hexBlock(YEAR_FROM)).length, 10);
  const year = recorder.exchanges().filter(({ request }) => (request.source === 'alchemy' ? request.params.fromBlock === hexBlock(YEAR_FROM) : request.query.fromBlock === String(YEAR_FROM)));
  assert.equal(year.length, 13);
  assert.ok(listed.every((m) => !JSON.stringify(year).includes(m.hash)), 'no year transfer is kept');
  assert.deepEqual(
    year.filter(({ request }) => request.source === 'etherscan').map(({ answer }) => answer),
    Array.from({ length: 3 }, () => ({ status: '1', message: 'OK', result: [] })),
    'etherscan, which finished, keeps empty pages that read as finished',
  );
  assert.equal(renderPastTxs(await yearRun(replayAsk(recorder.exchanges()), replayReader([])), registry), text, 'the replay needs no chain read');
});

async function recordedAndReplayed(listed: readonly Mint[], onChain: ReturnType<typeof chain>, maxTxs: number) {
  const recorder = recordingAsk(yearAsk(listed).ask);
  const live = await yearRun(recorder.ask, onChain.reader, { maxTxs });
  const replayed = await yearRun(replayAsk(recorder.exchanges()), replayReader(onChain.exchanges()), { maxTxs });
  return { live, replayed, text: renderPastTxs(live, registry) };
}

test('every transaction minting to a proven Safe is studied, and the rest fill the remaining places evenly in block order, the same again from the recording', async () => {
  const listed = mints(100);
  const safeAt = [10, 50, 90];
  const safes = safeAt.map((i) => (listed[i] as Mint).to);
  const notProxy = (listed[20] as Mint).to;
  const { live, replayed, text } = await recordedAndReplayed(listed, chain({ safes, singletonOnly: [notProxy] }), 12);
  assert.match(text, /^anchor parties, the address minted to: 100, read at block 26438400: 3 proven Safes\nchosen to study: all 3 transactions with a proven Safe party, and 9 of the other 97, taken evenly in block order$/m);
  const rest = listed.filter((_, i) => !safeAt.includes(i));
  const restChosen = Array.from({ length: 9 }, (_, i) => rest[Math.floor((i * 97) / 9)] as Mint);
  const expected = listed.filter((m) => safeAt.some((i) => listed[i] === m) || restChosen.includes(m)).map((m) => m.hash);
  assert.deepEqual(studied(live), expected);
  assert.equal(renderPastTxs(replayed, registry), text);
  assert.deepEqual(studied(replayed), expected);
});

test('Safe-party transactions beyond three quarters of --max-txs are sampled, leaving the rest a quarter', async () => {
  const listed = mints(300);
  const run = await yearRun(yearAsk(listed).ask, chain({ safes: listed.slice(0, 200).map((m) => m.to) }).reader, { maxTxs: 240 });
  assert.match(renderPastTxs(run, registry), /^chosen to study: 180 of 200 transactions with a proven Safe party, and 60 of the other 100, taken evenly in block order$/m);
  const hashes = new Set(studied(run));
  assert.equal(listed.slice(0, 200).filter((m) => hashes.has(m.hash)).length, 180);
  assert.equal(listed.slice(200).filter((m) => hashes.has(m.hash)).length, 60);
});

test('the party checked is the side the anchor leaves open: minted to, burned from, the other side of --from or --to, or the logging contract', async () => {
  const listed = mints(5);
  const side = (key: 'from' | 'to' | 'emitter') => listed.map((m) => m[key]);
  const line = async (anchor: Omit<Anchor, 'fromBlock' | 'toBlock'>, safes: readonly Address[] = []) =>
    /^anchor parties.*$/m.exec(renderPastTxs(await yearRun(yearAsk(listed).ask, chain({ safes }).reader, { anchor }), registry))?.[0];
  const event = anchorEvent('PreSignature(address,bytes,bool)');
  assert.equal(await line({ token: VAULT, kind: 'mint' }, side('to')), 'anchor parties, the address minted to: 5, read at block 26438400: 5 proven Safes');
  assert.equal(await line({ token: VAULT, kind: 'burn' }, side('from')), 'anchor parties, the address burned from: 5, read at block 26438400: 5 proven Safes');
  assert.equal(await line({ token: VAULT, kind: 'any' }, side('from')), 'anchor parties, the address the token moved out of: 5, read at block 26438400: 5 proven Safes');
  assert.equal(await line({ token: VAULT, kind: 'any', to: LENDING }, side('from')), 'anchor parties, the address the token moved out of: 5, read at block 26438400: 5 proven Safes');
  assert.equal(await line({ token: VAULT, kind: 'any', from: DISTRIBUTOR }, side('to')), 'anchor parties, the address the token moved into: 5, read at block 26438400: 5 proven Safes');
  assert.equal(await line({ token: VAULT, kind: 'any', from: DISTRIBUTOR, to: LENDING }), 'anchor parties: not checked, --from and --to fix both sides of the transfer');
  assert.equal(await line({ kind: 'event', event }, side('emitter')), 'anchor parties, the contract that logged the event: 5, read at block 26438400: 5 proven Safes');
  assert.equal(await line({ token: VAULT, kind: 'event', event }), "anchor parties: not checked, a named contract's event has no party of fixed meaning");
});

test('the configured Safe minted to is never read, and its scrubbed recording replays the same choice', async () => {
  const listed = mints(40);
  const safe = (listed[5] as Mint).to;
  const other = (listed[30] as Mint).to;
  const onChain = chain({ safes: [safe, other] });
  const recorder = recordingAsk(yearAsk(listed).ask);
  const live = await yearRun(recorder.ask, onChain.reader, { exclude: safe, maxTxs: 12 });
  const text = renderPastTxs(live, registry);
  assert.doesNotMatch(JSON.stringify(onChain.exchanges()), new RegExp(safe.slice(2), 'i'), 'no chain read names the configured Safe');
  assert.match(text, /^anchor parties, the address minted to: 39, read at block 26438400: 1 proven Safe\nchosen to study: all 1 transaction with a proven Safe party, and 11 of the other 38, taken evenly in block order$/m);
  assert.doesNotMatch(text, new RegExp(`${safe.slice(2)}|${(listed[5] as Mint).hash}`, 'i'));
  const written = scrubRecording({ query: { template: 'morpho/vault-deposit', token: VAULT, anchor: 'mint', maxTxs: 12 }, sources: recorder.exchanges(), providers: [], exchanges: onChain.exchanges() }, [safe], live.excluded);
  assert.doesNotMatch(JSON.stringify(written), new RegExp(safe.slice(2), 'i'));
  const again = await yearRun(replayAsk(written.sources), replayReader(written.exchanges), { maxTxs: 12, excludedByRecording: { found: new Set(written.excluded?.found ?? []), sampled: new Set(written.excluded?.sampled ?? []) } });
  assert.equal(renderPastTxs(again, registry), text);
  assert.deepEqual(studied(again), studied(live));
});

test('a party whose slot cannot be read is counted unreadable, and its transactions go with the rest', async () => {
  const listed = mints(20);
  const run = await yearRun(yearAsk(listed).ask, chain({ safes: [(listed[3] as Mint).to], unreadable: [(listed[7] as Mint).to] }).reader, { maxTxs: 12 });
  assert.match(renderPastTxs(run, registry), /^anchor parties, the address minted to: 20, read at block 26438400: 1 proven Safe, 1 unreadable\nchosen to study: all 1 transaction with a proven Safe party, and 11 of the other 19, taken evenly in block order$/m);
  assert.ok(studied(run).includes((listed[3] as Mint).hash));
});

test('a recording of a paged year asks the same pages again, and one of the year in one page asks one page and checks no party', async () => {
  const listed = mints(2500);
  const first = yearAsk(listed);
  const recorder = recordingAsk(first.ask);
  const onChain = chain();
  const live = await yearRun(recorder.ask, onChain.reader, { sampling: { kind: 'year', pages: YEAR_PAGES, head: HEAD } });
  const fields = samplingFields(live.query.sampling, live.head);
  assert.deepEqual(fields, { head: String(HEAD), yearPages: YEAR_PAGES });
  const replay = replayAsk(recorder.exchanges());
  const asked: SourceRequest[] = [];
  const replayed = await yearRun((request) => (asked.push(request), replay(request)), replayReader(onChain.exchanges()), { sampling: samplingOf(fields) });
  assert.equal(renderPastTxs(replayed, registry), renderPastTxs(live, registry));
  assert.deepEqual(asked.map((r) => JSON.stringify(r)).sort(), first.asked.map((r) => JSON.stringify(r)).sort());

  const old = yearAsk(listed);
  const text = renderPastTxs(await yearRun(old.ask, replayReader([]), { sampling: samplingOf({ head: String(HEAD), wholeYear: true }) }), registry);
  assert.deepEqual(old.asked.filter((r) => (r.source === 'alchemy' ? r.params.fromBlock === hexBlock(YEAR_FROM) : r.query.fromBlock === String(YEAR_FROM))).map((r) => r.source).sort(), ['alchemy', 'etherscan']);
  assert.match(text, /^whole year: blocks 23810401 to 26438400 hold more than one page of a source, so the windows are searched$/m);
  assert.doesNotMatch(text, /^anchor parties/m);
});

test('the report refuses a recording whose yearPages goes with wholeYear, exceeds 10, or has no head block', () => {
  const year: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'whole-year.json'));
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-past-txs-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'testdata', 'research'), { recursive: true });
  const subject = { template: { id: year.query.template }, vault: undefined } as unknown as Subject;
  const { wholeYear: _, ...paged } = year.query;
  const { head: __, ...headless } = paged;
  const only = (query: PastTxsRecording['query']) => {
    rmSync(join(root, 'testdata', 'research'), { recursive: true, force: true });
    mkdirSync(join(root, 'testdata', 'research'), { recursive: true });
    writeFileSync(join(root, 'testdata', 'research', 'year.json'), summaryOf(query));
    return () => pastTxsRecordings(root, subject);
  };
  assert.deepEqual(only({ ...paged, yearPages: 10 })().map((r) => r.file), ['testdata/research/year.json']);
  for (const query of [{ ...paged, yearPages: 11 }, { ...paged, yearPages: 0 }, { ...year.query, yearPages: 10 }, { ...headless, yearPages: 10 }]) {
    assert.throws(only(query), /year\.json: its name or query holds a value `pnpm past-txs --record` never writes/, JSON.stringify(query));
  }
});

test('the report replays a paged year\'s party reads from the recording', async () => {
  const listed = mints(100);
  const recorder = recordingAsk(yearAsk(listed).ask);
  const onChain = chain({ safes: [10, 50, 90].map((i) => (listed[i] as Mint).to) });
  await yearRun(recorder.ask, onChain.reader, { maxTxs: 12 });
  const recorded: PastTxsRecording = {
    query: { template: 'morpho/vault-deposit', token: VAULT, anchor: 'mint', head: String(HEAD), yearPages: YEAR_PAGES, maxTxs: 12 },
    sources: recorder.exchanges(),
    providers: [],
    exchanges: onChain.exchanges(),
  };
  const offline = summarizePastTxs(ROOT, registry, 'year.json', await studyRecording(ROOT, recorded, registry));
  assert.match(offline.text, /^chosen to study: all 3 transactions with a proven Safe party, and 9 of the other 97, taken evenly in block order$/m);
});

test('with --max-txs not a multiple of 4 the rest keeps the quarter rounded up', async () => {
  const listed = mints(100);
  const run = await yearRun(yearAsk(listed).ask, chain({ safes: listed.slice(0, 20).map((m) => m.to) }).reader, { maxTxs: 13 });
  assert.match(renderPastTxs(run, registry), /^ {2}blocks 23810401 to 26438400: 100 found, 13 studied\n(?:.*\n)*chosen to study: 9 of 20 transactions with a proven Safe party, and 4 of the other 80, taken evenly in block order$/m);
});

test('the chosen line counts what the window line counts, after a sampled transaction touching the configured Safe is left out, and never says all 0', async () => {
  const listed = mints(40);
  const safeTx = (listed[30] as Mint).hash;
  const left = await yearRun(yearAsk(listed).ask, chain({ safes: [(listed[30] as Mint).to] }).reader, { maxTxs: 12, excludedByRecording: { found: new Set(), sampled: new Set([safeTx]) } });
  const text = renderPastTxs(left, registry);
  assert.match(text, /^ {2}blocks 23810401 to 26438400: 39 found, 11 studied$/m);
  assert.match(text, /^anchor parties, the address minted to: 40, read at block 26438400: 1 proven Safe\nchosen to study: no transaction with a proven Safe party, and 11 of the other 39, taken evenly in block order$/m);

  const few = mints(4);
  const allSafe = renderPastTxs(await yearRun(yearAsk(few).ask, chain({ safes: few.map((m) => m.to) }).reader, { maxTxs: 12 }), registry);
  assert.match(allSafe, /^chosen to study: all 4 transactions with a proven Safe party, and no other transaction, taken evenly in block order$/m);
  const unchecked = renderPastTxs(await yearRun(yearAsk([]).ask, chain().reader, { anchor: { token: VAULT, kind: 'any', from: DISTRIBUTOR, to: LENDING } }), registry);
  assert.match(unchecked, /^chosen to study: no transaction$/m);
});

test('Etherscan answering a full 10th page has not finished the year, so the windows are searched', async () => {
  const text = renderPastTxs(await yearRun(yearAsk(mints(10000)).ask, replayReader([])), registry);
  assert.match(text, /^whole year: blocks 23810401 to 26438400 hold more than 10 pages of 1000 in etherscan, so the windows are searched$/m);
  assert.doesNotMatch(text, /^anchor parties/m);
});

test('an Etherscan error in a year Alchemy did not finish searches the windows, and one in a year Alchemy finished stops the run', async () => {
  const listed = mints(2500);
  const over = renderPastTxs(await yearRun(yearAsk(listed, { endless: true, etherscanRefusesPage: 2 }).ask, replayReader([])), registry);
  assert.match(over, /^whole year: blocks 23810401 to 26438400 hold more than 10 pages of 1000 in alchemy, so the windows are searched$/m);
  await assert.rejects(yearRun(yearAsk(listed, { etherscanRefusesPage: 2 }).ask, replayReader([])), /^ResearchError: etherscan refused: NOTOK Max rate limit reached$/);
});

/** One mint every `every` blocks over the year, newest last. */
const spread = (every: bigint): Mint[] => {
  const listed: Mint[] = [];
  for (let block = YEAR_FROM, i = 0; block <= YEAR_TO; block += every, i++) listed.push({ hash: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex, from: ZERO_ADDRESS, to: nth(i % 50, 'e'), block, emitter: VAULT });
  return listed;
};

/**
 * Both sources over `listed` for any block range, in ascending block order as each lists: Alchemy by page key, Etherscan
 * by page number. With `etherscanDrops`, Etherscan leaves the last log out of the first page of every range, or out of
 * every page, so that page holds 999 though more follow, as it did for USDC moving into Uniswap's PoolManager.
 */
function rangeAsk(listed: readonly Mint[], options: { etherscanDrops?: 'first page' | 'every page' } = {}): { ask: Ask; asked: SourceRequest[] } {
  const asked: SourceRequest[] = [];
  const within = (from: bigint, to: bigint) => listed.filter((m) => m.block >= from && m.block <= to);
  const ask: Ask = async (request) => {
    asked.push(request);
    if (request.source === 'alchemy') {
      const of = within(BigInt(request.params.fromBlock as string), BigInt(request.params.toBlock as string));
      const page = request.params.pageKey === undefined ? 0 : Number(String(request.params.pageKey).slice(1));
      const transfers = of.slice(page * 1000, (page + 1) * 1000).map((m) => ({ hash: m.hash, from: m.from, to: m.to, blockNum: hexBlock(m.block) }));
      return { transfers, ...((page + 1) * 1000 < of.length ? { pageKey: `p${page + 1}` } : {}) };
    }
    const of = within(BigInt(request.query.fromBlock as string), BigInt(request.query.toBlock as string));
    const page = Number(request.query.page);
    const result = of.slice((page - 1) * 1000, page * 1000 - (options.etherscanDrops === 'every page' || (options.etherscanDrops === 'first page' && page === 1) ? 1 : 0)).map((m) => ({ transactionHash: m.hash, topics: [etherscanBase.topic0, word(m.from), word(m.to)], blockNumber: hexBlock(m.block) }));
    return result.length === 0 ? { status: '0', message: 'No records found', result: [] } : { status: '1', message: 'OK', result };
  };
  return { ask, asked };
}

const newestRun = (ask: Ask, reader: Reader, maxPages = 20, options: { maxTxs?: number } = {}) => yearRun(ask, reader, { sampling: { kind: 'recent', maxPages, head: HEAD }, ...options });

test('by default the search pages back from the head block newest first, the first range the whole year, so a quiet year is read whole', async () => {
  assert.deepEqual(DEFAULT_SAMPLING, { kind: 'recent', maxPages: MAX_PAGES });
  const listed = mints(2500);
  const { ask, asked } = rangeAsk(listed);
  const run = await newestRun(ask, chain({ safes: [(listed[7] as Mint).to] }).reader);
  const text = renderPastTxs(run, registry);
  assert.ok(asked.every((r) => (r.source === 'alchemy' ? r.params.fromBlock === hexBlock(YEAR_FROM) && r.params.toBlock === hexBlock(YEAR_TO) : r.query.fromBlock === String(YEAR_FROM) && r.query.toBlock === String(YEAR_TO))), 'only the year is asked');
  assert.match(text, /^whole year, newest first: blocks 23810401 to 26438400 \(2025-09-21 to 2026-09-21, 365\.0 days\), in 4 pages of up to 1000, so the search covers the year with no gap\n {2}blocks 23810401 to 26438400: 2500 found, 240 studied$/m);
  assert.match(text, /^anchor parties, the address minted to: 2500, read at block 26438400: 1 proven Safe$/m);
});

test('a year busier than the page cap is read newest first down to where the cap stops it, every transaction in that range and none below, and the report says so', async () => {
  const listed = spread(10n);
  const { ask } = rangeAsk(listed);
  const run = await newestRun(ask, chain().reader);
  const text = renderPastTxs(run, registry);
  assert.match(text, /^newest first: blocks 26378356 to 26438400 \(2026-09-13 to 2026-09-21, 8\.3 days\), every transaction in them; the search stopped at its cap of 20 pages of up to 1000, so blocks 23810401 to 26378355 of the last year are not searched\n {2}blocks 26378356 to 26438400: 6004 found, 240 studied$/m);
  const inRange = listed.filter((m) => m.block >= 26378356n);
  assert.equal(run.found.total, inRange.length);
  assert.match(text, /^sources: alchemy found 6004, etherscan found 6004; both 6004, only alchemy 0, only etherscan 0$/m);
  assert.doesNotMatch(text, /^windows:/m);
  const blocks = new Set(inRange.map((m) => m.hash));
  assert.ok(run.studies.every((s) => blocks.has(s.hash)), 'every study lies in the range read');
});

test("a page of Etherscan's listing holding fewer than 1000 is not its end in a newest-first search", async () => {
  const listed = mints(2500);
  const text = renderPastTxs(await newestRun(rangeAsk(listed, { etherscanDrops: 'first page' }).ask, chain().reader), registry);
  assert.match(text, new RegExp(`^sources: alchemy found 2500, etherscan found 2499; both 2499, only alchemy 1, only etherscan 0\\n {2}only alchemy: ${(listed[999] as Mint).hash}$`, 'm'));
});

test('a newest-first recording replays the same run from its answers, asking nothing it did not record, and its summary reads back the same', async () => {
  const listed = spread(10n);
  const recorder = recordingAsk(rangeAsk(listed).ask);
  const onChain = chain({ safes: [(listed.at(-3) as Mint).to] });
  const live = await newestRun(recorder.ask, onChain.reader, 20, { maxTxs: 12 });
  const fields = samplingFields(live.query.sampling, live.head);
  assert.deepEqual(fields, { head: String(HEAD), maxPages: 20 });
  const recorded: PastTxsRecording = { query: { template: 'morpho/vault-deposit', token: VAULT, anchor: 'mint', ...fields, maxTxs: 12 }, sources: recorder.exchanges(), providers: [], exchanges: onChain.exchanges() };
  const replayed = await newestRun(replayAsk(recorded.sources), replayReader(recorded.exchanges), 20, { maxTxs: 12 });
  assert.equal(renderPastTxs(replayed, registry), renderPastTxs(live, registry));
  const hits = foundBy(live.found, 'alchemy') + foundBy(live.found, 'etherscan');
  assert.ok(JSON.stringify(recorded.sources).length < recorded.sources.length * 3_000 + hits * 300, `${JSON.stringify(recorded.sources).length} bytes for ${recorded.sources.length} answers and ${hits} transfers`);
  const summary = await studyRecording(ROOT, recorded, registry);
  const text = summaryText(summary);
  assert.equal(summaryText(parseSummary('year.json', text)), text);
  assert.deepEqual(JSON.parse(text).search.coverage, { kind: 'recent', range: { fromBlock: '26378356', toBlock: '26438400' }, pages: 20, time: { from: String(timeOf(26378356n)), to: String(timeOf(26438400n)) } });
  assert.match(summarizePastTxs(ROOT, registry, 'year.json', summary).text, /^newest first: blocks 26378356 to 26438400 \(2026-09-13 to 2026-09-21, 8\.3 days\), every transaction in them; the search stopped at its cap of 20 pages/m);
});

test("a newest-first recording replays the same run and summary when a range runs over in both sources and Etherscan's last page asked holds fewer than 1000", async () => {
  const listed = spread(10n);
  const recorder = recordingAsk(rangeAsk(listed, { etherscanDrops: 'every page' }).ask);
  const onChain = chain();
  const live = await newestRun(recorder.ask, onChain.reader, 20, { maxTxs: 12 });
  const recorded: PastTxsRecording = { query: { template: 'morpho/vault-deposit', token: VAULT, anchor: 'mint', ...samplingFields(live.query.sampling, live.head), maxTxs: 12 }, sources: recorder.exchanges(), providers: [], exchanges: onChain.exchanges() };
  const replayed = await newestRun(replayAsk(recorded.sources), replayReader(recorded.exchanges), 20, { maxTxs: 12 });
  assert.equal(renderPastTxs(replayed, registry), renderPastTxs(live, registry));
  assert.match(renderPastTxs(live, registry), /^sources: alchemy found (\d+), etherscan found \d+; both \d+, only alchemy [1-9]\d*, /m, 'etherscan left logs out of its short pages');
  const summary = JSON.parse(summaryText(await studyRecording(ROOT, recorded, registry))) as { search: { coverage: unknown } };
  assert.deepEqual(summary.search.coverage, JSON.parse(JSON.stringify(live.search, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).coverage);
});

test('a newest-first summary is refused when its range does not end on the block the head places, a recent one starts at the year or took other than the cap, or its query holds another cap', async () => {
  const listed = spread(10n);
  const recorder = recordingAsk(rangeAsk(listed).ask);
  const onChain = chain();
  await newestRun(recorder.ask, onChain.reader, 20, { maxTxs: 12 });
  const recorded: PastTxsRecording = { query: { template: 'morpho/vault-deposit', token: VAULT, anchor: 'mint', head: String(HEAD), maxPages: 20, maxTxs: 12 }, sources: recorder.exchanges(), providers: [], exchanges: onChain.exchanges() };
  const json = JSON.parse(summaryText(await studyRecording(ROOT, recorded, registry))) as { query: Record<string, unknown>; search: { coverage: Record<string, unknown> } };
  const refused = (change: (copy: typeof json) => void, message: RegExp) => {
    const copy = JSON.parse(JSON.stringify(json)) as typeof json;
    change(copy);
    assert.throws(() => parseSummary('year.json', JSON.stringify(copy)), message);
  };
  refused((c) => void (c.search.coverage.range = { fromBlock: '26378356', toBlock: '26438399' }), /search\.coverage\.range\.toBlock: not 26438400, the block the head places/);
  refused((c) => void (c.search.coverage.range = { fromBlock: String(YEAR_FROM), toBlock: '26438400' }), /search\.coverage\.range\.fromBlock: not after 23810401, the year's first block/);
  refused((c) => void (c.search.coverage.kind = 'year'), /search\.coverage\.range\.fromBlock: not 23810401, the year's first block/);
  refused((c) => void (c.search.coverage.pages = 19), /search\.coverage\.pages: not 20, the cap that stops a search short of the year/);
  for (const maxPages of [19, MAX_PAGES + 1]) refused((c) => void (c.query.maxPages = maxPages), /its name or query holds a value `pnpm past-txs --record` never writes/);
  refused((c) => void (c.query.yearPages = 10), /its name or query holds a value `pnpm past-txs --record` never writes/);
});
