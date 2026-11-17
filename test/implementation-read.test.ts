import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import type { CallRequest, Reader } from '../src/chain/reader.ts';
import type { BlockRef, BlockTag } from '../src/chain/types.ts';
import { abiCaseBlock, abiCaseReader, replayAbiCase } from '../src/contracts/abi-case.ts';
import type { AbiCase } from '../src/contracts/abi-case.ts';
import { keccakCode, readCodeHistory, readRunningCode } from '../src/contracts/code.ts';
import { describeRefusal } from '../src/contracts/prove.ts';
import type { AbiProof, AbiRefusal } from '../src/contracts/prove.ts';
import { loadRegistry, parseImplementationRead, parseRegistry } from '../src/registry.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { checkCode } from '../src/verify/code.ts';
import { detailText } from '../src/verify/detail-text.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';
import { warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' as Address;
const LIDO = '0x028271e30a695c0527a0c50ca30603fed004cdb0' as Address;
const KERNEL = '0xb8ffc3cd6e7cf5a098a1c92f48009765b24088dc' as Address;
const fixture = readRecording(join(ROOT, 'testdata', 'abi', 'steth.json')) as AbiCase;
const registry = loadRegistry(repoWithTestFixtures('implementation-read'));
const steth = registry.entries.get('steth')!;
const compilers = await warmCompilers([fixture]);
const at = abiCaseBlock(fixture);

const show = (result: AbiProof | AbiRefusal): string => (result.kind === 'proven' ? `proven ${result.contractName}` : `refused: ${describeRefusal(result.refusal)}`);
const word = (address: Address): Hex => `0x${address.slice(2).padStart(64, '0')}` as Hex;

test("stETH, an Aragon proxy no known slot names, is proven through its declared implementation() and the probe", async () => {
  const proof = await replayAbiCase(fixture, compilers);
  assert.equal(show(proof), 'proven Lido');
  assert.equal(proof.kind === 'proven' ? proof.proxy.kind : undefined, 'declared');
  assert.equal(proof.kind === 'proven' ? proof.proven : undefined, LIDO);
  assert.equal(proof.kind === 'proven' ? proof.proxyCodeHash : undefined, steth.code?.current.pin.hash, 'the proof and pnpm pin-code name the same proxy code');
  assert.equal(proof.kind === 'proven' ? proof.codeHash : undefined, steth.code?.current.pin.implementation?.hash, 'and the same implementation code');
});

test('without the declaration, stETH, whose known slots are all empty, is refused: it hands its fallback to code the program does not know', async () => {
  const unset = abiCaseReader(fixture, [], { getStorageAt: async () => ({ kind: 'agreed', value: word(`0x${'0'.repeat(40)}` as Address), providers: fixture.providers }) });
  const read = await readRunningCode(unset, STETH, at);
  assert.equal(read.kind === 'refused' ? `refused: ${describeRefusal(read.refusal)}` : 'read', `refused: ${STETH} hands a call it has no function for, at byte 547 of its code, to code the program neither proves nor pins`);
});

test('pnpm pin-code read every implementation stETH ran since its deployment, each found through the declared read', () => {
  const spans = [...steth.code!.earlier, steth.code!.current];
  assert.deepEqual(
    spans.map((span) => [span.from, span.pin.implementation?.address]),
    [
      [11473216n, '0x20dc62d5904633cc6a5e34bec87a048e80c92e97'],
      [13500147n, '0xc7b5af82b05eb3b64f12241b04b2cf14469e39f7'],
      [14860268n, '0x47ebab13b806773ec2a2d16873e2df770d130b50'],
      [17266004n, '0x17144556fd3424edc8fc8a4c940b2d04936d17eb'],
      [24083113n, '0x6ca84080381e43938476814be61b779a8bb6a600'],
      [25603297n, LIDO],
    ],
  );
});

test('verify passes stETH running its pinned implementation, and refuses another implementation code hash', async () => {
  assert.deepEqual(await checkCode(abiCaseReader(fixture), [steth], at, 'pending'), { kind: 'pass' });
  const raw = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'implementation-read', 'registry', 'contracts.json'), 'utf8'));
  const changed = `0x${'ab'.repeat(32)}`;
  raw.steth.code.implementation.hash = changed;
  const edited = parseRegistry(raw).entries.get('steth')!;
  assert.deepEqual(await checkCode(abiCaseReader(fixture), [edited], at, 'pending'), {
    kind: 'mismatch',
    findings: [`steth ${STETH}'s implementation ${LIDO} has code hash ${steth.code?.current.pin.implementation?.hash} at block ${at.number}, the registry pins ${changed}`],
  });
});

