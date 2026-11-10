import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { ProviderName } from '../chain/providers.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { locate, minimalProxyTarget, safeProxyFactory } from './proxy.ts';
import type { Proxy, ProxyRefusal } from './proxy.ts';
import type { Compilers } from './solc.ts';
import { parseSourcify } from './sourcify.ts';
import type { SourcifyGet, VerifiedSource } from './sourcify.ts';

export type AbiEntry = Readonly<Record<string, unknown>> & { readonly type: string };

/** The ABI that solc gave for source whose compiled code equals the code at `proven`, except at masked positions. */
export type AbiProof = {
  readonly kind: 'proven';
  readonly address: Address;
  readonly block: BlockRef;
  readonly providers: readonly [ProviderName, ProviderName];
  readonly proxy: Proxy;
  /** The address whose code was compiled and compared: the implementation behind a proxy, else `address`. */
  readonly proven: Address;
  readonly codeHash: Hex;
  /** The keccak256 of the code at `address` when it is a proxy. */
  readonly proxyCodeHash: Hex | undefined;
  readonly compiler: string;
  readonly contractPath: string;
  readonly contractName: string;
  readonly abi: readonly AbiEntry[];
  readonly source: 'sourcify';
  readonly immutablesMasked: number;
  readonly librariesMasked: number;
};

export type Refusal =
  | ProxyRefusal
  | { readonly why: 'no-code'; readonly at: Address }
  | { readonly why: 'chained-proxy'; readonly at: Address }
  | { readonly why: 'not-on-sourcify'; readonly at: Address }
  | { readonly why: 'sourcify-unreadable'; readonly at: Address; readonly detail: string }
  | { readonly why: 'unsupported-language'; readonly language: string }
  | { readonly why: 'compiler-not-pinned'; readonly version: string }
  | { readonly why: 'compiler-missing'; readonly path: string }
  | { readonly why: 'compiler-hash-mismatch'; readonly path: string; readonly expected: string; readonly actual: string }
  | { readonly why: 'compile-failed'; readonly errors: readonly string[] }
  | { readonly why: 'bytecode-mismatch'; readonly at: Address; readonly detail: string };

export type AbiRefusal = { readonly kind: 'refused'; readonly address: Address; readonly block: BlockRef; readonly refusal: Refusal };

export type ProveDeps = { readonly sourcify: SourcifyGet; readonly compilers: Compilers };

export function describeRefusal(refusal: Refusal): string {
  switch (refusal.why) {
    case 'unverifiable':
      return `a chain read is unverifiable: ${refusal.read}`;
    case 'slot-not-an-address':
      return `the ${refusal.slot} slot holds a word that is not an address`;
    case 'beacon-answer-not-an-address':
      return `the beacon ${refusal.beacon} did not answer implementation() with an address`;
    case 'both-eip1967-slots-set':
      return 'both the EIP-1967 implementation and beacon slots are set, so which code runs is unknown';
    case 'slot-without-delegatecall':
      return 'an EIP-1967 slot is set, but the code has no DELEGATECALL, so it does not run that implementation';
    case 'no-code':
      return `${refusal.at} has no code`;
    case 'chained-proxy':
      return `the implementation ${refusal.at} is itself a proxy`;
    case 'not-on-sourcify':
      return `Sourcify has no verified source for ${refusal.at}`;
    case 'sourcify-unreadable':
      return `Sourcify's answer for ${refusal.at} is unreadable: ${refusal.detail}`;
    case 'unsupported-language':
      return `the source is ${refusal.language}; only Solidity is compiled`;
    case 'compiler-not-pinned':
      return `solc ${refusal.version} is not pinned in src/contracts/solc-pins.ts`;
    case 'compiler-missing':
      return `${refusal.path} is missing; run \`pnpm fetch-solc\``;
    case 'compiler-hash-mismatch':
      return `${refusal.path} has sha256 ${refusal.actual}, not the pinned ${refusal.expected}; delete it and run \`pnpm fetch-solc\``;
    case 'compile-failed':
      return `solc reported errors: ${refusal.errors.join(' | ')}`;
    case 'bytecode-mismatch':
      return `the compiled code differs from the code at ${refusal.at}: ${refusal.detail}`;
  }
}

class Refused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.why);
    this.refusal = refusal;
  }
}

const refuse = (refusal: Refusal): never => {
  throw new Refused(refusal);
};

const OUTPUTS = ['abi', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'evm.deployedBytecode.linkReferences'];

type Span = { readonly start: number; readonly length: number };
type Compiled = {
  readonly abi: readonly AbiEntry[];
  readonly code: string;
  readonly immutables: readonly Span[];
  readonly libraries: readonly Span[];
};

type Json = Record<string, unknown>;
const isJson = (raw: unknown): raw is Json => typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const malformedOutput = (problem: string): never => refuse({ why: 'compile-failed', errors: [`solc output ${problem}`] });
const json = (raw: unknown, what: string): Json => (isJson(raw) ? raw : malformedOutput(`has no ${what}`));

function spans(raw: unknown, depth: 1 | 2): Span[] {
  return Object.values(json(raw ?? {}, 'reference map')).flatMap((entry) => {
    if (depth === 2) return spans(entry, 1);
    if (!Array.isArray(entry)) return malformedOutput('has a malformed reference list');
    return entry.map((span: unknown) => {
      const { start, length } = json(span, 'reference');
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)) return malformedOutput('has a malformed reference');
      return { start: start as number, length: length as number };
    });
  });
}

