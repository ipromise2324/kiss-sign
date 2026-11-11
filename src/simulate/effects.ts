import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { resolveRef } from '../card.ts';
import type { ResolvedCard, ResolvedValue } from '../card.ts';
import { canonicalType } from '../decode/abi.ts';
import type { AbiParam, AbiType } from '../decode/abi.ts';
import { decodeValues, encodeCall } from '../decode/codec.ts';
import type { AbiValue } from '../decode/codec.ts';
import type { Registry } from '../registry.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { CardRef, Rule, Template, TokenRef, ViewChange, ViewEffect } from '../template/template.ts';
import type { Execution } from './events.ts';
import type { SafeStateEvidence } from './safe-state.ts';

export type AllowanceChange = { readonly token: Address; readonly spender: Address; readonly before: bigint; readonly after: bigint };

export type Permit2Allowance = { readonly amount: bigint; readonly expiration: bigint; readonly nonce: bigint };
export type Permit2Change = { readonly token: Address; readonly spender: Address; readonly before: Permit2Allowance; readonly after: Permit2Allowance };

/** A raised Permit2 nonce only voids signed permits. */
export const permit2Raised = ({ before, after }: Permit2Change): boolean =>
  after.amount > 0n && (after.amount > before.amount || after.expiration > before.expiration);

/** A view call as sent: the contract and the calldata. */
export type ViewCall = { readonly to: Address; readonly data: Hex };
/** What a view answered, or why it gave no answer, such as a revert or providers that disagree. */
export type ViewAnswer = { readonly kind: 'returned'; readonly data: Hex } | { readonly kind: 'unread'; readonly why: string };
/**
 * Where a reading was taken: just around the transaction in a simulated block, or, for an executed transaction, at its
 * parent block and its execution block, which other transactions in that block also change.
 */
export type ViewReadIn = 'simulation' | 'blocks';
export type ViewReading = ViewCall & { readonly before: ViewAnswer; readonly after: ViewAnswer; readonly readIn: ViewReadIn };

/**
 * What the Safe's own balances did: net changes, signed, and every allowance from the Safe that was measured. `ends`
 * holds the Safe's balance after the transaction of each token that was asked for, as a card that gives all of it needs.
 * `views` holds each view a template asked for, read before and after, once for each place it was read; it is absent
 * when none was asked for.
 */
export type Effects = {
  readonly eth: bigint;
  readonly tokens: ReadonlyMap<Address, bigint>;
  readonly allowances: readonly AllowanceChange[];
  readonly permit2: readonly Permit2Change[];
  readonly ends: ReadonlyMap<Address, bigint>;
  readonly views?: readonly ViewReading[];
};

export type Observed =
  | ({ readonly kind: 'executed'; readonly safeState: SafeStateEvidence } & Effects)
  | { readonly kind: 'not-executed'; readonly why: Exclude<Execution, 'success'> };

export type Asset = 'eth' | Address;

/**
 * A change of exactly `change`; of more than `change` when the Safe also gets a `positive` amount, or less when it gives
 * one; or, when the Safe gives `all` of a token, any change that leaves it holding none.
 */
export type Expected = { readonly kind: 'exactly' | 'more-than' | 'less-than'; readonly change: bigint } | { readonly kind: 'all' };

export type EffectFinding =
  | { readonly kind: 'balance'; readonly asset: Asset; readonly expected: Exclude<Expected, { kind: 'all' }>; readonly actual: bigint }
  | { readonly kind: 'not-all'; readonly asset: Address; readonly left: bigint }
  | ({ readonly kind: 'open-allowance' } & AllowanceChange)
  | ({ readonly kind: 'open-permit2-allowance' } & Permit2Change)
  | { readonly kind: 'view'; readonly to: Address; readonly call: string; readonly value: string; readonly change: ViewChange; readonly before: bigint; readonly after: bigint; readonly readIn: ViewReadIn };

export type EffectVerdict =
  | { readonly kind: 'match' }
  | { readonly kind: 'mismatch'; readonly findings: readonly EffectFinding[] }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

export type Expectations =
  | { readonly kind: 'expected'; readonly changes: ReadonlyMap<Asset, Expected> }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

type Resolved = { readonly address: Address } | { readonly problem: string };

function addressOf(ref: CardRef, values: ReadonlyMap<string, ResolvedValue>, registry: Registry): Resolved {
  const target = resolveRef(ref, values, registry);
  if ('problem' in target) return target;
  return target.kind === 'address' ? { address: target.address } : { problem: `card field ${ref.field} is a number, not an address` };
}

