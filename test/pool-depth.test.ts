import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReader } from '../src/chain/reader.ts';
import { REPLAY_ENDPOINTS } from '../src/chain/recording.ts';
import type { Transport } from '../src/chain/rpc.ts';
import { parseFunctionSignature } from '../src/decode/abi.ts';
import type { AbiValue } from '../src/decode/codec.ts';
import { encodeParams } from '../src/decode/codec.ts';
import { loadRegistry } from '../src/registry.ts';
import { SAMPLE_EVERY, SAMPLES, poolDepthText } from '../src/research/pool-depth.ts';
import type { Blocks, DepthRequest } from '../src/research/pool-depth.ts';
import { parseAddress } from '../src/safe/types.ts';

const registry = loadRegistry(join(import.meta.dirname, '..'));
const POOL = parseAddress('pool', `0x${'34'.repeat(20)}`);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const HEAD = 26_500_008n;
const SETTLED = HEAD - 8n;
/** A power of two, so window × 2^128 over (window × 2^128 / L) gives back exactly L. */
const L = 2n ** 44n;

/** `no-code`: the call answers nothing and the pool has no code; `empty`: it answers nothing though the pool has code. */
type State = { readonly tick: bigint; readonly liquidity: bigint } | 'revert' | 'no-code' | 'empty';
type World = { readonly at: (block: bigint, window: bigint) => State; readonly drpc?: (block: bigint, window: bigint) => State; readonly notAPool?: boolean; readonly secondsStart?: bigint };

const span: AbiValue['span'] = [0, 0];
const encoded = (types: string, values: AbiValue[]): string => `0x${Buffer.from(encodeParams(parseFunctionSignature(`f(${types})`), values)).toString('hex')}`;
const selector = (signature: string) => parseFunctionSignature(signature).selector;
const hashOf = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const reverted = { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }) };

function transportOf(world: World): Transport {
  return async (url, body) => {
    const { method, params } = JSON.parse(body) as { method: string; params: any[] };
    const reply = (result: unknown) => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
    const block = (n: bigint) => reply({ number: `0x${n.toString(16)}`, hash: hashOf(n), timestamp: `0x${(1_700_000_000n + n * 12n).toString(16)}`, gasLimit: '0x1', mixHash: hashOf(n) });
    if (method === 'eth_blockNumber') return reply(`0x${HEAD.toString(16)}`);
    if (method === 'eth_getBlockByNumber') return block(BigInt(params[0]));
    if (method === 'eth_getBlockByHash') return block(BigInt(params[0]));
    if (method === 'eth_getCode') return reply(world.at(BigInt(params[1].blockHash), 1800n) === 'no-code' ? '0x' : '0x60');
    assert.equal(method, 'eth_call');
    const [{ to, data }, { blockHash }] = params as [{ to: string; data: string }, { blockHash: string }];
    const at = BigInt(blockHash);
    const called = data.slice(0, 10);
    if (to.toLowerCase() === POOL.toLowerCase()) {
      if (called === selector('token0()')) return world.notAPool ? reverted : reply(encoded('address', [{ kind: 'address', value: parseAddress('t', USDC), span }]));
      if (called === selector('token1()')) return reply(encoded('address', [{ kind: 'address', value: parseAddress('t', USDT), span }]));
      assert.equal(called, selector('observe(uint32[])'));
      const window = BigInt(`0x${data.slice(10 + 64 * 2, 10 + 64 * 3)}`);
      const state = (url.includes('drpc') && world.drpc !== undefined ? world.drpc : world.at)(at, window);
      if (state === 'revert') return reverted;
      if (state === 'no-code' || state === 'empty') return reply('0x');
      const start = world.secondsStart ?? 7n;
      return reply(
        encoded('int56[],uint160[]', [
          { kind: 'array', items: [{ kind: 'int', value: -5000n, span }, { kind: 'int', value: -5000n + state.tick * window, span }], span },
          { kind: 'array', items: [{ kind: 'uint', value: start, span }, { kind: 'uint', value: (start + (window << 128n) / state.liquidity) % 2n ** 160n, span }], span },
        ]),
      );
    }
    assert.equal(called, selector('decimals()'));
    return reply(encoded('uint8', [{ kind: 'uint', value: 6n, span }]));
  };
}

