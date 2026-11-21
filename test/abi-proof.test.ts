import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Read } from '../src/chain/reader.ts';
import { namedSignatureOfAbiEntry, parseFunctionSignature } from '../src/decode/abi.ts';
import { abiCaseBlock, abiCaseReader, abiCaseEtherscan } from '../src/contracts/abi-case.ts';
import type { AbiCase } from '../src/contracts/abi-case.ts';
import { describeRefusal, proveAbi } from '../src/contracts/prove.ts';
import type { AbiProof, AbiRefusal, Refusal } from '../src/contracts/prove.ts';
import { EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT, ZEPPELINOS_IMPLEMENTATION_SLOT } from '../src/contracts/proxy.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import { SOLC_PINS } from '../src/contracts/solc-pins.ts';
import type { EtherscanAnswer } from '../src/contracts/etherscan.ts';
import { loadRegistry } from '../src/registry.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { GENERATED_SUFFIX, generatedPath, replayReport, templateTargets } from '../src/research/report.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const suffixes = loadPublicSuffixList();

const load = (name: string): AbiCase => readRecording(join(ROOT, 'testdata', 'abi', `${name}.json`)) as AbiCase;

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

/** A copy of an Etherscan answer with its one result changed by `change`. */
function edited(answer: EtherscanAnswer | undefined, change: (result: Record<string, string>) => void): EtherscanAnswer {
  const copy = structuredClone(answer) as EtherscanAnswer & { body: { result: Record<string, string>[] } };
  change(copy.body.result[0] as Record<string, string>);
  return copy;
}

function replaced(answer: EtherscanAnswer | undefined, from: string, to: string): EtherscanAnswer {
  return edited(answer, (result) => {
    const source = result.SourceCode ?? '';
    assert.ok(source.includes(from), `the source holds ${from}`);
    result.SourceCode = source.replace(from, to);
  });
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
    name: 'general-adapter-1',
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
    contract: 'lib/vault-v2/src/VaultV2.sol:VaultV2',
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
  {
    name: 'usdt',
    proxy: 'none',
    proven: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    contract: 'TetherToken.sol:TetherToken',
    compiler: '0.4.18+commit.9cf6e910',
    functions: 32,
    immutables: 0,
    uses: ['approve(address _spender,uint256 _value)', 'transfer(address _to,uint256 _value)'],
  },
  {
    name: 'multisend-1-5-0',
    proxy: 'none',
    proven: '0x218543288004cd07832472d464648173c77d7eb7',
    contract: 'contracts/libraries/MultiSend.sol:MultiSend',
    compiler: '0.7.6+commit.7338295f',
    functions: 1,
    immutables: 1,
    uses: ['multiSend(bytes transactions)'],
  },
  {
    name: 'multisend-call-only-1-5-0',
    proxy: 'none',
    proven: '0xa83c336b20401af773b6219ba5027174338d1836',
    contract: 'contracts/libraries/MultiSendCallOnly.sol:MultiSendCallOnly',
    compiler: '0.7.6+commit.7338295f',
    functions: 1,
    immutables: 0,
    uses: ['multiSend(bytes transactions)'],
  },
] as const;

/** Etherscan's source for these compiles to the code on chain except the metadata hash. */
const PARTIAL = ['cctp-message-transmitter', 'usdc', 'usdt'];

const generated = templateTargets(ROOT, registry).filter((target) => existsSync(join(ROOT, generatedPath(ROOT, target))));

const compilers = await warmCompilers([...CASES.map((expected) => load(expected.name)), ...reportCases(ROOT, registry, generated)]);

