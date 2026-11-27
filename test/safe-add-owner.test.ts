import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { readRecording } from '../src/chain/bytecode.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { checkSimulatedFloor } from '../src/floor/simulated.ts';
import { floorAllowed } from '../src/floor/summary.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { judgeEffects } from '../src/simulate/effects.ts';
import { observeExecuted, withSimulatedSafeState } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const ID = 'safe/add-owner';
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>([[ID, loadTemplate(ROOT, ID, registry)]]);
const load = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));
const OTHER = '0x1111111111111111111111111111111111111111' as Address;

type Case = { readonly name: string; readonly owner: Address; readonly threshold: string };

/** Each card and book as `pnpm template implied-card safe/add-owner <fixture>` prints them. */
const CASES: readonly Case[] = [
  { name: 'safe-add-owner-nonce-0', owner: '0xa75bbd73b5ee18f71ff6d1c452c3dde222feb987' as Address, threshold: '1' },
  { name: 'safe-add-owner-to-3', owner: '0xd9dbf731b79ff7b021361bbce425e23fce85d31a' as Address, threshold: '3' },
  { name: 'safe-add-owner-v1-3-0', owner: '0x0bb66e05e216b62800b0ed01ee77f753c35af0e1' as Address, threshold: '3' },
  { name: 'safe-add-owner-multisend', owner: '0xb863ff2f29127fd032112b6b3f178b83f84a9f91' as Address, threshold: '1' },
];

function safeTx(name: string): SafeTx {
  const fixture = load('safe-tx', name);
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

const card = (threshold: string): Card => ({ operations: [{ template: ID, values: { owner: 'owner', threshold } }] });

function resolved(tx: SafeTx, c: Card, owner: Address): ResolvedCard {
  const result = resolveCard(c, { templates, registry, addressBook: new Map([['owner', owner]]), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

type SimFixture = { transactionHash: Hex; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };

async function observations(name: string, tx: SafeTx): Promise<{ simulated: Observation; receipt: Observation }> {
  const sim: SimFixture = load('simulate', name);
  const reader = replayReader(sim.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(sim.parent), await header(sim.executed)];
  const simulated = await simulateSafeTx(reader, { tx, parent, time: executed.time, watch: [], ends: [] });
  const receipt = withSimulatedSafeState(await observeExecuted(reader, sim.transactionHash, tx, []), simulated);
  return { simulated, receipt };
}

/** The effects' verdict and the floor's, which holds the Safe's owners and threshold to the card. */
function judged(observation: Observation, tx: SafeTx, resolvedCard: ResolvedCard): [string, string] {
  assert.equal(observation.kind, 'observed', observation.kind === 'unverifiable' ? observation.reasons.join('; ') : '');
  const observed = (observation as Extract<Observation, { kind: 'observed' }>).observed;
  return [
    judgeEffects(observed, resolvedCard, templates, registry).kind,
    checkSimulatedFloor(observed, tx.safe, floorAllowed(resolvedCard, templates, registry)).kind,
  ];
}

for (const c of CASES) {
  const tx = safeTx(c.name);

  test(`${c.name}: another Safe's executed safe/add-owner gives MATCH with the card it implies, by its fields, by simulation and by receipt`, async () => {
    const own = resolved(tx, card(c.threshold), c.owner);
    assert.deepEqual(checkTemplateFields(tx, own, templates, registry), { kind: 'match' });
    const { simulated, receipt } = await observations(c.name, tx);
    assert.deepEqual(judged(simulated, tx, own), ['match', 'pass']);
    assert.deepEqual(judged(receipt, tx, own), ['match', 'pass']);
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    const result = checkMutations(tx, resolved(tx, card(c.threshold), c.owner), templates, registry);
    assert.equal(result.kind, 'pass', JSON.stringify(result));
    assert.equal((result as Extract<typeof result, { kind: 'pass' }>).free, 0);
  });

  test(`${c.name}: a card naming another owner or another threshold is a mismatch by its fields and refused by the floor, by simulation and by receipt`, async () => {
    const otherOwner = resolved(tx, card(c.threshold), OTHER);
    const otherThreshold = resolved(tx, card(`${BigInt(c.threshold) + 1n}`), c.owner);
    for (const wrong of [otherOwner, otherThreshold]) {
      assert.equal(checkTemplateFields(tx, wrong, templates, registry).kind, 'mismatch');
    }
    const { simulated, receipt } = await observations(c.name, tx);
    for (const wrong of [otherOwner, otherThreshold]) {
      assert.deepEqual(judged(simulated, tx, wrong), ['match', 'refused']);
      assert.deepEqual(judged(receipt, tx, wrong), ['match', 'refused']);
    }
  });
}
