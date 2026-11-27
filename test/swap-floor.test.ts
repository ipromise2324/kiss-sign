import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard, resolveCard } from '../src/card.ts';
import type { Transport } from '../src/chain/rpc.ts';
import { main } from '../src/cli/main.ts';
import { expectedAnswers } from '../src/contracts/instance.ts';
import { keccakCode } from '../src/contracts/code.ts';
import { parseFunctionSignature } from '../src/decode/abi.ts';
import { encodeParams } from '../src/decode/codec.ts';
import type { AbiValue } from '../src/decode/codec.ts';
import { floorOf, pairFacts, valueOf } from '../src/price/reference.ts';
import { harmonicLiquidity, meanTick, sqrtRatioAtTick } from '../src/price/tick.ts';
import { RegistryError, loadRegistry, parseRegistry, registryFromTexts } from '../src/registry.ts';
import type { Hex } from '../src/safe/types.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import { TemplateError, parseTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'swap-floor');
const SAFE = '0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0';
const CODE = '0x00' as Hex;
const HEAD = 26_490_000;
const HEAD_HASH = `0x${'ab'.repeat(32)}`;
const NOW = 1_800_000_000;
const HOUR = 3600;
const PINNED = ['usdc', 'usdt', 'weth', 'weeth', 'cbbtc', 'usdc-usd', 'usdt-usd', 'eth-usd', 'cbbtc-usd', 'weeth-eth', 'v3-usdc-usdt-100', 'v3-usdc-weth-500'];

const text = (path: string) => readFileSync(join(FIXTURE, path), 'utf8');
const contracts = () => JSON.parse(text('registry/contracts.json'));
const attributes = JSON.parse(text('registry/attributes.json'));
const shipped = registryFromTexts(text('registry/contracts.json'), undefined, text('registry/attributes.json'));
const template = (id: string) => JSON.parse(text(`templates/${id}/template.json`));
const entry = (name: string) => shipped.entries.get(name)!;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

/** A clone, current with its own origin, of the fixture registry with the read contracts pinned to the stub code, and the fixture templates. */
function clone(edit: (registry: any) => void = () => {}, editTemplate: (uniswap: any) => void = () => {}, editCow: (cow: any) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-floor-'));
  const origin = mkdtempSync(join(tmpdir(), 'kiss-sign-floor-origin-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const registry = contracts();
  for (const name of PINNED) registry[name].code = { hash: keccakCode(CODE), from: 0 };
  edit(registry);
  writeFileSync(join(dir, 'registry', 'contracts.json'), JSON.stringify(registry));
  const uniswap = template('uniswap/swap');
  editTemplate(uniswap);
  writeFileSync(join(dir, 'templates', 'uniswap', 'swap', 'template.json'), JSON.stringify(uniswap));
  const cow = template('cow/swap');
  editCow(cow);
  writeFileSync(join(dir, 'templates', 'cow', 'swap', 'template.json'), JSON.stringify(cow));
  git(origin, 'init', '--quiet', '--bare', '--initial-branch=main');
  git(dir, 'init', '--quiet', '--initial-branch=main');
  const ssh = join(origin, 'ssh');
  writeFileSync(ssh, `#!/bin/sh\nexec git-upload-pack '${origin}'\n`);
  chmodSync(ssh, 0o755);
  git(dir, 'remote', 'add', 'origin', 'git@github.com:signer/kiss-sign.git');
  git(dir, 'config', 'core.sshCommand', ssh);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'data');
  git(dir, 'push', '--quiet', origin, 'HEAD:refs/heads/main');
  return dir;
}

let shared: string | undefined;

type FeedAnswer = { readonly answer: bigint; readonly age?: number; readonly description?: string; readonly decimals?: number; readonly updatedAt?: number };
type PoolAnswer = { readonly tick: number; readonly liquidity?: bigint } | 'revert';
type World = { readonly feeds: Record<string, FeedAnswer | 'revert'>; readonly pools: Record<string, PoolAnswer>; readonly drpc?: Partial<Omit<World, 'drpc'>>; readonly code?: Record<string, Hex>; readonly clock?: number; readonly blockTime?: number; readonly heads?: readonly [alchemy: number, drpc: number] };

const calm: World = {
  feeds: {
    'usdc-usd': { answer: 99_994_000n },
    'usdt-usd': { answer: 99_894_000n },
    'eth-usd': { answer: 165_292_000_000n },
    'cbbtc-usd': { answer: 5_920_398_232_300n },
    'weeth-eth': { answer: 1_108_673_212_702_759_100n },
  },
  pools: { 'v3-usdc-usdt-100': { tick: 10 }, 'v3-usdc-weth-500': { tick: 202_275 } },
};

const withFeed = (name: string, answer: Partial<FeedAnswer> | 'revert', world = calm): World => ({
  ...world,
  feeds: { ...world.feeds, [name]: answer === 'revert' ? answer : { ...(world.feeds[name] as FeedAnswer), ...answer } },
});
const withPool = (name: string, answer: PoolAnswer, world = calm): World => ({ ...world, pools: { ...world.pools, [name]: answer } });

const DECIMALS: Record<string, number> = { usdc: 6, usdt: 6, morpho: 18, weeth: 18, cbbtc: 8, weth: 18, 'weth-two': 18 };
const span: AbiValue['span'] = [0, 0];
const uint = (value: bigint): AbiValue => ({ kind: 'uint', value, span });
const int = (value: bigint): AbiValue => ({ kind: 'int', value, span });
const encoded = (types: string, values: AbiValue[]): string => `0x${Buffer.from(encodeParams(parseFunctionSignature(`f(${types})`), values)).toString('hex')}`;
const selector = (signature: string) => parseFunctionSignature(signature).selector;

function answerOf(world: World, name: string, data: string): string | 'revert' {
  const called = data.slice(0, 10);
  if (called === selector('decimals()') && DECIMALS[name] !== undefined) return encoded('uint256', [uint(BigInt(DECIMALS[name]))]);
  const feed = world.feeds[name];
  if (feed !== undefined) {
    const facts = entry(name).feed!;
    if (feed === 'revert') return 'revert';
    if (called === selector('description()')) return encoded('string', [{ kind: 'string', value: Buffer.from(feed.description ?? facts.description), span }]);
    if (called === selector('decimals()')) return encoded('uint8', [uint(BigInt(feed.decimals ?? facts.decimals))]);
    if (called === selector('latestRoundData()')) return encoded('uint80,int256,uint256,uint256,uint80', [uint(1n), int(feed.answer), uint(1n), uint(BigInt(feed.updatedAt ?? NOW - (feed.age ?? HOUR / 2))), uint(1n)]);
  }
  const pool = world.pools[name];
  if (pool !== undefined && called === selector('observe(uint32[])')) {
    if (pool === 'revert') return 'revert';
    const window = BigInt(`0x${data.slice(10 + 64 * 2, 10 + 64 * 3)}`);
    const liquidity = pool.liquidity ?? 10n ** 18n;
    return encoded('int56[],uint160[]', [
      { kind: 'array', items: [int(-5000n), int(-5000n + BigInt(pool.tick) * window)], span },
      { kind: 'array', items: [uint(7n), uint(7n + (window << 128n) / liquidity)], span },
    ]);
  }
  return assert.fail(`${called} on ${name} is not stubbed`);
}

function transportOf(world: World, edited: ReadonlyMap<string, string>): Transport {
  return async (url, body) => {
    const { method, params } = JSON.parse(body) as { method: string; params: any[] };
    const reply = (result: unknown) => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
    const here: World = url.includes('drpc') && world.drpc !== undefined ? { ...world, ...world.drpc } : world;
    const named = (address: string) => edited.get(address.toLowerCase()) as string;
    const heads = world.heads ?? [HEAD, HEAD];
    const lower = Math.min(...heads);
    if (method === 'eth_blockNumber') return reply(`0x${heads[url.includes('drpc') ? 1 : 0].toString(16)}`);
    if (method === 'eth_getBlockByNumber') assert.equal(Number(params[0]), lower);
    if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') return reply({ number: `0x${lower.toString(16)}`, hash: HEAD_HASH, timestamp: `0x${(world.blockTime ?? NOW).toString(16)}`, gasLimit: '0x1', mixHash: HEAD_HASH });
    if (method === 'eth_getCode') return reply(here.code?.[named(params[0])] ?? CODE);
    if (method === 'eth_getStorageAt') return reply(`0x${'0'.repeat(64)}`);
    assert.equal(method, 'eth_call');
    assert.equal(params[1].blockHash, HEAD_HASH, 'every read is made at the one block');
    const answer = answerOf(here, named(params[0].to), params[0].data);
    return answer === 'revert' ? { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }) } : reply(answer);
  };
}

