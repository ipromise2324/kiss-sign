import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import type { Reader } from '../src/chain/reader.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { resolveCard } from '../src/card.ts';
import { checkObservation } from '../src/floor/summary.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import { observeExecuted, withSimulatedSafeState } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import { readOwners } from '../src/verify/verify.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import { selectorOf } from '../src/decode/abi.ts';
import { checkFloor } from '../src/floor/floor.ts';
import type { FloorAllowed } from '../src/floor/floor.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldChain, FieldCheck, OwnersRead } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { TemplateError, loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';

/** A card that declares an owner change, which lets the four owner and threshold functions past the static floor. */
const DECLARES_CHANGE: FloorAllowed = { change: { add: '0x00000000000000000000000000000000000000aa' as Address, remove: undefined, threshold: undefined } };

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const IDS = ['safe/add-owner', 'safe/remove-owner', 'safe/swap-owner', 'safe/change-threshold', 'eth/transfer'] as const;
const templates = new Map<string, Template>(IDS.map((id) => [id, loadTemplate(ROOT, id, registry)]));
const SAFE = '0x1111111111111111111111111111111111111111' as Address;
const ALICE = '0x2222222222222222222222222222222222222222' as Address;
const BOB = '0x3333333333333333333333333333333333333333' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const book = new Map<string, Address>([
  ['alice', ALICE],
  ['bob', BOB],
]);
const resolve = (card: Card) => resolveCard(card, { templates, registry, addressBook: book, safe: SAFE });
const refusal = (card: Card) => {
  const result = resolve(card);
  return result.kind === 'refused' ? `${result.reason} ${result.at}` : 'resolved';
};

test('an owner is an address-book name, never the Safe or a registry contract, and a threshold a whole number from 1', () => {
  const add = (values: Record<string, string>): Card => ({ operations: [{ template: 'safe/add-owner', values }] });
  assert.equal(refusal(add({ owner: 'alice', threshold: '2' })), 'resolved');
  assert.equal(refusal(add({ owner: 'safe', threshold: '2' })), 'unknown-name operations[0].values.owner');
  assert.equal(refusal(add({ owner: 'usdc', threshold: '2' })), 'unknown-name operations[0].values.owner');
  assert.equal(refusal(add({ owner: 'alice', threshold: '0' })), 'not-a-threshold operations[0].values.threshold');
  assert.equal(refusal(add({ owner: 'alice', threshold: '1.5' })), 'not-a-threshold operations[0].values.threshold');
});

test("a card changes the Safe's owners or threshold in one operation at most", () => {
  const card: Card = {
    operations: [
      { template: 'safe/add-owner', values: { owner: 'alice', threshold: '2' } },
      { template: 'safe/change-threshold', values: { threshold: '3' } },
    ],
  };
  assert.equal(refusal(card), 'two-settings-changes operations[1]');
  const withTransfer: Card = { operations: [{ template: 'eth/transfer', values: { recipient: 'bob', amount: '1' } }, card.operations[0]!] };
  assert.equal(refusal(withTransfer), 'resolved');
});

