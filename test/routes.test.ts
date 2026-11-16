import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hexToBytes } from '@noble/hashes/utils.js';
import { MULTICALL3 } from '../src/chain/multicall.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import type { Reader } from '../src/chain/reader.ts';
import type { BlockRef, BlockTag, CallResult } from '../src/chain/types.ts';
import { keccakCode, readCodeHistory, readRunningCode } from '../src/contracts/code.ts';
import { describeRefusal } from '../src/contracts/prove.ts';
import { EIP1967_IMPLEMENTATION_SLOT } from '../src/contracts/proxy.ts';
import { parseFunctionSignature } from '../src/decode/abi.ts';
import { decodeCall, encodeCall, wholeRegion } from '../src/decode/codec.ts';
import type { AbiValue } from '../src/decode/codec.ts';
import { parseRegistry } from '../src/registry.ts';
import type { RegistryEntry } from '../src/registry.ts';
import { checksumAddress } from '../src/safe/types.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { checkToday } from '../src/research/report.ts';
import { checkCode } from '../src/verify/code.ts';
import { evaluate } from '../src/verify/verify.ts';
import type { VerdictFile } from '../src/verify/verify.ts';

const ROOT = join(import.meta.dirname, '..');
const REGISTRY = JSON.parse(readFileSync(join(ROOT, 'registry', 'contracts.json'), 'utf8')) as Record<string, Record<string, unknown>>;

const PROXY = `0x${'52'.repeat(20)}` as Address;
const DUMMY = `0x${'cc'.repeat(20)}` as Address;
const A = `0x${'0a'.repeat(20)}` as Address;
const B = `0x${'0b'.repeat(20)}` as Address;
const C = `0x${'0c'.repeat(20)}` as Address;
const selector = (n: number): Hex => `0x${n.toString(16).padStart(8, '0')}` as Hex;
const [S1, S2, S3, S4, S5] = [selector(1), selector(2), selector(3), selector(4), selector(5)] as const;
const HEAD = 400n;
const AT: BlockRef = { number: HEAD, hash: `0x${'00'.repeat(32)}` as Hex };
const IMPLEMENTATION_OF = parseFunctionSignature('getSigsImplementation(bytes4)');
const SELECTORS_OF = parseFunctionSignature('getImplementationSigs(address)');
const AGGREGATE = parseFunctionSignature('aggregate((address,bytes)[])');

type Proxied = { readonly codes: Readonly<Record<string, string>>; readonly implementationOf: Readonly<Record<string, Address>>; readonly selectorsOf: Readonly<Record<string, readonly Hex[]>> };

const TODAY: Proxied = {
  codes: { [PROXY]: '0x6000f4', [DUMMY]: '0x6001', [A]: '0x600a', [B]: '0x600b' },
  implementationOf: { [S1]: A, [S2]: A, [S3]: B, [S4]: B },
  selectorsOf: { [A]: [S2, S1], [B]: [S3, S4] },
};

const span = [0, 0] as const;
const returned = (signature: string, args: readonly AbiValue[]): Uint8Array => encodeCall({ fn: parseFunctionSignature(signature), args, trailer: undefined }).subarray(4);
const addressWord = (address: Address): Uint8Array => returned('r(address)', [{ kind: 'address', value: address, span }]);
const selectorList = (selectors: readonly Hex[]): Uint8Array => returned('r(bytes4[])', [{ kind: 'array', items: selectors.map((value) => ({ kind: 'fixed-bytes', value, span })), span }]);
const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as Address;

type Tweaks = {
  readonly answer?: (call: 'implementationOf' | 'selectorsOf', argument: string, honest: Uint8Array) => Uint8Array;
  readonly batch?: 'reverted' | 'disagree' | 'no-multicall';
};

