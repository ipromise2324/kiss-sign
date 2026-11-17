import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Read, Reader } from '../src/chain/reader.ts';
import type { BlockRef, CallResult } from '../src/chain/types.ts';
import { proveAdapterOf, proveInstance } from '../src/contracts/instance.ts';
import { RegistryError, parseRegistry } from '../src/registry.ts';
import type { Hex } from '../src/safe/types.ts';

const AT: BlockRef = { number: 1n, hash: `0x${'ab'.repeat(32)}` as Hex };
const FACTORY = '0x1897A8997241C1cD4bD0698647e4EB7213535c24';
const VAULT = '0x777791C4d6DC2CE140D00D2828a7C93503c67777';
const IS_META_MORPHO = '0x29b5352c';

const registry = (factory: Record<string, unknown> = {}) =>
  parseRegistry({
    usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', kind: 'token', source: 'https://example.org/usdc' },
    'metamorpho-factory-v1-1': { address: FACTORY, kind: 'factory', source: 'https://example.org/factory', instanceCheck: 'isMetaMorpho(address)', ...factory },
    apex: { address: VAULT, kind: 'vault', source: 'https://example.org/apex', attributes: { asset: 'usdc', factory: 'metamorpho-factory-v1-1' } },
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
  assert.equal(proof.kind === 'created' && proof.factory.name, 'metamorpho-factory-v1-1');
});

test('a vault its factory answers false for is refused', async () => {
  const proof = await proveInstance(factoryAnswering(agreed(`0x${'00'.repeat(32)}`)), registry(), 'apex', AT);
  assert.deepEqual(proof, { kind: 'refused', cause: 'not-created', why: 'metamorpho-factory-v1-1 answered isMetaMorpho(address) false for apex: it did not create it' });
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
  assert.deepEqual(split, { kind: 'refused', cause: 'no-answer', why: 'eth_call: alchemy and drpc disagree' });
});

