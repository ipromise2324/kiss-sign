import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { ResolvedCard } from '../card.ts';
import type { AbiType } from '../decode/abi.ts';
import { uintWord } from '../decode/codec.ts';
import type { Registry } from '../registry.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { checkTemplateFields, inspectTemplateFields } from './check.ts';
import type { FieldChain, FieldCheck, Leaf } from './check.ts';
import type { Template } from './template.ts';

export type Checker = typeof checkTemplateFields;

/** A bound leaf whose mutated copy did not give `mismatch`, or that could not be mutated in place. */
export type Uncaught = { readonly leaf: Leaf; readonly mutated: FieldCheck['kind'] | 'not-mutable' };

export type MutationResult =
  | { readonly kind: 'pass'; readonly bound: number; readonly free: number }
  | { readonly kind: 'weak-template'; readonly bound: number; readonly free: number; readonly uncaught: readonly Uncaught[] }
  /** The transaction itself does not match, so no mutation can show anything. */
  | { readonly kind: 'not-run'; readonly check: FieldCheck };

function nextInt(type: Extract<AbiType, { kind: 'uint' | 'int' }>, word: bigint): bigint {
  const value = type.kind === 'uint' ? BigInt.asUintN(type.bits, word) : BigInt.asIntN(type.bits, word);
  const max = type.kind === 'uint' ? (1n << BigInt(type.bits)) - 1n : (1n << BigInt(type.bits - 1)) - 1n;
  return value === max ? value - 1n : value + 1n;
}

/** The leaf's bytes changed to another valid value of its type, or undefined when no in-place change exists. */
function mutateBytes(type: AbiType, current: Uint8Array): Uint8Array | undefined {
  const word = BigInt(`0x${bytesToHex(current) || '0'}`);
  switch (type.kind) {
    case 'address': {
      const flipped = word ^ 1n;
      const other = flipped === 0n ? word ^ 2n : flipped;
      return hexToBytes(other.toString(16).padStart(current.length * 2, '0'));
    }
    case 'uint':
    case 'int':
      return uintWord(nextInt(type, word));
    case 'bool':
      return uintWord(word === 0n ? 1n : 0n);
    case 'fixed-bytes':
    case 'bytes':
    case 'string': {
      if (current.length === 0) return undefined;
      const changed = current.slice();
      changed[0] = (changed[0] as number) ^ 0x80;
      return changed;
    }
    default:
      return undefined;
  }
}

const MAX_UINT = (1n << 256n) - 1n;

function mutate(tx: SafeTx, leaf: Leaf): SafeTx | undefined {
  if (leaf.rule.kind === 'share-price' && leaf.bytes !== undefined) {
    const data = hexToBytes(tx.data.slice(2));
    const loosest = leaf.rule.bound === 'max' ? MAX_UINT : 0n;
    if (BigInt(`0x${bytesToHex(data.subarray(...leaf.bytes))}`) === loosest) return undefined;
    data.set(uintWord(loosest), leaf.bytes[0]);
    return { ...tx, data: `0x${bytesToHex(data)}` as Hex };
  }
  if (leaf.bytes === undefined) {
    if (leaf.arg === 'to') return { ...tx, to: `0x${bytesToHex(mutateBytes(leaf.type, hexToBytes(tx.to.slice(2))) as Uint8Array)}` as Address };
    if (leaf.arg === 'value') return { ...tx, value: nextInt({ kind: 'uint', bits: 256 }, tx.value) };
    if (leaf.arg === 'nonce') return { ...tx, nonce: nextInt({ kind: 'uint', bits: 256 }, tx.nonce) };
    return undefined;
  }
  const data = hexToBytes(tx.data.slice(2));
  const [start, end] = leaf.bytes;
  const changed = mutateBytes(leaf.type, data.subarray(start, end));
  if (changed === undefined) return undefined;
  data.set(changed, end - changed.length);
  return { ...tx, data: `0x${bytesToHex(data)}` as Hex };
}

/**
 * Changes each bound leaf of a matching transaction, one at a time, and requires the checker to give `mismatch` for
 * every copy. A copy that still matches means the template, or the checker, does not hold that field.
 */
export function checkMutations(
  tx: SafeTx,
  card: ResolvedCard,
  templates: ReadonlyMap<string, Template>,
  registry: Registry,
  checker: Checker = checkTemplateFields,
  chain: FieldChain = {},
): MutationResult {
  const { check, leaves } = inspectTemplateFields(tx, card, templates, registry, chain);
  if (check.kind !== 'match') return { kind: 'not-run', check };
  const bound = leaves.filter((leaf) => leaf.rule.kind !== 'free');
  const free = leaves.length - bound.length;
  const uncaught: Uncaught[] = [];
  for (const leaf of bound) {
    const mutated = mutate(tx, leaf);
    if (mutated === undefined) {
      uncaught.push({ leaf, mutated: 'not-mutable' });
      continue;
    }
    const result = checker(mutated, card, templates, registry, chain);
    if (result.kind !== 'mismatch') uncaught.push({ leaf, mutated: result.kind });
  }
  return uncaught.length === 0
    ? { kind: 'pass', bound: bound.length, free }
    : { kind: 'weak-template', bound: bound.length, free, uncaught };
}
