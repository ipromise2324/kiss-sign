import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import type { Reader } from '../src/chain/reader.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { checkSimulatedFloor } from '../src/floor/simulated.ts';
import { judgeEffects } from '../src/simulate/effects.ts';
import type { EffectVerdict, Observed } from '../src/simulate/effects.ts';
import { observeExecuted } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { loadTemplate } from '../src/template/template.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const ROOT = join(import.meta.dirname, '..');
const load = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));

type Fixture = { transactionHash: Hex; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };

const recorded: Fixture = load('simulate', 'morpho-vault-deposit');
const safeTxFixture = load('safe-tx', 'morpho-vault-deposit');
const deposit = parseServiceTx(safeTxFixture.service, { chainId: 1n, version: safeTxFixture.chain.version });
const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, 'morpho/vault-deposit', registry);
const templates = new Map([[template.id, template]]);

const USDC = registry.entries.get('usdc')!.address;
const VAULT = registry.entries.get('steakhouse-prime-usdc-v2-0f51')!.address;
const GENERAL_ADAPTER1 = registry.entries.get('general-adapter-1')!.address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const AMOUNT = 1800000000180n;
const SHARES = 1742403090147006731022214n;

const replay = (fixture: Fixture): Reader => replayReader(fixture.exchanges);

