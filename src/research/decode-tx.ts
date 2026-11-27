import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { paramName } from '../decode/abi.ts';
import type { AbiFunction, AbiType } from '../decode/abi.ts';
import { decodeCall, wholeRegion } from '../decode/codec.ts';
import type { AbiValue, DecodeFailure, DecodedCall, Region } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import type { InnerCall } from '../decode/multisend.ts';
import type { EventLog } from '../chain/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { decodeTemplateCall } from '../template/check.ts';
import type { PackedPart, Rule, Template } from '../template/template.ts';
import { EXEC_TRANSACTION, safeExecutionLine } from './safe-nonce.ts';
import { plain, quoted } from './shown.ts';

/** The functions of an address's proven ABI and where the proof came from, or why there is none. */
export type CallAbi =
  | { readonly kind: 'proven'; readonly functions: ReadonlyMap<Hex, AbiFunction>; readonly from: string }
  | { readonly kind: 'none'; readonly why: string };

export type DecodeTxDeps = {
  readonly abiOf: (address: Address) => Promise<CallAbi>;
  readonly nameOf: (address: Address) => string | undefined;
  /** Every byte of each `bytes` value, rather than the first `SHOWN_BYTES`. */
  readonly full?: boolean;
  /** A template whose `call`, `encoded` and `packed` rules say how to decode the `bytes` inside its calls' arguments. */
  readonly template?: Template;
};

/** An executed transaction and, once it has run, the logs of its receipt, which hold a Safe's ExecutionSuccess. */
export type ExecutedTx = { readonly hash: Hex; readonly blockNumber: bigint | null; readonly from: Address; readonly to: Address | null; readonly value: bigint; readonly input: Hex; readonly logs?: readonly EventLog[] };

export { EXEC_TRANSACTION };

/** The most bytes of one `bytes` value printed in full; the rest is counted. */
const SHOWN_BYTES = 256;
/** The most characters of one string printed in full. */
const SHOWN_CHARACTERS = 400;
const INDENT = '  ';

/** How one call's values print: names from the registry, every byte or the first `SHOWN_BYTES`, and the proven functions of the contract called. */
type Shown = {
  readonly names: DecodeTxDeps['nameOf'];
  readonly full: boolean;
  readonly own: ReadonlyMap<Hex, AbiFunction>;
  /** Whether the template's rules apply to this call by its target and position (`decoded as`), or only fit it by its function (`fits`). */
  readonly matched: boolean;
};

const hex = (bytes: Uint8Array, full: boolean): string =>
  full || bytes.length <= SHOWN_BYTES
    ? `0x${bytesToHex(bytes)}`
    : `0x${bytesToHex(bytes.subarray(0, SHOWN_BYTES))}… (SHORTENED: ${bytes.length} bytes, the first ${SHOWN_BYTES} shown; --full prints every byte)`;

function failure(failed: DecodeFailure): string {
  switch (failed.kind) {
    case 'malformed':
      return `malformed at byte ${failed.at}: ${failed.problem}`;
    case 'non-canonical':
      return `not the canonical encoding, first differing at byte ${failed.at}`;
    case 'wrong-selector':
      return `selector ${failed.actual}, not ${failed.expected}`;
  }
}

type Out = string[];

function packedPart(part: PackedPart, bytes: Uint8Array): string {
  const word = BigInt(`0x${bytesToHex(bytes)}`);
  switch (part.type.kind) {
    case 'uint':
      return String(word);
    case 'int':
      return String(BigInt.asIntN(part.type.bits, word));
    case 'bool':
      return String(word !== 0n);
    default:
      return `0x${bytesToHex(bytes)}`;
  }
}

/** `decoded`'s arguments, each with its rule from `rules` when given. */
function args(out: Out, depth: number, decoded: DecodedCall, rules: readonly Rule[] | undefined, shown: Shown): void {
  decoded.args.forEach((arg, i) => {
    const param = decoded.fn.params[i];
    if (param !== undefined) value(out, depth, paramName(param, i), param.type, arg, rules?.[i], shown);
  });
}

