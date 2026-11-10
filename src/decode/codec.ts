import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { Address, Hex } from '../safe/types.ts';
import { headSize, isDynamic } from './abi.ts';
import type { AbiFunction, AbiType } from './abi.ts';

/** Half-open byte offsets `[start, end)` into the Safe transaction's `data`. */
export type Span = readonly [start: number, end: number];

/** A window `[start, end)` of the Safe transaction's `data`, so spans found inside it stay absolute. */
export type Region = { readonly root: Uint8Array; readonly start: number; readonly end: number };

/**
 * A static leaf's span is its whole 32-byte word. A `bytes` or `string` span covers its content only, so a call decoded
 * from it starts at `span[0]`. An array's span runs from its length word through its last tail.
 */
export type AbiValue =
  | { readonly kind: 'uint' | 'int'; readonly value: bigint; readonly span: Span }
  | { readonly kind: 'address'; readonly value: Address; readonly span: Span }
  | { readonly kind: 'bool'; readonly value: boolean; readonly span: Span }
  | { readonly kind: 'fixed-bytes'; readonly value: Hex; readonly span: Span }
  | { readonly kind: 'bytes' | 'string'; readonly value: Uint8Array; readonly span: Span }
  | { readonly kind: 'array'; readonly items: readonly AbiValue[]; readonly span: Span }
  | { readonly kind: 'tuple'; readonly fields: readonly AbiValue[]; readonly span: Span };

export type Trailer = { readonly value: Uint8Array; readonly span: Span };

export type DecodedCall = {
  readonly kind: 'decoded';
  readonly fn: AbiFunction;
  readonly args: readonly AbiValue[];
  /** Bytes after the arguments, present only when the caller allowed a trailer. */
  readonly trailer: Trailer | undefined;
  readonly span: Span;
};

export type DecodeFailure =
  | { readonly kind: 'malformed'; readonly at: number; readonly problem: string }
  /** The bytes decode, but the canonical encoding of what they decode to differs, first at byte `at`. */
  | { readonly kind: 'non-canonical'; readonly at: number }
  | { readonly kind: 'wrong-selector'; readonly at: number; readonly expected: Hex; readonly actual: Hex };

export type DecodeOptions = { readonly trailerMaxBytes?: number };

const WORD = 32;

class Failure {
  readonly failure: DecodeFailure;
  constructor(failure: DecodeFailure) {
    this.failure = failure;
  }
}

const malformed = (at: number, problem: string): never => {
  throw new Failure({ kind: 'malformed', at, problem });
};

export function wholeRegion(data: Uint8Array): Region {
  return { root: data, start: 0, end: data.length };
}

export function regionBytes(region: Region): Uint8Array {
  return region.root.subarray(region.start, region.end);
}

