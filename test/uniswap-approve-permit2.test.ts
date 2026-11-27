import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const ID = 'uniswap/approve-permit2';
const registry = loadRegistry(ROOT);
const templates = new Map([[ID, loadTemplate(ROOT, ID, registry)]]);
const FIXTURES = ['uniswap-approve-permit2-usdt', 'uniswap-approve-permit2-usdt-2'] as const;

function safeTx(name: string): SafeTx {
  const { service, chain } = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(service, { chainId: 1n, version: chain.version });
}

function card(tx: SafeTx): ResolvedCard {
  const result = resolveCard({ operations: [{ template: ID, values: { token: 'usdt' } }] }, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

/** The transaction with the approval's amount word, the last 32 bytes of its data, replaced. */
function withValue(tx: SafeTx, value: bigint): SafeTx {
  const bytes = hexToBytes(tx.data.slice(2));
  bytes.set(hexToBytes(value.toString(16).padStart(64, '0')), bytes.length - 32);
  return { ...tx, data: `0x${bytesToHex(bytes)}` as Hex };
}

for (const name of FIXTURES) {
  test(`${name}: another Safe's unlimited USDT approval to Permit2 matches its implied card`, () => {
    const tx = safeTx(name);
    assert.deepEqual(checkTemplateFields(tx, card(tx), templates, registry), { kind: 'match' });
  });

  test(`${name}: every bound field, changed alone, gives a mismatch`, () => {
    const tx = safeTx(name);
    assert.deepEqual(checkMutations(tx, card(tx), templates, registry, [], {}), { kind: 'pass', bound: 4, free: 0 });
  });
}

test('a reset to 0 and an exact amount, which other wallets send, are mismatches at the approval amount', () => {
  const tx = safeTx(FIXTURES[0]);
  for (const value of [0n, 500000000n]) {
    const result: FieldCheck = checkTemplateFields(withValue(tx, value), card(tx), templates, registry);
    assert.equal(result.kind, 'mismatch');
    const { findings } = result as Extract<FieldCheck, { kind: 'mismatch' }>;
    assert.deepEqual(
      findings.map((f) => [f.arg, f.actual]),
      [['value', String(value)]],
    );
  }
});
