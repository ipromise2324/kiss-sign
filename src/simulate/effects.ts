import type { ResolvedCard, ResolvedValue } from '../card.ts';
import type { Registry } from '../registry.ts';
import type { Address } from '../safe/types.ts';
import type { CardRef, Template, TokenRef } from '../template/template.ts';
import type { Execution } from './events.ts';
import type { SafeStateEvidence } from './safe-state.ts';

export type AllowanceChange = { readonly token: Address; readonly spender: Address; readonly before: bigint; readonly after: bigint };

/**
 * What the Safe's own balances did: net changes, signed, and every allowance from the Safe that was measured. `ends`
 * holds the Safe's balance after the transaction of each token that was asked for, as a card that gives all of it needs.
 */
export type Effects = {
  readonly eth: bigint;
  readonly tokens: ReadonlyMap<Address, bigint>;
  readonly allowances: readonly AllowanceChange[];
  readonly ends: ReadonlyMap<Address, bigint>;
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
  | { readonly kind: 'balance'; readonly asset: Address | 'eth'; readonly expected: Exclude<Expected, { kind: 'all' }>; readonly actual: bigint }
  | { readonly kind: 'not-all'; readonly asset: Address; readonly left: bigint }
  | ({ readonly kind: 'open-allowance' } & AllowanceChange);

export type EffectVerdict =
  | { readonly kind: 'match' }
  | { readonly kind: 'mismatch'; readonly findings: readonly EffectFinding[] }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

export type Expectations =
  | { readonly kind: 'expected'; readonly changes: ReadonlyMap<Asset, Expected> }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

type Resolved = { readonly address: Address } | { readonly problem: string };

function addressOf(ref: CardRef, values: ReadonlyMap<string, ResolvedValue>, registry: Registry): Resolved {
  const value = values.get(ref.field);
  if (value === undefined) return { problem: `the card has no ${ref.field}` };
  if (value.kind === 'amount' || value.kind === 'nonce') return { problem: `card field ${ref.field} is a number, not an address` };
  if (value.kind === 'address') return { address: value.address };
  if (ref.attribute === undefined) return { address: value.entry.address };
  const name = value.entry.attributes[ref.attribute];
  const target = name === undefined ? undefined : registry.entries.get(name);
  return target === undefined ? { problem: `the registry has no ${ref.attribute} for ${value.name}` } : { address: target.address };
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
        else changes.set(token, { kind: open, change: base.change });
        continue;
      }
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

const meets = (expected: Exclude<Expected, { kind: 'all' }>, actual: bigint): boolean =>
  expected.kind === 'exactly' ? actual === expected.change : expected.kind === 'more-than' ? actual > expected.change : actual < expected.change;

/**
 * Every change to the Safe's balances must be one the card's effects explain, and every allowance must end where it
 * started: an approval is spent in the transaction that gives it.
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
    if (allowance.after !== allowance.before) findings.push({ kind: 'open-allowance', ...allowance });
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
    return `approval not spent in the same transaction: ${nameOf(finding.token, registry)} to ${finding.spender}, ${finding.before} before, ${finding.after} after`;
  }
  const { expected } = finding;
  const want = expected.kind === 'exactly' ? signed(expected.change) : `${expected.kind === 'more-than' ? 'more' : 'less'} than ${signed(expected.change)}`;
  return `${nameOf(finding.asset, registry)} changed by ${signed(finding.actual)}, the card explains ${want}`;
}
