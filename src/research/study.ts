import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { Transaction } from '../chain/types.ts';
import { safeProxyFactory } from '../contracts/proxy.ts';
import { parseFunctionSignature } from '../decode/abi.ts';
import type { AbiType } from '../decode/abi.ts';
import { decodeCall, wholeRegion } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import type { Registry } from '../registry.ts';
import { OFFICIAL_SAFE_SINGLETONS } from '../safe/deployments.ts';
import { EXECUTION_SUCCESS } from '../simulate/events.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { inspectTemplateFields } from '../template/check.ts';
import type { Leaf } from '../template/check.ts';
import type { CallNode, ConstValue, LeafRule, Rule, Template, TemplateCall } from '../template/template.ts';


/**
 * The template with every leaf set free, so only its shape is checked (calls, selectors, canonical encoding, trailers),
 * and the original leaf rules in the order the check visits them, so each leaf the check reports pairs with its rule.
 */
export type Loosened = { readonly shape: Template; readonly anyTrailer: Template; readonly rules: readonly LeafRule[] };

const MAX_TRAILER = 32;
const ZERO = `0x${'00'.repeat(20)}` as Address;

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
        return { kind: 'free', reason: 'study', claim: 'scalar' };
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
    return { to, value, data: call.data === 'empty' ? 'empty' : looseCall(call.data, wideTrailer, record), merge: call.merge };
  };
  // An execTransaction call does not carry the Safe's nonce, so a study never checks it.
  const shape = { ...template, nonce: undefined, calls: template.calls.map((call) => looseTop(call, false, true)) };
  const anyTrailer = { ...template, nonce: undefined, calls: template.calls.map((call) => looseTop(call, true, false)) };
  return { shape, anyTrailer, rules };
}

export type NotStudiedReason = 'execTransaction calldata does not decode' | 'no ExecutionSuccess from the Safe' | 'calls no function the template calls';

export type UnprovenReason = 'its code is not a known Safe proxy' | 'its singleton is not an official Safe singleton';

/**
 * Who made the template's calls: a proven Safe making all of them in one transaction, or an EOA making the template's
 * call number `call` as its own transaction.
 */
export type Sender = { readonly kind: 'safe'; readonly address: Address } | { readonly kind: 'eoa'; readonly address: Address; readonly call: number };

export type TxStudy =
  | { readonly kind: 'excluded' }
  | { readonly kind: 'unreadable'; readonly hash: Hex; readonly reason: string }
  | { readonly kind: 'not-studied'; readonly hash: Hex; readonly why: NotStudiedReason; readonly selector: string }
  | { readonly kind: 'unproven'; readonly hash: Hex; readonly contract: Address; readonly why: UnprovenReason }
  | { readonly kind: 'misfit'; readonly hash: Hex; readonly sender: Sender; readonly reason: string }
  /** `values` pairs with the rules of the sender's `Shape`; `paths` names each leaf. */
  | { readonly kind: 'fit'; readonly hash: Hex; readonly sender: Sender; readonly paths: readonly string[]; readonly types: readonly AbiType[]; readonly values: readonly string[] };

const EXEC_TRANSACTION = parseFunctionSignature(
  'execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)',
);

const EMPTY_SAFE_TX: SafeTx = {
  chainId: 1n,
  safe: ZERO,
  version: '1.4.1',
  to: ZERO,
  value: 0n,
  data: '0x' as Hex,
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: ZERO,
  refundReceiver: ZERO,
  nonce: 0n,
};

