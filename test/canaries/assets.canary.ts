import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../../src/card.ts';
import { readRecording } from '../../src/chain/bytecode.ts';
import { replayReader } from '../../src/chain/recording.ts';
import { loadRegistry } from '../../src/registry.ts';
import { parseServiceTx } from '../../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../../src/safe/types.ts';
import { describeFinding, judgeEffects } from '../../src/simulate/effects.ts';
import type { Observed } from '../../src/simulate/effects.ts';
import { observeExecuted } from '../../src/simulate/executed.ts';
import { simulateSafeTx } from '../../src/simulate/simulate.ts';
import type { Observation } from '../../src/simulate/simulate.ts';
import { parseTemplate } from '../../src/template/template.ts';
import { evaluate } from '../../src/verify/verify.ts';
import type { VerdictFile, VerifyInputs } from '../../src/verify/verify.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const recording = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));
const deposit: VerdictFile = recording('verify', 'morpho-vault-deposit');
const migration: VerdictFile = recording('verify', 'morpho-migrate-all');
const keccakText = (text: string): string => `0x${bytesToHex(keccak_256(new TextEncoder().encode(text)))}`;
const NO_EFFECTS = { gives: [], gets: [] };

const registry = loadRegistry(ROOT);
const templateText = (id: string) => JSON.parse(readFileSync(join(ROOT, 'templates', id, 'template.json'), 'utf8'));
const recordedTx = (name: string): SafeTx => {
  const { service, chain } = recording('safe-tx', name);
  return parseServiceTx(service, { chainId: 1n, version: chain.version });
};
const observedOf = (observation: Observation): Observed => {
  assert.equal(observation.kind, 'observed', observation.kind === 'unverifiable' ? observation.reasons.join('; ') : '');
  return (observation as Extract<Observation, { kind: 'observed' }>).observed;
};

/** What the effects check finds in `observed` for a card of the template `id`, its effects replaced by `effects`. */
function judged(observed: Observed, id: string, effects: object, values: Record<string, string>, book: Record<string, Address>, safe: Address): string[] {
  const template = parseTemplate({ ...templateText(id), effects }, registry);
  const templates = new Map([[template.id, template]]);
  const card = resolveCard({ operations: [{ template: template.id, values }] }, { templates, registry, addressBook: new Map(Object.entries(book)), safe });
  assert.equal(card.kind, 'resolved');
  const verdict = judgeEffects(observed, (card as Extract<typeof card, { kind: 'resolved' }>).card, templates, registry);
  return verdict.kind === 'mismatch' ? verdict.findings.map((f) => describeFinding(f, registry)) : [verdict.kind];
}

/** The recorded inputs with the one template's effects replaced, approved at its new hash so only the effects differ. */
function withEffects(inputs: VerifyInputs, effects: object): VerifyInputs {
  const [only] = inputs.templates;
  const text = JSON.stringify({ ...JSON.parse(only!.text), effects });
  return { ...inputs, templates: [{ id: only!.id, text, approved: keccakText(text) }] };
}

test('a token found only by a Transfer log naming the Safe is judged by the receipt: the recorded deposit, with effects that explain no change, is MISMATCH on each', async () => {
  assert.deepEqual((await evaluate(deposit.inputs, replayReader(deposit.exchanges))).verdict, { kind: 'MATCH' });
  const { verdict } = await evaluate(withEffects(deposit.inputs, NO_EFFECTS), replayReader(deposit.exchanges));
  assert.deepEqual(verdict, {
    kind: 'MISMATCH',
    causes: [
      {
        check: 'effects',
        details: [
          'usdc 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 changed by -1800000000180, the card explains 0',
          'steakhouse-prime-usdc 0xbeef088055857739c12cd3765f20b7679def0f51 changed by +1742403090147006731022214, the card explains 0',
        ],
      },
    ],
  });
  const onlyUsdc = await evaluate(withEffects(deposit.inputs, { gives: [{ token: 'card.vault.asset', amount: 'card.amount' }], gets: [] }), replayReader(deposit.exchanges));
  assert.deepEqual(onlyUsdc.verdict, {
    kind: 'MISMATCH',
    causes: [{ check: 'effects', details: ['steakhouse-prime-usdc 0xbeef088055857739c12cd3765f20b7679def0f51 changed by +1742403090147006731022214, the card explains 0'] }],
  });
});

