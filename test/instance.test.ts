import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Read, Reader } from '../src/chain/reader.ts';
import type { BlockRef, CallResult } from '../src/chain/types.ts';
import { proveInstance } from '../src/contracts/instance.ts';
import { RegistryError, parseRegistry } from '../src/registry.ts';
import type { Hex } from '../src/safe/types.ts';

const AT: BlockRef = { number: 1n, hash: `0x${'ab'.repeat(32)}` as Hex };
const FACTORY = '0x1897A8997241C1cD4bD0698647e4EB7213535c24';
const VAULT = '0x777791C4d6DC2CE140D00D2828a7C93503c67777';
const IS_META_MORPHO = '0x29b5352c';

const registry = (factory: Record<string, unknown> = {}) =>
  parseRegistry({
    usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', kind: 'token', source: 'https://example.org/usdc' },
    'metamorpho-factory-1.1': { address: FACTORY, kind: 'factory', source: 'https://example.org/factory', instanceCheck: 'isMetaMorpho(address)', ...factory },
    apex: { address: VAULT, kind: 'vault', source: 'https://example.org/apex', attributes: { asset: 'usdc', factory: 'metamorpho-factory-1.1' } },
    lone: { address: `0x${'11'.repeat(20)}`, kind: 'vault', source: 'https://example.org/lone', attributes: { asset: 'usdc' } },
  });

/** Answers only `isMetaMorpho(VAULT)` on the factory, with `word`. */
function factoryAnswering(word: Read<CallResult>): Reader {
  return {
    call: async (request, at) => {
      assert.equal(at, AT);
      assert.equal(request.to, FACTORY.toLowerCase());
      assert.equal(request.data, `${IS_META_MORPHO}${'00'.repeat(12)}${VAULT.slice(2).toLowerCase()}`);
      return word;
    },
  } as Partial<Reader> as Reader;
}

const agreed = (data: string): Read<CallResult> => ({ kind: 'agreed', value: { kind: 'returned', data: data as Hex }, providers: ['alchemy', 'drpc'] });

test("a vault its registry factory answers true for is proven that factory's instance", async () => {
  const proof = await proveInstance(factoryAnswering(agreed(`0x${'00'.repeat(31)}01`)), registry(), 'apex', AT);
  assert.equal(proof.kind, 'created');
  assert.equal(proof.kind === 'created' && proof.factory.name, 'metamorpho-factory-1.1');
});

test('a vault its factory answers false for is refused', async () => {
  const proof = await proveInstance(factoryAnswering(agreed(`0x${'00'.repeat(32)}`)), registry(), 'apex', AT);
  assert.deepEqual(proof, { kind: 'refused', why: 'metamorpho-factory-1.1 answered isMetaMorpho(address) false for apex: it did not create it' });
});

test('an answer that is neither true nor false, a revert, or providers that disagree are refused', async () => {
  const odd = await proveInstance(factoryAnswering(agreed(`0x${'00'.repeat(31)}02`)), registry(), 'apex', AT);
  assert.match(odd.kind === 'refused' ? odd.why : '', /with 0x0{62}02, not true or false/);
  const reverted = await proveInstance(factoryAnswering({ kind: 'agreed', value: { kind: 'reverted' }, providers: ['alchemy', 'drpc'] }), registry(), 'apex', AT);
  assert.match(reverted.kind === 'refused' ? reverted.why : '', /with a revert/);
  const split = await proveInstance(
    factoryAnswering({ kind: 'unverifiable', reason: 'eth_call: alchemy and drpc disagree', answers: [{ provider: 'alchemy', kind: 'malformed' }, { provider: 'drpc', kind: 'malformed' }] }),
    registry(),
    'apex',
    AT,
  );
  assert.deepEqual(split, { kind: 'refused', why: 'eth_call: alchemy and drpc disagree' });
});

test('a vault that names no factory is refused without a chain read', async () => {
  const proof = await proveInstance({} as Reader, registry(), 'lone', AT);
  assert.deepEqual(proof, { kind: 'refused', why: 'lone names no factory' });
});

test('a factory must declare an instance check that takes one address, and only a factory may', () => {
  assert.throws(() => registry({ instanceCheck: undefined }), (e: unknown) => e instanceof RegistryError && /instanceCheck: not a function signature/.test(e.message));
  assert.throws(() => registry({ instanceCheck: 'isMetaMorpho(uint256)' }), /must take exactly one address/);
  assert.throws(
    () => parseRegistry({ usdc: { address: FACTORY, kind: 'token', source: 'https://example.org/usdc', instanceCheck: 'isMetaMorpho(address)' } }),
    /usdc.instanceCheck: a token has no instanceCheck/,
  );
  assert.throws(
    () => parseRegistry({ usdc: { address: FACTORY, kind: 'token', source: 'https://example.org/usdc' }, v: { address: VAULT, kind: 'vault', source: 'https://example.org/v', attributes: { factory: 'usdc' } } }),
    /v.attributes.factory: "usdc" is not a factory in the registry/,
  );
});
