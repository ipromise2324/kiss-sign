import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import type { Reader } from '../src/chain/reader.ts';
import { abiCaseBlock, abiCaseReader } from '../src/contracts/abi-case.ts';
import type { AbiCase, RecordedRead } from '../src/contracts/abi-case.ts';
import { keccakCode, pinOf, readCodeHistory, readRunningCode } from '../src/contracts/code.ts';
import { describeRefusal } from '../src/contracts/prove.ts';
import type { AbiProof } from '../src/contracts/prove.ts';
import { pinVerdict } from '../src/research/report.ts';
import type { RegistryEntry } from '../src/registry.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { checkCode } from '../src/verify/code.ts';
import { detailText } from '../src/verify/detail-text.ts';
import { parseRegistryAt } from './registry-at.ts';

const ROOT = join(import.meta.dirname, '..');
const fixture = readRecording(join(ROOT, 'testdata', 'abi', 'compound-v3-cusdcv3.json')) as AbiCase;
const at = abiCaseBlock(fixture);
const COMET = fixture.address;
const IMPLEMENTATION = '0x0b07565a8ef48170e15918b251ebd95109b23255' as Address;
const EXTENSION = '0xa70a0227028ad005f4fc9376a82cd1462e3aaedc' as Address;
const OTHER = `0x${'0e'.repeat(20)}` as Address;
const REGISTRY = JSON.parse(readFileSync(join(ROOT, 'registry', 'contracts.json'), 'utf8')) as Record<string, Record<string, unknown>>;
const FLUID_DELEGATOR = (readRecording(join(ROOT, 'testdata', 'abi', 'fluid-token.json')) as AbiCase).reads[0]!.value as Hex;

const codeOf = (address: Address): Hex => fixture.reads.find((read) => read.method === 'getCode' && read.args[0] === address)!.value as Hex;
const PIN = {
  hash: keccakCode(codeOf(COMET)),
  implementation: { address: IMPLEMENTATION, hash: keccakCode(codeOf(IMPLEMENTATION)), extension: { address: EXTENSION, hash: keccakCode(codeOf(EXTENSION)) } },
};

const cometWith = (code: Record<string, unknown>): RegistryEntry =>
  parseRegistryAt(ROOT, { ...REGISTRY, 'comet-usdc': { address: COMET, kind: 'lending', source: 'https://docs.example.org/comet', code } }).entries.get('comet-usdc')!;
const chainWith = (codes: Readonly<Record<string, Hex>>) => abiCaseReader(fixture, Object.entries(codes).map(([address, value]): RecordedRead => ({ method: 'getCode', args: [address], value })));
const refused = async (codes: Readonly<Record<string, Hex>>): Promise<string> => {
  const read = await readRunningCode(chainWith(codes), COMET, at);
  return read.kind === 'refused' ? describeRefusal(read.refusal) : 'read';
};

/** The findings of the code check, each of which reads in Traditional Chinese. */
async function findings(code: Record<string, unknown>, codes: Readonly<Record<string, Hex>> = {}): Promise<readonly string[]> {
  const check = await checkCode(chainWith(codes), [cometWith(code)], at, 'pending');
  const found = check.kind === 'mismatch' ? check.findings : [check.kind];
  for (const finding of found) assert.notEqual(detailText(finding, 'zh-TW'), finding, `reads in Traditional Chinese: ${finding}`);
  return found;
}

const where = `comet-usdc ${COMET}`;
const block = `at block ${at.number}`;

test("pin-code pins Comet's proxy, its implementation, and the extension the implementation hands a call it has no function for to", async () => {
  const read = await readRunningCode(abiCaseReader(fixture), COMET, at);
  assert.deepEqual(read.kind === 'read' ? pinOf(read.code) : read, PIN);
});

test('a pin with the extension parses as written, and an extension with any other key is refused', () => {
  assert.deepEqual(cometWith({ ...PIN, from: 1 }).code?.current.pin, PIN);
  assert.throws(() => cometWith({ ...PIN, implementation: { ...PIN.implementation, extension: { ...PIN.implementation.extension, routes: [] } } }), {
    message: 'comet-usdc.code.implementation.extension.routes: unexpected field',
  });
});