test('a declaration that names a contract the proxy only calls, such as its kernel, fails the probe', async () => {
  const kernel = { implementationRead: parseImplementationRead('steth.implementationRead', [{ function: 'kernel()' }]) };
  const reader = abiCaseReader(fixture, [], {
    call: async (request: CallRequest, ref: BlockRef) => {
      if (request.override !== undefined) return { kind: 'agreed', value: { kind: 'reverted' }, providers: fixture.providers };
      if (request.data === ('0xd4aae0c4' as Hex)) return { kind: 'agreed', value: { kind: 'returned', data: word(KERNEL) }, providers: fixture.providers };
      return abiCaseReader(fixture).call(request, ref);
    },
  });
  const read = await readRunningCode(reader, STETH, at, kernel);
  assert.equal(read.kind === 'refused' ? describeRefusal(read.refusal) : 'read', `a call the proxy has no function for did not run the code at ${KERNEL}, which its implementationRead answers, as the proxy`);
});

test('a view that answers no address is refused before any probe', async () => {
  const appId = { implementationRead: parseImplementationRead('steth.implementationRead', [{ function: 'appId()' }]) };
  const reader = abiCaseReader(fixture, [{ method: 'call', args: [STETH, '0x80afdea8'], value: { kind: 'returned', data: '0x3ca7c3e38968823ccb4c78ea688df41356f182ae1d159e4ee608d30d68cef320' } }]);
  const read = await readRunningCode(reader, STETH, at, appId);
  assert.equal(read.kind === 'refused' ? describeRefusal(read.refusal) : 'read', `appId() on ${STETH}, a view of the entry's implementationRead, did not answer one nonzero address other than the proxy's own`);
});

/** A fallback that delegates at byte 12 to the address in slot 0, then at byte 26 to the address in slot 1. */
const TWO_DELEGATIONS = '0x60006000600060006000545af45060006000600060006001545af45000' as Hex;

/** A fallback that delegates nowhere and returns the 32 bytes after the selector, so it could answer any word asked. */
const NO_DELEGATION = '0x60206004600037602060006000f3' as Hex;

test('a fallback that hands its call to no other code is refused, whatever the probe would answer', async () => {
  const reader = abiCaseReader(fixture, [], { getCode: async () => ({ kind: 'agreed', value: NO_DELEGATION, providers: fixture.providers }) });
  const read = await readRunningCode(reader, STETH, at, steth);
  assert.equal(read.kind === 'refused' ? describeRefusal(read.refusal) : 'read', `${STETH} runs a call it has no function for without handing it to other code, so its implementationRead names no code it runs`);
});

test('a fallback with a second delegation the probe cannot account for is refused, whatever the views answer', async () => {
  const reader = abiCaseReader(fixture, [], { getCode: async () => ({ kind: 'agreed', value: TWO_DELEGATIONS, providers: fixture.providers }) });
  const read = await readRunningCode(reader, STETH, at, steth);
  assert.equal(read.kind === 'refused' ? describeRefusal(read.refusal) : 'read', `${STETH} hands a call it has no function for, at byte 26 of its code, to code the program neither proves nor pins`);
});

/** What the probe code returns when it runs as the proxy: the word its PUSH32 holds, after its first 32 bytes. */
const probeAnswer = (code: Hex): Hex => `0x${code.slice(2 + 32 * 2, 2 + 32 * 2 + 64)}` as Hex;
const ONE_DELEGATION = '0x60006000600060006000545af45000' as Hex;
const A = `0x${'a'.repeat(40)}` as Address;
const B = `0x${'b'.repeat(40)}` as Address;

