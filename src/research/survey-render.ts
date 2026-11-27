import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { paramName, parseFunctionSignature, parseViewSignature } from '../decode/abi.ts';
import type { AbiFunction, AbiParam } from '../decode/abi.ts';
import { decodeCall, decodeValues, wholeRegion } from '../decode/codec.ts';
import type { AbiValue } from '../decode/codec.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { addressLike, shortSearch } from './survey.ts';
import type { QueryRun, SafeCall, SafeTxCalls, Survey } from './survey.ts';

/** The functions a contract's proven ABI holds, or why none was proven. */
export type Functions = { readonly kind: 'proven'; readonly bySelector: ReadonlyMap<string, AbiFunction> } | { readonly kind: 'unproven'; readonly why: string };

const ERC20 = new Map(['approve(address spender, uint256 value)', 'transfer(address to, uint256 value)', 'transferFrom(address from, address to, uint256 value)'].map((s) => [parseFunctionSignature(s).selector as string, parseFunctionSignature(s)]));

/** Layouts tried on bytes that are no known call: a command list beside its inputs, and a list of inputs. */
const LAYOUTS = ['f() returns (bytes commands, bytes[] inputs)', 'f() returns (bytes[] inputs)'].map((s) => parseViewSignature(s).returns);

const MAX_SHAPES = 12;
const MAX_CALLS = 8;
const MAX_FIELDS = 30;
/** Of a group of one transaction, which its example hash shows whole. */
const MAX_FIELDS_ONE = 12;
const MAX_WORDS = 16;
const MAX_ITEMS = 16;
/** Items of an array of words, such as a proof, whose values say nothing one by one. */
const MAX_WORD_ITEMS = 2;
const MAX_TEXT = 42;
const MAX_DEPTH = 6;
const EXAMPLES = 3;

type Names = { readonly registry: Registry; readonly abis: ReadonlyMap<Address, Functions>; readonly target: ReadonlySet<Address> };
type Field = { readonly path: string; readonly text: string; readonly shape: boolean };

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
const selector = (data: Hex): string => data.slice(0, 10);
const nameOf = (address: Address, { registry }: Names): string => registry.byAddress.get(address)?.name ?? checksumAddress(address);

/** A function by its selector alone, from any proven ABI: what a selector names does not depend on the contract. */
const functionBy = (data: Hex, names: Pick<Names, 'abis'>): AbiFunction | undefined =>
  [...names.abis.values()].flatMap((abi) => (abi.kind === 'proven' ? [abi.bySelector.get(selector(data))] : [])).find((fn) => fn !== undefined) ?? ERC20.get(selector(data));

function callName(tx: SafeTxCalls, call: SafeCall, names: Names): string {
  const named = call.to === tx.safe ? 'the Safe itself' : names.target.has(call.to) || names.registry.byAddress.has(call.to) ? nameOf(call.to, names) : 'another contract';
  const fn = functionBy(call.data, names);
  const what = call.data.length === 2 ? 'no data' : (fn?.signature ?? selector(call.data));
  return `${call.operation === 1 ? 'delegatecall ' : ''}${named} ${what}${call.value > 0n ? ' with ETH' : ''}`;
}

/** Consecutive equal calls shown once with a count, so batches of different sizes group alike only when their calls do. */
const callList = (tx: SafeTxCalls, names: Names): string => {
  const runs: { text: string; n: number }[] = [];
  for (const call of tx.calls) {
    const text = callName(tx, call, names);
    const last = runs.at(-1);
    if (last?.text === text) last.n++;
    else runs.push({ text, n: 1 });
  }
  return `${{ direct: '', batch: 'MultiSend: ', raw: 'not unwrapped: ' }[tx.wrapped]}${runs.map(({ text, n }) => (n === 1 ? text : `${n}x ${text}`)).join(', then ')}`;
};

function groups<T>(items: readonly T[], key: (item: T) => string): [string, T[]][] {
  const by = new Map<string, T[]>();
  for (const item of items) by.set(key(item), [...(by.get(key(item)) ?? []), item]);
  return [...by].sort(([a, x], [b, y]) => y.length - x.length || (a < b ? -1 : 1));
}

