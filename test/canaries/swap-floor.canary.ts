import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../../src/card.ts';
import type { Transport } from '../../src/chain/rpc.ts';
import { main } from '../../src/cli/main.ts';
import { keccakCode } from '../../src/contracts/code.ts';
import { parseFunctionSignature } from '../../src/decode/abi.ts';
import { encodeCall, encodeParams } from '../../src/decode/codec.ts';
import type { AbiValue } from '../../src/decode/codec.ts';
import { parseRegistry } from '../../src/registry.ts';
import type { Address, Hex, SafeTx } from '../../src/safe/types.ts';
import { checkTemplateFields } from '../../src/template/check.ts';
import { TemplateError, parseTemplate } from '../../src/template/template.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const SAFE = `0x${'5a'.repeat(20)}` as Address;
const CODE = '0x00' as Hex;
const PIN = { hash: keccakCode(CODE), from: 0 };
const SWAP = 'swap(address sell, address buy, uint256 amountIn, uint256 minOut, address to)';
const SOLD = 1_000_000_000n;

const at = (byte: string): string => `0x${byte.repeat(20)}`;
const of = (byte: string, kind: string, rest: object = {}) => ({ address: at(byte), kind, source: 'https://example.com/', ...rest });
const feed = (byte: string, unit: string, rest: object = {}) =>
  of(byte, 'oracle', { code: PIN, feed: { description: `${unit} / USD`, decimals: 8, heartbeat: 86_400, deviationBps: 25, sourceClass: 'cex_price', quote: 'usd', ...rest } });

const plainRegistry = { one: of('a1', 'token'), two: of('a2', 'token'), dex: of('a3', 'router') };
const priced = {
  ...plainRegistry,
  one: of('a1', 'token', { code: PIN, price: { feed: 'one-usd', peg: 'usd' } }),
  two: of('a2', 'token', { code: PIN, price: { feed: 'two-usd', peg: 'usd' } }),
  'one-usd': feed('b1', 'ONE'),
  'two-usd': feed('b2', 'TWO'),
  pools: of('b3', 'factory', { instanceCheck: { function: 'getPool(address,address)', args: [{ attribute: 'token0' }, { attribute: 'token1' }] } }),
  pool: of('b4', 'pool', { code: PIN, attributes: { factory: 'pools', token0: 'one', token1: 'two' }, twap: { minLiquidity: '1000000' } }),
};
/** Feeds that may be off by 51 bps together, one more than a floor may be computed from. */
const loose = { ...priced, 'one-usd': feed('b1', 'ONE', { deviationBps: 26 }) };
const twoUnpriced = { ...priced, two: of('a2', 'token') };
const ATTRIBUTES = { asset: 'token', factory: 'factory', adapter: 'adapter', token0: 'token', token1: 'token' };

const swapTemplate = (floor: object) => ({
  id: 'test/swap',
  card: {
    'sell-token': { kind: 'contract', registryKind: 'token', names: ['one', 'two'] },
    'buy-token': { kind: 'contract', registryKind: 'token', names: ['one', 'two'] },
    'sell-amount': { kind: 'amount', of: 'sell-token' },
    'min-buy': { kind: 'amount', of: 'buy-token', ...floor },
  },
  calls: [
    {
      to: { contract: 'dex' },
      value: { const: '0' },
      function: SWAP,
      args: { sell: { card: 'sell-token' }, buy: { card: 'buy-token' }, amountIn: { card: 'sell-amount' }, minOut: { atLeast: 'card.min-buy' }, to: { safe: true } },
    },
  ],
  effects: { gives: [{ token: 'card.sell-token', amount: 'card.sell-amount' }], gets: [{ token: 'card.buy-token', amount: { atLeast: 'card.min-buy' } }] },
});

const FLOOR = { floor: { sells: 'sell-amount' } };

const span: AbiValue['span'] = [0, 0];
const uint = (value: bigint): AbiValue => ({ kind: 'uint', value, span });
const int = (value: bigint): AbiValue => ({ kind: 'int', value, span });
const address = (value: string): AbiValue => ({ kind: 'address', value: value as Address, span });
const hex = (bytes: Uint8Array): Hex => `0x${Buffer.from(bytes).toString('hex')}` as Hex;
const encoded = (types: string, values: AbiValue[]): Hex => hex(encodeParams(parseFunctionSignature(`f(${types})`), values));
const selector = (signature: string): Hex => parseFunctionSignature(signature).selector;

function swapOf(minOut: bigint): SafeTx {
  const args = [address(at('a1')), address(at('a2')), uint(SOLD), uint(minOut), address(SAFE)];
  const data = hex(encodeCall({ fn: parseFunctionSignature(SWAP), args, trailer: undefined }));
  const zero = at('00') as Address;
  return { chainId: 1n, version: '1.4.1', safe: SAFE, to: at('a3') as Address, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zero, refundReceiver: zero, nonce: 1n };
}