/** A proxy with one delegation whose implementation() is A before block 250 and B from it, at a head of 400; it has code from block 100. */
function upgradedProxy(): Reader {
  const agreed = <T>(value: T) => ({ kind: 'agreed', value, providers: ['alchemy', 'drpc'] }) as const;
  const implementation = (n: bigint): Address => (n < 250n ? A : B);
  return {
    ...abiCaseReader(fixture),
    block: async (tag: BlockTag) => agreed({ number: tag === 'latest' ? 400n : tag, hash: `0x${'00'.repeat(32)}` as Hex }),
    getCode: async (address: Address, ref: BlockRef) => agreed((address === STETH ? (ref.number < 100n ? '0x' : ONE_DELEGATION) : address === A ? '0x6001' : '0x6002') as Hex),
    call: async (request: CallRequest, ref: BlockRef) => {
      const runs = implementation(ref.number);
      if (request.override === undefined) return agreed({ kind: 'returned', data: word(runs) } as const);
      return agreed(request.override.address === runs ? ({ kind: 'returned', data: probeAnswer(request.override.code) } as const) : ({ kind: 'reverted' } as const));
    },
  };
}

test("pnpm pin-code's search finds each implementation a declared read answered, and where it started", async () => {
  const head = { hash: keccakCode(ONE_DELEGATION), implementation: { address: B, hash: keccakCode('0x6002' as Hex) } };
  const history = await readCodeHistory(upgradedProxy(), STETH, 400n, head, steth);
  assert.equal(history.kind, 'read');
  assert.deepEqual(
    history.kind === 'read' ? [...history.pins.earlier, history.pins.current].map((span) => [span.from, span.pin.implementation?.address]) : [],
    [
      [100n, A],
      [250n, B],
    ],
  );
});

test('an implementationRead is refused beside routes, with a parameter type it cannot hold, or with arguments that do not fit', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'implementation-read', 'registry', 'contracts.json'), 'utf8'));
  const refusal = (implementationRead: unknown, more: Record<string, unknown> = {}): string => {
    try {
      parseRegistry({ steth: { ...raw.steth, implementationRead, ...more } });
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail('accepted');
  };
  const view = { function: 'implementation()' };
  assert.equal(refusal([]), 'steth.implementationRead: not a list of 1 to 3 views');
  assert.equal(refusal([view, view, view, view]), 'steth.implementationRead: not a list of 1 to 3 views');
  assert.equal(refusal([{ function: 'getApp(bytes32,string)', args: [`0x${'0'.repeat(64)}`, 'x'] }]), 'steth.implementationRead[0].function: may take only address, bytes32, uint256');
  assert.equal(refusal([{ function: 'getApp(bytes32,bytes32)', args: [`0x${'0'.repeat(64)}`] }]), 'steth.implementationRead[0].args: not 2 arguments');
  assert.equal(refusal([{ function: 'getApp(bytes32)', args: null }]), 'steth.implementationRead[0].args: not 1 arguments');
  assert.equal(refusal([{ function: 'getApp(bytes32)', args: ['0x01'] }]), 'steth.implementationRead[0].args[0]: not a lowercase 32-byte word');
  assert.equal(refusal([{ function: 'implementationOf(address)', args: [`0x${'f'.repeat(64)}`] }]), 'steth.implementationRead[0].args[0]: not an address word');
  assert.equal(refusal([{ ...view, label: 'x' }]), 'steth.implementationRead[0].label: unexpected field');
  const routes = { implementationOf: 'getSigsImplementation(bytes4)', selectorsOf: 'getImplementationSigs(address)', seeds: ['0xad967e15'] };
  assert.equal(refusal([view], { routes, code: undefined }), 'steth.implementationRead: beside routes, which name the code each selector runs');
  const { implementation: _, ...bare } = raw.steth.code;
  assert.equal(refusal([view], { code: bare }), 'steth.code: names no implementation, though the entry declares implementationRead');
});

test('the refusals of a declared read read in Traditional Chinese', () => {
  assert.equal(
    detailText(`steth ${STETH} at block 9: appId() on ${STETH}, a view of the entry's implementationRead, did not answer one nonzero address other than the proxy's own`, 'zh-TW'),
    `steth ${STETH} 在區塊 9：${STETH} 的 appId()（登記項目 implementationRead 的一個 view）沒有回答一個不是零、也不是 proxy 自己的地址`,
  );
  assert.equal(
    detailText(`steth ${STETH} at block 9: a call the proxy has no function for did not run the code at ${KERNEL}, which its implementationRead answers, as the proxy`, 'zh-TW'),
    `steth ${STETH} 在區塊 9：proxy 沒有對應函式的呼叫，沒有以 proxy 的身分執行 implementationRead 回答的 ${KERNEL} 的程式碼`,
  );
});
