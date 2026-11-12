import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const ID = 'morpho/vault-bundles-deposit';
const templates = new Map([[ID, loadTemplate(ROOT, ID, registry)]]);

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const MIN_SHARES: Record<string, string> = { '31583325527': '30442521166571443751074', '2700000000000': '2605667274057129893492827' };
const deposit = (amount: string, minShares = MIN_SHARES[amount] ?? '1'): Card => ({
  operations: [{ template: ID, values: { vault: 'steakhouse-prime-usdc-v2-0f51', amount, 'min-shares': minShares } }],
});
const check = (tx: SafeTx, card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);

const CASES = [
  { name: 'morpho-bundles-deposit', amount: '31583325527' },
  { name: 'morpho-bundles-deposit-two-tags', amount: '2700000000000' },
] as const;

for (const c of CASES) {
  const tx = safeTx(c.name);

  test(`${c.name} matches ${ID} with the card it implies`, () => {
    assert.deepEqual(check(tx, deposit(c.amount)), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, deposit(c.amount)), templates, registry), { kind: 'pass', bound: 12, free: 2 });
  });

  test(`${c.name}: another amount on the card is a mismatch at both amounts`, () => {
    const result = check(tx, deposit(`${BigInt(c.amount) + 1n}`, MIN_SHARES[c.amount]));
    assert.equal(result.kind, 'mismatch');
    const args = result.kind === 'mismatch' ? result.findings.map((f) => f.arg) : [];
    assert.deepEqual(args, ['value', 'assets']);
  });
}

function replaceWord(tx: SafeTx, value: string, replacement: string): SafeTx {
  const word = value.slice(2).padStart(64, '0');
  assert.equal(tx.data.split(word).length, 2, 'the word occurs once');
  return { ...tx, data: tx.data.replace(word, replacement.slice(2).padStart(64, '0')) as Hex };
}

test('a referral fee taken from the deposit is a mismatch', () => {
  const tx = safeTx('morpho-bundles-deposit');
  const deadline = `0x${(1793094749).toString(16)}` as Hex;
  const zeroFeeThenDeadline = `${'0'.repeat(128)}${deadline.slice(2).padStart(64, '0')}`;
  assert.equal(tx.data.split(zeroFeeThenDeadline).length, 2);
  const fee = `${(10n ** 17n).toString(16).padStart(64, '0')}${'0'.repeat(64)}${deadline.slice(2).padStart(64, '0')}`;
  const tampered = { ...tx, data: tx.data.replace(zeroFeeThenDeadline, fee) as Hex };
  const result = check(tampered, deposit('31583325527'));
  assert.deepEqual(result.kind === 'mismatch' ? result.findings.map((f) => [f.arg, f.expected, f.actual]) : result, [
    ['referralFeePct', '0', '100000000000000000'],
  ]);
});

test('a deposit for another vault is a mismatch at the vault', () => {
  const tx = safeTx('morpho-bundles-deposit');
  const prime = registry.entries.get('steakhouse-prime-usdc-v2-0f51')!.address;
  const apex = registry.entries.get('hyperithm-usdc-apex-v2-9e2f')!.address;
  const result = check(replaceWord(tx, prime, apex), deposit('31583325527'));
  assert.deepEqual(result.kind === 'mismatch' ? result.findings.map((f) => f.arg) : result, ['vault']);
});

test('a card that asks for more shares than the price bound guarantees is a mismatch at the bound', () => {
  const result = check(safeTx('morpho-bundles-deposit'), deposit('31583325527', '30442521166571443751075'));
  assert.deepEqual(result.kind === 'mismatch' ? result.findings.map((f) => f.arg) : result, ['maxSharePriceE27']);
});