test('a swap whose minimum is one base unit under the card\'s is a mismatch, and one at or over it is not', () => {
  const registry = parseRegistry(plainRegistry);
  const templates = new Map([['test/swap', parseTemplate(swapTemplate({}), registry, 'committed')]]);
  const card = resolveCard({ operations: [{ template: 'test/swap', values: { 'sell-token': 'one', 'buy-token': 'two', 'sell-amount': `${SOLD}`, 'min-buy': '992500000' } }] }, { templates, registry, addressBook: new Map(), safe: SAFE });
  assert.equal(card.kind, 'resolved');
  const judged = (minOut: bigint) => checkTemplateFields(swapOf(minOut), (card as Extract<typeof card, { kind: 'resolved' }>).card, templates, registry).kind;
  assert.equal(judged(992_500_000n), 'match');
  assert.equal(judged(992_500_001n), 'match');
  assert.equal(judged(992_499_999n), 'mismatch');
  assert.equal(judged(0n), 'mismatch');
});

type World = {
  readonly one: bigint;
  readonly two: bigint;
  readonly age: bigint;
  readonly updatedAtZero: boolean;
  readonly tick: bigint;
  readonly liquidity: bigint;
  readonly buyDecimals: bigint;
  readonly feedDecimals: bigint;
  readonly unit: string;
  readonly otherCodeAt: string;
  readonly revertingAt: string;
};
/** Both tokens at one dollar in the feeds and in the pool. */
const CALM: World = { one: 100_000_000n, two: 100_000_000n, age: 60n, updatedAtZero: false, tick: 0n, liquidity: 10n ** 18n, buyDecimals: 6n, feedDecimals: 8n, unit: 'ONE', otherCodeAt: '', revertingAt: '' };

function answerOf(world: World, now: bigint, to: string, data: string): Hex {
  const [called, isOne] = [data.slice(0, 10), to === at('b1')];
  if (to === at('a1') || to === at('a2')) return encoded('uint8', [uint(to === at('a1') ? 6n : world.buyDecimals)]);
  if (called === selector('description()')) return encoded('string', [{ kind: 'string', value: Buffer.from(`${isOne ? world.unit : 'TWO'} / USD`), span }]);
  if (called === selector('decimals()')) return encoded('uint8', [uint(isOne ? world.feedDecimals : 8n)]);
  if (called === selector('latestRoundData()')) return encoded('uint80,int256,uint256,uint256,uint80', [uint(1n), int(isOne ? world.one : world.two), uint(1n), uint(world.updatedAtZero ? 0n : now - world.age), uint(1n)]);
  if (called === selector('observe(uint32[])')) {
    const window = BigInt(`0x${data.slice(138, 202)}`);
    return encoded('int56[],uint160[]', [
      { kind: 'array', items: [int(0n), int(world.tick * window)], span },
      { kind: 'array', items: [uint(0n), uint((window << 128n) / world.liquidity)], span },
    ]);
  }
  return assert.fail(`${called} on ${to}`);
}

const transportOf = (alchemy: World, drpc: World, now: bigint): Transport => async (url, body) => {
  const world = url.includes('drpc') ? drpc : alchemy;
  const { method, params } = JSON.parse(body) as { method: string; params: [string & { to: string; data: string }] };
  const reply = (result: unknown) => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
  const hash = `0x${'ab'.repeat(32)}`;
  switch (method) {
    case 'eth_blockNumber':
      return reply('0x10');
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return reply({ number: '0x10', hash, timestamp: `0x${now.toString(16)}`, gasLimit: '0x1', mixHash: hash });
    case 'eth_getCode':
      return reply(params[0] as string === world.otherCodeAt ? '0x01' : CODE);
    case 'eth_getStorageAt':
      return reply(`0x${'0'.repeat(64)}`);
    default: {
      const to = params[0].to.toLowerCase();
      if (to === world.revertingAt) return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }) };
      return reply(answerOf(world, now, to, params[0].data));
    }
  }
};

const repos = new Map<string, string>();

