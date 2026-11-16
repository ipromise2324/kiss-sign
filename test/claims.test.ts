import { bytesToHex } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { REGISTRY_PATH, parseRegistry } from '../src/registry.ts';
import { regionBytes } from '../src/decode/codec.ts';
import { unwrapSafeTx } from '../src/decode/multisend.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { expectedChanges, judgeEffects } from '../src/simulate/effects.ts';
import type { EffectVerdict, Observed } from '../src/simulate/effects.ts';
import { observeExecuted } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { TemplateError, loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const ROOT = repoWithTestFixtures();
const load = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));
const REWARD_TOKENS_OUTSIDE_REGISTRY = {
  aethusde: { address: '0x3a4de44B29995a3D8Cd02d46243E1563E55bCc8b', kind: 'token', source: 'https://aave.com/docs/resources/addresses' },
  fxn: { address: '0x365AccFCa291e7D3914637ABf1F7635dB165Bb09', kind: 'token', source: 'https://github.com/AladdinDAO/aladdin-v3-contracts/blob/main/scripts/utils/tokens.ts' },
};
const registry = parseRegistry({ ...JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8')), ...REWARD_TOKENS_OUTSIDE_REGISTRY });
const IDS = ['fluid/rewards-claim', 'fluid/vault-withdraw', 'merkl/claim', 'cctp/receive'];
const templates = new Map<string, Template>(IDS.map((id) => [id, loadTemplate(ROOT, id, registry)]));
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const addressOf = (name: string): Address => registry.entries.get(name)!.address;

function safeTx(name: string): SafeTx {
  const fixture = load('safe-tx', name);
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const claim = (template: string, token: string): Card['operations'][number] => ({ template, values: { token } });
const card = (...operations: Card['operations']): Card => ({ operations });
const check = (tx: SafeTx, c: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, c), templates, registry);
const findings = (result: FieldCheck) => (result.kind === 'mismatch' ? result.findings.map((f) => `${f.callPath}.${f.arg}`) : result);

function otherRecipient(tx: SafeTx): SafeTx {
  const word = tx.safe.slice(2).toLowerCase().padStart(64, '0');
  const data = tx.data.slice(2).replaceAll(word, OTHER.slice(2).padStart(64, '0'));
  assert.notEqual(data, tx.data.slice(2), 'the transaction names the Safe');
  return { ...tx, data: `0x${data}` as Hex };
}

const CASES = [
  { name: 'fluid-claim', card: card(claim('fluid/rewards-claim', 'fluid')), bound: 3, free: 6, recipient: ['call.claim.recipient_'] },
  {
    name: 'fluid-claim-two',
    card: card(claim('fluid/rewards-claim', 'fluid'), claim('fluid/rewards-claim', 'fluid')),
    bound: 6,
    free: 12,
    recipient: ['multiSend[0].claim.recipient_', 'multiSend[1].claim.recipient_'],
  },
  { name: 'fluid-claim-other-safe', card: card(claim('fluid/rewards-claim', 'fluid')), bound: 3, free: 6, recipient: ['call.claim.recipient_'] },
  { name: 'merkl-claim', card: card(claim('merkl/claim', 'morpho')), bound: 4, free: 2, recipient: ['call.claim.users[0]'] },
  { name: 'merkl-claim-other-safe', card: card(claim('merkl/claim', 'morpho')), bound: 4, free: 2, recipient: ['call.claim.users[0]'] },
  {
    name: 'merkl-claim-two-tokens',
    card: card(claim('merkl/claim', 'usdc'), claim('merkl/claim', 'morpho')),
    bound: 6,
    free: 4,
    recipient: ['call.claim.users[0]', 'call.claim.users[1]'],
  },
  {
    name: 'merkl-claim-three-tokens',
    card: card(claim('merkl/claim', 'morpho'), claim('merkl/claim', 'aethusde'), claim('merkl/claim', 'fxn')),
    bound: 8,
    free: 6,
    recipient: ['call.claim.users[0]', 'call.claim.users[1]', 'call.claim.users[2]'],
  },
] as const;

for (const c of CASES) {
  const tx = safeTx(c.name);

  test(`${c.name} matches its claim templates with the card it implies`, () => {
    assert.deepEqual(check(tx, c.card), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, c.card), templates, registry), { kind: 'pass', bound: c.bound, free: c.free });
  });

  test(`${c.name}: a reward claimed for anyone but the Safe is a mismatch at the recipient`, () => {
    assert.deepEqual(findings(check(otherRecipient(tx), c.card)), c.recipient);
  });
}

