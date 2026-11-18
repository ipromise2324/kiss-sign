import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseServiceTx } from '../../src/safe/parse.ts';
import { chain, fixture, run, service, setUp, write } from './verify-harness.ts';

const context = { chainId: 1n, version: chain.version as string };
const lastByteChanged = (data: string) => `${data.slice(0, -2)}${data.slice(-2) === '00' ? '01' : '00'}`;

test('the recorded deposit, as the Transaction Service gave it, parses: its safeTxHash is the one computed from its fields', () => {
  assert.equal(parseServiceTx(service, context).nonce, BigInt(String(service.nonce)));
});

test('a service object with an altered safeTxHash is refused', () => {
  const altered = { ...service, safeTxHash: `0x${'ab'.repeat(32)}` };
  assert.throws(() => parseServiceTx(altered, context), { name: 'SafeTxParseError', field: 'safeTxHash' });
});

test('a service object with one changed data byte and the original safeTxHash is refused', () => {
  const altered = { ...service, data: lastByteChanged(String(service.data)) };
  assert.throws(() => parseServiceTx(altered, context), { name: 'SafeTxParseError', field: 'safeTxHash' });
});

test('verify refuses Transaction Service JSON whose fields do not hash to its safeTxHash, and writes no verdict', async () => {
  const altered = [{ ...service, data: lastByteChanged(String(service.data)) }, { ...service, nonce: `${BigInt(String(service.nonce)) + 1n}` }];
  for (const tx of altered) {
    const { base, repo, home } = setUp();
    const file = write(join(base, 'tx.json'), JSON.stringify(tx));
    const { code, stdout, stderr } = await run(['verify', '--card', fixture.inputs.card.hash, '--tx', file], repo, home);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.equal(stderr, 'kiss-sign: the Safe transaction: safeTxHash: differs from the hash computed from the transaction\n');
    assert.equal(readdirSync(home).includes('verdicts'), false);
  }
});
