import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Read, Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { AbiSignatureError, parseFunctionSignature, selectorOf } from '../decode/abi.ts';
import type { Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress, parseAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { readTarGz } from './tar.ts';

/**
 * The ERC-7730 registry Ledger started, now `ethereum/clear-signing-erc7730-registry` (the Ledger URL redirects there),
 * as codeload's archive of one commit. Two downloads of the archive gave the same sha256.
 */
export const ERC7730_REGISTRY_PIN = {
  repository: 'github.com/ethereum/clear-signing-erc7730-registry',
  commit: '3bebbd05cbc2d2d2bf9c41a8edbf5e5cc88e4eb4',
  url: 'https://codeload.github.com/ethereum/clear-signing-erc7730-registry/tar.gz/3bebbd05cbc2d2d2bf9c41a8edbf5e5cc88e4eb4',
  sha256: 'b4e02f6c6ce721b1091018b31dc8c31e3da0523b57faf36356be32e3cf44d97b',
} as const;

export const ERC7730_DIR = join(import.meta.dirname, '..', '..', 'vendor', 'erc7730');
export const ERC7730_ARCHIVE = `${ERC7730_REGISTRY_PIN.commit}.tar.gz`;

/** ERC-8176: the EAS schema `bytes32 descriptorHash` and the EAS contract on mainnet, which records revocations. */
const ERC8176 = {
  schema: '0xe023eef113c1670774801c34b377fdf612dd8a4d2fa92fe382e15bd91fafb5c2',
  eas: '0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587' as Address,
  domainName: 'EAS Attestation',
  domainVersion: '0.26',
} as const;

const ECRECOVER = '0x0000000000000000000000000000000000000001' as Address;

/** Every `.json` file of the registry at one commit, by path from the repository root. */
export type Snapshot = { readonly commit: string; readonly files: ReadonlyMap<string, string> };
export type SnapshotUnavailable = { readonly unavailable: string };

export function loadSnapshot(dir: string = ERC7730_DIR): Snapshot | SnapshotUnavailable {
  const path = join(dir, ERC7730_ARCHIVE);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { unavailable: `${path} missing; run pnpm fetch-erc7730` };
    throw error;
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== ERC7730_REGISTRY_PIN.sha256) return { unavailable: `${path} sha256 ${actual} is not the pinned ${ERC7730_REGISTRY_PIN.sha256}` };
  const archive = readTarGz(bytes);
  if (archive.comment !== ERC7730_REGISTRY_PIN.commit) return { unavailable: `${path} names commit ${archive.comment ?? 'none'}, not the pinned one` };
  const files = new Map<string, string>();
  const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
  for (const [file, content] of archive.files) if (file.endsWith('.json')) files.set(file, utf8.decode(content));
  return { commit: ERC7730_REGISTRY_PIN.commit, files };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Refuses `__proto__`, so merging a descriptor never sets a prototype. */
function parseJson(text: string): Json {
  return JSON.parse(text, (key, value: Json) => {
    if (key === '__proto__') throw new SyntaxError('a __proto__ key');
    return value;
  }) as Json;
}

/** RFC 8785: keys sorted by UTF-16 code unit; ECMAScript serializes numbers and strings the way the RFC requires. */
function jcs(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${jcs(value[key]!)}`)
    .join(',')}}`;
}

const keccakHex = (bytes: Uint8Array): Hex => `0x${bytesToHex(keccak_256(bytes))}` as Hex;

// The registry's own merge (.github/scripts/resolve-erc7730-includes.js at the pinned commit), which its attestations
// were hashed with: the including file wins, and `fields` merge by `path`.
function mergeFields(included: Json[], including: Json[]): Json[] {
  const pathOf = (f: Json) => (isObject(f) && typeof f.path === 'string' ? f.path : undefined);
  const byPath = new Map<string, JsonObject>();
  for (const f of included) if (pathOf(f) !== undefined) byPath.set(pathOf(f)!, { ...(f as JsonObject) });
  for (const f of including) if (pathOf(f) !== undefined) byPath.set(pathOf(f)!, { ...byPath.get(pathOf(f)!), ...(f as JsonObject) });
  const order = included.map(pathOf).filter((p) => p !== undefined);
  const appended = including.filter((f) => pathOf(f) !== undefined && !order.includes(pathOf(f)!));
  return [...order.map((p) => byPath.get(p)!), ...appended];
}

function merge(a: JsonObject, b: JsonObject): JsonObject {
  const out: JsonObject = { ...a };
  for (const key of Object.keys(b)) {
    const [x, y] = [a[key], b[key]!];
    if (key === 'fields' && Array.isArray(x) && Array.isArray(y)) out.fields = mergeFields(x, y);
    else if (key === 'formats' && isObject(x) && isObject(y)) {
      const formats: JsonObject = {};
      for (const sig of new Set([...Object.keys(x), ...Object.keys(y)])) {
        const [fx, fy] = [x[sig], y[sig]];
        formats[sig] = merge(isObject(fx) ? fx : {}, isObject(fy) ? fy : {});
      }
      out.formats = formats;
    } else if (isObject(x) && isObject(y)) out[key] = merge(x, y);
    else out[key] = y;
  }
  return out;
}

type Resolved = { readonly kind: 'resolved'; readonly value: JsonObject; readonly includes: readonly string[] } | { readonly kind: 'unresolved'; readonly why: string };

function resolve(snapshot: Snapshot, path: string, depth = 0): Resolved {
  if (depth > 8) return { kind: 'unresolved', why: 'includes nest more than 8 deep' };
  const text = snapshot.files.get(path);
  if (text === undefined) return { kind: 'unresolved', why: `${printablePath(path)} is not in the registry at this commit` };
  let doc: Json;
  try {
    doc = parseJson(text);
  } catch {
    return { kind: 'unresolved', why: `${printablePath(path)} is not JSON the program reads` };
  }
  if (!isObject(doc)) return { kind: 'unresolved', why: `${printablePath(path)} is not a JSON object` };
  const { includes, ...rest } = doc;
  if (includes === undefined || includes === null || includes === '') return { kind: 'resolved', value: doc, includes: [] };
  if (typeof includes !== 'string' || includes.includes('://')) return { kind: 'unresolved', why: `${printablePath(path)} includes something other than a file of the registry` };
  const target = posix.normalize(posix.join(posix.dirname(path), includes));
  if (target.startsWith('../') || target.startsWith('/')) return { kind: 'unresolved', why: `${printablePath(path)} includes a file outside the registry` };
  const inner = resolve(snapshot, target, depth + 1);
  if (inner.kind === 'unresolved') return inner;
  return { kind: 'resolved', value: merge(inner.value, rest), includes: [target, ...inner.includes] };
}

const PRINTABLE_PATH = /^[A-Za-z0-9_.+\-/]{1,200}$/;
const printablePath = (path: string) => (PRINTABLE_PATH.test(path) ? path : '<a path with other characters>');
const FIELD_PATH = /^[A-Za-z0-9_.#@[\]\-$]{1,120}$/;

/** The format names of ERC-7730 v2 (`specs/erc7730-v2.schema.json`, `$format.names`). Any other value prints as unknown. */
const FORMATS = new Set(['raw', 'addressName', 'tokenTicker', 'calldata', 'amount', 'tokenAmount', 'nftName', 'date', 'duration', 'unit', 'enum', 'chainId', 'interoperableAddressName']);

export type FieldFact =
  | { readonly kind: 'field'; readonly path: string; readonly format: string; readonly visible: string }
  | { readonly kind: 'group'; readonly path: string; readonly fields: readonly FieldFact[] };

export type FunctionFact = {
  readonly selector: Hex | undefined;
  /** Canonical types only, such as `deposit(uint256,address)`; undefined when the format is keyed by selector alone. */
  readonly signature: string | undefined;
  readonly fields: readonly FieldFact[];
  /** Top-level parameters no field names. */
  readonly notShown: readonly string[];
  readonly excluded: readonly string[];
};

const fieldPath = (raw: Json | undefined): string => {
  if (raw === undefined) return '(constant)';
  return typeof raw === 'string' && FIELD_PATH.test(raw) ? raw : '<a path with other characters>';
};

function visibility(raw: Json | undefined): string {
  if (raw === undefined) return 'always';
  if (raw === 'always' || raw === 'never' || raw === 'optional') return raw;
  if (isObject(raw) && 'ifNotIn' in raw) return 'shown-unless-listed-value';
  if (isObject(raw) && 'mustMatch' in raw) return 'never-but-must-match';
  return 'unknown';
}

function fieldFacts(items: Json | undefined, definitions: JsonObject): FieldFact[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): FieldFact[] => {
    if (!isObject(item)) return [];
    if (Array.isArray(item.fields)) return [{ kind: 'group', path: fieldPath(item.path), fields: fieldFacts(item.fields, definitions) }];
    const ref = typeof item.$ref === 'string' ? /^\$\.display\.definitions\.([A-Za-z0-9_-]+)$/.exec(item.$ref)?.[1] : undefined;
    const definition = ref !== undefined && isObject(definitions[ref]) ? definitions[ref] : {};
    const format = item.format ?? definition.format;
    return [
      {
        kind: 'field',
        path: fieldPath(item.path ?? definition.path),
        format: format === undefined ? 'none' : typeof format === 'string' && FORMATS.has(format) ? format : 'unknown',
        visible: visibility(item.visible ?? definition.visible),
      },
    ];
  });
}