const assetOf = (ref: TokenRef, values: ReadonlyMap<string, ResolvedValue>, registry: Registry): { readonly asset: Asset } | { readonly problem: string } => {
  if (ref === 'eth') return { asset: 'eth' };
  const resolved = addressOf(ref, values, registry);
  return 'problem' in resolved ? resolved : { asset: resolved.address };
};

/** The sum over the card's operations of what each template's effects say the Safe gives and gets. */
export function expectedChanges(card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): Expectations {
  const changes = new Map<Asset, Expected>();
  const reasons: string[] = [];
  const stated = new Set<Asset>();
  const mixed = (token: Asset): string => `the card names an exact and an open amount of ${token}, so neither can be checked`;
  for (const op of card.operations) {
    const template = templates.get(op.template);
    if (template === undefined) {
      reasons.push(`no template ${op.template}`);
      continue;
    }
    const sides = [
      ...template.effects.gives.map((effect) => ({ effect, sign: -1n })),
      ...template.effects.gets.map((effect) => ({ effect, sign: 1n })),
    ];
    for (const { effect, sign } of sides) {
      const ref = assetOf(effect.token, op.values, registry);
      if ('problem' in ref) {
        reasons.push(ref.problem);
        continue;
      }
      if (effect.to !== undefined) {
        const receiver = addressOf(effect.to, op.values, registry);
        if ('problem' in receiver) {
          reasons.push(receiver.problem);
          continue;
        }
        if (receiver.address === card.safe) continue;
      }
      const token = ref.asset;
      const known = changes.get(token);
      const open = sign > 0n ? 'more-than' : 'less-than';
      if (effect.amount.kind === 'all') {
        if (token === 'eth' || known !== undefined) reasons.push(`the card gives all of ${token} and names it again`);
        else changes.set(token, { kind: 'all' });
        continue;
      }
      if (known?.kind === 'all') {
        reasons.push(`the card gives all of ${token} and names it again`);
        continue;
      }
      const base = known ?? { kind: 'exactly', change: 0n };
      if (effect.amount.kind === 'positive') {
        if (base.kind !== 'exactly' && base.kind !== open) reasons.push(`the card leaves the change of ${token} open both ways`);
        else if (stated.has(token)) reasons.push(mixed(token));
        else changes.set(token, { kind: open, change: base.change });
        continue;
      }
      // An open amount of the same token would hide whether this one arrived exactly, which a template may rely on.
      if (base.kind !== 'exactly') {
        reasons.push(mixed(token));
        continue;
      }
      stated.add(token);
      const amount = op.values.get(effect.amount.field);
      if (amount?.kind !== 'amount') {
        reasons.push(`the card has no amount ${effect.amount.field}`);
        continue;
      }
      changes.set(token, { ...base, change: base.change + sign * amount.value });
    }
  }
  return reasons.length > 0 ? { kind: 'unverifiable', reasons } : { kind: 'expected', changes };
}

/** A view a template on the card reads, its arguments bound to this card, and the call as it reads in a finding. */
export type ExpectedView = { readonly view: ViewEffect; readonly call: ViewCall; readonly text: string };

type Bound = { readonly safe: Address; readonly values: ReadonlyMap<string, ResolvedValue>; readonly registry: Registry };

/** The value a bound argument rule gives, or why the card cannot give it. */
function argument(rule: Rule, type: AbiType, bound: Bound): AbiValue | string {
  const span = [0, 0] as const;
  switch (rule.kind) {
    case 'fields': {
      if (type.kind !== 'tuple') return `a tuple rule on a ${type.kind}`;
      const fields = rule.fields.map((field, i) => argument(field, (type.components[i] as AbiParam).type, bound));
      const problem = fields.find((field) => typeof field === 'string');
      return problem ?? { kind: 'tuple', fields: fields as AbiValue[], span };
    }
    case 'items': {
      if (type.kind !== 'array' && type.kind !== 'fixed-array') return `an items rule on a ${type.kind}`;
      const items = rule.items.map((item) => argument(item, type.item, bound));
      const problem = items.find((item) => typeof item === 'string');
      return problem ?? { kind: 'array', items: items as AbiValue[], span };
    }
    case 'safe':
      return { kind: 'address', value: bound.safe, span };
    case 'contract': {
      const entry = bound.registry.entries.get(rule.name);
      return entry === undefined ? `the registry has no ${rule.name}` : { kind: 'address', value: entry.address, span };
    }
    case 'const': {
      const { value } = rule;
      if (value.kind === 'bytes' || value.kind === 'string') return { kind: value.kind, value: hexToBytes(value.value.slice(2)), span };
      return { ...value, span } as AbiValue;
    }
    case 'card': {
      const target = resolveRef(rule.ref, bound.values, bound.registry);
      if ('problem' in target) return target.problem;
      if (target.kind === 'address') return { kind: 'address', value: target.address, span };
      if (target.kind === 'uint') return { kind: 'uint', value: target.value, span };
      if (target.kind === 'bytes32') return { kind: 'fixed-bytes', value: target.value, span };
      return 'a whole market is bound part by part';
    }
    default:
      return `a ${rule.kind} rule gives no value before the transaction`;
  }
}

