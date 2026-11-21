import type { ProviderName } from '../chain/providers.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import type { ProxyDeclaration } from '../registry.ts';
import { AbiSignatureError, selectorOf, signatureOfAbiEntry } from '../decode/abi.ts';
import type { Address, Hex } from '../safe/types.ts';
import { keccakCode, readRunningCode } from './code.ts';
import type { CodeRefusal } from './code.ts';
import type { Proxy } from './proxy.ts';
import type { Compilers } from './solc.ts';
import { parseEtherscan } from './etherscan.ts';
import type { EtherscanGet, VerifiedSource } from './etherscan.ts';

export type AbiEntry = Readonly<Record<string, unknown>> & { readonly type: string };

/** The extension an implementation hands a call it has no function for to, proven as the implementation is. */
export type ExtensionProof = {
  readonly address: Address;
  readonly codeHash: Hex;
  readonly compiler: string;
  readonly contractPath: string;
  readonly contractName: string;
  readonly immutablesMasked: number;
  readonly librariesMasked: number;
  readonly metadataHashMasked: boolean;
};

/**
 * The ABI that solc gave for source whose compiled code equals the code at `proven`, except at masked positions, and
 * after it the functions of the extension that code hands a call it has no function for to, when it has one.
 */
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
  readonly source: 'etherscan';
  readonly immutablesMasked: number;
  readonly librariesMasked: number;
  /** True when the metadata hash in the trailer differs: the source compiles to the same code but is not the deployed text. */
  readonly metadataHashMasked: boolean;
  readonly extension?: ExtensionProof;
};

export type Refusal =
  | CodeRefusal
  | { readonly why: 'not-on-etherscan'; readonly at: Address }
  | { readonly why: 'etherscan-unreadable'; readonly at: Address; readonly detail: string }
  | { readonly why: 'unsupported-language'; readonly language: string }
  | { readonly why: 'compiler-not-pinned'; readonly version: string }
  | { readonly why: 'compiler-missing'; readonly path: string }
  | { readonly why: 'compiler-hash-mismatch'; readonly path: string; readonly expected: string; readonly actual: string }
  | { readonly why: 'compile-failed'; readonly errors: readonly string[] }
  | { readonly why: 'bytecode-mismatch'; readonly at: Address; readonly detail: string }
  | { readonly why: 'selector-clash'; readonly at: Address; readonly selector: Hex };

export type AbiRefusal = { readonly kind: 'refused'; readonly address: Address; readonly block: BlockRef; readonly refusal: Refusal };

export type ProveDeps = { readonly etherscan: EtherscanGet; readonly compilers: Compilers };

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
    case 'unknown-delegator':
      return `${refusal.at} hands a call it has no function for, at byte ${refusal.pc} of its code, to code the program neither proves nor pins`;
    case 'fallback-unfollowable':
      return `the program cannot follow what ${refusal.at} does with a call it has no function for (${refusal.cause} at byte ${refusal.pc}), so whether it delegates elsewhere is unknown`;
    case 'declared-without-delegation':
      return `${refusal.at} runs a call it has no function for without handing it to other code, so its implementationRead names no code it runs`;
    case 'declared-read-failed':
      return `${refusal.call} on ${refusal.at}, a view of the entry's implementationRead, did not answer one nonzero address other than the proxy's own`;
    case 'declared-probe-failed':
      return `a call the proxy has no function for did not run the code at ${refusal.implementation}, which its implementationRead answers, as the proxy`;
    case 'no-code':
      return `${refusal.at} has no code`;
    case 'chained-proxy':
      return `the implementation ${refusal.at} is itself a proxy`;
    case 'multicall-no-code':
      return 'Multicall3 has no code at this block, so the routes cannot be read';
    case 'routes-reverted':
      return 'a Multicall3 batch of route reads reverted';
    case 'routes-malformed':
      return `${refusal.call} answered something other than its canonical encoding`;
    case 'routes-inconsistent':
      return `the routes are inconsistent: ${refusal.detail}`;
    case 'not-on-etherscan':
      return `Etherscan has no verified source for ${refusal.at}`;
    case 'etherscan-unreadable':
      return `Etherscan's answer for ${refusal.at} is unreadable: ${refusal.detail}`;
    case 'unsupported-language':
      return `the source is ${refusal.language}; only Solidity is compiled`;
    case 'compiler-not-pinned':
      return `solc ${refusal.version} is not pinned in src/contracts/solc-pins.ts; run \`pnpm pin-solc ${refusal.version}\``;
    case 'compiler-missing':
      return `${refusal.path} is missing; run \`pnpm fetch-solc\``;
    case 'compiler-hash-mismatch':
      return `${refusal.path} has sha256 ${refusal.actual}, not the pinned ${refusal.expected}; delete it and run \`pnpm fetch-solc\``;
    case 'compile-failed':
      return `solc reported errors: ${refusal.errors.join(' | ')}`;
    case 'bytecode-mismatch':
      return `the compiled code differs from the code at ${refusal.at}: ${refusal.detail}`;
    case 'selector-clash':
      return `the implementation and its extension ${refusal.at} have different functions with the selector ${refusal.selector}`;
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