test('every committed generated report has its own test below', () => {
  assert.ok(generated.some((target) => target.template === 'morpho/vault-deposit'), `morpho/vault-deposit has a generated report`);
  const checked = generated.map((target) => generatedPath(ROOT, target)).sort();
  const committed = execFileSync('git', ['ls-files', `*${GENERATED_SUFFIX}`], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((line) => line !== '').sort();
  assert.deepEqual(checked, committed, 'each committed *.generated.md needs a test, and each generated report must be committed: git add a report you just wrote');
});

for (const target of generated) {
  const path = generatedPath(ROOT, target);
  const args = target.instance === undefined ? target.template : `${target.template} --instance-of ${target.instance}`;
  test(`${path} is what the program writes from the repository and its recordings`, { timeout: 600_000 }, async () => {
    assert.ok(!('unavailable' in suffixes), `the source checks need the pinned Public Suffix List: ${'unavailable' in suffixes ? suffixes.unavailable : ''}`);
    const committed = readFileSync(join(ROOT, path), 'utf8');
    const text = await replayReport(ROOT, registry, target, compilers, suffixes);
    assert.ok(text === committed, `${path} differs from \`pnpm report ${args} --offline\`; run \`pnpm report ${args} --record\` and never edit it by hand`);
    assert.ok(!text.includes('REFUSED: `unverifiable`'), `an ABI case of ${args} lacks a read the proof now makes; delete it and run \`pnpm report ${args} --record\``);
    const missing = text.split('\n').find((line) => line.includes('FINDING: not in the ABI'));
    assert.equal(missing, undefined, `${args} calls or reads a function its contract's proven ABI does not hold`);
  });
}

for (const expected of CASES) {
  test(`${expected.name}: the pinned solc rebuilds the code read on chain, so its ABI is proven`, async () => {
    const fixture = load(expected.name);
    const proof = proven(await proveAbi(abiCaseReader(fixture), fixture.address, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers }));
    assert.equal(proof.address, fixture.address);
    assert.deepEqual(proof.block, abiCaseBlock(fixture));
    assert.deepEqual(proof.providers, fixture.providers);
    assert.equal(proof.proxy.kind, expected.proxy);
    assert.equal(proof.proven, expected.proven);
    assert.equal(`${proof.contractPath}:${proof.contractName}`, expected.contract);
    assert.equal(proof.compiler, expected.compiler);
    assert.equal(proof.source, 'etherscan');
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
  const proof = proven(await proveAbi(abiCaseReader(safe), safe.address, abiCaseBlock(safe), { etherscan: abiCaseEtherscan(safe.etherscan), compilers }));
  assert.deepEqual(proof.proxy, { kind: 'safe', factory: 'GnosisSafeProxy 1.3.0', implementation: '0x3e5c63644e683549055b9be8653de26e0b4cd36e' });
});

test("GeneralAdapter1's source is refused for Bundler3's code", async () => {
  const bundler3 = load('bundler3');
  const lying = { [BUNDLER3]: load('general-adapter-1').etherscan[GENERAL_ADAPTER1] as EtherscanAnswer };
  const refused = refusal(await proveAbi(abiCaseReader(bundler3), BUNDLER3, abiCaseBlock(bundler3), { etherscan: abiCaseEtherscan(lying), compilers }));
  assert.equal(refused.why, 'bytecode-mismatch');
  assert.match(describeRefusal(refused), /compiled code differs from the code at 0x6566194141eefa99af43bb5aa71460ca2dc90245/);
});

test('a source with one changed literal is refused', async () => {
  const fixture = load('bundler3');
  const answer = replaced(fixture.etherscan[BUNDLER3], 'bundle.length > 0', 'bundle.length > 1');
  const refused = refusal(await proveAbi(abiCaseReader(fixture), BUNDLER3, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan({ [BUNDLER3]: answer }), compilers }));
  assert.equal(refused.why, 'bytecode-mismatch');
});

test('code whose trailer carries no metadata hash still has every byte compared: one changed literal is refused', async () => {
  const fixture = load('morpho-vault-v2-apex');
  const answer = replaced(fixture.etherscan[fixture.address], 'MAX_PERFORMANCE_FEE = 0.5e18', 'MAX_PERFORMANCE_FEE = 0.6e18');
  const refused = refusal(
    await proveAbi(abiCaseReader(fixture), fixture.address, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan({ [fixture.address]: answer }), compilers }),
  );
  assert.equal(refused.why, 'bytecode-mismatch');
});

test('a partial match is proven only up to the metadata hash: one changed literal is still refused', async () => {
  const fixture = load('cctp-message-transmitter');
  const answer = replaced(fixture.etherscan[fixture.address], '_numEnabledAttesters > 1', '_numEnabledAttesters > 2');
  const refused = refusal(
    await proveAbi(abiCaseReader(fixture), fixture.address, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan({ [fixture.address]: answer }), compilers }),
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
    await proveAbi(abiCaseReader({ ...fixture, reads }), fixture.address, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers }),
  );
  assert.equal(refused.why, 'bytecode-mismatch');
});