/** `bytes` the template's rule describes: a call or encoded parameters (`call`), or packed parts; false when it describes none. */
function templateBytes(out: Out, depth: number, label: string, bytes: Uint8Array, rule: Rule | undefined, shown: Shown): boolean {
  const pad = INDENT.repeat(depth);
  if (rule?.kind === 'call') {
    const node = rule.call;
    const decoded = decodeTemplateCall(node, wholeRegion(bytes));
    const as = node.encoding === 'params' ? `the template's encoded parameters ${node.fn.signature}` : `the template's call ${node.fn.signature}`;
    if (decoded.kind !== 'decoded') {
      out.push(`${pad}${label}: ${bytes.length} bytes, which do not decode as ${as}: ${failure(decoded)}: ${hex(bytes, shown.full)}`);
      return true;
    }
    out.push(`${pad}${label}: ${bytes.length} bytes, ${shown.matched ? 'decoded as' : 'fits'} ${as}`);
    args(out, depth + 1, decoded, node.args, shown);
    if (decoded.trailer !== undefined && decoded.trailer.value.length > 0) out.push(`${pad}${INDENT}trailer after the arguments: ${hex(decoded.trailer.value, shown.full)}`);
    return true;
  }
  if (rule?.kind === 'packed') {
    const size = rule.parts.reduce((sum, part) => sum + part.size, 0);
    if (bytes.length !== size) {
      out.push(`${pad}${label}: ${bytes.length} bytes, not the ${size} of the template's packed parts: ${hex(bytes, shown.full)}`);
      return true;
    }
    out.push(`${pad}${label}: ${bytes.length} bytes, ${shown.matched ? 'decoded as' : 'fits'} the template's packed parts`);
    let at = 0;
    for (const part of rule.parts) {
      out.push(`${pad}${INDENT}${part.name}: ${packedPart(part, bytes.subarray(at, at + part.size))}`);
      at += part.size;
    }
    return true;
  }
  return false;
}

/** `bytes` that decode as a call of the called contract's own proven ABI, such as each call a multicall makes to itself. */
function ownCall(out: Out, depth: number, label: string, bytes: Uint8Array, shown: Shown): boolean {
  const fn = bytes.length < 4 ? undefined : shown.own.get(`0x${bytesToHex(bytes.subarray(0, 4))}` as Hex);
  const decoded = fn === undefined ? undefined : decodeCall(fn, wholeRegion(bytes));
  if (decoded?.kind !== 'decoded') return false;
  out.push(`${INDENT.repeat(depth)}${label}: ${bytes.length} bytes, decodes as ${decoded.fn.signature} (${decoded.fn.selector}) of the called contract's proven ABI, a guess: nothing declares these bytes a call`);
  args(out, depth + 1, decoded, undefined, shown);
  return true;
}

function value(out: Out, depth: number, label: string, type: AbiType, decoded: AbiValue, rule: Rule | undefined, shown: Shown): void {
  const pad = INDENT.repeat(depth);
  switch (decoded.kind) {
    case 'address': {
      const name = shown.names(decoded.value);
      out.push(`${pad}${label}: ${decoded.value}${name === undefined ? '' : ` (registry: ${name})`}`);
      return;
    }
    case 'uint':
    case 'int':
    case 'bool':
    case 'fixed-bytes':
      out.push(`${pad}${label}: ${String(decoded.value)}`);
      return;
    case 'string': {
      const characters = [...new TextDecoder().decode(decoded.value)];
      if (shown.full) {
        out.push(`${pad}${label}: ${JSON.stringify(plain(characters.join('')))}`);
        return;
      }
      const cut = characters.length > SHOWN_CHARACTERS;
      out.push(`${pad}${label}: ${quoted(characters.slice(0, SHOWN_CHARACTERS).join(''), Infinity)}${cut ? ` (SHORTENED: ${characters.length} characters, the first ${SHOWN_CHARACTERS} shown; --full prints every one, control characters escaped)` : ''}`);
      return;
    }
    case 'bytes':
      if (!templateBytes(out, depth, label, decoded.value, rule, shown) && !ownCall(out, depth, label, decoded.value, shown)) out.push(`${pad}${label}: ${hex(decoded.value, shown.full)}`);
      return;
    case 'array': {
      const item = type.kind === 'array' || type.kind === 'fixed-array' ? type.item : type;
      const ruled = rule?.kind === 'items' && rule.items.length !== decoded.items.length ? `; the template's rule has ${rule.items.length}, applied by position` : '';
      out.push(`${pad}${label}: ${decoded.items.length} items${ruled}`);
      decoded.items.forEach((child, i) => value(out, depth + 1, `[${i}]`, item, child, rule?.kind === 'items' ? rule.items[i] : undefined, shown));
      return;
    }
    case 'tuple': {
      out.push(`${pad}${label}:`);
      const components = type.kind === 'tuple' ? type.components : [];
      decoded.fields.forEach((child, i) => {
        const component = components[i];
        value(out, depth + 1, component === undefined ? String(i) : paramName(component, i), component?.type ?? type, child, rule?.kind === 'fields' ? rule.fields[i] : undefined, shown);
      });
      return;
    }
  }
}

