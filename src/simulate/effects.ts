import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { resolveRef } from '../card.ts';
import type { ResolvedCard, ResolvedValue } from '../card.ts';
import { canonicalType } from '../decode/abi.ts';
import type { AbiParam, AbiType } from '../decode/abi.ts';
import { decodeValues, encodeCall, encodeParams } from '../decode/codec.ts';
import type { AbiValue } from '../decode/codec.ts';
import { groupedTokens } from '../chain/decimals.ts';
import type { AllowanceRoute, Registry } from '../registry.ts';
import type { Address, Hex } from '../safe/types.ts';
import { isNamedToken } from '../template/template.ts';
import type { BoundView, CallNode, CardRef, EffectToken, Rule, Template, ViewChange, ViewEffect, ViewTarget } from '../template/template.ts';
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
 * one; of at least `change` when it gets at least a card amount or `any`; from `low` to `high`, both included, when it
 * gives at most a card amount or a tolerance widens an exact one; or, when the Safe gives `all` of a token, any change
 * that leaves it holding none.
 */
export type Expected =
  | { readonly kind: 'exactly'; readonly change: bigint }
  | { readonly kind: 'more-than' | 'at-least' | 'less-than'; readonly change: bigint }
  | { readonly kind: 'between'; readonly low: bigint; readonly high: bigint }
  | { readonly kind: 'all' };

/** An expected change that bounds the amount, as a balance finding names it. */
export type Bounded = Exclude<Expected, { kind: 'all' }>;

export type EffectFinding =
  | { readonly kind: 'balance'; readonly asset: Asset; readonly expected: Bounded; readonly actual: bigint }
  | { readonly kind: 'not-all'; readonly asset: Address; readonly left: bigint }
  | ({ readonly kind: 'open-allowance' } & AllowanceChange)
  | ({ readonly kind: 'open-permit2-allowance' } & Permit2Change)
  | { readonly kind: 'view'; readonly to: Address; readonly call: string; readonly value: string; readonly change: ViewChange | { readonly equals: bigint }; readonly before: bigint; readonly after: bigint; readonly readIn: ViewReadIn };

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

const assetOf = (ref: EffectToken, values: ReadonlyMap<string, ResolvedValue>, registry: Registry): { readonly asset: Asset } | { readonly problem: string } => {
  if (ref === 'eth') return { asset: 'eth' };
  if (isNamedToken(ref)) {
    const entry = registry.entries.get(ref.contract);
    return entry === undefined ? { problem: `the registry has no ${ref.contract}` } : { asset: entry.address };
  }
  const resolved = addressOf(ref, values, registry);
  return 'problem' in resolved ? resolved : { asset: resolved.address };
};

/** `expected` moved by a change from `low` to `high`: an exact amount becomes a range unless both ends are equal. */
function shifted(expected: Extract<Bounded, { kind: 'exactly' | 'between' }>, low: bigint, high: bigint): Bounded {
  const [from, to] = expected.kind === 'exactly' ? [expected.change, expected.change] : [expected.low, expected.high];
  return low === high && from === to ? { kind: 'exactly', change: from + low } : { kind: 'between', low: from + low, high: to + high };
}

/**
 * The sum over the card's operations of what each template's effects say the Safe gives and gets, each widened by the
 * tolerances the templates declare (an effect's own and `effects.touches`), summed over the card as amounts are.
 */
