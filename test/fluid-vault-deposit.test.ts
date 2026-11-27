import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { SafeTx } from '../src/safe/types.ts';
import { describeFinding, judgeEffects } from '../src/simulate/effects.ts';
import type { EffectVerdict, Observed } from '../src/simulate/effects.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const ID = 'fluid/vault-deposit';
const templates = new Map([[ID, loadTemplate(ROOT, ID, registry)]]);
const VAULT = 'fluid-fusdc';
const USDC = registry.entries.get('usdc')!.address;
const FUSDC = registry.entries.get(VAULT)!.address;

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const deposit = (vault: string, amount: string, minShares: string): Card => ({
  operations: [{ template: ID, values: { vault, amount, 'min-shares': minShares } }],
});

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);
const mismatchedArgs = (result: FieldCheck) => (result.kind === 'mismatch' ? result.findings.map((f) => f.arg) : result);

/** What `pnpm simulate` printed for each transaction: the USDC given and the fUSDC shares received. */
const observed = (amount: string, shares: string): Observed => ({
  kind: 'executed',
  safeState: { kind: 'receipt', logs: [] },
  eth: 0n,
  tokens: new Map([
    [USDC, -BigInt(amount)],
    [FUSDC, BigInt(shares)],
  ]),
  allowances: [],
  permit2: [],
  ends: new Map(),
});
const effects = (tx: SafeTx, card: Card, o: Observed): string[] => {
  const verdict: EffectVerdict = judgeEffects(o, resolved(tx, card), templates, registry);
  return verdict.kind === 'mismatch' ? verdict.findings.map((f) => describeFinding(f, registry)) : [verdict.kind];
};

const CASES = [
  { name: 'fluid-deposit-usdc', amount: '967104173', shares: '821126769' },
  { name: 'fluid-deposit-usdc-other-safe', amount: '17746857253', shares: '15062772377' },
] as const;

for (const c of CASES) {
  const tx = safeTx(c.name);
  const card = deposit(VAULT, c.amount, c.shares);

  test(`${c.name} matches fluid/vault-deposit with the card it implies`, () => {
    assert.deepEqual(check(tx, card), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, card), templates, registry), { kind: 'pass', bound: 8, free: 0 });
  });

  test(`${c.name}: a card with another amount is a mismatch wherever the amount is bound`, () => {
    assert.deepEqual(mismatchedArgs(check(tx, deposit(VAULT, `${BigInt(c.amount) + 1n}`, c.shares))), ['value', 'assets_']);
  });

  test(`${c.name}: the shares it minted meet a floor at them and miss a floor one share higher`, () => {
    assert.deepEqual(effects(tx, card, observed(c.amount, c.shares)), ['match']);
    const [finding] = effects(tx, deposit(VAULT, c.amount, `${BigInt(c.shares) + 1n}`), observed(c.amount, c.shares));
    assert.match(finding!, new RegExp(`fluid-fusdc ${FUSDC}`));
  });
}

test('a card naming a vault of another protocol is refused before any check', () => {
  const tx = safeTx('fluid-deposit-usdc');
  const result = resolveCard(deposit('steakhouse-prime-usdc-v2-0f51', '967104173', '1'), { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'refused');
});
