import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { checkFloor } from '../src/floor/floor.ts';
import { checkSimulatedFloor } from '../src/floor/simulated.ts';
import { floorAllowed } from '../src/floor/summary.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Hex, SafeTx } from '../src/safe/types.ts';
import { judgeEffects } from '../src/simulate/effects.ts';
import type { Observed } from '../src/simulate/effects.ts';
import { observeExecuted, withSimulatedSafeState } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const ID = 'safe/change-threshold';
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>([[ID, loadTemplate(ROOT, ID, registry)]]);
const load = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));

/** Each test transaction, from another Safe, with the threshold it sets: one Safe of version 1.4.1 and one of 1.3.0. */
const FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ['safe-change-threshold-1-4-1', '3'],
  ['safe-change-threshold-1-3-0', '2'],
];

function safeTx(name: string): SafeTx {
  const fixture = load('safe-tx', name);
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const cardOf = (threshold: string): Card => ({ operations: [{ template: ID, values: { threshold } }] });

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, card: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);

function mismatchAt(result: FieldCheck): string[] {
  assert.equal(result.kind, 'mismatch', JSON.stringify(result));
  return (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => `${f.callPath}.${f.arg}`);
}

type SimFixture = { safeTx: string; transactionHash: Hex; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };

async function observations(name: string): Promise<{ tx: SafeTx; simulated: Observed; receipt: Observed }> {
  const fixture: SimFixture = load('simulate', name);
  const tx = safeTx(fixture.safeTx);
  const reader = replayReader(fixture.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(fixture.parent), await header(fixture.executed)];
  const observedOf = (o: Observation): Observed => {
    assert.equal(o.kind, 'observed', o.kind === 'unverifiable' ? o.reasons.join('; ') : '');
    return (o as Extract<Observation, { kind: 'observed' }>).observed;
  };
  const simulated = await simulateSafeTx(reader, { tx, parent, time: executed.time, watch: [], ends: [] });
  const receipt = withSimulatedSafeState(await observeExecuted(reader, fixture.transactionHash, tx, []), simulated);
  return { tx, simulated: observedOf(simulated), receipt: observedOf(receipt) };
}

for (const [name, threshold] of FIXTURES) {
  const tx = safeTx(name);

  test(`${name} matches ${ID} with the card it implies`, () => {
    assert.deepEqual(check(tx, cardOf(threshold)), { kind: 'match' });
  });

  test(`${name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, cardOf(threshold)), templates, registry), { kind: 'pass', bound: 3, free: 0 });
  });

  test(`${name}: a card threshold other than the transaction's is a mismatch at _threshold`, () => {
    assert.deepEqual(mismatchAt(check(tx, cardOf(`${BigInt(threshold) + 1n}`))), ['call.changeThreshold._threshold']);
    assert.deepEqual(mismatchAt(check(tx, cardOf('1'))), ['call.changeThreshold._threshold']);
  });

  test(`${name}: the Safe's call to itself passes the floor only for a card that declares the change`, () => {
    assert.deepEqual(checkFloor(tx, floorAllowed(resolved(tx, cardOf(threshold)), templates, registry)), { kind: 'pass' });
    assert.equal(checkFloor(tx).kind, 'refused');
  });

  test(`${name}: the threshold ends at the card's and the signers stay, in the simulation and the receipt`, async () => {
    const { simulated, receipt } = await observations(name);
    const allowed = floorAllowed(resolved(tx, cardOf(threshold)), templates, registry);
    const other = floorAllowed(resolved(tx, cardOf(`${BigInt(threshold) + 1n}`)), templates, registry);
    for (const observed of [simulated, receipt]) {
      assert.deepEqual(judgeEffects(observed, resolved(tx, cardOf(threshold)), templates, registry), { kind: 'match' });
      assert.deepEqual(checkSimulatedFloor(observed, tx.safe, allowed), { kind: 'pass' });
      assert.equal(checkSimulatedFloor(observed, tx.safe, other).kind, 'refused');
      assert.equal(checkSimulatedFloor(observed, tx.safe).kind, 'refused');
    }
  });
}