export function expectedChanges(card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): Expectations {
  const changes = new Map<Asset, Expected>();
  const reasons: string[] = [];
  const stated = new Set<Asset>();
  const slack = new Map<Asset, { readonly less: bigint; readonly more: bigint }>();
  const touched = new Set<Asset>();
  const named = new Set<Asset>();
  const allow = (token: Asset, less: bigint, more: bigint): void => {
    const known = slack.get(token) ?? { less: 0n, more: 0n };
    slack.set(token, { less: known.less + less, more: known.more + more });
  };
  const mixed = (token: Asset): string => `the card names an exact and an open amount of ${token}, so neither can be checked`;
  for (const op of card.operations) {
    const template = templates.get(op.template);
    if (template === undefined) {
      reasons.push(`no template ${op.template}`);
      continue;
    }
    for (const { token, tolerance } of template.effects.touches) {
      const ref = assetOf({ contract: token }, op.values, registry);
      if ('problem' in ref) reasons.push(ref.problem);
      else {
        touched.add(ref.asset);
        allow(ref.asset, tolerance.less, tolerance.more);
      }
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
      named.add(token);
      const known = changes.get(token);
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
      if (effect.amount.kind === 'at-least') {
        const least = op.values.get(effect.amount.field);
        if (least?.kind !== 'amount') reasons.push(`the card has no amount ${effect.amount.field}`);
        else if (base.kind !== 'exactly' || stated.has(token)) reasons.push(mixed(token));
        else {
          stated.add(token);
          changes.set(token, { kind: 'at-least', change: base.change + least.value });
        }
        continue;
      }
      if (effect.amount.kind === 'positive' || effect.amount.kind === 'any') {
        const open = effect.amount.kind === 'any' ? 'at-least' : sign > 0n ? 'more-than' : 'less-than';
        if (base.kind !== 'exactly' && base.kind !== open) reasons.push(`the card leaves the change of ${token} open both ways`);
        else if (stated.has(token)) reasons.push(mixed(token));
        else changes.set(token, { kind: open, change: base.change });
        continue;
      }
      // An open amount of the same token would hide whether this one arrived within its bounds, which a template may rely on.
      if (base.kind !== 'exactly' && base.kind !== 'between') {
        reasons.push(mixed(token));
        continue;
      }
      stated.add(token);
      const amount = op.values.get(effect.amount.field);
      if (amount?.kind !== 'amount') {
        reasons.push(`the card has no amount ${effect.amount.field}`);
        continue;
      }
      changes.set(token, effect.amount.kind === 'at-most' ? shifted(base, -amount.value, 0n) : shifted(base, sign * amount.value, sign * amount.value));
      if (effect.tolerance !== undefined) allow(token, effect.tolerance.less, effect.tolerance.more);
    }
  }
  // Before this loop only `atMost` makes a range, so a tolerance widens only an exact amount, never an open or atMost one.
  for (const [token, { less, more }] of slack) {
    const known = changes.get(token) ?? { kind: 'exactly', change: 0n };
    if (touched.has(token) && named.has(token)) reasons.push(`the card touches ${token} and names it in an effect too`);
    else if (known.kind !== 'exactly') reasons.push(`a tolerance on ${token} would widen an open or atMost amount of it`);
    else changes.set(token, shifted(known, -less, more));
  }
  return reasons.length > 0 ? { kind: 'unverifiable', reasons } : { kind: 'expected', changes };
}

/**
 * The most each allowance from the Safe may end at, by route, token and spender, summed over the card's operations whose
 * template leaves it open (`effects.approves`); `unlimited` when any of them keeps it so.
 */
export type KeptAllowances = ReadonlyMap<string, bigint | 'unlimited'>;

export const keptKey = (via: AllowanceRoute, token: Address, spender: Address): string => `${via}|${token}|${spender}`;

/** The allowances the card's templates keep (`effects.approves`), and why any could not be resolved. */
export function keptAllowances(card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): { readonly kept: KeptAllowances; readonly reasons: readonly string[] } {
  const kept = new Map<string, bigint | 'unlimited'>();
  const reasons: string[] = [];
  for (const op of card.operations) {
    for (const approval of templates.get(op.template)?.effects.approves ?? []) {
      const token = addressOf(approval.token, op.values, registry);
      const spender = registry.entries.get(approval.spender);
      const amount = approval.amount.kind === 'card' ? op.values.get(approval.amount.field) : undefined;
      if ('problem' in token) reasons.push(token.problem);
      else if (spender === undefined) reasons.push(`the registry has no ${approval.spender}`);
      else if (approval.amount.kind === 'card' && amount?.kind !== 'amount') reasons.push(`no card amount ${approval.amount.field}`);
      else {
        const key = keptKey(approval.via, token.address, spender.address);
        const known = kept.get(key) ?? 0n;
        kept.set(key, known === 'unlimited' || approval.amount.kind === 'unlimited' || amount?.kind !== 'amount' ? 'unlimited' : known + amount.value);
      }
    }
  }
  return { kept, reasons };
}

const keeps = (kept: KeptAllowances, via: AllowanceRoute, token: Address, spender: Address, after: bigint): boolean => {
  const limit = kept.get(keptKey(via, token, spender));
  return limit !== undefined && (limit === 'unlimited' || after <= limit);
};

/** An allowance the transaction left higher than it started, which a template on the card keeps; `expiration` only through Permit2. */
export type KeptSeen = { readonly via: AllowanceRoute; readonly token: Address; readonly spender: Address; readonly amount: bigint; readonly expiration: bigint | undefined };

