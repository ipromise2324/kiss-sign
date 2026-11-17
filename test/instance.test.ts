import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import type { Read, Reader } from '../src/chain/reader.ts';
import type { BlockRef, CallResult } from '../src/chain/types.ts';
import { proveInstance } from '../src/contracts/instance.ts';
import type { InstanceAnswers, InstanceUnasked } from '../src/contracts/instance.ts';
import { RegistryError, loadRegistry, parseRegistry } from '../src/registry.ts';
import type { RegistryEntry } from '../src/registry.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = join(import.meta.dirname, '..');
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

/** Each view's answer as the signer reads it: what was asked of whom, and what it answered or why it vouched for nothing. */
const outcomes = (proof: InstanceAnswers | InstanceUnasked) =>
  proof.kind === 'unasked' ? [['unasked', proof.why]] : proof.answers.map((a) => (a.kind === 'vouched' ? [a.asker?.name, a.asked, a.answered] : [a.cause, a.why]));

test("a vault its registry factory answers true for is proven that factory's instance", async () => {
  const proof = await proveInstance(factoryAnswering(agreed(`0x${'00'.repeat(31)}01`)), registry(), 'apex', AT);
  assert.deepEqual(outcomes(proof), [['metamorpho-factory-v1-1', 'isMetaMorpho(address)', 'true']]);
});

test('a vault its factory answers false for is refused', async () => {
  const proof = await proveInstance(factoryAnswering(agreed(`0x${'00'.repeat(32)}`)), registry(), 'apex', AT);
  assert.deepEqual(outcomes(proof), [['denied', 'metamorpho-factory-v1-1 answered isMetaMorpho(address) false for apex: it did not create it']]);
});

test('an answer that is neither true nor false, a revert, or providers that disagree are refused', async () => {
  const odd = await proveInstance(factoryAnswering(agreed(`0x${'00'.repeat(31)}02`)), registry(), 'apex', AT);
  assert.match(String(outcomes(odd)[0]?.[1]), /with 0x0{62}02, not true or false/);
  const reverted = await proveInstance(factoryAnswering({ kind: 'agreed', value: { kind: 'reverted' }, providers: ['alchemy', 'drpc'] }), registry(), 'apex', AT);
  assert.match(String(outcomes(reverted)[0]?.[1]), /with a revert/);
  const split = await proveInstance(
    factoryAnswering({ kind: 'unverifiable', reason: 'eth_call: alchemy and drpc disagree', answers: [{ provider: 'alchemy', kind: 'malformed' }, { provider: 'drpc', kind: 'malformed' }] }),
    registry(),
    'apex',
    AT,
  );
  assert.deepEqual(outcomes(split), [['no-answer', 'eth_call: alchemy and drpc disagree']]);
});

test('a vault that names no factory is refused without a chain read', async () => {
  const proof = await proveInstance({} as Reader, registry(), 'lone', AT);
  assert.deepEqual(outcomes(proof), [['unasked', 'lone names no factory']]);
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
  assert.deepEqual(outcomes(proof), [['fluid-lending-factory', 'computeToken(usdc,"fToken")', FUSDC]]);
});

test("a factory that computes another address for the vault's asset did not create it", async () => {
  const fusdt = '0x5C20B550819128074FD538Edf79791733ccEdd18';
  const proof = await proveInstance(lendingFactoryAnswering(agreed(addressWord(fusdt))), fluid(), 'fluid-fusdc', AT);
  assert.deepEqual(outcomes(proof), [['denied', `fluid-lending-factory answered computeToken(usdc,"fToken") = ${fusdt}, not fluid-fusdc: its official contract is another`]]);
});

test('a computed answer that is not one address word, a revert, or providers that disagree are refused', async () => {
  for (const data of [`0x${'11'.repeat(32)}`, `${addressWord(FUSDC)}${'00'.repeat(32)}`, '0x']) {
    const proof = await proveInstance(lendingFactoryAnswering(agreed(data)), fluid(), 'fluid-fusdc', AT);
    assert.deepEqual(outcomes(proof), [['other-answer', `fluid-lending-factory answered computeToken(usdc,"fToken") with ${data}, not an address`]]);
  }
  const reverted = await proveInstance(lendingFactoryAnswering({ kind: 'agreed', value: { kind: 'reverted' }, providers: ['alchemy', 'drpc'] }), fluid(), 'fluid-fusdc', AT);
  assert.deepEqual(outcomes(reverted), [['other-answer', 'fluid-lending-factory answered computeToken(usdc,"fToken") with a revert, not an address']]);
  const split = await proveInstance(
    lendingFactoryAnswering({ kind: 'unverifiable', reason: 'eth_call: alchemy and drpc disagree', answers: [{ provider: 'alchemy', kind: 'malformed' }, { provider: 'drpc', kind: 'malformed' }] }),
    fluid(),
    'fluid-fusdc',
    AT,
  );
  assert.deepEqual(outcomes(split), [['no-answer', 'eth_call: alchemy and drpc disagree']]);
});