/** A clone whose main holds the template and `registry`. */
function cloneOf(registry: object): string {
  const key = JSON.stringify(registry);
  const made = repos.get(key);
  if (made !== undefined) return made;
  const base = mkdtempSync(join(tmpdir(), 'kiss-sign-floor-canary-'));
  const [origin, repo] = [join(base, 'origin.git'), join(base, 'repo')];
  git(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(base, 'clone', '--quiet', origin, repo);
  write(join(repo, 'templates', 'test', 'swap', 'template.json'), JSON.stringify(swapTemplate(FLOOR)));
  write(join(repo, 'registry', 'contracts.json'), key);
  write(join(repo, 'registry', 'attributes.json'), JSON.stringify(ATTRIBUTES));
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'data');
  git(repo, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  const ssh = write(join(base, 'ssh'), `#!/bin/sh\nexec git-upload-pack '${origin}'\n`);
  chmodSync(ssh, 0o755);
  git(repo, 'remote', 'set-url', 'origin', 'git@github.com:signer/kiss-sign.git');
  git(repo, 'config', 'core.sshCommand', ssh);
  repos.set(key, repo);
  return repo;
}

type Run = { readonly world?: Partial<World>; readonly drpc?: Partial<World>; readonly registry?: object; readonly pair?: readonly [string, string]; readonly lines: readonly string[] };

/** The minimum `card new` seals for a swap of 1000 of the first token to the second, or why it seals none: its own refusal, never a crash. */
async function cardNew({ world = {}, drpc = world, registry = priced, pair = ['one', 'two'], lines }: Run): Promise<bigint | string> {
  const home = mkdtempSync(join(tmpdir(), 'kiss-sign-floor-home-'));
  write(join(home, 'config.json'), JSON.stringify({ chainId: 1, safe: SAFE, repo: 'github.com/signer/kiss-sign' }));
  const queue = [...pair, '1000', ...lines];
  let said = '';
  const code = await main(['card', 'new', 'test/swap'], {
    env: { KISS_SIGN_HOME: home, ALCHEMY_API_KEY: 'test-key', DRPC_API_KEY: 'test-key-drpc' },
    stdout: () => {},
    stderr: (text) => void (said += text),
    platform: 'linux',
    readSecret: undefined,
    ask: async () => queue.shift(),
    repoRoot: cloneOf(registry),
    transport: transportOf({ ...CALM, ...world }, { ...CALM, ...drpc }, BigInt(Math.floor(Date.now() / 1000))),
    fetchJson: async () => assert.fail('card new fetches nothing'),
    readMessage: async () => ({ why: 'none' }),
  });
  const cards = join(home, 'cards');
  const [file] = existsSync(cards) ? readdirSync(cards) : [];
  if (file !== undefined) {
    assert.equal(code, 0, said);
    return BigInt(JSON.parse(readFileSync(join(cards, file), 'utf8')).operations[0].values['min-buy']);
  }
  assert.equal(code, 1, said);
  assert.notEqual(said, '');
  return said;
}

/** Before a program knows `floor`, loading the template refuses it with exactly this, and there is nothing to guard. */
function knowsFloor(): boolean {
  try {
    parseTemplate(swapTemplate(FLOOR), parseRegistry(plainRegistry), 'committed');
    return true;
  } catch (error) {
    if (error instanceof TemplateError && error.message === 'card.min-buy.floor: unexpected field') return false;
    throw error;
  }
}
const floorTest = (name: string, body: () => Promise<void>) => test(name, { skip: knowsFloor() ? false : 'this program refuses a floor field' }, body);

/** Each expected floor is worked out by hand from the price, the slippage and the 0.25% margin, never by the program. */
const COMPUTED: readonly (readonly [string, Run, bigint])[] = [
  ['both at a dollar, 0.50% on Enter', { lines: ['', 'y'] }, 992_500_000n],
  ['the most slippage, 1.00%', { lines: ['1', 'y'] }, 987_500_000n],
  ['no slippage but the margin', { lines: ['0', 'y'] }, 997_500_000n],
  ['a pool that says less', { world: { tick: -10n }, lines: ['', 'y'] }, 992_500_000n],
  ['a feed that says less', { world: { one: 99_900_000n }, lines: ['', 'y'] }, 992_500_000n],
  ['a pool that says more', { world: { tick: 10n }, lines: ['', 'y'] }, 993_492_946n],
  ['the feeds\' price, above the pool\'s', { world: { one: 99_500_000n, two: 100_200_000n, tick: -75n }, lines: ['', 'y'] }, 985_566_367n],
  ['the pool\'s price, above the feeds\'', { world: { one: 99_500_000n, two: 100_200_000n, tick: -65n }, lines: ['', 'y'] }, 986_069_991n],
  ['the reverse pair by the pool', { world: { one: 99_500_000n, two: 100_200_000n, tick: -75n }, pair: ['two', 'one'], lines: ['', 'y'] }, 999_971_359n],
  ['the reverse pair by the feeds', { world: { one: 99_500_000n, two: 100_200_000n, tick: -65n }, pair: ['two', 'one'], lines: ['', 'y'] }, 999_482_412n],
  ['6 to 18 decimals by the feeds', { world: { one: 99_500_000n, two: 100_200_000n, tick: 276_249n, buyDecimals: 18n }, lines: ['', 'y'] }, 985_566_367_265_469_061_876n],
  ['18 to 6 decimals by the feeds', { world: { tick: 276_330n, buyDecimals: 18n }, pair: ['two', 'one'], lines: ['', 'y'] }, 992_500_000n],
];

for (const [what, run, expected] of COMPUTED) {
  floorTest(`a computed floor: ${what}`, async () => {
    assert.equal(await cardNew(run), expected);
  });
}

floorTest('a slippage over 1.00% is refused', async () => {
  assert.equal(typeof (await cardNew({ lines: ['1.01', 'y'] })), 'string');
});

const JUST_PAST_A_LIMIT: readonly (readonly [string, Partial<World>])[] = [
  ['a pool 15.99 bps below the feeds', { tick: -16n }],
  ['a pool 16.01 bps above the feeds', { tick: 16n }],
  ['a pool one under its least liquidity', { liquidity: 999_999n }],
  ['a sold token 1.01% under its peg', { one: 98_990_000n, tick: -102n }],
  ['a sold token 1.01% over its peg', { one: 101_010_000n, tick: 100n }],
  ['a bought token 1.01% over its peg', { two: 101_010_000n, tick: -100n }],
  ['a bought token 1.01% under its peg', { two: 98_990_000n, tick: 102n }],
  ['a feed a second past its heartbeat and an hour', { age: 90_001n }],
  ['a pool that reverts', { revertingAt: at('b4') }],
];

for (const [what, world] of JUST_PAST_A_LIMIT) {
  floorTest(`${what} computes nothing: Enter, a percent, one key or one typing seals nothing, and the same minimum typed twice does`, async () => {
    for (const lines of [['', 'y'], ['1', 'y'], ['y', 'y'], ['990', 'y'], ['990', '', 'y'], ['990', '991', 'y', 'y']]) assert.equal(typeof (await cardNew({ world, lines })), 'string', `${lines}`);
    assert.equal(await cardNew({ world, lines: ['990', '990', 'y'] }), 990_000_000n);
  });
}

floorTest('feeds that may be off by 51 bps together compute nothing, and a minimum over 2.50% below the price, or 150 bps of doubt, is typed twice', async () => {
  const typed = (lines: readonly string[], world: Partial<World> = {}) => cardNew({ registry: loose, world, lines });
  assert.equal(typeof (await typed(['', 'y'])), 'string');
  assert.equal(await typed(['975', 'y']), 975_000_000n);
  assert.equal(typeof (await typed(['974.999', 'y'])), 'string');
  assert.equal(await typed(['974.999', '974.999', 'y']), 974_999_000n);
  assert.equal(await typed(['990', 'y'], { tick: -151n }), 990_000_000n);
  assert.equal(typeof (await typed(['990', 'y'], { tick: -152n })), 'string');
});

floorTest('a token without a feed takes the typed minimum', async () => {
  assert.equal(await cardNew({ registry: twoUnpriced, lines: ['900', 'y'] }), 900_000_000n);
});

const REFUSED: readonly (readonly [string, Partial<World>, string, Partial<World>?])[] = [
  ['a sold token\'s feed at 0', { one: 0n }, 'one-usd'],
  ['a bought token\'s feed at 0', { two: 0n }, 'two-usd'],
  ['a feed below 0', { one: -100_000_000n }, 'one-usd'],
  ['a feed from the future', { age: -1n }, 'one-usd'],
  ['a feed never updated', { updatedAtZero: true }, 'one-usd'],
  ['a feed that says it prices another unit', { unit: 'TWO' }, 'one-usd'],
  ['a feed of other decimals', { feedDecimals: 18n }, 'one-usd'],
  ['a feed that reverts', { revertingAt: at('b2') }, 'two-usd'],
  ['a feed that runs other code', { otherCodeAt: at('b1') }, 'one-usd'],
  ['a pool that runs other code', { otherCodeAt: at('b4') }, 'pool'],
  ['one provider that lies about a feed', {}, 'one-usd', { one: 99_000_000n }],
  ['one provider that lies about a pool', {}, 'pool', { tick: -5n }],
];

for (const [what, world, named, drpc] of REFUSED) {
  floorTest(`${what} gives no card, whatever is typed, and the refusal names ${named}`, async () => {
    for (const lines of [['', 'y'], ['900', 'y'], ['900', '900', 'y']]) assert.match(String(await cardNew({ world, drpc: drpc ?? world, lines })), new RegExp(`\\b${named}\\b`), `${lines}`);
  });
}
