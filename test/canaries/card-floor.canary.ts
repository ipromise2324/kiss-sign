import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCard } from '../../src/card.ts';
import type { Card } from '../../src/card.ts';
import { selectorOf } from '../../src/decode/abi.ts';
import { encodeCall, uintWord } from '../../src/decode/codec.ts';
import { MULTISEND } from '../../src/decode/multisend.ts';
import { PERMIT2_MAX, checkFloor } from '../../src/floor/floor.ts';
import type { FloorAllowed, FloorResult } from '../../src/floor/floor.ts';
import { checkSimulatedFloor } from '../../src/floor/simulated.ts';
import { floorAllowed } from '../../src/floor/summary.ts';
import { loadRegistry } from '../../src/registry.ts';
import type { Address, Hex, SafeTx } from '../../src/safe/types.ts';
import type { Observed } from '../../src/simulate/effects.ts';
import { topic, wordOf } from '../../src/simulate/events.ts';
import type { SafeState } from '../../src/simulate/safe-state.ts';
import { loadTemplate } from '../../src/template/template.ts';
import { repoWithTestFixtures } from '../repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const registry = loadRegistry(ROOT);
const IDS = ['safe/add-owner', 'eth/transfer', 'uniswap/approve-permit2', 'uniswap/swap'];
const templates = new Map(IDS.map((id) => [id, loadTemplate(ROOT, id, registry)]));

const SAFE = '0x1111111111111111111111111111111111111111' as Address;
const ALICE = '0x2222222222222222222222222222222222222222' as Address;
const BOB = '0x3333333333333333333333333333333333333333' as Address;
const OTHER = '0x4444444444444444444444444444444444444444' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address;
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7' as Address;
const tokenField = templates.get('uniswap/approve-permit2')?.card.get('token');
const APPROVED_NAME = (tokenField?.kind === 'contract' ? tokenField.scope.names?.[0] : undefined) ?? assert.fail('uniswap/approve-permit2 lists a token');
const APPROVED = registry.entries.get(APPROVED_NAME)?.address ?? assert.fail(`${APPROVED_NAME} is in the registry`);
const UNAPPROVED = APPROVED === USDC ? USDT : USDC;
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as Address;
const MAX = (1n << 256n) - 1n;

const allowedBy = (card: Card): FloorAllowed => {
  const result = resolveCard(card, { templates, registry, addressBook: new Map([['alice', ALICE], ['bob', BOB]]), safe: SAFE });
  assert.equal(result.kind, 'resolved', JSON.stringify(result));
  return floorAllowed((result as Extract<typeof result, { kind: 'resolved' }>).card, templates, registry);
};

const addOwnerAndApprove: Card = {
  operations: [
    { template: 'safe/add-owner', values: { owner: 'alice', threshold: '2' } },
    { template: 'uniswap/approve-permit2', values: { token: APPROVED_NAME } },
  ],
};
const approveAndSwap: Card = {
  operations: [
    { template: 'uniswap/approve-permit2', values: { token: APPROVED_NAME } },
    { template: 'uniswap/swap', values: { 'sell-token': 'usdc', 'buy-token': 'usdt', 'sell-amount': '1000000', 'min-buy': '990000' } },
  ],
};
const transferOnly: Card = { operations: [{ template: 'eth/transfer', values: { recipient: 'bob', amount: '1' } }] };

const word = (value: bigint | Address): Uint8Array => uintWord(BigInt(value));
const calldata = (signature: string, ...args: (bigint | Address)[]): Uint8Array =>
  concatBytes(hexToBytes(selectorOf(signature).slice(2)), ...args.map(word));
const BASE: SafeTx = {
  chainId: 1n,
  safe: SAFE,
  version: '1.4.1',
  to: SAFE,
  value: 0n,
  data: '0x' as Hex,
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: ZERO,
  refundReceiver: ZERO,
  nonce: 7n,
};
type Entry = { readonly to: Address; readonly data: Uint8Array };
const packed = ({ to, data }: Entry): Uint8Array => concatBytes(Uint8Array.of(0), hexToBytes(to.slice(2)), word(0n), word(BigInt(data.length)), data);
const multiSend = (...entries: Entry[]): SafeTx => {
  const [official] = [...registry.entries.values()].filter((e) => e.kind === 'multisend' && e.name.includes('call-only'));
  assert.ok(official !== undefined);
  const data = encodeCall({ fn: MULTISEND, args: [{ kind: 'bytes', value: concatBytes(...entries.map(packed)), span: [0, 0] }], trailer: undefined });
  return { ...BASE, to: official.address, operation: 1, data: `0x${bytesToHex(data)}` as Hex };
};

const addAlice: Entry = { to: SAFE, data: calldata('addOwnerWithThreshold(address,uint256)', ALICE, 2n) };
const enableModule: Entry = { to: SAFE, data: calldata('enableModule(address)', OTHER) };
const approve = (token: Address, spender: Address): Entry => ({ to: token, data: calldata('approve(address,uint256)', spender, MAX) });

const rules = (result: FloorResult): string[] => (result.kind === 'pass' ? [] : result.findings.map((f) => `${f.rule} ${f.callPath}`));

const STATE: SafeState = {
  singleton: wordOf('0x41675c099f32341bf84bfc5382af534df5c7461a' as Address),
  threshold: 1n,
  owners: [BOB],
  modules: [],
  guard: wordOf(ZERO),
  moduleGuard: undefined,
  fallbackHandler: wordOf(ZERO),
};
type Executed = Extract<Observed, { kind: 'executed' }>;
const executed = (safeState: Executed['safeState'], allowances: Executed['allowances'] = [], permit2: Executed['permit2'] = []): Observed => ({
  kind: 'executed',
  eth: 0n,
  tokens: new Map(),
  allowances,
  permit2,
  ends: new Map(),
  safeState,
});
const observed = (after: Partial<SafeState>, allowances: Executed['allowances'] = [], permit2: Executed['permit2'] = []): Observed =>
  executed({ kind: 'read', before: STATE, after: { ...STATE, ...after } }, allowances, permit2);