test("a vault that lacks an attribute its factory's check binds is refused without a chain read", async () => {
  const proof = await proveInstance({} as Reader, fluid(), 'bare', AT);
  assert.deepEqual(outcomes(proof), [['unaskable', "bare has no asset attribute, which fluid-lending-factory's instanceCheck computeToken(address,string) binds"]]);
});

test('a computed instance check binds each parameter once, by its type, to a party or a constant of that type, and binds an attribute', () => {
  const refused = (check: unknown, message: RegExp) => assert.throws(() => fluid(check), (e: unknown) => e instanceof RegistryError && message.test(e.message));
  refused({ function: 'computeToken(address,string)', args: [{ attribute: 'asset' }] }, /fluid-lending-factory\.instanceCheck\.args: not a list of one argument for each of the 2 parameters/);
  refused({ function: 'computeToken(address,string)', args: [{ attribute: 'asset' }, { string: 'fToken' }, { string: 'x' }] }, /instanceCheck\.args: not a list of one argument for each of the 2/);
  refused({ function: 'computeToken(address,string)' }, /instanceCheck\.args: not a list/);
  refused({ args: [] }, /instanceCheck\.function: not a function signature/);
  refused({ function: 'computeToken(address,string', args: [] }, /instanceCheck\.function: /);
  refused({ ...COMPUTE_TOKEN, extra: 1 }, /instanceCheck\.extra: unexpected field/);
  refused({ function: 'computeToken(address,string)', args: [{ string: 'fToken' }, { attribute: 'asset' }] }, /instanceCheck\.args\[0\]: a constant string binds only string parameters, and this one is address/);
  refused({ function: 'computeToken(address,uint256)', args: [{ attribute: 'asset' }, { attribute: 'asset' }] }, /instanceCheck\.args\[1\]: a party binds only an address parameter, and this one is uint256/);
  refused({ function: 'computeToken(address,string)', args: [{ attribute: 'curator' }, { string: 'fToken' }] }, /instanceCheck\.args\[0\]\.attribute: not one of asset, factory, adapter$/);
  refused({ function: 'computeToken(address,string)', args: [{ attribute: 'asset', string: 'fToken' }, { string: 'fToken' }] }, /instanceCheck\.args\[0\]: not one of/);
  refused({ function: 'computeToken(address,string)', args: [{}, { string: 'fToken' }] }, /instanceCheck\.args\[0\]: not one of/);
  refused({ function: 'computeToken(address,string)', args: ['asset', { string: 'fToken' }] }, /instanceCheck\.args\[0\]: not one of "factory", "instance"/);
  refused({ function: 'computeToken(address,uint24)', args: [{ attribute: 'asset' }, { uint: '16777216' }] }, /instanceCheck\.args\[1\]\.uint: not a decimal integer string in the range of uint24/);
  refused({ function: 'computeToken(address,int8)', args: [{ attribute: 'asset' }, { int: '-129' }] }, /instanceCheck\.args\[1\]\.int: not a decimal integer string in the range of int8/);
  refused({ function: 'computeToken(address,uint24)', args: [{ attribute: 'asset' }, { int: '3' }] }, /instanceCheck\.args\[1\]: a constant int binds only int<bits> parameters, and this one is uint24/);
  refused({ function: 'computeToken(address,bytes32)', args: [{ attribute: 'asset' }, { bytes32: '0x01' }] }, /instanceCheck\.args\[1\]\.bytes32: not 32 bytes/);
  refused({ function: 'isPool(address)', args: [{ attribute: 'asset' }], answers: true }, /instanceCheck: names the instance nowhere, so it answers the same for every contract$/);
  refused({ ...COMPUTE_TOKEN, word: 64 }, /instanceCheck\.word: not a word index from 0 to 63/);
  assert.ok(fluid({ function: 'computeToken(address,uint24,int8,bytes32)', args: [{ attribute: 'asset' }, { uint: '500' }, { int: '-1' }, { bytes32: `0x${'ab'.repeat(32)}` }] }));
  for (const bad of ['', 'f Token', 'f"Token', 'f\\Token', 'f`Token', 'f|Token', '<fToken>', 'f&Token', 'x'.repeat(33), 'fTokén', 7]) {
    refused({ function: 'computeToken(address,string)', args: [{ attribute: 'asset' }, { string: bad }] }, /instanceCheck\.args\[1\]\.string: not 1 to 32 letters, digits, _, \. or -$/);
  }
  refused({ function: 'computeToken(string)', args: [{ string: 'fToken' }] }, /instanceCheck\.args: binds no attribute of the contract, so the address it computes is the same for every contract$/);
  assert.ok(fluid({ function: 'computeToken(address,string)', args: [{ attribute: 'asset' }, { string: 'f-Token_v1.2' }] }));
  refused([7], /instanceCheck\[0\]: not a function signature or a \{"function", "args"\} object/);
  assert.ok(fluid({ function: 'computeToken(address,string)', args: [{ attribute: 'asset' }, { string: 'x'.repeat(32) }] }));
});