test('a partial match with a Swarm metadata hash is refused when the code on chain differs just before its trailer', async () => {
  const fixture = load('usdt');
  const reads = fixture.reads.map((read) => {
    if (read.method !== 'getCode') return read;
    const code = read.value as string;
    const at = code.length - 2 * 45;
    return { ...read, value: `${code.slice(0, at)}${code[at] === '0' ? '1' : '0'}${code.slice(at + 1)}` };
  });
  const refused = refusal(
    await proveAbi(abiCaseReader({ ...fixture, reads }), fixture.address, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers }),
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
    await proveAbi(abiCaseReader(fixture), BUNDLER3, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers: pinnedCompilers(dir) }),
  );
  assert.equal(refused.why, 'compiler-hash-mismatch');
  assert.match(describeRefusal(refused), /not the pinned 72ef580a.*pnpm fetch-solc/);
});

test('a missing compiler file is refused with the command that fetches it', async () => {
  const fixture = load('bundler3');
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-solc-'));
  const refused = refusal(
    await proveAbi(abiCaseReader(fixture), BUNDLER3, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers: pinnedCompilers(dir) }),
  );
  assert.equal(refused.why, 'compiler-missing');
  assert.match(describeRefusal(refused), /run `pnpm fetch-solc`/);
});

test('a compiler version with no pin is refused', async () => {
  const fixture = load('bundler3');
  const answer = edited(fixture.etherscan[BUNDLER3], (result) => {
    result.CompilerVersion = 'v0.8.29+commit.ab55807c';
  });
  const refused = refusal(await proveAbi(abiCaseReader(fixture), BUNDLER3, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan({ [BUNDLER3]: answer }), compilers }));
  assert.deepEqual(refused, { why: 'compiler-not-pinned', version: '0.8.29+commit.ab55807c' });
  assert.match(describeRefusal(refused), /run `pnpm pin-solc 0\.8\.29\+commit\.ab55807c`$/);
});

test('an unverifiable code read is refused, not proven', async () => {
  const fixture = load('bundler3');
  const reader = abiCaseReader(fixture, [], { getCode: () => Promise.resolve(unverifiable('eth_getCode: alchemy and drpc disagree')) });
  const refused = refusal(await proveAbi(reader, BUNDLER3, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers }));
  assert.deepEqual(refused, { why: 'unverifiable', read: 'eth_getCode: alchemy and drpc disagree' });
});

test('a contract Etherscan has not verified is refused', async () => {
  const fixture = load('bundler3');
  const refused = refusal(await proveAbi(abiCaseReader(fixture), BUNDLER3, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan({}), compilers }));
  assert.deepEqual(refused, { why: 'not-on-etherscan', at: BUNDLER3 });
});