const topLevel = (path: string) => path.replace(/^#\./, '').split(/[.[]/)[0] ?? '';

function functionFacts(descriptor: JsonObject): FunctionFact[] {
  const display = isObject(descriptor.display) ? descriptor.display : {};
  const formats = isObject(display.formats) ? display.formats : {};
  const definitions = isObject(display.definitions) ? display.definitions : {};
  return Object.entries(formats).map(([key, format]) => {
    const body = isObject(format) ? format : {};
    const fields = fieldFacts(body.fields, definitions);
    const excluded = Array.isArray(body.excluded) ? body.excluded.map(fieldPath) : [];
    if (/^0x[0-9a-fA-F]{8}$/.test(key)) return { selector: key.toLowerCase() as Hex, signature: undefined, fields, notShown: [], excluded };
    let fn;
    try {
      fn = parseFunctionSignature(key);
    } catch (error) {
      if (error instanceof AbiSignatureError) return { selector: undefined, signature: undefined, fields, notShown: [], excluded };
      throw error;
    }
    const named = new Set<string>();
    const collect = (facts: readonly FieldFact[]) => {
      for (const f of facts) {
        named.add(topLevel(f.path));
        if (f.kind === 'group') collect(f.fields);
      }
    };
    collect(fields);
    const notShown = fn.params.map((p, i) => p.name ?? String(i)).filter((name) => !named.has(name));
    return { selector: fn.selector, signature: fn.signature, fields, notShown, excluded };
  });
}

export type Scope = { readonly deployment: boolean; readonly factories: readonly Address[] };

function mainnetAddresses(raw: Json | undefined): Address[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((d) => {
    if (!isObject(d) || d.chainId !== 1 || typeof d.address !== 'string') return [];
    try {
      return [parseAddress('deployment', d.address)];
    } catch {
      return [];
    }
  });
}

function scopeOf(descriptor: JsonObject, address: Address): Scope {
  const contract = isObject(descriptor.context) && isObject(descriptor.context.contract) ? descriptor.context.contract : {};
  const factory = isObject(contract.factory) ? contract.factory : {};
  return { deployment: mainnetAddresses(contract.deployments).includes(address), factories: mainnetAddresses(factory.deployments) };
}

type Descriptor = { readonly path: string; readonly resolved: Resolved };

const isCalldataDescriptor = (path: string) =>
  /^(registry\/[^/]+(\/[^/]+)*|ercs)\/calldata-[^/]*\.json$/.test(path) && !path.endsWith('.tests.json') && !/\/(tests|testsv2|sigs)\//.test(path);

function calldataDescriptors(snapshot: Snapshot): Descriptor[] {
  return [...snapshot.files.keys()].filter(isCalldataDescriptor).sort().map((path) => ({ path, resolved: resolve(snapshot, path) }));
}

export type AttestationStatus =
  | { readonly kind: 'valid'; readonly attester: Address; readonly expires: bigint; readonly block: bigint }
  | { readonly kind: 'revoked'; readonly attester: Address; readonly at: bigint; readonly block: bigint }
  | { readonly kind: 'expired'; readonly attester: Address; readonly expires: bigint; readonly block: bigint }
  | { readonly kind: 'invalid'; readonly why: string }
  | { readonly kind: 'unverifiable'; readonly why: string };

export type AttestationFact = { readonly file: string; readonly signer: Address | undefined; readonly listed: boolean; readonly status: AttestationStatus };

export type DescriptorFact = {
  readonly path: string;
  readonly scope: Scope;
  /** sha256 of the descriptor file's bytes, as stored at the commit. */
  readonly fileSha256: string;
  readonly includes: readonly string[];
  readonly descriptorHash: Hex | undefined;
  readonly unresolved: string | undefined;
  readonly functions: readonly FunctionFact[];
  readonly attestations: readonly AttestationFact[];
};

export type EntryReport = {
  readonly entry: RegistryEntry;
  readonly factory: { readonly name: string; readonly address: Address } | undefined;
  readonly index: string | undefined;
  readonly descriptors: readonly DescriptorFact[];
};

type Attestation = {
  readonly version: number;
  readonly schema: string;
  readonly recipient: Address;
  readonly time: bigint;
  readonly expirationTime: bigint;
  readonly revocable: boolean;
  readonly refUID: Hex;
  readonly data: Hex;
  readonly salt: Hex;
  readonly uid: Hex;
  readonly domainIsErc8176: boolean;
  readonly v: number;
  readonly r: Hex;
  readonly s: Hex;
  readonly signer: Address | undefined;
};

const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const BYTES = /^0x([0-9a-fA-F]{2})*$/;

function uint(raw: Json | undefined, bits: number): bigint | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  if (!/^[0-9]+$/.test(String(raw))) return undefined;
  const value = BigInt(raw);
  return value < 1n << BigInt(bits) ? value : undefined;
}

