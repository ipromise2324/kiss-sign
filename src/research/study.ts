import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import { parseFunctionSignature } from '../decode/abi.ts';
import type { AbiFunction, AbiType } from '../decode/abi.ts';
import { decodeCall, wholeRegion } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import type { Registry } from '../registry.ts';
import { EXECUTION_SUCCESS } from '../simulate/events.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { inspectTemplateFields } from '../template/check.ts';
import type { Leaf } from '../template/check.ts';
import type { CallNode, ConstValue, Rule, Template, TemplateCall } from '../template/template.ts';

export type LeafRule = Exclude<Rule, { readonly kind: 'call' | 'items' | 'fields' }>;

/**
 * The template with every leaf set free, so only its shape is checked (calls, selectors, canonical encoding, trailers),
 * and the original leaf rules in the order the check visits them, so each leaf the check reports pairs with its rule.
 */
export type Loosened = { readonly shape: Template; readonly anyTrailer: Template; readonly rules: readonly LeafRule[] };

const MAX_TRAILER = 32;

export function loosen(template: Template): Loosened {
  const rules: LeafRule[] = [];
  const looseRule = (rule: Rule, wideTrailer: boolean, record: boolean): Rule => {
    switch (rule.kind) {
      case 'call':
        return { kind: 'call', call: looseCall(rule.call, wideTrailer, record) };
      case 'items':
        return { kind: 'items', items: rule.items.map((item) => looseRule(item, wideTrailer, record)) };
      case 'fields':
        return { kind: 'fields', fields: rule.fields.map((field) => looseRule(field, wideTrailer, record)) };
      default:
        if (record) rules.push(rule);
        return { kind: 'free', reason: 'study' };
    }
  };
  const looseCall = (node: CallNode, wideTrailer: boolean, record: boolean): CallNode => ({
    fn: node.fn,
    args: node.args.map((arg) => looseRule(arg, wideTrailer, record)),
    trailer: wideTrailer ? { maxBytes: MAX_TRAILER, why: 'study' } : node.trailer,
  });
  const looseTop = (call: TemplateCall, wideTrailer: boolean, record: boolean): TemplateCall => {
    const to = looseRule(call.to, wideTrailer, record);
    const value = looseRule(call.value, wideTrailer, record);
    return { ...looseCall(call, wideTrailer, record), to, value };
  };
  const shape = { ...template, calls: template.calls.map((call) => looseTop(call, false, true)) };
  const anyTrailer = { ...template, calls: template.calls.map((call) => looseTop(call, true, false)) };
  return { shape, anyTrailer, rules };
}

export type NotSafeReason = 'not a call to execTransaction' | 'execTransaction calldata does not decode' | 'no ExecutionSuccess from the called Safe';

export type TxStudy =
  | { readonly kind: 'excluded' }
  | { readonly kind: 'unreadable'; readonly hash: Hex; readonly reason: string }
  /** `selector` is the first four bytes the transaction called, which tell an EOA call from a relayer or a 4337 bundle. */
  | { readonly kind: 'not-safe'; readonly hash: Hex; readonly why: NotSafeReason; readonly selector: string }
  | { readonly kind: 'misfit'; readonly hash: Hex; readonly safe: Address; readonly reason: string }
  /** `values` pairs with `Loosened.rules`; `paths` names each leaf. */
  | { readonly kind: 'fit'; readonly hash: Hex; readonly safe: Address; readonly paths: readonly string[]; readonly types: readonly AbiType[]; readonly values: readonly string[] };

const EXEC_TRANSACTION = parseFunctionSignature(
  'execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)',
);

/** The SafeTx an `execTransaction` call carries. The nonce and version only feed the Safe's hash, which a study never computes. */
function safeTxOf(safe: Address, input: Hex): SafeTx | undefined {
  const call = decodeCall(EXEC_TRANSACTION, wholeRegion(hexToBytes(input.slice(2))));
  if (call.kind !== 'decoded') return undefined;
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver] = call.args.map((arg) =>
    arg.kind === 'bytes' ? (`0x${bytesToHex(arg.value)}` as Hex) : 'value' in arg ? arg.value : undefined,
  );
  if (operation !== 0n && operation !== 1n) return undefined;
  return {
    chainId: 1n,
    safe,
    version: '1.4.1',
    to: to as Address,
    value: value as bigint,
    data: data as Hex,
    operation: operation === 0n ? 0 : 1,
    safeTxGas: safeTxGas as bigint,
    baseGas: baseGas as bigint,
    gasPrice: gasPrice as bigint,
    gasToken: gasToken as Address,
    refundReceiver: refundReceiver as Address,
    nonce: 0n,
  };
}

export function leafValue(leaf: Leaf, tx: SafeTx): string {
  if (leaf.bytes === undefined) return leaf.arg === 'to' ? tx.to : String(tx.value);
  const bytes = hexToBytes(tx.data.slice(2)).subarray(leaf.bytes[0], leaf.bytes[1]);
  const word = BigInt(`0x${bytesToHex(bytes) || '0'}`);
  switch (leaf.type.kind) {
    case 'address':
      return `0x${bytesToHex(bytes.subarray(bytes.length - 20))}`;
    case 'uint':
      return word.toString();
    case 'int':
      return BigInt.asIntN(leaf.type.bits, word).toString();
    case 'bool':
      return word === 0n ? 'false' : 'true';
    case 'fixed-bytes':
      return `0x${bytesToHex(bytes.subarray(0, leaf.type.size))}`;
    default:
      return `0x${bytesToHex(bytes)}`;
  }
}

