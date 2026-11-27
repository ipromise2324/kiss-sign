import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { uintWord } from '../src/decode/codec.ts';
import { unwrapSafeTx } from '../src/decode/multisend.ts';
import type { Unwrapped } from '../src/decode/multisend.ts';
import { loadRegistry } from '../src/registry.ts';
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
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const registry = loadRegistry(ROOT);
const templates = new Map<string, Template>([['compound/supply', loadTemplate(ROOT, 'compound/supply', registry)]]);
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const FIXTURES = ['compound-supply-usdc-base', 'compound-supply-usdc-again', 'compound-supply-usdc-other-safe-base'];
const addressOf = (name: string): Address => registry.entries.get(name)!.address;
const load = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));

function safeTx(name: string): SafeTx {
  const fixture = load('safe-tx', name);
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

/** Where the arguments of each MultiSend entry's call start in `data`. */
function argsAt(tx: SafeTx): readonly number[] {
  const unwrapped = unwrapSafeTx(tx) as Extract<Unwrapped, { kind: 'multisend' }>;
  return unwrapped.calls.map((call) => call.data.start + 4);
}

const wordAt = (tx: SafeTx, at: number): bigint => BigInt(`0x${tx.data.slice(2 + at * 2, 2 + (at + 32) * 2)}`);
const supplied = (tx: SafeTx): bigint => wordAt(tx, argsAt(tx)[1]! + 32);

function changed(tx: SafeTx, at: number, bytes: Uint8Array): SafeTx {
  const data = hexToBytes(tx.data.slice(2));
  data.set(bytes, at);
  return { ...tx, data: `0x${bytesToHex(data)}` as Hex };
}

const impliedCard = (tx: SafeTx, amount: bigint = supplied(tx)): Card => ({
  operations: [{ template: 'compound/supply', values: { market: 'compound-v3-cusdcv3', amount: `${amount}` } }],
});

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const check = (tx: SafeTx, card: Card = impliedCard(tx)): FieldCheck => checkTemplateFields(tx, resolved(tx, card), templates, registry);

function mismatchAt(result: FieldCheck): string[] {
  assert.equal(result.kind, 'mismatch', JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v)));
  return (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => `${f.callPath}.${f.arg}`);
}

for (const name of FIXTURES) {
  const tx = safeTx(name);

  test(`${name} matches compound/supply with the card it implies`, () => {
    assert.equal(wordAt(tx, argsAt(tx)[0]! + 32), supplied(tx), 'the batch approves exactly the amount it supplies');
    assert.deepEqual(check(tx), { kind: 'match' });
  });

  test(`${name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, impliedCard(tx)), templates, registry), { kind: 'pass', bound: 8, free: 0 });
  });

  test(`${name}: another spender, a larger approval or another supplied token is a mismatch at that argument`, () => {
    const [approve, supply] = argsAt(tx);
    assert.deepEqual(mismatchAt(check(changed(tx, approve! + 12, hexToBytes(OTHER.slice(2))))), ['multiSend[0].approve.spender']);
    assert.deepEqual(mismatchAt(check(changed(tx, approve! + 32, uintWord(supplied(tx) + 1n)))),['multiSend[0].approve.value']);
    assert.deepEqual(mismatchAt(check(changed(tx, supply! + 12, hexToBytes(OTHER.slice(2))))), ['multiSend[1].supply.asset']);
  });
}

test('a card amount other than the batch states mismatches at the approval and the supply', () => {
  const tx = safeTx('compound-supply-usdc-base');
  assert.deepEqual(mismatchAt(check(tx, impliedCard(tx, supplied(tx) - 1n))), ['multiSend[0].approve.value', 'multiSend[1].supply.amount']);
});

test('a supply card naming a vault of another protocol is refused before any check', () => {
  const tx = safeTx('compound-supply-usdc-base');
  const result = resolveCard({ operations: [{ template: 'compound/supply', values: { market: 'fluid-fusdc', amount: '1' } }] }, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind === 'refused' ? result.reason : result.kind, 'wrong-protocol');
});

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
  const expected = expectedChanges(resolved(tx, impliedCard(tx)), templates, registry);
  assert.equal(expected.kind, 'expected');
  const watch = [...(expected as Extract<typeof expected, { kind: 'expected' }>).changes.keys()].filter((asset): asset is Address => asset !== 'eth');
  return {
    tx,
    simulated: observedOf(await simulateSafeTx(reader, { tx, parent, time: executed.time, watch, ends: [] })),
    receipt: observedOf(await observeExecuted(reader, fixture.transactionHash, tx, [])),
  };
}

const executedOf = (observed: Observed) => observed as Extract<Observed, { kind: 'executed' }>;
const judge = (tx: SafeTx, observed: Observed, card: Card = impliedCard(tx)): EffectVerdict => judgeEffects(observed, resolved(tx, card), templates, registry);

test('a supply gives exactly the card amount of USDC, gets cUSDCv3 within 2 units of it, and spends its exact approval', async () => {
  const { tx, simulated, receipt } = await observations('compound-supply-usdc-base');
  for (const observed of [simulated, receipt]) {
    const { tokens, allowances } = executedOf(observed);
    assert.equal(tokens.get(addressOf('usdc')), -supplied(tx));
    assert.equal(tokens.get(addressOf('compound-v3-cusdcv3')), supplied(tx) - 1n);
    assert.deepEqual(allowances, [{ token: addressOf('usdc'), spender: addressOf('compound-v3-cusdcv3'), before: 0n, after: 0n }]);
    assert.deepEqual(judge(tx, observed), { kind: 'match' });
  }
  const short = (by: bigint): Observed => ({ ...executedOf(receipt), tokens: new Map([...executedOf(receipt).tokens, [addressOf('compound-v3-cusdcv3'), supplied(tx) - by]]) });
  assert.deepEqual(judge(tx, short(2n)), { kind: 'match' });
  assert.equal(judge(tx, short(3n)).kind, 'mismatch');
  assert.equal(judge(tx, receipt, impliedCard(tx, supplied(tx) + 1n)).kind, 'mismatch');
});

test('an approval the supply leaves open is a mismatch', async () => {
  const { tx, receipt } = await observations('compound-supply-usdc-base');
  const open = { token: addressOf('usdc'), spender: addressOf('compound-v3-cusdcv3'), before: 0n, after: 1n };
  assert.deepEqual(judge(tx, { ...executedOf(receipt), allowances: [open] }), { kind: 'mismatch', findings: [{ kind: 'open-allowance', ...open }] });
});