function rawWords(out: Out, depth: number, data: Uint8Array): void {
  const pad = INDENT.repeat(depth);
  const args = data.subarray(4);
  for (let at = 0; at < args.length; at += 32) out.push(`${pad}word ${at / 32}: 0x${bytesToHex(args.subarray(at, at + 32))}`);
}

/** One call's selector, decoded with `fn` when given; a decode that fails prints why and the raw words. */
function call(out: Out, depth: number, fn: AbiFunction | undefined, region: Region, shown: Shown, whyRaw: string, rules?: readonly Rule[]): void {
  const pad = INDENT.repeat(depth);
  const data = region.root.subarray(region.start, region.end);
  if (data.length === 0) {
    out.push(`${pad}no data: a plain ETH transfer or the receive function`);
    return;
  }
  if (data.length < 4) {
    out.push(`${pad}${data.length} bytes, too short for a selector: ${hex(data, shown.full)}`);
    return;
  }
  const selector = `0x${bytesToHex(data.subarray(0, 4))}`;
  if (fn === undefined) {
    out.push(`${pad}selector ${selector}, not decoded: ${whyRaw}`);
    rawWords(out, depth + 1, data);
    return;
  }
  const decoded = decodeCall(fn, region, { trailerMaxBytes: data.length });
  if (decoded.kind !== 'decoded') {
    out.push(`${pad}${fn.signature} (${selector}) does not decode: ${failure(decoded)}`);
    rawWords(out, depth + 1, data);
    return;
  }
  out.push(`${pad}${fn.signature} (${selector})`);
  args(out, depth + 1, decoded, rules, shown);
  if (decoded.trailer !== undefined && decoded.trailer.value.length > 0) out.push(`${pad}${INDENT}trailer after the arguments: ${hex(decoded.trailer.value, shown.full)}`);
}

/**
 * The template's rules for a call to `to` with `selector`, the call's `position` among the Safe's: matched when the
 * template's call at that position has the function and names `to`'s registry entry (or no contract), else a fit, the
 * first of its calls with the function.
 */
function templateRules(deps: DecodeTxDeps, position: number, to: Address, selector: Hex): { readonly rules: readonly Rule[]; readonly matched: boolean; readonly what: string } | undefined {
  const template = deps.template;
  if (template === undefined) return undefined;
  const calls = template.calls.map((call, i) => ({ call, i })).filter(({ call }) => call.data !== 'empty' && call.data.fn.selector === selector);
  const names = (call: Template['calls'][number]) => call.to.kind !== 'contract' || deps.nameOf(to) === call.to.name;
  const at = calls.find(({ call, i }) => i === position && names(call));
  const fit = at ?? calls.find(({ call }) => names(call)) ?? calls[0];
  if (fit === undefined || fit.call.data === 'empty') return undefined;
  const what =
    at !== undefined ? `bytes inside decoded by ${template.id}'s call [${fit.i}], this call's target and position`
    : `bytes inside shown where they fit ${template.id}'s call [${fit.i}], the first with this function${names(fit.call) ? '' : ', to another contract'}; this call is at position [${position}]`;
  return { rules: fit.call.data.args, matched: at !== undefined, what };
}

async function target(out: Out, depth: number, position: number, to: Address, region: Region, deps: DecodeTxDeps): Promise<void> {
  const data = region.root.subarray(region.start, region.end);
  const plain: Shown = { names: deps.nameOf, full: deps.full === true, own: new Map(), matched: false };
  if (data.length < 4) return call(out, depth, undefined, region, plain, '');
  const abi = await deps.abiOf(to);
  const selector = `0x${bytesToHex(data.subarray(0, 4))}` as Hex;
  if (abi.kind === 'none') return call(out, depth, undefined, region, plain, abi.why);
  const fn = abi.functions.get(selector);
  const applied = templateRules(deps, position, to, selector);
  out.push(`${INDENT.repeat(depth)}ABI: ${abi.from}${applied === undefined ? '' : `; ${applied.what}`}`);
  call(out, depth, fn, region, { ...plain, own: abi.functions, matched: applied?.matched === true }, `the proven ABI has no function with this selector`, applied?.rules);
}

const named = (address: Address, names: DecodeTxDeps['nameOf']): string => {
  const name = names(address);
  return name === undefined ? address : `${address} (registry: ${name})`;
};

async function inner(out: Out, depth: number, calls: readonly InnerCall[], deps: DecodeTxDeps): Promise<void> {
  for (const [position, part] of calls.entries()) {
    out.push(`${INDENT.repeat(depth)}${part.path}: ${part.operation === 1 ? 'delegatecall' : 'call'} to ${named(part.to, deps.nameOf)}, value ${part.value} wei`);
    await target(out, depth + 1, position, part.to, part.data, deps);
  }
}