test('verify passes Comet when its implementation and extension run the pinned code', async () => {
  assert.deepEqual(await checkCode(abiCaseReader(fixture), [cometWith(PIN)], at, 'pending'), { kind: 'pass' });
});

test("verify refuses an extension whose code differs from its pin, whether the chain's code or the pin's hash changed", async () => {
  const other = '0x6000' as Hex;
  assert.deepEqual(await findings(PIN, { [EXTENSION]: other }), [`${where}'s extension ${EXTENSION} has code hash ${keccakCode(other)} ${block}, the registry pins ${PIN.implementation.extension.hash}`]);
  const changed = `0x${'ab'.repeat(32)}` as Hex;
  assert.deepEqual(await findings({ ...PIN, implementation: { ...PIN.implementation, extension: { address: EXTENSION, hash: changed } } }), [
    `${where}'s extension ${EXTENSION} has code hash ${PIN.implementation.extension.hash} ${block}, the registry pins ${changed}`,
  ]);
});

test('verify refuses a pin that names another extension, or none, for the implementation it pins', async () => {
  const of = `${where}'s implementation ${IMPLEMENTATION}`;
  assert.deepEqual(await findings({ ...PIN, implementation: { ...PIN.implementation, extension: { ...PIN.implementation.extension, address: OTHER } } }), [
    `${of} hands a call it has no function for to ${EXTENSION} ${block}, the registry pins ${OTHER}`,
  ]);
  const { extension: _, ...bare } = PIN.implementation;
  assert.deepEqual(await findings({ ...PIN, implementation: bare }), [`${of} hands a call it has no function for to ${EXTENSION} ${block}, the registry pins no extension`]);
});

test('verify refuses an extension the pinned implementation no longer hands a call to', async () => {
  const plain = '0x6000' as Hex;
  const pin = { ...PIN, implementation: { ...PIN.implementation, hash: keccakCode(plain) } };
  assert.deepEqual(await findings(pin, { [IMPLEMENTATION]: plain }), [
    `${where}'s implementation ${IMPLEMENTATION} no longer hands a call it has no function for to ${EXTENSION} ${block}, the registry pins that extension`,
  ]);
});

test('an extension that hands a call on again, or has no code, is refused, so the extension is the last code a call reaches', async () => {
  assert.equal(await refused({ [EXTENSION]: FLUID_DELEGATOR }), `${EXTENSION} hands a call it has no function for, at byte 156 of its code, to code the program neither proves nor pins`);
  assert.equal(await refused({ [EXTENSION]: '0x' as Hex }), `${EXTENSION} has no code`);
  const pin = { ...PIN, implementation: { ...PIN.implementation, extension: { address: EXTENSION, hash: keccakCode(FLUID_DELEGATOR) } } };
  assert.deepEqual(await findings(pin, { [EXTENSION]: FLUID_DELEGATOR }), [
    `${where} ${block}: ${EXTENSION} hands a call it has no function for, at byte 156 of its code, to code the program neither proves nor pins`,
  ]);
});

