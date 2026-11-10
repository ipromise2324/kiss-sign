import type { ResolvedCard, ResolvedValue } from '../card.ts';
import type { Registry } from '../registry.ts';
import type { Address } from '../safe/types.ts';
import type { CardRef, Template } from '../template/template.ts';
import type { Execution } from './events.ts';

export type AllowanceChange = { readonly token: Address; readonly spender: Address; readonly before: bigint; readonly after: bigint };

/** What the Safe's own balances did: net changes, signed, and every allowance from the Safe that was measured. */
export type Effects = {
  readonly eth: bigint;
  readonly tokens: ReadonlyMap<Address, bigint>;
  readonly allowances: readonly AllowanceChange[];
};

export type Observed =
  | ({ readonly kind: 'executed' } & Effects)
  | { readonly kind: 'not-executed'; readonly why: Exclude<Execution, 'success'> };

export type Asset = 'eth' | Address;

/** A change of exactly `change`, or, for an effect that `gets` a `positive` amount, of more than `change`. */
export type Expected = { readonly kind: 'exactly' | 'more-than'; readonly change: bigint };

export type EffectFinding =
  | { readonly kind: 'balance'; readonly asset: Asset; readonly expected: Expected; readonly actual: bigint }
  | ({ readonly kind: 'open-allowance' } & AllowanceChange);

export type EffectVerdict =
  | { readonly kind: 'match' }
  | { readonly kind: 'mismatch'; readonly findings: readonly EffectFinding[] }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

export type Expectations =
  | { readonly kind: 'expected'; readonly changes: ReadonlyMap<Address, Expected> }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

type TokenRef = { readonly token: Address } | { readonly problem: string };

function tokenOf(ref: CardRef, values: ReadonlyMap<string, ResolvedValue>, registry: Registry): TokenRef {
  const value = values.get(ref.field);
  if (value === undefined) return { problem: `the card has no ${ref.field}` };
  if (value.kind === 'amount') return { problem: `card field ${ref.field} is an amount, not a token` };
  if (value.kind === 'address') return { token: value.address };
  if (ref.attribute === undefined) return { token: value.entry.address };
  const name = value.entry.attributes[ref.attribute];
  const target = name === undefined ? undefined : registry.entries.get(name);
  return target === undefined ? { problem: `the registry has no ${ref.attribute} for ${value.name}` } : { token: target.address };
}

/** The sum over the card's operations of what each template's effects say the Safe gives and gets. */
export function expectedChanges(card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): Expectations {
  const changes = new Map<Address, Expected>();
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
      const ref = tokenOf(effect.token, op.values, registry);
      if ('problem' in ref) {
        reasons.push(ref.problem);
        continue;
      }
      const { token } = ref;
      const known = changes.get(token) ?? { kind: 'exactly', change: 0n };
      if (effect.amount.kind === 'positive') {
        changes.set(token, { kind: 'more-than', change: known.change });
        continue;
      }
      const amount = op.values.get(effect.amount.field);
      if (amount?.kind !== 'amount') {
        reasons.push(`the card has no amount ${effect.amount.field}`);
        continue;
      }
      changes.set(token, { ...known, change: known.change + sign * amount.value });
    }
  }
  return reasons.length > 0 ? { kind: 'unverifiable', reasons } : { kind: 'expected', changes };
}

const meets = (expected: Expected, actual: bigint): boolean =>
  expected.kind === 'exactly' ? actual === expected.change : actual > expected.change;

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
  const assets = new Set<Address>([...expectations.changes.keys(), ...observed.tokens.keys()]);
  if (!meets(NONE, observed.eth)) findings.push({ kind: 'balance', asset: 'eth', expected: NONE, actual: observed.eth });
  for (const asset of assets) {
    const expected = expectations.changes.get(asset) ?? NONE;
    const actual = observed.tokens.get(asset) ?? 0n;
    if (!meets(expected, actual)) findings.push({ kind: 'balance', asset, expected, actual });
  }
  for (const allowance of observed.allowances) {
    if (allowance.after !== allowance.before) findings.push({ kind: 'open-allowance', ...allowance });
  }
  return findings.length === 0 ? { kind: 'match' } : { kind: 'mismatch', findings };
}

const nameOf = (asset: Asset, registry: Registry): string =>
  asset === 'eth' ? 'ETH' : `${registry.byAddress.get(asset)?.name ?? 'unregistered token'} ${asset}`;

const signed = (n: bigint): string => (n > 0n ? `+${n}` : `${n}`);

export function describeFinding(finding: EffectFinding, registry: Registry): string {
  if (finding.kind === 'open-allowance') {
    return `approval not spent in the same transaction: ${nameOf(finding.token, registry)} to ${finding.spender}, ${finding.before} before, ${finding.after} after`;
  }
  const { expected } = finding;
  const want = expected.kind === 'exactly' ? signed(expected.change) : `more than ${signed(expected.change)}`;
  return `${nameOf(finding.asset, registry)} changed by ${signed(finding.actual)}, the card explains ${want}`;
}