const ALICE_ADDED = { owners: [ALICE, BOB], threshold: 2n };

test('a card that adds an owner and approves Permit2 passes both floors only for that owner and that approval', () => {
  const allowed = allowedBy(addOwnerAndApprove);
  assert.deepEqual(checkFloor(multiSend(addAlice, approve(APPROVED, PERMIT2)), allowed), { kind: 'pass' });
  assert.deepEqual(rules(checkFloor(multiSend(addAlice, approve(APPROVED, OTHER)), allowed)), ['unlimited-approval multiSend[1]']);
  assert.deepEqual(rules(checkFloor(multiSend(addAlice, approve(UNAPPROVED, PERMIT2)), allowed)), ['unlimited-approval multiSend[1]']);
  assert.deepEqual(rules(checkFloor(multiSend(addAlice, approve(APPROVED, PERMIT2), enableModule), allowed)), ['self-call multiSend[2]']);

  const kept = { token: APPROVED, spender: PERMIT2, before: 0n, after: MAX };
  assert.deepEqual(checkSimulatedFloor(observed(ALICE_ADDED, [kept]), SAFE, allowed), { kind: 'pass' });
  assert.deepEqual(rules(checkSimulatedFloor(observed(ALICE_ADDED, [kept, { ...kept, spender: OTHER }]), SAFE, allowed)), ['unlimited-approval allowances']);
  assert.deepEqual(rules(checkSimulatedFloor(observed(ALICE_ADDED, [{ ...kept, token: UNAPPROVED }]), SAFE, allowed)), ['unlimited-approval allowances']);
  const viaPermit2 = { token: APPROVED, spender: PERMIT2, before: { amount: 0n, expiration: 0n, nonce: 0n }, after: { amount: PERMIT2_MAX, expiration: 0n, nonce: 0n } };
  assert.deepEqual(rules(checkSimulatedFloor(observed(ALICE_ADDED, [kept], [viaPermit2]), SAFE, allowed)), ['unlimited-approval permit2']);
  assert.deepEqual(rules(checkSimulatedFloor(observed({ owners: [OTHER, BOB], threshold: 2n }, [kept]), SAFE, allowed)), ['safe-state safe']);
  assert.deepEqual(rules(checkSimulatedFloor(observed({ ...ALICE_ADDED, modules: [OTHER] }, [kept]), SAFE, allowed)), ['safe-state safe']);
});

test('enableModule, or an owner function, is refused for a card that holds a Uniswap swap, whatever its allowances keep', () => {
  const allowed = allowedBy(approveAndSwap);
  assert.equal(allowed.change, undefined);
  assert.deepEqual(checkFloor(multiSend(approve(APPROVED, PERMIT2)), allowed), { kind: 'pass' });
  assert.deepEqual(rules(checkFloor(multiSend(approve(APPROVED, PERMIT2), enableModule), allowed)), ['self-call multiSend[1]']);
  assert.deepEqual(rules(checkFloor({ ...BASE, data: `0x${bytesToHex(enableModule.data)}` as Hex }, allowed)), ['self-call call']);
  assert.deepEqual(rules(checkFloor(multiSend(approve(APPROVED, PERMIT2), addAlice), allowed)), ['self-call multiSend[1]']);
  const module = { address: SAFE, topics: [topic('EnabledModule(address)')], data: wordOf(OTHER) };
  const receipt = executed({ kind: 'receipt', logs: [module] });
  assert.deepEqual(rules(checkSimulatedFloor(receipt, SAFE, allowed)), ['safe-state receipt']);
});

test('an owner change the card does not declare is refused by both floors', () => {
  const allowed = allowedBy(transferOnly);
  assert.deepEqual(allowed, { standing: [], change: undefined });
  assert.deepEqual(rules(checkFloor({ ...BASE, data: `0x${bytesToHex(addAlice.data)}` as Hex }, allowed)), ['self-call call']);
  assert.deepEqual(rules(checkSimulatedFloor(observed(ALICE_ADDED), SAFE, allowed)), ['safe-state safe', 'safe-state safe']);
  const added = { address: SAFE, topics: [topic('AddedOwner(address)'), wordOf(ALICE)], data: '0x' as Hex };
  const receipt = executed({ kind: 'receipt', logs: [added] });
  assert.deepEqual(rules(checkSimulatedFloor(receipt, SAFE, allowed)), ['safe-state receipt']);
});

test('a card holding 0 as the fewest a swap may give is refused, whether a call argument or a signed order compares with it', () => {
  const swaps = new Map(['uniswap/swap', 'cow/swap'].map((id) => [id, loadTemplate(ROOT, id, registry)]));
  for (const template of swaps.keys()) {
    const card = (minBuy: string): Card => ({ operations: [{ template, values: { 'sell-token': 'usdc', 'buy-token': 'usdt', 'sell-amount': '1000000', 'min-buy': minBuy } }] });
    const resolve = (minBuy: string) => resolveCard(card(minBuy), { templates: swaps, registry, addressBook: new Map(), safe: SAFE });
    assert.deepEqual(resolve('0'), {
      kind: 'refused',
      reason: 'zero-floor',
      at: 'operations[0].values.min-buy',
      field: 'min-buy',
      detail: 'min-buy is 0; a computed amount, or one a share price bound or atLeast compares with, must be at least 1, since 0 there bounds nothing or nothing can meet it',
    });
    assert.equal(resolve('1').kind, 'resolved');
  }
});