/** The allowances `observed` left raised that the card's templates keep, for the signer to see what stays open. */
export function keptSeen(observed: Observed, card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): KeptSeen[] {
  if (observed.kind !== 'executed') return [];
  const { kept } = keptAllowances(card, templates, registry);
  return [
    ...observed.allowances
      .filter((a) => a.after > a.before && keeps(kept, 'erc20', a.token, a.spender, a.after))
      .map((a): KeptSeen => ({ via: 'erc20', token: a.token, spender: a.spender, amount: a.after, expiration: undefined })),
    ...observed.permit2
      .filter((p) => permit2Raised(p) && keeps(kept, 'permit2', p.token, p.spender, p.after.amount))
      .map((p): KeptSeen => ({ via: 'permit2', token: p.token, spender: p.spender, amount: p.after.amount, expiration: p.after.expiration })),
  ];
}

/** A view a template on the card reads, its arguments bound to this card, and the call as it reads in a finding. */
export type ExpectedView = { readonly view: ViewEffect; readonly call: ViewCall; readonly text: string; readonly values: ReadonlyMap<string, ResolvedValue> };

/** What a view's arguments are bound to. A fact never reads the Safe, so it binds none. */
type Bound = { readonly safe: Address | undefined; readonly values: ReadonlyMap<string, ResolvedValue>; readonly registry: Registry };

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
      return bound.safe === undefined ? 'no Safe is bound' : { kind: 'address', value: bound.safe, span };
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
    case 'call': {
      const data = encoded(rule.call, bound);
      return typeof data === 'string' ? data : { kind: 'bytes', value: data, span };
    }
    case 'keccak': {
      const data = encoded(rule.call, bound);
      return typeof data === 'string' ? data : { kind: 'fixed-bytes', value: `0x${bytesToHex(keccak_256(data))}` as Hex, span };
    }
    default:
      return `a ${rule.kind} rule gives no value before the transaction`;
  }
}