/** The CBOR trailer solc appends with `bytecodeHash: "none"`: the map `{"solc": <version>}` and its length. */
const SOLC_ONLY_TRAILER = /a164736f6c6343[0-9a-f]{6}000a$/;

/**
 * A trailer without a metadata hash binds no source text, so whichever `bytecodeHash` the verified settings on Etherscan name
 * changes only bytes the chain does not have. Compiling without the hash compares every byte on chain, trailer included.
 */
function settingsFor(source: VerifiedSource, onChain: Hex): Readonly<Record<string, unknown>> {
  if (!SOLC_ONLY_TRAILER.test(onChain)) return source.settings;
  const metadata = isJson(source.settings.metadata) ? source.settings.metadata : {};
  return { ...source.settings, metadata: { ...metadata, bytecodeHash: 'none' } };
}

function compile(source: VerifiedSource, compilers: Compilers, onChain: Hex): Compiled {
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
    settings: { ...settingsFor(source, onChain), outputSelection: { [contractPath]: { [contractName]: OUTPUTS } } },
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
 * solc's CBOR trailers that carry a metadata hash, and where that hash lies counted from the end of the code: the map
 * `{"ipfs": <34-byte multihash>, "solc": <version>}` from 0.6.0, and `{"bzzr0": <32-byte Swarm hash>}` before 0.5.9.
 */
const HASH_TRAILERS = [
  { trailer: /a264697066735822[0-9a-f]{68}64736f6c6343[0-9a-f]{6}0033$/, fromEnd: 45, length: 34 },
  { trailer: /a165627a7a72305820[0-9a-f]{64}0029$/, fromEnd: 34, length: 32 },
];

/**
 * Immutables are written by the constructor and libraries are linked at deployment, so their bytes are not in the
 * source. The metadata hash in a trailer hashes the source text, comments and file names included, so a source
 * verified with other file names or comments differs from the code only there. Every other byte must be equal. Returns whether
 * the metadata hash differed.
 */
function compare(compiled: Compiled, onChain: Hex, at: Address): boolean {
  const chain = onChain.slice(2);
  const ours = compiled.code.toLowerCase();
  const mismatch = (detail: string) => refuse({ why: 'bytecode-mismatch', at, detail });
  if (ours.length !== chain.length) mismatch(`compiled ${ours.length / 2} bytes, on chain ${chain.length / 2} bytes`);
  const masked = new Uint8Array(chain.length / 2);
  for (const { start, length } of [...compiled.immutables, ...compiled.libraries]) {
    if (start < 0 || length <= 0 || start + length > masked.length) mismatch('a masked span falls outside the code');
    masked.fill(1, start, start + length);
  }
  const shape = HASH_TRAILERS.find(({ trailer }) => trailer.test(ours) && trailer.test(chain));
  const hash = shape === undefined ? undefined : { start: masked.length - shape.fromEnd, end: masked.length - shape.fromEnd + shape.length };
  const hashDiffers = hash !== undefined && ours.slice(2 * hash.start, 2 * hash.end) !== chain.slice(2 * hash.start, 2 * hash.end);
  if (hashDiffers) masked.fill(1, hash.start, hash.end);
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === 0 && ours.slice(2 * i, 2 * i + 2) !== chain.slice(2 * i, 2 * i + 2)) mismatch(`first difference at byte ${i}`);
  }
  return hashDiffers;
}

