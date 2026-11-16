import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Hex, SafeTx } from '../src/safe/types.ts';
import { describeFinding, judgeEffects, viewCalls } from '../src/simulate/effects.ts';
import type { EffectVerdict } from '../src/simulate/effects.ts';
import { observeExecuted, withSimulatedViews } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { TemplateError, loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { signedEntryNames } from '../src/research/report.ts';
import { codeClaims } from '../src/verify/code.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures('vault-v2');
const registry = loadRegistry(ROOT);
const IDS = ['morpho/vault-v2-cap-submit', 'morpho/vault-v2-cap-accept', 'morpho/vault-v2-cap-decrease', 'morpho/vault-v2-reallocate', 'morpho/vault-v2-revoke'];
const templates = new Map(IDS.map((id) => [id, loadTemplate(ROOT, id, registry)]));
const VAULT = 'acuto-usdc-v2-4a57';
const NO_LIMIT = `${(1n << 128n) - 1n}`;
const ALL = '1000000000000000000';

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const card = (template: string, values: Record<string, string>): Card => ({ operations: [{ template, values }] });

function resolved(tx: SafeTx, given: Card): ResolvedCard {
  const result = resolveCard(given, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, given: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, given), templates, registry);
const mismatchedArgs = (result: FieldCheck) => (result.kind === 'mismatch' ? result.findings.map((f) => f.arg) : result);

const caps = (market: string, absolute: string, relative: string) => ({ vault: VAULT, market, 'absolute-cap': absolute, 'relative-cap': relative });

const CASES = [
  { fixture: 'vault-v2-cap-submit-gauntlet', template: 'morpho/vault-v2-cap-submit', values: { ...caps('usdc-cbbtc-86', '300000000000000', ALL), vault: 'gauntlet-usdc-prime-v2-a3d0' }, bound: 18 },
  { fixture: 'vault-v2-cap-submit-flowmark', template: 'morpho/vault-v2-cap-submit', values: { ...caps('usdc-cbbtc-86', '50000000000', '50000000000000000'), vault: 'flowmark-fgenesis-v2-6439' }, bound: 18 },
  { fixture: 'vault-v2-cap-submit-murmurr', template: 'morpho/vault-v2-cap-submit', values: { ...caps('usdc-cbbtc-86', NO_LIMIT, '800000000000000000'), vault: 'murmurr-usdc-frontier-v2-5f99' }, bound: 18 },
  { fixture: 'vault-v2-cap-submit', template: 'morpho/vault-v2-cap-submit', values: caps('usdc-usp-915', NO_LIMIT, ALL), bound: 18 },
  { fixture: 'vault-v2-cap-submit-other-safe', template: 'morpho/vault-v2-cap-submit', values: caps('usdc-usp-915', '1000000', '10000000000000000'), bound: 18 },
  { fixture: 'vault-v2-cap-submit-860', template: 'morpho/vault-v2-cap-submit', values: caps('usdc-usp-86', NO_LIMIT, ALL), bound: 18 },
  { fixture: 'vault-v2-cap-accept', template: 'morpho/vault-v2-cap-accept', values: caps('usdc-usp-915', NO_LIMIT, ALL), bound: 18 },
  { fixture: 'vault-v2-cap-decrease', template: 'morpho/vault-v2-cap-decrease', values: caps('usdc-usp-915', '0', '0'), bound: 18 },
  { fixture: 'vault-v2-cap-decrease-other-safe', template: 'morpho/vault-v2-cap-decrease', values: caps('usdc-usp-915', '10', '0'), bound: 18 },
  { fixture: 'vault-v2-revoke', template: 'morpho/vault-v2-revoke', values: caps('usdc-usp-915', '1000000', '10000000000000000'), bound: 18 },
  { fixture: 'vault-v2-reallocate', template: 'morpho/vault-v2-reallocate', values: { vault: VAULT, from: 'usdc-usp-915', to: 'usdc-usp-86', amount: '1' }, bound: 16 },
  { fixture: 'vault-v2-reallocate-back', template: 'morpho/vault-v2-reallocate', values: { vault: VAULT, from: 'usdc-usp-86', to: 'usdc-usp-915', amount: '1000000' }, bound: 16 },
] as const;

for (const c of CASES) {
  const tx = safeTx(c.fixture);

  test(`${c.fixture} matches ${c.template} with the card it implies`, () => {
    assert.deepEqual(check(tx, card(c.template, c.values)), { kind: 'match' });
  });

  test(`${c.fixture}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, card(c.template, c.values)), templates, registry), { kind: 'pass', bound: c.bound, free: 0 });
  });

  test(`${c.fixture}: every contract verify compares with its code pin is one the report says each signing checks`, () => {
    const signed = signedEntryNames(templates.get(c.template) as Template, registry);
    const claimed = codeClaims(tx, resolved(tx, card(c.template, c.values)), templates, registry).map((entry) => entry.name);
    assert.deepEqual(claimed.filter((name) => !signed.has(name)), []);
  });
}

test('a cap submission with another absolute cap or another market on the card is a mismatch at that field', () => {
  const tx = safeTx('vault-v2-cap-submit-other-safe');
  assert.deepEqual(mismatchedArgs(check(tx, card('morpho/vault-v2-cap-submit', caps('usdc-usp-915', '1000001', '10000000000000000')))), ['newAbsoluteCap']);
  assert.deepEqual(mismatchedArgs(check(tx, card('morpho/vault-v2-cap-submit', caps('usdc-usp-915', '1000000', ALL)))), ['newRelativeCap']);
  const otherMarket = mismatchedArgs(check(tx, card('morpho/vault-v2-cap-submit', caps('usdc-usp-86', '1000000', '10000000000000000'))));
  assert.deepEqual(otherMarket, ['marketParams.lltv', 'marketParams.lltv']);
});

test('a reallocation with the markets swapped or another amount on the card is a mismatch', () => {
  const tx = safeTx('vault-v2-reallocate');
  const swapped = check(tx, card('morpho/vault-v2-reallocate', { vault: VAULT, from: 'usdc-usp-86', to: 'usdc-usp-915', amount: '1' }));
  assert.deepEqual(mismatchedArgs(swapped), ['marketParams.lltv', 'marketParams.lltv']);
  assert.deepEqual(mismatchedArgs(check(tx, card('morpho/vault-v2-reallocate', { vault: VAULT, from: 'usdc-usp-915', to: 'usdc-usp-86', amount: '2' }))), ['assets', 'assets']);
});

test('a percent above 100 is refused on the card', () => {
  const result = resolveCard(card('morpho/vault-v2-cap-submit', caps('usdc-usp-915', NO_LIMIT, `${10n ** 18n + 1n}`)), { templates, registry, addressBook: new Map(), safe: safeTx('vault-v2-cap-submit').safe });
  assert.equal(result.kind === 'refused' ? result.reason : result.kind, 'not-a-percent');
});

const raw = (id: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, 'templates', id, 'template.json'), 'utf8'));
const refusal = (template: unknown): string => {
  try {
    parseTemplate(template, registry);
  } catch (error) {
    if (error instanceof TemplateError) return error.message;
    throw error;
  }
  return 'parsed';
};

test('template load refuses a keccak outside a view, a long constant string, and an abi rule on a number', () => {
  const submit = raw('morpho/vault-v2-cap-submit');
  const text = JSON.stringify(submit);
  const keccakInCall = JSON.parse(text.replace('"idData":{"abi"', '"idData":{"keccak":{"abi"').replace('"marketParams":{"card":"market"}}}},"newAbsoluteCap"', '"marketParams":{"card":"market"}}}}},"newAbsoluteCap"'));
  assert.match(refusal(keccakInCall), /binds only a view's argument/);
  const longTag = JSON.parse(text.replaceAll('"this/marketParams"', `"${'a'.repeat(33)}"`));
  assert.match(refusal(longTag), /a constant string is a tag of at most 32 printable ASCII characters/);
  const abiOnNumber = JSON.parse(text.replace('"newAbsoluteCap":{"card":"absolute-cap"}', '"newAbsoluteCap":{"abi":{"params":"uint256 x","args":{"x":{"card":"absolute-cap"}}}}'));
  assert.match(refusal(abiOnNumber), /a abi rule cannot bind a uint256/);
});

type Fixture = { transactionHash: Hex; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(ROOT, 'testdata', 'simulate', `${name}.json`), 'utf8'));

/** The recorded transaction, simulated on its parent block and observed from its receipt, judged against the card. */
async function recordedVerdicts(name: string, given: Card): Promise<{ simulated: EffectVerdict; executed: EffectVerdict }> {
  const recorded = fixture(name);
  const tx = safeTx(name);
  const reader = replayReader(recorded.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(recorded.parent), await header(recorded.executed)];
  const views = viewCalls(resolved(tx, given), templates as ReadonlyMap<string, Template>, registry);
  const simulated = await simulateSafeTx(reader, { tx, parent, time: executed.time, watch: [], ends: [], views });
  const fromReceipt = withSimulatedViews(await observeExecuted(reader, recorded.transactionHash, tx, [], views), simulated, views);
  const judged = (observation: Observation): EffectVerdict => {
    assert.equal(observation.kind, 'observed', observation.kind === 'unverifiable' ? observation.reasons.join('; ') : '');
    return judgeEffects((observation as Extract<Observation, { kind: 'observed' }>).observed, resolved(tx, given), templates, registry);
  };
  return { simulated: judged(simulated), executed: judged(fromReceipt) };
}

const RECORDED = [
  { name: 'vault-v2-cap-submit-flowmark', given: card('morpho/vault-v2-cap-submit', { ...caps('usdc-cbbtc-86', '50000000000', '50000000000000000'), vault: 'flowmark-fgenesis-v2-6439' }) },
  { name: 'vault-v2-cap-submit', given: card('morpho/vault-v2-cap-submit', caps('usdc-usp-915', NO_LIMIT, ALL)) },
  { name: 'vault-v2-cap-accept', given: card('morpho/vault-v2-cap-accept', caps('usdc-usp-915', NO_LIMIT, ALL)) },
  { name: 'vault-v2-cap-decrease', given: card('morpho/vault-v2-cap-decrease', caps('usdc-usp-915', '0', '0')) },
  { name: 'vault-v2-revoke', given: card('morpho/vault-v2-revoke', caps('usdc-usp-915', '1000000', '10000000000000000')) },
  { name: 'vault-v2-reallocate', given: card('morpho/vault-v2-reallocate', { vault: VAULT, from: 'usdc-usp-915', to: 'usdc-usp-86', amount: '1' }) },
];

for (const { name, given } of RECORDED) {
  test(`${name}: the vault's views change as the card says and no asset of the Safe moves, simulated and from its receipt`, async () => {
    assert.deepEqual(await recordedVerdicts(name, given), { simulated: { kind: 'match' }, executed: { kind: 'match' } });
  });
}

test('a decrease the card states as another cap is a mismatch naming the cap the card wants', async () => {
  const { executed } = await recordedVerdicts('vault-v2-cap-decrease', card('morpho/vault-v2-cap-decrease', caps('usdc-usp-915', '7', '0')));
  assert.equal(executed.kind, 'mismatch');
  const lines = executed.kind === 'mismatch' ? executed.findings.map((f) => describeFinding(f, registry)) : [];
  assert.ok(lines.some((line) => line.includes('absoluteCap') && line.endsWith('the template needs it to be 7, as the card says')), lines.join('\n'));
});