test('an EIP-1167 minimal proxy proves the code it delegates to', async () => {
  const fixture = load('bundler3');
  const clone = `0x${'c1'.repeat(20)}` as Address;
  const code = `0x363d3d373d3d3d363d73${BUNDLER3.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  const reader = abiCaseReader(fixture, [{ method: 'getCode', args: [clone], value: code }]);
  const proof = proven(await proveAbi(reader, clone, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers }));
  assert.deepEqual(proof.proxy, { kind: 'eip1167', implementation: BUNDLER3 });
  assert.equal(proof.contractName, 'Bundler3');
});

test('an EIP-1967 slot on code that cannot DELEGATECALL is refused', async () => {
  const fixture = load('bundler3');
  const slot = `0x${EIP1967_IMPLEMENTATION_SLOT.toString(16)}`;
  const reader = abiCaseReader(fixture, [{ method: 'getStorageAt', args: [BUNDLER3, slot], value: `0x${GENERAL_ADAPTER1.slice(2).padStart(64, '0')}` }]);
  const refused = refusal(await proveAbi(reader, BUNDLER3, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers }));
  assert.equal(refused.why, 'slot-without-delegatecall');
});

test('the FLUID token hands a call it has no function for to an implementation in its storage, so its ABI is refused, not proven', async () => {
  const fixture = load('fluid-token');
  const refused = refusal(await proveAbi(abiCaseReader(fixture), fixture.address, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers }));
  assert.deepEqual(refused, { why: 'unknown-delegator', at: fixture.address, pc: 156 });
  assert.equal(
    describeRefusal(refused),
    '0x6f40d4a6237c257fff2db00fa0510deeecd303eb hands a call it has no function for, at byte 156 of its code, to code the program neither proves nor pins',
  );
});

const UNKNOWN = `0x${'d0'.repeat(20)}` as Address;
const noSlots = (address: Address) =>
  [EIP1967_IMPLEMENTATION_SLOT, EIP1967_BEACON_SLOT, ZEPPELINOS_IMPLEMENTATION_SLOT].map((slot) => ({
    method: 'getStorageAt',
    args: [address, `0x${slot.toString(16)}`],
    value: `0x${'0'.repeat(64)}`,
  }));
const DELEGATE_TO_MEMORY_WORD_0 = '5f5f5f5f5f515af400';

async function proveUnknown(code: string): Promise<AbiProof | AbiRefusal> {
  const fixture = load('bundler3');
  const reader = abiCaseReader(fixture, [{ method: 'getCode', args: [UNKNOWN], value: `0x${code}` }, ...noSlots(UNKNOWN)]);
  return proveAbi(reader, UNKNOWN, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan({}), compilers });
}

test('a fallback that delegates to an address it moved from storage through memory is refused', async () => {
  const refused = refusal(await proveUnknown(`5f545f52${DELEGATE_TO_MEMORY_WORD_0}`));
  assert.equal(refused.why, 'unknown-delegator');
});

test("a fallback that delegates to the address another contract answered is refused, as a beacon's would be", async () => {
  const refused = refusal(await proveUnknown(`60205f5f5f5f73${'be'.repeat(20)}5af150${DELEGATE_TO_MEMORY_WORD_0}`));
  assert.equal(refused.why, 'unknown-delegator');
});

test('a fallback that delegates to a constant address is refused, since the code there is neither proven nor pinned', async () => {
  const refused = refusal(await proveUnknown(`5f5f5f5f73${'be'.repeat(20)}5af400`));
  assert.equal(refused.why, 'unknown-delegator');
});

test('a fallback that delegates to an address in the call data is not refused for delegating, so the proof goes on to its source', async () => {
  const refused = refusal(await proveUnknown('5f5f5f5f60043560a01b60a01c5af400'));
  assert.deepEqual(refused, { why: 'not-on-etherscan', at: UNKNOWN });
});

test('a fallback that runs code from storage through CALLCODE alone is refused', async () => {
  const refused = refusal(await proveUnknown('5f5f365f5f5f545af200'));
  assert.equal(refused.why, 'unknown-delegator');
});

test('a delegator whose last two bytes read like a metadata length is still refused', async () => {
  const refused = refusal(await proveUnknown('5f5f365f5f545af4000002'));
  assert.equal(refused.why, 'unknown-delegator');
});

test('an EIP-1967 slot does not vouch for code that delegates through another slot', async () => {
  const fixture = load('fluid-token');
  const slot = `0x${EIP1967_IMPLEMENTATION_SLOT.toString(16)}`;
  const reader = abiCaseReader(fixture, [{ method: 'getStorageAt', args: [fixture.address, slot], value: `0x${BUNDLER3.slice(2).padStart(64, '0')}` }]);
  const refused = refusal(await proveAbi(reader, fixture.address, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers }));
  assert.deepEqual(refused, { why: 'unknown-delegator', at: fixture.address, pc: 156 });
});

test('a fallback that delegates to the contract itself, or to the first word of the call data, is not refused for delegating', async () => {
  assert.deepEqual(refusal(await proveUnknown('5f5f365f5f305af400')), { why: 'not-on-etherscan', at: UNKNOWN });
  assert.deepEqual(refusal(await proveUnknown('5f5f365f5f5f355af400')), { why: 'not-on-etherscan', at: UNKNOWN });
});

test('a fallback the walk cannot follow to its delegatecall is refused, with where and why', async () => {
  assert.deepEqual(refusal(await proveUnknown('5f35565b5f5f5f5f305af400')), { why: 'fallback-unfollowable', at: UNKNOWN, pc: 2, cause: 'dynamic-jump' });
  assert.deepEqual(refusal(await proveUnknown('0c5f5f5f5f305af400')), { why: 'fallback-unfollowable', at: UNKNOWN, pc: 0, cause: 'unknown-opcode' });
  assert.deepEqual(refusal(await proveUnknown('620fffff5b600190038060045700305af4')), { why: 'fallback-unfollowable', at: UNKNOWN, pc: 4, cause: 'too-many-states' });
});

test('an EIP-1967 implementation that itself delegates its fallback to an address in its storage is refused', async () => {
  const fixture = load('morpho-token-eip1967');
  const delegator = load('fluid-token').reads.find((read) => read.method === 'getCode')!.value;
  const implementation = '0x4364fd2371b6318159366abfa51f190df5c24852' as Address;
  const reader = abiCaseReader(fixture, [{ method: 'getCode', args: [implementation], value: delegator }]);
  const refused = refusal(await proveAbi(reader, fixture.address, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers }));
  assert.deepEqual(refused, { why: 'unknown-delegator', at: implementation, pc: 156 });
});

const IMPLEMENTATION = `0x${'1e'.repeat(20)}` as Address;
const word = (value: bigint | string): string => (typeof value === 'bigint' ? value.toString(16) : value.slice(2)).padStart(64, '0');

/** An EIP-1967 proxy at UNKNOWN whose implementation has no fallback of its own. */
async function proveProxy(code: string): Promise<AbiProof | AbiRefusal> {
  const fixture = load('bundler3');
  const reader = abiCaseReader(fixture, [
    { method: 'getCode', args: [UNKNOWN], value: `0x${code}` },
    { method: 'getStorageAt', args: [UNKNOWN, `0x${EIP1967_IMPLEMENTATION_SLOT.toString(16)}`], value: `0x${word(IMPLEMENTATION)}` },
    { method: 'getCode', args: [IMPLEMENTATION], value: '0x00' },
    ...noSlots(UNKNOWN),
  ]);
  return proveAbi(reader, UNKNOWN, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan({}), compilers });
}

/**
 * A fallback that copies the 32 bytes after its last opcode to memory at `to`, runs `then`, and delegates the call to
 * the code at the address in the storage slot that memory word 0 names, as solc compiles a proxy that keeps its slot in
 * its code.
 */
function slotFromCode(copied: string, to = '5f', then = ''): string {
  const ops = (from: number) => `5f5f365f602060${from.toString(16).padStart(2, '0')}${to}39${then}5f51545af400`;
  return `${ops(ops(0).length / 2)}${copied}`;
}

test('a proxy that copies its EIP-1967 slot out of its own code delegates through that slot alone, so the proof goes on to the implementation', async () => {
  assert.deepEqual(refusal(await proveProxy(slotFromCode(word(EIP1967_IMPLEMENTATION_SLOT)))), { why: 'not-on-etherscan', at: IMPLEMENTATION });
});

test('a proxy whose copied word is another slot, or lies elsewhere than where its MLOAD reads, is refused', async () => {
  assert.equal(refusal(await proveProxy(slotFromCode(word(EIP1967_BEACON_SLOT)))).why, 'unknown-delegator');
  assert.equal(refusal(await proveProxy(slotFromCode(word(EIP1967_IMPLEMENTATION_SLOT), '6001'))).why, 'unknown-delegator');
});

test('a proxy whose copied slot is overwritten before its MLOAD, by the call data or one byte, is refused', async () => {
  for (const then of ['60015f601f37', '365f5f37', '60ff601f53']) {
    assert.equal(refusal(await proveProxy(slotFromCode(word(EIP1967_IMPLEMENTATION_SLOT), '5f', then))).why, 'unknown-delegator', then);
  }
});

test('a fallback that delegates to a constant address it stores in memory or copies out of its own code is refused', async () => {
  assert.equal(refusal(await proveUnknown(`73${'be'.repeat(20)}5f52${DELEGATE_TO_MEMORY_WORD_0}`)).why, 'unknown-delegator');
  assert.equal(refusal(await proveUnknown(`6020600f5f39${DELEGATE_TO_MEMORY_WORD_0}${word(`0x${'be'.repeat(20)}`)}`)).why, 'unknown-delegator');
});

test('an address with no code is refused', async () => {
  const fixture = load('bundler3');
  const empty = `0x${'e0'.repeat(20)}` as Address;
  const reader = abiCaseReader(fixture, [{ method: 'getCode', args: [empty], value: '0x' }]);
  const refused = refusal(await proveAbi(reader, empty, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers }));
  assert.deepEqual(refused, { why: 'no-code', at: empty });
});