test('a vault that names no factory is refused without a chain read', async () => {
  const proof = await proveInstance({} as Reader, registry(), 'lone', AT);
  assert.deepEqual(proof, { kind: 'refused', cause: 'unaskable', why: 'lone names no factory' });
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

const LENDING_FACTORY = '0x54B91A0D94cb471F37f949c60F7Fa7935b551D03';
const FUSDC = '0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33';
const COMPUTE_TOKEN = { function: 'computeToken(address,string)', args: [{ attribute: 'asset' }, { string: 'fToken' }] };

const fluid = (check: unknown = COMPUTE_TOKEN) =>
  parseRegistry({
    usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', kind: 'token', source: 'https://example.org/usdc' },
    'fluid-lending-factory': { address: LENDING_FACTORY, kind: 'factory', source: 'https://example.org/lending-factory', instanceCheck: check },
    'fluid-fusdc': { address: FUSDC, kind: 'vault', source: 'https://example.org/fusdc', attributes: { asset: 'usdc', factory: 'fluid-lending-factory' } },
    bare: { address: `0x${'22'.repeat(20)}`, kind: 'vault', source: 'https://example.org/bare', attributes: { factory: 'fluid-lending-factory' } },
  });

const word = (hex: string) => hex.padStart(64, '0');
const COMPUTE_TOKEN_SELECTOR = '0xbb4a64d3';
const USDC_WORD = word('a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
const STRING_OFFSET_WORD = word('40');
const FTOKEN_LENGTH_WORD = word('6');
const FTOKEN_BYTES_WORD = Buffer.from('fToken').toString('hex').padEnd(64, '0');
const COMPUTE_FUSDC = `${COMPUTE_TOKEN_SELECTOR}${USDC_WORD}${STRING_OFFSET_WORD}${FTOKEN_LENGTH_WORD}${FTOKEN_BYTES_WORD}`;

function lendingFactoryAnswering(word: Read<CallResult>): Reader {
  return {
    call: async (request, at) => {
      assert.equal(at, AT);
      assert.equal(request.to, LENDING_FACTORY.toLowerCase());
      assert.equal(request.data, COMPUTE_FUSDC);
      return word;
    },
  } as Partial<Reader> as Reader;
}

const addressWord = (address: string) => `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}`;

test("a vault whose address its factory computes from the vault's asset is proven that factory's instance", async () => {
  const proof = await proveInstance(lendingFactoryAnswering(agreed(addressWord(FUSDC))), fluid(), 'fluid-fusdc', AT);
  assert.equal(proof.kind, 'created');
  if (proof.kind !== 'created') return;
  assert.equal(proof.factory.name, 'fluid-lending-factory');
  assert.equal(proof.asked, 'computeToken(usdc,"fToken")');
  assert.equal(proof.answered, FUSDC);
});

test("a factory that computes another address for the vault's asset did not create it", async () => {
  const fusdt = '0x5C20B550819128074FD538Edf79791733ccEdd18';
  const proof = await proveInstance(lendingFactoryAnswering(agreed(addressWord(fusdt))), fluid(), 'fluid-fusdc', AT);
  assert.deepEqual(proof, { kind: 'refused', cause: 'not-created', why: `fluid-lending-factory answered computeToken(usdc,"fToken") = ${fusdt}, not fluid-fusdc: its official contract is another` });
});

test('a computed answer that is not one address word, a revert, or providers that disagree are refused', async () => {
  for (const data of [`0x${'11'.repeat(32)}`, `${addressWord(FUSDC)}${'00'.repeat(32)}`, '0x']) {
    const proof = await proveInstance(lendingFactoryAnswering(agreed(data)), fluid(), 'fluid-fusdc', AT);
    assert.deepEqual(proof, { kind: 'refused', cause: 'other-answer', why: `fluid-lending-factory answered computeToken(usdc,"fToken") with ${data}, not an address` });
  }
  const reverted = await proveInstance(lendingFactoryAnswering({ kind: 'agreed', value: { kind: 'reverted' }, providers: ['alchemy', 'drpc'] }), fluid(), 'fluid-fusdc', AT);
  assert.deepEqual(reverted, { kind: 'refused', cause: 'other-answer', why: 'fluid-lending-factory answered computeToken(usdc,"fToken") with a revert, not an address' });
  const split = await proveInstance(
    lendingFactoryAnswering({ kind: 'unverifiable', reason: 'eth_call: alchemy and drpc disagree', answers: [{ provider: 'alchemy', kind: 'malformed' }, { provider: 'drpc', kind: 'malformed' }] }),
    fluid(),
    'fluid-fusdc',
    AT,
  );
  assert.deepEqual(split, { kind: 'refused', cause: 'no-answer', why: 'eth_call: alchemy and drpc disagree' });
});

test("a vault that lacks an attribute its factory's check binds is refused without a chain read", async () => {
  const proof = await proveInstance({} as Reader, fluid(), 'bare', AT);
  assert.deepEqual(proof, { kind: 'refused', cause: 'unaskable', why: "bare has no asset attribute, which fluid-lending-factory's instanceCheck computeToken(address,string) binds" });
});

test('a computed instance check binds each parameter once, by its type, to an attribute or a short constant string, and binds an attribute', () => {
  const refused = (check: unknown, message: RegExp) => assert.throws(() => fluid(check), (e: unknown) => e instanceof RegistryError && message.test(e.message));
  refused({ function: 'computeToken(address,string)', args: [{ attribute: 'asset' }] }, /fluid-lending-factory\.instanceCheck\.args: not a list of one argument for each of the 2 parameters/);
  refused({ function: 'computeToken(address,string)', args: [{ attribute: 'asset' }, { string: 'fToken' }, { string: 'x' }] }, /instanceCheck\.args: not a list of one argument for each of the 2/);
  refused({ function: 'computeToken(address,string)' }, /instanceCheck\.args: not a list/);
  refused({ args: [] }, /instanceCheck\.function: not a function signature/);
  refused({ function: 'computeToken(address,string', args: [] }, /instanceCheck\.function: /);
  refused({ ...COMPUTE_TOKEN, extra: 1 }, /instanceCheck\.extra: unexpected field/);
  refused({ function: 'computeToken(address,string)', args: [{ string: 'fToken' }, { attribute: 'asset' }] }, /instanceCheck\.args\[0\]: a string binds only a string parameter, and this one is address/);
  refused({ function: 'computeToken(address,uint256)', args: [{ attribute: 'asset' }, { attribute: 'asset' }] }, /instanceCheck\.args\[1\]: an attribute binds only an address parameter, and this one is uint256/);
  refused({ function: 'computeToken(address,string)', args: [{ attribute: 'curator' }, { string: 'fToken' }] }, /instanceCheck\.args\[0\]\.attribute: not one of asset, factory/);
  refused({ function: 'computeToken(address,string)', args: [{ attribute: 'asset', string: 'fToken' }, { string: 'fToken' }] }, /instanceCheck\.args\[0\]: not one of/);
  refused({ function: 'computeToken(address,string)', args: [{}, { string: 'fToken' }] }, /instanceCheck\.args\[0\]: not one of/);
  refused({ function: 'computeToken(address,string)', args: ['asset', { string: 'fToken' }] }, /instanceCheck\.args\[0\]: not a JSON object/);
  for (const bad of ['', 'f Token', 'f"Token', 'f\\Token', 'f`Token', 'f|Token', '<fToken>', 'f&Token', 'x'.repeat(33), 'fTokén', 7]) {
    refused({ function: 'computeToken(address,string)', args: [{ attribute: 'asset' }, { string: bad }] }, /instanceCheck\.args\[1\]\.string: not 1 to 32 letters, digits, _, \. or -$/);
  }
  refused({ function: 'computeToken(string)', args: [{ string: 'fToken' }] }, /instanceCheck\.args: binds no attribute of the contract, so the address it computes is the same for every contract$/);
  assert.ok(fluid({ function: 'computeToken(address,string)', args: [{ attribute: 'asset' }, { string: 'f-Token_v1.2' }] }));
  refused(['computeToken(address,string)'], /instanceCheck: not a function signature or a \{"function", "args"\} object/);
  assert.ok(fluid({ function: 'computeToken(address,string)', args: [{ attribute: 'asset' }, { string: 'x'.repeat(32) }] }));
});

const VAULT_FACTORY = '0xA1D94F746dEfa1928926b84fB2596c06926C0405';
const VAULT_V2 = '0x153Bd1abE60104Bd46aa05a27fA12D1346D64A57';
const ADAPTER = '0x9b42102feb9Ba61d9793E49239eDA0d0C3cb5bD5';
const IS_ADAPTER = '0x68c18beb';

const vaultV2 = (adapterCheck: unknown = 'isAdapter(address)') =>
  parseRegistry({
    'vault-v2-factory': { address: VAULT_FACTORY, kind: 'factory', source: 'https://example.org/vault-factory', instanceCheck: 'isVaultV2(address)', ...(adapterCheck === null ? {} : { adapterCheck }) },
    'adapter-factory': { address: FACTORY, kind: 'factory', source: 'https://example.org/adapter-factory', instanceCheck: 'isMorphoMarketV1AdapterV2(address)' },
    'market-adapter': { address: ADAPTER, kind: 'adapter', source: 'https://example.org/adapter', attributes: { factory: 'adapter-factory' } },
    vault: { address: VAULT_V2, kind: 'vault', source: 'https://example.org/vault', attributes: { factory: 'vault-v2-factory', adapter: 'market-adapter' } },
  });

/** Answers only `isAdapter(ADAPTER)` on the vault, with `word`. */
function vaultAnswering(word: Read<CallResult>): Reader {
  return {
    call: async (request, at) => {
      assert.equal(at, AT);
      assert.equal(request.to, VAULT_V2.toLowerCase());
      assert.equal(request.data, `${IS_ADAPTER}${'00'.repeat(12)}${ADAPTER.slice(2).toLowerCase()}`);
      return word;
    },
  } as Partial<Reader> as Reader;
}

const adapterOf = (registry: ReturnType<typeof vaultV2>, reader: Reader) => proveAdapterOf(reader, registry, registry.entries.get('market-adapter')!, AT);

test('each registry vault naming an adapter is asked through its factory\'s adapterCheck whether it allocates through it', async () => {
  const uses = await adapterOf(vaultV2(), vaultAnswering(agreed(`0x${'00'.repeat(31)}01`)));
  assert.deepEqual(
    uses.map((a) => [a.vault.name, a.asked, a.kind]),
    [['vault', 'isAdapter(address)', 'uses']],
  );
  const refusals = async (word: Read<CallResult>) => (await adapterOf(vaultV2(), vaultAnswering(word))).map((a) => (a.kind === 'refused' ? [a.cause, a.why] : a.kind));
  assert.deepEqual(await refusals(agreed(`0x${'00'.repeat(32)}`)), [['not-used', 'vault answered isAdapter(address) false for market-adapter: it does not allocate through it']]);
  assert.deepEqual(await refusals({ kind: 'agreed', value: { kind: 'reverted' }, providers: ['alchemy', 'drpc'] }), [['other-answer', 'vault answered isAdapter(address) with a revert, not true or false']]);
  assert.deepEqual(
    await refusals({ kind: 'unverifiable', reason: 'eth_call: alchemy and drpc disagree', answers: [{ provider: 'alchemy', kind: 'malformed' }, { provider: 'drpc', kind: 'malformed' }] }),
    [['no-answer', 'eth_call: alchemy and drpc disagree']],
  );
});

test("a vault whose factory declares no adapterCheck is not asked, and an adapter no vault names gets no answer", async () => {
  const unasked = await adapterOf(vaultV2(null), {} as Reader);
  assert.deepEqual(unasked.map((a) => (a.kind === 'refused' ? [a.cause, a.why] : a.kind)), [['unaskable', 'vault-v2-factory has no adapterCheck']]);
  const registry = vaultV2();
  assert.deepEqual(await proveAdapterOf({} as Reader, registry, registry.entries.get('adapter-factory')!, AT), []);
});

test('only a factory may declare an adapterCheck, which takes one address', () => {
  assert.throws(() => vaultV2('isAdapter(uint256)'), (e: unknown) => e instanceof RegistryError && /vault-v2-factory\.adapterCheck: must take exactly one address/.test(e.message));
  assert.throws(
    () => parseRegistry({ usdc: { address: FACTORY, kind: 'token', source: 'https://example.org/usdc', adapterCheck: 'isAdapter(address)' } }),
    /usdc.adapterCheck: a token has no adapterCheck/,
  );
  assert.equal(vaultV2().entries.get('vault-v2-factory')?.adapterCheck?.signature, 'isAdapter(address)');
});