function compile(source: VerifiedSource, compilers: Compilers): Compiled {
  const load = compilers(source.compilerVersion);
  switch (load.kind) {
    case 'not-pinned':
      return refuse({ why: 'compiler-not-pinned', version: load.version });
    case 'missing':
      return refuse({ why: 'compiler-missing', path: load.path });
    case 'hash-mismatch':
      return refuse({ why: 'compiler-hash-mismatch', path: load.path, expected: load.expected, actual: load.actual });
  }
  const { contractPath, contractName } = source;
  const input = {
    language: source.language,
    sources: source.sources,
    settings: { ...source.settings, outputSelection: { [contractPath]: { [contractName]: OUTPUTS } } },
  };
  let output: Json;
  try {
    output = json(JSON.parse(load.solc.compile(JSON.stringify(input))), 'object');
  } catch (error) {
    if (error instanceof Refused) throw error;
    return refuse({ why: 'compile-failed', errors: [`solc did not answer with JSON: ${(error as Error).message}`] });
  }
  const errors = (Array.isArray(output.errors) ? output.errors : [])
    .filter((entry: unknown) => isJson(entry) && entry.severity === 'error')
    .map((entry: Json) => String(entry.formattedMessage ?? entry.message));
  if (errors.length > 0) refuse({ why: 'compile-failed', errors });
  const contract = json(json(json(output.contracts, 'contracts')[contractPath], contractPath)[contractName], contractName);
  const deployed = json(json(contract.evm, 'evm').deployedBytecode, 'deployedBytecode');
  const abi = contract.abi;
  if (!Array.isArray(abi) || !abi.every((entry: unknown) => isJson(entry) && typeof entry.type === 'string')) {
    return malformedOutput('has a malformed ABI');
  }
  if (typeof deployed.object !== 'string') return malformedOutput('has no deployed code');
  return {
    abi: abi as AbiEntry[],
    code: deployed.object,
    immutables: spans(deployed.immutableReferences, 1),
    libraries: spans(deployed.linkReferences, 2),
  };
}

/**
 * Immutables are written by the constructor and libraries are linked at deployment, so their bytes are not in the
 * source. Every other byte must be equal.
 */
function compare(compiled: Compiled, onChain: Hex, at: Address): void {
  const chain = onChain.slice(2);
  const ours = compiled.code.toLowerCase();
  const mismatch = (detail: string) => refuse({ why: 'bytecode-mismatch', at, detail });
  if (ours.length !== chain.length) mismatch(`compiled ${ours.length / 2} bytes, on chain ${chain.length / 2} bytes`);
  const masked = new Uint8Array(chain.length / 2);
  for (const { start, length } of [...compiled.immutables, ...compiled.libraries]) {
    if (start < 0 || length <= 0 || start + length > masked.length) mismatch('a masked span falls outside the code');
    masked.fill(1, start, start + length);
  }
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === 0 && ours.slice(2 * i, 2 * i + 2) !== chain.slice(2 * i, 2 * i + 2)) mismatch(`first difference at byte ${i}`);
  }
}

const codeHash = (code: Hex): Hex => `0x${bytesToHex(keccak_256(hexToBytes(code.slice(2))))}` as Hex;

async function codeAt(reader: Reader, address: Address, block: BlockRef): Promise<Hex> {
  const read = await reader.getCode(address, block);
  if (read.kind === 'unverifiable') return refuse({ why: 'unverifiable', read: read.reason });
  if (read.value.length === 2) refuse({ why: 'no-code', at: address });
  return read.value;
}

async function sourceOf(deps: ProveDeps, address: Address): Promise<VerifiedSource> {
  let lookup;
  try {
    lookup = parseSourcify(address, await deps.sourcify(address));
  } catch (error) {
    return refuse({ why: 'sourcify-unreadable', at: address, detail: `request failed: ${(error as Error).message}` });
  }
  switch (lookup.kind) {
    case 'not-verified':
      return refuse({ why: 'not-on-sourcify', at: address });
    case 'unsupported-language':
      return refuse({ why: 'unsupported-language', language: lookup.language });
    case 'unreadable':
      return refuse({ why: 'sourcify-unreadable', at: address, detail: lookup.why });
  }
  return lookup.source;
}

/**
 * Proves the ABI of the code a call to `address` runs at `block`: Sourcify's source, compiled with a pinned solc, must
 * give the code both providers read. Every failure is a refusal, never a guess.
 */
export async function proveAbi(reader: Reader, address: Address, block: BlockRef, deps: ProveDeps): Promise<AbiProof | AbiRefusal> {
  try {
    const own = await codeAt(reader, address, block);
    const located = await locate(reader, address, own, block);
    if (located.kind === 'refused') return refuse(located.refusal);
    const { proxy } = located;
    const proven = proxy.kind === 'none' ? address : proxy.implementation;
    const code = proxy.kind === 'none' ? own : await codeAt(reader, proven, block);
    if (proxy.kind !== 'none' && (minimalProxyTarget(code) !== undefined || safeProxyFactory(code) !== undefined)) {
      refuse({ why: 'chained-proxy', at: proven });
    }
    const source = await sourceOf(deps, proven);
    const compiled = compile(source, deps.compilers);
    compare(compiled, code, proven);
    return {
      kind: 'proven',
      address,
      block,
      providers: reader.providers,
      proxy,
      proven,
      codeHash: codeHash(code),
      proxyCodeHash: proxy.kind === 'none' ? undefined : codeHash(own),
      compiler: source.compilerVersion,
      contractPath: source.contractPath,
      contractName: source.contractName,
      abi: compiled.abi,
      source: 'sourcify',
      immutablesMasked: compiled.immutables.length,
      librariesMasked: compiled.libraries.length,
    };
  } catch (error) {
    if (error instanceof Refused) return { kind: 'refused', address, block, refusal: error.refusal };
    throw error;
  }
}
