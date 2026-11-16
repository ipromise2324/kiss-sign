import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { AbiParam, AbiType } from '../decode/abi.ts';
import { uintWord } from '../decode/codec.ts';
import type { Address, Hex } from '../safe/types.ts';

/** The registry and templates describe Ethereum mainnet contracts only. */
const CHAIN_ID = 1n;

const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

/** One struct type, as EIP-712's `encodeType` writes it, such as `Order(address sellToken,...)`. */
export type StructType = { readonly name: string; readonly members: readonly AbiParam[]; readonly encoded: string };

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

function memberValue(type: AbiType, raw: unknown): MemberValue | undefined {
  switch (type.kind) {
    case 'uint':
    case 'int': {
      const n = integer(raw);
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

/**
 * Each member of `struct`, read by its name from the top-level JSON object `text` holds, or why it cannot be. Other
 * keys are left alone, since an API answers more than the message.
 */
export function parseMessage(struct: StructType, text: string): { readonly values: readonly MemberValue[]; readonly body: Readonly<Record<string, unknown>> } | string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'not a JSON object';
  const record = body as Record<string, unknown>;
  const values: MemberValue[] = [];
  for (const member of struct.members) {
    const value = memberValue(member.type, Object.hasOwn(record, member.name as string) ? record[member.name as string] : undefined);
    if (value === undefined) return `no ${member.name} of type ${member.type.kind}`;
    values.push(value);
  }
  return { values, body: record };
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