export function firstDifference(a: Uint8Array, b: Uint8Array): number | undefined {
  const shorter = Math.min(a.length, b.length);
  for (let i = 0; i < shorter; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? undefined : shorter;
}

/** Requires `actual` to be exactly `canonical`, else a `non-canonical` failure at the first differing absolute byte. */
export function requireCanonical(canonical: Uint8Array, region: Region): DecodeFailure | undefined {
  const at = firstDifference(canonical, regionBytes(region));
  return at === undefined ? undefined : { kind: 'non-canonical', at: region.start + at };
}

function readWord(root: Uint8Array, at: number, limit: number): bigint {
  if (at + WORD > limit) malformed(at, 'a 32-byte word runs past the end');
  return BigInt(`0x${bytesToHex(root.subarray(at, at + WORD))}`);
}

function readCount(root: Uint8Array, at: number, unit: number, from: number, limit: number): number {
  const count = readWord(root, at, limit);
  if (BigInt(from) + count * BigInt(Math.max(unit, 1)) > BigInt(limit)) malformed(at, 'a length runs past the end');
  return Number(count);
}

type Read<T> = { readonly value: T; readonly end: number };

function decodeTuple(root: Uint8Array, types: readonly AbiType[], start: number, limit: number): Read<AbiValue[]> {
  const headsEnd = start + types.reduce((size, type) => size + headSize(type), 0);
  if (headsEnd > limit) malformed(start, 'the heads run past the end');
  let head = start;
  let tail = headsEnd;
  const values = types.map((type) => {
    if (!isDynamic(type)) {
      const read = decodeValue(root, type, head, limit);
      head = read.end;
      return read.value;
    }
    // A canonical offset points exactly where the previous tail ended; anything else could alias another value.
    readWord(root, head, limit);
    const at = firstDifference(uintWord(BigInt(tail - start)), root.subarray(head, head + WORD));
    if (at !== undefined) throw new Failure({ kind: 'non-canonical', at: head + at });
    head += WORD;
    const read = decodeValue(root, type, tail, limit);
    tail = read.end;
    return read.value;
  });
  return { value: values, end: tail };
}

function decodeValue(root: Uint8Array, type: AbiType, at: number, limit: number): Read<AbiValue> {
  switch (type.kind) {
    case 'tuple': {
      const read = decodeTuple(root, type.components.map((c) => c.type), at, limit);
      return { value: { kind: 'tuple', fields: read.value, span: [at, read.end] }, end: read.end };
    }
    case 'fixed-array': {
      const read = decodeTuple(root, Array<AbiType>(type.length).fill(type.item), at, limit);
      return { value: { kind: 'array', items: read.value, span: [at, read.end] }, end: read.end };
    }
    case 'array': {
      const count = readCount(root, at, headSize(type.item), at + WORD, limit);
      const read = decodeTuple(root, Array<AbiType>(count).fill(type.item), at + WORD, limit);
      return { value: { kind: 'array', items: read.value, span: [at, read.end] }, end: read.end };
    }
    case 'bytes':
    case 'string': {
      const start = at + WORD;
      const length = readCount(root, at, 1, start, limit);
      const padded = start + Math.ceil(length / WORD) * WORD;
      if (padded > limit) malformed(at, 'the padding runs past the end');
      return { value: { kind: type.kind, value: root.slice(start, start + length), span: [start, start + length] }, end: padded };
    }
  }
  const word = readWord(root, at, limit);
  const span: Span = [at, at + WORD];
  const end = at + WORD;
  switch (type.kind) {
    case 'uint':
      return { value: { kind: 'uint', value: BigInt.asUintN(type.bits, word), span }, end };
    case 'int':
      return { value: { kind: 'int', value: BigInt.asIntN(type.bits, word), span }, end };
    case 'address':
      return { value: { kind: 'address', value: `0x${bytesToHex(root.subarray(end - 20, end))}` as Address, span }, end };
    case 'bool':
      return { value: { kind: 'bool', value: word !== 0n, span }, end };
    case 'fixed-bytes':
      return { value: { kind: 'fixed-bytes', value: `0x${bytesToHex(root.subarray(at, at + type.size))}` as Hex, span }, end };
  }
}

/**
 * Decodes `fn`'s call from `region` and accepts it only when re-encoding gives the same bytes. Any bytes after the
 * arguments fail unless `trailerMaxBytes` allows that many.
 */
export function decodeCall(fn: AbiFunction, region: Region, options: DecodeOptions = {}): DecodedCall | DecodeFailure {
  const { root, start, end } = region;
  try {
    if (end - start < 4) malformed(start, 'shorter than a selector');
    const actual = `0x${bytesToHex(root.subarray(start, start + 4))}` as Hex;
    if (actual !== fn.selector) return { kind: 'wrong-selector', at: start, expected: fn.selector, actual };
    const read = decodeTuple(root, fn.params.map((p) => p.type), start + 4, end);
    const trailing = end - read.end;
    const trailer: Trailer | undefined =
      trailing > 0 && trailing <= (options.trailerMaxBytes ?? 0)
        ? { value: root.slice(read.end, end), span: [read.end, end] }
        : undefined;
    const call: DecodedCall = { kind: 'decoded', fn, args: read.value, trailer, span: [start, end] };
    return requireCanonical(encodeCall(call), region) ?? call;
  } catch (error) {
    if (error instanceof Failure) return error.failure;
    throw error;
  }
}

export function uintWord(value: bigint): Uint8Array {
  return hexToBytes(BigInt.asUintN(256, value).toString(16).padStart(64, '0'));
}

function padRight(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(bytes.length / WORD) * WORD);
  padded.set(bytes);
  return padded;
}

function mismatch(type: AbiType, value: AbiValue): never {
  throw new Error(`cannot encode a ${value.kind} value as ${type.kind}`);
}

function encodeTuple(types: readonly AbiType[], values: readonly AbiValue[]): Uint8Array {
  if (types.length !== values.length) throw new Error(`${values.length} values for ${types.length} types`);
  const parts = types.map((type, i) => ({ dynamic: isDynamic(type), bytes: encodeValue(type, values[i] as AbiValue) }));
  let offset = parts.reduce((size, part) => size + (part.dynamic ? WORD : part.bytes.length), 0);
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  for (const part of parts) {
    if (!part.dynamic) {
      heads.push(part.bytes);
      continue;
    }
    heads.push(uintWord(BigInt(offset)));
    tails.push(part.bytes);
    offset += part.bytes.length;
  }
  return concatBytes(...heads, ...tails);
}

function encodeValue(type: AbiType, value: AbiValue): Uint8Array {
  switch (type.kind) {
    case 'uint':
    case 'int':
      return value.kind === type.kind ? uintWord(value.value) : mismatch(type, value);
    case 'address':
      return value.kind === 'address' ? uintWord(BigInt(value.value)) : mismatch(type, value);
    case 'bool':
      return value.kind === 'bool' ? uintWord(value.value ? 1n : 0n) : mismatch(type, value);
    case 'fixed-bytes':
      return value.kind === 'fixed-bytes' ? padRight(hexToBytes(value.value.slice(2))) : mismatch(type, value);
    case 'bytes':
    case 'string':
      return value.kind === type.kind ? concatBytes(uintWord(BigInt(value.value.length)), padRight(value.value)) : mismatch(type, value);
    case 'tuple':
      return value.kind === 'tuple' ? encodeTuple(type.components.map((c) => c.type), value.fields) : mismatch(type, value);
    case 'fixed-array':
      return value.kind === 'array' && value.items.length === type.length
        ? encodeTuple(Array<AbiType>(type.length).fill(type.item), value.items)
        : mismatch(type, value);
    case 'array':
      return value.kind === 'array'
        ? concatBytes(uintWord(BigInt(value.items.length)), encodeTuple(Array<AbiType>(value.items.length).fill(type.item), value.items))
        : mismatch(type, value);
  }
}

/** The canonical encoding: selector, arguments, then the trailer if the call has one. */
export function encodeCall(call: Pick<DecodedCall, 'fn' | 'args' | 'trailer'>): Uint8Array {
  return concatBytes(
    hexToBytes(call.fn.selector.slice(2)),
    encodeTuple(call.fn.params.map((p) => p.type), call.args),
    call.trailer?.value ?? new Uint8Array(),
  );
}