test('a token found only by a Transfer log naming the Safe is judged when the deposit is simulated as a pending transaction, watching no token', async () => {
  const simulated = recording('simulate', 'morpho-vault-deposit');
  const tx = recordedTx('morpho-vault-deposit');
  const reader = replayReader(simulated.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(simulated.parent), await header(simulated.executed)];
  const observed = observedOf(await simulateSafeTx(reader, { tx, parent, time: executed.time, watch: [], ends: [] }));
  const values = { vault: 'steakhouse-prime-usdc-v2-0f51', amount: '1800000000180', 'min-shares': '1741863305677219101283940' };
  const judge = (effects: object) => judged(observed, 'morpho/vault-deposit', effects, values, {}, tx.safe);
  assert.deepEqual(judge(templateText('morpho/vault-deposit').effects), ['match']);
  assert.deepEqual(judge(NO_EFFECTS), [
    'usdc 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 changed by -1800000000180, the card explains 0',
    'steakhouse-prime-usdc-v2-0f51 0xbeef088055857739c12cd3765f20b7679def0f51 changed by +1742403090147006731022214, the card explains 0',
  ]);
});

test('ETH the Safe gives is judged though no effect names ETH: the recorded ETH transfer, by its receipt and simulated, with effects that explain no change, is a mismatch on ETH', async () => {
  const recorded = recording('simulate', 'eth-transfer-null-data');
  const tx = recordedTx('eth-transfer-null-data');
  const reader = replayReader(recorded.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(recorded.parent), await header(recorded.executed)];
  const byReceipt = observedOf(await observeExecuted(reader, recorded.transactionHash as Hex, tx, []));
  const simulated = observedOf(await simulateSafeTx(reader, { tx, parent, time: executed.time, watch: [], ends: [] }));
  for (const observed of [byReceipt, simulated]) {
    const judge = (effects: object) => judged(observed, 'eth/transfer', effects, { amount: `${tx.value}`, recipient: 'payee' }, { payee: tx.to }, tx.safe);
    assert.deepEqual(judge(templateText('eth/transfer').effects), ['match']);
    assert.deepEqual(judge(NO_EFFECTS), [`ETH changed by -${tx.value}, the card explains 0`]);
  }
});

test('a vault whose asset() is not the token the registry names is MISMATCH, and one the providers disagree on UNVERIFIABLE', async () => {
  assert.deepEqual((await evaluate(migration.inputs, replayReader(migration.exchanges))).verdict, { kind: 'MATCH' });
  const vaultAssetFindings = async (recorded: VerdictFile, vaults: string[]) => {
    const entries = JSON.parse(recorded.inputs.registry);
    for (const vault of vaults) entries[vault].attributes.asset = 'usdt';
    const { verdict } = await evaluate({ ...recorded.inputs, registry: JSON.stringify(entries) }, replayReader(recorded.exchanges));
    assert.equal(verdict.kind, 'MISMATCH');
    return verdict.causes.filter((c) => c.check === 'vault-asset').flatMap((c) => c.details.map((d) => d.replace(/at block \d+/, 'at block N')));
  };
  const finding = (vault: string, address: string) =>
    `${vault} ${address} holds 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 by its asset() at block N, the registry says usdt 0xdac17f958d2ee523a2206206994597c13d831ec7`;
  assert.deepEqual(await vaultAssetFindings(deposit, ['steakhouse-prime-usdc']), [finding('steakhouse-prime-usdc', '0xbeef088055857739c12cd3765f20b7679def0f51')]);
  assert.deepEqual(await vaultAssetFindings(migration, ['smokehouse-usdc', 'steakhouse-high-yield-usdc']), [
    finding('smokehouse-usdc', '0xbeefff209270748ddd194831b3fa287a5386f5bc'),
    finding('steakhouse-high-yield-usdc', '0xbeeff2c5bf38f90e3482a8b19f12e5a6d2fca757'),
  ]);
  const ASSET_CALL = '0x38d52e0f';
  const exchanges = migration.exchanges.map((e) =>
    JSON.stringify(e.params).includes(ASSET_CALL) ? { ...e, answers: { ...e.answers, drpc: `0x${'0'.repeat(24)}${'11'.repeat(20)}` } } : e,
  );
  const disagreed = await evaluate(migration.inputs, replayReader(exchanges));
  assert.equal(disagreed.verdict.kind, 'UNVERIFIABLE');
  assert.deepEqual(disagreed.verdict.causes.map((c) => c.check), ['vault-asset']);
});
