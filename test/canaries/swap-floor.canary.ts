import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { parseTemplate } from '../../src/template/template.ts';
import { git, write } from './verify-harness.ts';

const SAFE = `0x${'5a'.repeat(20)}` as Address;
const CODE = '0x00' as Hex;
const PIN = { hash: keccakCode(CODE), from: 0 };
const NOW = 1_800_000_000n;
const SWAP = 'swap(address sell, address buy, uint256 amountIn, uint256 minOut, address to)';
const SOLD = 1_000_000_000n;

const at = (byte: string): string => `0x${byte.repeat(20)}`;
const of = (byte: string, kind: string, rest: object = {}) => ({ address: at(byte), kind, source: 'https://example.com/', ...rest });
const feed = (byte: string, unit: string) => of(byte, 'oracle', { code: PIN, feed: { description: `${unit} / USD`, decimals: 8, heartbeat: 86_400, deviationBps: 25, sourceClass: 'cex_price', quote: 'usd' } });

const plainRegistry = { one: of('a1', 'token'), two: of('a2', 'token'), dex: of('a3', 'router') };
const pricedRegistry = {
  one: of('a1', 'token', { price: { feed: 'one-usd', peg: 'usd' } }),
  two: of('a2', 'token', { price: { feed: 'two-usd', peg: 'usd' } }),
  dex: of('a3', 'router'),
  'one-usd': feed('b1', 'ONE'),
  'two-usd': feed('b2', 'TWO'),
  pools: of('b3', 'factory', { instanceCheck: { function: 'getPool(address,address)', args: [{ attribute: 'token0' }, { attribute: 'token1' }] } }),
  pool: of('b4', 'pool', { code: PIN, attributes: { factory: 'pools', token0: 'one', token1: 'two' }, twap: { minLiquidity: '1000000' } }),
};
const ATTRIBUTES = { asset: 'token', factory: 'factory', adapter: 'adapter', token0: 'token', token1: 'token' };