test('verify and pin-code refuse an implementation that is a minimal proxy, and an extension that is one or an EIP-7702 delegation', async () => {
  const clone = `0x363d3d373d3d3d363d73${EXTENSION.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
  const chained = `${IMPLEMENTATION}, code a call runs, is itself a proxy or an EIP-7702 delegation`;
  assert.equal(await refused({ [IMPLEMENTATION]: clone }), chained);
  const clonePin = { ...PIN, implementation: { ...PIN.implementation, hash: keccakCode(clone) } };
  assert.deepEqual(await findings(clonePin, { [IMPLEMENTATION]: clone }), [`${where} ${block}: ${chained}`]);
  for (const code of [`0xef0100${OTHER.slice(2)}`, `0x363d3d373d3d3d363d73${OTHER.slice(2)}5af43d82803e903d91602b57fd5bf3`] as Hex[]) {
    const extended = `${EXTENSION}, code a call runs, is itself a proxy or an EIP-7702 delegation`;
    assert.equal(await refused({ [EXTENSION]: code }), extended);
    const pin = { ...PIN, implementation: { ...PIN.implementation, extension: { address: EXTENSION, hash: keccakCode(code) } } };
    assert.deepEqual(await findings(pin, { [EXTENSION]: code }), [`${where} ${block}: ${extended}`]);
  }
});

test('an implementation that hands calls to two constant addresses is refused; one address at two places is one extension', async () => {
  const delegateTo = (address: Address) => `5f5f365f73${address.slice(2)}5af450`;
  const two = `0x${delegateTo(EXTENSION)}${delegateTo(OTHER)}00` as Hex;
  const second = delegateTo(EXTENSION).length / 2 + 26;
  assert.equal(await refused({ [IMPLEMENTATION]: two }), `${IMPLEMENTATION} hands a call it has no function for, at byte ${second} of its code, to code the program neither proves nor pins`);
  const twice = `0x${delegateTo(EXTENSION)}${delegateTo(EXTENSION)}00` as Hex;
  const read = await readRunningCode(chainWith({ [IMPLEMENTATION]: twice }), COMET, at);
  assert.equal(read.kind === 'read' ? read.code.extension?.address : read.refusal.why, EXTENSION);
});

test("the report's check that the pin names the code the ABI proof compiled covers the extension", () => {
  const proof = (extension: object | undefined) =>
    ({ kind: 'proven', proxy: { kind: 'eip1967', implementation: IMPLEMENTATION }, proven: IMPLEMENTATION, proxyCodeHash: PIN.hash, codeHash: PIN.implementation.hash, extension }) as unknown as AbiProof;
  const compiled = proof({ address: EXTENSION, codeHash: PIN.implementation.extension.hash });
  const { extension: _, ...bare } = PIN.implementation;
  assert.equal(pinVerdict(cometWith(PIN), compiled), 'PASS');
  assert.equal(pinVerdict(cometWith({ ...PIN, implementation: bare }), compiled), 'FINDING');
  assert.equal(pinVerdict(cometWith(PIN), proof({ address: EXTENSION, codeHash: `0x${'ab'.repeat(32)}` })), 'FINDING');
  assert.equal(pinVerdict(cometWith(PIN), proof(undefined)), 'FINDING');
});

test('pin-code finds the block an implementation started handing calls to another extension, so each extension starts a span', async () => {
  const clone = `0x${'c1'.repeat(20)}` as Address;
  const delegateTo = (address: Address) => `0x5f5f365f5f73${address.slice(2)}5af400` as Hex;
  const codeAt = (address: Address, n: bigint): Hex => {
    if (n < 100n) return '0x' as Hex;
    if (address === clone) return `0x363d3d373d3d3d363d73${IMPLEMENTATION.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
    return address === IMPLEMENTATION ? delegateTo(n < 250n ? EXTENSION : OTHER) : ('0x6000' as Hex);
  };
  const agreed = <T>(value: T) => ({ kind: 'agreed', value, providers: fixture.providers }) as const;
  const reader = {
    providers: fixture.providers,
    block: async (n: bigint) => agreed({ number: n, hash: `0x${'00'.repeat(32)}` as Hex }),
    getCode: async (address: Address, ref: { readonly number: bigint }) => agreed(codeAt(address, ref.number)),
  } as unknown as Reader;
  const pin = (extension: Address) => ({
    hash: keccakCode(codeAt(clone, 400n)),
    implementation: { address: IMPLEMENTATION, hash: keccakCode(delegateTo(extension)), extension: { address: extension, hash: keccakCode('0x6000' as Hex) } },
  });
  assert.deepEqual(await readCodeHistory(reader, clone, 400n, pin(OTHER)), {
    kind: 'read',
    pins: { earlier: [{ from: 100n, pin: pin(EXTENSION) }], current: { from: 250n, pin: pin(OTHER) } },
    before: { why: 'no-code', at: clone },
  });
});