const depositCard = (amount = AMOUNT, count = 1): Card => ({
  operations: Array.from({ length: count }, () => ({ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc-v2-0f51', amount: `${amount}`, 'min-shares': '1741863305677219101283940' } })),
});

function resolved(card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: deposit.safe });
  assert.equal(result.kind, 'resolved');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const judge = (observed: Observed, card: Card = depositCard()): EffectVerdict => judgeEffects(observed, resolved(card), templates, registry);

async function simulated(fixture: Fixture = recorded, tx: SafeTx = deposit): Promise<Observation> {
  const reader = replay(fixture);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(recorded.parent), await header(recorded.executed)];
  return simulateSafeTx(reader, { tx, parent, time: executed.time, watch: [USDC, VAULT], ends: [] });
}

function observed(observation: Observation): Observed {
  assert.equal(observation.kind, 'observed', observation.kind === 'unverifiable' ? observation.reasons.join('; ') : '');
  return (observation as Extract<Observation, { kind: 'observed' }>).observed;
}

const depositEffects = (overrides: Partial<Extract<Observed, { kind: 'executed' }>> = {}): Observed => ({
  kind: 'executed',
  eth: 0n,
  tokens: new Map([
    [USDC, -AMOUNT],
    [VAULT, SHARES],
  ]),
  allowances: [{ token: USDC, spender: GENERAL_ADAPTER1, before: 0n, after: 0n }],
  permit2: [],
  ends: new Map(),
  safeState: { kind: 'receipt', logs: [] },
  ...overrides,
});

/** What the Safe gave and got, without how its settings were observed. */
function balances(observed: Observed) {
  assert.equal(observed.kind, 'executed');
  const { safeState: _, ...rest } = observed as Extract<Observed, { kind: 'executed' }>;
  return rest;
}

test('the Morpho deposit, simulated on its parent block, gives exactly the card amount of USDC for shares and leaves no approval', async () => {
  const effects = observed(await simulated());
  assert.deepEqual(balances(effects), balances(depositEffects()));
  assert.deepEqual(judge(effects), { kind: 'match' });
});

test('the simulated deposit leaves every Safe setting as it was and passes the simulated floor', async () => {
  const effects = observed(await simulated());
  const evidence = (effects as Extract<Observed, { kind: 'executed' }>).safeState;
  assert.equal(evidence.kind, 'read');
  const { before, after } = evidence as Extract<typeof evidence, { kind: 'read' }>;
  assert.deepEqual(after, before);
  assert.equal(before.singleton, '0x00000000000000000000000041675c099f32341bf84bfc5382af534df5c7461a');
  assert.equal(before.threshold, 2n);
  assert.equal(before.owners.length, 6);
  assert.deepEqual(before.modules, []);
  assert.equal(before.moduleGuard, undefined);
  assert.deepEqual(checkSimulatedFloor(effects, deposit.safe), { kind: 'pass' });
});

test('the receipt of the executed deposit shows the same USDC and shares', async () => {
  const effects = observed(await observeExecuted(replay(recorded), recorded.transactionHash, deposit, []));
  assert.deepEqual(balances(effects), balances(depositEffects()));
  assert.deepEqual(judge(effects), { kind: 'match' });
  assert.deepEqual(checkSimulatedFloor(effects, deposit.safe), { kind: 'pass' });
});

test('a card amount one unit higher mismatches on USDC', async () => {
  const verdict = judge(observed(await simulated()), depositCard(AMOUNT + 1n));
  assert.deepEqual(verdict, {
    kind: 'mismatch',
    findings: [{ kind: 'balance', asset: USDC, expected: { kind: 'exactly', change: -(AMOUNT + 1n) }, actual: -AMOUNT }],
  });
});

test('a provider that reports a different balance inside the simulation makes it unverifiable, naming both providers', async () => {
  const lying = structuredClone(recorded);
  const measurement = lying.exchanges.filter((e) => e.method === 'eth_simulateV1')[1]!;
  const calls = (measurement.answers.drpc as { calls: { returnData: string }[] }[])[0]!.calls;
  calls[1]!.returnData = `0x${(BigInt(calls[1]!.returnData) + 1n).toString(16).padStart(64, '0')}`;
  const observation = await simulated(lying);
  assert.equal(observation.kind, 'unverifiable');
  const reasons = (observation as Extract<Observation, { kind: 'unverifiable' }>).reasons.join('; ');
  assert.match(reasons, /eth_simulateV1: alchemy and drpc disagree/);
});

test('a transaction whose nonce is not the Safe nonce on chain is not simulated', async () => {
  const observation = await simulated(recorded, { ...deposit, nonce: deposit.nonce + 1n });
  assert.deepEqual(observation, { kind: 'unverifiable', reasons: ["the Safe's nonce at block 26048222 is 249, the transaction's is 250"] });
});

test('an outflow of a token the card does not name is a mismatch naming the token and its change', () => {
  const tokens = new Map([
    [USDC, -AMOUNT],
    [VAULT, SHARES],
    [OTHER, -5n],
  ]);
  assert.deepEqual(judge(depositEffects({ tokens })), {
    kind: 'mismatch',
    findings: [{ kind: 'balance', asset: OTHER, expected: { kind: 'exactly', change: 0n }, actual: -5n }],
  });
});

test('an ETH change the card does not explain is a mismatch', () => {
  assert.deepEqual(judge(depositEffects({ eth: -1n })), {
    kind: 'mismatch',
    findings: [{ kind: 'balance', asset: 'eth', expected: { kind: 'exactly', change: 0n }, actual: -1n }],
  });
});

test('an allowance left open is a mismatch', () => {
  const open = { token: USDC, spender: GENERAL_ADAPTER1, before: 0n, after: 7n };
  assert.deepEqual(judge(depositEffects({ allowances: [open] })), { kind: 'mismatch', findings: [{ kind: 'open-allowance', ...open }] });
});

test('no shares received is a mismatch, since the deposit must get a positive amount', () => {
  const tokens = new Map([[USDC, -AMOUNT]]);
  assert.deepEqual(judge(depositEffects({ tokens })), {
    kind: 'mismatch',
    findings: [{ kind: 'balance', asset: VAULT, expected: { kind: 'more-than', change: 0n }, actual: 0n }],
  });
});

test('a Safe transaction that did not execute is unverifiable', () => {
  for (const why of ['execution-failure', 'reverted', 'other-safe-tx-hash'] as const) {
    const verdict = judge({ kind: 'not-executed', why });
    assert.equal(verdict.kind, 'unverifiable', why);
  }
});

test("a batch card's effects are the sum over its operations", () => {
  const twice = depositEffects({ tokens: new Map([[USDC, -2n * AMOUNT], [VAULT, 2n * SHARES]]) });
  assert.deepEqual(judge(twice, depositCard(AMOUNT, 2)), { kind: 'match' });
  assert.equal(judge(depositEffects(), depositCard(AMOUNT, 2)).kind, 'mismatch');
});

test('a receipt that executed two Safe transactions cannot judge either, and says why', async () => {
  const { EXECUTION_SUCCESS, executionOf } = await import('../src/simulate/events.ts');
  const safe = '0x1111111111111111111111111111111111111111' as Address;
  const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
  const log = (n: number) => ({ address: safe, topics: [EXECUTION_SUCCESS, hash(n)], data: `0x${'0'.repeat(64)}` as Hex });
  assert.equal(executionOf([log(1)], safe, hash(1)), 'success');
  assert.equal(executionOf([log(1), log(2)], safe, hash(1)), 'several-safe-executions-in-one-transaction');
  assert.equal(executionOf([], safe, hash(1)), 'no-execution-event');
});