const VAULT_FACTORY = '0xA1D94F746dEfa1928926b84fB2596c06926C0405';
const VAULT_V2 = '0x153Bd1abE60104Bd46aa05a27fA12D1346D64A57';
const OTHER_VAULT = '0x2222222222222222222222222222222222222222';
const ADAPTER = '0x9b42102feb9Ba61d9793E49239eDA0d0C3cb5bD5';
const IS_ADAPTER = '0x68c18beb';
const PARENT_VAULT = '0x0fe36536';

const NAMED_BY_VAULT = { ask: { namedBy: 'adapter' }, function: 'isAdapter(address)', args: ['instance'], answers: true };
const MADE_FOR_VAULT = { ask: 'instance', function: 'parentVault()', args: [], answers: { namedBy: 'adapter' } };

const vaultV2 = (views: unknown[] = ['isMorphoMarketV1AdapterV2(address)', NAMED_BY_VAULT, MADE_FOR_VAULT], vaults: Record<string, unknown> = {}) =>
  parseRegistry({
    'vault-v2-factory': { address: VAULT_FACTORY, kind: 'factory', source: 'https://example.org/vault-factory', instanceCheck: 'isVaultV2(address)' },
    'adapter-factory': { address: FACTORY, kind: 'factory', source: 'https://example.org/adapter-factory', instanceCheck: views },
    'market-adapter': { address: ADAPTER, kind: 'adapter', source: 'https://example.org/adapter', attributes: { factory: 'adapter-factory' } },
    vault: { address: VAULT_V2, kind: 'vault', source: 'https://example.org/vault', attributes: { factory: 'vault-v2-factory', adapter: 'market-adapter' } },
    ...vaults,
  });

/** Answers the adapter factory, each vault's `isAdapter(ADAPTER)` and the adapter's `parentVault()`, counting each read. */
function vaultV2Answering(answers: { readonly vault?: Read<CallResult>; readonly other?: Read<CallResult>; readonly parent?: Read<CallResult> }, reads: string[] = []): Reader {
  const TRUE = agreed(`0x${'00'.repeat(31)}01`);
  return {
    call: async (request, at) => {
      assert.equal(at, AT);
      reads.push(`${request.to} ${request.data.slice(0, 10)}`);
      if (request.to === FACTORY.toLowerCase()) return TRUE;
      if (request.data === (PARENT_VAULT as Hex)) {
        assert.equal(request.to, ADAPTER.toLowerCase());
        return answers.parent ?? agreed(addressWord(VAULT_V2));
      }
      assert.equal(request.data, `${IS_ADAPTER}${'00'.repeat(12)}${ADAPTER.slice(2).toLowerCase()}`);
      return request.to === VAULT_V2.toLowerCase() ? (answers.vault ?? TRUE) : (answers.other ?? TRUE);
    },
  } as Partial<Reader> as Reader;
}

const REVERT: Read<CallResult> = { kind: 'agreed', value: { kind: 'reverted' }, providers: ['alchemy', 'drpc'] };