const depth = (world: World, blocks: Blocks, request: Partial<Omit<DepthRequest, 'blocks'>> = {}) =>
  poolDepthText(createReader(REPLAY_ENDPOINTS, transportOf(world), { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] }), registry, POOL, {
    blocks,
    windows: [1800n, 300n],
    min: undefined,
    ...request,
  });

const given: Blocks = { kind: 'given', calm: 26_000_000n, stressed: 26_100_000n };
const steady: World = { at: (block) => ({ tick: block === given.stressed ? -40n : 1n, liquidity: block === given.stressed ? L / 4n : L }) };

test('given blocks: the harmonic mean liquidity over 30 and 5 minutes at each, with the pool tokens the registry names', async () => {
  const { read, text } = await depth(steady, given);
  assert.equal(read, true);
  assert.match(text, /^pool {9}not in the registry 0x3434343434343434343434343434343434343434\ntoken0 {7}usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 6 decimals\ntoken1 {7}usdt 0xdAC17F958D2ee523a2206206994597C13D831ec7, 6 decimals\n/);
  assert.match(text, new RegExp(`^calm {6}\\S+ \\S+  block 26000000  30 min ${L}  5 min ${L}$`, 'm'));
  assert.match(text, new RegExp(`^stressed {2}\\S+ \\S+  block 26100000  30 min ${L / 4n}  5 min ${L / 4n}$`, 'm'));
});

test('beside each measure, the mean price and what moves it 100 ticks at that liquidity', async () => {
  const tick = 6932n;
  const { text } = await depth({ at: () => ({ tick, liquidity: L }) }, given);
  // With √P = 1.0001^(tick/2), 100 ticks up take L × √P × (1.0001^50 − 1) of token1, and down L / √P × (1.0001^50 − 1) of token0.
  const [root, band] = [1.0001 ** (Number(tick) / 2), 1.0001 ** 50 - 1];
  const whole = (n: number) => Math.floor(n / 1e6).toLocaleString('en-US');
  assert.match(text, new RegExp(`30-minute mean price ${(root * root).toPrecision(6)} usdt per usdc; at this liquidity ${whole(Number(L) * root * band)}\\.\\d\\d usdt moves it up 100 ticks \\(1\\.005%\\), ${whole((Number(L) / root) * band)}\\.\\d\\d usdc down`));
});

test('a secondsPerLiquidityCumulativeX128 that wraps past 2^160 gives the same liquidity', async () => {
  const { text } = await depth({ ...steady, secondsStart: 2n ** 160n - 5n }, given);
  assert.match(text, new RegExp(`^calm {6}\\S+ \\S+  block 26000000  30 min ${L}  5 min ${L}$`, 'm'));
});

test('a window the pool has no history for says so, and the shorter one still reads', async () => {
  const { text } = await depth({ at: (_, window) => (window === 1800n ? 'revert' : { tick: 0n, liquidity: L }) }, given);
  assert.match(text, new RegExp(`block 26000000  30 min no mean price \\(observe reverted\\)  5 min ${L}$`, 'm'));
});

test('providers that disagree on a block make that measure UNVERIFIABLE', async () => {
  const { text } = await depth({ ...steady, drpc: (block, window) => (block === given.stressed ? { tick: 1n, liquidity: L * 2n } : steady.at(block, window)) }, given);
  assert.match(text, /block 26100000  30 min UNVERIFIABLE eth_call: alchemy and drpc disagree/);
  assert.match(text, new RegExp(`block 26000000  30 min ${L}`));
});

test('a contract that answers no token0() is refused', async () => {
  const { read, text } = await depth({ ...steady, notAPool: true }, given);
  assert.equal(read, false);
  assert.match(text, /^REFUSED 0x3434343434343434343434343434343434343434: token0\(\) answered a revert, as no Uniswap v3 pool does/);
});

test('given blocks with --min mark each measure under it', async () => {
  const { text } = await depth(steady, given, { min: L / 2n });
  assert.match(text, new RegExp(`^minLiquidity ${L / 2n}, as given$`, 'm'));
  assert.match(text, new RegExp(`block 26000000  30 min ${L}  5 min ${L}$`, 'm'));
  assert.match(text, new RegExp(`block 26100000  30 min ${L / 4n} \\(under minLiquidity\\)  5 min ${L / 4n} \\(under minLiquidity\\)$`, 'm'));
});