function safeTxOf(safe: Address, input: Hex): SafeTx | undefined {
  const call = decodeCall(EXEC_TRANSACTION, wholeRegion(hexToBytes(input.slice(2))));
  if (call.kind !== 'decoded') return undefined;
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver] = call.args.map((arg) =>
    arg.kind === 'bytes' ? (`0x${bytesToHex(arg.value)}` as Hex) : 'value' in arg ? arg.value : undefined,
  );
  if (operation !== 0n && operation !== 1n) return undefined;
  return {
    ...EMPTY_SAFE_TX,
    safe,
    to: to as Address,
    value: value as bigint,
    data: data as Hex,
    operation: operation === 0n ? 0 : 1,
    safeTxGas: safeTxGas as bigint,
    baseGas: baseGas as bigint,
    gasPrice: gasPrice as bigint,
    gasToken: gasToken as Address,
    refundReceiver: refundReceiver as Address,
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
  const visitCall = (node: CallNode): void => {
    names.set(node.fn.selector, node.fn.name);
    node.args.forEach(visitRule);
  };
  for (const call of template.calls) if (call.data !== 'empty') visitCall(call.data);
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
      const data = template.calls[i]?.data;
      if (data === 'empty') return call.data.end === call.data.start;
      return data !== undefined && call.data.end - call.data.start >= 4 && bytesToHex(call.data.root.subarray(call.data.start, call.data.start + 4)) === data.fn.selector.slice(2);
    });
  if (!sameCalls) return `calls ${shapeOf.join(', ')}`;
  const wide = check(loosened.anyTrailer).check;
  const strict = check(loosened.shape).check;
  const first = strict.kind === 'mismatch' ? strict.findings[0] : undefined;
  if (wide.kind === 'match') return `more bytes after the arguments than the template allows, at ${first?.callPath ?? 'a call'}`;
  if (first === undefined) return 'does not fit';
  return `${first.callPath}.${first.arg}: expected ${first.expected}, got ${first.actual}`;
}

export type Shape = { readonly template: Template; readonly loosened: Loosened };

export function shapesOf(template: Template): { readonly whole: Shape; readonly calls: readonly Shape[] } {
  const shape = (t: Template): Shape => ({ template: t, loosened: loosen(t) });
  return { whole: shape(template), calls: template.calls.map((call) => shape({ ...template, calls: [call] })) };
}

export type StudyContext = {
  readonly shapes: ReturnType<typeof shapesOf>;
  readonly registry: Registry;
  /** The configured Safe, left out of every result. */
  readonly exclude: Address | undefined;
};

type Proof = { readonly kind: 'proven' } | { readonly kind: 'unproven'; readonly why: UnprovenReason } | { readonly kind: 'unreadable'; readonly reason: string };

async function proveSafe(reader: Reader, address: Address, blockNumber: bigint): Promise<Proof> {
  const block = await reader.block(blockNumber - 1n);
  if (block.kind === 'unverifiable') return { kind: 'unreadable', reason: block.reason };
  const code = await reader.getCode(address, block.value);
  if (code.kind === 'unverifiable') return { kind: 'unreadable', reason: code.reason };
  if (safeProxyFactory(code.value) === undefined) return { kind: 'unproven', why: 'its code is not a known Safe proxy' };
  const slot = await reader.getStorageAt(address, 0n, block.value);
  if (slot.kind === 'unverifiable') return { kind: 'unreadable', reason: slot.reason };
  const official = OFFICIAL_SAFE_SINGLETONS.some((s) => slot.value === `0x${'00'.repeat(12)}${s.address.slice(2)}`);
  return official ? { kind: 'proven' } : { kind: 'unproven', why: 'its singleton is not an official Safe singleton' };
}

function judge(hash: Hex, tx: SafeTx, sender: Sender, shape: Shape, registry: Registry): TxStudy {
  const { template, loosened } = shape;
  const check = (t: Template) =>
    inspectTemplateFields(tx, { safe: sender.address, operations: [{ template: template.id, values: new Map() }] }, new Map([[template.id, t]]), registry);
  const inspection = check(loosened.shape);
  if (inspection.check.kind !== 'match' || inspection.leaves.length !== loosened.rules.length) {
    return { kind: 'misfit', hash, sender, reason: misfitReason(tx, loosened, template, registry, check) };
  }
  return {
    kind: 'fit',
    hash,
    sender,
    paths: inspection.leaves.map((leaf) => `${leaf.callPath}.${leaf.arg}`),
    types: inspection.leaves.map((leaf) => leaf.type),
    values: inspection.leaves.map((leaf) => leafValue(leaf, tx)),
  };
}

