import type { AbiType } from '../decode/abi.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { LeafRule, Rule, Template } from '../template/template.ts';
import { argumentTree } from './notes.ts';
import type { ArgNode } from './notes.ts';
import { spreadOf } from './past-txs-render.ts';
import type { Spread } from './past-txs-render.ts';
import type { Fit, Misfit, PastTxs } from './past-txs.ts';
import { appFills, isOtherOperation, isTime, shapesOf } from './study.ts';
import type { CallName, MisfitReason, Outside } from './study.ts';

export type Studied = Fit | Misfit;

/** Who sent a transaction, and whether what they sent is the template: for an EOA, one of its calls. */
export type PastGroupKind = 'safe-exact' | 'safe-differs' | 'eoa-exact' | 'eoa-differs';
export const PAST_GROUPS: readonly PastGroupKind[] = ['safe-exact', 'safe-differs', 'eoa-exact', 'eoa-differs'];

export const isExact = (s: Studied): boolean => s.kind === 'fit' && s.outside.length === 0;
const groupOf = (s: Studied): PastGroupKind => `${s.sender.kind}-${isExact(s) ? 'exact' : 'differs'}`;

/**
 * How much a study of one transaction says, lowest first: exactly the template, which no anchor changes; another contract
 * where the template binds one, which one anchor proves; its shape outside the registry; another shape.
 */
const rank = (s: Studied): number => (s.kind === 'fit' ? (s.outside.length === 0 ? 0 : 2) : s.reason.kind === 'entry' ? 1 : 3);

/** The operation's studied transactions, each once, though several recordings found it. */
export function studiedOnce(runs: readonly PastTxs[], template: Template): Studied[] {
  const best = new Map<Hex, Studied>();
  for (const s of runs.flatMap((run) => run.studies)) {
    if ((s.kind !== 'fit' && s.kind !== 'misfit') || isOtherOperation(s, template)) continue;
    const seen = best.get(s.hash);
    if (seen === undefined || rank(s) < rank(seen)) best.set(s.hash, s);
  }
  return [...best.values()];
}

/** `of` from the newest block to the oldest, undefined when one's block was not kept, since that one may be the newest. */
export function newestFirst(of: readonly Studied[]): Studied[] | undefined {
  const placed = of.flatMap((study) => (study.block === undefined ? [] : [{ study, block: study.block }]));
  if (placed.length < of.length) return undefined;
  return placed.sort((a, b) => (a.block > b.block ? -1 : a.block < b.block ? 1 : 0)).map(({ study }) => study);
}

/**
 * The past values at one place the template leaves to the app. `time`: each value's distance from its block's time.
 * `numbers`: too many different numbers to list. `values`: each value, few enough to list. `distinct`: too many to list
 * and no number. Each keeps the transactions the template accepts apart from those it refuses.
 */
export type PastValues =
  | { readonly kind: 'time'; readonly limit: bigint | undefined; readonly rows: readonly SpreadRow[] }
  | { readonly kind: 'numbers'; readonly rows: readonly SpreadRow[] }
  | { readonly kind: 'values'; readonly groups: readonly PastGroupKind[]; readonly values: readonly ValueCount[] }
  | { readonly kind: 'distinct'; readonly rows: readonly DistinctRow[] };
/** One group's values; `unrecorded` counts those whose block's time was not recorded. */
export type SpreadRow = { readonly group: PastGroupKind; readonly spread: Spread | undefined; readonly unrecorded: number };
/** How many transactions of each group held the value. */
export type ValueCount = { readonly value: string; readonly counts: Readonly<Record<PastGroupKind, number>> };
/** One group's `count` transactions, how many different values they held, and the commonest of those. */
export type DistinctRow = { readonly group: PastGroupKind; readonly count: number; readonly distinct: number; readonly most: { readonly value: string; readonly times: number } };
export type PastField = { readonly name: string; readonly key: string; readonly past: PastValues };

const MOST_LISTED = 6;
const LONGEST_LISTED = 66;

type Place = { readonly field: number; readonly rule: LeafRule; readonly node: ArgNode };
type Entry = { readonly study: Studied; readonly value: string };