test("an adapter is admitted by every view of its factory's instanceCheck: the factory, each vault naming it, and its own word naming that vault", async () => {
  assert.deepEqual(outcomes(await proveInstance(vaultV2Answering({}), vaultV2(), 'market-adapter', AT)), [
    ['adapter-factory', 'isMorphoMarketV1AdapterV2(address)', 'true'],
    ['vault', 'isAdapter(address)', 'true'],
    ['market-adapter', 'parentVault()', VAULT_V2],
  ]);
  const second = vaultV2(undefined, { second: { address: OTHER_VAULT, kind: 'vault', source: 'https://example.org/second', attributes: { factory: 'vault-v2-factory', adapter: 'market-adapter' } } });
  const reads: string[] = [];
  assert.deepEqual(outcomes(await proveInstance(vaultV2Answering({}, reads), second, 'market-adapter', AT)).slice(1), [
    ['vault', 'isAdapter(address)', 'true'],
    ['second', 'isAdapter(address)', 'true'],
    ['market-adapter', 'parentVault()', VAULT_V2],
    ['denied', `market-adapter answered parentVault() = ${VAULT_V2}, not second`],
  ]);
  assert.equal(reads.filter((read) => read.endsWith(PARENT_VAULT)).length, 1, 'the adapter is asked once, its answer compared with each vault naming it');
});

test("a vault naming the adapter that answers false or reverts, or an adapter made for another vault, vouches for nothing", async () => {
  const refusals = async (answers: Parameters<typeof vaultV2Answering>[0]) => outcomes(await proveInstance(vaultV2Answering(answers), vaultV2(), 'market-adapter', AT)).filter((o) => o.length === 2);
  assert.deepEqual(await refusals({ vault: agreed(`0x${'00'.repeat(32)}`) }), [['denied', 'vault answered isAdapter(address) false for market-adapter: it does not vouch for it']]);
  assert.deepEqual(await refusals({ vault: REVERT }), [['other-answer', 'vault answered isAdapter(address) with a revert, not true or false']]);
  assert.deepEqual(await refusals({ parent: agreed(addressWord(VAULT_FACTORY)) }), [['denied', `market-adapter answered parentVault() = ${VAULT_FACTORY}, not vault`]]);
  assert.deepEqual(await refusals({ parent: REVERT }), [['other-answer', 'market-adapter answered parentVault() with a revert, not an address']]);
  assert.deepEqual(
    await refusals({ parent: { kind: 'unverifiable', reason: 'eth_call: alchemy and drpc disagree', answers: [{ provider: 'alchemy', kind: 'malformed' }, { provider: 'drpc', kind: 'malformed' }] } }),
    [['no-answer', 'eth_call: alchemy and drpc disagree']],
  );
});

test('a view asked once per entry naming the instance is not read when no registry entry names it', async () => {
  const lone = parseRegistry({
    'adapter-factory': { address: FACTORY, kind: 'factory', source: 'https://example.org/adapter-factory', instanceCheck: ['isMorphoMarketV1AdapterV2(address)', NAMED_BY_VAULT, MADE_FOR_VAULT] },
    'market-adapter': { address: ADAPTER, kind: 'adapter', source: 'https://example.org/adapter', attributes: { factory: 'adapter-factory' } },
  });
  assert.deepEqual(outcomes(await proveInstance(vaultV2Answering({}), lone, 'market-adapter', AT)).slice(1), [
    ['unaskable', 'no registry entry names market-adapter as its adapter'],
    ['unaskable', 'no registry entry names market-adapter as its adapter'],
  ]);
});

test('instance views name declared attributes, ask more than the instance alone, and only a factory may list them', () => {
  const refused = (views: unknown, message: RegExp) => assert.throws(() => vaultV2(views as unknown[]), (e: unknown) => e instanceof RegistryError && message.test(e.message));
  refused([{ ...NAMED_BY_VAULT, ask: { namedBy: 'curator' } }], /adapter-factory\.instanceCheck\[0\]\.ask\.namedBy: not one of asset, factory, adapter/);
  refused([MADE_FOR_VAULT], /adapter-factory\.instanceCheck: asks only the instance, whose own word tells it from no lookalike/);
  refused(MADE_FOR_VAULT as unknown as unknown[], /adapter-factory\.instanceCheck: asks only the instance, whose own word tells it from no lookalike/);
  refused([], /adapter-factory\.instanceCheck: not a non-empty list of views/);
  refused([{ ...MADE_FOR_VAULT, ask: 'vault' }], /instanceCheck\[0\]\.ask: not one of "factory", "instance"/);
  assert.throws(
    () => parseRegistry({ usdc: { address: FACTORY, kind: 'token', source: 'https://example.org/usdc', instanceCheck: ['isAdapter(address)'] } }),
    /usdc.instanceCheck: a token has no instanceCheck/,
  );
  for (const gone of ['adapterCheck', 'parentCheck']) {
    assert.throws(() => parseRegistry({ f: { address: FACTORY, kind: 'factory', source: 'https://example.org/f', instanceCheck: 'isX(address)', [gone]: 'parentVault()' } }), new RegExp(`f\\.${gone}: unexpected field`));
  }
});