function parseAttestation(text: string): Attestation | string {
  let doc: Json;
  try {
    doc = parseJson(text);
  } catch {
    return 'not JSON';
  }
  if (!isObject(doc) || !isObject(doc.sig)) return 'no sig object';
  const { sig } = doc;
  const message = isObject(sig.message) ? sig.message : undefined;
  const domain = isObject(sig.domain) ? sig.domain : undefined;
  const signature = isObject(sig.signature) ? sig.signature : undefined;
  if (message === undefined || domain === undefined || signature === undefined) return 'no message, domain or signature';
  const hash = (raw: Json | undefined) => (typeof raw === 'string' && HASH32.test(raw) ? (raw.toLowerCase() as Hex) : undefined);
  const [time, expirationTime] = [uint(message.time, 64), uint(message.expirationTime, 64)];
  const [refUID, salt, uid, r, s] = [hash(message.refUID), hash(message.salt), hash(sig.uid), hash(signature.r), hash(signature.s)];
  const v = typeof signature.v === 'number' ? signature.v : undefined;
  let recipient: Address;
  let signer: Address | undefined;
  try {
    recipient = parseAddress('recipient', message.recipient);
    signer = doc.signer === undefined ? undefined : parseAddress('signer', doc.signer);
  } catch {
    return 'an address that is not one';
  }
  if (typeof message.version !== 'number' || typeof message.schema !== 'string' || typeof message.revocable !== 'boolean') return 'malformed version, schema or revocable';
  if (typeof message.data !== 'string' || !BYTES.test(message.data)) return 'malformed data';
  if (time === undefined || expirationTime === undefined || refUID === undefined || salt === undefined || uid === undefined) return 'malformed time, expirationTime, refUID, salt or uid';
  if (r === undefined || s === undefined || v === undefined) return 'malformed signature';
  const domainIsErc8176 =
    domain.name === ERC8176.domainName &&
    domain.version === ERC8176.domainVersion &&
    String(domain.chainId) === '1' &&
    typeof domain.verifyingContract === 'string' &&
    domain.verifyingContract.toLowerCase() === ERC8176.eas.toLowerCase();
  return {
    version: message.version,
    schema: message.schema,
    recipient,
    time,
    expirationTime,
    revocable: message.revocable,
    refUID,
    data: message.data.toLowerCase() as Hex,
    salt,
    uid,
    domainIsErc8176,
    v,
    r,
    s,
    signer,
  };
}

