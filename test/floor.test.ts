import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { selectorOf } from '../src/decode/abi.ts';
import { encodeCall, uintWord } from '../src/decode/codec.ts';
import { MULTISEND, unwrapSafeTx } from '../src/decode/multisend.ts';
import type { Unwrapped } from '../src/decode/multisend.ts';
import { checkFloor } from '../src/floor/floor.ts';
import type { FloorResult } from '../src/floor/floor.ts';
import { checkSimulatedFloor } from '../src/floor/simulated.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import type { Observed } from '../src/simulate/effects.ts';
import { APPROVAL, topic, wordOf } from '../src/simulate/events.ts';
import type { SafeState } from '../src/simulate/safe-state.ts';

const ROOT = join(import.meta.dirname, '..');
const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', 'morpho-vault-deposit.json'), 'utf8'));
const deposit = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
const SAFE = deposit.safe;

const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address;
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as Address;
const MAX = (1n << 256n) - 1n;

const hex = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}` as Hex;
const word = (value: bigint | Address): Uint8Array => uintWord(BigInt(value));
const calldata = (signature: string, ...args: (bigint | Address)[]): Uint8Array =>
  concatBytes(hexToBytes(selectorOf(signature).slice(2)), ...args.map(word));

const direct = (to: Address, data: Uint8Array, value = 0n): SafeTx => ({ ...deposit, to, value, data: hex(data), operation: 0 });

type Entry = { operation?: 0 | 1; to: Address; value?: bigint; data: Uint8Array };
const packed = ({ operation = 0, to, value = 0n, data }: Entry): Uint8Array =>
  concatBytes(Uint8Array.of(operation), hexToBytes(to.slice(2)), word(value), word(BigInt(data.length)), data);
const multiSend = (...entries: Entry[]): SafeTx => ({
  ...deposit,
  data: hex(encodeCall({ fn: MULTISEND, args: [{ kind: 'bytes', value: concatBytes(...entries.map(packed)), span: [0, 0] }], trailer: undefined })),
});

const rules = (result: FloorResult): string[] => (result.kind === 'pass' ? [] : result.findings.map((f) => `${f.rule} ${f.callPath}`));
const details = (result: FloorResult): string[] => (result.kind === 'pass' ? [] : result.findings.map((f) => f.detail));

test('the Morpho deposit passes the static floor', () => {
  assert.deepEqual(checkFloor(deposit), { kind: 'pass' });
});

test('a gas price with a refund receiver is refused on both fee fields', () => {
  const result = checkFloor({ ...deposit, gasPrice: 1n, refundReceiver: OTHER });
  assert.deepEqual(rules(result), ['fee-fields safeTx', 'fee-fields safeTx']);
  assert.deepEqual(details(result), ['gasPrice is 1, must be zero', `refundReceiver is ${OTHER}, must be zero`]);
});

test('a delegatecall to anything but an official MultiSend is refused', () => {
  const result = checkFloor({ ...deposit, to: OTHER });
  assert.deepEqual(rules(result), ['delegatecall safeTx']);
  assert.match(details(result)[0]!, /not an official MultiSend/);
});

test('a delegatecall inside the MultiSend is refused, pointing at its operation byte', () => {
  const unwrapped = unwrapSafeTx(deposit) as Extract<Unwrapped, { kind: 'multisend' }>;
  const at = unwrapped.calls[0]!.fields!.operation[0];
  const bytes = hexToBytes(deposit.data.slice(2));
  bytes[at] = 1;
  const result = checkFloor({ ...deposit, data: hex(bytes) });
  assert.deepEqual(result, {
    kind: 'refused',
    findings: [{ rule: 'delegatecall', callPath: 'multiSend[0]', detail: `a delegatecall to ${USDC} inside the MultiSend`, bytes: [at, at + 1] }],
  });
});

test('a MultiSend that does not decode is refused, not passed', () => {
  const result = checkFloor({ ...deposit, data: `${deposit.data}00` as Hex });
  assert.deepEqual(rules(result), ['delegatecall safeTx']);
  assert.match(details(result)[0]!, /does not decode/);
});

test('a call to the Safe with data is refused, whether it adds an owner, changes the threshold or sets a fallback handler', () => {
  const cases: [string, SafeTx, string][] = [
    ['addOwnerWithThreshold(address,uint256)', direct(SAFE, calldata('addOwnerWithThreshold(address,uint256)', OTHER, 1n)), 'self-call call'],
    ['changeThreshold(uint256)', multiSend({ to: SAFE, data: calldata('changeThreshold(uint256)', 1n) }), 'self-call multiSend[0]'],
    ['setFallbackHandler(address)', direct(SAFE, calldata('setFallbackHandler(address)', OTHER)), 'self-call call'],
  ];
  for (const [signature, tx, rule] of cases) {
    const result = checkFloor(tx);
    assert.deepEqual(rules(result), [rule], signature);
    assert.deepEqual(details(result), [`a call to the Safe itself with data (selector ${selectorOf(signature)})`], signature);
  }
});

test('a zero-value call to the Safe with no data, the cancellation shape, passes', () => {
  assert.deepEqual(checkFloor(direct(SAFE, new Uint8Array())), { kind: 'pass' });
});

test('an unlimited ERC-20 approval is refused at the top level and inside the MultiSend, naming token, spender and amount', () => {
  const approve = calldata('approve(address,uint256)', OTHER, MAX);
  const top = checkFloor(direct(USDC, approve));
  assert.deepEqual(rules(top), ['unlimited-approval call']);
  assert.deepEqual(details(top), [`approve(address,uint256) of token ${USDC} to spender ${OTHER}, amount ${MAX}`]);
  assert.deepEqual((top as Extract<FloorResult, { kind: 'refused' }>).findings[0]!.bytes, [36, 68]);

  const inner = checkFloor(multiSend({ to: USDC, data: calldata('increaseAllowance(address,uint256)', OTHER, 1n << 255n) }));
  assert.deepEqual(rules(inner), ['unlimited-approval multiSend[0]']);
});

test('an approval just under 2^255 passes the static floor', () => {
  assert.deepEqual(checkFloor(direct(USDC, calldata('approve(address,uint256)', OTHER, (1n << 255n) - 1n))), { kind: 'pass' });
});

test('a short-address approve, whose amount the EVM reads shifted by the missing byte, is refused', () => {
  const spender = '0x1111111111111111111111111111111111111100' as Address;
  const short = concatBytes(calldata('approve(address,uint256)'), word(spender).subarray(0, 31), word(1n << 247n));
  assert.deepEqual(details(checkFloor(direct(USDC, short))), [`approve(address,uint256) of token ${USDC} to spender ${spender}, amount ${1n << 255n}`]);
});

test('a Permit2 approval of the maximum uint160 is refused, naming the token inside it', () => {
  const max160 = (1n << 160n) - 1n;
  const result = checkFloor(direct(PERMIT2, calldata('approve(address,address,uint160,uint48)', USDC, OTHER, max160, 1n)));
  assert.deepEqual(details(result), [`approve(address,address,uint160,uint48) of token ${USDC} to spender ${OTHER}, amount ${max160}`]);
});

test('an NFT approve-all is refused when set and passes when revoked', () => {
  const nft = '0x2222222222222222222222222222222222222222' as Address;
  assert.deepEqual(details(checkFloor(direct(nft, calldata('setApprovalForAll(address,bool)', OTHER, 1n)))), [
    `setApprovalForAll(address,bool) of token ${nft} to spender ${OTHER}, amount 1`,
  ]);
  assert.deepEqual(checkFloor(direct(nft, calldata('setApprovalForAll(address,bool)', OTHER, 0n))), { kind: 'pass' });
});

const STATE: SafeState = {
  singleton: `0x${'41675c099f32341bf84bfc5382af534df5c7461a'.padStart(64, '0')}` as Hex,
  threshold: 2n,
  owners: [OTHER, '0x2222222222222222222222222222222222222222' as Address],
  modules: [],
  guard: `0x${'0'.repeat(64)}` as Hex,
  moduleGuard: undefined,
  fallbackHandler: `0x${'fd0732dc9e303f09fcef3a7388ad10a83459ec99'.padStart(64, '0')}` as Hex,
};

const executed = (overrides: Partial<Extract<Observed, { kind: 'executed' }>>): Observed => ({
  kind: 'executed',
  eth: 0n,
  tokens: new Map(),
  allowances: [],
  permit2: [],
  ends: new Map(),
  safeState: { kind: 'read', before: STATE, after: STATE },
  ...overrides,
});

test('a simulation that changes the singleton is refused naming the singleton', () => {
  const after = { ...STATE, singleton: wordOf(OTHER) };
  const result = checkSimulatedFloor(executed({ safeState: { kind: 'read', before: STATE, after } }), SAFE);
  assert.deepEqual(rules(result), ['safe-state safe']);
  assert.match(details(result)[0]!, /^singleton changed from 0x0+41675c.* to 0x0+1111/);
});

test('a simulation that changes the owners is refused naming the owners', () => {
  const after = { ...STATE, owners: [...STATE.owners, USDC] };
  const result = checkSimulatedFloor(executed({ safeState: { kind: 'read', before: STATE, after } }), SAFE);
  assert.deepEqual(rules(result), ['safe-state safe']);
  assert.match(details(result)[0]!, /^owners changed/);
});

test('an allowance from the Safe left at the maximum is an unlimited approval', () => {
  const allowances = [{ token: USDC, spender: OTHER, before: 0n, after: MAX }];
  const result = checkSimulatedFloor(executed({ allowances }), SAFE);
  assert.deepEqual(rules(result), ['unlimited-approval allowances']);
  assert.deepEqual(details(result), [`token ${USDC} approved spender ${OTHER} for ${MAX}`]);
});

test('a receipt in which the Safe logs ChangedFallbackHandler is refused', () => {
  const logs = [{ address: SAFE, topics: [topic('ChangedFallbackHandler(address)'), wordOf(OTHER)], data: '0x' as Hex }];
  const result = checkSimulatedFloor(executed({ safeState: { kind: 'receipt', logs } }), SAFE);
  assert.deepEqual(rules(result), ['safe-state receipt']);
  assert.deepEqual(details(result), ['the Safe logged ChangedFallbackHandler(address)']);
});

test('a receipt with an unlimited Approval from the Safe is refused; the same event from another contract is not a Safe setting', () => {
  const logs = [
    { address: USDC, topics: [APPROVAL, wordOf(SAFE), wordOf(OTHER)], data: hex(word(MAX)) },
    { address: OTHER, topics: [topic('AddedOwner(address)'), wordOf(OTHER)], data: '0x' as Hex },
  ];
  const result = checkSimulatedFloor(executed({ safeState: { kind: 'receipt', logs } }), SAFE);
  assert.deepEqual(rules(result), ['unlimited-approval receipt']);
});
