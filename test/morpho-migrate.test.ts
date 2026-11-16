import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Card } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { TemplateError, loadTemplate, parseTemplate } from '../src/template/template.ts';
import { evaluate } from '../src/verify/verify.ts';
import type { VerdictFile, VerifyInputs } from '../src/verify/verify.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const ROOT = repoWithTestFixtures();
const registry = loadRegistry(ROOT);
const ALL = 'morpho/vault-migrate-all';
const templates = new Map([ALL].map((id) => [id, loadTemplate(ROOT, id, registry)]));
const SAFE = '0x1111111111111111111111111111111111111111' as Address;

const refusal = (card: Card) => {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: SAFE });
  return result.kind === 'refused' ? `${result.reason} at ${result.at}: ${result.detail}` : result.kind;
};

test('a migration between two vaults of one asset resolves, and between vaults of different assets is refused', () => {
  assert.equal(refusal({ operations: [{ template: ALL, values: { from: 'hyperithm-usdc-apex-v1-7777', to: 'steakhouse-prime-usdc-v2-0f51', 'min-assets': '1', 'min-shares': '1' } }] }), 'resolved');
  assert.equal(
    refusal({ operations: [{ template: ALL, values: { from: 'hyperithm-usdc-apex-v1-7777', to: 'fluid-fusdt', 'min-assets': '1', 'min-shares': '1' } }] }),
    'not-the-same at operations[0]: morpho/vault-migrate-all needs one address for from.asset usdc and to.asset usdt',
  );
});

test('a template whose same list names fewer than two references fails to load', () => {
  const raw = { id: 'x/y', card: { from: { kind: 'contract', registryKind: 'vault' } }, same: ['from.asset'], calls: [{ to: { card: 'from' }, value: { const: '0' }, data: 'empty' }], effects: { gives: [], gets: [] } };
  assert.throws(() => parseTemplate(raw, registry), (error: unknown) => error instanceof TemplateError && /same: names fewer than two/.test(error.message));
});

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const migrate = (minAssets: string, minShares: string): Card => ({
  operations: [{ template: ALL, values: { from: 'smokehouse-usdc-v1-f5bc', to: 'steakhouse-high-yield-usdc-v2-a757', 'min-assets': minAssets, 'min-shares': minShares } }],
});
const BOUNDS: Record<string, [string, string]> = {
  'morpho-migrate-all-smokehouse': ['11959243449', '11619105060826236536810'],
  'morpho-migrate-all-smokehouse-other-safe': ['72804844915', '69500106226276768561930'],
};
const MIGRATE = migrate(...BOUNDS['morpho-migrate-all-smokehouse']!);

function resolvedFor(tx: SafeTx, card: Card) {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

for (const [name, bounds] of Object.entries(BOUNDS)) {
  const tx = safeTx(name);
  const MIGRATE = migrate(...bounds);

  test(`${name} matches ${ALL} with the card it implies`, () => {
    assert.deepEqual(checkTemplateFields(tx, resolvedFor(tx, MIGRATE), templates, registry), { kind: 'match' });
  });

  test(`${name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolvedFor(tx, MIGRATE), templates, registry), { kind: 'pass', bound: 29, free: 1 });
  });
}

test('a migration whose new shares go to someone else is a mismatch at the deposit receiver', () => {
  const tx = safeTx('morpho-migrate-all-smokehouse');
  const safe = tx.safe.slice(2).toLowerCase();
  assert.equal(tx.data.split(safe).length, 2, 'the Safe occurs once in the data');
  const other = { ...tx, data: tx.data.replace(safe, '1'.repeat(40)) as Hex };
  const result = checkTemplateFields(other, resolvedFor(tx, MIGRATE), templates, registry);
  assert.deepEqual(result.kind === 'mismatch' ? result.findings.map((f) => `${f.callPath}.${f.arg}`) : result, [
    'multiSend[1].multicall.bundle[2].data.erc4626Deposit.receiver',
  ]);
});

test('a migration card asks for at least the assets the redeem bound guarantees, and at least the shares the deposit bound guarantees', () => {
  const tx = safeTx('morpho-migrate-all-smokehouse');
  const at = (card: Card) => {
    const result = checkTemplateFields(tx, resolvedFor(tx, card), templates, registry);
    return result.kind === 'mismatch' ? result.findings.map((f) => `${f.callPath}.${f.arg}`) : result.kind;
  };
  const [assets, shares] = BOUNDS['morpho-migrate-all-smokehouse']!;
  assert.deepEqual(at(migrate(`${BigInt(assets) + 1n}`, shares)), [
    'multiSend[1].multicall.bundle[1].data.erc4626Redeem.minSharePriceE27',
  ]);
  assert.deepEqual(at(migrate(assets, `${BigInt(shares) + 1n}`)), ['multiSend[1].multicall.bundle[2].data.erc4626Deposit.maxSharePriceE27']);
});

const recorded: VerdictFile = readRecording(join(ROOT, 'testdata', 'verify', 'morpho-migrate-all.json'));
const ASSET_CALL = '0x38d52e0f';

function withRegistry(edit: (entries: Record<string, { attributes?: Record<string, string> }>) => void): VerifyInputs {
  const entries = JSON.parse(recorded.inputs.registry);
  edit(entries);
  return { ...recorded.inputs, registry: JSON.stringify(entries) };
}

test('the recorded migration, judged by its receipt, is MATCH', async () => {
  assert.deepEqual((await evaluate(recorded.inputs, replayReader(recorded.exchanges))).verdict, { kind: 'MATCH' });
});

test('a registry that names another asset for both vaults is MISMATCH, since each vault asset() is read from the chain', async () => {
  const inputs = withRegistry((entries) => {
    entries['smokehouse-usdc']!.attributes!.asset = 'usdt';
    entries['steakhouse-high-yield-usdc']!.attributes!.asset = 'usdt';
  });
  const { verdict } = await evaluate(inputs, replayReader(recorded.exchanges));
  assert.equal(verdict.kind, 'MISMATCH');
  assert.deepEqual(verdict.causes.map((c) => c.check), ['vault-asset']);
  assert.match(
    JSON.stringify(verdict),
    /smokehouse-usdc 0xbeefff209270748ddd194831b3fa287a5386f5bc holds 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 by its asset\(\) at block \d+, the registry says usdt 0xdac17f958d2ee523a2206206994597c13d831ec7/,
  );
});

test('a vault asset() the two providers disagree on is UNVERIFIABLE', async () => {
  const exchanges = recorded.exchanges.map((e) =>
    JSON.stringify(e.params).includes(ASSET_CALL) ? { ...e, answers: { ...e.answers, drpc: `0x${'0'.repeat(24)}${'11'.repeat(20)}` } } : e,
  );
  const { verdict } = await evaluate(recorded.inputs, replayReader(exchanges));
  assert.equal(verdict.kind, 'UNVERIFIABLE');
  assert.deepEqual(verdict.causes.map((c) => c.check), ['vault-asset']);
});