const word = (value: bigint, bytes = 32) => hexToBytes(value.toString(16).padStart(bytes * 2, '0'));
const hexBytes = (hex: string) => hexToBytes(hex.slice(2));

/** EAS offchain attestation version 2: `solidityPackedKeccak256` of the fields, the schema as the UTF-8 of its hex text. */
function offchainUid(a: Attestation): Hex {
  return keccakHex(
    concatBytes(
      word(BigInt(a.version), 2),
      utf8ToBytes(ERC8176.schema),
      hexBytes(a.recipient),
      new Uint8Array(20),
      word(a.time, 8),
      word(a.expirationTime, 8),
      new Uint8Array([a.revocable ? 1 : 0]),
      hexBytes(a.refUID),
      hexBytes(a.data),
      hexBytes(a.salt),
      new Uint8Array(4),
    ),
  );
}

const DOMAIN_TYPEHASH = keccak_256(utf8ToBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const ATTEST_TYPEHASH = keccak_256(
  utf8ToBytes('Attest(uint16 version,bytes32 schema,address recipient,uint64 time,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,bytes32 salt)'),
);
const DOMAIN_SEPARATOR = keccak_256(
  concatBytes(DOMAIN_TYPEHASH, keccak_256(utf8ToBytes(ERC8176.domainName)), keccak_256(utf8ToBytes(ERC8176.domainVersion)), word(1n), word(BigInt(ERC8176.eas))),
);

function attestDigest(a: Attestation): Uint8Array {
  const struct = keccak_256(
    concatBytes(
      ATTEST_TYPEHASH,
      word(BigInt(a.version)),
      hexBytes(ERC8176.schema),
      word(BigInt(a.recipient)),
      word(a.time),
      word(a.expirationTime),
      word(a.revocable ? 1n : 0n),
      hexBytes(a.refUID),
      keccak_256(hexBytes(a.data)),
      hexBytes(a.salt),
    ),
  );
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), DOMAIN_SEPARATOR, struct));
}