function bytesFields(path: string, value: Uint8Array, names: Names, depth: number): Field[] {
  const hex = bytesToHex(value);
  if (value.length < 32) return [{ path, text: `0x${hex}`, shape: true }];
  if (depth < MAX_DEPTH) {
    const data = `0x${hex}` as Hex;
    const known = functionBy(data, names);
    const call = known === undefined ? undefined : decodeCall(known, wholeRegion(value));
    if (known !== undefined && call?.kind === 'decoded') return [{ path, text: `call ${known.signature}`, shape: true }, ...paramFields(`${path}.`, known.params, call.args, names, depth + 1)];
    for (const layout of LAYOUTS) {
      const values = decodeValues(layout.map((p) => p.type), value);
      if (values !== undefined) return paramFields(`${path}~`, layout, values, names, depth + 1);
    }
  }
  if (value.length % 32 !== 0) return [{ path, text: `${value.length} bytes`, shape: false }];
  const words = hex.match(/.{64}/g) ?? [];
  return [
    { path, text: `${plural(words.length, 'word')} of no known type`, shape: false },
    ...words.slice(0, MAX_WORDS).map((word, i) => ({ path: `${path}.word${i}`, text: wordText(word, names), shape: false })),
  ];
}

function wordText(word: string, names: Names): string {
  if (addressLike(word)) return nameOf(`0x${word.slice(24)}` as Address, names);
  const n = BigInt(`0x${word}`);
  return n < 1n << 128n ? String(n) : `0x${word}`;
}

function valueFields(path: string, value: AbiValue, param: AbiParam | undefined, names: Names, depth: number): Field[] {
  switch (value.kind) {
    case 'uint':
    case 'int':
    case 'bool':
    case 'fixed-bytes':
      return [{ path, text: String(value.value), shape: false }];
    case 'address':
      return [{ path, text: nameOf(value.value, names), shape: false }];
    case 'string':
      return [{ path, text: JSON.stringify(new TextDecoder().decode(value.value).slice(0, 60)), shape: false }];
    case 'bytes':
      return bytesFields(path, value.value, names, depth);
    case 'array': {
      const item = param?.type.kind === 'array' || param?.type.kind === 'fixed-array' ? { name: undefined, type: param.type.item } : undefined;
      return [{ path, text: plural(value.items.length, 'item'), shape: true }, ...value.items.slice(0, item?.type.kind === 'fixed-bytes' ? MAX_WORD_ITEMS : MAX_ITEMS).flatMap((v, i) => valueFields(`${path}[${i}]`, v, item, names, depth))];
    }
    case 'tuple': {
      const components = param?.type.kind === 'tuple' ? param.type.components : [];
      return value.fields.flatMap((field, i) => valueFields(`${path}.${components[i] === undefined ? i : paramName(components[i], i)}`, field, components[i], names, depth));
    }
  }
}

const paramFields = (prefix: string, params: readonly AbiParam[], args: readonly AbiValue[], names: Names, depth: number): Field[] =>
  args.flatMap((arg, i) => valueFields(`${prefix}${paramName(params[i] as AbiParam, i)}`, arg, params[i], names, depth));

function callFields(call: SafeCall, safe: Address, names: Names): Field[] {
  const fn = functionBy(call.data, names);
  const bytes = hexToBytes(call.data.slice(2));
  const value: Field[] = call.value > 0n ? [{ path: 'ETH value', text: String(call.value), shape: false }] : [];
  const decoded = fn === undefined ? undefined : decodeCall(fn, wholeRegion(bytes), { trailerMaxBytes: 64 });
  const fields =
    fn !== undefined && decoded?.kind === 'decoded'
      ? [...paramFields('', fn.params, decoded.args, names, 0), ...(decoded.trailer === undefined ? [] : [{ path: 'bytes after the arguments', text: `0x${bytesToHex(decoded.trailer.value)}`, shape: false }])]
      : bytes.length <= 4 ? []
      : bytesFields(fn === undefined ? 'arguments' : 'arguments that do not decode', bytes.subarray(4), names, 0);
  const self = checksumAddress(safe);
  return [...value, ...fields.map((field) => (field.text === self ? { ...field, text: 'the Safe itself' } : field))];
}