test('template load refuses a prevOwner bound to anything but an owner field, and a settings change that names no owner field', () => {
  const base = JSON.parse(JSON.stringify({
    id: 'safe/x',
    card: { owner: { kind: 'owner' }, threshold: { kind: 'threshold' }, other: { kind: 'recipient' } },
    calls: [{ to: { safe: true }, value: { const: '0' }, function: 'removeOwner(address prevOwner, address owner, uint256 _threshold)', args: { prevOwner: { ownerBefore: 'card.owner' }, owner: { card: 'owner' }, _threshold: { card: 'threshold' } } }],
    effects: { gives: [], gets: [], safe: { owners: { remove: 'card.owner' }, threshold: 'card.threshold' } },
  }));
  assert.doesNotThrow(() => parseTemplate(base, registry));
  const broken = (edit: (t: typeof base) => void): string => {
    const copy = JSON.parse(JSON.stringify(base));
    edit(copy);
    try {
      parseTemplate(copy, registry);
      return 'parsed';
    } catch (error) {
      assert.ok(error instanceof TemplateError);
      return error.message;
    }
  };
  assert.equal(broken((t) => (t.calls[0].args.prevOwner = { ownerBefore: 'card.other' })), 'calls[0].args.prevOwner.ownerBefore: must be card.<owner field>');
  assert.equal(broken((t) => (t.calls[0].args._threshold = { ownerBefore: 'card.owner' })), 'calls[0].args._threshold: a ownerBefore rule cannot bind a uint256');
  assert.equal(broken((t) => (t.effects.safe.owners = { add: 'card.other' })), 'effects.safe.owners.add: must be card.<owner field>');
  assert.equal(broken((t) => (t.effects.safe.threshold = 'card.owner')), 'effects.safe.threshold: must be card.<threshold field>');
  assert.equal(broken((t) => (t.effects.safe = {})), 'effects.safe: declares no change');
  assert.equal(broken((t) => (t.effects.safe.owners = { add: 'card.owner', remove: 'card.owner' })), 'effects.safe.owners: adds and removes one card field');
});

const word = (value: bigint | Address): string => BigInt(value).toString(16).padStart(64, '0');
const call = (signature: string, ...args: (bigint | Address)[]): Hex => `${selectorOf(signature)}${args.map(word).join('')}` as Hex;
const selfCall = (data: Hex, operation: 0 | 1 = 0, to: Address = SAFE): SafeTx => ({
  chainId: 1n,
  safe: SAFE,
  version: '1.4.1',
  to,
  value: 0n,
  data,
  operation,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: ZERO,
  refundReceiver: ZERO,
  nonce: 7n,
});

test('no shipped template matches a module, guard, fallback handler or singleton change, and the static floor refuses each', () => {
  const cards: Card[] = [
    { operations: [{ template: 'safe/add-owner', values: { owner: 'alice', threshold: '1' } }] },
    { operations: [{ template: 'safe/remove-owner', values: { owner: 'alice', threshold: '1' } }] },
    { operations: [{ template: 'safe/swap-owner', values: { 'old-owner': 'alice', 'new-owner': 'bob' } }] },
    { operations: [{ template: 'safe/change-threshold', values: { threshold: '1' } }] },
    { operations: [{ template: 'eth/transfer', values: { recipient: 'safe', amount: '0' } }] },
  ];
  const attacks: [string, SafeTx][] = [
    ['enableModule', selfCall(call('enableModule(address)', ALICE))],
    ['setGuard', selfCall(call('setGuard(address)', ALICE))],
    ['setFallbackHandler', selfCall(call('setFallbackHandler(address)', ALICE))],
    ['delegatecall that rewrites the singleton, as at Bybit', selfCall(call('transfer(address,uint256)', ALICE, 0n), 1, BOB)],
  ];
  const owners: OwnersRead = { kind: 'read', owners: [ALICE, BOB] };
  for (const [name, tx] of attacks) {
    assert.equal(checkFloor(tx, DECLARES_CHANGE).kind, 'refused', name);
    for (const card of cards) {
      const resolved = resolve(card);
      assert.equal(resolved.kind, 'resolved');
      const fields = checkTemplateFields(tx, (resolved as Extract<typeof resolved, { kind: 'resolved' }>).card, templates, registry, [], { owners });
      assert.equal(fields.kind, 'mismatch', `${name} against ${card.operations[0]!.template}`);
    }
  }
});