/** What the static checks found wrong with an attestation of `descriptorHash`, in the order ERC-8176 checks them. */
function staticFailure(a: Attestation, descriptorHash: Hex): string | undefined {
  if (a.schema !== ERC8176.schema) return 'its schema is not the ERC-8176 schema, written in lowercase';
  if (a.version !== 2) return 'it is not an EAS offchain attestation of version 2';
  if (!a.domainIsErc8176) return 'its EIP-712 domain is not the ERC-8176 one';
  if (a.data !== descriptorHash) return 'it attests another descriptorHash';
  if (offchainUid(a) !== a.uid) return 'its uid is not the one its fields give';
  if (a.v !== 27 && a.v !== 28) return 'its signature v is not 27 or 28';
  return undefined;
}

export type Chain = { readonly reader: Reader; readonly at: BlockRef; readonly time: bigint };
export type ChainAccess = Chain | { readonly unavailable: string };

/** The latest block both providers agree on, and its time, for the expiration check. */
export async function chainAt(reader: Reader): Promise<ChainAccess> {
  const block = await reader.block('latest');
  if (block.kind === 'unverifiable') return { unavailable: `latest block: ${block.reason}` };
  const header = await reader.header(block.value);
  if (header.kind === 'unverifiable') return { unavailable: `block ${block.value.number} header: ${header.reason}` };
  return { reader, at: block.value, time: header.value.time };
}

const both = (read: Read<unknown>) => (read.kind === 'agreed' ? undefined : read.reason);

async function checkOnChain(a: Attestation, chain: Chain): Promise<AttestationStatus> {
  const input = `0x${bytesToHex(concatBytes(attestDigest(a), word(BigInt(a.v)), hexBytes(a.r), hexBytes(a.s)))}` as Hex;
  const recovered = await chain.reader.call({ to: ECRECOVER, data: input }, chain.at);
  if (recovered.kind === 'unverifiable') return { kind: 'unverifiable', why: `ecrecover: ${both(recovered)}` };
  if (recovered.value.kind !== 'returned' || recovered.value.data.length !== 66) return { kind: 'invalid', why: 'its signature recovers no address' };
  const attester = parseAddress('recovered', `0x${recovered.value.data.slice(26)}`);
  if (a.signer !== undefined && attester !== a.signer) return { kind: 'invalid', why: `its signature recovers ${checksumAddress(attester)}, not the signer the file names` };
  const block = chain.at.number;
  if (a.expirationTime !== 0n && a.expirationTime <= chain.time) return { kind: 'expired', attester, expires: a.expirationTime, block };
  const query = `${selectorOf('getRevokeOffchain(address,bytes32)')}${attester.slice(2).padStart(64, '0')}${a.uid.slice(2)}` as Hex;
  const revoked = await chain.reader.call({ to: ERC8176.eas, data: query }, chain.at);
  if (revoked.kind === 'unverifiable') return { kind: 'unverifiable', why: `getRevokeOffchain: ${both(revoked)}` };
  if (revoked.value.kind !== 'returned' || revoked.value.data.length !== 66) return { kind: 'unverifiable', why: 'getRevokeOffchain gave no uint64' };
  const at = BigInt(revoked.value.data);
  if (at !== 0n) return { kind: 'revoked', attester, at, block };
  return { kind: 'valid', attester, expires: a.expirationTime, block };
}

