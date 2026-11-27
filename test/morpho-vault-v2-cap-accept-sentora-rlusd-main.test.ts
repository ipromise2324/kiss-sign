import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { liveRepo } from './repo-with-test-fixtures.ts';

const ID = 'morpho/vault-v2-cap-accept';
const ROOT = liveRepo();
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>([[ID, loadTemplate(ROOT, ID, registry)]]);

const FIXTURES = [
  { name: 'sentora-rlusd-main-cap-accept-kbtc-251', cap: 220_000_000n * 10n ** 18n },
  { name: 'sentora-rlusd-main-cap-accept-kbtc-213', cap: 175_000_000n * 10n ** 18n },
];

function safeTx(name: string): SafeTx {
  const fixture = readRecording<any>(join(ROOT, 'testdata', 'safe-tx', `${name}.json`));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const card = (cap: bigint): Card => ({
  operations: [
    { template: ID, values: { vault: 'sentora-rlusd-main-v2-e6bf', market: 'rlusd-kbtc-86', 'absolute-cap': `${cap}` } },
  ],
});

function resolved(tx: SafeTx, c: Card): ResolvedCard {
  const result = resolveCard(c, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, c: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, c), templates, registry);

for (const { name, cap } of FIXTURES) {
  const tx = safeTx(name);

  test(`${name} matches ${ID} with the cap it executes`, () => {
    assert.deepEqual(check(tx, card(cap)), { kind: 'match' });
  });

  test(`${name} is a MISMATCH against a card with another cap`, () => {
    const result = check(tx, card(cap + 1n));
    assert.equal(result.kind, 'mismatch');
    const findings = (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => `${f.callPath}.${f.arg}`);
    assert.ok(
      findings.some((f) => f.endsWith('newAbsoluteCap')),
      findings.join(', '),
    );
  });

  test(`${name}: the mutation check catches every bound field`, () => {
    const result = checkMutations(tx, resolved(tx, card(cap)), templates, registry);
    assert.equal(result.kind, 'pass', JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v)));
  });
}