/**
 * An executed transaction as the template author reads it: a Safe `execTransaction` with its fields and the call the
 * Safe made, a MultiSend's parts, and each call decoded with the proven ABI of the address it goes to, or its selector
 * and raw words. Nothing here is a verdict.
 */
export async function renderDecodedTx(tx: ExecutedTx, deps: DecodeTxDeps): Promise<string> {
  const out: Out = [];
  out.push(`transaction ${tx.hash}, block ${tx.blockNumber ?? 'pending'}`);
  out.push(`from ${named(tx.from, deps.nameOf)}`);
  if (tx.to === null) {
    out.push('creates a contract; nothing to decode');
    return `${out.join('\n')}\n`;
  }
  out.push(`to ${named(tx.to, deps.nameOf)}, value ${tx.value} wei`);
  const data = hexToBytes(tx.input.slice(2));
  const region = wholeRegion(data);
  if (`0x${bytesToHex(data.subarray(0, 4))}` !== EXEC_TRANSACTION.selector) {
    await target(out, 0, 0, tx.to, region, deps);
    return `${out.join('\n')}\n`;
  }
  const exec = decodeCall(EXEC_TRANSACTION, region);
  if (exec.kind !== 'decoded') {
    out.push(`${EXEC_TRANSACTION.signature} (${EXEC_TRANSACTION.selector}) does not decode: ${failure(exec)}`);
    rawWords(out, 1, data);
    return `${out.join('\n')}\n`;
  }
  out.push(`Safe ${EXEC_TRANSACTION.signature} (${EXEC_TRANSACTION.selector}), decoded by the Safe's own signature; whether ${tx.to} is a Safe is not checked`);
  if (tx.logs !== undefined) out.push(safeExecutionLine(tx.to, tx.input, tx.logs));
  const [to, valueArg, inData, operation] = exec.args;
  exec.args.forEach((arg, i) => {
    const param = EXEC_TRANSACTION.params[i];
    if (param !== undefined && param.name !== 'data') value(out, 1, paramName(param, i), param.type, arg, undefined, { names: deps.nameOf, full: deps.full === true, own: new Map(), matched: false });
  });
  if (to?.kind !== 'address' || valueArg?.kind !== 'uint' || inData?.kind !== 'bytes' || operation?.kind !== 'uint') throw new Error('execTransaction decoded without its fields');
  if (operation.value !== 0n && operation.value !== 1n) {
    out.push(`${INDENT}operation ${operation.value} is neither a call nor a delegatecall; the inner call is not decoded`);
    return `${out.join('\n')}\n`;
  }
  const safeTx = { to: to.value, value: valueArg.value, data: `0x${bytesToHex(inData.value)}` as Hex, operation: Number(operation.value) as 0 | 1 };
  const unwrapped = unwrapSafeTx(safeTx);
  out.push('the call the Safe makes:');
  const innerRegion: Region = { root: data, start: inData.span[0], end: inData.span[1] };
  switch (unwrapped.kind) {
    case 'direct':
      await inner(out, 1, [{ ...unwrapped.calls[0], data: innerRegion }], deps);
      break;
    case 'multisend':
      out.push(`${INDENT}delegatecall to ${named(safeTx.to, deps.nameOf)}, Safe's ${unwrapped.deployment.contract} ${unwrapped.deployment.version}, multiSend(bytes) of ${unwrapped.calls.length} calls`);
      await inner(out, 2, unwrapped.calls, deps);
      break;
    case 'foreign-delegatecall':
      out.push(`${INDENT}delegatecall to ${named(safeTx.to, deps.nameOf)}, which is not one of Safe's official MultiSend deployments`);
      await target(out, 2, 0, safeTx.to, innerRegion, deps);
      break;
    case 'zero-to':
      out.push(`${INDENT}a MultiSend part whose to is zero, at byte ${unwrapped.at}; not decoded further`);
      break;
    default:
      out.push(`${INDENT}the MultiSend data does not decode: ${failure(unwrapped)}`);
  }
  return `${out.join('\n')}\n`;
}

/** One decoded value as decode-tx prints it, `depth` steps in, with every byte when `full`. */
export function valueLines(depth: number, label: string, type: AbiType, decoded: AbiValue, names: DecodeTxDeps['nameOf'], full: boolean): string[] {
  const out: Out = [];
  value(out, depth, label, type, decoded, undefined, { names, full, own: new Map(), matched: false });
  return out;
}