const SIG_FILE = /^(.*)\/sigs\/(calldata-.*)\.eip155-1-(0x[0-9a-fA-F]{40})\.json$/;

/** Attestation files that name this descriptor by file name, and any other whose data is its descriptorHash. */
function attestationFiles(snapshot: Snapshot, path: string, descriptorHash: Hex | undefined): { file: string; parsed: Attestation | string }[] {
  const dir = posix.dirname(path);
  const base = posix.basename(path, '.json');
  const found: { file: string; parsed: Attestation | string }[] = [];
  for (const [file, text] of snapshot.files) {
    const named = SIG_FILE.exec(file);
    if (named === null) continue;
    const parsed = parseAttestation(text);
    const byName = named[1] === dir && named[2] === base;
    const byHash = typeof parsed !== 'string' && descriptorHash !== undefined && parsed.data === descriptorHash;
    if (byName || byHash) found.push({ file, parsed });
  }
  return found.sort((x, y) => (x.file < y.file ? -1 : 1));
}

const isListedAuditor = (snapshot: Snapshot, address: Address) =>
  [...snapshot.files.keys()].some((f) => f.toLowerCase() === `auditors/eip155-1-${address.toLowerCase()}/profile.json`);

async function attestationFacts(snapshot: Snapshot, d: Descriptor, descriptorHash: Hex | undefined, chain: () => Promise<ChainAccess>): Promise<AttestationFact[]> {
  const facts: AttestationFact[] = [];
  for (const { file, parsed } of attestationFiles(snapshot, d.path, descriptorHash)) {
    if (typeof parsed === 'string') {
      facts.push({ file, signer: undefined, listed: false, status: { kind: 'invalid', why: `the file is malformed: ${parsed}` } });
      continue;
    }
    const listed = parsed.signer !== undefined && isListedAuditor(snapshot, parsed.signer);
    const failure = descriptorHash === undefined ? 'the descriptorHash could not be computed' : staticFailure(parsed, descriptorHash);
    if (failure !== undefined) {
      facts.push({ file, signer: parsed.signer, listed, status: { kind: 'invalid', why: failure } });
      continue;
    }
    const access = await chain();
    const status: AttestationStatus = 'unavailable' in access ? { kind: 'unverifiable', why: access.unavailable } : await checkOnChain(parsed, access);
    const signer = 'attester' in status ? status.attester : parsed.signer;
    facts.push({ file, signer: signer, listed: signer !== undefined && isListedAuditor(snapshot, signer), status });
  }
  return facts;
}

function indexEntry(snapshot: Snapshot, address: Address): string | undefined {
  const text = snapshot.files.get('index.calldata.json');
  if (text === undefined) return undefined;
  const index = parseJson(text);
  const path = isObject(index) ? index[`eip155:1:${address.toLowerCase()}`] : undefined;
  return typeof path === 'string' ? path : undefined;
}

/**
 * Finds every calldata descriptor that lists the entry's address among its mainnet deployments, or whose factory is the
 * factory the entry's registry `factory` attribute names. Each found descriptor's attestations are checked; the chain is
 * opened only when one passes the checks that need no chain.
 */
