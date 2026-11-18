import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { unreadRefusal } from '../src/chain/https.ts';
import { createReader } from '../src/chain/reader.ts';
import type { Reader } from '../src/chain/reader.ts';
import { REPLAY_ENDPOINTS, replayReader, replayTransport } from '../src/chain/recording.ts';
import type { Transport } from '../src/chain/rpc.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Registry } from '../src/registry.ts';
import { DEFAULT_SPREAD, pastTxs, renderPastTxs, spreadOf } from '../src/research/past-txs.ts';
import { isWithheld, scrubRecording } from '../src/research/recording.ts';
import { replayMessages } from '../src/research/messages.ts';
import { pastTxsRecordings, pastTxsSampling } from '../src/research/report.ts';
import type { Subject } from '../src/research/report.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { anchorEvent, recordingAsk, replayAsk, searchBoth } from '../src/research/sources.ts';
import type { Anchor, AnchorKind, Ask, SourceExchange, SourceRequest } from '../src/research/sources.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const ROOT = repoWithTestFixtures();
const SCRIPTS = join(import.meta.dirname, '..', 'scripts');
const recording: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'research', 'morpho-vault-deposit.json'));
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
      sampling: pastTxsSampling(query),
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
  const windowed: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'research', 'morpho-vault-deposit-windows.json'));
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
    { template: loadTemplate(ROOT, query.template, registry), anchor: { token: query.token as Address, kind: query.anchor as AnchorKind }, sampling: pastTxsSampling(query) },
    { ask, reader: replayReader(windowed.exchanges), registry, readMessage: replayMessages([]), exclude: undefined, maxTxs: query.maxTxs },
  );
  const text = renderPastTxs(run, registry);
  assert.match(text, /^ {2}blocks 26377201 to 26380800: 45 found, 2 studied; halved, too many transfers in 26373601 to 26380800, so 26373601 to 26377200 not searched$/m);
  assert.equal(text.match(/halved/g)?.length, 1);
});

test('a recording keeps only what the search reads, so a busy token\'s halved windows, overflowing in either source alone, replay the same report at a size bounded by the answers and transfers found', async () => {
  for (const overflowing of ['alchemy', 'etherscan'] as const) {
    const windowed: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'research', 'morpho-vault-deposit-windows.json'));
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
        { template: loadTemplate(ROOT, query.template, registry), anchor: { token: query.token as Address, kind: query.anchor as AnchorKind }, sampling: pastTxsSampling(query) },
        { ask, reader: replayReader(windowed.exchanges), registry, readMessage: replayMessages([]), exclude: undefined, maxTxs: query.maxTxs },
      );
    const recorder = recordingAsk(live);
    const run = await study(recorder.ask);
    const recorded = recorder.exchanges();
    assert.equal(renderPastTxs(await study(replayAsk(recorded)), registry), renderPastTxs(run, registry));
    assert.match(renderPastTxs(run, registry), /halved, too many transfers in 26373601 to 26380800/);
    const hits = [...run.found.values()].reduce((n, sources) => n + sources.length, 0);
    assert.ok(JSON.stringify(recorded).length < recorded.length * 3_000 + hits * 300, `${JSON.stringify(recorded).length} bytes for ${recorded.length} answers and ${hits} transfers`);
  }
});

test('--max-txs below one transaction per window is refused', () => {
  const run = spawnSync(process.execPath, [join(SCRIPTS, 'past-txs.ts'), 'morpho/vault-deposit', '--token', 'steakhouse-prime-usdc-v2-0f51', '--anchor', 'mint', '--max-txs', '11'], { encoding: 'utf8' });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /--max-txs must be at least 12, one transaction per window/);
});

test('by default the windows are spread over the last year from the head block, and each window is sampled to its share', async () => {
  const windowed: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'research', 'morpho-vault-deposit-windows.json'));
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
  const windowed: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'research', 'morpho-vault-deposit-windows.json'));
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
    { template: loadTemplate(ROOT, query.template, registry), anchor: { token: query.token as Address, kind: query.anchor as AnchorKind }, sampling: { ...DEFAULT_SPREAD, wholeYear: true } },
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
      sampling: pastTxsSampling(query),
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
  const write = (name: string, query: PastTxsRecording['query']) => writeFileSync(join(root, 'testdata', 'research', `${name}.json`), JSON.stringify({ query, sources: [], providers: [], exchanges: [] }));
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

