import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { UsageError } from '../cli/io.ts';
import { AbiSignatureError, canonicalType, parseFunctionSignature } from '../decode/abi.ts';
import type { AbiType } from '../decode/abi.ts';
import { encodeParams } from '../decode/codec.ts';
import type { AbiValue } from '../decode/codec.ts';
import type { Address, Hex } from '../safe/types.ts';
import { argOf } from './read-view.ts';
import { anchorEvent } from './sources.ts';

const hex = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}` as Hex;

function parsed<T>(what: string, text: string, parse: (text: string) => T): T {
  try {
    return parse(text);
  } catch (error) {
    if (error instanceof AbiSignatureError) throw new UsageError(`${what} ${JSON.stringify(text)}: ${error.message}`);
    throw error;
  }
}

/** A function's canonical signature and its 4-byte selector; parameter names play no part. */
export function selectorLine(signature: string): string {
  const fn = parsed('function', signature, parseFunctionSignature);
  return `${fn.selector}  ${fn.signature}`;
}

/** An event's canonical signature and its topic 0, keccak256 of that signature; `indexed` and names play no part. */
export function topicLine(signature: string): string {
  const event = parsed('event', signature, anchorEvent);
  return `${event.topic}  ${event.signature}`;
}

const span: AbiValue['span'] = [0, 0];

/** A word as a value of `type`: a tuple or an array as a JSON array, of strings and nested arrays, else as `argOf` reads it. */
function valueOf(type: AbiType, raw: unknown, addressOf: (raw: string) => Address | undefined): AbiValue {
  const items = (count: number | undefined): unknown[] => {
    const refuse = (): never => {
      throw new UsageError(`${canonicalType(type)} takes a JSON array of ${count ?? 'its'} items, such as '["usdc","1"]', got ${JSON.stringify(raw)}`);
    };
    let list = raw;
    if (typeof raw === 'string') {
      try {
        list = JSON.parse(raw) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) refuse();
        throw error;
      }
    }
    if (!Array.isArray(list) || (count !== undefined && list.length !== count)) return refuse();
    return list;
  };
  switch (type.kind) {
    case 'tuple':
      return { kind: 'tuple', fields: items(type.components.length).map((item, i) => valueOf((type.components[i] as { type: AbiType }).type, item, addressOf)), span };
    case 'array':
    case 'fixed-array':
      return { kind: 'array', items: items(type.kind === 'array' ? undefined : type.length).map((item) => valueOf(type.item, item, addressOf)), span };
    default:
      if (typeof raw !== 'string') throw new UsageError(`${canonicalType(type)} takes a string, got ${JSON.stringify(raw)}`);
      return argOf(type, raw, addressOf);
  }
}

/** abi.encode of `values` as `types`, a comma list such as `address,uint24` or `(address,address,uint24,int24,address)`, and its keccak256. */
export function encodedHash(types: string, values: readonly string[], addressOf: (raw: string) => Address | undefined): { readonly encoded: Hex; readonly hash: Hex; readonly types: string } {
  const fn = parsed('types', types, (text) => parseFunctionSignature(`encode(${text})`));
  if (fn.params.length !== values.length) throw new UsageError(`${fn.params.length} types (${fn.signature.slice('encode'.length)}) but ${values.length} values; give one value per type, a tuple or an array as one JSON array`);
  const encoded = encodeParams(fn, fn.params.map((param, i) => valueOf(param.type, values[i], addressOf)));
  return { encoded: hex(encoded), hash: hex(keccak_256(encoded)), types: fn.signature.slice('encode'.length) };
}