type Typed = { readonly sell: string; readonly buy: string; readonly amount: string; readonly then: readonly string[]; readonly waits?: Readonly<Record<number, number>> };

/** `card new` of one swap template in `world`: the picks, the amount, then the typed lines of `then`. */
async function cardNew(id: string, { sell, buy, amount, then, waits = {} }: Typed, world: World = calm, repoRoot = (shared ??= clone()), language = 'en') {
  const home = mkdtempSync(join(tmpdir(), 'kiss-sign-floor-home-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ chainId: 1, safe: SAFE, repo: 'github.com/signer/kiss-sign', language }));
  const registry = JSON.parse(readFileSync(join(repoRoot, 'registry', 'contracts.json'), 'utf8')) as Record<string, { address: string }>;
  const queue = [sell, buy, amount, ...then];
  const asked: string[] = [];
  let waited = 0;
  let stdout = '';
  let stderr = '';
  const code = await main(['card', 'new', id], {
    env: { KISS_SIGN_HOME: home, ALCHEMY_API_KEY: 'test-key', DRPC_API_KEY: 'test-key-drpc' },
    stdout: (out) => void (stdout += out),
    stderr: (out) => void (stderr += out),
    platform: 'linux',
    readSecret: undefined,
    ask: async (question) => {
      waited += waits[asked.length] ?? 0;
      asked.push(question);
      return queue.shift();
    },
    repoRoot,
    transport: transportOf(world, new Map(Object.entries(registry).map(([name, { address }]) => [address.toLowerCase(), name]))),
    fetchJson: async () => assert.fail('card new fetches nothing'),
    readMessage: async () => ({ why: 'none' }),
    now: () => ((world.clock ?? NOW) + waited) * 1000,
  });
  const cards = existsSync(join(home, 'cards')) ? readdirSync(join(home, 'cards')) : [];
  const card = cards.length === 0 ? undefined : parseCard(JSON.parse(readFileSync(join(home, 'cards', cards[0] as string), 'utf8')));
  return { code, stdout, stderr, asked, left: queue, minBuy: card?.operations[0]?.values['min-buy'] };
}

const STABLE = { sell: 'usdt', buy: 'usdc', amount: '16,089.929021' };
const SOLD = 16_089_929_021n;
const byFeeds = (bps: bigint) => (SOLD * 99_894_000n * (10_000n - bps)) / (99_994_000n * 10_000n);

/** The floor by the pool alone, sold usdt, with the price as a v3 pool at `tick` holds it. */
function byPool(tick: bigint, bps: bigint): bigint {
  const sqrt = sqrtRatioAtTick(tick)!;
  return (SOLD * (1n << 192n) * (10_000n - bps)) / (sqrt * sqrt * 10_000n);
}

for (const id of ['uniswap/swap', 'cow/swap']) {
  test(`${id}: a pair that shares a peg asks the slippage and seals the stricter of the two floors, less the margin`, async () => {
    const feeds = await cardNew(id, { ...STABLE, then: ['', 'y'] }, withPool('v3-usdc-usdt-100', { tick: 20 }));
    assert.equal(feeds.code, 0, feeds.stderr);
    assert.equal(feeds.asked[3], 'min-buy: slippage the app shows, percent [Enter = 0.50%, at most 1.00%]: ');
    assert.equal(feeds.minBuy, `${byFeeds(75n)}`, 'the pool says less, so the feeds count');
    assert.match(feeds.stdout, /stricter +by feeds/);
    const pool = await cardNew(id, { ...STABLE, then: ['', 'y'] }, withPool('v3-usdc-usdt-100', { tick: 5 }));
    assert.equal(pool.minBuy, `${byPool(5n, 75n)}`, 'the pool says more, so the pool counts');
    assert.ok(byPool(5n, 75n) > byFeeds(75n));
    assert.match(pool.stdout, /stricter +by pool/);
    const typed = await cardNew(id, { ...STABLE, then: ['1.00', 'y'] }, withPool('v3-usdc-usdt-100', { tick: 20 }));
    assert.equal(typed.minBuy, `${byFeeds(125n)}`);
    const none = await cardNew(id, { ...STABLE, then: ['0', 'y'] }, withPool('v3-usdc-usdt-100', { tick: 20 }));
    assert.equal(none.minBuy, `${byFeeds(25n)}`);
  });

  for (const [what, world, said] of [
    ['a token off its peg', withFeed('usdt-usd', { answer: 98_999_999n }, withPool('v3-usdc-usdt-100', { tick: 100 })), /doubt +usdt is at 0\.98999999 of its peg, more than 1\.00% away/],
    ['a stale feed', withFeed('usdc-usd', { age: 82_800 + 3600 + 1 }), /doubt +usdc-usd was last updated 24\.0 h ago, over its limit of 24\.0 h/],
    ['a pool pushed down', withPool('v3-usdc-usdt-100', { tick: -20 }), /doubt +the pool price is 0\.\d+% from the feeds, over the limit of 0\.15%/],
    ['a pool pushed up', withPool('v3-usdc-usdt-100', { tick: 60 }), /doubt +the pool price is 0\.\d+% from the feeds/],
    ['a thin pool', withPool('v3-usdc-usdt-100', { tick: 10, liquidity: 10n ** 13n }), /doubt +v3-usdc-usdt-100 is too thin to price: mean liquidity 100000\d+ over 30 minutes/],
    ['a pool with too short a history', withPool('v3-usdc-usdt-100', 'revert'), /doubt +v3-usdc-usdt-100 gives no mean price over 30 minutes/],
  ] as const) {
    test(`${id}: ${what} says so, computes nothing, and takes a minimum only when it is typed twice`, async () => {
      const kept = await cardNew(id, { ...STABLE, then: ['15,995.324415', '15,995.324415', 'y'] }, world);
      assert.equal(kept.code, 0, kept.stderr);
      assert.match(kept.stdout, said);
      assert.match(kept.stdout, /The price is in doubt, so no min-buy is computed/);
      assert.ok(!kept.asked.some((question) => question.includes('slippage')));
      assert.equal(kept.asked[4], 'min-buy: type the same amount again to keep it (whole usdc): ');
      assert.equal(kept.minBuy, '15995324415');
      const other = await cardNew(id, { ...STABLE, then: ['15,995.324415', '15,900', '16,000', '16,000', 'y'] }, world);
      assert.match(other.stdout, /The two amounts differ, so min-buy is asked again/);
      assert.equal(other.minBuy, '16000000000');
      const key = await cardNew(id, { ...STABLE, then: ['15,995.324415', 'y', 'y'] }, world);
      assert.equal(key.code, 1);
      assert.equal(key.minBuy, undefined, 'one key keeps nothing');
      const enter = await cardNew(id, { ...STABLE, then: ['', 'y'] }, world);
      assert.equal(enter.minBuy, undefined, 'Enter seals nothing');
    });
  }

  test(`${id}: a pair with feeds and no shared peg takes a typed minimum near the price, and one far below it only when typed twice`, async () => {
    const swap = { sell: 'weth', buy: 'usdc', amount: '1' };
    const near = await cardNew(id, { ...swap, then: ['1,640', 'y'] });
    assert.equal(near.code, 0, near.stderr);
    assert.equal(near.minBuy, '1640000000');
    assert.match(near.stdout, /observe\(\) mean price over 5 minutes/);
    const far = await cardNew(id, { ...swap, then: ['1,500', '1,500', 'y'] });
    assert.match(far.stdout, /yours is 9\.\d+% below it/);
    assert.equal(far.minBuy, '1500000000');
    const once = await cardNew(id, { ...swap, then: ['1,500', 'y'] });
    assert.equal(once.minBuy, undefined);
  });

  test(`${id}: a token with no feed is typed and said to have no independent price`, async () => {
    const made = await cardNew(id, { sell: 'morpho', buy: 'usdc', amount: '10', then: ['15', 'y'] });
    assert.equal(made.code, 0, made.stderr);
    assert.match(made.stdout, /no independent price for morpho/);
    assert.equal(made.minBuy, '15000000');
  });

  test(`${id}: the same token sold and bought is refused`, async () => {
    const made = await cardNew(id, { sell: 'usdc', buy: 'usdc', amount: '10', then: ['', 'y'] });
    assert.equal(made.code, 1);
    assert.match(made.stderr, /min-buy: the Safe would sell usdc for usdc/);
    assert.equal(made.minBuy, undefined);
  });
}

for (const [what, world, message] of [
  ['a feed answers 0', withFeed('usdc-usd', { answer: 0n }), /usdc-usd 0x8fFf\S+ gives no price: latestRoundData\(\) answers 0, not a price above 0/],
  ['a feed answers a negative price', withFeed('usdt-usd', { answer: -1n }), /latestRoundData\(\) answers -1/],
  ['a feed was never updated', withFeed('usdt-usd', { updatedAt: 0 }), /updatedAt 0, which is 0 or after the block/],
  ['a feed was updated after the block', withFeed('usdt-usd', { updatedAt: NOW + 1 }), /updatedAt 1800000001/],
  ['a feed reverts', withFeed('usdt-usd', 'revert'), /cannot read description\(\) on usdt-usd .*: it reverted/],
  ['a feed is another feed', withFeed('usdt-usd', { description: 'ETH / USD' }), /description\(\) answers "ETH \/ USD", the registry says "USDT \/ USD"/],
  ['a feed has other decimals', withFeed('usdt-usd', { decimals: 18 }), /decimals\(\) answers 18, the registry says 8/],
  ['the providers disagree on a feed', { ...calm, drpc: { feeds: withFeed('usdt-usd', { answer: 90_000_000n }).feeds } }, /cannot read latestRoundData\(\) on usdt-usd .*alchemy and drpc disagree/],
  ['the providers disagree on a pool', { ...calm, drpc: { pools: { ...calm.pools, 'v3-usdc-usdt-100': { tick: 5000 } } } }, /cannot read observe\(uint32\[\]\) on v3-usdc-usdt-100 .*alchemy and drpc disagree/],
  ['a pool reverts at one provider only', { ...calm, drpc: { pools: { ...calm.pools, 'v3-usdc-usdt-100': 'revert' } } }, /cannot read observe\(uint32\[\]\) on v3-usdc-usdt-100/],
  ['a feed runs other code', { ...calm, code: { 'usdt-usd': '0x01' as Hex } }, /usdt-usd 0x3E7d\S+, which a value is read from, is not shown to run the code the registry pins/],
  ['the token sold runs other code', { ...calm, code: { usdt: '0x01' as Hex } }, /usdt 0xdAC1\S+, which a value is read from, is not shown/],
  ['the token received runs other code', { ...calm, code: { usdc: '0x01' as Hex } }, /usdc 0xA0b8\S+, which a value is read from, is not shown/],
  ['a pool runs other code', { ...calm, code: { 'v3-usdc-usdt-100': '0x01' as Hex } }, /v3-usdc-usdt-100 0x3416\S+, which a value is read from, is not shown/],
] as const satisfies readonly (readonly [string, World, RegExp])[]) {
  test(`card new refuses a floor, whatever is typed, when ${what}`, async () => {
    const made = await cardNew('cow/swap', { ...STABLE, then: ['', 'y', '15,995', '15,995', 'y'] }, world);
    assert.equal(made.code, 1, made.stdout);
    assert.match(made.stderr, message);
    assert.equal(made.minBuy, undefined);
  });
}

for (const [typed, message] of [['1.01', /"1\.01" percent is more than 1\.00%/], ['abc', /"abc" is not a slippage/], ['0.505', /not a slippage/], ['-1', /not a slippage/], ['0.5%', /not a slippage/]] as const) {
  test(`a slippage typed as ${typed} is refused`, async () => {
    const made = await cardNew('cow/swap', { ...STABLE, then: [typed, 'y'] });
    assert.equal(made.code, 1);
    assert.match(made.stderr, message);
    assert.equal(made.minBuy, undefined);
  });
}

test('an amount worth less than a base unit, and a floor that comes to 0, are refused', async () => {
  const dust = await cardNew('cow/swap', { sell: 'weth', buy: 'usdc', amount: '0.000000000000000001', then: ['1', '1', 'y'] });
  assert.match(dust.stderr, /worth less than one base unit/);
  const one = await cardNew('cow/swap', { sell: 'usdc', buy: 'usdt', amount: '0.000001', then: ['', 'y'] });
  assert.match(one.stderr, /min-buy comes to 0/);
  assert.equal(one.minBuy, undefined);
});

test('an amount near 2^256 neither wraps nor loses a digit', async () => {
  const big = (1n << 256n) - 1n;
  const whole = `${big / 10n ** 6n}.${(big % 10n ** 6n).toString().padStart(6, '0')}`;
  const made = await cardNew('cow/swap', { sell: 'usdt', buy: 'usdc', amount: whole, then: ['', 'y'] }, withPool('v3-usdc-usdt-100', { tick: 20 }));
  assert.equal(made.minBuy, `${(big * 99_894_000n * 9_925n) / (99_994_000n * 10_000n)}`);
  const over = await cardNew('cow/swap', { sell: 'usdc', buy: 'weth', amount: whole, then: ['1', '1', 'y'] });
  assert.equal(over.minBuy === undefined || BigInt(over.minBuy) < 1n << 256n, true);
});

test('a price of 8, 18 and 6 decimals, through two feeds, is exact', async () => {
  const btc = await cardNew('cow/swap', { sell: 'cbbtc', buy: 'usdc', amount: '0.5', then: ['29,000', 'y'] });
  assert.equal(btc.code, 0, btc.stderr);
  assert.match(btc.stdout, /by feeds +29,603\.767387 usdc/);
  assert.match(btc.stdout, /one price source only/);
  const eth = await cardNew('cow/swap', { sell: 'weeth', buy: 'usdc', amount: '2', then: ['3,600', 'y'] });
  assert.match(eth.stdout, /by feeds +3,665\.316172 usdc/);
  assert.match(eth.stdout, /one price source only/);
  const back = await cardNew('cow/swap', { sell: 'usdc', buy: 'cbbtc', amount: '59,200.43', then: ['0.99', 'y'] });
  assert.match(back.stdout, /by feeds +0\.99988 cbbtc/);
});

const lines = (text: string): string => text.replace(/\s+/g, ' ');

const whole18 = (value: bigint): string => `${value / 10n ** 18n}.${(value % 10n ** 18n).toString().padStart(18, '0')}`;

const OLD = NOW - 12_000_000;
const fresh = (name: string): FeedAnswer => ({ ...(calm.feeds[name] as FeedAnswer), updatedAt: OLD - 60 });
for (const [what, world, said] of [
  ['one provider is far behind, so its old block would set the price', { feeds: Object.fromEntries(Object.keys(calm.feeds).map((name) => [name, fresh(name)])), pools: calm.pools, heads: [HEAD, HEAD - 1_000_000], blockTime: OLD }, /alchemy is at 26490000 and drpc at 25490000, more than 25 blocks apart/],
  ['the same provider, with a clock as far behind', { ...calm, heads: [HEAD - 26, HEAD] }, /alchemy is at 26489974 and drpc at 26490000, more than 25 blocks apart/],
  ['both heads are old', { ...calm, clock: NOW + 301 }, /block 26490000, the latest both providers have, is 301 s behind this computer's clock, more than 300 s/],
  ['the block is ahead of the clock', { ...calm, clock: NOW - 301 }, /is 301 s after this computer's clock/],
] as const satisfies readonly (readonly [string, World, RegExp])[]) {
  test(`card new refuses a floor, whatever is typed, when ${what}`, async () => {
    for (const typed of [['', 'y'], ['15,995', '15,995', 'y']]) {
      const made = await cardNew('cow/swap', { ...STABLE, then: typed }, world);
      assert.equal(made.code, 1, made.stdout);
      assert.match(made.stderr, said);
      assert.equal(made.minBuy, undefined);
    }
  });
}

test('a provider a few blocks behind and a clock a few minutes off are normal, and the box says the block\'s time', async () => {
  for (const world of [{ ...calm, clock: NOW + 300 }, { ...calm, clock: NOW - 300 }, { ...calm, heads: [HEAD - 25, HEAD] as const }, { ...calm, heads: [HEAD, HEAD - 25] as const }]) {
    const made = await cardNew('cow/swap', { ...STABLE, then: ['', 'y'] }, world);
    assert.equal(made.code, 0, made.stderr);
    assert.match(lines(made.stdout), /chain reads at block 264\d+ of 2027-01-15 08:00:00 UTC, where/);
  }
});

for (const [what, swap, at] of [
  ['the slippage prompt', { ...STABLE, then: ['', 'y'] }, 3],
  ['the typed minimum', { sell: 'weth', buy: 'usdc', amount: '1', then: ['1,640', 'y'] }, 3],
  ['a minimum with no price', { sell: 'morpho', buy: 'usdc', amount: '10', then: ['15', 'y'] }, 3],
  ['the seal question', { ...STABLE, then: ['', 'y'] }, 4],
] as const) {
  test(`card new seals nothing once ${what} was left open past 30 minutes, and seals at 30 minutes`, async () => {
    const late = await cardNew('cow/swap', { ...swap, waits: { [at]: 1801 } });
    assert.equal(late.code, 1, late.stdout);
    assert.match(late.stderr, /block 26490000, which the card's values were read at, is now 1801 s old, more than 1800 s; nothing is sealed/);
    assert.equal(late.minBuy, undefined);
    if (at === 3) assert.ok(!late.stdout.includes('base units'), 'the box is not shown');
    const inTime = await cardNew('cow/swap', { ...swap, waits: { [at]: 1800 } });
    assert.equal(inTime.code, 0, inTime.stderr);
  });
}

test('no floor is computed once the slippage prompt was left open', async () => {
  const late = await cardNew('cow/swap', { ...STABLE, then: ['', 'y'], waits: { 3: 1801 } });
  assert.match(late.stdout, /latestRoundData/);
  assert.doesNotMatch(late.stdout, /the app's minimum received must be at least/);
});

test('no price is read for a floor once the block is old', async () => {
  const twoAmounts = clone(undefined, (t) => (t.card.other = t.card['sell-amount']));
  const late = await cardNew('uniswap/swap', { ...STABLE, then: ['1', '', 'y'], waits: { 3: 1801 } }, calm, twoAmounts);
  assert.match(late.stderr, /is now 1801 s old/);
  assert.doesNotMatch(late.stdout, /latestRoundData/);
});

test('what a feed calls itself is printed with no character that can rewrite the terminal', async () => {
  const made = await cardNew('cow/swap', { ...STABLE, then: ['', 'y'] }, withFeed('usdt-usd', { description: 'USDT\u009b2J\u202e \u200b/ USD\u0007' }));
  assert.equal(made.code, 1);
  assert.match(made.stderr, /description\(\) answers "USDT\ufffd2J\ufffd \ufffd\/ USD\ufffd"/);
});

test('a typed minimum is compared with the stricter source, and one more than 2.50% below it is typed twice', async () => {
  const pair = { sell: 'weth', buy: 'usdc', amount: '1' };
  const near = await cardNew('cow/swap', { ...pair, then: ['1,611.70', 'y'] });
  assert.equal(near.minBuy, '1611700000', '2.4996% below the feeds, which say more than the pool');
  assert.equal((await cardNew('cow/swap', { ...pair, then: ['1,611.52', 'y'] })).minBuy, undefined, '2.51% below');
  const high = withPool('v3-usdc-weth-500', { tick: 202_117 });
  assert.equal((await cardNew('cow/swap', { ...pair, then: ['1,625', 'y'] }, high)).minBuy, undefined, '1.7% below the feeds, 2.7% below the pool');
  assert.equal((await cardNew('cow/swap', { ...pair, then: ['1,625', '1,625', 'y'] }, high)).minBuy, '1625000000');
});

test('a pair that shares no peg is in doubt once its sources are more than 1.50% apart', async () => {
  const made = await cardNew('cow/swap', { sell: 'weth', buy: 'usdc', amount: '1', then: ['1,680', 'y'] }, withPool('v3-usdc-weth-500', { tick: 202_275 - 258 }));
  assert.match(made.stdout, /the pool price is \d\.\d+% from the feeds, over the limit of 1\.50%/);
  assert.equal(made.minBuy, undefined);
});

test('a token above its peg is as doubtful as one below it', async () => {
  const at = (answer: bigint) => cardNew('cow/swap', { ...STABLE, then: ['', 'y'] }, withFeed('usdt-usd', { answer }, withPool('v3-usdc-usdt-100', { tick: -100 })));
  assert.ok((await at(101_000_000n)).minBuy !== undefined);
  const over = await at(101_000_001n);
  assert.match(over.stdout, /doubt +usdt is at 1\.01000001 of its peg, more than 1\.00% away/);
  assert.equal(over.minBuy, undefined);
});

test('sources a fraction of a hundredth of a basis point over the limit are in doubt', async () => {
  const at = (answer: bigint) => cardNew('cow/swap', { ...STABLE, then: ['', 'y'] }, withFeed('usdc-usd', { answer: 100_000_000n }, withFeed('usdt-usd', { answer }, withPool('v3-usdc-usdt-100', { tick: 0 }))));
  assert.ok((await at(99_850_225n)).minBuy !== undefined, '14.999966 bps');
  assert.equal((await at(99_850_224n)).minBuy, undefined, '15.000067 bps');
});

test('two tokens priced by the very same feed compute nothing: no feed tells them apart', async () => {
  const twins = clone((r) => {
    r.weth.price.peg = 'eth-usd';
    r['weth-two'] = { ...r.weth, address: `0x${'77'.repeat(20)}` };
  }, undefined, (cow) => {
    for (const field of ['sell-token', 'buy-token']) cow.card[field].names.push('weth-two');
  });
  const made = await cardNew('cow/swap', { sell: 'weth', buy: 'weth-two', amount: '1', then: ['0.99', 'y'] }, calm, twins);
  assert.equal(made.code, 0, made.stderr);
  assert.ok(!made.asked.some((question) => question.includes('slippage')));
  assert.equal(made.minBuy, '990000000000000000');
});

test('every route of the fewest pools is read, and the highest counts', async () => {
  const two = clone((r) => {
    const code = { hash: keccakCode(CODE), from: 0 };
    const pool = (byte: string, token0: string, token1: string) => ({ ...r['v3-usdc-usdt-100'], code, address: `0x${byte.repeat(20)}`, attributes: { factory: 'uniswap-v3-factory', token0, token1 } });
    r['v3-morpho-weth'] = pool('71', 'morpho', 'weth');
    r['v3-morpho-usdt'] = pool('72', 'morpho', 'usdt');
  });
  const world = withPool('v3-morpho-usdt', { tick: 0 }, withPool('v3-morpho-weth', { tick: 202_315 }));
  const byFeedsWei = (SOLD * 99_894_000n * 10n ** 12n) / 165_292_000_000n;
  const typed = whole18((byFeedsWei * 984n) / 1000n);
  const swap = { sell: 'usdt', buy: 'weth', amount: STABLE.amount };
  const once = await cardNew('cow/swap', { ...swap, then: [typed, 'y'] }, world, two);
  assert.equal(once.stdout.match(/by pool/g)?.length, 2);
  assert.match(once.stdout, /yours is 2\.[67]\d+% below it/);
  assert.equal(once.minBuy, undefined);
});

const poolName = (t: any): any => t.calls[0].args.inputs.items[0].encoded.args.params.items[1].encoded.args.params.fields.poolKey.fields;
const pickedPool = (t: any): void => {
  t.card.pool = { kind: 'contract', registryKind: 'pool', names: ['v3-usdc-usdt-100'] };
  poolName(t).hooks = { card: 'pool' };
};
for (const [what, edit, picks] of [
  ['a rule names', (t: any) => (poolName(t).hooks = { contract: 'v3-usdc-usdt-100' }), []],
  ['the signer picks', pickedPool, ['v3-usdc-usdt-100']],
] as const) {
  test(`a pool ${what} is never the second source of a swap through it`, async () => {
    const [first, ...rest] = [...picks, STABLE.amount, '', 'y'] as [string, ...string[]];
    const made = await cardNew('uniswap/swap', { ...STABLE, amount: first, then: rest }, calm, clone(undefined, edit));
    assert.equal(made.code, 0, made.stderr);
    assert.match(lines(made.stdout), /one price source only: the only pool between the two tokens is one this template itself names/);
    assert.equal(made.minBuy, `${byFeeds(75n)}`);
  });
}

test('a zh-TW home is told a doubt in Chinese and types the same amount twice', async () => {
  const made = await cardNew('cow/swap', { ...STABLE, then: ['15,995', '15,995', 'y'] }, withPool('v3-usdc-usdt-100', 'revert'), undefined, 'zh-TW');
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /價格有疑問，所以不計算 min-buy/);
});

test('a feed chain counts each token\'s own feeds, a route has at most two pools, and a pool the template names is no second source', () => {
  const facts = (sell: string, buy: string, named: string[] = [], registry = shipped) => {
    const found = pairFacts(registry.entries.get(sell)!, registry.entries.get(buy)!, registry, new Set(named));
    assert.equal(found.kind, 'feeds');
    return found as Extract<typeof found, { kind: 'feeds' }>;
  };
  assert.deepEqual(facts('weeth', 'weth').sell.map(({ name }) => name), ['weeth-eth', 'eth-usd']);
  assert.deepEqual(facts('usdt', 'weth').routes.map((route) => route.map(({ entry: { name } }) => name)), [['v3-usdc-usdt-100', 'v3-usdc-weth-500']]);
  assert.equal(facts('usdc', 'usdt').alone, undefined);
  assert.equal(facts('usdc', 'usdt', ['v3-usdc-usdt-100']).alone, 'own-pool');
  assert.equal(facts('weeth', 'usdc').alone, 'no-pool');
  const wide = contracts();
  wide['usdt-usd'].feed.deviationBps = 26;
  assert.equal(facts('usdc', 'usdt', [], parseRegistry(wide, {}, attributes)).pegged, undefined, 'feeds that may be off by more than 50 bps together compute nothing');
  const dex = contracts();
  dex['usdt-usd'].feed.sourceClass = 'dex_state_price';
  assert.equal(facts('usdc', 'usdt', [], parseRegistry(dex, {}, attributes)).alone, 'shared-upstream');
});

test('the tick, mean tick and liquidity arithmetic is v3\'s own', () => {
  assert.equal(sqrtRatioAtTick(0n), 1n << 96n);
  assert.equal(sqrtRatioAtTick(-887272n), 4295128739n);
  assert.equal(sqrtRatioAtTick(887272n), 1461446703485210103287273052203988822378723970342n);
  assert.equal(sqrtRatioAtTick(887273n), undefined);
  assert.equal(sqrtRatioAtTick(-887273n), undefined);
  assert.equal(meanTick(-1n, 1800n), -1n);
  assert.equal(meanTick(-3600n, 1800n), -2n);
  assert.equal(meanTick(3599n, 1800n), 1n);
  assert.equal(harmonicLiquidity(5n, 5n, 1800n), 0n);
  assert.equal(harmonicLiquidity((1n << 160n) - 1n, (1n << 128n) - 1n, 1n), 1n, 'the cumulative wraps');
  assert.equal(floorOf(1000n, { num: 1n, den: 3n }, 0), 333n);
  assert.equal(valueOf(1000n, { num: 2n, den: 3n }), 666n);
});

for (const [what, edit, path] of [
  ['a quote that is no feed', (r: any) => (r['weeth-eth'].feed.quote = 'nothing'), 'weeth-eth.feed.quote'],
  ['a quote in another unit', (r: any) => (r['weeth-eth'].feed.quote = 'usdc-usd'), 'weeth-eth.feed.quote'],
  ['a dollar quote of a feed priced in ETH', (r: any) => (r['weeth-eth'].feed.quote = 'usd'), 'weeth-eth.feed.quote'],
  ['a circle of quotes', (r: any) => Object.assign(r['eth-usd'].feed, { description: 'ETH / ETH', quote: 'eth-usd' }), 'eth-usd.feed.quote'],
  ['a price whose feed is a token', (r: any) => (r.usdc.price.feed = 'usdt'), 'usdc.price.feed'],
  ['a peg off the token\'s own chain', (r: any) => (r.cbbtc.price.peg = 'eth-usd'), 'cbbtc.price.peg'],
  ['a feed on a token', (r: any) => (r.usdc.feed = r['usdc-usd'].feed), 'usdc.feed'],
  ['a price on a pool', (r: any) => (r['v3-usdc-usdt-100'].price = r.usdc.price), 'v3-usdc-usdt-100.price'],
  ['a price whose feed prices another token', (r: any) => (r.usdt.price.feed = 'usdc-usd'), 'usdt.price.feed'],
  ['a price in another token\'s unit', (r: any) => (r.usdt.price = { feed: 'usdc-usd', unit: 'USDC', peg: 'usd' }), 'usdt.price.unit'],
  ['a unit the feed does not price', (r: any) => (r.weth.price.unit = 'BTC'), 'weth.price.unit'],
  ['a wrapped token whose unit is not said', (r: any) => delete r.weth.price.unit, 'weth.price.feed'],
  ['a feed with no code pin', (r: any) => delete r['usdt-usd'].code, 'usdt-usd.code'],
  ['a pool to price from with no code pin', (r: any) => delete r['v3-usdc-usdt-100'].code, 'v3-usdc-usdt-100.code'],
  ['a heartbeat over a day', (r: any) => (r['usdt-usd'].feed.heartbeat = 86_401), 'usdt-usd.feed.heartbeat'],
  ['a negative heartbeat', (r: any) => (r['usdc-usd'].feed.heartbeat = -1), 'usdc-usd.feed.heartbeat'],
  ['an unknown source class', (r: any) => (r['usdc-usd'].feed.sourceClass = 'cex'), 'usdc-usd.feed.sourceClass'],
  ['a pool with no factory', (r: any) => delete r['v3-usdc-usdt-100'].attributes.factory, 'v3-usdc-usdt-100.attributes.factory'],
  ['a pool with its tokens in the other order', (r: any) => Object.assign(r['v3-usdc-usdt-100'].attributes, { token0: 'usdt', token1: 'usdc' }), 'v3-usdc-usdt-100.attributes.token1'],
  ['a pool any liquidity is enough for', (r: any) => (r['v3-usdc-usdt-100'].twap.minLiquidity = '0'), 'v3-usdc-usdt-100.twap.minLiquidity'],
  ['two pools for one pair', (r: any) => (r.twin = { ...r['v3-usdc-usdt-100'], address: `0x${'12'.repeat(20)}` }), 'twin.twap'],
] as const) {
  test(`the registry refuses ${what}`, () => {
    const raw = contracts();
    edit(raw);
    assert.throws(
      () => parseRegistry(raw, {}, attributes),
      (error) => error instanceof RegistryError && error.path === path,
    );
  });
}

test('a factory vouches for each pool by the fee its own entry declares', () => {
  const asked = (name: string) => expectedAnswers(shipped, name)?.[0]?.asked;
  assert.equal(asked('v3-usdc-usdt-100'), 'getPool(usdc,usdt,100)');
  assert.equal(asked('v3-usdc-weth-500'), 'getPool(usdc,weth,500)');
  for (const change of [(r: any) => delete r['v3-usdc-usdt-100'].numbers, (r: any) => (r['v3-usdc-usdt-100'].numbers.fee = `${1 << 24}`)]) {
    const raw = contracts();
    change(raw);
    assert.equal(expectedAnswers(parseRegistry(raw, {}, attributes), 'v3-usdc-usdt-100'), undefined, 'a fee that is missing or over uint24 asks nothing');
  }
});

const order = (t: any): any => t.calls[0].args.orderUid.packed[0].rule.eip712.fields;

for (const [what, edit, path] of [
  ['a floor beside a max', (t: any) => (t.card['min-buy'].max = { value: '1', why: 'x' }), 'card.min-buy.floor'],
  ['a floor that sells itself', (t: any) => (t.card['min-buy'].floor.sells = 'min-buy'), 'card.min-buy.floor.sells'],
  ['a floor that sells a token field', (t: any) => (t.card['min-buy'].floor.sells = 'sell-token'), 'card.min-buy.floor.sells'],
  ['a floor that sells another floor, declared before it', (t: any) => (t.card = { ...t.card, 'min-buy': { ...t.card['min-buy'], floor: { sells: 'late' } }, late: { kind: 'amount', of: 'sell-token', floor: { sells: 'sell-amount' } } }), 'card.min-buy.floor.sells'],
  ['a floor of ETH', (t: any) => (t.card['min-buy'].of = 'eth'), 'card.min-buy.floor'],
  ['a floor that sells ETH', (t: any) => (t.card['sell-amount'].of = 'eth'), 'card.min-buy.floor.sells'],
  ['a floor with a slippage of its own', (t: any) => (t.card['min-buy'].floor.bps = 500), 'card.min-buy.floor.bps'],
  ['a floor that sells an amount no call sells', (t: any) => Object.assign(t.card, { other: t.card['sell-amount'], 'min-buy': { ...t.card['min-buy'], floor: { sells: 'other' } } }), 'card.min-buy.floor.sells'],
  ['an order that sells at least the amount', (t: any) => (order(t).sellAmount = { atLeast: 'card.sell-amount' }), 'card.min-buy.floor.sells'],
  ['a floor only an expiry must meet', (t: any) => Object.assign(order(t), { buyAmount: { const: '0' }, validTo: { atLeast: 'card.min-buy' } }), 'card.min-buy.floor'],
  ['a floor a fee must meet, the amount received free', (t: any) => Object.assign(order(t), { buyAmount: { free: 'x' }, feeAmount: { atLeast: 'card.min-buy' } }), 'card.min-buy.floor'],
  ['an order that does not buy the floor\'s token', (t: any) => (order(t).buyToken = { contract: 'usdc' }), 'card.min-buy.floor'],
  ['a floor the transaction never has to meet', (t: any) => (t.calls[0].args.orderUid.packed[0].rule.eip712.fields.buyAmount = { card: 'min-buy' }), 'card.min-buy.floor'],
] as const) {
  test(`a template is refused with ${what}`, () => {
    const raw = template('cow/swap');
    edit(raw);
    assert.throws(
      () => parseTemplate(raw, shipped, 'committed'),
      (error) => error instanceof TemplateError && error.message.startsWith(`${path}:`),
    );
  });
}

const swapParams = (t: any): any => t.calls[0].args.inputs.items[0].encoded.args.params.items[1].encoded.args.params.fields;
for (const [what, edit, path] of [
  ['a floor only the deadline must meet in the call', (t: any) => ((swapParams(t).amountOutMinimum = { const: '0' }), (t.calls[0].args.deadline = { atLeast: 'card.min-buy' })), 'card.min-buy.floor'],
  ['a floor only a price bound beside a free minimum must meet', (t: any) => Object.assign(swapParams(t), { amountOutMinimum: { free: 'x' }, minHopPriceX36: { atLeast: 'card.min-buy' } }), 'card.min-buy.floor'],
  ['what the Safe gets bounded by no floor', (t: any) => (t.effects.gets[0].amount = 'positive'), 'card.min-buy.floor'],
  ['a floor on another token the Safe gets', (t: any) => (t.effects.gets[0].token = 'weth'), 'card.min-buy.floor'],
  ['a sale the effects do not bound', (t: any) => (t.effects.gives[0].amount = 'positive'), 'card.min-buy.floor.sells'],
  ['a floor that sells an amount the Safe does not give', (t: any) => Object.assign(t.card, { other: t.card['sell-amount'], 'min-buy': { ...t.card['min-buy'], floor: { sells: 'other' } } }), 'card.min-buy.floor.sells'],
] as const) {
  test(`a template that moves tokens is refused with ${what}`, () => {
    const raw = template('uniswap/swap');
    edit(raw);
    assert.throws(
      () => parseTemplate(raw, shipped, 'committed'),
      (error) => error instanceof TemplateError && error.message.startsWith(`${path}:`),
    );
  });
}

const FLOOR = { atLeast: 'card.min-buy' };
const SOLD_RULE = { card: 'sell-amount' };
const TIME = { free: { time: { en: 'x', 'zh-TW': 'x' } } };
const UNBOUND = /it does not bound what is received/;

function swapOf(params: readonly (readonly [parameter: string, rule: unknown])[]): any {
  const t = template('uniswap/swap');
  t.card['other'] = { kind: 'amount', of: 'sell-token' };
  t.effects.gives.push({ token: 'card.sell-token', amount: 'card.other' });
  t.calls[0].args.inputs.items[0].encoded.args.params.items[1] = {
    encoded: { as: `SWAP(${params.map(([p]) => p).join(', ')})`, args: Object.fromEntries(params.map(([p, rule]) => [p.split(' ')[1], rule])) },
  };
  t.calls[0].args.inputs.items[1] = { encoded: { as: 'OTHER(address token, uint256 other)', args: { token: { card: 'sell-token' }, other: { card: 'other' } } } };
  t.calls[0].args.inputs.items[0].encoded.args.params.items.splice(0, 1);
  t.calls[0].args.inputs.items[0].encoded.args.actions.const = '0x060e';
  return t;
}

const least = (rule: unknown) => ['uint256 least', rule] as const;
const sold = (rule: unknown = SOLD_RULE) => ['uint256 sold', rule] as const;
const deadline = (rule: unknown) => ['uint256 deadline', rule] as const;
const start = (rule: unknown) => ['uint256 start', rule] as const;

for (const [what, params, said] of [
  ['the minimum declared a time, after the amount sold', [sold(), least(TIME), deadline(FLOOR)], /beside a free time it must come after sell-amount, with the time not between them/],
  ['the minimum declared a time, after a deadline first', [deadline(FLOOR), sold(), least(TIME)], /beside a free time it must come after sell-amount/],
  ['the amount received declared a time, before the most sold', [least(TIME), sold({ atMost: 'card.sell-amount' }), deadline(FLOOR)], /beside a free time it must come before sell-amount/],
  ['the amount received declared a time, between a deadline and the most sold', [deadline(FLOOR), least(TIME), sold({ atMost: 'card.sell-amount' })], /beside a free time it must come before sell-amount/],
  ['two free times', [start(TIME), sold(), least(FLOOR), deadline(TIME)], /2 free times of type uint256 sit beside it/],
  ['the minimum at most an amount', [sold(), least({ atMost: 'card.other' }), deadline(FLOOR)], /another uint256 beside it is neither a const, a time nor one of the two amounts/],
  ['the minimum another card amount', [sold(), least({ card: 'other' }), deadline(FLOOR)], /another uint256 beside it/],
  ['the minimum at least another card amount', [sold(), least({ atLeast: 'card.other' }), deadline(FLOOR)], /another uint256 beside it/],
  ['the minimum at most the amount sold', [sold(), least({ atMost: 'card.sell-amount' }), deadline(FLOOR)], /another uint256 beside it/],
  ['a deadline left plainly free', [sold(), least(FLOOR), deadline({ free: 'x' })], /a free uint256 sits beside it and could be the real minimum; a deadline must be declared a time, \{"free": \{"time": "<why>"\}\}/],
] as const) {
  test(`a floor is refused beside ${what}`, () => {
    assert.throws(
      () => parseTemplate(swapOf(params), shipped, 'committed'),
      (error) => error instanceof TemplateError && error.message.startsWith('card.min-buy.floor:') && UNBOUND.test(error.message) && said.test(error.message),
    );
  });
}

for (const [what, params] of [
  ['an exact sale with a deadline last', [sold(), least(FLOOR), deadline(TIME)]],
  ['an exact sale with a deadline first', [deadline(TIME), sold(), least(FLOOR)]],
  ['an amount received, the most sold and a deadline', [least(FLOOR), sold({ atMost: 'card.sell-amount' }), deadline(TIME)]],
  ['a deadline within seconds, and a const', [start({ const: '0' }), sold(), least(FLOOR), deadline({ withinSeconds: 600 })]],
  ['a minimum before the amount sold, with no free time', [least(FLOOR), sold()]],
] as const) {
  test(`a floor loads in ${what}`, () => {
    parseTemplate(swapOf(params), shipped, 'committed');
  });
}

test('the shipped swap template loads with a floor on it', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'cow', 'swap', 'template.json'), 'utf8'));
  raw.card['min-buy'].floor = { sells: 'sell-amount' };
  parseTemplate(raw, loadRegistry(ROOT), 'committed');
});

test('a real swap meets a card whose floor is at or below its own minimum, and one unit above it is a mismatch, with or without `floor` in the template', () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', 'uniswap-swap-hook-usdc-usdt.json'), 'utf8'));
  const tx = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
  const least = 19_923_502_689n;
  const plain = template('uniswap/swap');
  delete plain.card['min-buy'].floor;
  for (const json of [template('uniswap/swap'), plain]) {
    const templates = new Map([['uniswap/swap', parseTemplate(json, shipped, 'committed')]]);
    const check = (minBuy: bigint) => {
      const card = resolveCard(parseCard({ operations: [{ template: 'uniswap/swap', values: { 'sell-token': 'usdc', 'buy-token': 'usdt', 'sell-amount': '20000000000', 'min-buy': `${minBuy}` } }] }), { templates, registry: shipped, addressBook: new Map(), safe: tx.safe });
      assert.equal(card.kind, 'resolved');
      return checkTemplateFields(tx, (card as Extract<typeof card, { kind: 'resolved' }>).card, templates, shipped).kind;
    };
    assert.equal(check(least), 'match');
    assert.equal(check(least - 1n), 'match');
    assert.equal(check(least + 1n), 'mismatch');
  }
});