/** A constant rendered the way `leafValue` renders the same bytes. */
export function constText(value: ConstValue): string {
  return typeof value.value === 'bigint' || typeof value.value === 'boolean' ? String(value.value) : value.value;
}

function functionNames(template: Template): Map<string, string> {
  const names = new Map<string, string>();
  const visitRule = (rule: Rule): void => {
    if (rule.kind === 'call') visitCall(rule.call);
    if (rule.kind === 'items') rule.items.forEach(visitRule);
    if (rule.kind === 'fields') rule.fields.forEach(visitRule);
  };
  const visitCall = (node: CallNode | { fn: AbiFunction; args: readonly Rule[] }): void => {
    names.set(node.fn.selector, node.fn.name);
    node.args.forEach(visitRule);
  };
  template.calls.forEach(visitCall);
  return names;
}

/** Why a transaction does not fit the template's shape, in words that group alike transactions. */
function misfitReason(tx: SafeTx, loosened: Loosened, template: Template, registry: Registry, check: (t: Template) => ReturnType<typeof inspectTemplateFields>): string {
  const unwrapped = unwrapSafeTx(tx);
  if (unwrapped.kind === 'foreign-delegatecall') return 'a delegatecall to a contract that is not an official MultiSend';
  if (unwrapped.kind !== 'direct' && unwrapped.kind !== 'multisend') return 'a MultiSend batch that does not decode canonically';
  const names = functionNames(template);
  const shapeOf = unwrapped.calls.map((call) => {
    const target = registry.byAddress.get(call.to)?.name ?? 'another contract';
    const data = call.data.root.subarray(call.data.start, call.data.end);
    if (data.length === 0) return `${target} (no data)`;
    const selector = `0x${bytesToHex(data.subarray(0, 4))}`;
    return `${target}.${names.get(selector) ?? selector}`;
  });
  const sameCalls =
    unwrapped.calls.length === template.calls.length &&
    unwrapped.calls.every((call, i) => {
      const fn = template.calls[i]?.fn;
      return fn !== undefined && call.data.end - call.data.start >= 4 && bytesToHex(call.data.root.subarray(call.data.start, call.data.start + 4)) === fn.selector.slice(2);
    });
  if (!sameCalls) return `calls ${shapeOf.join(', ')}`;
  const wide = check(loosened.anyTrailer).check;
  const strict = check(loosened.shape).check;
  const first = strict.kind === 'mismatch' ? strict.findings[0] : undefined;
  if (wide.kind === 'match') return `more bytes after the arguments than the template allows, at ${first?.callPath ?? 'a call'}`;
  if (first === undefined) return 'does not fit';
  return `${first.callPath}.${first.arg}: expected ${first.expected}, got ${first.actual}`;
}

export type StudyContext = {
  readonly template: Template;
  readonly loosened: Loosened;
  readonly registry: Registry;
  /** The configured Safe, left out of every result. */
  readonly exclude: Address | undefined;
};

export async function studyTx(reader: Reader, hash: Hex, context: StudyContext): Promise<TxStudy> {
  const read = await reader.getTransaction(hash);
  if (read.kind === 'unverifiable') return { kind: 'unreadable', hash, reason: read.reason };
  const tx = read.value;
  if (tx === null) return { kind: 'unreadable', hash, reason: 'neither provider knows the transaction' };
  if (context.exclude !== undefined && (tx.to === context.exclude || tx.from === context.exclude)) return { kind: 'excluded' };
  const selector = tx.input.length >= 10 ? tx.input.slice(0, 10) : 'no data';
  if (tx.to === null || !tx.input.startsWith(EXEC_TRANSACTION.selector)) return { kind: 'not-safe', hash, why: 'not a call to execTransaction', selector };
  const safe = tx.to;
  const safeTx = safeTxOf(safe, tx.input);
  if (safeTx === undefined) return { kind: 'not-safe', hash, why: 'execTransaction calldata does not decode', selector };
  const receiptRead = await reader.getTransactionReceipt(hash);
  if (receiptRead.kind === 'unverifiable') return { kind: 'unreadable', hash, reason: receiptRead.reason };
  const receipt = receiptRead.value;
  if (receipt === null || !receipt.logs.some((log) => log.address === safe && log.topics[0] === EXECUTION_SUCCESS)) {
    return { kind: 'not-safe', hash, why: 'no ExecutionSuccess from the called Safe', selector };
  }
  const { template, loosened, registry } = context;
  const check = (t: Template) =>
    inspectTemplateFields(safeTx, { safe, operations: [{ template: template.id, values: new Map() }] }, new Map([[template.id, t]]), registry);
  const inspection = check(loosened.shape);
  if (inspection.check.kind !== 'match' || inspection.leaves.length !== loosened.rules.length) {
    return { kind: 'misfit', hash, safe, reason: misfitReason(safeTx, loosened, template, registry, check) };
  }
  return {
    kind: 'fit',
    hash,
    safe,
    paths: inspection.leaves.map((leaf) => `${leaf.callPath}.${leaf.arg}`),
    types: inspection.leaves.map((leaf) => leaf.type),
    values: inspection.leaves.map((leaf) => leafValue(leaf, safeTx)),
  };
}