function places(template: Template): Place[] {
  const nodes = new Map<Rule, ArgNode>();
  const visit = (node: ArgNode): void => {
    nodes.set(node.rule, node);
    node.children.forEach(visit);
  };
  argumentTree(template).forEach((call) => call.args.forEach(visit));
  return shapesOf(template).whole.loosened.rules.flatMap((rule, field): Place[] => {
    const node = appFills(rule) ? nodes.get(rule) : undefined;
    return node === undefined ? [] : [{ field, rule, node }];
  });
}

function entriesAt(field: number, studies: readonly Studied[], template: Template): Entry[] {
  const offsets: number[] = [];
  let total = 0;
  for (const shape of shapesOf(template).calls) {
    offsets.push(total);
    total += shape.loosened.rules.length;
  }
  return studies.flatMap((study): Entry[] => {
    if (study.kind === 'misfit') return study.free.filter((f) => f.field === field).map((f) => ({ study, value: f.value }));
    const value = study.values[field - (study.sender.kind === 'safe' ? 0 : (offsets[study.sender.call] as number))];
    return value === undefined ? [] : [{ study, value }];
  });
}

function rows(entries: readonly Entry[], valueOf: (entry: Entry) => bigint | undefined): SpreadRow[] {
  return PAST_GROUPS.flatMap((group): SpreadRow[] => {
    const mine = entries.filter((e) => groupOf(e.study) === group);
    const values = mine.map(valueOf).filter((value) => value !== undefined);
    return mine.length === 0 && group !== 'safe-exact' ? [] : [{ group, spread: spreadOf(values), unrecorded: mine.length - values.length }];
  });
}

const NUMBERS: readonly AbiType['kind'][] = ['uint', 'int'];

function pastValues(place: Place, entries: readonly Entry[], declared: boolean): PastValues {
  const { rule, node } = place;
  const number = NUMBERS.includes(node.param?.type.kind as AbiType['kind']);
  if (number && (isTime(rule) || declared)) {
    return { kind: 'time', limit: rule.kind === 'within-seconds' ? rule.seconds : undefined, rows: rows(entries, ({ study, value }) => (study.time === undefined ? undefined : BigInt(value) - study.time)) };
  }
  const total = (count: ValueCount): number => PAST_GROUPS.reduce((n, group) => n + count.counts[group], 0);
  const counts = new Map<string, Record<PastGroupKind, number>>();
  for (const { study, value } of entries) {
    const count = counts.get(value) ?? { 'safe-exact': 0, 'safe-differs': 0, 'eoa-exact': 0, 'eoa-differs': 0 };
    count[groupOf(study)] += 1;
    counts.set(value, count);
  }
  const values = [...counts].map(([value, of]): ValueCount => ({ value, counts: of })).sort((a, b) => total(b) - total(a));
  const held = (group: PastGroupKind): ValueCount[] => values.filter((v) => v.counts[group] > 0);
  const groups = PAST_GROUPS.filter((group) => group === 'safe-exact' || held(group).length > 0);
  if (values.length <= MOST_LISTED && values.every(({ value }) => number || value.length <= LONGEST_LISTED)) return { kind: 'values', groups, values };
  if (number) return { kind: 'numbers', rows: rows(entries, (e) => BigInt(e.value)) };
  return {
    kind: 'distinct',
    rows: groups.flatMap((group): DistinctRow[] => {
      const mine = held(group);
      const most = mine.reduce<ValueCount | undefined>((top, v) => (top === undefined || v.counts[group] > top.counts[group] ? v : top), undefined);
      return most === undefined ? [] : [{ group, count: mine.reduce((n, v) => n + v.counts[group], 0), distinct: mine.length, most: { value: most.value, times: most.counts[group] } }];
    }),
  };
}

/** Each place the template leaves to the app, with its past values; `times` holds the keys the notes declare times. */
export function pastFields(studies: readonly Studied[], template: Template, times: readonly string[]): PastField[] {
  const all = places(template);
  return all.map((place) => {
    const { key, name } = place.node;
    const shared = all.filter((other) => other.node.name === name).length > 1;
    return { name: shared ? key.slice(key.indexOf('.') + 1) : name, key, past: pastValues(place, entriesAt(place.field, studies, template), times.includes(key)) };
  });
}

/** A call a past transaction made; `sender` for one to the account that made it, so the calls of different Safes to themselves read alike. */
export type PastCall = { readonly to: Address | 'sender' | undefined; readonly selector: Hex | undefined };

