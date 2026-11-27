import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>([['erc20/transfer', loadTemplate(ROOT, 'erc20/transfer', registry)]]);

/** Each fixture with the card and address-book entry `pnpm template implied-card` printed for it. */
const FIXTURES = [
  { name: 'erc20-transfer-usdc-a', amount: '456794535', recipient: '0xb5793636c9bef1e27a4668a43ddf8b759c85eba3' },
  { name: 'erc20-transfer-usdc-b', amount: '1623000000', recipient: '0x581c1ec6ee7d428cf7932695db1cebed4cf505af' },
  { name: 'erc20-transfer-usdc-c', amount: '25000000000', recipient: '0x72eed2364f952a73d0db55d0f58adf3a963c754c' },
] as const;

function safeTx(name: string): SafeTx {
  const fixture = readRecording<any>(join(ROOT, 'testdata', 'safe-tx', `${name}.json`));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const card = (amount: string, token = 'usdc'): Card => ({
  operations: [{ template: 'erc20/transfer', values: { token, amount, recipient: 'recipient' } }],
});

function resolve(tx: SafeTx, c: Card, recipient: string) {
  return resolveCard(c, { templates, registry, addressBook: new Map([['recipient', recipient as Address]]), safe: tx.safe });
}

function resolved(tx: SafeTx, c: Card, recipient: string): ResolvedCard {
  const result = resolve(tx, c, recipient);
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, c: Card, recipient: string): FieldCheck => checkTemplateFields(tx, resolved(tx, c, recipient), templates, registry);

for (const { name, amount, recipient } of FIXTURES) {
  const tx = safeTx(name);

  test(`${name} matches erc20/transfer with the card it implies`, () => {
    assert.deepEqual(check(tx, card(amount), recipient), { kind: 'match' });
  });

  test(`${name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, card(amount), recipient), templates, registry), { kind: 'pass', bound: 4, free: 0 });
  });

  test(`${name}: another amount or another recipient on the card is a mismatch`, () => {
    assert.equal(check(tx, card(`${BigInt(amount) + 1n}`), recipient).kind, 'mismatch');
    assert.equal(check(tx, card(amount), '0x1111111111111111111111111111111111111111').kind, 'mismatch');
  });
}

test('a transfer card naming a token the template does not list is refused', () => {
  const { name, amount, recipient } = FIXTURES[0];
  const result = resolve(safeTx(name), card(amount, 'usdt'), recipient);
  assert.equal(result.kind, 'refused');
});
