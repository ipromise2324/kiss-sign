import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { AbiParam, AbiType } from '../decode/abi.ts';
import { uintWord } from '../decode/codec.ts';
import type { ApiPathStep } from '../registry.ts';
import type { Address, Hex } from '../safe/types.ts';

/** The registry and templates describe Ethereum mainnet contracts only. */
const CHAIN_ID = 1n;

const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

/** One struct type, as EIP-712's `encodeType` writes it, such as `Order(address sellToken,...)`. */
export type StructType = { readonly name: string; readonly members: readonly AbiParam[]; readonly encoded: string };

/** Where a `lookup` answer holds one member, from the object `MessageAnswer.path` reaches, and whether a `uintN` is `0x` hex. */
export type MemberSource = { readonly path: readonly ApiPathStep[]; readonly encoding: 'plain' | 'hex' };

/** Where a `lookup` answer holds the message: `path` to its object, then each member's source, by position. */
export type MessageAnswer = { readonly path: readonly ApiPathStep[]; readonly members: readonly MemberSource[] };

/** The message as one top-level object with each member under its own name, as CoW serves it and verdict files keep it. */
export const ownNames = (struct: StructType): MessageAnswer => ({ path: [], members: struct.members.map((member) => ({ path: [member.name as string], encoding: 'plain' })) });

/** A member's value as the message holds it. A string or `bytes` member is kept as its bytes, hex. */
export type MemberValue =
  | { readonly kind: 'uint' | 'int'; readonly value: bigint }
  | { readonly kind: 'address'; readonly value: Address }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'fixed-bytes' | 'bytes' | 'string'; readonly value: Hex };