test('the reward tokens of a merged Merkl claim must be on the card, in its order, and all of them', () => {
  const tx = safeTx('merkl-claim-three-tokens');
  assert.deepEqual(findings(check(tx, card(claim('merkl/claim', 'aethusde'), claim('merkl/claim', 'morpho'), claim('merkl/claim', 'fxn')))), [
    'call.claim.tokens[0]',
    'call.claim.tokens[1]',
  ]);
  assert.deepEqual(findings(check(tx, card(claim('merkl/claim', 'morpho'), claim('merkl/claim', 'aethusde')))), [
    'call.claim.users',
    'call.claim.tokens',
    'call.claim.amounts',
    'call.claim.proofs',
  ]);
});

test('a claim whose card names another reward token mismatches where the token is in the call', () => {
  assert.deepEqual(findings(check(safeTx('merkl-claim'), card(claim('merkl/claim', 'usdc')))), ['call.claim.tokens[0]']);
});

test('a Fluid claim and an fToken withdrawal batched in one MultiSend both need their own card operation', () => {
  const tx = safeTx('fluid-claim-two');
  assert.deepEqual(findings(check(tx, card(claim('fluid/rewards-claim', 'fluid')))), ['multiSend[1].call']);
  const withdraw = { template: 'fluid/vault-withdraw', values: { vault: 'fluid-fusdt', amount: '1' } };
  assert.deepEqual(findings(check(tx, card(claim('fluid/rewards-claim', 'fluid'), withdraw))), ['multiSend[1].to', 'multiSend[1].selector']);
});

test('a merged call takes every argument as items, with as many items in each, or the template fails to load', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'merkl', 'claim', 'template.json'), 'utf8'));
  const unequal = structuredClone(raw);
  unequal.calls[0].args.users.items.push({ safe: true });
  const loose = structuredClone(raw);
  loose.calls[0].args.amounts = { free: { proof: 'x' } };
  for (const broken of [unequal, loose]) {
    assert.throws(() => parseTemplate(broken, registry), (error: unknown) => error instanceof TemplateError && error.path === 'calls[0].merge');
  }
});

type SimFixture = { safeTx: string; transactionHash: Hex; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };

/**
 * The effects verdicts, from the simulation on the parent block and from the receipt, that `judgedAs` gets for what
 * the recording observed with the tokens `c` names watched.
 */