function fieldLines(calls: readonly Field[][]): string[] {
  const max = calls.length === 1 ? MAX_FIELDS_ONE : MAX_FIELDS;
  const paths = [...new Set(calls.flatMap((fields) => fields.map((f) => f.path)))];
  const lines = paths.slice(0, max).map((path) => {
    const texts = calls.flatMap((fields) => fields.filter((f) => f.path === path).map((f) => f.text));
    const counts = groups(texts, (t) => t);
    const numbers = texts.every((t) => /^-?\d+$/.test(t)) ? texts.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : undefined;
    if (counts.length > 4 && texts.some((t) => t.length > MAX_TEXT)) return `      ${path}: ${counts.length} different values, the most common in ${counts[0]?.[1].length} of ${texts.length} (${counts[0]?.[0].slice(0, MAX_TEXT)})`;
    const spread = counts.length > 4 && numbers !== undefined ? `, from ${numbers[0]} to ${numbers.at(-1)}` : '';
    const top = counts.slice(0, 4).map(([text, all]) => (counts.length === 1 && all.length === calls.length ? text : `${text} (${all.length})`));
    return `      ${path}: ${top.join(', ')}${counts.length > 4 ? `, ${counts.length} different values${spread}` : ''}`;
  });
  return paths.length > max ? [...lines, `      and ${paths.length - max} more`] : lines;
}

const spread = <T extends { readonly tx: SafeTxCalls }>(items: readonly T[]): string => {
  const txs = [...new Set(items.map((i) => i.tx))];
  return `${plural(txs.length, 'transaction')}, ${plural(new Set(txs.map((t) => t.safe)).size, 'Safe')}`;
};
const examples = (items: readonly { readonly tx: SafeTxCalls }[]): string => [...new Set(items.map((i) => i.tx.hash))].slice(-EXAMPLES).reverse().join(' ');

/** The call of a transaction that reaches the target: one to it, or that names it in its data; when none does, every call, since the target is reached inside one. */
export function reaching(tx: SafeTxCalls, target: ReadonlySet<Address>): readonly SafeCall[] {
  if (target.size === 0) {
    const own = tx.calls.filter((call) => call.to === tx.safe);
    return own.length > 0 ? own : tx.calls;
  }
  const direct = tx.calls.filter((call) => target.has(call.to) || [...target].some((t) => call.data.includes(t.slice(2))));
  return direct.length > 0 ? direct : tx.calls;
}

export const targetOf = ({ target }: Survey): ReadonlySet<Address> => new Set(target.kind === 'contracts' ? target.contracts.map((c) => c.address) : target.contracts);

/** One contract of each kind of call whose function has no known name, the most used first: a Safe standing for every Safe's own functions. */
export function unnamedTargets(survey: Survey, names: Pick<Names, 'abis' | 'registry'>): Address[] {
  const unnamed = survey.txs.flatMap((tx) => tx.calls.filter((c) => c.data.length >= 10 && functionBy(c.data, names) === undefined).map((c) => ({ key: c.to === tx.safe ? 'a Safe' : c.to, to: c.to, tx: tx.hash })));
  return groups(unnamed, (u) => u.key).filter(([, uses]) => new Set(uses.map((u) => u.tx)).size > 1 || unnamed.length < 5).map(([, uses]) => (uses[0] as { to: Address }).to);
}

const runLine = (run: QueryRun, range: Survey['range']): string => {
  const read = run.fromBlock === undefined ? 'nothing read' : `${plural(run.logs, 'log')} in blocks ${run.fromBlock} to ${range.toBlock}`;
  return `  ${run.label}: ${read}, ${plural(run.pages, 'page')}${run.stopped === undefined ? '' : `; NOT older, stopped by ${run.stopped}`}`;
};