test('prevOwner must be the owner listed before the card owner, or the sentinel for the first; anything else is caught', () => {
  const CAROL = '0x4444444444444444444444444444444444444444' as Address;
  const SENTINEL = '0x0000000000000000000000000000000000000001' as Address;
  const owners: OwnersRead = { kind: 'read', owners: [ALICE, BOB, CAROL] };
  const card = (owner: string): ResolvedCard => {
    const resolved = resolve({ operations: [{ template: 'safe/remove-owner', values: { owner, threshold: '1' } }] });
    assert.equal(resolved.kind, 'resolved');
    return (resolved as Extract<typeof resolved, { kind: 'resolved' }>).card;
  };
  const remove = (prev: Address, owner: Address): SafeTx => selfCall(call('removeOwner(address,address,uint256)', prev, owner, 1n));
  const fields = (tx: SafeTx, c: ResolvedCard, chain: FieldChain = { owners }) => checkTemplateFields(tx, c, templates, registry, [], chain);
  assert.deepEqual(fields(remove(SENTINEL, ALICE), card('alice')), { kind: 'match' });
  assert.deepEqual(fields(remove(ALICE, BOB), card('bob')), { kind: 'match' });
  const wrong = fields(remove(SENTINEL, BOB), card('bob'));
  assert.equal(wrong.kind, 'mismatch');
  assert.deepEqual((wrong as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => [f.arg, f.expected, f.actual]), [['prevOwner', ALICE, SENTINEL]]);
  const stranger = fields(remove(BOB, CAROL), card('bob'), { owners: { kind: 'read', owners: [ALICE, CAROL] } });
  assert.equal(stranger.kind, 'mismatch');
  assert.match((stranger as Extract<FieldCheck, { kind: 'mismatch' }>).findings[0]!.expected, /who is not an owner of the Safe$/);
  assert.deepEqual(fields(remove(ALICE, BOB), card('bob'), { owners: { kind: 'unread', why: 'the providers disagree' } }), {
    kind: 'unverifiable',
    reasons: ["the Safe's owners: the providers disagree"],
  });
  assert.deepEqual(fields(remove(ALICE, BOB), card('bob'), {}), { kind: 'unverifiable', reasons: ["the Safe's owners: not read"] });
  assert.deepEqual(checkMutations(remove(ALICE, BOB), card('bob'), templates, registry, [], { owners }), { kind: 'pass', bound: 5, free: 0 });
});

type Recorded = { executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; transactionHash: Hex; exchanges: Exchange[] };
type FixtureCase = { readonly name: string; readonly values: Record<string, string>; readonly book: Record<string, Address> };

const FIXTURES: readonly (FixtureCase & { readonly template: string })[] = [
  { name: 'safe-add-owner-1-3-0', template: 'safe/add-owner', values: { owner: 'new', threshold: '2' }, book: { new: '0xb1df01604095536cea66a9d06e67ed6f00684e58' as Address } },
  { name: 'safe-add-owner-raise-threshold', template: 'safe/add-owner', values: { owner: 'new', threshold: '2' }, book: { new: '0x383965940c950008a4b67bfaa477fdf6ac91a7f7' as Address } },
  { name: 'safe-remove-owner-1-3-0', template: 'safe/remove-owner', values: { owner: 'old', threshold: '1' }, book: { old: '0xa6003fc149b2e2f92f1430428fe4644736a99742' as Address } },
  { name: 'safe-remove-owner-first', template: 'safe/remove-owner', values: { owner: 'old', threshold: '2' }, book: { old: '0x4057bea8a5e2710ea78b7656045f3e6ec90f54f2' as Address } },
  {
    name: 'safe-swap-owner-1-3-0',
    template: 'safe/swap-owner',
    values: { 'old-owner': 'old', 'new-owner': 'new' },
    book: { old: '0x889e7efaefded3c8a4acf303d8a2a19698352a34' as Address, new: '0x734ca48be1161a038a40051402be05e88eaf0589' as Address },
  },
  {
    name: 'safe-swap-owner-first',
    template: 'safe/swap-owner',
    values: { 'old-owner': 'old', 'new-owner': 'new' },
    book: { old: '0xe759d1ab235d44ae86e7029af07fb444acc61d1c' as Address, new: '0xd97a2244f2c697f7361141dd91698a01ebe485e6' as Address },
  },
  { name: 'safe-change-threshold-lower', template: 'safe/change-threshold', values: { threshold: '1' }, book: {} },
  { name: 'safe-change-threshold-raise', template: 'safe/change-threshold', values: { threshold: '2' }, book: {} },
];

