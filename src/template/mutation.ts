import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { ResolvedCard } from '../card.ts';
import type { AbiType } from '../decode/abi.ts';
import { uintWord } from '../decode/codec.ts';
import type { Registry } from '../registry.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { checkTemplateFields, inspectTemplateFields } from './check.ts';
import type { FieldCheck, Leaf, MessageLeaf, Messages } from './check.ts';
import { memberJson, typedDataDigest } from './eip712.ts';
import type { MemberValue } from './eip712.ts';
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
      return uintWord(nextInt(type, word)).subarray(32 - current.length);
    case 'bool':
      return uintWord(word === 0n ? 1n : 0n).subarray(32 - current.length);
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

type Mutated = { readonly tx: SafeTx; readonly messages: Messages };

/** Another value of the member's type, or for an `atLeast` bound 0, its loosest; undefined when none differs. */
function otherMember(leaf: Leaf, value: MemberValue): MemberValue | undefined {
  if (leaf.rule.kind === 'at-least') return value.kind === 'uint' && value.value !== 0n ? { kind: 'uint', value: 0n } : undefined;
  if (value.kind === 'string') return { kind: 'string', value: `${value.value}78` as Hex };
  if (value.kind === 'uint' || value.kind === 'int') {
    if (leaf.type.kind !== 'uint' && leaf.type.kind !== 'int') return undefined;
    return { kind: value.kind, value: nextInt(leaf.type, value.value) };
  }
  if (value.kind === 'bool') return { kind: 'bool', value: !value.value };
  const bytes = mutateBytes(leaf.type, hexToBytes((value.value as Hex).slice(2)));
  return bytes === undefined ? undefined : ({ kind: value.kind, value: `0x${bytesToHex(bytes)}` } as MemberValue);
}

/** The message with one member changed, its digest written again into the transaction, and the new message given. */
function mutateMember(tx: SafeTx, leaf: Leaf, at: MessageLeaf, messages: Messages): Mutated | undefined {
  const other = otherMember(leaf, at.values[at.member] as MemberValue);
  if (other === undefined) return undefined;
  const values = at.values.map((v, i) => (i === at.member ? other : v));
  const name = at.message.struct.members[at.member]?.name as string;
  const body = { ...at.body, [name]: memberJson(other) };
  const data = hexToBytes(tx.data.slice(2));
  data.set(hexToBytes(typedDataDigest(at.message.separator, at.message.struct, values).slice(2)), at.digest[0]);
  return { tx: { ...tx, data: `0x${bytesToHex(data)}` as Hex }, messages: [...messages, JSON.stringify(body)] };
}

function mutate(tx: SafeTx, leaf: Leaf, messages: Messages): Mutated | undefined {
  if (leaf.message !== undefined) return mutateMember(tx, leaf, leaf.message, messages);
  const changed = mutateTx(tx, leaf);
  return changed === undefined ? undefined : { tx: changed, messages };
}

function mutateTx(tx: SafeTx, leaf: Leaf): SafeTx | undefined {
  if (leaf.rule.kind === 'at-least' && leaf.bytes !== undefined) {
    const data = hexToBytes(tx.data.slice(2));
    const [start, end] = leaf.bytes;
    if (BigInt(`0x${bytesToHex(data.subarray(start, end))}`) === 0n) return undefined;
    data.fill(0, start, end);
    return { ...tx, data: `0x${bytesToHex(data)}` as Hex };
  }
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
const isEmptyConst = ({ rule }: Leaf): boolean => rule.kind === 'const' && (rule.value.kind === 'bytes' || rule.value.kind === 'string') && rule.value.value.length === 2;

export function checkMutations(
  tx: SafeTx,
  card: ResolvedCard,
  templates: ReadonlyMap<string, Template>,
  registry: Registry,
  messages: Messages = [],
  checker: Checker = checkTemplateFields,
): MutationResult {
  const { check, leaves } = inspectTemplateFields(tx, card, templates, registry, messages);
  if (check.kind !== 'match') return { kind: 'not-run', check };
  const bound = leaves.filter((leaf) => leaf.rule.kind !== 'free');
  const free = leaves.length - bound.length;
  const uncaught: Uncaught[] = [];
  for (const leaf of bound) {
    // Empty constant bytes have no byte to change in place, and any other value is longer, which the field check compares.
    if (isEmptyConst(leaf)) continue;
    const mutated = mutate(tx, leaf, messages);
    if (mutated === undefined) {
      uncaught.push({ leaf, mutated: 'not-mutable' });
      continue;
    }
    const result = checker(mutated.tx, card, templates, registry, mutated.messages);
    if (result.kind !== 'mismatch') uncaught.push({ leaf, mutated: result.kind });
  }
  return uncaught.length === 0
    ? { kind: 'pass', bound: bound.length, free }
    : { kind: 'weak-template', bound: bound.length, free, uncaught };
}
