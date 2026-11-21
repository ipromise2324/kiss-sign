import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Hex } from '../safe/types.ts';

export type AbiType =
  | { readonly kind: 'uint'; readonly bits: number }
  | { readonly kind: 'int'; readonly bits: number }
  | { readonly kind: 'address' }
  | { readonly kind: 'bool' }
  | { readonly kind: 'fixed-bytes'; readonly size: number }
  | { readonly kind: 'bytes' }
  | { readonly kind: 'string' }
  | { readonly kind: 'array'; readonly item: AbiType }
  | { readonly kind: 'fixed-array'; readonly item: AbiType; readonly length: number }
  | { readonly kind: 'tuple'; readonly components: readonly AbiParam[] };

/** `name` is undefined when the signature leaves the parameter unnamed; callers then address it by its index. */
export type AbiParam = { readonly name: string | undefined; readonly type: AbiType };

export type AbiFunction = {
  readonly name: string;
  readonly params: readonly AbiParam[];
  /** The canonical form the selector hashes, such as `approve(address,uint256)`. */
  readonly signature: string;
  readonly selector: Hex;
};

export class AbiSignatureError extends Error {
  override name = 'AbiSignatureError';
}

const MAX_NESTING = 16;
const MAX_FIXED_LENGTH = 1024;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*/;

export function paramName(param: AbiParam, index: number): string {
  return param.name ?? String(index);
}

export function canonicalType(type: AbiType): string {
  switch (type.kind) {
    case 'uint':
    case 'int':
      return `${type.kind}${type.bits}`;
    case 'fixed-bytes':
      return `bytes${type.size}`;
    case 'address':
    case 'bool':
    case 'bytes':
    case 'string':
      return type.kind;
    case 'array':
      return `${canonicalType(type.item)}[]`;
    case 'fixed-array':
      return `${canonicalType(type.item)}[${type.length}]`;
    case 'tuple':
      return `(${type.components.map((c) => canonicalType(c.type)).join(',')})`;
  }
}

export function isDynamic(type: AbiType): boolean {
  switch (type.kind) {
    case 'bytes':
    case 'string':
    case 'array':
      return true;
    case 'fixed-array':
      return isDynamic(type.item);
    case 'tuple':
      return type.components.some((c) => isDynamic(c.type));
    default:
      return false;
  }
}

/** Bytes the type takes in its enclosing tuple's head. */
export function headSize(type: AbiType): number {
  if (isDynamic(type)) return 32;
  if (type.kind === 'tuple') return type.components.reduce((size, c) => size + headSize(c.type), 0);
  if (type.kind === 'fixed-array') return type.length * headSize(type.item);
  return 32;
}

function elementary(word: string): AbiType | undefined {
  if (word === 'address' || word === 'bool' || word === 'bytes' || word === 'string') return { kind: word };
  const sized = /^(uint|int|bytes)([0-9]*)$/.exec(word);
  if (sized === null) return undefined;
  const [, base, digits] = sized as unknown as [string, 'uint' | 'int' | 'bytes', string];
  if (digits.startsWith('0')) return undefined;
  if (base === 'bytes') {
    const size = Number(digits);
    return size >= 1 && size <= 32 ? { kind: 'fixed-bytes', size } : undefined;
  }
  const bits = digits === '' ? 256 : Number(digits);
  return bits >= 8 && bits <= 256 && bits % 8 === 0 ? { kind: base, bits } : undefined;
}

class Reader {
  at = 0;
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  fail(problem: string): never {
    throw new AbiSignatureError(`${JSON.stringify(this.text.slice(0, 200))} at ${this.at}: ${problem}`);
  }

  skipSpaces(): void {
    while (this.text[this.at] === ' ') this.at += 1;
  }

  take(char: string): boolean {
    this.skipSpaces();
    if (this.text[this.at] !== char) return false;
    this.at += 1;
    return true;
  }

  identifier(): string | undefined {
    this.skipSpaces();
    const match = IDENTIFIER.exec(this.text.slice(this.at));
    if (match === null) return undefined;
    this.at += match[0].length;
    return match[0];
  }

  params(depth: number): AbiParam[] {
    if (depth > MAX_NESTING) this.fail('nested too deep');
    const params: AbiParam[] = [];
    if (this.take(')')) return params;
    do {
      const type = this.type(depth);
      const name = this.identifier();
      params.push({ name, type });
    } while (this.take(','));
    if (!this.take(')')) this.fail('expected "," or ")"');
    return params;
  }

