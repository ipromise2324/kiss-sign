import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Read } from '../src/chain/reader.ts';
import { namedSignatureOfAbiEntry, parseFunctionSignature } from '../src/decode/abi.ts';
import { abiCaseBlock, abiCaseReader, abiCaseSourcify } from '../src/contracts/abi-case.ts';
import type { AbiCase } from '../src/contracts/abi-case.ts';
import { describeRefusal, proveAbi } from '../src/contracts/prove.ts';
import type { AbiProof, AbiRefusal, Refusal } from '../src/contracts/prove.ts';
import { EIP1967_IMPLEMENTATION_SLOT } from '../src/contracts/proxy.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import { SOLC_PINS } from '../src/contracts/solc-pins.ts';
import type { SourcifyAnswer } from '../src/contracts/sourcify.ts';
import { loadRegistry } from '../src/registry.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { GENERATED_FILE, GENERATED_SUFFIX, VAULT_REPORTS_DIR, replayReport } from '../src/research/report.ts';
import type { Target } from '../src/research/report.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const suffixes = loadPublicSuffixList();

const load = (name: string): AbiCase => JSON.parse(readFileSync(join(ROOT, 'testdata', 'abi', `${name}.json`), 'utf8')) as AbiCase;

const unverifiable = <T>(reason: string): Read<T> => ({
  kind: 'unverifiable',
  reason,
  answers: [
    { provider: 'alchemy', kind: 'failed', cause: 'no-answer' },
    { provider: 'drpc', kind: 'failed', cause: 'no-answer' },
  ],
});

const show = (result: AbiProof | AbiRefusal): string =>
  result.kind === 'proven' ? `proven ${result.contractName}` : `refused: ${describeRefusal(result.refusal)}`;

function proven(result: AbiProof | AbiRefusal): AbiProof {
  assert.equal(result.kind, 'proven', show(result));
  return result as AbiProof;
}

function refusal(result: AbiProof | AbiRefusal): Refusal {
  assert.equal(result.kind, 'refused', show(result));
  return (result as AbiRefusal).refusal;
}

const codeHashOf = (fixture: AbiCase, address: string): Hex => {
  const code = fixture.reads.find((read) => read.method === 'getCode' && read.args[0] === address)?.value as string;
  return `0x${bytesToHex(keccak_256(hexToBytes(code.slice(2))))}` as Hex;
};

const BUNDLER3 = '0x6566194141eefa99af43bb5aa71460ca2dc90245' as Address;
const GENERAL_ADAPTER1 = '0x4a6c312ec70e8747a587ee860a0353cd42be0ae0' as Address;