export function renderSurvey(survey: Survey, names: Pick<Names, 'abis' | 'registry'>): string {
  const all: Names = { ...names, target: targetOf(survey) };
  const { txs, range } = survey;
  const items = txs.map((tx) => ({ tx }));
  const calls = txs.flatMap((tx) => [...reaching(tx, all.target)].map((call) => ({ tx, call, fields: callFields(call, tx.safe, all) })));
  const byName = groups(calls, ({ tx, call, fields }) => `${callName(tx, call, all)}\n${fields.filter((f) => f.shape).map((f) => `${f.path}: ${f.text}`).join('; ')}`);
  const shapes = groups(items, ({ tx }) => callList(tx, all));
  const others = groups(txs.flatMap((tx) => tx.calls.filter((c) => callName(tx, c, all).includes('another contract')).map((c) => ({ tx, call: c }))), ({ call }) => call.to);
  const lines = [
    'ORIENTATION ONLY: this output is never recorded and no report, card or verdict reads it. Study the operation with pnpm past-txs before you rely on it.',
    '',
    `Searched blocks ${range.fromBlock} to ${range.toBlock}, newest first:`,
    ...survey.queries.map((run) => runLine(run, range)),
    runLine(survey.executions, range),
    ...[shortSearch(survey.target, survey.queries, range) ?? []].flat(),
    `Found ${plural(survey.found, 'transaction')}; ${survey.marked} with a Safe among the addresses logged, or a Safe's ExecutionSuccess; read ${survey.read}${survey.read < survey.marked ? ', spread evenly over the blocks' : ''}.`,
    `${plural(txs.length, 'executed Safe transaction')} of ${plural(new Set(txs.map((t) => t.safe)).size, 'Safe')}.`,
    '',
    'Whole transactions, the Safe\'s calls in order:',
    ...shapes.slice(0, MAX_SHAPES).map(([text, group]) => `  ${spread(group)}: ${text}\n    e.g. ${examples(group)}`),
    ...(shapes.length > MAX_SHAPES ? [`  and ${plural(shapes.length - MAX_SHAPES, 'more shape')}, ${plural(shapes.slice(MAX_SHAPES).flatMap(([, g]) => g).length, 'transaction')}`] : []),
    ...(others.length === 0 ? [] : [`  "another contract" is ${others.slice(0, 10).map(([to, group]) => `${checksumAddress(to as Address)} (${spread(group)})`).join(', ')}${others.length > 10 ? `, and ${others.length - 10} more` : ''}`]),
    '',
    all.target.size === 0 ? 'Calls of the Safe to itself, or every call when it makes none, by function and argument shape:' : 'Calls to the contract, or naming it, or every call of a transaction that only reaches it inside one, by function and argument shape:',
    ...byName.slice(0, MAX_CALLS).flatMap(([key, group]) => [`  ${spread(group)}: ${key.split('\n')[0]}`, `    e.g. ${examples(group)}`, ...fieldLines(group.map((g) => g.fields))]),
    ...byName.slice(MAX_CALLS).map(([key, group]) => `  ${spread(group)}: ${key.replace(/\n$/, '').replace('\n', ', ').slice(0, 400)}\n    e.g. ${examples(group)}`).slice(0, 2 * MAX_CALLS),
    ...(byName.length > 3 * MAX_CALLS ? [`  and ${plural(byName.length - 3 * MAX_CALLS, 'more group')}`] : []),
    '',
    ...[...all.abis].map(([address, abi]) => `ABI of ${nameOf(address, all)}: ${abi.kind === 'proven' ? `proven, ${plural(abi.bySelector.size, 'function')}` : `not proven, so its functions print as selectors: ${abi.why}`}`),
    '',
    'Not reached:',
    '  a transaction older than a query\'s blocks above, and one none of these logs marks, such as a call that logs nothing naming the contract;',
    `  ExecutionSuccess marks only blocks from ${survey.executions.fromBlock ?? 'none'}; before them a transaction counts only where a Safe is an address its matched log holds;`,
    ...(survey.parties.unreadable > 0 ? [`  ${plural(survey.parties.unreadable, 'address')} of ${survey.parties.checked} the Safe check could not read;`] : []),
    ...(survey.marked > survey.read ? [`  ${survey.marked - survey.read} marked transactions past the cap on reading;`] : []),
    ...groups([...survey.leftOut].flatMap(([why, hashes]) => hashes.map((hash) => ({ why, hash }))), (o) => o.why).slice(0, 12).map(([why, out]) => `  ${plural(out.length, 'transaction')}: ${why}, e.g. ${out[0]?.hash}`),
    '  calls inside the called contracts: only the Safe\'s own calls and their decoded arguments are read, no trace. "~" marks bytes decoded by a guessed layout, "words" by none.',
    'ORIENTATION ONLY: transactions as Etherscan\'s logs list them; one they left out is not shown, so no call here proves none happened.',
  ];
  return `${lines.join('\n')}\n`;
}