test('a given block with no measure over any window leaves the pair incomplete and the run not read', async () => {
  const { read, text } = await depth({ at: (block) => (block === given.stressed ? 'revert' : { tick: 0n, liquidity: L }) }, given);
  assert.equal(read, false);
  assert.match(text, /^INCOMPLETE the stressed block gave no measure over any window, so the pair cannot set minLiquidity$/m);
});

test('an empty answer is no code only when the pool has no code at that block, and otherwise UNVERIFIABLE', async () => {
  const { text } = await depth({ at: (block) => (block === given.calm ? 'no-code' : 'empty') }, given);
  assert.match(text, /block 26000000  30 min no code at the pool yet  5 min no code at the pool yet$/m);
  assert.match(text, /block 26100000  30 min UNVERIFIABLE observe answered no \(int56\[\], uint160\[\]\)  5 min UNVERIFIABLE/m);
});

const sample = (i: number) => SETTLED - BigInt(SAMPLES - i) * SAMPLE_EVERY;
const dateOfBlock = (n: bigint) => new Date(Number(1_700_000_000n + n * 12n) * 1000).toISOString().slice(0, 16).replace('T', ' ');

test('--auto samples a year daily and picks the median-liquidity block as calm, the largest daily move as stressed, and the thinnest', async () => {
  const [move, thin] = [sample(200), sample(300)];
  const at = (block: bigint): State => {
    const i = Number((block - sample(0)) / SAMPLE_EVERY);
    return { tick: block === move ? 30n : 0n, liquidity: block === thin ? L / 8n : L + BigInt(i) * 1000n };
  };
  const { read, text } = await depth({ at }, { kind: 'auto' }, { min: L + 10_000n });
  assert.equal(read, true);
  // 366 samples; the thin one sorts first, so the lower median, position 182, is sample 181.
  assert.match(text, new RegExp(`^calm {6}\\S+ \\S+  block ${sample(181)}  30 min ${L + 181_000n}`, 'm'));
  assert.match(text, new RegExp(`^stressed {2}\\S+ \\S+  block ${move}  30 min `, 'm'));
  assert.match(text, new RegExp(`^lowest {4}\\S+ \\S+  block ${thin}  30 min ${L / 8n} \\(under minLiquidity\\)`, 'm'));
  assert.match(text, new RegExp(`^sampled {6}366 blocks 7200 apart \\(about a day\\), from ${dateOfBlock(sample(0))} \\(block ${sample(0)}\\) to ${dateOfBlock(SETTLED)} \\(block ${SETTLED}\\)$`, 'm'));
  // Under L + 10,000: samples 0 to 9 and the thin one, sample 300.
  assert.match(text, /^ {2}over 30 min 366 read, 11 of them under minLiquidity; 0 before the pool had code, 0 with no mean price, 0 UNVERIFIABLE$/m);
  assert.match(text, /^ {2}over 5 min 366 read, 11 of them under minLiquidity;/m);
});

test('--auto over 5 minutes ranks by the 5-minute measure, and counts samples before the pool had code apart from failed reads', async () => {
  const born = sample(300);
  const at = (block: bigint, window: bigint): State => {
    if (block < born) return 'no-code';
    if (window === 1800n) return 'revert';
    return { tick: 0n, liquidity: block === sample(350) ? L / 2n : L };
  };
  const { read, text } = await depth({ at }, { kind: 'auto' }, { windows: [300n] });
  assert.equal(read, true);
  assert.match(text, new RegExp(`^lowest {4}\\S+ \\S+  block ${sample(350)}  5 min ${L / 2n}$`, 'm'));
  assert.match(text, /^ {2}over 5 min 66 read; 300 before the pool had code, 0 with no mean price, 0 UNVERIFIABLE$/m);
  assert.doesNotMatch(text, /30 min/);
});

test('--auto with fewer than two readable samples picks nothing and reads as not read', async () => {
  const { read, text } = await depth({ at: (block) => (block === SETTLED ? { tick: 0n, liquidity: L } : 'revert') }, { kind: 'auto' });
  assert.equal(read, false);
  assert.match(text, /^no calm or stressed block: fewer than two samples gave a mean price over 30 minutes$/m);
  assert.match(text, /^ {2}over 30 min 1 read; 0 before the pool had code, 365 with no mean price, 0 UNVERIFIABLE$/m);
});