function valueText(value: AbiValue): string {
  switch (value.kind) {
    case 'tuple':
      return `(${value.fields.map(valueText).join(', ')})`;
    case 'array':
      return `[${value.items.map(valueText).join(', ')}]`;
    case 'bytes':
    case 'string':
      return `0x${bytesToHex(value.value)}`;
    default:
      return String(value.value);
  }
}

/** Every view the card's templates read, with its calldata for this card, and why any could not be built. */
export function expectedViews(card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): { readonly views: readonly ExpectedView[]; readonly reasons: readonly string[] } {
  const views: ExpectedView[] = [];
  const reasons: string[] = [];
  for (const op of card.operations) {
    for (const view of templates.get(op.template)?.effects.views ?? []) {
      const to = registry.entries.get(view.to);
      const args = view.fn.params.map((param, i) => argument(view.args[i] as Rule, param.type, { safe: card.safe, values: op.values, registry }));
      const problem = to === undefined ? `the registry has no ${view.to}` : args.find((arg) => typeof arg === 'string');
      if (to === undefined || problem !== undefined) {
        reasons.push(`${view.fn.signature} on ${view.to}: ${problem}`);
        continue;
      }
      const values = args as AbiValue[];
      const data = `0x${bytesToHex(encodeCall({ fn: view.fn, args: values, trailer: undefined }))}` as Hex;
      views.push({ view, call: { to: to.address, data }, text: `${view.fn.name}(${values.map(valueText).join(', ')})` });
    }
  }
  return { views, reasons };
}

/** The view calls to read before and after the transaction, each once. */
export function viewCalls(card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): ViewCall[] {
  const calls = new Map(expectedViews(card, templates, registry).views.map(({ call }) => [`${call.to}${call.data}`, call]));
  return [...calls.values()];
}

/** Each return value of a view's answer, as a number where it is one, or why the answer has none. */
function numbersOf(view: ViewEffect, answer: ViewAnswer): readonly (bigint | undefined)[] | string {
  if (answer.kind === 'unread') return answer.why;
  const values = decodeValues(view.returns.map((r) => r.type), hexToBytes(answer.data.slice(2)));
  if (values === undefined) return `its answer does not decode as ${view.returns.map((r) => canonicalType(r.type)).join(', ')}`;
  return values.map((value) => (value.kind === 'uint' || value.kind === 'int' ? value.value : undefined));
}

const READ_IN: Readonly<Record<ViewReadIn, string>> = {
  simulation: 'in a simulated block',
  blocks: 'at the parent block and the execution block',
};

const CHANGED: Readonly<Record<ViewChange, (before: bigint, after: bigint) => boolean>> = {
  increases: (before, after) => after > before,
  decreases: (before, after) => after < before,
  same: (before, after) => after === before,
};

const meets = (expected: Exclude<Expected, { kind: 'all' }>, actual: bigint): boolean =>
  expected.kind === 'exactly' ? actual === expected.change : expected.kind === 'more-than' ? actual > expected.change : actual < expected.change;

/**
 * Every change to the Safe's balances must be one the card's effects explain, and no allowance, ERC-20 or Permit2, may
 * end higher than it started: an approval is spent in the transaction that gives it.
 */