const CASES = [
  {
    name: 'bundler3',
    proxy: 'none',
    proven: BUNDLER3,
    contract: 'src/Bundler3.sol:Bundler3',
    compiler: '0.8.28+commit.7893614a',
    functions: 4,
    immutables: 0,
    uses: ['multicall((address to,bytes data,uint256 value,bool skipRevert,bytes32 callbackHash)[] bundle)'],
  },
  {
    name: 'general-adapter1',
    proxy: 'none',
    proven: GENERAL_ADAPTER1,
    contract: 'src/adapters/EthereumGeneralAdapter1.sol:EthereumGeneralAdapter1',
    compiler: '0.8.28+commit.7893614a',
    functions: 34,
    immutables: 58,
    uses: [
      'erc20TransferFrom(address token,address receiver,uint256 amount)',
      'erc4626Deposit(address vault,uint256 assets,uint256 maxSharePriceE27,address receiver)',
      'erc4626Withdraw(address vault,uint256 assets,uint256 minSharePriceE27,address receiver,address owner)',
      'erc4626Redeem(address vault,uint256 shares,uint256 minSharePriceE27,address receiver,address owner)',
    ],
  },
  {
    name: 'vault-bundles-v1',
    proxy: 'none',
    proven: '0x02912516d49de997db75b9d7858faae59209650b',
    contract: 'lib/bundles/src/vault/VaultBundlesV1.sol:VaultBundlesV1',
    compiler: '0.8.34+commit.80d5c536',
    functions: 4,
    immutables: 0,
    uses: [
      'vaultBundlesV1Deposit(address vault,uint256 assets,uint256 maxSharePriceE27,(uint8 kind,bytes data) assetPermit,uint256 referralFeePct,address referralFeeRecipient,uint256 deadline)',
    ],
  },
  {
    name: 'fluid-fusdc',
    proxy: 'none',
    proven: '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    contract: 'contracts/protocols/lending/fToken/main.sol:fToken',
    compiler: '0.8.21+commit.d9974bed',
    functions: 48,
    immutables: 38,
    uses: ['deposit(uint256 assets_,address receiver_)', 'withdraw(uint256 assets_,address receiver_,address owner_)', 'redeem(uint256 shares_,address receiver_,address owner_)', 'approve(address spender,uint256 amount)'],
  },
  {
    name: 'fluid-fusdt',
    proxy: 'none',
    proven: '0x5c20b550819128074fd538edf79791733ccedd18',
    contract: 'contracts/protocols/lending/fToken/main.sol:fToken',
    compiler: '0.8.21+commit.d9974bed',
    functions: 48,
    immutables: 38,
    uses: ['deposit(uint256 assets_,address receiver_)', 'withdraw(uint256 assets_,address receiver_,address owner_)', 'redeem(uint256 shares_,address receiver_,address owner_)', 'approve(address spender,uint256 amount)'],
  },
  {
    name: 'morpho-token-eip1967',
    proxy: 'eip1967',
    proven: '0x4364fd2371b6318159366abfa51f190df5c24852',
    contract: 'src/MorphoTokenEthereum.sol:MorphoTokenEthereum',
    compiler: '0.8.27+commit.40a35a09',
    functions: 30,
    immutables: 2,
    uses: [],
  },
  {
    name: 'morpho-vault-v2-apex',
    proxy: 'none',
    proven: '0x093272c07700d3ca5301c3bf9b3a392624179e2f',
    contract: '../lib/vault-v2/src/VaultV2.sol:VaultV2',
    compiler: '0.8.28+commit.7893614a',
    functions: 97,
    immutables: 12,
    uses: ['deposit(uint256 assets,address onBehalf)', 'asset()'],
  },
  {
    name: 'metamorpho-v1-0-steakhouse-usdt',
    proxy: 'none',
    proven: '0xbeef047a543e45807105e51a8bbefcc5950fcfba',
    contract: 'src/MetaMorpho.sol:MetaMorpho',
    compiler: '0.8.21+commit.d9974bed',
    functions: 73,
    immutables: 32,
    uses: ['deposit(uint256 assets,address receiver)', 'asset()'],
  },
  {
    name: 'metamorpho-v1-1-apex',
    proxy: 'none',
    proven: '0x777791c4d6dc2ce140d00d2828a7c93503c67777',
    contract: 'src/MetaMorphoV1_1.sol:MetaMorphoV1_1',
    compiler: '0.8.26+commit.8a97fa7a',
    functions: 76,
    immutables: 32,
    uses: ['deposit(uint256 assets,address receiver)', 'asset()', 'approve(address spender,uint256 value)'],
  },
  {
    name: 'safe-proxy-1-3-0',
    proxy: 'safe',
    proven: '0x3e5c63644e683549055b9be8653de26e0b4cd36e',
    contract: 'contracts/GnosisSafeL2.sol:GnosisSafeL2',
    compiler: '0.7.6+commit.7338295f',
    functions: 31,
    immutables: 0,
    uses: [],
  },
  {
    name: 'fluid-rewards-distributor',
    proxy: 'none',
    proven: '0x7060fe0dd3e31be01efac6b28c8d38018fd163b0',
    contract: 'contracts/protocols/lending/merkleDistributor/main.sol:FluidMerkleDistributor',
    compiler: '0.8.21+commit.d9974bed',
    functions: 21,
    immutables: 2,
    uses: ['claim(address recipient_,uint256 cumulativeAmount_,uint8 positionType_,bytes32 positionId_,uint256 cycle_,bytes32[] merkleProof_,bytes metadata_)'],
  },
  {
    name: 'fluid-token',
    proxy: 'none',
    proven: '0x6f40d4a6237c257fff2db00fa0510deeecd303eb',
    contract: 'contracts/TokenDelegator.sol:InstaToken',
    compiler: '0.7.3+commit.9bfce1f6',
    functions: 7,
    immutables: 0,
    uses: [],
  },
  {
    name: 'merkl-distributor',
    proxy: 'eip1967',
    proven: '0x33cc998fd4af3b6be42bac9a67fe97e9e275d2ae',
    contract: 'contracts/Distributor.sol:Distributor',
    compiler: '0.8.25+commit.b61c2a91',
    functions: 38,
    immutables: 5,
    uses: ['claim(address[] users,address[] tokens,uint256[] amounts,bytes32[][] proofs)'],
  },
  {
    name: 'morpho-urd',
    proxy: 'none',
    proven: '0x330eefa8a787552dc5cad3c3ca644844b1e61ddb',
    contract: 'src/UniversalRewardsDistributor.sol:UniversalRewardsDistributor',
    compiler: '0.8.19+commit.7dd6d404',
    functions: 15,
    immutables: 0,
    uses: ['claim(address account,address reward,uint256 claimable,bytes32[] proof)'],
  },
  {
    name: 'cctp-message-transmitter',
    proxy: 'none',
    proven: '0x0a992d191deec32afe36203ad87d7d289a738f81',
    contract: 'MessageTransmitter.sol:MessageTransmitter',
    compiler: '0.7.6+commit.7338295f',
    functions: 31,
    immutables: 7,
    uses: ['receiveMessage(bytes message,bytes attestation)'],
  },
  {
    name: 'usdc',
    proxy: 'zeppelinos',
    proven: '0x43506849d7c04f9138d1a2050bbf3a0c054402dd',
    contract: '/Users/aloysius.chan/Repositories/circlefin/stablecoin-evm-private-eurc-mainnet-eth/contracts/v2/FiatTokenV2_2.sol:FiatTokenV2_2',
    compiler: '0.6.12+commit.27d51765',
    functions: 55,
    immutables: 0,
    uses: ['approve(address spender,uint256 value)', 'transfer(address to,uint256 value)'],
  },
  {
    name: 'cbbtc',
    proxy: 'zeppelinos',
    proven: '0x7458bfdc30034eb860b265e6068121d18fa5aa72',
    contract: 'lib/stablecoin-evm/contracts/v2/FiatTokenV2_1.sol:FiatTokenV2_1',
    compiler: '0.6.12+commit.27d51765',
    functions: 50,
    immutables: 0,
    uses: ['approve(address spender,uint256 value)', 'transfer(address to,uint256 value)'],
  },
] as const;

