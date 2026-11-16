import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { replayReader } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Registry } from '../src/registry.ts';
import { DEFAULT_SPREAD, pastTxs, renderPastTxs } from '../src/research/past-txs.ts';
import type { Sampling } from '../src/research/past-txs.ts';
import { scrubRecording } from '../src/research/recording.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { replayAsk, searchBoth } from '../src/research/sources.ts';
import type { Anchor, AnchorKind, SourceExchange, SourceRequest } from '../src/research/sources.ts';
import type { Address } from '../src/safe/types.ts';
import { loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const SCRIPTS = join(import.meta.dirname, '..', 'scripts');
const recording: PastTxsRecording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'research', 'morpho-vault-deposit.json'), 'utf8'));
const registry = loadRegistry(ROOT);

const FIT = '0x88a65493c62cfc17be33cbc587fca29edf71d0984b6ba2295873dfb1a9a38c4c';
const MISFIT = '0xbd242bf8e4ff0a45a27468a62553bae8770bd456c12420028de0f82e28e18a80';

/** The Safe that executed `hash`, as the recorded chain read says. */
function safeOf(hash: string): Address {
  const read = recording.exchanges.find((e) => e.method === 'eth_getTransactionByHash' && JSON.stringify(e.params) === JSON.stringify([hash]));
  return (read?.answers.alchemy as { to: Address }).to;
}

const samplingOf = (query: PastTxsRecording['query']): Sampling =>
  query.fromBlock === undefined || query.toBlock === undefined ? DEFAULT_SPREAD : { kind: 'range', range: { fromBlock: BigInt(query.fromBlock), toBlock: BigInt(query.toBlock) } };

async function report(
  options: { exclude?: Address; sources?: readonly SourceExchange[]; template?: Template; exchanges?: PastTxsRecording['exchanges']; recorded?: PastTxsRecording; registry?: Registry } = {},
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
    { ask: replayAsk(options.sources ?? recorded.sources), reader: replayReader(options.exchanges ?? recorded.exchanges), registry: seen, exclude: options.exclude, maxTxs: query.maxTxs },
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
  const text = await report({ registry: { entries: new Map(kept.map((e) => [e.name, e])), byAddress: new Map(kept.map((e) => [e.address, e])), markets: registry.markets } });
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
  const windowed: PastTxsRecording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'research', 'morpho-vault-deposit-windows.json'), 'utf8'));
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
    { template: loadTemplate(ROOT, query.template, registry), anchor: { token: query.token as Address, kind: query.anchor as AnchorKind }, sampling: DEFAULT_SPREAD },
    { ask, reader: replayReader(windowed.exchanges), registry, exclude: undefined, maxTxs: query.maxTxs },
  );
  const text = renderPastTxs(run, registry);
  assert.match(text, /^ {2}blocks 26377201 to 26380800: 45 found, 2 studied; halved, too many transfers in 26373601 to 26380800, so 26373601 to 26377200 not searched$/m);
  assert.equal(text.match(/halved/g)?.length, 1);
});

test('--max-txs below one transaction per window is refused', () => {
  const run = spawnSync(process.execPath, [join(SCRIPTS, 'past-txs.ts'), 'morpho/vault-deposit', '--token', 'steakhouse-prime-usdc-v2-0f51', '--anchor', 'mint', '--max-txs', '11'], { encoding: 'utf8' });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /--max-txs must be at least 12, one transaction per window/);
});

test('by default the windows are spread over the last year from the head block, and each window is sampled to its share', async () => {
  const windowed: PastTxsRecording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'research', 'morpho-vault-deposit-windows.json'), 'utf8'));
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

test('a recording that would name the configured Safe loses those entries, or is refused', () => {
  const safe = safeOf(FIT);
  const scrubbed = JSON.stringify(scrubRecording(recording, [safe]));
  assert.doesNotMatch(scrubbed, new RegExp(safe.slice(2), 'i'));
  assert.throws(() => scrubRecording({ ...recording, query: { ...recording.query, token: safe } }, [safe]), /still mentions the configured Safe/);
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

test('an anchor with a sender asks both sources only for transfers out of it, and the report names it', async () => {
  const claims: PastTxsRecording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'research', 'merkl-claim.json'), 'utf8'));
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
      { ask: async (r) => (r.source === 'alchemy' ? { transfers: [] } : { status: '0', message: 'No records found' }), reader: replayReader([]), registry, exclude: undefined, maxTxs: 12 },
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
  const transfers: PastTxsRecording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'research', 'erc20-transfer.json'), 'utf8'));
  const text = await report({ recorded: transfers });
  assert.match(
    text,
    /^by proven Safes, the whole template in one transaction:\nanother operation, making none of the template's calls: 1 transaction from 1 Safe; not counted below\n {2}e\.g\. 0x76b2080d079470fd25ea8724b2aaf1f1d951e50ec48501d990f500105d3901bb: calls 0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2\.0x1d7d4ebc\nfit the template's shape: 1 transaction from 1 Safe; misfits: 0 from 0 Safes\n {2}exactly the template: 0 from 0 Safes; outside the registry: 1 from 1 Safe \(a token outside the registry at call\.to in 1\)$/m,
  );
  assert.doesNotMatch(text, /^misfits, by reason:\n {2}1 from 1 Safe: calls /m);
});