export async function studyEntries(entries: readonly RegistryEntry[], registry: Registry, snapshot: Snapshot, chain: () => Promise<ChainAccess>): Promise<EntryReport[]> {
  let opened: Promise<ChainAccess> | undefined;
  const once = () => (opened ??= chain());
  const descriptors = calldataDescriptors(snapshot);
  const reports: EntryReport[] = [];
  for (const entry of entries) {
    const factoryName = entry.attributes.factory;
    const factoryEntry = factoryName === undefined ? undefined : registry.entries.get(factoryName);
    const factory = factoryEntry === undefined ? undefined : { name: factoryEntry.name, address: factoryEntry.address };
    const facts: DescriptorFact[] = [];
    for (const d of descriptors) {
      const doc = d.resolved.kind === 'resolved' ? d.resolved.value : undefined;
      const scope = doc === undefined ? { deployment: false, factories: [] } : scopeOf(doc, entry.address);
      const byFactory = factory !== undefined && scope.factories.includes(factory.address);
      if (!scope.deployment && !byFactory) continue;
      const descriptorHash = doc === undefined ? undefined : keccakHex(utf8ToBytes(jcs(doc)));
      facts.push({
        path: d.path,
        scope,
        fileSha256: createHash('sha256').update(snapshot.files.get(d.path)!, 'utf8').digest('hex'),
        includes: d.resolved.kind === 'resolved' ? d.resolved.includes : [],
        descriptorHash,
        unresolved: d.resolved.kind === 'unresolved' ? d.resolved.why : undefined,
        functions: doc === undefined ? [] : functionFacts(doc),
        attestations: await attestationFacts(snapshot, d, descriptorHash, once),
      });
    }
    reports.push({ entry, factory, index: indexEntry(snapshot, entry.address), descriptors: facts });
  }
  return reports;
}

/** Descriptors scoped by a factory: ERC-7730 applies them to any contract that factory deploys, and the index omits them. */
function factoryScoped(snapshot: Snapshot): { path: string; factories: readonly Address[] }[] {
  return calldataDescriptors(snapshot).flatMap((d) => {
    if (d.resolved.kind !== 'resolved') return [];
    const { factories } = scopeOf(d.resolved.value, '0x0000000000000000000000000000000000000000' as Address);
    return factories.length === 0 ? [] : [{ path: d.path, factories }];
  });
}

function fieldLines(facts: readonly FieldFact[], indent: string): string[] {
  return facts.flatMap((f) =>
    f.kind === 'group' ? [`${indent}group      ${f.path}`, ...fieldLines(f.fields, `${indent}  `)] : [`${indent}field      ${f.path} ${f.format}${f.visible === 'always' ? '' : ` (visible: ${f.visible})`}`],
  );
}

function statusLine(s: AttestationStatus): string {
  switch (s.kind) {
    case 'valid':
      return `VALID: ERC-8176 schema and domain, data equals this descriptorHash, uid matches its fields, signature recovers ${checksumAddress(s.attester)} (both providers), ${s.expires === 0n ? 'never expires' : `expires at unix time ${s.expires}`}, not revoked as of block ${s.block} (getRevokeOffchain, both providers)`;
    case 'revoked':
      return `REVOKED by ${checksumAddress(s.attester)} at unix time ${s.at} (getRevokeOffchain at block ${s.block}, both providers)`;
    case 'expired':
      return `EXPIRED at unix time ${s.expires}, before block ${s.block}; signed by ${checksumAddress(s.attester)}`;
    case 'invalid':
      return `INVALID: ${s.why}`;
    case 'unverifiable':
      return `UNVERIFIABLE: ${s.why}`;
  }
}