const json = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));

function fixtureOf(c: (typeof FIXTURES)[number]) {
  const recorded: Recorded = json('simulate', c.name);
  const safeTx = json('safe-tx', c.name);
  const tx = parseServiceTx(safeTx.service, { chainId: 1n, version: safeTx.chain.version });
  const cardFor = (values: Record<string, string>, book: Record<string, Address> = c.book): ResolvedCard => {
    const result = resolveCard({ operations: [{ template: c.template, values }] }, { templates, registry, addressBook: new Map(Object.entries(book)), safe: tx.safe });
    assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
    return (result as Extract<typeof result, { kind: 'resolved' }>).card;
  };
  const reader = () => replayReader(recorded.exchanges);
  const blocks = async (r: Reader) => {
    const header = async (at: { number: string; hash: Hex }) => {
      const read = await r.header({ number: BigInt(at.number), hash: at.hash });
      assert.equal(read.kind, 'agreed');
      return (read as Extract<typeof read, { kind: 'agreed' }>).value;
    };
    return { parent: await header(recorded.parent), executed: await header(recorded.executed) };
  };
  return { recorded, tx, cardFor, reader, blocks };
}

for (const c of FIXTURES) {
  test(`${c.name}: another Safe's executed ${c.template} matches its card, field by field, by simulation and by receipt`, async () => {
    const { recorded, tx, cardFor, reader, blocks } = fixtureOf(c);
    const card = cardFor(c.values);
    const r = reader();
    const { parent, executed } = await blocks(r);
    const owners = await readOwners(r, tx.safe, parent);
    assert.equal(owners.kind, 'read');
    assert.equal(checkFloor(tx, DECLARES_CHANGE).kind, 'pass');
    assert.deepEqual(checkTemplateFields(tx, card, templates, registry, [], { owners }), { kind: 'match' });
    const mutations = checkMutations(tx, card, templates, registry, [], { owners });
    assert.equal(mutations.kind, 'pass');
    const simulated = await simulateSafeTx(r, { tx, parent, time: executed.time, watch: [], ends: [] });
    const simChecks = checkObservation(simulated, tx.safe, card, templates, registry);
    assert.deepEqual(simChecks.kind === 'observed' ? [simChecks.effects.kind, simChecks.floor] : simChecks, ['match', { kind: 'pass' }]);
    const byReceipt = withSimulatedSafeState(await observeExecuted(r, recorded.transactionHash, tx, []), simulated);
    const receiptChecks = checkObservation(byReceipt, tx.safe, card, templates, registry);
    assert.deepEqual(receiptChecks.kind === 'observed' ? [receiptChecks.effects.kind, receiptChecks.floor] : receiptChecks, ['match', { kind: 'pass' }]);
  });
}

test('the same executed transactions give MISMATCH for a card naming another owner or another threshold', async () => {
  const OTHER = '0x5555555555555555555555555555555555555555' as Address;
  for (const c of FIXTURES) {
    const { tx, cardFor, reader, blocks } = fixtureOf(c);
    const r = reader();
    const { parent, executed } = await blocks(r);
    const owners = await readOwners(r, tx.safe, parent);
    const changedBook = Object.fromEntries(Object.entries(c.book).map(([name], i) => [name, i === Object.keys(c.book).length - 1 ? OTHER : c.book[name] as Address]));
    const changedValues = c.template === 'safe/change-threshold' ? { threshold: c.values.threshold === '1' ? '2' : '1' } : c.values;
    const card = cardFor(changedValues, changedBook);
    const fields = checkTemplateFields(tx, card, templates, registry, [], { owners });
    assert.equal(fields.kind, 'mismatch', c.name);
    const simulated = await simulateSafeTx(r, { tx, parent, time: executed.time, watch: [], ends: [] });
    const checks = checkObservation(simulated, tx.safe, card, templates, registry);
    assert.equal(checks.kind === 'observed' ? checks.floor.kind : checks.kind, 'refused', c.name);
  }
});
