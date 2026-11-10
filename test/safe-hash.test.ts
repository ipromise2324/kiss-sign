import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashSafeTx } from '../src/safe/hash.ts';
import { parseSafeWebAppTx, parseServiceTx } from '../src/safe/parse.ts';

type Fixture = {
  chainId: number;
  safe: string;
  chain: { version: string; domainSeparator: string; transactionHash: string };
  service: Record<string, unknown> & { safeTxHash: string; data: string | null };
};

const FIXTURES = [
  'morpho-vault-deposit',
  'eth-transfer-null-data',
  'eth-transfer-first-nonce',
  'erc20-transfer-usdc',
  'erc20-transfer-usdc-other-safe',
  'erc20-transfer-usdt',
  'safe-cancel',
  'safe-cancel-other-safe',
] as const;

function load(name: string): Fixture {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
}

const morpho = load('morpho-vault-deposit');
const context = { chainId: 1n, version: morpho.chain.version };

function webAppJson(fixture: Fixture): Record<string, unknown> {
  const s = fixture.service;
  return {
    to: s.to,
    value: s.value,
    data: s.data ?? '0x',
    operation: s.operation,
    safeTxGas: s.safeTxGas,
    baseGas: s.baseGas,
    gasPrice: s.gasPrice,
    gasToken: s.gasToken,
    refundReceiver: s.refundReceiver,
    nonce: Number(s.nonce),
  };
}

function assertChainHashes(fixture: Fixture, hashes: { domainHash: string; messageHash: string; safeTxHash: string }) {
  assert.equal(hashes.domainHash, fixture.chain.domainSeparator, 'domain hash equals on-chain domainSeparator()');
  assert.equal(hashes.safeTxHash, fixture.chain.transactionHash, 'safeTxHash equals on-chain getTransactionHash');
  assert.equal(hashes.safeTxHash, fixture.service.safeTxHash.toLowerCase(), 'safeTxHash equals the service');
  const digest = `0x1901${hashes.domainHash.slice(2)}${hashes.messageHash.slice(2)}`;
  assert.equal(`0x${bytesToHex(keccak_256(hexToBytes(digest.slice(2))))}`, fixture.chain.transactionHash, 'message hash is the one the Safe signs');
}

for (const name of FIXTURES) {
  const fixture = load(name);

  test(`${name}: the service object hashes to the on-chain values`, () => {
    const tx = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
    assertChainHashes(fixture, hashSafeTx(tx));
  });

  test(`${name}: the same transaction as Safe web app JSON gives the same hashes`, () => {
    const tx = parseSafeWebAppTx(webAppJson(fixture), { chainId: 1n, safe: fixture.safe, version: fixture.chain.version });
    assertChainHashes(fixture, hashSafeTx(tx));
  });
}

test('the service data null is hashed as empty bytes', () => {
  const fixture = load('eth-transfer-null-data');
  assert.equal(fixture.service.data, null);
  const tx = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
  assert.equal(tx.data, '0x');
});

test('a service object with an altered safeTxHash is refused', () => {
  const altered = { ...morpho.service, safeTxHash: `0x${'ab'.repeat(32)}` };
  assert.throws(() => parseServiceTx(altered, context), { name: 'SafeTxParseError', field: 'safeTxHash' });
});

test('a service object with one changed data byte and the original safeTxHash is refused', () => {
  const data = morpho.service.data as string;
  const last = data.slice(-2) === '00' ? '01' : '00';
  const altered = { ...morpho.service, data: `${data.slice(0, -2)}${last}` };
  assert.throws(() => parseServiceTx(altered, context), { name: 'SafeTxParseError', field: 'safeTxHash' });
});

test('an unsupported Safe version is refused', () => {
  assert.throws(() => parseServiceTx(morpho.service, { chainId: 1n, version: '1.2.0' }), {
    field: 'version',
    message: /unsupported Safe version "1\.2\.0"/,
  });
  assert.throws(() => parseSafeWebAppTx(webAppJson(morpho), { chainId: 1n, safe: morpho.safe, version: '1.4.1+L2' }), {
    field: 'version',
  });
});

test('Safe web app JSON with a malformed field is refused, naming the field', () => {
  const web = { chainId: 1n, safe: morpho.safe, version: '1.4.1' };
  const cases: [string, unknown][] = [
    ['operation', 2],
    ['to', (morpho.service.to as string).toLowerCase().replace(/^0x./, '0xG')],
    ['to', (morpho.service.to as string).replace(/[a-f]/, (c) => c.toUpperCase())],
    ['to', '0x1234'],
    ['value', '-1'],
    ['value', 1.5],
    ['value', '0x10'],
    ['nonce', -1],
    ['data', '0xabc'],
    ['data', null],
    ['gasToken', undefined],
  ];
  for (const [field, value] of cases) {
    const json = { ...webAppJson(morpho), [field]: value };
    if (value === undefined) delete json[field];
    assert.throws(() => parseSafeWebAppTx(json, web), { name: 'SafeTxParseError', field }, `${field} = ${String(value)}`);
  }
});

test('Safe web app JSON with an unexpected field is refused', () => {
  assert.throws(
    () => parseSafeWebAppTx({ ...webAppJson(morpho), signatures: '0x' }, { chainId: 1n, safe: morpho.safe, version: '1.4.1' }),
    { name: 'SafeTxParseError', message: /unexpected field/ },
  );
});

test('a Safe 1.1.1 transaction hashes without the chain id in its domain, as the Safe and the service hash it', () => {
  // Bybit's cold wallet, nonce 71: the Transaction Service record, and `domainSeparator()` read at block 21,895,237.
  const bybit = {
    safe: '0x1Db92e2EeBC8E0c075a02BeA49a2935BcD2dFCF4',
    to: '0x96221423681A6d52E184D440a8eFCEbB105C7242',
    value: '0',
    data: '0xa9059cbb000000000000000000000000bdd077f651ebe7f7b3ce16fe5f2b025be29695160000000000000000000000000000000000000000000000000000000000000000',
    operation: 1,
    gasToken: '0x0000000000000000000000000000000000000000',
    safeTxGas: '45746',
    baseGas: '0',
    gasPrice: '0',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce: '71',
    safeTxHash: '0xb3476d061aeb8fc1d605a873c483a2402d88a68a9cdd1a8b47655dd55ba004f8',
  };
  const hashes = hashSafeTx(parseServiceTx(bybit, { chainId: 1n, version: '1.1.1' }));
  assert.equal(hashes.domainHash, '0xb3ded2bdbff5db1a87f6d551fa256e9f2bd6517a3bb84f4c2ea863fb3a559622');
  assert.equal(hashes.safeTxHash, bybit.safeTxHash);
  assert.throws(() => parseServiceTx(bybit, { chainId: 1n, version: '1.3.0' }), { field: 'safeTxHash' });
});
