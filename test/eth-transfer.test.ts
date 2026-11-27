import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, 'eth/transfer', registry);
const templates = new Map([[template.id, template]]);

/** Plain ETH transfers of other Safes, each with the card `pnpm template implied-card eth/transfer` prints for it. */
const CASES = [
  { fixture: 'eth-transfer-small', amount: '1300000000000000', recipient: '0x6c94ce2a7104c754d267731635b51928a9e298d0' },
  { fixture: 'eth-transfer-third', amount: '20000000000000000', recipient: '0x07720554047a0c30b29a09b23db59e5ad2f328af' },
  { fixture: 'eth-transfer-large', amount: '1174832696313398886', recipient: '0xb0057443597b1614d758e6a046baa558aed78ab7' },
] as const;

function load(name: string): SafeTx {
  const { service, chain } = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(service, { chainId: 1n, version: chain.version });
}

function card(tx: SafeTx, amount: string, recipient: string): ResolvedCard {
  const operations = [{ template: 'eth/transfer', values: { amount, recipient: 'recipient' } }];
  const addressBook = new Map([['recipient', recipient as Address]]);
  const result = resolveCard({ operations }, { templates, registry, addressBook, safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

for (const { fixture, amount, recipient } of CASES) {
  test(`${fixture}: the ETH transfer matches its card`, () => {
    const tx = load(fixture);
    assert.deepEqual(checkTemplateFields(tx, card(tx, amount, recipient), templates, registry), { kind: 'match' });
  });

  test(`${fixture}: every bound field of the ETH transfer, changed alone, gives a mismatch`, () => {
    const tx = load(fixture);
    assert.deepEqual(checkMutations(tx, card(tx, amount, recipient), templates, registry), { kind: 'pass', bound: 2, free: 0 });
  });

  test(`${fixture}: one wei more on the card, or another recipient, is a mismatch`, () => {
    const tx = load(fixture);
    assert.equal(checkTemplateFields(tx, card(tx, (BigInt(amount) + 1n).toString(), recipient), templates, registry).kind, 'mismatch');
    assert.equal(checkTemplateFields(tx, card(tx, amount, '0x1111111111111111111111111111111111111111'), templates, registry).kind, 'mismatch');
  });
}
