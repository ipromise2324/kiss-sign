import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AbiSignatureError, parseFunctionSignature } from '../src/decode/abi.ts';
import { decodeCall, encodeCall, regionBytes, wholeRegion } from '../src/decode/codec.ts';
import type { AbiValue, DecodeFailure, DecodedCall, Region } from '../src/decode/codec.ts';
import { decodeMultiSendTransactions, unwrapSafeTx } from '../src/decode/multisend.ts';
import type { InnerCall, Unwrapped } from '../src/decode/multisend.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'testdata', 'safe-tx', 'morpho-vault-deposit.json'), 'utf8'));
const deposit = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });

const APPROVE = parseFunctionSignature('approve(address spender, uint256 value)');
const MULTICALL = parseFunctionSignature('multicall((address to, bytes data, uint256 value, bool skipRevert, bytes32 callbackHash)[] bundle)');
const TRANSFER_FROM = parseFunctionSignature('erc20TransferFrom(address token, address receiver, uint256 amount)');
const DEPOSIT = parseFunctionSignature('erc4626Deposit(address vault, uint256 assets, uint256 maxSharePriceE27, address receiver)');

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const BUNDLER3 = '0x6566194141eefa99af43bb5aa71460ca2dc90245';
const ADAPTER = '0x4a6c312ec70e8747a587ee860a0353cd42be0ae0';
const VAULT = '0xbeef088055857739c12cd3765f20b7679def0f51';
const AMOUNT = 1_800_000_000_180n;

const withData = (bytes: Uint8Array): SafeTx => ({ ...deposit, data: `0x${bytesToHex(bytes)}` as Hex });
const depositBytes = (): Uint8Array => hexToBytes(deposit.data.slice(2));

function unwrapped(result: Unwrapped | DecodeFailure): readonly InnerCall[] {
  assert.equal(result.kind, 'multisend', 'kind' in result && 'at' in result ? `${result.kind} at ${result.at}` : result.kind);
  return (result as Extract<Unwrapped, { kind: 'multisend' }>).calls;
}

function decoded(result: DecodedCall | DecodeFailure): DecodedCall {
  assert.equal(result.kind, 'decoded', 'at' in result ? `${result.kind} at ${result.at}` : result.kind);
  return result as DecodedCall;
}

const plain = (value: AbiValue | undefined): unknown => {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'array':
      return value.items.map(plain);
    case 'tuple':
      return value.fields.map(plain);
    case 'bytes':
    case 'string':
      return `0x${bytesToHex(value.value)}`;
    default:
      return value.value;
  }
};

function nested(value: AbiValue | undefined): Region {
  assert.equal(value?.kind, 'bytes');
  const span = (value as Extract<AbiValue, { kind: 'bytes' | 'string' }>).span;
  return { root: depositBytes(), start: span[0], end: span[1] };
}

test('the Morpho deposit decodes down to the adapter calls, and every level re-encodes to its exact bytes', () => {
  const calls = unwrapped(unwrapSafeTx(deposit));
  assert.deepEqual(calls.map((c) => [c.operation, c.to, c.value]), [[0, USDC, 0n], [0, BUNDLER3, 0n]]);

  const approve = decoded(decodeCall(APPROVE, calls[0]!.data));
  assert.deepEqual(approve.args.map(plain), [ADAPTER, AMOUNT]);

  const multicall = decoded(decodeCall(MULTICALL, calls[1]!.data, { trailerMaxBytes: 8 }));
  assert.equal(bytesToHex(multicall.trailer?.value ?? new Uint8Array()), '6ab541c925afea44', 'the Morpho app metadata trailer');
  const bundle = multicall.args[0];
  assert.equal(bundle?.kind, 'array');
  const items = (bundle as Extract<AbiValue, { kind: 'array' }>).items as Extract<AbiValue, { kind: 'tuple' }>[];
  assert.deepEqual(items.map((item) => [plain(item.fields[0]), plain(item.fields[2]), plain(item.fields[3]), plain(item.fields[4])]), [
    [ADAPTER, 0n, false, `0x${'00'.repeat(32)}`],
    [ADAPTER, 0n, false, `0x${'00'.repeat(32)}`],
  ]);

  const transferFrom = decoded(decodeCall(TRANSFER_FROM, nested(items[0]?.fields[1])));
  assert.deepEqual(transferFrom.args.map(plain), [USDC, ADAPTER, AMOUNT]);
  const vaultDeposit = decoded(decodeCall(DEPOSIT, nested(items[1]?.fields[1])));
  assert.deepEqual(vaultDeposit.args.map(plain), [VAULT, AMOUNT, 1_033_376_152_028_289n, deposit.safe]);
  assert.deepEqual(depositBytes().subarray(...vaultDeposit.args[3]!.span), hexToBytes(`000000000000000000000000${deposit.safe.slice(2)}`));

  for (const [call, region] of [
    [approve, calls[0]!.data],
    [multicall, calls[1]!.data],
    [transferFrom, nested(items[0]?.fields[1])],
    [vaultDeposit, nested(items[1]?.fields[1])],
  ] as const) {
    assert.deepEqual(encodeCall(call), regionBytes(region), `${call.fn.name} re-encodes byte for byte`);
  }
});