/** Sourcify holds these as partial matches: the source compiles to the code on chain except the metadata hash. */
const PARTIAL = ['morpho-urd', 'cctp-message-transmitter', 'usdc'];

const generated = readdirSync(join(ROOT, TEMPLATES_DIR)).flatMap((protocol) =>
  readdirSync(join(ROOT, TEMPLATES_DIR, protocol))
    .map((operation) => `${protocol}/${operation}`)
    .filter((id) => existsSync(join(ROOT, TEMPLATES_DIR, id, GENERATED_FILE))),
);

const vaultReports = existsSync(join(ROOT, VAULT_REPORTS_DIR)) ? readdirSync(join(ROOT, VAULT_REPORTS_DIR)).filter((f) => f.endsWith(GENERATED_SUFFIX)) : [];
const vaultsReported = vaultReports.map((file) => file.slice(0, -GENERATED_SUFFIX.length));
const reportTargets: Target[] = [...generated.map((template) => ({ template })), ...vaultsReported.map((vault) => ({ vault }))];

const compilers = await warmCompilers([...CASES.map((expected) => load(expected.name)), ...reportCases(ROOT, registry, reportTargets)]);

test('every committed generated report has its own test below', () => {
  assert.ok(generated.includes('morpho/vault-deposit'), `morpho/vault-deposit has a generated report`);
  assert.ok(vaultsReported.length > 0, `${VAULT_REPORTS_DIR} holds a vault report`);
  const checked = [...generated.map((id) => join(TEMPLATES_DIR, id, GENERATED_FILE)), ...vaultReports.map((file) => join(VAULT_REPORTS_DIR, file))].sort();
  const committed = execFileSync('git', ['ls-files', `*${GENERATED_SUFFIX}`], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((line) => line !== '').sort();
  assert.deepEqual(checked, committed, 'each committed *.generated.md needs a test, and each generated report must be committed: git add a report you just wrote');
});

for (const id of generated) {
  test(`${TEMPLATES_DIR}/${id}/${GENERATED_FILE} is what the program writes from the repository and its recordings`, { timeout: 600_000 }, async () => {
    assert.ok(!('unavailable' in suffixes), `the source checks need the pinned Public Suffix List: ${'unavailable' in suffixes ? suffixes.unavailable : ''}`);
    const committed = readFileSync(join(ROOT, TEMPLATES_DIR, id, GENERATED_FILE), 'utf8');
    const text = await replayReport(ROOT, registry, { template: id }, compilers, suffixes);
    assert.ok(text === committed, `${TEMPLATES_DIR}/${id}/${GENERATED_FILE} differs from \`pnpm report ${id} --offline\`; run \`pnpm report ${id} --record\` and never edit it by hand`);
    assert.ok(!text.includes('REFUSED: `unverifiable`'), `an ABI case of ${id} lacks a read the proof now makes; delete it and run \`pnpm report ${id} --record\``);
  });
}

for (const vault of vaultsReported) {
  test(`${VAULT_REPORTS_DIR}/${vault}${GENERATED_SUFFIX} is what pnpm report --vault writes from its recordings`, { timeout: 600_000 }, async () => {
    const committed = readFileSync(join(ROOT, VAULT_REPORTS_DIR, `${vault}${GENERATED_SUFFIX}`), 'utf8');
    const text = await replayReport(ROOT, registry, { vault }, compilers, suffixes);
    assert.ok(text === committed, `${VAULT_REPORTS_DIR}/${vault}${GENERATED_SUFFIX} differs from \`pnpm report --vault ${vault} --offline\`; run \`pnpm report --vault ${vault} --record\``);
    assert.ok(!text.includes('## Card'), 'a vault report has no template sections');
    const entry = registry.entries.get(vault)!;
    for (const name of [vault, ...Object.values(entry.attributes)]) assert.match(text, new RegExp(`^\\| \`${name.replace(/\./g, '\\.')}\` \\| \`0x[0-9a-fA-F]{40}\` \\|`, 'm'));
    assert.match(text, /stored output of `pnpm vault-evidence`/);
  });
}

for (const expected of CASES) {
  test(`${expected.name}: the pinned solc rebuilds the code read on chain, so its ABI is proven`, async () => {
    const fixture = load(expected.name);
    const proof = proven(await proveAbi(abiCaseReader(fixture), fixture.address, abiCaseBlock(fixture), { sourcify: abiCaseSourcify(fixture.sourcify), compilers }));
    assert.equal(proof.address, fixture.address);
    assert.deepEqual(proof.block, abiCaseBlock(fixture));
    assert.deepEqual(proof.providers, fixture.providers);
    assert.equal(proof.proxy.kind, expected.proxy);
    assert.equal(proof.proven, expected.proven);
    assert.equal(`${proof.contractPath}:${proof.contractName}`, expected.contract);
    assert.equal(proof.compiler, expected.compiler);
    assert.equal(proof.source, 'sourcify');
    assert.equal(proof.abi.filter((entry) => entry.type === 'function').length, expected.functions);
    assert.equal(proof.immutablesMasked, expected.immutables);
    assert.equal(proof.metadataHashMasked, PARTIAL.includes(expected.name));
    assert.equal(proof.codeHash, codeHashOf(fixture, expected.proven));
    assert.equal(proof.proxyCodeHash, expected.proxy === 'none' ? undefined : codeHashOf(fixture, fixture.address));
    const functions = proof.abi.filter((entry) => entry.type === 'function').map((entry) => parseFunctionSignature(namedSignatureOfAbiEntry(entry)));
    for (const used of expected.uses) {
      assert.deepEqual(functions.find((fn) => fn.signature === parseFunctionSignature(used).signature), parseFunctionSignature(used), `${used} is in the proven ABI with these names`);
    }
  });
}

test('a proxy names its implementation, and a Safe proxy names its factory', async () => {
  const safe = load('safe-proxy-1-3-0');
  const proof = proven(await proveAbi(abiCaseReader(safe), safe.address, abiCaseBlock(safe), { sourcify: abiCaseSourcify(safe.sourcify), compilers }));
  assert.deepEqual(proof.proxy, { kind: 'safe', factory: 'GnosisSafeProxy 1.3.0', implementation: '0x3e5c63644e683549055b9be8653de26e0b4cd36e' });
});

test("GeneralAdapter1's source is refused for Bundler3's code", async () => {
  const bundler3 = load('bundler3');
  const adapter = load('general-adapter1').sourcify[GENERAL_ADAPTER1] as SourcifyAnswer;
  const lying = { [BUNDLER3]: { status: 200, body: { ...(adapter.body as object), address: BUNDLER3 } } };
  const refused = refusal(await proveAbi(abiCaseReader(bundler3), BUNDLER3, abiCaseBlock(bundler3), { sourcify: abiCaseSourcify(lying), compilers }));
  assert.equal(refused.why, 'bytecode-mismatch');
  assert.match(describeRefusal(refused), /compiled code differs from the code at 0x6566194141eefa99af43bb5aa71460ca2dc90245/);
});

test('a source with one changed literal is refused', async () => {
  const fixture = load('bundler3');
  const answer = structuredClone(fixture.sourcify[BUNDLER3]) as { status: number; body: { stdJsonInput: { sources: Record<string, { content: string }> } } };
  const file = answer.body.stdJsonInput.sources['src/Bundler3.sol'] as { content: string };
  assert.ok(file.content.includes('bundle.length > 0'));
  file.content = file.content.replace('bundle.length > 0', 'bundle.length > 1');
  const refused = refusal(await proveAbi(abiCaseReader(fixture), BUNDLER3, abiCaseBlock(fixture), { sourcify: abiCaseSourcify({ [BUNDLER3]: answer }), compilers }));
  assert.equal(refused.why, 'bytecode-mismatch');
});

test('code whose trailer carries no metadata hash still has every byte compared: one changed literal is refused', async () => {
  const fixture = load('morpho-vault-v2-apex');
  const answer = structuredClone(fixture.sourcify[fixture.address]) as { status: number; body: { stdJsonInput: { sources: Record<string, { content: string }> } } };
  const file = Object.values(answer.body.stdJsonInput.sources).find(({ content }) => content.includes('MAX_PERFORMANCE_FEE = 0.5e18'));
  assert.ok(file !== undefined);
  file.content = file.content.replace('MAX_PERFORMANCE_FEE = 0.5e18', 'MAX_PERFORMANCE_FEE = 0.6e18');
  const refused = refusal(
    await proveAbi(abiCaseReader(fixture), fixture.address, abiCaseBlock(fixture), { sourcify: abiCaseSourcify({ [fixture.address]: answer }), compilers }),
  );
  assert.equal(refused.why, 'bytecode-mismatch');
});

test('a partial match is proven only up to the metadata hash: one changed literal is still refused', async () => {
  const fixture = load('morpho-urd');
  const answer = structuredClone(fixture.sourcify[fixture.address]) as { status: number; body: { stdJsonInput: { sources: Record<string, { content: string }> } } };
  const file = answer.body.stdJsonInput.sources['src/UniversalRewardsDistributor.sol'] as { content: string };
  assert.ok(file.content.includes('claimable > claimed[account][reward]'));
  file.content = file.content.replace('claimable > claimed[account][reward]', 'claimable >= claimed[account][reward]');
  const refused = refusal(
    await proveAbi(abiCaseReader(fixture), fixture.address, abiCaseBlock(fixture), { sourcify: abiCaseSourcify({ [fixture.address]: answer }), compilers }),
  );
  assert.equal(refused.why, 'bytecode-mismatch');
});

test('a partial match whose code on chain differs outside the metadata hash is refused', async () => {
  const fixture = load('cctp-message-transmitter');
  const reads = fixture.reads.map((read) => {
    if (read.method !== 'getCode') return read;
    const code = read.value as string;
    const at = code.length - 2 * 60;
    return { ...read, value: `${code.slice(0, at)}${code[at] === '0' ? '1' : '0'}${code.slice(at + 1)}` };
  });
  const refused = refusal(
    await proveAbi(abiCaseReader({ ...fixture, reads }), fixture.address, abiCaseBlock(fixture), { sourcify: abiCaseSourcify(fixture.sourcify), compilers }),
  );
  assert.equal(refused.why, 'bytecode-mismatch');
});

test('a compiler file whose sha256 differs from the pin is refused', async () => {
  const fixture = load('bundler3');
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-solc-'));
  const pin = SOLC_PINS['0.8.28+commit.7893614a'];
  assert.ok(pin !== undefined);
  writeFileSync(join(dir, pin.file), 'var Module = {};\n');
  const refused = refusal(
    await proveAbi(abiCaseReader(fixture), BUNDLER3, abiCaseBlock(fixture), { sourcify: abiCaseSourcify(fixture.sourcify), compilers: pinnedCompilers(dir) }),
  );
  assert.equal(refused.why, 'compiler-hash-mismatch');
  assert.match(describeRefusal(refused), /not the pinned 72ef580a.*pnpm fetch-solc/);
});

test('a missing compiler file is refused with the command that fetches it', async () => {
  const fixture = load('bundler3');
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-solc-'));
  const refused = refusal(
    await proveAbi(abiCaseReader(fixture), BUNDLER3, abiCaseBlock(fixture), { sourcify: abiCaseSourcify(fixture.sourcify), compilers: pinnedCompilers(dir) }),
  );
  assert.equal(refused.why, 'compiler-missing');
  assert.match(describeRefusal(refused), /run `pnpm fetch-solc`/);
});

test('a compiler version with no pin is refused', async () => {
  const fixture = load('bundler3');
  const answer = structuredClone(fixture.sourcify[BUNDLER3]) as { status: number; body: { compilation: { compilerVersion: string } } };
  answer.body.compilation.compilerVersion = '0.8.29+commit.ab55807c';
  const refused = refusal(await proveAbi(abiCaseReader(fixture), BUNDLER3, abiCaseBlock(fixture), { sourcify: abiCaseSourcify({ [BUNDLER3]: answer }), compilers }));
  assert.deepEqual(refused, { why: 'compiler-not-pinned', version: '0.8.29+commit.ab55807c' });
});

test('an unverifiable code read is refused, not proven', async () => {
  const fixture = load('bundler3');
  const reader = abiCaseReader(fixture, [], { getCode: () => Promise.resolve(unverifiable('eth_getCode: alchemy and drpc disagree')) });
  const refused = refusal(await proveAbi(reader, BUNDLER3, abiCaseBlock(fixture), { sourcify: abiCaseSourcify(fixture.sourcify), compilers }));
  assert.deepEqual(refused, { why: 'unverifiable', read: 'eth_getCode: alchemy and drpc disagree' });
});

test('a contract Sourcify has not verified is refused', async () => {
  const fixture = load('bundler3');
  const refused = refusal(await proveAbi(abiCaseReader(fixture), BUNDLER3, abiCaseBlock(fixture), { sourcify: abiCaseSourcify({}), compilers }));
  assert.deepEqual(refused, { why: 'not-on-sourcify', at: BUNDLER3 });
});

test('an EIP-1167 minimal proxy proves the code it delegates to', async () => {
  const fixture = load('bundler3');
  const clone = `0x${'c1'.repeat(20)}` as Address;
  const code = `0x363d3d373d3d3d363d73${BUNDLER3.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  const reader = abiCaseReader(fixture, [{ method: 'getCode', args: [clone], value: code }]);
  const proof = proven(await proveAbi(reader, clone, abiCaseBlock(fixture), { sourcify: abiCaseSourcify(fixture.sourcify), compilers }));
  assert.deepEqual(proof.proxy, { kind: 'eip1167', implementation: BUNDLER3 });
  assert.equal(proof.contractName, 'Bundler3');
});

test('an EIP-1967 slot on code that cannot DELEGATECALL is refused', async () => {
  const fixture = load('bundler3');
  const slot = `0x${EIP1967_IMPLEMENTATION_SLOT.toString(16)}`;
  const reader = abiCaseReader(fixture, [{ method: 'getStorageAt', args: [BUNDLER3, slot], value: `0x${GENERAL_ADAPTER1.slice(2).padStart(64, '0')}` }]);
  const refused = refusal(await proveAbi(reader, BUNDLER3, abiCaseBlock(fixture), { sourcify: abiCaseSourcify(fixture.sourcify), compilers }));
  assert.equal(refused.why, 'slot-without-delegatecall');
});

test('an address with no code is refused', async () => {
  const fixture = load('bundler3');
  const empty = `0x${'e0'.repeat(20)}` as Address;
  const reader = abiCaseReader(fixture, [{ method: 'getCode', args: [empty], value: '0x' }]);
  const refused = refusal(await proveAbi(reader, empty, abiCaseBlock(fixture), { sourcify: abiCaseSourcify(fixture.sourcify), compilers }));
  assert.deepEqual(refused, { why: 'no-code', at: empty });
});
