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
import { loadTemplate, parseTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const templates = new Map([['morpho/vault-deposit', loadTemplate(ROOT, 'morpho/vault-deposit', registry)]]);

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const deposit = (vault: string, amount: string, minShares: string): Card => ({
  operations: [{ template: 'morpho/vault-deposit', values: { vault, amount, 'min-shares': minShares } }],
});

const CASES = [
  { name: 'morpho-deposit-metamorpho-1-0', vault: 'smokehouse-usdc-v1-f5bc', amount: '1464958248813', minShares: '1390732183143696404747928' },
  { name: 'morpho-deposit-metamorpho-1-0-other-safe', vault: 'smokehouse-usdc-v1-f5bc', amount: '200000000000', minShares: '189861410385534442527589' },
  { name: 'morpho-deposit-approve-trailer', vault: 'hyperithm-usdc-apex-v1-7777', amount: '20000000000', minShares: '18968731394945526506377' },
  { name: 'morpho-deposit-approve-trailer-other-safe', vault: 'hyperithm-usdc-apex-v1-7777', amount: '10001000000', minShares: '9482917730630123475126' },
] as const;

const check = (tx: SafeTx, card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);

for (const c of CASES) {
  const tx = safeTx(c.name);
  const card = deposit(c.vault, c.amount, c.minShares);

  test(`${c.name} matches morpho/vault-deposit with the card it implies`, () => {
    assert.deepEqual(check(tx, card), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, card), templates, registry), { kind: 'pass', bound: 21, free: 0 });
  });
}

const DEPOSIT_PATH = 'multiSend[1].multicall.bundle[1].data.erc4626Deposit';

test('a card that asks for more shares than the price bound guarantees is a mismatch at the bound', () => {
  const c = CASES[0];
  const result = check(safeTx(c.name), deposit(c.vault, c.amount, `${BigInt(c.minShares) + 1n}`));
  assert.deepEqual(result.kind === 'mismatch' ? result.findings.map((f) => [f.callPath, f.arg]) : result, [[DEPOSIT_PATH, 'maxSharePriceE27']]);
  assert.match(result.kind === 'mismatch' ? result.findings[0]!.expected : '', /^at most \d+: 1464958248813 assets for 1390732183143696404747929 shares, scaled by 1e27$/);
});

test('a transaction whose price bound would accept 1 wei of shares is a mismatch at the bound', () => {
  const c = CASES[0];
  const tx = safeTx(c.name);
  const data = tx.data.slice(2);
  const words = Array.from({ length: (data.length - 64) / 2 + 1 }, (_, i) => data.slice(i * 2, i * 2 + 64));
  const word = words.find((w) => BigInt(`0x${w}`) > 0n && (BigInt(c.amount) * 10n ** 27n) / BigInt(`0x${w}`) === BigInt(c.minShares));
  assert.ok(word !== undefined && tx.data.split(word).length === 2, 'the bound occurs once');
  const loose = { ...tx, data: tx.data.replace(word, (BigInt(c.amount) * 10n ** 27n).toString(16).padStart(64, '0')) as Hex };
  const result = check(loose, deposit(c.vault, c.amount, c.minShares));
  assert.deepEqual(result.kind === 'mismatch' ? result.findings.map((f) => f.arg) : result, ['maxSharePriceE27']);
});

test('a stricter price bound than the card needs still matches', () => {
  const c = CASES[0];
  assert.deepEqual(check(safeTx(c.name), deposit(c.vault, c.amount, '1')), { kind: 'match' });
});

test('a template that declares another price scale compares the bound against assets × 10^scale / shares, and names the scale', () => {
  const c = CASES[0];
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'morpho', 'vault-deposit', 'template.json'), 'utf8'));
  const bound = raw.calls[1].args.bundle.items[1].fields.data.call.args.maxSharePriceE27.maxSharePrice;
  const checkScaled = (scale: number): FieldCheck => {
    bound.scale = scale;
    const scaled = new Map([['morpho/vault-deposit', parseTemplate(raw, registry)]]);
    const tx = safeTx(c.name);
    const result = resolveCard(deposit(c.vault, c.amount, c.minShares), { templates: scaled, registry, addressBook: new Map(), safe: tx.safe });
    assert.equal(result.kind, 'resolved');
    return checkTemplateFields(tx, (result as Extract<typeof result, { kind: 'resolved' }>).card, scaled, registry);
  };
  assert.deepEqual(checkScaled(27), { kind: 'match' });
  const result = checkScaled(18);
  assert.deepEqual(result.kind === 'mismatch' ? result.findings.map((f) => [f.callPath, f.arg]) : result, [[DEPOSIT_PATH, 'maxSharePriceE27']]);
  assert.equal(result.kind === 'mismatch' ? result.findings[0]!.expected : '', `at most ${(BigInt(c.amount) * 10n ** 18n) / BigInt(c.minShares)}: ${c.amount} assets for ${c.minShares} shares, scaled by 1e18`);
});