  type(depth: number): AbiType {
    let type: AbiType;
    if (this.take('(')) {
      const components = this.params(depth + 1);
      if (components.length === 0) this.fail('an empty tuple');
      type = { kind: 'tuple', components };
    } else {
      const word = this.identifier();
      const parsed = word === undefined ? undefined : elementary(word);
      if (parsed === undefined) this.fail(`unknown type ${JSON.stringify(word ?? '')}`);
      type = parsed;
    }
    while (this.text[this.at] === '[') {
      this.at += 1;
      const digits = /^[0-9]*/.exec(this.text.slice(this.at))?.[0] ?? '';
      this.at += digits.length;
      if (this.text[this.at] !== ']') this.fail('expected "]"');
      this.at += 1;
      if (digits === '') {
        type = { kind: 'array', item: type };
        continue;
      }
      const length = Number(digits);
      if (digits.startsWith('0') || length > MAX_FIXED_LENGTH) this.fail(`bad array length ${digits}`);
      type = { kind: 'fixed-array', item: type, length };
    }
    return type;
  }
}

export function selectorOf(signature: string): Hex {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(signature)).subarray(0, 4))}` as Hex;
}

/**
 * Parses `name(type name, ...)`. Parameter names are optional and play no part in the selector, so
 * `approve(address,uint256)` and `approve(address spender, uint256 value)` give the same function.
 */
export function parseFunctionSignature(text: string): AbiFunction {
  const reader = new Reader(text);
  const fn = functionOf(reader);
  reader.skipSpaces();
  if (reader.at !== text.length) reader.fail('unexpected text after ")"');
  return fn;
}

function functionOf(reader: Reader): AbiFunction {
  const name = reader.identifier();
  if (name === undefined) return reader.fail('expected a function name');
  if (reader.text[reader.at] !== '(') reader.fail('expected "("');
  reader.at += 1;
  const params = reader.params(0);
  const signature = `${name}(${params.map((p) => canonicalType(p.type)).join(',')})`;
  return { name, params, signature, selector: selectorOf(signature) };
}

/** Parses `name(type name, ...) returns (type name, ...)`, a view function with the values it returns. */
export function parseViewSignature(text: string): { readonly fn: AbiFunction; readonly returns: readonly AbiParam[] } {
  const reader = new Reader(text);
  const fn = functionOf(reader);
  if (reader.identifier() !== 'returns' || !reader.take('(')) reader.fail('expected "returns ("');
  const returns = reader.params(0);
  if (returns.length === 0) reader.fail('returns nothing');
  reader.skipSpaces();
  if (reader.at !== text.length) reader.fail('unexpected text after ")"');
  return { fn, returns };
}

type JsonParam = { readonly name?: unknown; readonly type?: unknown; readonly components?: unknown };

function jsonType(param: JsonParam, component: (param: JsonParam) => string = jsonParam): string {
  if (typeof param.type !== 'string') throw new AbiSignatureError('an ABI parameter without a type');
  const tuple = /^tuple((\[[0-9]*\])*)$/.exec(param.type);
  if (tuple === null) return param.type;
  if (!Array.isArray(param.components)) throw new AbiSignatureError('a tuple without components');
  return `(${(param.components as JsonParam[]).map((item) => component(item)).join(',')})${tuple[1] ?? ''}`;
}

const canonicalJsonType = (param: JsonParam): string => jsonType(param, canonicalJsonType);

function jsonParam(param: JsonParam): string {
  const name = typeof param.name === 'string' && param.name !== '' ? ` ${param.name}` : '';
  return `${jsonType(param)}${name}`;
}

/** A function entry of a solc ABI, written as a named signature that `parseFunctionSignature` reads. */
export function namedSignatureOfAbiEntry(entry: Readonly<Record<string, unknown>>): string {
  if (typeof entry.name !== 'string' || !Array.isArray(entry.inputs)) throw new AbiSignatureError('not a function entry');
  return `${entry.name}(${(entry.inputs as JsonParam[]).map(jsonParam).join(',')})`;
}

/** The canonical signature of a function entry of a solc ABI, from the types solc gives its inputs. */
export function signatureOfAbiEntry(entry: Readonly<Record<string, unknown>>): string {
  if (typeof entry.name !== 'string' || !Array.isArray(entry.inputs)) throw new AbiSignatureError('not a function entry');
  return `${entry.name}(${(entry.inputs as JsonParam[]).map(canonicalJsonType).join(',')})`;
}