/** Why some past transactions are not the template: what differed, and which they are. */
export type PastReason =
  | { readonly kind: 'outside'; readonly outside: readonly Outside[] }
  | { readonly kind: 'batch'; readonly over: number }
  | { readonly kind: 'calls'; readonly how: 'other' | 'extra'; readonly calls: readonly PastCall[] }
  | { readonly kind: 'missing'; readonly missing: readonly string[]; readonly calls: readonly PastCall[] }
  | { readonly kind: 'values'; readonly reason: Extract<MisfitReason, { kind: 'field' | 'entry' }>; readonly different: number }
  | { readonly kind: 'items'; readonly at: string; readonly expected: number; readonly got: number; readonly calls: readonly PastCall[] | undefined }
  | { readonly kind: 'misfit'; readonly reason: Exclude<MisfitReason, { kind: 'calls' | 'items' | 'field' | 'entry' }> };
export type PastDifference = { readonly reason: PastReason; readonly studies: readonly Studied[] };

/** The most calls a difference names one by one; a template of more calls names as many as it has. */
const MOST_CALLS = 4;

/** The places of `of` in order within `within`, or undefined when it does not hold them in that order. */
function inOrder(of: readonly (string | undefined)[], within: readonly (string | undefined)[]): boolean {
  let at = 0;
  for (const item of within) if (at < of.length && item === of[at]) at++;
  return at === of.length;
}

function reasonOf(s: Studied, template: Template): { readonly key: string; readonly reason: PastReason } {
  if (s.kind === 'fit') return { key: `outside ${s.outside.map((o) => `${o.at}:${o.kind}`).join(' ')}`, reason: { kind: 'outside', outside: s.outside } };
  const { reason } = s;
  const past = (calls: readonly CallName[]): PastCall[] => calls.map(({ to, selector }) => ({ to: to === s.sender.address ? 'sender' : to, selector }));
  const named = (calls: readonly PastCall[]): string => calls.map((call) => `${call.to}.${call.selector}`).join(' ');
  switch (reason.kind) {
    case 'calls': {
      const over = Math.max(MOST_CALLS, template.calls.length);
      if (reason.calls.length > over) return { key: 'batch', reason: { kind: 'batch', over } };
      const own = template.calls.map((call) => (call.data === 'empty' ? undefined : call.data.fn));
      const ownSelectors = own.map((fn) => fn?.selector);
      const selectors = reason.calls.map((call) => call.selector);
      const calls = past(reason.calls);
      const key = `calls ${named(calls)}`;
      if (inOrder(selectors, ownSelectors)) {
        const missing = own.flatMap((fn) => (fn === undefined || selectors.includes(fn.selector) ? [] : [fn.name]));
        if (missing.length > 0) return { key, reason: { kind: 'missing', missing, calls } };
      }
      return { key, reason: { kind: 'calls', how: inOrder(ownSelectors, selectors) ? 'extra' : 'other', calls } };
    }
    case 'field':
      return { key: `field ${reason.at} ${reason.expected}`, reason: { kind: 'values', reason, different: 1 } };
    case 'entry':
      return { key: `entry ${reason.at}`, reason: { kind: 'values', reason, different: 1 } };
    case 'items': {
      const calls = reason.calls !== undefined && reason.calls.length <= MOST_CALLS ? past(reason.calls) : undefined;
      return { key: `items ${reason.at} ${reason.got} ${named(calls ?? [])}`, reason: { ...reason, calls } };
    }
    default:
      return { key: `${reason.kind} ${'at' in reason ? reason.at : ''} ${'other' in reason ? reason.other : ''}`, reason: { kind: 'misfit', reason } };
  }
}

const actualOf = (s: Studied): string => (s.kind === 'misfit' && (s.reason.kind === 'field' || s.reason.kind === 'entry') ? s.reason.actual : '');

/** The transactions that are not exactly the template, by what differed, the commonest first. */
export function pastDifferences(studies: readonly Studied[], template: Template): PastDifference[] {
  const groups = new Map<string, { reason: PastReason; studies: Studied[] }>();
  for (const s of studies.filter((s) => !isExact(s))) {
    const { key, reason } = reasonOf(s, template);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { reason, studies: [s] });
    else group.studies.push(s);
  }
  return [...groups.values()]
    .map(({ reason, studies: of }) => ({ reason: reason.kind === 'values' ? { ...reason, different: new Set(of.map(actualOf)).size } : reason, studies: of }))
    .sort((a, b) => b.studies.length - a.studies.length);
}
