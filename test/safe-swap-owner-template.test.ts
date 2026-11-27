import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { judgeEffects } from '../src/simulate/effects.ts';
import type { Observed } from '../src/simulate/effects.ts';
import { observeExecuted, withSimulatedSafeState } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { checkSimulatedFloor } from '../src/floor/simulated.ts';
import { floorAllowed } from '../src/floor/summary.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldChain, FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const ID = 'safe/swap-owner';
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>([[ID, loadTemplate(ROOT, ID, registry)]]);
const SENTINEL = '0x0000000000000000000000000000000000000001';
const OTHER = '0x1111111111111111111111111111111111111111' as Address;

/** Each test transaction of another Safe, with the address book its implied card names (pnpm template implied-card). */
const FIXTURES: Record<string, { readonly old: Address; readonly new: Address; readonly firstSigner: boolean }> = {
  'safe-swap-owner-v141': { old: '0xb3ce78b8d976137ada61221a5d5d9bb34ad8db52' as Address, new: '0xe42086c168a83fb94e707c9ae4157ab303998715' as Address, firstSigner: false },
  'safe-swap-owner-v130': { old: '0x07f854f87ddf58414b5d65ddcabba23ba0b7c705' as Address, new: '0x5301e02df22ee5fb3f262439592e38431ec50b22' as Address, firstSigner: false },
  'safe-swap-owner-first-signer': { old: '0xd12f7c525057b69a5b2c8c52a5580a3a9282eb52' as Address, new: '0x3ef5a8755376ef4c89405649d73e2597299b6e0b' as Address, firstSigner: true },
};

const CARD: Card = { operations: [{ template: ID, values: { 'old-owner': 'old-owner', 'new-owner': 'new-owner' } }] };
const load = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));

function safeTx(name: string): SafeTx {
  const fixture = load('safe-tx', name);
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

function resolved(tx: SafeTx, book: { readonly old: Address; readonly new: Address }): ResolvedCard {
  const addressBook = new Map<string, Address>([['old-owner', book.old], ['new-owner', book.new]]);
  const result = resolveCard(CARD, { templates, registry, addressBook, safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? `${result.reason}: ${result.detail}` : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

type SimFixture = { safeTx: string; transactionHash: Hex; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };
type Executed = Extract<Observed, { kind: 'executed' }>;

async function observations(name: string): Promise<{ tx: SafeTx; simulated: Executed; receipt: Executed }> {
  const fixture: SimFixture = load('simulate', name);
  const tx = safeTx(fixture.safeTx);
  const reader = replayReader(fixture.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(fixture.parent), await header(fixture.executed)];
  const observedOf = (o: Observation): Executed => {
    assert.equal(o.kind, 'observed', o.kind === 'unverifiable' ? o.reasons.join('; ') : '');
    const observed = (o as Extract<Observation, { kind: 'observed' }>).observed;
    assert.equal(observed.kind, 'executed');
    return observed as Executed;
  };
  const simulated = await simulateSafeTx(reader, { tx, parent, time: executed.time, watch: [], ends: [] });
  const receipt = withSimulatedSafeState(await observeExecuted(reader, fixture.transactionHash, tx, []), simulated);
  return { tx, simulated: observedOf(simulated), receipt: observedOf(receipt) };
}

/** The owner list the Safe held just before the transaction, as the simulation read it. */
function ownersBefore(observed: Executed): readonly Address[] {
  assert.equal(observed.safeState.kind, 'read');
  return (observed.safeState as Extract<Executed['safeState'], { kind: 'read' }>).before.owners;
}

const floor = (tx: SafeTx, observed: Observed, card: ResolvedCard) => checkSimulatedFloor(observed, tx.safe, floorAllowed(card, templates, registry));

const chainOf = (owners: readonly Address[]): FieldChain => ({ owners: { kind: 'read', owners } });

function mismatchAt(result: FieldCheck): string[] {
  assert.equal(result.kind, 'mismatch', JSON.stringify(result));
  return (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => `${f.callPath}.${f.arg}`);
}

for (const [name, book] of Object.entries(FIXTURES)) {
  test(`${name}: another Safe's executed safe/swap-owner matches its card, field by field, by simulation and by receipt`, async () => {
    const { tx, simulated, receipt } = await observations(name);
    const owners = ownersBefore(simulated);
    const at = owners.findIndex((owner) => owner.toLowerCase() === book.old);
    assert.ok(at >= 0, 'the old owner was an owner before the transaction');
    assert.equal(at === 0, book.firstSigner, 'prevOwner is the sentinel exactly when the old owner is first');
    const card = resolved(tx, book);
    assert.deepEqual(checkTemplateFields(tx, card, templates, registry, [], chainOf(owners)), { kind: 'match' });
    for (const observed of [simulated, receipt]) {
      assert.deepEqual(judgeEffects(observed, card, templates, registry), { kind: 'match' });
      assert.deepEqual(floor(tx, observed, card), { kind: 'pass' });
    }
  });

  test(`${name}: every bound field, changed alone, gives a mismatch`, async () => {
    const { tx, simulated } = await observations(name);
    assert.deepEqual(checkMutations(tx, resolved(tx, book), templates, registry, [], chainOf(ownersBefore(simulated))), { kind: 'pass', bound: 5, free: 0 });
  });

  test(`${name}: a card naming another old or new owner is a mismatch at that argument, and unread owners are unverifiable`, async () => {
    const { tx, simulated } = await observations(name);
    const owners = ownersBefore(simulated);
    assert.deepEqual(mismatchAt(checkTemplateFields(tx, resolved(tx, { ...book, new: OTHER }), templates, registry, [], chainOf(owners))), ['call.swapOwner.newOwner']);
    for (const other of [...owners.filter((owner) => owner.toLowerCase() !== book.old), OTHER]) {
      const findings = mismatchAt(checkTemplateFields(tx, resolved(tx, { ...book, old: other }), templates, registry, [], chainOf(owners)));
      assert.ok(findings.includes('call.swapOwner.oldOwner'), findings.join(', '));
    }
    assert.equal(checkTemplateFields(tx, resolved(tx, book), templates, registry).kind, 'unverifiable');
  });

  test(`${name}: the Safe's settings refuse a card naming another new owner, and a changed threshold`, async () => {
    const { tx, simulated, receipt } = await observations(name);
    for (const observed of [simulated, receipt]) assert.equal(floor(tx, observed, resolved(tx, { ...book, new: OTHER })).kind, 'refused');
    const state = simulated.safeState as Extract<Executed['safeState'], { kind: 'read' }>;
    const raised: Executed = { ...simulated, safeState: { ...state, after: { ...state.after, threshold: state.after.threshold + 1n } } };
    assert.equal(floor(tx, raised, resolved(tx, book)).kind, 'refused');
  });
}

test('the sentinel is the expected prevOwner when the replaced owner is first', async () => {
  const { tx, simulated } = await observations('safe-swap-owner-first-signer');
  assert.equal(ownersBefore(simulated)[0]!.toLowerCase(), FIXTURES['safe-swap-owner-first-signer']!.old);
  assert.equal(`0x${tx.data.slice(2 + 8 + 24, 2 + 8 + 64)}`, SENTINEL);
});
