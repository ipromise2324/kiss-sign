import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { abiCaseBlock, abiCaseReader, loadAbiCases } from '../src/contracts/abi-case.ts';
import { createReader } from '../src/chain/reader.ts';
import { REPLAY_ENDPOINTS } from '../src/chain/recording.ts';
import type { Transport } from '../src/chain/rpc.ts';
import { parseFunctionSignature, parseViewSignature } from '../src/decode/abi.ts';
import type { AbiValue } from '../src/decode/codec.ts';
import { encodeParams } from '../src/decode/codec.ts';
import { recordedAbiAt } from '../src/research/proven-abi.ts';
import type { ProvenAbi } from '../src/research/proven-abi.ts';
import { argOf, readView } from '../src/research/read-view.ts';
import { parseAddress } from '../src/safe/types.ts';
import { warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const FEED = parseAddress('feed', '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6');
const HEAD = 24_000_000n;
const span: AbiValue['span'] = [0, 0];
const hashOf = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const pair = (text: string) => `0x${Buffer.from(encodeParams(parseFunctionSignature('f(string)'), [{ kind: 'string', value: new TextEncoder().encode(text), span }])).toString('hex')}`;

type Answer = { readonly result: unknown } | 'revert' | 'down';

/** A chain whose `eth_call` answers `answer(provider)`, recording the block hash each call was made at. */
function chain(answer: (provider: string) => Answer, code = '0x60') {
  const calledAt: string[] = [];
  const transport: Transport = async (url, body) => {
    const { method, params } = JSON.parse(body) as { method: string; params: any[] };
    const reply = (result: unknown) => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
    const block = (n: bigint) => reply({ number: `0x${n.toString(16)}`, hash: hashOf(n), timestamp: '0x1', gasLimit: '0x1', mixHash: hashOf(n) });
    if (method === 'eth_blockNumber') return reply(`0x${HEAD.toString(16)}`);
    if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') return block(BigInt(params[0]));
    if (method === 'eth_getCode') return reply(code);
    assert.equal(method, 'eth_call');
    calledAt.push(params[1].blockHash);
    const given = answer(url.includes('drpc') ? 'drpc' : 'alchemy');
    if (given === 'down') return { status: 503, text: 'unavailable' };
    return given === 'revert' ? { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }) } : reply(given.result);
  };
  return { reader: createReader(REPLAY_ENDPOINTS, transport, { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] }), calledAt };
}

const DESCRIPTION = parseViewSignature('description() returns (string)');
const NO_ABI = async (): Promise<ProvenAbi> => ({ kind: 'none', why: 'testdata/abi/ holds no ABI proof of it' });
const proven = (outputs: unknown, stateMutability = 'view') => async (): Promise<ProvenAbi> => ({
  kind: 'proven',
  from: 'the recorded proof',
  abi: [{ type: 'function', name: 'description', inputs: [], outputs, stateMutability }],
});

test('a view both providers answer alike prints its decoded value, at the block it read, decoded by the given signature', async () => {
  const { reader, calledAt } = chain(() => ({ result: pair('USDC / USD') }));
  const { text, ok } = await readView(reader, FEED, DESCRIPTION, [], 23_000_000n, NO_ABI, undefined);
  assert.equal(ok, true);
  assert.deepEqual(calledAt, [hashOf(23_000_000n), hashOf(23_000_000n)]);
  assert.match(text, /at block 23000000/);
  assert.match(text, /decoded by the given signature, with no proven ABI: testdata\/abi\/ holds no ABI proof of it; that it is a view or pure function, which changes no state, is not established/);
  assert.match(text, /^ {2}0 \(string\): "USDC \/ USD"$/m);
  assert.match(text, /ORIENTATION ONLY/);
});

