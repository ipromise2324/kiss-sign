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
import type { FieldChain, FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const ID = 'morpho/vault-deposit';
const templates = new Map([[ID, loadTemplate(ROOT, ID, registry)]]);

const fixture = (name: string) => JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));

function safeTx(name: string): SafeTx {
  const { service, chain } = fixture(name);
  return parseServiceTx(service, { chainId: 1n, version: chain.version });
}

/** The block the fixture's transaction ran in, with its time, which the deposit's `deadline` is bounded from. */
function ranIn(name: string): FieldChain {
  const { service } = fixture(name);
  return { blockTime: { kind: 'read', number: BigInt(service.blockNumber), time: BigInt(Date.parse(service.executionDate) / 1000) } };
}

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

type Case = { readonly name: string; readonly vault: string; readonly amount: string; readonly minShares: string };
const STEAKHOUSE = 'steakhouse-prime-usdc-v2-0f51';
const HYPERITHM = 'hyperithm-usdc-apex-v2-9e2f';
const CASES: readonly Case[] = [
  { name: 'morpho-vault-bundles-deposit', vault: STEAKHOUSE, amount: '10000000000', minShares: '9609712613964437589511' },
  { name: 'morpho-vault-bundles-deposit-other-safe', vault: STEAKHOUSE, amount: '60000000000', minShares: '57722843047406249093813' },
  { name: 'morpho-bundles-deposit', vault: STEAKHOUSE, amount: '31583325527', minShares: '30442521166571443751074' },
  { name: 'morpho-bundles-deposit-two-tags', vault: STEAKHOUSE, amount: '2700000000000', minShares: '2605667274057129893492827' },
];
const BUNDLER3_CASES: readonly Case[] = [
  { name: 'morpho-vault-deposit', vault: STEAKHOUSE, amount: '1800000000180', minShares: '1741863305677219101283940' },
  { name: 'morpho-vault-deposit-v2', vault: HYPERITHM, amount: '1000611448606', minShares: '973551731159989631767877' },
  { name: 'morpho-vault-deposit-v2-other-safe', vault: HYPERITHM, amount: '200060208382', minShares: '196232498267776029465926' },
];

const cardOf = ({ vault, amount, minShares }: Case, changes: Record<string, string> = {}): Card => ({
  operations: [{ template: ID, values: { vault, amount, 'min-shares': minShares, ...changes } }],
});
const check = (c: Case, tx: SafeTx = safeTx(c.name), card: Card = cardOf(c), chain: FieldChain = ranIn(c.name)): FieldCheck =>
  checkTemplateFields(tx, resolved(tx, card), templates, registry, [], chain);
const mismatchedArgs = (result: FieldCheck) => (result.kind === 'mismatch' ? result.findings.map((f) => f.arg) : result);

/** The first occurrence of the 32-byte word `value` in the data, which the approval holds before the deposit does, replaced. */
function withFirstWord(tx: SafeTx, value: bigint, replacement: bigint): SafeTx {
  const word = (n: bigint) => n.toString(16).padStart(64, '0');
  assert.ok(tx.data.includes(word(value)));
  return { ...tx, data: tx.data.replace(word(value), word(replacement)) as Hex };
}

for (const c of CASES) {
  test(`${c.name} matches ${ID} with the card it implies`, () => {
    assert.deepEqual(check(c), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    const tx = safeTx(c.name);
    assert.deepEqual(checkMutations(tx, resolved(tx, cardOf(c)), templates, registry, [], ranIn(c.name)), { kind: 'pass', bound: 13, free: 1 });
  });

  test(`${c.name}: a card with another amount is a mismatch at the approval and the deposit`, () => {
    assert.deepEqual(mismatchedArgs(check(c, undefined, cardOf(c, { amount: `${BigInt(c.amount) + 1n}` }))), ['value', 'assets']);
  });

  test(`${c.name}: a card asking for more shares than the price bound gives is a mismatch at the price bound`, () => {
    assert.deepEqual(mismatchedArgs(check(c, undefined, cardOf(c, { 'min-shares': `${BigInt(c.minShares) + 1n}` }))), ['maxSharePriceE27']);
  });

  test(`${c.name}: a card naming another vault is a mismatch at the vault`, () => {
    assert.deepEqual(mismatchedArgs(check(c, undefined, cardOf(c, { vault: HYPERITHM }))), ['vault']);
  });

  test(`${c.name}: the app's unlimited approval is a mismatch at the approval alone`, () => {
    assert.deepEqual(mismatchedArgs(check(c, withFirstWord(safeTx(c.name), BigInt(c.amount), 2n ** 256n - 1n))), ['value']);
  });
}

for (const c of BUNDLER3_CASES) {
  test(`${c.name}: a deposit through Bundler3 is a mismatch`, () => {
    const result = check(c);
    assert.deepEqual(result.kind === 'mismatch' ? result.findings.map((f) => `${f.callPath} ${f.arg}`) : result, ['multiSend[0].approve spender', 'multiSend[1] to', 'multiSend[1] selector']);
  });
}

test('a deadline more than 7 days after the block is a mismatch at the deadline, and with no block time read the check is UNVERIFIABLE', () => {
  const c = CASES[0]!;
  const { number, time } = ranIn(c.name).blockTime as Extract<FieldChain['blockTime'], { kind: 'read' }>;
  assert.deepEqual(mismatchedArgs(check(c, undefined, undefined, { blockTime: { kind: 'read', number, time: time - 604_800n } })), ['deadline']);
  assert.equal(check(c, undefined, undefined, {}).kind, 'unverifiable');
});
