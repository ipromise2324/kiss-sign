import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { loadAbiCases, replayAbiCase } from '../src/contracts/abi-case.ts';
import { namedSignatureOfAbiEntry, parseFunctionSignature } from '../src/decode/abi.ts';
import { encodeParams } from '../src/decode/codec.ts';
import type { AbiValue } from '../src/decode/codec.ts';
import { loadRegistry } from '../src/registry.ts';
import { loadTemplate } from '../src/template/template.ts';
import { EXEC_TRANSACTION, renderDecodedTx } from '../src/research/decode-tx.ts';
import { EXECUTION_SUCCESS } from '../src/simulate/events.ts';
import type { CallAbi, DecodeTxDeps, ExecutedTx } from '../src/research/decode-tx.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { baseRepo } from './repo-with-test-fixtures.ts';
import { warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const nameOf = (address: Address) => registry.byAddress.get(address)?.name;
const SPAN = [0, 0] as const;
/** The frozen templates the decoding tests read: uniswap/swap-no-hook and the cow/swap these fixtures were made for. */
const BASE = baseRepo();
const baseRegistry = loadRegistry(BASE);

/** The executed transaction of a recorded Safe fixture: execTransaction with the service's fields and signatures. */
function executed(name: string): ExecutedTx {
  const { service } = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8')) as { service: Record<string, string> };
  const address = (key: string): AbiValue => ({ kind: 'address', value: (service[key] as string).toLowerCase() as Address, span: SPAN });
  const uint = (key: string): AbiValue => ({ kind: 'uint', value: BigInt(service[key] as string), span: SPAN });
  const bytes = (key: string): AbiValue => ({ kind: 'bytes', value: hexToBytes((service[key] as string).slice(2)), span: SPAN });
  const args = [address('to'), uint('value'), bytes('data'), uint('operation'), uint('safeTxGas'), uint('baseGas'), uint('gasPrice'), address('gasToken'), address('refundReceiver'), bytes('signatures')];
  return {
    hash: service.transactionHash as Hex,
    blockNumber: BigInt(service.blockNumber as string),
    from: (service.executor as string).toLowerCase() as Address,
    to: (service.safe as string).toLowerCase() as Address,
    value: 0n,
    input: `${EXEC_TRANSACTION.selector}${bytesToHex(encodeParams(EXEC_TRANSACTION, args))}` as Hex,
  };
}

const USDT = registry.entries.get('usdt')?.address ?? assert.fail('usdt');
const FUSDT = registry.entries.get('fluid-fusdt')?.address ?? assert.fail('fluid-fusdt');

async function provenAbis(addresses: readonly Address[]): Promise<DecodeTxDeps['abiOf']> {
  const cases = loadAbiCases(ROOT);
  const recorded = addresses.map((a) => cases.get(a) ?? assert.fail(`no ABI case of ${a}`));
  const compilers = await warmCompilers(recorded);
  const abis = new Map<Address, CallAbi>();
  for (const fixture of recorded) {
    const proof = await replayAbiCase(fixture, compilers, registry.byAddress.get(fixture.address) ?? {});
    if (proof.kind !== 'proven') assert.fail(`${fixture.address}: refused`);
    const functions = proof.abi.filter((e) => e.type === 'function').map((e) => parseFunctionSignature(namedSignatureOfAbiEntry(e)));
    abis.set(fixture.address, { kind: 'proven', from: `the recorded proof at block ${fixture.block.number}`, functions: new Map(functions.map((fn) => [fn.selector, fn])) });
  }
  return async (address) => abis.get(address) ?? { kind: 'none', why: 'no proof in this test' };
}

test('decode-tx unwraps a Safe execTransaction into its MultiSend parts and decodes each with the proven ABI of its target', { timeout: 600_000 }, async () => {
  const tx = executed('fluid-deposit-usdt-base');
  const text = await renderDecodedTx(tx, { abiOf: await provenAbis([USDT, FUSDT]), nameOf });
  const amount = 0xbea480d64n.toString();
  assert.match(text, /^transaction 0xbf3f89984eae08bd1c73628d5777815592ed85a339223a2517f380a2bf91c801, block 26304863\n/);
  assert.match(text, /Safe execTransaction\(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes\) \(0x6a761202\)/);
  assert.match(text, /\n {2}operation: 1\n/);
  assert.match(text, /delegatecall to 0x9641d764fc13c8b624c04430c7356c1c7c8102e2 \(registry: multisend-call-only-1\.4\.1\), Safe's MultiSendCallOnly 1\.4\.1, multiSend\(bytes\) of 2 calls/);
  assert.match(text, new RegExp(`multiSend\\[0\\]: call to ${USDT} \\(registry: usdt\\), value 0 wei\\n.*ABI: the recorded proof at block \\d+\\n {6}approve\\(address,uint256\\) \\(0x095ea7b3\\)\\n {8}\\w+: ${FUSDT} \\(registry: fluid-fusdt\\)\\n {8}\\w+: ${amount}\\n`));
  assert.match(text, new RegExp(`multiSend\\[1\\]: call to ${FUSDT} \\(registry: fluid-fusdt\\), value 0 wei\\n.*\\n {6}deposit\\(uint256,address\\) \\(0x6e553f65\\)\\n {8}\\w+: ${amount}\\n {8}\\w+: ${tx.to}\\n`));
});

test("decode-tx prints a Safe transaction's nonce and safeTxHash from its ExecutionSuccess log, logged as a topic (1.4.1) or as data (1.3.0)", async () => {
  const none = { abiOf: async (): Promise<CallAbi> => ({ kind: 'none', why: 'no proof here' }), nameOf };
  for (const name of ['fluid-deposit-usdt-base', 'cow-swap-usdc-base']) {
    const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8')) as { chain: { version: string; transactionHash: Hex }; service: { nonce: string } };
    const safeTxHash = fixture.chain.transactionHash;
    const tx = executed(name);
    const event = fixture.chain.version === '1.3.0' ? { topics: [EXECUTION_SUCCESS], data: `${safeTxHash}${'00'.repeat(32)}` as Hex } : { topics: [EXECUTION_SUCCESS, safeTxHash], data: `0x${'00'.repeat(32)}` as Hex };
    const text = await renderDecodedTx({ ...tx, logs: [{ address: tx.to as Address, ...event }] }, none);
    assert.match(text, new RegExp(`\\nSafe nonce ${fixture.service.nonce}, safeTxHash ${safeTxHash}\\n`));
  }
  const tx = executed('fluid-deposit-usdt-base');
  assert.match(await renderDecodedTx({ ...tx, logs: [] }, none), /\nSafe nonce: not read, the receipt holds 0 ExecutionSuccess logs of 0x[0-9a-f]{40}, not one\n/);
});

test('decode-tx prints the selector and raw words of a call whose target has no proven ABI, and says why', async () => {
  const text = await renderDecodedTx(executed('fluid-deposit-usdt-base'), { abiOf: async () => ({ kind: 'none', why: 'no proof here' }), nameOf });
  assert.match(text, new RegExp(`multiSend\\[0\\]: call to ${USDT} \\(registry: usdt\\), value 0 wei\\n {6}selector 0x095ea7b3, not decoded: no proof here\\n {8}word 0: 0x0{24}${FUSDT.slice(2)}\\n {8}word 1: 0x0+bea480d64\\n`));
});

test('decode-tx decodes a call that is not a Safe transaction with the ABI of its target, quoting any string as data', async () => {
  const fn = parseFunctionSignature('setName(string name)');
  const input = `${fn.selector}${bytesToHex(encodeParams(fn, [{ kind: 'string', value: new TextEncoder().encode('a‮b\nc'), span: SPAN }]))}` as Hex;
  const to = `0x${'11'.repeat(20)}` as Address;
  const tx: ExecutedTx = { hash: `0x${'22'.repeat(32)}` as Hex, blockNumber: 1n, from: `0x${'33'.repeat(20)}` as Address, to, value: 5n, input };
  const text = await renderDecodedTx(tx, { abiOf: async () => ({ kind: 'proven', from: 'test', functions: new Map([[fn.selector, fn]]) }), nameOf });
  assert.match(text, /\nto 0x1{40}, value 5 wei\nABI: test\nsetName\(string\) \(0x[0-9a-f]{8}\)\n {2}name: "a b c"\n$/);
  const full = await renderDecodedTx(tx, { abiOf: async () => ({ kind: 'proven', from: 'test', functions: new Map([[fn.selector, fn]]) }), nameOf, full: true });
  assert.match(full, /\n {2}name: "a\[U\+202E\]b\[U\+000A\]c"\n$/);
});

const proven = (signature: string): DecodeTxDeps['abiOf'] => {
  const fn = parseFunctionSignature(signature);
  return async () => ({ kind: 'proven', from: 'test', functions: new Map([[fn.selector, fn]]) });
};

test("decode-tx decodes the Universal Router's inputs by --template's encoded rules and says where an input does not fit them", async () => {
  const deps = { abiOf: proven('execute(bytes commands, bytes[] inputs, uint256 deadline)'), nameOf };
  const tx = executed('uniswap-swap-no-hook-usdc-usdt');
  const plain = await renderDecodedTx(tx, deps);
  assert.match(plain, /\n {8}\[0\]: 0x[0-9a-f]{512}… \(SHORTENED: \d+ bytes, the first 256 shown; --full prints every byte\)\n/);
  const text = await renderDecodedTx(tx, { ...deps, template: loadTemplate(BASE, 'uniswap/swap-no-hook', baseRegistry) });
  assert.match(text, /bytes inside decoded by uniswap\/swap-no-hook's call \[0\], this call's target and position\n/);
  assert.match(text, /\n {8}\[0\]: \d+ bytes, decoded as the template's encoded parameters V4_SWAP\(bytes,bytes\[\]\)\n {10}actions: 0x[0-9a-f]+\n {10}params: 3 items\n/);
  assert.match(text, new RegExp(`\\n {18}currency0: ${registry.entries.get('usdc')?.address} \\(registry: usdc\\)\\n`));
  assert.doesNotMatch(text, /SHORTENED/);
  const execute = parseFunctionSignature('execute(bytes commands, bytes[] inputs, uint256 deadline)');
  const odd = new Uint8Array(64).fill(1);
  const input = `${execute.selector}${bytesToHex(encodeParams(execute, [{ kind: 'bytes', value: hexToBytes('10'), span: SPAN }, { kind: 'array', items: [{ kind: 'bytes', value: odd, span: SPAN }, { kind: 'bytes', value: odd, span: SPAN }], span: SPAN }, { kind: 'uint', value: 1n, span: SPAN }]))}` as Hex;
  const unfit = await renderDecodedTx({ ...tx, input }, { ...deps, template: loadTemplate(BASE, 'uniswap/swap-no-hook', baseRegistry) });
  assert.match(unfit, /bytes inside shown where they fit uniswap\/swap-no-hook's call \[0\], the first with this function, to another contract; this call is at position \[0\]\n/);
  assert.match(unfit, /\n {2}inputs: 2 items; the template's rule has 1, applied by position\n/);
  assert.match(unfit, /\n {4}\[1\]: 0x(01){64}\n/);
  assert.match(unfit, /\n {4}\[0\]: 64 bytes, which do not decode as the template's encoded parameters V4_SWAP\(bytes,bytes\[\]\): .+: 0x(01){64}\n/);
});

test("decode-tx prints a CoW order uid as --template's packed parts", async () => {
  const deps = { abiOf: proven('setPreSignature(bytes orderUid, bool signed)'), nameOf, template: loadTemplate(BASE, 'cow/swap', baseRegistry) };
  const text = await renderDecodedTx(executed('cow-swap-usdc-base'), deps);
  assert.match(text, /\n {6}orderUid: 56 bytes, decoded as the template's packed parts\n {8}digest: 0x[0-9a-f]{64}\n {8}owner: 0x[0-9a-f]{40}\n {8}validTo: \d+\n/);
});

test('decode-tx prints a long bytes value whole with --full, and decodes bytes that are a call of the same contract', async () => {
  const multicall = parseFunctionSignature('multicall(bytes[] data)');
  const transfer = parseFunctionSignature('pay(address to, bytes memo)');
  const memo = new Uint8Array(300).fill(0xab);
  const inner = hexToBytes(`${transfer.selector.slice(2)}${bytesToHex(encodeParams(transfer, [{ kind: 'address', value: `0x${'44'.repeat(20)}` as Address, span: SPAN }, { kind: 'bytes', value: memo, span: SPAN }]))}`);
  const input = `${multicall.selector}${bytesToHex(encodeParams(multicall, [{ kind: 'array', items: [{ kind: 'bytes', value: inner, span: SPAN }], span: SPAN }]))}` as Hex;
  const tx: ExecutedTx = { hash: `0x${'22'.repeat(32)}` as Hex, blockNumber: 1n, from: `0x${'33'.repeat(20)}` as Address, to: `0x${'11'.repeat(20)}` as Address, value: 0n, input };
  const abiOf: DecodeTxDeps['abiOf'] = async () => ({ kind: 'proven', from: 'test', functions: new Map([multicall, transfer].map((fn) => [fn.selector, fn])) });
  const text = await renderDecodedTx(tx, { abiOf, nameOf, full: true });
  assert.match(text, new RegExp(`\\n {4}\\[0\\]: ${inner.length} bytes, decodes as pay\\(address,bytes\\) \\(${transfer.selector}\\) of the called contract's proven ABI, a guess: nothing declares these bytes a call\\n {6}to: 0x4{40}\\n {6}memo: 0x(ab){300}\\n$`));
});