async function sourceOf(deps: ProveDeps, address: Address): Promise<VerifiedSource> {
  let lookup;
  try {
    lookup = parseEtherscan(await deps.etherscan(address));
  } catch (error) {
    return refuse({ why: 'etherscan-unreadable', at: address, detail: `request failed: ${(error as Error).message}` });
  }
  switch (lookup.kind) {
    case 'not-verified':
      return refuse({ why: 'not-on-etherscan', at: address });
    case 'unsupported-language':
      return refuse({ why: 'unsupported-language', language: lookup.language });
    case 'unreadable':
      return refuse({ why: 'etherscan-unreadable', at: address, detail: lookup.why });
  }
  return lookup.source;
}

type ProvenCode = { readonly source: VerifiedSource; readonly compiled: Compiled; readonly metadataHashMasked: boolean };

async function proveCode(deps: ProveDeps, at: Address, code: Hex): Promise<ProvenCode> {
  const source = await sourceOf(deps, at);
  const compiled = compile(source, deps.compilers, code);
  return { source, compiled, metadataHashMasked: compare(compiled, code, at) };
}

function signatureOfEntry(entry: AbiEntry): string {
  try {
    return signatureOfAbiEntry(entry);
  } catch (error) {
    if (error instanceof AbiSignatureError) return malformedOutput('has a malformed function entry');
    throw error;
  }
}

/**
 * The implementation's ABI with its extension's functions after it. A call with a selector the implementation's own
 * functions hold runs that function, so an extension function with the same signature, such as a getter both inherit,
 * is not listed again, and one with another signature under the same selector is refused.
 */
function withExtension(abi: readonly AbiEntry[], extension: readonly AbiEntry[], at: Address): AbiEntry[] {
  const own = new Map(abi.filter((entry) => entry.type === 'function').map((entry) => [selectorOf(signatureOfEntry(entry)), signatureOfEntry(entry)]));
  const added = extension.filter((entry) => {
    if (entry.type !== 'function') return false;
    const signature = signatureOfEntry(entry);
    const selector = selectorOf(signature);
    const ownSignature = own.get(selector);
    if (ownSignature !== undefined && ownSignature !== signature) refuse({ why: 'selector-clash', at, selector });
    return ownSignature === undefined;
  });
  return [...abi, ...added];
}

/**
 * Proves the ABI of the code a call to `address` runs at `block`: Etherscan's verified source, compiled with a pinned solc, must
 * give the code both providers read, and so must the extension's when that code hands calls to one. Every failure is
 * a refusal, never a guess.
 */
export async function proveAbi(reader: Reader, address: Address, block: BlockRef, deps: ProveDeps, declared: ProxyDeclaration = {}): Promise<AbiProof | AbiRefusal> {
  try {
    const read = await readRunningCode(reader, address, block, declared);
    if (read.kind === 'refused') return refuse(read.refusal);
    const { own, proxy, runs: code, extension } = read.code;
    const proven = proxy.kind === 'none' ? address : proxy.implementation;
    const { source, compiled, metadataHashMasked } = await proveCode(deps, proven, code);
    const extended = extension === undefined ? undefined : { extension, ...(await proveCode(deps, extension.address, extension.code)) };
    return {
      kind: 'proven',
      address,
      block,
      providers: reader.providers,
      proxy,
      proven,
      codeHash: keccakCode(code),
      proxyCodeHash: proxy.kind === 'none' ? undefined : keccakCode(own),
      compiler: source.compilerVersion,
      contractPath: source.contractPath,
      contractName: source.contractName,
      abi: extended === undefined ? compiled.abi : withExtension(compiled.abi, extended.compiled.abi, extended.extension.address),
      source: 'etherscan',
      immutablesMasked: compiled.immutables.length,
      librariesMasked: compiled.libraries.length,
      metadataHashMasked,
      ...(extended === undefined
        ? {}
        : {
            extension: {
              address: extended.extension.address,
              codeHash: keccakCode(extended.extension.code),
              compiler: extended.source.compilerVersion,
              contractPath: extended.source.contractPath,
              contractName: extended.source.contractName,
              immutablesMasked: extended.compiled.immutables.length,
              librariesMasked: extended.compiled.libraries.length,
              metadataHashMasked: extended.metadataHashMasked,
            },
          }),
    };
  } catch (error) {
    if (error instanceof Refused) return { kind: 'refused', address, block, refusal: error.refusal };
    throw error;
  }
}