test('one extra byte after the Safe transaction data is non-canonical at that byte', () => {
  const bytes = depositBytes();
  const result = unwrapSafeTx(withData(Uint8Array.of(...bytes, 0)));
  assert.deepEqual(result, { kind: 'non-canonical', at: bytes.length });
});

test('trailing bytes after a call are refused unless the caller allows that many', () => {
  const [, bundler] = unwrapped(unwrapSafeTx(deposit));
  assert.deepEqual(decodeCall(MULTICALL, bundler!.data), { kind: 'non-canonical', at: 1110 });
  assert.deepEqual(decodeCall(MULTICALL, bundler!.data, { trailerMaxBytes: 7 }), { kind: 'non-canonical', at: 1110 });
});

test('a dirty high byte in the approval spender word is non-canonical at that byte', () => {
  const [approve] = unwrapped(unwrapSafeTx(deposit));
  const spenderWord = approve!.data.start + 4;
  const bytes = depositBytes();
  bytes[spenderWord] = 0x01;
  const [dirty] = unwrapped(unwrapSafeTx(withData(bytes)));
  assert.deepEqual(decodeCall(APPROVE, dirty!.data), { kind: 'non-canonical', at: spenderWord });
});

test('a truncated transaction is malformed, not thrown', () => {
  const bytes = depositBytes();
  const result = unwrapSafeTx(withData(bytes.subarray(0, bytes.length - 40)));
  assert.equal(result.kind, 'malformed');
});

test('an offset that does not point at the next tail is non-canonical', () => {
  const bytes = depositBytes();
  bytes[35] = 0x40;
  assert.deepEqual(unwrapSafeTx(withData(bytes)), { kind: 'non-canonical', at: 35 });
});

test('a MultiSend entry whose operation is neither call nor delegatecall is malformed', () => {
  const [approve] = unwrapped(unwrapSafeTx(deposit));
  const bytes = depositBytes();
  bytes[approve!.span[0]] = 2;
  assert.deepEqual(unwrapSafeTx(withData(bytes)), { kind: 'malformed', at: approve!.span[0], problem: 'a MultiSend operation that is neither 0 nor 1' });
});

test('a zero `to` inside MultiSend 1.5.0, which calls the Safe itself, is malformed; older MultiSends call the zero address', () => {
  const [approve] = unwrapped(unwrapSafeTx(deposit));
  const bytes = depositBytes();
  bytes.fill(0, approve!.span[0] + 1, approve!.span[0] + 21);
  const zeroTo = withData(bytes);
  assert.deepEqual(unwrapSafeTx({ ...zeroTo, to: '0xa83c336b20401af773b6219ba5027174338d1836' as Address }), {
    kind: 'malformed',
    at: approve!.span[0] + 1,
    problem: 'a MultiSend 1.5.0 call to the zero address, which it sends to the Safe itself',
  });
  assert.equal(unwrapped(unwrapSafeTx(zeroTo))[0]!.to, `0x${'0'.repeat(40)}`);
  assert.equal(unwrapped(unwrapSafeTx({ ...deposit, to: '0xa83c336b20401af773b6219ba5027174338d1836' as Address })).length, 2);
});

test('only an official MultiSend is unwrapped; a direct call is one call', () => {
  const foreign = '0x1111111111111111111111111111111111111111' as Address;
  assert.deepEqual(unwrapSafeTx({ ...deposit, to: foreign }), { kind: 'foreign-delegatecall', to: foreign });
  const direct = unwrapSafeTx({ ...deposit, operation: 0 });
  assert.equal(direct.kind, 'direct');
  assert.deepEqual((direct as Extract<Unwrapped, { kind: 'direct' }>).calls.map((c) => [c.path, c.to, c.data.end]), [['call', deposit.to, depositBytes().length]]);
});

