import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadRegistry, parseRegistry } from '../src/registry.ts';

const SOURCE = 'https://docs.morpho.org/get-started/resources/addresses';
const CONTRACTS = {
  'morpho-blue': { address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', kind: 'lending', source: SOURCE },
  usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', kind: 'token', source: SOURCE },
  cbbtc: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', kind: 'token', source: SOURCE },
  'cbbtc-usdc-oracle': { address: '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a', kind: 'oracle', source: SOURCE },
  'adaptive-curve-irm': { address: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', kind: 'irm', source: SOURCE },
};
const ID = '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64';
const MARKET = {
  lending: 'morpho-blue',
  loanToken: 'usdc',
  collateralToken: 'cbbtc',
  oracle: 'cbbtc-usdc-oracle',
  irm: 'adaptive-curve-irm',
  lltv: '860000000000000000',
  id: ID,
};

const withMarket = (changes: Record<string, unknown>, name = 'usdc-cbbtc-86') => () => parseRegistry(CONTRACTS, { [name]: { ...MARKET, ...changes } });

test('a market whose id is the hash of its parameters resolves each part to its registry entry', () => {
  const market = parseRegistry(CONTRACTS, { 'usdc-cbbtc-86': MARKET }).markets.get('usdc-cbbtc-86');
  assert.equal(market?.id, ID);
  assert.equal(market?.lltv, 860000000000000000n);
  assert.deepEqual(
    [market?.lending.name, market?.loanToken.name, market?.collateralToken.name, market?.oracle.name, market?.irm.name],
    ['morpho-blue', 'usdc', 'cbbtc', 'cbbtc-usdc-oracle', 'adaptive-curve-irm'],
  );
});

test('a market id written in capitals is the same id', () => {
  assert.equal(withMarket({ id: `0x${ID.slice(2).toUpperCase()}` })().markets.get('usdc-cbbtc-86')?.id, ID);
});

test('a market whose id is not the hash of its parameters is refused, naming the hash they give', () => {
  assert.throws(withMarket({ lltv: '915000000000000000' }), {
    name: 'RegistryError',
    message: /^markets\.usdc-cbbtc-86\.id: is not the id of these parameters, which hash to 0x[0-9a-f]{64}$/,
  });
  assert.throws(withMarket({ collateralToken: 'usdc' }), { message: /^markets\.usdc-cbbtc-86\.id: is not the id of these parameters/ });
});

test('a market part that names an entry of the wrong kind, or no entry, is refused', () => {
  assert.throws(withMarket({ oracle: 'usdc' }), { message: 'markets.usdc-cbbtc-86.oracle: "usdc" is not an oracle in the registry' });
  assert.throws(withMarket({ irm: 'no-such-irm' }), { message: 'markets.usdc-cbbtc-86.irm: "no-such-irm" is not an irm in the registry' });
  assert.throws(withMarket({ lending: 'usdc' }), { message: 'markets.usdc-cbbtc-86.lending: "usdc" is not a lending in the registry' });
  assert.throws(withMarket({ loanToken: 'morpho-blue' }), { message: 'markets.usdc-cbbtc-86.loanToken: "morpho-blue" is not a token in the registry' });
});

test('a market with a part missing, an extra field, or an lltv that is not a uint256 is refused', () => {
  const { irm: _, ...noIrm } = MARKET;
  assert.throws(() => parseRegistry(CONTRACTS, { m: noIrm }), { message: 'markets.m.irm: missing' });
  assert.throws(withMarket({ curator: 'x' }, 'm'), { message: 'markets.m.curator: unexpected field' });
  for (const lltv of [860000000000000000, '0.86', '-1', '08', (1n << 256n).toString()]) {
    assert.throws(withMarket({ lltv }, 'm'), { message: 'markets.m.lltv: not a decimal integer below 2^256' }, String(lltv));
  }
  assert.throws(withMarket({ id: '0x64d6' }, 'm'), { message: 'markets.m.id: not 32 bytes' });
});

test('a market name must be a name that no contract, the Safe or ETH already holds', () => {
  assert.throws(withMarket({}, 'usdc'), { message: 'markets.usdc: is also a registry contract' });
  assert.throws(withMarket({}, 'safe'), { message: 'markets.safe: not a market name' });
  assert.throws(withMarket({}, 'eth'), { message: 'markets.eth: not a market name' });
  assert.throws(withMarket({}, 'USDC Market'), { message: 'markets.USDC Market: not a market name' });
});

test('a repository without registry/markets.json has no markets, and one with it has them', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-markets-'));
  mkdirSync(join(root, 'registry'));
  writeFileSync(join(root, 'registry', 'contracts.json'), JSON.stringify(CONTRACTS));
  assert.equal(loadRegistry(root).markets.size, 0);
  writeFileSync(join(root, 'registry', 'markets.json'), JSON.stringify({ 'usdc-cbbtc-86': MARKET }));
  assert.deepEqual([...loadRegistry(root).markets.keys()], ['usdc-cbbtc-86']);
});