test('a recording keeps the hash of no transaction it did not study, and none the configured Safe sent or is named in, and replays the same', async () => {
  const windowed: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'research', 'morpho-vault-deposit-windows.json'));
  const { query } = windowed;
  const study = (ask: Ask, exclude: Address | undefined, excludedByRecording?: ReadonlySet<Hex>) =>
    pastTxs(
      { template: loadTemplate(ROOT, query.template, registry), anchor: { token: query.token as Address, kind: query.anchor as AnchorKind }, sampling: pastTxsSampling(query) },
      { ask, reader: replayReader(windowed.exchanges), registry, readMessage: replayMessages([]), exclude, maxTxs: query.maxTxs, ...(excludedByRecording === undefined ? {} : { excludedByRecording }) },
    );
  const plain = await study(replayAsk(windowed.sources), undefined);
  const studied = new Set(plain.studies.map((s) => s.hash));
  const transfers = windowed.sources.flatMap(({ answer }) => ((answer as { transfers?: { hash: string; to: string }[] }).transfers ?? []));
  const unsampled = transfers.find((t) => !studied.has(t.hash as Hex) && transfers.filter((u) => u.to === t.to).every((u) => !studied.has(u.hash as Hex))) as { hash: string; to: string };
  const safe = unsampled.to.toLowerCase() as Address;

  const recorder = recordingAsk(replayAsk(windowed.sources));
  const live = await study(recorder.ask, safe);
  const written = scrubRecording({ ...windowed, sources: recorder.exchanges() }, [safe], live);
  const text = JSON.stringify(written).toLowerCase();
  assert.doesNotMatch(text, new RegExp(safe.slice(2)));
  assert.ok(!text.includes(unsampled.hash.toLowerCase()), 'the unsampled transaction the configured Safe is named in is not recorded');
  const kept = new Set([...live.studies.map((s) => s.hash), ...live.otherEmitter]);
  const hashes = written.sources.flatMap(({ answer }) => [...((answer as { transfers?: { hash: Hex }[] }).transfers ?? []).map((t) => t.hash), ...((answer as { result?: { transactionHash?: Hex }[] }).result ?? []).flatMap((l) => (l.transactionHash === undefined ? [] : [l.transactionHash]))]);
  assert.ok(hashes.length > kept.size);
  for (const hash of hashes) assert.ok(kept.has(hash) || isWithheld(hash), `${hash} was not studied but is recorded`);
  const replayed = await study(replayAsk(written.sources), undefined, new Set(written.excluded ?? []));
  assert.equal(renderPastTxs(replayed, registry), renderPastTxs(live, registry));
  assert.throws(() => scrubRecording({ ...written, query: { ...written.query, token: safe } }, [safe], live), /still mentions the configured Safe/);
});

test('a sampled transaction the configured Safe sent, whose search entry names no address, is left out, and its withheld hash replays as left out without a chain read', async () => {
  const year: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'past-txs', 'whole-year.json'));
  const senders = year.exchanges.filter((e) => e.method === 'eth_getTransactionByHash').map((e) => (e.answers.alchemy as { to: string }).to.toLowerCase());
  const safe = senders.find((to, i) => senders.indexOf(to) !== i) as Address;
  const { query } = year;
  const run = (ask: Ask, exclude: Address | undefined, excludedByRecording: ReadonlySet<Hex>, exchanges = year.exchanges) =>
    pastTxs(
      { template: loadTemplate(ROOT, query.template, registry), anchor: { token: query.token as Address, kind: 'event', event: anchorEvent(query.event as string) }, sampling: pastTxsSampling(query) },
      { ask, reader: replayReader(exchanges), registry, readMessage: replayMessages([]), exclude, maxTxs: query.maxTxs, excludedByRecording },
    );
  const live = await run(replayAsk(year.sources), safe, new Set());
  const written = scrubRecording(year, [safe], live);
  assert.ok((written.excluded ?? []).length > 0 && (written.excluded ?? []).every(isWithheld));
  const text = JSON.stringify(written).toLowerCase();
  assert.ok(!text.includes(safe.slice(2)));
  const unstudied = [...live.excluded, ...[...live.found.keys()].filter((h) => !live.studies.some((s) => s.hash === h))].filter((h) => !isWithheld(h));
  assert.ok(unstudied.length > 0);
  for (const hash of unstudied) assert.ok(!text.includes(hash.toLowerCase()), `${hash} is recorded`);
  assert.equal(renderPastTxs(await run(replayAsk(written.sources), undefined, new Set(written.excluded), written.exchanges), registry), renderPastTxs(live, registry));
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
  const claims: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'research', 'merkl-claim.json'));
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
  const transfers: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'research', 'erc20-transfer.json'));
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
  const replay = replayTransport(recording.exchanges, REPLAY_ENDPOINTS);
  let left = fails;
  return async (url, body, signal) => {
    if (url === REPLAY_ENDPOINTS[1].url && body.includes(hash) && left-- > 0) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return replay(url, body, signal);
  };
}

test('a read that fails on the way is asked again, so a dropped connection that heals changes nothing', async () => {
  const unread: string[] = [];
  const reader = createReader(REPLAY_ENDPOINTS, replayDroppingDrpc(FIT, 2), { retryPausesMs: [0, 0], note: (read) => void unread.push(read) });
  assert.equal(await report({ reader, template: noAmounts() }), await report({ template: noAmounts() }));
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
  const windowed: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'research', 'morpho-vault-deposit-windows.json'));
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
  assert.match(run.stderr, /--same-windows-as <recording>/);
});

test('--same-windows-as refuses a recording of one block range, and a name with no recording', () => {
  const old = pastTxsRun('--same-windows-as', 'morpho-vault-deposit');
  assert.equal(old.status, 64);
  assert.equal(old.stderr, '--same-windows-as morpho-vault-deposit: the recording searched one block range and keeps no head block, so it has no windows to search again\n');
  const missing = pastTxsRun('--same-windows-as', 'no-such-study');
  assert.equal(missing.status, 64);
  assert.equal(missing.stderr, '--same-windows-as no-such-study: no recording testdata/research/no-such-study.json\n');
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

const cow: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'research', 'cow-swap-presign.json'));

async function cowRun(options: { time?: boolean; withinSeconds?: number; messages?: PastTxsRecording['messages']; reader?: Reader } = {}) {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'cow', 'swap', 'template.json'), 'utf8'));
  const fields = raw.calls[0].args.orderUid.packed[0].rule.eip712.fields;
  if (options.time === true) fields.validTo = { free: { time: { en: 'When the order expires.', 'zh-TW': '訂單到期的時間。' } } };
  if (options.withinSeconds !== undefined) fields.validTo = { withinSeconds: options.withinSeconds };
  const { query } = cow;
  return pastTxs(
    { template: parseTemplate(raw, registry), anchor: { token: query.token as Address, kind: 'event', event: anchorEvent(query.event as string) }, sampling: pastTxsSampling(query) },
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