async function studySafeTx(reader: Reader, tx: Transaction & { readonly to: Address; readonly blockNumber: bigint }, context: StudyContext): Promise<TxStudy> {
  const { hash } = tx;
  const proof = await proveSafe(reader, tx.to, tx.blockNumber);
  if (proof.kind === 'unreadable') return { kind: 'unreadable', hash, reason: proof.reason };
  if (proof.kind === 'unproven') return { kind: 'unproven', hash, contract: tx.to, why: proof.why };
  const selector = tx.input.slice(0, 10);
  const safeTx = safeTxOf(tx.to, tx.input);
  if (safeTx === undefined) return { kind: 'not-studied', hash, why: 'execTransaction calldata does not decode', selector };
  const receiptRead = await reader.getTransactionReceipt(hash);
  if (receiptRead.kind === 'unverifiable') return { kind: 'unreadable', hash, reason: receiptRead.reason };
  const receipt = receiptRead.value;
  if (receipt === null || !receipt.logs.some((log) => log.address === tx.to && log.topics[0] === EXECUTION_SUCCESS)) {
    return { kind: 'not-studied', hash, why: 'no ExecutionSuccess from the Safe', selector };
  }
  return judge(hash, safeTx, { kind: 'safe', address: tx.to }, context.shapes.whole, context.registry);
}

function studyDirectCall(tx: Transaction & { readonly to: Address }, context: StudyContext): TxStudy {
  const selector = tx.input.length >= 10 ? tx.input.slice(0, 10) : 'no data';
  const candidates = context.shapes.calls.flatMap((shape, call) => {
    const templateCall = shape.template.calls[0];
    const data = templateCall?.data;
    const same = data === 'empty' ? tx.input.length === 2 : data !== undefined && selector === data.fn.selector;
    // A named contract pins the call's target, so the same selector on another contract is another function.
    const target = templateCall?.to.kind !== 'contract' || context.registry.entries.get(templateCall.to.name)?.address === tx.to;
    return same && target ? [{ shape, call }] : [];
  });
  if (candidates.length === 0) return { kind: 'not-studied', hash: tx.hash, why: 'calls no function the template calls', selector };
  const direct: SafeTx = { ...EMPTY_SAFE_TX, safe: tx.from, to: tx.to, value: tx.value, data: tx.input };
  const studies = candidates.map(({ shape, call }) => judge(tx.hash, direct, { kind: 'eoa', address: tx.from, call }, shape, context.registry));
  return studies.find((study) => study.kind === 'fit') ?? (studies[0] as TxStudy);
}

export async function studyTx(reader: Reader, hash: Hex, context: StudyContext): Promise<TxStudy> {
  const read = await reader.getTransaction(hash);
  if (read.kind === 'unverifiable') return { kind: 'unreadable', hash, reason: read.reason };
  const tx = read.value;
  if (tx === null) return { kind: 'unreadable', hash, reason: 'neither provider knows the transaction' };
  if (context.exclude !== undefined && (tx.to === context.exclude || tx.from === context.exclude)) return { kind: 'excluded' };
  const { to, blockNumber } = tx;
  if (to === null) return { kind: 'not-studied', hash, why: 'calls no function the template calls', selector: 'contract creation' };
  if (blockNumber === null) return { kind: 'unreadable', hash, reason: 'the transaction is pending' };
  if (tx.input.startsWith(EXEC_TRANSACTION.selector)) return studySafeTx(reader, { ...tx, to, blockNumber }, context);
  return studyDirectCall({ ...tx, to }, context);
}