function chain(state: (block: bigint) => Proxied, tweaks: Tweaks = {}): Reader {
  const agreed = <T>(value: T) => ({ kind: 'agreed', value, providers: ['alchemy', 'drpc'] }) as const;
  const word = (address: Address): Hex => `0x${'00'.repeat(12)}${address.slice(2)}` as Hex;
  return {
    providers: ['alchemy', 'drpc'],
    block: async (tag: BlockTag) => agreed({ number: tag === 'latest' ? HEAD : tag, hash: AT.hash }),
    getCode: async (address: Address, at: BlockRef) => agreed(state(at.number).codes[address] ?? '0x'),
    getStorageAt: async (address: Address, slot: bigint, at: BlockRef) =>
      agreed(address === PROXY && slot === EIP1967_IMPLEMENTATION_SLOT && state(at.number).codes[PROXY] !== undefined ? word(DUMMY) : word(ZERO_ADDRESS)),
    call: async ({ to, data }: { to: Address; data: Hex }, at: BlockRef) => {
      if (tweaks.batch === 'disagree') return { kind: 'unverifiable', reason: 'eth_call: alchemy and drpc disagree', answers: [] };
      if (tweaks.batch === 'reverted') return agreed<CallResult>({ kind: 'reverted' });
      if (tweaks.batch === 'no-multicall') return agreed<CallResult>({ kind: 'returned', data: '0x' as Hex });
      assert.equal(to, MULTICALL3);
      const batch = decodeCall(AGGREGATE, wholeRegion(hexToBytes(data.slice(2))));
      assert.equal(batch.kind, 'decoded');
      const calls = batch.kind === 'decoded' && batch.args[0]?.kind === 'array' ? batch.args[0].items : [];
      const { implementationOf, selectorsOf } = state(at.number);
      const answers = calls.map((call) => {
        const [target, callData] = call.kind === 'tuple' ? call.fields : [];
        assert.ok(target?.kind === 'address' && target.value === PROXY && callData?.kind === 'bytes');
        const asked = decodeCall(IMPLEMENTATION_OF, wholeRegion(callData.value));
        if (asked.kind === 'decoded' && asked.args[0]?.kind === 'fixed-bytes') {
          const selector = asked.args[0].value;
          return tweaks.answer?.('implementationOf', selector, addressWord(implementationOf[selector] ?? ZERO_ADDRESS)) ?? addressWord(implementationOf[selector] ?? ZERO_ADDRESS);
        }
        const listed = decodeCall(SELECTORS_OF, wholeRegion(callData.value));
        assert.ok(listed.kind === 'decoded' && listed.args[0]?.kind === 'address');
        const implementation = listed.args[0].value;
        return tweaks.answer?.('selectorsOf', implementation, selectorList(selectorsOf[implementation] ?? [])) ?? selectorList(selectorsOf[implementation] ?? []);
      });
      const answer = returned('r(uint256,bytes[])', [
        { kind: 'uint', value: at.number, span },
        { kind: 'array', items: answers.map((value) => ({ kind: 'bytes', value, span })), span },
      ]);
      return agreed<CallResult>({ kind: 'returned', data: `0x${Buffer.from(answer).toString('hex')}` as Hex });
    },
  } as unknown as Reader;
}

const hash = (code: string): Hex => keccakCode(code as Hex);
const ROUTING = { implementationOf: 'getSigsImplementation(bytes4)', selectorsOf: 'getImplementationSigs(address)', seeds: [S3, S1] };
const routeJson = (address: Address, code: string, selectors: readonly Hex[]) => ({ address: checksumAddress(address), hash: hash(code), selectors });
const TODAY_PIN = {
  hash: hash('0x6000f4'),
  implementation: { address: checksumAddress(DUMMY), hash: hash('0x6001') },
  routes: [routeJson(A, '0x600a', [S2, S1]), routeJson(B, '0x600b', [S3, S4])],
};

function registryWith(liquidity: Record<string, unknown>, more: Record<string, Record<string, unknown>> = {}) {
  return parseRegistry({ ...REGISTRY, ...more, liquidity: { address: PROXY, kind: 'lending', source: 'https://docs.example.org/liquidity', routes: ROUTING, ...liquidity } });
}