/** A call, or values ABI-encoded without a selector, built from bound arguments. */
function encoded(node: CallNode, bound: Bound): Uint8Array | string {
  const args = node.fn.params.map((param, i) => argument(node.args[i] as Rule, param.type, bound));
  const problem = args.find((arg) => typeof arg === 'string');
  if (problem !== undefined) return problem;
  return node.encoding === 'params' ? encodeParams(node.fn, args as AbiValue[]) : encodeCall({ fn: node.fn, args: args as AbiValue[], trailer: undefined });
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

/** The contract a view reads: a registry name, or a view effect's target, which may be a card field. */
function viewContract(to: string | ViewTarget, bound: Bound): { readonly address: Address } | { readonly problem: string } {
  if (typeof to === 'string' || to.kind === 'contract') {
    const name = typeof to === 'string' ? to : to.name;
    const entry = bound.registry.entries.get(name);
    return entry === undefined ? { problem: `the registry has no ${name}` } : entry;
  }
  const target = resolveRef(to.ref, bound.values, bound.registry);
  if ('problem' in target) return target;
  return target.kind === 'address' ? target : { problem: `card.${to.ref.field} names no contract` };
}

/** The call a view makes with its arguments bound, and how it reads in a finding, or why they cannot be bound. */
export function bindView(view: Omit<BoundView, 'to'> & { readonly to: string | ViewTarget }, bound: Bound): { readonly call: ViewCall; readonly text: string } | { readonly problem: string } {
  const to = viewContract(view.to, bound);
  if ('problem' in to) return to;
  const args = view.fn.params.map((param, i) => argument(view.args[i] as Rule, param.type, bound));
  const problem = args.find((arg) => typeof arg === 'string');
  if (problem !== undefined) return { problem };
  const values = args as AbiValue[];
  const data = `0x${bytesToHex(encodeCall({ fn: view.fn, args: values, trailer: undefined }))}` as Hex;
  return { call: { to: to.address, data }, text: `${view.fn.name}(${values.map(valueText).join(', ')})` };
}

/** Every view the card's templates read, with its calldata for this card, and why any could not be built. */
export function expectedViews(card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): { readonly views: readonly ExpectedView[]; readonly reasons: readonly string[] } {
  const views: ExpectedView[] = [];
  const reasons: string[] = [];
  for (const op of card.operations) {
    for (const view of templates.get(op.template)?.effects.views ?? []) {
      const bound = bindView(view, { safe: card.safe, values: op.values, registry });
      if ('problem' in bound) reasons.push(`${view.fn.signature} on ${view.to.kind === 'contract' ? view.to.name : `card.${view.to.ref.field}${view.to.ref.attribute === undefined ? '' : `.${view.to.ref.attribute}`}`}: ${bound.problem}`);
      else views.push({ view, ...bound, values: op.values });
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
export function numbersOf(view: Pick<BoundView, 'returns'>, answer: ViewAnswer): readonly (bigint | undefined)[] | string {
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

const meets = (expected: Bounded, actual: bigint): boolean => {
  switch (expected.kind) {
    case 'exactly':
      return actual === expected.change;
    case 'more-than':
      return actual > expected.change;
    case 'at-least':
      return actual >= expected.change;
    case 'less-than':
      return actual < expected.change;
    case 'between':
      return expected.low <= actual && actual <= expected.high;
  }
};

/**
 * Every change to the Safe's balances must be one the card's effects explain, and no allowance, ERC-20 or Permit2, may
 * end higher than it started: an approval is spent in the transaction that gives it, unless a template on the card leaves
 * it open (`effects.approves`), and then it may end at no more than the card's amount, or at any amount for one kept
 * `unlimited` to a spender that declares a standing allowance.
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
  const { kept, reasons } = keptAllowances(card, templates, registry);
  unread.push(...reasons);
  for (const allowance of observed.allowances) {
    // A lower allowance lets no one take more from the Safe than before, so only a rise must be explained.
    if (allowance.after > allowance.before && !keeps(kept, 'erc20', allowance.token, allowance.spender, allowance.after)) findings.push({ kind: 'open-allowance', ...allowance });
  }
  for (const allowance of observed.permit2) {
    if (permit2Raised(allowance) && !keeps(kept, 'permit2', allowance.token, allowance.spender, allowance.after.amount)) findings.push({ kind: 'open-permit2-allowance', ...allowance });
  }
  const expectedReads = expectedViews(card, templates, registry);
  unread.push(...expectedReads.reasons);
  for (const { view, call, text, values } of expectedReads.views) {
    const cardNumber = (field: string): bigint | undefined => {
      const value = values.get(field);
      return value?.kind === 'amount' || value?.kind === 'percent' ? value.value : undefined;
    };
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
        const wanted = typeof change === 'string' ? change : cardNumber(change.equals);
        if (wanted === undefined) {
          unread.push(`${where}: the card has no number ${typeof change === 'string' ? '' : change.equals}`);
          continue;
        }
        if (typeof wanted === 'string' ? !CHANGED[wanted](was, now) : now !== wanted) {
          const shown = typeof wanted === 'string' ? wanted : { equals: wanted };
          findings.push({ kind: 'view', to: call.to, call: text, value: view.returns[value]?.name ?? String(value), change: shown, before: was, after: now, readIn: reading.readIn });
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

/**
 * One line per finding. With an asset's decimals, a balance change reads in whole tokens beside its base units, such as
 * `+0.862161333415445038 (+862161333415445038 base units)`; without them, in base units alone.
 */
export function describeFinding(finding: EffectFinding, registry: Registry, decimals: ReadonlyMap<Asset, number> = new Map()): string {
  if (finding.kind === 'not-all') return `${nameOf(finding.asset, registry)} still held ${finding.left} after the transaction, the card gives all of it`;
  if (finding.kind === 'open-allowance') {
    return `approval raised and not spent in the same transaction: ${nameOf(finding.token, registry)} to ${finding.spender}, ${finding.before} before, ${finding.after} after`;
  }
  if (finding.kind === 'view') {
    const want = typeof finding.change === 'string' ? { increases: 'increase', decreases: 'decrease', same: 'stay the same' }[finding.change] : `be ${finding.change.equals}, as the card says`;
    return `${nameOf(finding.to, registry)} ${finding.call} ${finding.value}: ${finding.before} before, ${finding.after} after ${READ_IN[finding.readIn]}; the template needs it to ${want}`;
  }
  if (finding.kind === 'open-permit2-allowance') {
    const show = ({ amount, expiration, nonce }: Permit2Allowance) => `${amount} until ${expiration} (nonce ${nonce})`;
    return `Permit2 allowance raised and not spent in the same transaction: ${nameOf(finding.token, registry)} to ${finding.spender}, ${show(finding.before)} before, ${show(finding.after)} after`;
  }
  const { expected, asset } = finding;
  const places = decimals.get(asset);
  const amount = (n: bigint): string =>
    places === undefined || n === 0n ? signed(n) : `${n > 0n ? '+' : '-'}${groupedTokens(n < 0n ? -n : n, places)} (${signed(n)} base units)`;
  const want =
    expected.kind === 'between'
      ? `between ${amount(expected.low)} and ${amount(expected.high)}`
      : expected.kind === 'exactly'
        ? amount(expected.change)
        : expected.kind === 'at-least'
          ? `at least ${amount(expected.change)}`
          : `${expected.kind === 'more-than' ? 'more' : 'less'} than ${amount(expected.change)}`;
  return `${nameOf(asset, registry)} changed by ${amount(finding.actual)}, the card explains ${want}`;
}