function descriptorLines(d: DescriptorFact, report: EntryReport): string[] {
  const lines = [`  descriptor   ${printablePath(d.path)}`];
  if (d.scope.deployment) lines.push('  applies      by exact address (context.contract.deployments lists it on chain 1)');
  if (d.scope.factories.length > 0) {
    const ours = report.factory !== undefined && d.scope.factories.includes(report.factory.address);
    lines.push(
      `  applies      BY FACTORY ${d.scope.factories.map(checksumAddress).join(', ')}${ours ? ` (the registry's factory ${report.factory!.name})` : ''}: ERC-7730 applies it to ANY contract that factory deploys, including an attacker's`,
    );
  }
  lines.push(`  index        ${report.index === undefined ? 'index.calldata.json has no entry for this address' : report.index === d.path ? 'index.calldata.json names this file' : `index.calldata.json names ${printablePath(report.index)}`}`);
  for (const include of d.includes) lines.push(`  includes     ${printablePath(include)}`);
  lines.push(`  file         sha256 ${d.fileSha256} of the file's bytes`);
  lines.push(
    d.descriptorHash === undefined
      ? `  hash         descriptorHash not computed: ${d.unresolved}`
      : `  hash         descriptorHash ${d.descriptorHash}: keccak256 of the RFC 8785 JSON of the descriptor with includes resolved (ERC-8176)`,
  );
  for (const fn of d.functions) {
    lines.push(`  function     ${fn.selector ?? '<a format key that is no function signature>'}${fn.signature === undefined ? '' : ` ${fn.signature}`}`);
    lines.push(...fieldLines(fn.fields, '    '));
    for (const path of fn.excluded) lines.push(`    excluded   ${path}`);
    if (fn.notShown.length > 0) lines.push(`    no field   ${fn.notShown.join(', ')}`);
  }
  if (d.attestations.length === 0) lines.push('  attestations none: no file in a sigs/ folder names this descriptor or attests its descriptorHash');
  for (const a of d.attestations) {
    lines.push(`  attestation  ${printablePath(a.file)}`);
    if (a.signer !== undefined) lines.push(`    signer     ${checksumAddress(a.signer)}, ${a.listed ? 'listed' : 'not listed'} in auditors/`);
    lines.push(`    result     ${statusLine(a.status)}`);
  }
  return lines;
}

/** Only structured facts: paths, hashes, addresses, selectors, canonical types and format names. No descriptor text. */
export function formatReports(snapshot: Snapshot, reports: readonly EntryReport[]): string {
  const scoped = factoryScoped(snapshot);
  const head = [
    `ERC-7730 registry ${ERC7730_REGISTRY_PIN.repository} at commit ${snapshot.commit}`,
    `${scoped.length} descriptor(s) scoped by factory: ${scoped.map((s) => printablePath(s.path)).join(', ') || 'none'}; one applies below only when its factory is the entry's registry factory`,
  ];
  const blocks = reports.map((report) => {
    const lines = [`${report.entry.name} ${checksumAddress(report.entry.address)} (${report.entry.kind})`];
    if (report.descriptors.length === 0) {
      lines.push(`  descriptor   none: no calldata descriptor lists this address on chain 1${report.factory === undefined ? '' : ` or is scoped by its factory ${report.factory.name}`}`);
      lines.push(`  index        ${report.index === undefined ? 'index.calldata.json has no entry for this address' : `index.calldata.json names ${printablePath(report.index)}, which does not list it`}`);
    }
    for (const d of report.descriptors) lines.push(...descriptorLines(d, report));
    return lines.join('\n');
  });
  return [head.join('\n'), ...blocks].join('\n\n');
}

export type Erc7730Recording = {
  readonly commit: string;
  readonly fetched: string;
  readonly entries: readonly string[];
  /** The files the run read, by path; `index.calldata.json` cut to the checked addresses. */
  readonly files: Readonly<Record<string, string>>;
  readonly chain: readonly unknown[];
};

/** Keeps the files a replay of `reports` reads: found descriptors, their includes and attestations, every factory-scoped descriptor, and the auditors named. */
export function trimForRecording(snapshot: Snapshot, reports: readonly EntryReport[]): Map<string, string> {
  const keep = new Set<string>();
  const add = (path: string) => {
    if (snapshot.files.has(path)) keep.add(path);
  };
  for (const s of factoryScoped(snapshot)) {
    add(s.path);
    const r = resolve(snapshot, s.path);
    if (r.kind === 'resolved') r.includes.forEach(add);
  }
  for (const report of reports) {
    for (const d of report.descriptors) {
      add(d.path);
      d.includes.forEach(add);
      for (const a of d.attestations) {
        add(a.file);
        for (const f of snapshot.files.keys()) if (a.signer !== undefined && f.toLowerCase() === `auditors/eip155-1-${a.signer.toLowerCase()}/profile.json`) add(f);
      }
    }
  }
  const files = new Map([...keep].sort().map((p) => [p, snapshot.files.get(p)!]));
  const index = snapshot.files.get('index.calldata.json');
  if (index !== undefined) {
    const full = parseJson(index);
    const cut: JsonObject = {};
    for (const report of reports) {
      const key = `eip155:1:${report.entry.address.toLowerCase()}`;
      if (isObject(full) && full[key] !== undefined) cut[key] = full[key];
    }
    files.set('index.calldata.json', `${JSON.stringify(cut, null, 2)}\n`);
  }
  return files;
}
