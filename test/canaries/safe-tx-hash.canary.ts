import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashSafeTx } from '../../src/safe/hash.ts';
import { parseServiceTx } from '../../src/safe/parse.ts';
import type { Hex } from '../../src/safe/types.ts';
import { chain, fixture, receiverChanged, run, service, setUp } from './verify-harness.ts';

const ASKED: string = chain.transactionHash;
const SERVICE_URL = `https://api.safe.global/tx-service/eth/api/v1/multisig-transactions/${ASKED}/`;

/** Runs `verify --safe-tx-hash` on the recorded deposit's hash, with the Transaction Service answering `answer`. */
async function verifyByHash(answer: unknown) {
  const { repo, home } = setUp();
  const asked: string[] = [];
  const fetchJson = async (url: string) => {
    asked.push(url);
    return answer;
  };
  const result = await run(['verify', '--card', fixture.inputs.card.hash, '--safe-tx-hash', ASKED], repo, home, undefined, fetchJson);
  assert.deepEqual(asked, [SERVICE_URL]);
  return { ...result, verdicts: readdirSync(home).includes('verdicts') ? readdirSync(join(home, 'verdicts')) : [] };
}

/** The deposit with its receiver changed, as a Transaction Service record whose safeTxHash is its own. */
function anotherTransaction(): Record<string, unknown> {
  const data = String(receiverChanged().data);
  const tx = { ...parseServiceTx(service, { chainId: 1n, version: chain.version }), data: data as Hex };
  return { ...service, data, safeTxHash: hashSafeTx(tx).safeTxHash };
}

test('the Transaction Service record of the asked safeTxHash verifies to MATCH', async () => {
  const { code, stdout, verdicts } = await verifyByHash(service);
  assert.equal(code, 0, stdout);
  assert.match(stdout, new RegExp(`^┌─ MATCH [^\\n]*\\n│ nonce +${service.nonce}\\n│ safeTxHash  ${ASKED}\\n`));
  assert.equal(verdicts.filter((name) => name.endsWith('.json')).length, 1);
});

test('another transaction, whose safeTxHash is its own and not the one asked, is refused before any verdict', async () => {
  const other = anotherTransaction();
  assert.notEqual(other.safeTxHash, ASKED);
  const { code, stdout, stderr, verdicts } = await verifyByHash(other);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.equal(stderr, `kiss-sign: the Transaction Service did not return ${ASKED}\n`);
  assert.deepEqual(verdicts, []);
});

test('a record that claims the asked safeTxHash but holds another transaction is refused before any verdict', async () => {
  const claimed = { ...anotherTransaction(), safeTxHash: ASKED };
  const { code, stdout, stderr, verdicts } = await verifyByHash(claimed);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.equal(stderr, 'kiss-sign: the Safe transaction: safeTxHash: differs from the hash computed from the transaction\n');
  assert.deepEqual(verdicts, []);
});
