import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef, BlockTag } from '../chain/types.ts';
import { UsageError } from '../cli/io.ts';
import { AbiSignatureError, canonicalType, namedSignatureOfAbiEntry, paramName, parseFunctionSignature, signatureOfAbiEntry } from '../decode/abi.ts';
import type { AbiFunction, AbiParam, AbiType } from '../decode/abi.ts';
import { castValue } from '../decode/cast.ts';
import type { AbiValue } from '../decode/codec.ts';
import { decodeValues, encodeCall } from '../decode/codec.ts';
import type { ViewFunction } from '../price/reference.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { ProvenAbi } from './proven-abi.ts';

const ORIENTATION = 'ORIENTATION ONLY: nothing is recorded, and no report, card or verify reads it.';

const span: AbiValue['span'] = [0, 0];

/** A parameter type one command-line word can give. */
type WordType = Exclude<AbiType, { readonly kind: 'array' | 'fixed-array' | 'tuple' }>;

/** The function's parameter types, refusing the first array or tuple: no command-line word gives one. */
export function wordTypes(fn: AbiFunction): readonly WordType[] {
  return fn.params.map((param, i) => {
    const { type } = param;
    if (type.kind === 'array' || type.kind === 'fixed-array' || type.kind === 'tuple') {
      throw new UsageError(`${fn.signature}: parameter ${paramName(param, i)} is ${canonicalType(type)}; a view that takes an array or a tuple cannot be called`);
    }
    return type;
  });
}

/** One command-line word as a value of `type`; an address-typed word may be a registry name. */
export function argOf(type: WordType, raw: string, addressOf: (raw: string) => Address | undefined): AbiValue {
  const refuse = (what: string): never => {
    throw new UsageError(`argument ${JSON.stringify(raw)}: ${canonicalType(type)} takes ${what}`);
  };
  switch (type.kind) {
    case 'uint':
    case 'int': {
      if (!/^-?[0-9]+$/.test(raw)) return refuse('a decimal number');
      const value = BigInt(raw);
      const [min, max] = type.kind === 'uint' ? [0n, 2n ** BigInt(type.bits) - 1n] : [-(2n ** BigInt(type.bits - 1)), 2n ** BigInt(type.bits - 1) - 1n];
      if (value < min || value > max) return refuse(`a number from ${min} to ${max}`);
      return { kind: type.kind, value, span };
    }
    case 'address':
      return { kind: 'address', value: addressOf(raw) ?? refuse('an address or a registry name'), span };
    case 'bool':
      return raw === 'true' || raw === 'false' ? { kind: 'bool', value: raw === 'true', span } : refuse('true or false');
    case 'fixed-bytes':
      return new RegExp(`^0x[0-9a-fA-F]{${type.size * 2}}$`).test(raw) ? { kind: 'fixed-bytes', value: raw.toLowerCase() as Hex, span } : refuse(`0x and ${type.size * 2} hex digits`);
    case 'bytes':
      return /^0x([0-9a-fA-F]{2})*$/.test(raw) ? { kind: 'bytes', value: hexToBytes(raw.slice(2)), span } : refuse('0x and an even number of hex digits');
    case 'string':
      return { kind: 'string', value: utf8ToBytes(raw), span };
  }
}

/** How the view's answer is read: refused before the call, decoded by these returns, or left as bytes. */
type Decoding =
  | { readonly kind: 'not-a-view'; readonly why: string }
  | { readonly kind: 'decode'; readonly returns: readonly AbiParam[]; readonly by: string }
  | { readonly kind: 'undecodable'; readonly why: string };

const NOT_ESTABLISHED = 'that it is a view or pure function, which changes no state, is not established';