test('providers that disagree give no answer and no value', async () => {
  const { reader } = chain((provider) => ({ result: pair(provider === 'drpc' ? 'ETH / USD' : 'USDC / USD') }));
  const { text, ok } = await readView(reader, FEED, DESCRIPTION, [], 'latest', NO_ABI, undefined);
  assert.equal(ok, false);
  assert.match(text, /NO ANSWER .*disagree/);
  assert.doesNotMatch(text, /USD"/);
});

test('a revert both providers agree on is printed as one', async () => {
  const { reader } = chain(() => 'revert');
  const { text, ok } = await readView(reader, FEED, DESCRIPTION, [], 'latest', NO_ABI, undefined);
  assert.equal(ok, true);
  assert.match(text, /REVERTED/);
});

test('a provider that fails gives no answer, naming it', async () => {
  const { reader } = chain((provider) => (provider === 'drpc' ? 'down' : { result: pair('USDC / USD') }));
  const { text, ok } = await readView(reader, FEED, DESCRIPTION, [], 'latest', NO_ABI, undefined);
  assert.equal(ok, false);
  assert.match(text, /NO ANSWER .*drpc/);
  assert.doesNotMatch(text, /USD"/);
});

test('an empty answer from an address with no code says so, and gives no value', async () => {
  const { reader } = chain(() => ({ result: '0x' }), '0x');
  const { text, ok } = await readView(reader, FEED, DESCRIPTION, [], 'latest', NO_ABI, undefined);
  assert.equal(ok, false);
  assert.match(text, /NO CODE/);
});

test('an empty answer from an address with code says it returned nothing, and gives no value', async () => {
  const { reader } = chain(() => ({ result: '0x' }), '0x60');
  const { text, ok } = await readView(reader, FEED, DESCRIPTION, [], 'latest', NO_ABI, undefined);
  assert.equal(ok, false);
  assert.match(text, /RETURNED NOTHING .*though the address has code/);
});

test('an answer the returns cannot decode prints its bytes as UNDECODED, and gives no value', async () => {
  const { reader } = chain(() => ({ result: '0x01' }));
  const { text, ok } = await readView(reader, FEED, DESCRIPTION, [], 'latest', NO_ABI, undefined);
  assert.equal(ok, false);
  assert.match(text, /UNDECODED .* 0x01, not the canonical encoding/);
});

test('returns the proven ABI declares in a type that cannot be decoded print the bytes as UNDECODED, with the reason', async () => {
  const { reader } = chain(() => ({ result: pair('USDC / USD') }));
  const { text, ok } = await readView(reader, FEED, DESCRIPTION, [], 'latest', proven([{ name: 'callback', type: 'function' }]), undefined);
  assert.equal(ok, false);
  assert.match(text, new RegExp(`UNDECODED .* ${pair('USDC / USD')}; the proven ABI, the recorded proof, declares returns that cannot be decoded: .*function`));
});

test('a function the proven ABI declares neither view nor pure is refused, and not called', async () => {
  const { reader, calledAt } = chain(() => ({ result: pair('USDC / USD') }));
  const { text, ok } = await readView(reader, FEED, DESCRIPTION, [], 'latest', proven([{ name: '', type: 'string' }], 'nonpayable'), undefined);
  assert.equal(ok, false);
  assert.match(text, /NOT A VIEW {2}the proven ABI, the recorded proof, declares description\(\) nonpayable/);
  assert.deepEqual(calledAt, []);
});

const USDC = loadAbiCases(ROOT).get(parseAddress('usdc', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'))!;
const IMPLEMENTATION_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const NEW_IMPLEMENTATION = '0x00000000000000000000000000000000000000aa';

test("a recorded ABI proof is proven again at the block read, and once the proxy's implementation changed, the given returns decode instead", async () => {
  const compilers = await warmCompilers([USDC]);
  const deps = { registry: { byAddress: new Map() }, compilers };
  const same = await recordedAbiAt(USDC, { ...deps, reader: abiCaseReader(USDC) }, abiCaseBlock(USDC));
  assert.equal(same.kind, 'proven');
  assert.match(same.kind === 'proven' ? same.from : '', /proven again at block 26433609/);

  const upgraded = USDC.reads.map((read) => (read.method === 'getStorageAt' && read.args[1] === IMPLEMENTATION_SLOT ? { ...read, value: `0x${NEW_IMPLEMENTATION.slice(2).padStart(64, '0')}` } : read));
  const implementationCode = USDC.reads.find((read) => read.method === 'getCode' && read.args[0] !== USDC.address)!.value;
  const newCode = { method: 'getCode', args: [NEW_IMPLEMENTATION], value: implementationCode };
  const stale = await recordedAbiAt(USDC, { ...deps, reader: abiCaseReader({ ...USDC, reads: upgraded }, [newCode]) }, abiCaseBlock(USDC));
  assert.deepEqual(stale.kind, 'none');
  const { reader } = chain(() => ({ result: pair('USDC / USD') }));
  const { text, ok } = await readView(reader, FEED, DESCRIPTION, [], 'latest', async () => stale, undefined);
  assert.equal(ok, true);
  assert.match(text, new RegExp(`decoded by the given signature, with no proven ABI: the ABI proof recorded in testdata/abi/ at block 26433609 is not proven again at block 26433609: the code there runs ${NEW_IMPLEMENTATION}, whose source the proof did not record; pnpm record-abi-case`));
  assert.match(text, /^ {2}0 \(string\): "USDC \/ USD"$/m);
});

test('a proven ABI with the function decodes by its returns and names them, and says when the given returns differ', async () => {
  const { reader } = chain(() => ({ result: pair('USDC / USD') }));
  const { text } = await readView(reader, FEED, parseViewSignature('description() returns (bytes)'), [], 'latest', proven([{ name: 'pair', type: 'string' }]), 'a-feed');
  assert.match(text, /\(a-feed\)/);
  assert.match(text, /decoded by the proven ABI, the recorded proof; the given returns \(bytes\) differ from its \(string\)/);
  assert.match(text, /^ {2}pair \(string\): "USDC \/ USD"$/m);
});

test('a proven ABI without the function leaves the given signature to decode, and says so', async () => {
  const abi = async (): Promise<ProvenAbi> => ({ kind: 'proven', from: 'the recorded proof', abi: [{ type: 'function', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' }] });
  const { reader } = chain(() => ({ result: pair('USDC / USD') }));
  assert.match((await readView(reader, FEED, DESCRIPTION, [], 'latest', abi, undefined)).text, /the proven ABI \(the recorded proof\) has no description\(\); that it is a view or pure function, which changes no state, is not established/);
});

test('arguments are read by their parameter type, refusing a value the type cannot hold', () => {
  const named = (raw: string) => (raw === 'a-feed' ? FEED : undefined);
  assert.deepEqual(argOf({ kind: 'address' }, 'a-feed', named), { kind: 'address', value: FEED, span });
  assert.deepEqual(argOf({ kind: 'uint', bits: 8 }, '255', named), { kind: 'uint', value: 255n, span });
  assert.throws(() => argOf({ kind: 'uint', bits: 8 }, '256', named), /uint8 takes a number from 0 to 255/);
  assert.throws(() => argOf({ kind: 'address' }, 'nobody', named), /address takes an address or a registry name/);
});

/** Runs pnpm read with no key, so a run that gets past its arguments refuses for the missing key. */
const run = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'read.ts'), ...args], { cwd: ROOT, env: { PATH: process.env.PATH, KISS_SIGN_HOME: join(ROOT, 'no-such-home') }, encoding: 'utf8' });

test('a view that takes an array is refused before its arguments are counted', () => {
  const refused = run('usdc', 'f(uint256[] ids) returns (uint8)');
  assert.equal(refused.status, 64);
  assert.match(refused.stderr, /^f\(uint256\[\]\): parameter ids is uint256\[\]; a view that takes an array or a tuple cannot be called$/m);
});

test('a count mismatch names the arguments the view takes, one in the singular', () => {
  const refused = run('usdc', 'f(uint8 a) returns (uint8)');
  assert.equal(refused.status, 64);
  assert.match(refused.stderr, /^f\(uint8\) takes 1 argument; 0 given$/m);
});

test('a negative number is an argument after --, and an unknown option before it', () => {
  const after = run('usdc', 'f(int8 a) returns (uint8)', '--', '-500');
  assert.equal(after.status, 64);
  assert.match(after.stderr, /argument "-500": int8 takes a number from -128 to 127/);
  const before = run('usdc', 'f(int8 a) returns (uint8)', '-500');
  assert.equal(before.status, 64);
  assert.match(before.stderr, /Unknown option '-5'/);
});