test('any kind may carry any attribute the table declares, naming an entry of the kind the table gives', () => {
  const table = { asset: 'token', factory: 'factory', token0: 'token' };
  const usdc = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', kind: 'token', source: 'https://example.org/usdc' };
  const pool = (attributes: Record<string, string>) => ({ usdc, pool: { address: VAULT, kind: 'router', source: 'https://example.org/pool', attributes } });
  assert.equal(parseRegistry(pool({ token0: 'usdc' }), {}, table).entries.get('pool')?.attributes.token0, 'usdc');
  assert.throws(() => parseRegistry(pool({ token1: 'usdc' }), {}, table), /pool\.attributes\.token1: not an attribute registry\/attributes\.json declares/);
  assert.throws(() => parseRegistry(pool({ factory: 'usdc' }), {}, table), /pool\.attributes\.factory: "usdc" is not a factory in the registry/);
  assert.throws(() => parseRegistry(pool({}), {}, { Token0: 'token' }), /attributes\.Token0: not an attribute name/);
  assert.throws(() => parseRegistry(pool({}), {}, { token0: 'coin' }), /attributes\.token0: not one of token, vault/);
  assert.throws(() => parseRegistry(pool({}), {}, { constructor: 'token' }), /attributes\.constructor: not an attribute name/);
});

test('a Uniswap v3 pool, declared only as data, is proven by its factory computing getPool(token0, token1, 500) in a recorded live answer', async () => {
  const root = repoWithTestFixtures('uniswap-v3');
  const recorded = readRecording(join(ROOT, 'testdata', 'instance', 'uniswap-v3-usdc-weth-500.json')) as { readonly entry: string; readonly block: { readonly number: string; readonly hash: Hex }; readonly exchanges: Exchange[] };
  const registry = loadRegistry(root);
  const block = { number: BigInt(recorded.block.number), hash: recorded.block.hash };
  const proof = await proveInstance(replayReader(recorded.exchanges), registry, recorded.entry, block);
  assert.deepEqual(outcomes(proof), [['uniswap-v3-factory', 'getPool(usdc,weth,500)', '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640']]);
  const otherFee = loadRegistry(root);
  const factory = otherFee.entries.get('uniswap-v3-factory')!;
  const view = factory.instanceCheck![0];
  const asking3000 = { ...factory, instanceCheck: [{ ...view, args: [...view.args.slice(0, 2), { kind: 'uint', value: 3000n }] }] } as RegistryEntry;
  const swapped = { ...otherFee, entries: new Map([...otherFee.entries].map(([name, entry]) => [name, name === factory.name ? asking3000 : entry])) };
  assert.equal(outcomes(await proveInstance(replayReader(recorded.exchanges), swapped, recorded.entry, block))[0]?.[0], 'no-answer', 'another fee asks another call, which the recording does not answer');
});

test('a struct answer too short for its word, or a view expecting an attribute the instance lacks, vouches for nothing', async () => {
  const struct = (data: string) => proveInstance(lendingFactoryAnswering(agreed(data)), fluid({ ...COMPUTE_TOKEN, word: 1 }), 'fluid-fusdc', AT);
  assert.deepEqual(outcomes(await struct(addressWord(FUSDC))), [['other-answer', `fluid-lending-factory answered computeToken(usdc,"fToken") with ${addressWord(FUSDC)}, which has no word 1`]]);
  assert.deepEqual(outcomes(await struct(`${addressWord(VAULT)}${addressWord(FUSDC).slice(2)}`)), [['fluid-lending-factory', 'computeToken(usdc,"fToken")', FUSDC]]);
  const expectsAsset = fluid({ function: 'computeToken(address,string)', args: ['instance', { string: 'fToken' }], answers: { attribute: 'asset' } });
  const reader = { call: async () => agreed(addressWord(FUSDC)) } as Partial<Reader> as Reader;
  assert.deepEqual(outcomes(await proveInstance(reader, expectsAsset, 'bare', AT)), [['unaskable', "bare names no entry for computeToken(address,\"fToken\") to answer, as fluid-lending-factory's instanceCheck expects"]]);
});