function decodingOf(view: ViewFunction, abi: ProvenAbi): Decoding {
  if (abi.kind === 'none') return { kind: 'decode', returns: view.returns, by: `the given signature, with no proven ABI: ${abi.why}; ${NOT_ESTABLISHED}` };
  const entry = abi.abi.find((e) => e.type === 'function' && signatureOfAbiEntry(e) === view.fn.signature);
  if (entry === undefined) return { kind: 'decode', returns: view.returns, by: `the given signature: the proven ABI (${abi.from}) has no ${view.fn.signature}; ${NOT_ESTABLISHED}` };
  const mutability = typeof entry.stateMutability === 'string' ? entry.stateMutability : undefined;
  if (mutability !== 'view' && mutability !== 'pure') {
    return { kind: 'not-a-view', why: `the proven ABI, ${abi.from}, declares ${view.fn.signature} ${mutability ?? 'with no state mutability'}; pnpm read calls only a view or pure function` };
  }
  let returns: readonly AbiParam[];
  try {
    returns = parseFunctionSignature(namedSignatureOfAbiEntry({ name: 'returns', inputs: entry.outputs ?? [] })).params;
  } catch (error) {
    if (!(error instanceof AbiSignatureError)) throw error;
    return { kind: 'undecodable', why: `the proven ABI, ${abi.from}, declares returns that cannot be decoded: ${error.message}` };
  }
  const types = (params: readonly AbiParam[]) => `(${params.map((p) => canonicalType(p.type)).join(',')})`;
  const differ = types(returns) === types(view.returns) ? '' : `; the given returns ${types(view.returns)} differ from its ${types(returns)}`;
  return { kind: 'decode', returns, by: `the proven ABI, ${abi.from}${differ}` };
}

/**
 * Reads one view at one block both providers agree on, with the ABI `abiAt` proves at that block, and says what it returned,
 * or that it reverted, or why no value stands. `ok` is true only for decoded values and for a revert both providers agree on.
 */
export async function readView(
  reader: Reader,
  address: Address,
  view: ViewFunction,
  args: readonly AbiValue[],
  tag: BlockTag,
  abiAt: (at: BlockRef) => Promise<ProvenAbi>,
  name: string | undefined,
): Promise<{ readonly text: string; readonly ok: boolean }> {
  const lines = (ok: boolean, ...body: string[]) => ({ text: `${[...body, ORIENTATION].join('\n')}\n`, ok });
  const block = await reader.block(tag);
  if (block.kind === 'unverifiable') return lines(false, `NO ANSWER  the block: ${block.reason}`);
  const at = block.value;
  const where = `${checksumAddress(address)}${name === undefined ? '' : ` (${name})`}, ${view.fn.signature}, at block ${at.number} (${at.hash})`;
  const decoding = decodingOf(view, await abiAt(at));
  if (decoding.kind === 'not-a-view') return lines(false, where, `NOT A VIEW  ${decoding.why}`);
  const read = await reader.call({ to: address, data: `0x${bytesToHex(encodeCall({ fn: view.fn, args, trailer: undefined }))}` as Hex }, at);
  if (read.kind === 'unverifiable') return lines(false, where, `NO ANSWER  ${read.reason}`);
  const agreed = `both ${read.providers.join(' and ')} answered`;
  if (read.value.kind === 'reverted') return lines(true, where, `REVERTED  ${agreed} that the call reverts`);
  if (read.value.data.length === 2) {
    const code = await reader.getCode(address, at);
    if (code.kind === 'unverifiable') return lines(false, where, `RETURNED NOTHING  ${agreed}; its code: ${code.reason}`);
    return lines(false, where, code.value.length === 2 ? `NO CODE  ${agreed} nothing, and the address has no code at this block` : `RETURNED NOTHING  ${agreed} nothing, though the address has code`);
  }
  if (decoding.kind === 'undecodable') return lines(false, where, `UNDECODED  ${agreed} ${read.value.data}; ${decoding.why}`);
  const { returns, by } = decoding;
  const values = decodeValues(
    returns.map((p) => p.type),
    hexToBytes(read.value.data.slice(2)),
  );
  if (values === undefined) return lines(false, where, `UNDECODED  ${agreed} ${read.value.data}, not the canonical encoding of the returns of ${by}`);
  return lines(true, where, `${agreed}; decoded by ${by}:`, ...values.map((value, i) => `  ${paramName(returns[i] as AbiParam, i)} (${canonicalType((returns[i] as AbiParam).type)}): ${castValue(value)}`));
}