async function observe(name: string, c: Card, judgedAs: Card = c): Promise<{ simulated: EffectVerdict; receipt: EffectVerdict }> {
  const fixture: SimFixture = load('simulate', name);
  const tx = safeTx(fixture.safeTx);
  const reader = replayReader(fixture.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const resolvedCard = resolved(tx, c);
  const expectations = expectedChanges(resolvedCard, templates, registry);
  const watch = expectations.kind === 'expected' ? [...expectations.changes.keys()].filter((asset): asset is Address => asset !== 'eth') : [];
  const [parent, executed] = [await header(fixture.parent), await header(fixture.executed)];
  const judged = (observation: Observation): EffectVerdict => {
    assert.equal(observation.kind, 'observed', observation.kind === 'unverifiable' ? observation.reasons.join('; ') : '');
    return judgeEffects((observation as Extract<Observation, { kind: 'observed' }>).observed, resolved(tx, judgedAs), templates, registry);
  };
  return {
    simulated: judged(await simulateSafeTx(reader, { tx, parent, time: executed.time, watch, ends: [] })),
    receipt: judged(await observeExecuted(reader, fixture.transactionHash, tx, [])),
  };
}

const MATCH = { simulated: { kind: 'match' }, receipt: { kind: 'match' } };

test('a Fluid claim gets FLUID and changes nothing else, simulated and from its receipt', async () => {
  assert.deepEqual(await observe('fluid-claim', card(claim('fluid/rewards-claim', 'fluid'))), MATCH);
});

test('a Merkl claim gets MORPHO, simulated and from its receipt; a card for another reward token explains neither change', async () => {
  assert.deepEqual(await observe('merkl-claim', card(claim('merkl/claim', 'morpho'))), MATCH);
  const { receipt } = await observe('merkl-claim', card(claim('merkl/claim', 'morpho')), card(claim('merkl/claim', 'usdc')));
  assert.deepEqual(
    receipt.kind === 'mismatch' ? receipt.findings.map((f) => (f.kind === 'balance' ? [f.asset, f.expected.kind, f.actual > 0n] : f.kind)) : receipt,
    [
      [addressOf('usdc'), 'more-than', false],
      [addressOf('morpho'), 'exactly', true],
    ],
  );
});

/**
 * No Safe in the searched blocks received a CCTP message on its own, so the CCTP tests take the receive that
 * `cctp-receive-then-call` makes first in its MultiSend, and the amount its message mints.
 */
const cctpFixture = safeTx('cctp-receive-then-call');
const cctpReceive = (() => {
  const unwrapped = unwrapSafeTx(cctpFixture);
  assert.equal(unwrapped.kind, 'multisend');
  const first = (unwrapped as Extract<typeof unwrapped, { kind: 'multisend' }>).calls[0]!;
  const data = regionBytes(first.data);
  const message = data.subarray(4 + 96);
  const amount = BigInt(`0x${bytesToHex(message.subarray(184, 216))}`);
  const direct: SafeTx = { ...cctpFixture, to: first.to, value: 0n, operation: 0, data: `0x${bytesToHex(data)}` as Hex };
  return { direct, amount, mintRecipient: `0x${bytesToHex(message.subarray(164, 184))}` };
})();
const receive = (amount: bigint): Card => card({ template: 'cctp/receive', values: { token: 'usdc', amount: `${amount}` } });

test('a CCTP receive in a MultiSend matches cctp/receive, and the calls after it need their own card operations', () => {
  assert.notEqual(cctpReceive.mintRecipient, cctpFixture.safe, 'this Safe relays a message that mints to another address');
  assert.equal(cctpReceive.direct.to, addressOf('cctp-message-transmitter'));
  assert.deepEqual(findings(check(cctpFixture, receive(cctpReceive.amount))), ['multiSend[1].call']);
});

test('a CCTP receive alone matches its card, and its target and value are bound', () => {
  assert.deepEqual(check(cctpReceive.direct, receive(cctpReceive.amount)), { kind: 'match' });
  assert.deepEqual(checkMutations(cctpReceive.direct, resolved(cctpReceive.direct, receive(cctpReceive.amount)), templates, registry), {
    kind: 'pass',
    bound: 2,
    free: 2,
  });
});

test('the effects, not the fields, hold a CCTP message to the Safe and the card amount: a mint elsewhere, as this message makes, is a mismatch', () => {
  const { direct, amount } = cctpReceive;
  const usdc = addressOf('usdc');
  const observed = (minted: bigint): Observed => ({
    kind: 'executed',
    safeState: { kind: 'receipt', logs: [] },
    eth: 0n,
    tokens: new Map(minted === 0n ? [] : [[usdc, minted]]),
    allowances: [],
    permit2: [],
    ends: new Map(),
  });
  const judge = (minted: bigint) => judgeEffects(observed(minted), resolved(direct, receive(amount)), templates, registry);
  assert.deepEqual(judge(amount), { kind: 'match' });
  for (const minted of [0n, amount - 1n, amount + 1n]) {
    assert.deepEqual(judge(minted), { kind: 'mismatch', findings: [{ kind: 'balance', asset: usdc, expected: { kind: 'exactly', change: amount }, actual: minted }] });
  }
});

test('a card that claims a reward in USDC and also receives an exact amount of USDC through CCTP cannot be judged', () => {
  const tx = safeTx('cctp-receive-then-call');
  const both = card(claim('merkl/claim', 'usdc'), { template: 'cctp/receive', values: { token: 'usdc', amount: '1000' } });
  const expectations = expectedChanges(resolved(tx, both), templates, registry);
  assert.deepEqual(expectations, { kind: 'unverifiable', reasons: [`the card names an exact and an open amount of ${addressOf('usdc')}, so neither can be checked`] });
});
