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
import { checkMutations } from '../src/template/mutation.ts';
import type { Checker, MutationResult } from '../src/template/mutation.ts';
import { loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', 'morpho-vault-deposit.json'), 'utf8'));
const deposit = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, 'morpho/vault-deposit', registry);
const rawTemplate = JSON.parse(readFileSync(join(ROOT, 'templates', 'morpho', 'vault-deposit', 'template.json'), 'utf8'));
const DEPOSIT_PATH = 'multiSend[1].multicall.bundle[1].data.erc4626Deposit';

const templatesOf = (t: Template) => new Map([[t.id, t]]);

function card(templates: ReadonlyMap<string, Template>, amount = '1800000000180'): ResolvedCard {
  const operations = [{ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc', amount, 'min-shares': '1741863305677219101283940' } }];
  const result = resolveCard({ operations }, { templates, registry, addressBook: new Map(), safe: deposit.safe });
  assert.equal(result.kind, 'resolved');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const mutations = (t: Template = template, checker?: Checker, amount?: string): MutationResult =>
  checkMutations(deposit, card(templatesOf(t), amount), templatesOf(t), registry, checker);

/** The receiver word of the deposit, which holds the Safe: the one place the Safe appears in the data. */
const RECEIVER = (() => {
  const at = deposit.data.slice(2).indexOf(deposit.safe.slice(2)) / 2 - 12;
  return [at, at + 32] as const;
})();

test('every bound field of the Morpho deposit, changed alone, gives a mismatch', () => {
  assert.deepEqual(mutations(), { kind: 'pass', bound: 21, free: 0 });
});

test('a template that frees the deposited assets still passes, with one more free field and one fewer bound', () => {
  const weakened = structuredClone(rawTemplate);
  weakened.calls[1].args.bundle.items[1].fields.data.call.args.assets = { free: 'test: assets left free' };
  assert.deepEqual(mutations(parseTemplate(weakened, registry)), { kind: 'pass', bound: 20, free: 1 });
});

test('a checker that ignores the receiver makes the template weak, naming the receiver', () => {
  const original = hexToBytes(deposit.data.slice(2)).slice(...RECEIVER);
  const blind: Checker = (tx, ...rest) => {
    const bytes = hexToBytes(tx.data.slice(2));
    bytes.set(original, RECEIVER[0]);
    const restored: SafeTx = { ...tx, data: `0x${bytesToHex(bytes)}` as Hex };
    return checkTemplateFields(restored, ...rest);
  };
  const result = mutations(template, blind);
  assert.equal(result.kind, 'weak-template');
  const { uncaught, bound, free } = result as Extract<MutationResult, { kind: 'weak-template' }>;
  assert.deepEqual([bound, free], [21, 0]);
  assert.deepEqual(
    uncaught.map(({ leaf, mutated }) => [leaf.callPath, leaf.arg, leaf.bytes, leaf.rule.kind, mutated]),
    [[DEPOSIT_PATH, 'receiver', RECEIVER, 'safe', 'match']],
  );
});

test('a transaction that does not match its card is not mutated', () => {
  const result = mutations(template, undefined, '1800000000181');
  assert.equal(result.kind, 'not-run');
});
