import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderName } from '../chain/providers.ts';
import type { CallRequest, Read, Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { implementationReadJson, parseImplementationRead } from '../registry.ts';
import type { ProxyDeclaration } from '../registry.ts';
import type { Address, Hex } from '../safe/types.ts';
import { proveAbi } from './prove.ts';
import type { AbiProof, AbiRefusal, ProveDeps } from './prove.ts';
import type { EtherscanAnswer } from './etherscan.ts';
import { readRecording } from '../chain/bytecode.ts';

export type RecordedRead = { readonly method: string; readonly args: readonly unknown[]; readonly value: unknown };

/** One ABI proof's inputs: the chain reads both providers agreed on at one block, and Etherscan's answers. */
export type AbiCase = {
  readonly address: Address;
  readonly block: { readonly number: string; readonly hash: Hex };
  readonly providers: readonly [ProviderName, ProviderName];
  readonly reads: readonly RecordedRead[];
  readonly etherscan: Readonly<Record<string, EtherscanAnswer>>;
  /** The registry entry's `implementationRead` the proof followed, as written there. */
  readonly implementationRead?: unknown;
};

export const ABI_CASES_DIR = join('testdata', 'abi');

export const abiCaseBlock = (fixture: AbiCase): BlockRef => ({ number: BigInt(fixture.block.number), hash: fixture.block.hash });

const NOT_RECORDED = 'not recorded';

const callArgs = (request: CallRequest): unknown[] =>
  request.override === undefined ? [request.to, request.data] : [request.to, request.data, request.override.address, request.override.code];

/** The declaration a case was recorded with, parsed as the registry parses it. */
export const abiCaseDeclaration = (fixture: AbiCase): ProxyDeclaration =>
  fixture.implementationRead === undefined ? {} : { implementationRead: parseImplementationRead(`${fixture.address}.implementationRead`, fixture.implementationRead) };

const unverifiable = <T>(reason: string): Read<T> => ({
  kind: 'unverifiable',
  reason,
  answers: [
    { provider: 'alchemy', kind: 'failed', cause: 'no-answer' },
    { provider: 'drpc', kind: 'failed', cause: 'no-answer' },
  ],
});

/** Answers only the reads the recording made, at the recorded block, as both providers agreed on them. */
export function abiCaseReader(fixture: AbiCase, extra: readonly RecordedRead[] = [], overrides: Partial<Reader> = {}): Reader {
  const reads = [...extra, ...fixture.reads];
  const answer = <T>(at: BlockRef, method: string, args: unknown[]): Promise<Read<T>> => {
    const found = reads.find((read) => read.method === method && JSON.stringify(read.args) === JSON.stringify(args));
    if (at.hash !== fixture.block.hash || found === undefined) return Promise.resolve(unverifiable(NOT_RECORDED));
    return Promise.resolve({ kind: 'agreed', value: found.value as T, providers: fixture.providers });
  };
  return {
    providers: fixture.providers,
    blockNumber: () => Promise.resolve(unverifiable(NOT_RECORDED)),
    block: () => Promise.resolve(unverifiable(NOT_RECORDED)),
    header: () => Promise.resolve(unverifiable(NOT_RECORDED)),
    simulateV1: () => Promise.resolve(unverifiable(NOT_RECORDED)),
    getTransactionReceipt: () => Promise.resolve(unverifiable(NOT_RECORDED)),
    getTransaction: () => Promise.resolve(unverifiable(NOT_RECORDED)),
    getBalance: () => Promise.resolve(unverifiable(NOT_RECORDED)),
    getTransactionCount: () => Promise.resolve(unverifiable(NOT_RECORDED)),
    getCode: (address, at) => answer(at, 'getCode', [address]),
    getStorageAt: (address, slot, at) => answer(at, 'getStorageAt', [address, `0x${slot.toString(16)}`]),
    call: (request, at) => answer(at, 'call', callArgs(request)),
    ...overrides,
  };
}

export const abiCaseEtherscan =
  (answers: Readonly<Record<string, EtherscanAnswer>>) =>
  async (address: Address): Promise<EtherscanAnswer> =>
    answers[address] ?? { status: 200, body: { status: '1', message: 'OK', result: [{ SourceCode: '', ABI: 'Contract source code not verified' }] } };

/**
 * Proves the ABI again from a recording alone: the recorded code and Etherscan source, compiled with the pinned solc.
 * `declared` is the registry entry's declaration when there is an entry, so a case recorded under another one fails.
 */
export const replayAbiCase = (fixture: AbiCase, compilers: ProveDeps['compilers'], declared: ProxyDeclaration = abiCaseDeclaration(fixture)): Promise<AbiProof | AbiRefusal> =>
  proveAbi(abiCaseReader(fixture), fixture.address, abiCaseBlock(fixture), { etherscan: abiCaseEtherscan(fixture.etherscan), compilers }, declared);

/** Proves the ABI live and keeps every read and Etherscan answer it used. A read the providers disagree on throws. */
export async function recordAbiCase(
  live: Reader,
  address: Address,
  block: BlockRef,
  providers: readonly [ProviderName, ProviderName],
  deps: ProveDeps,
  declared: ProxyDeclaration = {},
): Promise<{ proof: AbiProof | AbiRefusal; fixture: AbiCase }> {
  const reads: RecordedRead[] = [];
  const hex = (n: bigint) => `0x${n.toString(16)}`;
  const kept = async <T>(method: string, args: unknown[], read: Promise<Read<T>>): Promise<Read<T>> => {
    const answer = await read;
    if (answer.kind === 'unverifiable') throw new Error(`${method}: ${answer.reason}`);
    reads.push({ method, args, value: answer.value });
    return answer;
  };
  const recorder: Reader = {
    ...live,
    getCode: (at, ref) => kept('getCode', [at], live.getCode(at, ref)),
    getStorageAt: (at, slot, ref) => kept('getStorageAt', [at, hex(slot)], live.getStorageAt(at, slot, ref)),
    call: (request, ref) => kept('call', callArgs(request), live.call(request, ref)),
  };
  const etherscan: Record<string, EtherscanAnswer> = {};
  const proof = await proveAbi(
    recorder,
    address,
    block,
    {
      compilers: deps.compilers,
      etherscan: async (at) => {
        const answer = await deps.etherscan(at);
        etherscan[at] = answer;
        return answer;
      },
    },
    declared,
  );
  const read = declared.implementationRead === undefined ? {} : { implementationRead: implementationReadJson(declared.implementationRead) };
  return { proof, fixture: { address, block: { number: block.number.toString(), hash: block.hash }, providers, reads, etherscan, ...read } };
}

/** Every recorded case under `testdata/abi/`, by the address it proves; of two for one address, the later block. */
export function loadAbiCases(repoRoot: string): Map<Address, AbiCase> {
  const dir = join(repoRoot, ABI_CASES_DIR);
  const cases = new Map<Address, AbiCase>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const fixture = readRecording(join(dir, file)) as AbiCase;
    const address = fixture.address.toLowerCase() as Address;
    const known = cases.get(address);
    if (known === undefined || BigInt(known.block.number) < BigInt(fixture.block.number)) cases.set(address, fixture);
  }
  return cases;
}