const swapTemplate = (floor: object) => ({
  id: 'test/swap',
  card: {
    'sell-token': { kind: 'contract', registryKind: 'token' },
    'buy-token': { kind: 'contract', registryKind: 'token' },
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
  const templates = new Map([['test/swap', parseTemplate(swapTemplate({}), registry)]]);
  const card = resolveCard({ operations: [{ template: 'test/swap', values: { 'sell-token': 'one', 'buy-token': 'two', 'sell-amount': `${SOLD}`, 'min-buy': '992500000' } }] }, { templates, registry, addressBook: new Map(), safe: SAFE });
  assert.equal(card.kind, 'resolved');
  const judged = (minOut: bigint) => checkTemplateFields(swapOf(minOut), (card as Extract<typeof card, { kind: 'resolved' }>).card, templates, registry).kind;
  assert.equal(judged(992_500_000n), 'match');
  assert.equal(judged(992_500_001n), 'match');
  assert.equal(judged(992_499_999n), 'mismatch');
  assert.equal(judged(0n), 'mismatch');
});

type World = { readonly one: bigint; readonly two: bigint; readonly age: bigint; readonly tick: bigint; readonly liquidity: bigint; readonly code: Hex };
/** Both tokens at one dollar in the feeds and in the pool. */
const CALM: World = { one: 100_000_000n, two: 100_000_000n, age: 60n, tick: 0n, liquidity: 10n ** 18n, code: CODE };

function answerOf(world: World, to: string, data: string): Hex {
  const [called, unit] = [data.slice(0, 10), to === at('b1') ? 'ONE' : 'TWO'];
  if (to === at('a1') || to === at('a2')) return encoded('uint8', [uint(6n)]);
  if (called === selector('description()')) return encoded('string', [{ kind: 'string', value: Buffer.from(`${unit} / USD`), span }]);
  if (called === selector('decimals()')) return encoded('uint8', [uint(8n)]);
  if (called === selector('latestRoundData()')) return encoded('uint80,int256,uint256,uint256,uint80', [uint(1n), int(unit === 'ONE' ? world.one : world.two), uint(1n), uint(NOW - world.age), uint(1n)]);
  if (called === selector('observe(uint32[])')) {
    const window = BigInt(`0x${data.slice(138, 202)}`);
    return encoded('int56[],uint160[]', [
      { kind: 'array', items: [int(0n), int(world.tick * window)], span },
      { kind: 'array', items: [uint(0n), uint((window << 128n) / world.liquidity)], span },
    ]);
  }
  return assert.fail(`${called} on ${to}`);
}

const transportOf = (alchemy: World, drpc: World): Transport => async (url, body) => {
  const world = url.includes('drpc') ? drpc : alchemy;
  const { method, params } = JSON.parse(body) as { method: string; params: [string & { to: string; data: string }] };
  const reply = (result: unknown) => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
  const hash = `0x${'ab'.repeat(32)}`;
  switch (method) {
    case 'eth_blockNumber':
      return reply('0x10');
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return reply({ number: '0x10', hash, timestamp: `0x${NOW.toString(16)}`, gasLimit: '0x1', mixHash: hash });
    case 'eth_getCode':
      return reply(world.code);
    case 'eth_getStorageAt':
      return reply(`0x${'0'.repeat(64)}`);
    default:
      return reply(answerOf(world, params[0].to.toLowerCase(), params[0].data));
  }
};

/** The minimum `card new` seals for a swap of 1000 `one` to `two`, with the signer's lines, or undefined when it seals no card. */
async function sealed(world: World, lines: readonly string[], drpc = world): Promise<bigint | undefined> {
  const base = mkdtempSync(join(tmpdir(), 'kiss-sign-floor-canary-'));
  const [origin, repo, home] = [join(base, 'origin.git'), join(base, 'repo'), join(base, 'home')];
  git(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(base, 'clone', '--quiet', origin, repo);
  write(join(repo, 'templates', 'test', 'swap', 'template.json'), JSON.stringify(swapTemplate({ floor: { sells: 'sell-amount' } })));
  write(join(repo, 'registry', 'contracts.json'), JSON.stringify(pricedRegistry));
  write(join(repo, 'registry', 'attributes.json'), JSON.stringify(ATTRIBUTES));
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'data');
  git(repo, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  const ssh = write(join(base, 'ssh'), `#!/bin/sh\nexec git-upload-pack '${origin}'\n`);
  chmodSync(ssh, 0o755);
  git(repo, 'remote', 'set-url', 'origin', 'git@github.com:signer/kiss-sign.git');
  git(repo, 'config', 'core.sshCommand', ssh);
  write(join(home, 'config.json'), JSON.stringify({ chainId: 1, safe: SAFE, repo: 'github.com/signer/kiss-sign' }));
  const queue = ['one', 'two', '1000', ...lines];
  await main(['card', 'new', 'test/swap'], {
    env: { KISS_SIGN_HOME: home, ALCHEMY_API_KEY: 'test-key' },
    stdout: () => {},
    stderr: () => {},
    platform: 'linux',
    readSecret: undefined,
    ask: async () => queue.shift(),
    repoRoot: repo,
    transport: transportOf(world, drpc),
    fetchJson: async () => assert.fail('card new fetches nothing'),
    readMessage: async () => ({ why: 'none' }),
  }).catch((error: Error) => assert.match(`${error.name}`, /Error/));
  const cards = join(home, 'cards');
  const [file] = existsSync(cards) ? readdirSync(cards) : [];
  if (file === undefined) return undefined;
  return BigInt(JSON.parse(readFileSync(join(cards, file), 'utf8')).operations[0].values['min-buy']);
}

/** 1000 at a dollar each less 0.75%, and less 1.25%, the least a computed floor may be. */
const [LEAST, LEAST_OF_ALL] = [992_500_000n, 987_500_000n];
const DOUBTED: readonly (readonly [string, World])[] = [
  ['a pool pushed down', { ...CALM, tick: -500n }],
  ['a pool pushed up', { ...CALM, tick: 500n }],
  ['a thin pool', { ...CALM, liquidity: 10n }],
  ['a token off its peg', { ...CALM, two: 110_000_000n, tick: -953n }],
  ['a late feed', { ...CALM, age: 200_000n }],
];
const REFUSED: readonly (readonly [string, World, World?])[] = [
  ['a feed at 0', { ...CALM, one: 0n }],
  ['a feed below 0', { ...CALM, one: -100_000_000n }],
  ['a feed from the future', { ...CALM, age: -1n }],
  ['other code', { ...CALM, code: '0x01' as Hex }],
  ['one provider that lies about a feed', CALM, { ...CALM, one: 50_000_000n }],
  ['one provider that lies about a pool', CALM, { ...CALM, tick: -5000n }],
];

test('a swap floor the signer does not type is never below the price less 1.25%, and one source that says less never lowers it', async () => {
  for (const world of [CALM, { ...CALM, tick: -10n }, { ...CALM, one: 99_900_000n }]) {
    const floor = await sealed(world, ['', 'y']);
    assert.ok(floor === undefined || floor >= LEAST, `${floor}`);
  }
  const most = await sealed(CALM, ['1', 'y']);
  assert.ok(most === undefined || most >= LEAST_OF_ALL, `${most}`);
  assert.equal(await sealed(CALM, ['1.01', 'y']), undefined);
});

for (const [what, world] of DOUBTED) {
  test(`${what} never gives a computed floor: Enter, a percent, one key or one typing seals nothing`, async () => {
    for (const lines of [['', 'y'], ['1', 'y'], ['y', 'y'], ['900', 'y'], ['900', '', 'y'], ['900', '901', '', 'y']]) assert.equal(await sealed(world, lines), undefined, `${lines}`);
  });
}

for (const [what, world, drpc] of REFUSED) {
  test(`${what} gives no card, whatever is typed`, async () => {
    for (const lines of [['', 'y'], ['900', 'y'], ['900', '900', 'y']]) assert.equal(await sealed(world, lines, drpc), undefined, `${lines}`);
  });
}