const keccak = (bytes: Uint8Array): Uint8Array => keccak_256(bytes);
const hex = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}` as Hex;

/** EIP-712 allows a struct member of an atomic type, `string` or `bytes`; no array and no nested struct here. */
export const isMemberType = (type: AbiType): boolean => ['uint', 'int', 'address', 'bool', 'fixed-bytes', 'bytes', 'string'].includes(type.kind);

export function domainSeparator(domain: { readonly name: string; readonly version: string; readonly verifyingContract: Address }): Hex {
  return hex(
    keccak(
      concatBytes(
        keccak(utf8ToBytes(DOMAIN_TYPE)),
        keccak(utf8ToBytes(domain.name)),
        keccak(utf8ToBytes(domain.version)),
        uintWord(CHAIN_ID),
        uintWord(BigInt(domain.verifyingContract)),
      ),
    ),
  );
}

function encodeMember(value: MemberValue): Uint8Array {
  switch (value.kind) {
    case 'uint':
      return uintWord(value.value);
    case 'int':
      return uintWord(BigInt.asUintN(256, value.value));
    case 'address':
      return uintWord(BigInt(value.value));
    case 'bool':
      return uintWord(value.value ? 1n : 0n);
    case 'fixed-bytes': {
      const word = new Uint8Array(32);
      word.set(hexToBytes(value.value.slice(2)));
      return word;
    }
    case 'bytes':
    case 'string':
      return keccak(hexToBytes(value.value.slice(2)));
  }
}

/** `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))`, with the members in the struct's order. */
export function typedDataDigest(separator: Hex, struct: StructType, values: readonly MemberValue[]): Hex {
  const structHash = keccak(concatBytes(keccak(utf8ToBytes(struct.encoded)), ...values.map(encodeMember)));
  return hex(keccak(concatBytes(new Uint8Array([0x19, 0x01]), hexToBytes(separator.slice(2)), structHash)));
}

/** A JSON number counts only when it is an integer JavaScript holds exactly. */
function integer(raw: unknown): bigint | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? BigInt(raw) : undefined;
  if (typeof raw === 'string' && /^-?(0|[1-9][0-9]{0,77})$/.test(raw)) return BigInt(raw);
  return undefined;
}

function memberValue(type: AbiType, raw: unknown, encoding: MemberSource['encoding']): MemberValue | undefined {
  switch (type.kind) {
    case 'uint':
    case 'int': {
      const n = encoding === 'hex' ? (typeof raw === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(raw) ? BigInt(raw) : undefined) : integer(raw);
      if (n === undefined) return undefined;
      const fits = type.kind === 'uint' ? BigInt.asUintN(type.bits, n) === n : BigInt.asIntN(type.bits, n) === n;
      return fits ? { kind: type.kind, value: n } : undefined;
    }
    case 'address':
      return typeof raw === 'string' && /^0x[0-9a-fA-F]{40}$/.test(raw) ? { kind: 'address', value: raw.toLowerCase() as Address } : undefined;
    case 'bool':
      return typeof raw === 'boolean' ? { kind: 'bool', value: raw } : undefined;
    case 'fixed-bytes':
      return typeof raw === 'string' && new RegExp(`^0x[0-9a-fA-F]{${type.size * 2}}$`).test(raw) ? { kind: 'fixed-bytes', value: raw.toLowerCase() as Hex } : undefined;
    case 'bytes':
      return typeof raw === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(raw) ? { kind: 'bytes', value: raw.toLowerCase() as Hex } : undefined;
    case 'string':
      return typeof raw === 'string' ? { kind: 'string', value: hex(utf8ToBytes(raw)) } : undefined;
    default:
      return undefined;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value `path` reaches in `json`, through own keys and array indexes only. */
function walk(json: unknown, path: readonly ApiPathStep[]): unknown {
  let value = json;
  for (const step of path) {
    if (typeof step === 'number') value = Array.isArray(value) ? value[step] : undefined;
    else value = isRecord(value) && Object.hasOwn(value, step) ? value[step] : undefined;
  }
  return value;
}

/**
 * Each member of `struct` read from the JSON `text` holds, where `answer` says, or why it cannot be. Other keys are left
 * alone, since an API answers more than the message.
 */
function readMembers(struct: StructType, answer: MessageAnswer, text: string): readonly MemberValue[] | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  const root = walk(json, answer.path);
  if (!isRecord(root)) return answer.path.length === 0 ? 'not a JSON object' : `no JSON object at ${answer.path.join('.')}`;
  const values: MemberValue[] = [];
  for (const [i, member] of struct.members.entries()) {
    const source = answer.members[i] as MemberSource;
    const value = memberValue(member.type, walk(root, source.path), source.encoding);
    if (value === undefined) return `no ${member.name} of type ${member.type.kind}${source.encoding === 'hex' ? ' in hex' : ''} at ${[...answer.path, ...source.path].join('.')}`;
    values.push(value);
  }
  return values;
}

/** The message as a verdict file keeps it: each member under its own name, in the encoding `parseMessage` reads. */
export function messageText(struct: StructType, values: readonly MemberValue[]): string {
  return JSON.stringify(Object.fromEntries(struct.members.map((member, i) => [member.name, memberJson(values[i] as MemberValue)])));
}

/** The message a `lookup` answer holds where `answer` says, as `messageText` writes it, or why it holds none. */
export function messageFromAnswer(struct: StructType, answer: MessageAnswer, text: string): { readonly text: string } | { readonly why: string } {
  const values = readMembers(struct, answer, text);
  return typeof values === 'string' ? { why: values } : { text: messageText(struct, values) };
}

/** Each member of `struct`, read from a message as `messageText` writes it, with that object, or why it cannot be. */
export function parseMessage(struct: StructType, text: string): { readonly values: readonly MemberValue[]; readonly body: Readonly<Record<string, unknown>> } | string {
  const values = readMembers(struct, ownNames(struct), text);
  return typeof values === 'string' ? values : { values, body: JSON.parse(text) as Record<string, unknown> };
}

/** The JSON a message holds for `value`, as `parseMessage` reads it back. */
export function memberJson(value: MemberValue): unknown {
  switch (value.kind) {
    case 'uint':
    case 'int':
      return String(value.value);
    case 'string':
      return Buffer.from(value.value.slice(2), 'hex').toString('utf8');
    default:
      return value.value;
  }
}