export function judgeEffects(
  observed: Observed,
  card: ResolvedCard,
  templates: ReadonlyMap<string, Template>,
  registry: Registry,
): EffectVerdict {
  if (observed.kind === 'not-executed') return { kind: 'unverifiable', reasons: [`the Safe transaction did not execute: ${observed.why}`] };
  const expectations = expectedChanges(card, templates, registry);
  if (expectations.kind === 'unverifiable') return expectations;
  const NONE: Expected = { kind: 'exactly', change: 0n };
  const findings: EffectFinding[] = [];
  const assets = new Set<Asset>(['eth', ...expectations.changes.keys(), ...observed.tokens.keys()]);
  const unread: string[] = [];
  for (const asset of assets) {
    const expected = expectations.changes.get(asset) ?? NONE;
    if (expected.kind === 'all') {
      const left = asset === 'eth' ? undefined : observed.ends.get(asset);
      if (asset === 'eth' || left === undefined) unread.push(`the Safe's balance of ${asset} after the transaction was not read`);
      else if (left !== 0n) findings.push({ kind: 'not-all', asset, left });
      continue;
    }
    const actual = asset === 'eth' ? observed.eth : (observed.tokens.get(asset) ?? 0n);
    if (!meets(expected, actual)) findings.push({ kind: 'balance', asset, expected, actual });
  }
  for (const allowance of observed.allowances) {
    // A lower allowance lets no one take more from the Safe than before, so only a rise must be explained.
    if (allowance.after > allowance.before) findings.push({ kind: 'open-allowance', ...allowance });
  }
  for (const allowance of observed.permit2) if (permit2Raised(allowance)) findings.push({ kind: 'open-permit2-allowance', ...allowance });
  const expectedReads = expectedViews(card, templates, registry);
  unread.push(...expectedReads.reasons);
  for (const { view, call, text } of expectedReads.views) {
    const where = `${nameOf(call.to, registry)} ${text}`;
    const readings = observed.views?.filter((r) => r.to === call.to && r.data === call.data) ?? [];
    if (readings.length === 0) unread.push(`${where} was not read`);
    for (const reading of readings) {
      const [before, after] = [numbersOf(view, reading.before), numbersOf(view, reading.after)];
      if (typeof before === 'string') {
        unread.push(`${where} could not be read before the transaction ${READ_IN[reading.readIn]}: ${before}`);
        continue;
      }
      if (typeof after === 'string') {
        unread.push(`${where} could not be read after the transaction ${READ_IN[reading.readIn]}: ${after}`);
        continue;
      }
      for (const { value, change } of view.changes) {
        // Template load lets a change name only a number.
        const [was, now] = [before[value] as bigint, after[value] as bigint];
        if (!CHANGED[change](was, now)) {
          findings.push({ kind: 'view', to: call.to, call: text, value: view.returns[value]?.name ?? String(value), change, before: was, after: now, readIn: reading.readIn });
        }
      }
    }
  }
  if (findings.length > 0) return { kind: 'mismatch', findings };
  return unread.length > 0 ? { kind: 'unverifiable', reasons: unread } : { kind: 'match' };
}

/** The tokens whose balance after the transaction the card's effects need: those it gives all of. */
export function endsNeeded(expectations: Expectations): Address[] {
  if (expectations.kind === 'unverifiable') return [];
  return [...expectations.changes].flatMap(([asset, expected]) => (expected.kind === 'all' && asset !== 'eth' ? [asset] : []));
}

const nameOf = (asset: Asset, registry: Registry): string =>
  asset === 'eth' ? 'ETH' : `${registry.byAddress.get(asset)?.name ?? 'unregistered token'} ${asset}`;

const signed = (n: bigint): string => (n > 0n ? `+${n}` : `${n}`);

export function describeFinding(finding: EffectFinding, registry: Registry): string {
  if (finding.kind === 'not-all') return `${nameOf(finding.asset, registry)} still held ${finding.left} after the transaction, the card gives all of it`;
  if (finding.kind === 'open-allowance') {
    return `approval raised and not spent in the same transaction: ${nameOf(finding.token, registry)} to ${finding.spender}, ${finding.before} before, ${finding.after} after`;
  }
  if (finding.kind === 'view') {
    const want = { increases: 'increase', decreases: 'decrease', same: 'stay the same' }[finding.change];
    return `${nameOf(finding.to, registry)} ${finding.call} ${finding.value}: ${finding.before} before, ${finding.after} after ${READ_IN[finding.readIn]}; the template needs it to ${want}`;
  }
  if (finding.kind === 'open-permit2-allowance') {
    const show = ({ amount, expiration, nonce }: Permit2Allowance) => `${amount} until ${expiration} (nonce ${nonce})`;
    return `Permit2 allowance raised and not spent in the same transaction: ${nameOf(finding.token, registry)} to ${finding.spender}, ${show(finding.before)} before, ${show(finding.after)} after`;
  }
  const { expected } = finding;
  const want = expected.kind === 'exactly' ? signed(expected.change) : `${expected.kind === 'more-than' ? 'more' : 'less'} than ${signed(expected.change)}`;
  return `${nameOf(finding.asset, registry)} changed by ${signed(finding.actual)}, the card explains ${want}`;
}