test('MultiSend entries repack to the exact bytes they came from', () => {
  const calls = unwrapped(unwrapSafeTx(deposit));
  const packed: Region = { root: depositBytes(), start: calls[0]!.span[0], end: calls[1]!.span[1] };
  assert.equal(packed.end - packed.start, 1050);
  assert.deepEqual(decodeMultiSendTransactions(packed), calls);
});

test('a wrong selector names both selectors', () => {
  const [approve] = unwrapped(unwrapSafeTx(deposit));
  assert.deepEqual(decodeCall(TRANSFER_FROM, approve!.data), {
    kind: 'wrong-selector',
    at: approve!.data.start,
    expected: TRANSFER_FROM.selector,
    actual: '0x095ea7b3',
  });
});

test('signatures parse to canonical forms and the selectors the fixture uses', () => {
  assert.deepEqual(
    [APPROVE, MULTICALL, TRANSFER_FROM, DEPOSIT, parseFunctionSignature('multiSend(bytes)')].map((f) => [f.signature, f.selector]),
    [
      ['approve(address,uint256)', '0x095ea7b3'],
      ['multicall((address,bytes,uint256,bool,bytes32)[])', '0x374f435d'],
      ['erc20TransferFrom(address,address,uint256)', '0xd96ca0b9'],
      ['erc4626Deposit(address,uint256,uint256,address)', '0x6ef5eeae'],
      ['multiSend(bytes)', '0x8d80ff0a'],
    ],
  );
  assert.equal(parseFunctionSignature('f(uint,int8[2][],(bytes4,(string,bool)[3]) x)').signature, 'f(uint256,int8[2][],(bytes4,(string,bool)[3]))');
  assert.deepEqual(APPROVE.params.map((p) => p.name), ['spender', 'value']);
  for (const bad of ['approve(address,uint7)', 'f(bytes33)', 'f(()', 'f(uint256[0])', 'f(address', 'f(address))', 'f()x', '(address)', 'f(int08)']) {
    assert.throws(() => parseFunctionSignature(bad), AbiSignatureError, bad);
  }
});

test('nested tuples, fixed arrays, strings and negative ints decode back to what was encoded', () => {
  const fn = parseFunctionSignature('f((uint8,bytes)[2] pairs, string note, int16[] deltas, bytes3 tag)');
  const span = [0, 0] as const;
  const bytes = (hex: string): AbiValue => ({ kind: 'bytes', value: hexToBytes(hex), span });
  const pair = (n: bigint, hex: string): AbiValue => ({ kind: 'tuple', fields: [{ kind: 'uint', value: n, span }, bytes(hex)], span });
  const args: AbiValue[] = [
    { kind: 'array', items: [pair(7n, 'aabb'), pair(255n, '')], span },
    { kind: 'string', value: new TextEncoder().encode('hello'), span },
    { kind: 'array', items: [{ kind: 'int', value: -2n, span }, { kind: 'int', value: 300n, span }], span },
    { kind: 'fixed-bytes', value: '0x010203' as Hex, span },
  ];
  const encoded = encodeCall({ fn, args, trailer: undefined });
  const call = decoded(decodeCall(fn, wholeRegion(encoded)));
  assert.deepEqual(call.args.map(plain), [[[7n, '0xaabb'], [255n, '0x']], '0x68656c6c6f', [-2n, 300n], '0x010203']);
});

test('no corruption of the deposit makes the decoder throw', () => {
  const original = depositBytes();
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const decodeAll = (tx: SafeTx) => {
    const result = unwrapSafeTx(tx);
    if (result.kind !== 'multisend') return;
    decodeCall(APPROVE, result.calls[0]!.data);
    if (result.calls[1] === undefined) return;
    const multicall = decodeCall(MULTICALL, result.calls[1].data, { trailerMaxBytes: 8 });
    if (multicall.kind !== 'decoded') return;
    for (const item of (multicall.args[0] as Extract<AbiValue, { kind: 'array' }>).items as Extract<AbiValue, { kind: 'tuple' }>[]) {
      const data = item.fields[1] as Extract<AbiValue, { kind: 'bytes' | 'string' }>;
      decodeCall(DEPOSIT, { root: result.calls[1].data.root, start: data.span[0], end: data.span[1] });
    }
  };
  for (let i = 0; i < 3000; i += 1) {
    const bytes = original.slice(0, i % 3 === 0 ? next(original.length) : original.length);
    for (let k = 0; k < 3; k += 1) if (bytes.length > 0) bytes[next(bytes.length)] = next(256);
    assert.doesNotThrow(() => decodeAll(withData(bytes)));
  }
});