const LIQUIDITY = registryWith({ code: { ...TODAY_PIN, from: 100 } }).entries.get('liquidity') as RegistryEntry;
const refusal = (raw: Record<string, unknown>, more?: Record<string, Record<string, unknown>>) => {
  try {
    registryWith(raw, more);
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail('the registry was accepted');
};

test('routes name a bytes4 view and an address view, and 1 to 16 distinct lowercase seeds', () => {
  assert.deepEqual(LIQUIDITY.routes?.seeds, [S3, S1]);
  assert.equal(refusal({ routes: { ...ROUTING, implementationOf: 'getSigsImplementation(address)' } }), 'liquidity.routes.implementationOf: must take exactly one bytes4');
  assert.equal(refusal({ routes: { ...ROUTING, implementationOf: 'getSigsImplementation(bytes32)' } }), 'liquidity.routes.implementationOf: must take exactly one bytes4');
  assert.equal(refusal({ routes: { ...ROUTING, selectorsOf: 'getImplementationSigs(address,uint256)' } }), 'liquidity.routes.selectorsOf: must take exactly one address');
  assert.equal(refusal({ routes: { ...ROUTING, seeds: ['0xAD967E15'] } }), 'liquidity.routes.seeds[0]: not a lowercase 4-byte selector');
  assert.equal(refusal({ routes: { ...ROUTING, seeds: [S1, S1] } }), `liquidity.routes.seeds[1]: ${S1} is listed twice`);
  assert.equal(refusal({ routes: { ...ROUTING, seeds: [] } }), 'liquidity.routes.seeds: not a list of 1 to 16 selectors');
  assert.equal(refusal({ routes: { ...ROUTING, seeds: Array.from({ length: 17 }, (_, i) => selector(i)) } }), 'liquidity.routes.seeds: not a list of 1 to 16 selectors');
  assert.equal(refusal({ routes: { ...ROUTING, list: 'getImplementations()' } }), 'liquidity.routes.list: unexpected field');
});

test('a pin holds routes on every span exactly when its entry declares them, sorted, with no selector twice and every seed listed', () => {
  const { routes: _, ...unrouted } = TODAY_PIN;
  assert.equal(refusal({ code: unrouted }), 'liquidity.code.routes: missing, though the entry declares routes; remove the code pin and run pnpm pin-code');
  assert.equal(refusal({ code: { ...TODAY_PIN, from: 250, earlier: [{ from: 100, ...unrouted }] } }), 'liquidity.code.earlier[0].routes: missing, though the entry declares routes; remove the code pin and run pnpm pin-code');
  assert.equal(refusal({ routes: undefined, code: TODAY_PIN }), 'liquidity.code.routes: the entry declares no routes');
  const [a, b] = TODAY_PIN.routes as [ReturnType<typeof routeJson>, ReturnType<typeof routeJson>];
  assert.equal(refusal({ code: { ...TODAY_PIN, routes: [b, a] } }), `liquidity.code.routes[1].address: not after ${B}: routes are sorted by address, each implementation once`);
  assert.equal(refusal({ code: { ...TODAY_PIN, routes: [a, a] } }), `liquidity.code.routes[1].selectors[0]: ${S2} is in another route too`);
  assert.equal(refusal({ code: { ...TODAY_PIN, routes: [a, { ...b, selectors: [S3, S1] }] } }), `liquidity.code.routes[1].selectors[1]: ${S1} is in another route too`);
  assert.equal(refusal({ code: { ...TODAY_PIN, routes: [a, { ...b, selectors: [] }] } }), 'liquidity.code.routes[1].selectors: not a non-empty list of selectors');
  assert.equal(refusal({ code: { ...TODAY_PIN, routes: [a] } }), `liquidity.code.routes: no route lists the seed ${S3}, which then routes nowhere`);
  const unseeded = routeJson(C, '0x600c', [S5]);
  assert.equal(refusal({ code: { ...TODAY_PIN, routes: [a, b, unseeded] } }), 'liquidity.code.routes[2]: lists no seed, and pnpm pin-code reaches an implementation only through a seed');
  assert.doesNotThrow(() => registryWith({ code: { ...TODAY_PIN, from: 250, earlier: [{ from: 100, ...TODAY_PIN, routes: [a, b, unseeded] }] } }), 'an earlier span read with other seeds may hold one');
  const zero = { ...routeJson(ZERO_ADDRESS, '0x', [S5]) };
  assert.equal(refusal({ code: { ...TODAY_PIN, from: 250, earlier: [{ from: 100, ...TODAY_PIN, routes: [zero, a, b] }] } }), 'liquidity.code.earlier[0].routes[0].address: the zero address, which a selector that routes nowhere answers, is no implementation');
  assert.doesNotThrow(() => registryWith({ code: { ...TODAY_PIN, from: 250, earlier: [{ from: 100, ...TODAY_PIN, routes: [] }] } }), 'an earlier span may reach no implementation');
});

test('dependsOn names 1 to 8 other registry entries, none of which depends on another', () => {
  const registry = registryWith({ code: TODAY_PIN }, { dependent: { ...REGISTRY.bundler3, address: `0x${'d0'.repeat(20)}`, dependsOn: ['liquidity'] } });
  assert.deepEqual(registry.entries.get('dependent')?.dependsOn, ['liquidity']);
  assert.equal(refusal({ dependsOn: ['nothing-here'] }), 'liquidity.dependsOn[0]: "nothing-here" is not in the registry');
  assert.equal(refusal({ dependsOn: ['liquidity'] }), 'liquidity.dependsOn[0]: names the entry itself');
  assert.equal(refusal({ dependsOn: ['usdc', 'usdc'] }), 'liquidity.dependsOn[1]: usdc is listed twice');
  assert.equal(refusal({ dependsOn: [] }), 'liquidity.dependsOn: not a list of 1 to 8 registry names');
  assert.equal(refusal({ dependsOn: 'usdc' }), 'liquidity.dependsOn: not a list of 1 to 8 registry names');
  assert.equal(
    refusal({ code: TODAY_PIN, dependsOn: ['usdc'] }, { dependent: { ...REGISTRY.bundler3, address: `0x${'d0'.repeat(20)}`, dependsOn: ['liquidity'] } }),
    'dependent.dependsOn[0]: liquidity depends on other entries itself; a dependency is one step deep',
  );
});

test('the pin of a selector-routed proxy holds each implementation its seeds reach, sorted by address, with its code hash and selectors as listed', async () => {
  const read = await readRunningCode(chain(() => TODAY), PROXY, AT, LIQUIDITY.routes);
  assert.equal(read.kind, 'read');
  assert.deepEqual(read.kind === 'read' ? read.code.routes : undefined, [
    { address: A, hash: hash('0x600a'), selectors: [S2, S1] },
    { address: B, hash: hash('0x600b'), selectors: [S3, S4] },
  ]);
  const withoutRouting = await readRunningCode(chain(() => TODAY), PROXY, AT);
  assert.equal(withoutRouting.kind === 'read' ? withoutRouting.code.routes : 'refused', undefined, 'an entry without routes reads none');
});

const refusedRead = async (state: Proxied, tweaks?: Tweaks): Promise<string> => {
  const read = await readRunningCode(chain(() => state, tweaks), PROXY, AT, LIQUIDITY.routes);
  return read.kind === 'refused' ? describeRefusal(read.refusal) : assert.fail('the routes were read');
};

test('routes that do not agree with themselves, an implementation with no code, a malformed answer or a revert refuse the read', async () => {
  assert.equal(await refusedRead({ ...TODAY, implementationOf: { ...TODAY.implementationOf, [S2]: B } }), `the routes are inconsistent: ${A} lists ${S2}, which routes to ${B}`);
  assert.equal(await refusedRead({ ...TODAY, implementationOf: { ...TODAY.implementationOf, [S4]: ZERO_ADDRESS } }), `the routes are inconsistent: ${B} lists ${S4}, which routes to no implementation`);
  assert.equal(await refusedRead({ ...TODAY, selectorsOf: { ...TODAY.selectorsOf, [A]: [S2] } }), `the routes are inconsistent: ${S1} routes to ${A}, whose selector list does not hold it`);
  assert.equal(await refusedRead({ ...TODAY, selectorsOf: { ...TODAY.selectorsOf, [A]: [S2, S1, S3] } }), `the routes are inconsistent: ${A} and ${B} both list ${S3}`);
  assert.equal(await refusedRead({ ...TODAY, selectorsOf: { ...TODAY.selectorsOf, [A]: [S2, S1, S2] } }), `the routes are inconsistent: ${A} lists ${S2} twice`);
  assert.equal(await refusedRead({ ...TODAY, codes: { ...TODAY.codes, [B]: '0x' } }), `${B} has no code`);
  const dirty = (honest: Uint8Array) => Uint8Array.from(honest, (byte, i) => (i === 0 ? 1 : byte));
  assert.equal(await refusedRead(TODAY, { answer: (call, _, honest) => (call === 'implementationOf' ? dirty(honest) : honest) }), `getSigsImplementation(${S3}) answered something other than its canonical encoding`);
  const padded = (honest: Uint8Array) => Uint8Array.from(honest, (byte, i) => (i === honest.length - 1 ? 1 : byte));
  assert.equal(await refusedRead(TODAY, { answer: (call, _, honest) => (call === 'selectorsOf' ? padded(honest) : honest) }), `getImplementationSigs(${A}) answered something other than its canonical encoding`);
  assert.equal(await refusedRead(TODAY, { batch: 'reverted' }), 'a Multicall3 batch of route reads reverted');
  assert.equal(await refusedRead(TODAY, { batch: 'no-multicall' }), 'Multicall3 has no code at this block, so the routes cannot be read');
});

test('pin-code finds the block an implementation was added to the routes, so each route change starts a span', async () => {
  const before: Proxied = { codes: TODAY.codes, implementationOf: { [S1]: A, [S2]: A }, selectorsOf: { [A]: [S2, S1] } };
  const state = (block: bigint): Proxied => (block < 100n ? { codes: {}, implementationOf: {}, selectorsOf: {} } : block < 250n ? before : TODAY);
  const history = await readCodeHistory(chain(state), PROXY, HEAD, LIQUIDITY.code!.current.pin, LIQUIDITY.routes);
  const pin = (routes: unknown) => ({ hash: hash('0x6000f4'), implementation: { address: DUMMY, hash: hash('0x6001') }, routes });
  assert.deepEqual(history, {
    kind: 'read',
    pins: {
      earlier: [{ from: 100n, pin: pin([{ address: A, hash: hash('0x600a'), selectors: [S2, S1] }]) }],
      current: { from: 250n, pin: pin([{ address: A, hash: hash('0x600a'), selectors: [S2, S1] }, { address: B, hash: hash('0x600b'), selectors: [S3, S4] }]) },
    },
    before: { why: 'no-code', at: PROXY },
  });
});

const verifyAgainst = (state: Proxied, tweaks?: Tweaks, entry: RegistryEntry = LIQUIDITY, at: BlockRef = AT, time: 'pending' | 'executed' = 'pending') =>
  checkCode(chain(() => state, tweaks), [entry], at, time);
const where = `liquidity ${PROXY}`;

test('verify passes a selector-routed proxy whose routes are the pinned ones', async () => {
  assert.deepEqual(await verifyAgainst(TODAY), { kind: 'pass' });
});

test('verify refuses routes that changed since the pin, naming each change', async () => {
  const cases: readonly [string, Proxied, string[]][] = [
    [
      'a seed now reaches a new implementation',
      { codes: { ...TODAY.codes, [C]: '0x600c' }, implementationOf: { ...TODAY.implementationOf, [S3]: C }, selectorsOf: { ...TODAY.selectorsOf, [B]: [S4], [C]: [S3] } },
      [`${where} routes no seed to ${B} at block 400, an implementation the registry pins`, `${where} routes selectors to ${C} at block 400, an implementation the registry does not pin`],
    ],
    ['an implementation was removed', { ...TODAY, implementationOf: { [S1]: A, [S2]: A }, selectorsOf: { [A]: [S2, S1] } }, [`${where} routes no seed to ${B} at block 400, an implementation the registry pins`]],
    ['an implementation has other code', { ...TODAY, codes: { ...TODAY.codes, [A]: '0x60aa' } }, [`${where}'s routed implementation ${A} has code hash ${hash('0x60aa')} at block 400, the registry pins ${hash('0x600a')}`]],
    [
      'an implementation serves another selector',
      { ...TODAY, implementationOf: { ...TODAY.implementationOf, [S5]: A }, selectorsOf: { ...TODAY.selectorsOf, [A]: [S2, S1, S5] } },
      [`${where}'s routed implementation ${A} serves ${S5} at block 400, which the registry does not pin`],
    ],
    [
      'a selector moved from one implementation to another',
      { ...TODAY, implementationOf: { ...TODAY.implementationOf, [S2]: B }, selectorsOf: { [A]: [S1], [B]: [S3, S4, S2] } },
      [`${where}'s routed implementation ${A} no longer serves ${S2} at block 400, which the registry pins`, `${where}'s routed implementation ${B} serves ${S2} at block 400, which the registry does not pin`],
    ],
    ['an implementation lists its selectors in another order', { ...TODAY, selectorsOf: { ...TODAY.selectorsOf, [A]: [S1, S2] } }, [`${where}'s routed implementation ${A} lists the pinned selectors in another order at block 400`]],
    ['a selector routes elsewhere than the implementation listing it', { ...TODAY, implementationOf: { ...TODAY.implementationOf, [S2]: B } }, [`${where} at block 400: the routes are inconsistent: ${A} lists ${S2}, which routes to ${B}`]],
  ];
  for (const [what, state, findings] of cases) assert.deepEqual(await verifyAgainst(state), { kind: 'mismatch', findings }, what);
});

test("the report reads a routed entry's code and routes at its latest block against its current pin", async () => {
  const today = (state: Proxied, tweaks?: Tweaks) => checkToday(chain(() => state, tweaks), [LIQUIDITY], AT).then((checks) => checks.get(PROXY));
  assert.deepEqual(await today(TODAY), { kind: 'pass', text: 'PASS' });
  const moved = { ...TODAY, codes: { ...TODAY.codes, [A]: '0x60aa' } };
  const finding = await today(moved);
  assert.equal(finding?.kind, 'finding');
  assert.ok(finding?.text.includes(`\`${checksumAddress(A)}\` \`${hash('0x60aa')}\` (2 selectors)`), finding?.text);
  assert.deepEqual(await today(TODAY, { batch: 'disagree' }), { kind: 'unverifiable', text: 'UNVERIFIABLE' });
  assert.deepEqual(await today(TODAY, { batch: 'no-multicall' }), { kind: 'finding', text: 'FINDING: runs no code it can pin, `multicall-no-code`' });
});

test('routes the providers do not agree on are UNVERIFIABLE', async () => {
  assert.deepEqual(await verifyAgainst(TODAY, { batch: 'disagree' }), { kind: 'unverifiable', reasons: [`${where} at block 400: a chain read is unverifiable: eth_call: alchemy and drpc disagree`] });
});

test('an executed transaction is judged by the routes of the span that holds its block', async () => {
  const before = { codes: TODAY.codes, implementationOf: { [S1]: A, [S2]: A, [S3]: A }, selectorsOf: { [A]: [S2, S1, S3] } };
  const entry = registryWith({ code: { ...TODAY_PIN, from: 250, earlier: [{ from: 100, ...TODAY_PIN, routes: [routeJson(A, '0x600a', [S2, S1, S3])] }] } }).entries.get('liquidity') as RegistryEntry;
  const old = { number: 200n, hash: AT.hash };
  assert.deepEqual(await verifyAgainst(before, {}, entry, old, 'executed'), { kind: 'pass' });
  assert.equal((await verifyAgainst(before, {}, entry, old, 'pending')).kind, 'mismatch', 'a transaction to sign needs the current routes');
});

test("verify checks the code of every entry a touched entry depends on, though no call targets it", async () => {
  const recorded: VerdictFile = JSON.parse(readFileSync(join(ROOT, 'testdata', 'verify', 'morpho-vault-deposit.json'), 'utf8'));
  const entries = JSON.parse(recorded.inputs.registry) as Record<string, Record<string, unknown>>;
  const liquidity = { address: PROXY, kind: 'lending', source: 'https://docs.example.org/liquidity', code: { hash: hash('0x6000') } };
  const registry = JSON.stringify({ ...entries, bundler3: { ...entries.bundler3, dependsOn: ['liquidity'] }, liquidity });
  const parent = recorded.exchanges.find((e) => e.method === 'eth_getCode')?.params as [string, unknown];
  const code: Exchange = { method: 'eth_getCode', params: [PROXY, parent[1]], answers: { alchemy: '0x6001', drpc: '0x6001' } };
  const { verdict } = await evaluate({ ...recorded.inputs, registry }, replayReader([...recorded.exchanges, code]));
  assert.equal(verdict.kind, 'MISMATCH');
  assert.match(JSON.stringify(verdict), new RegExp(`liquidity ${PROXY} has code hash ${hash('0x6001')} at block \\d+, the registry pins ${hash('0x6000')}`));
});
