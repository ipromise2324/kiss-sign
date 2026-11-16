import type { FloorResult } from '../floor/floor.ts';
import type { SafeTx } from '../safe/types.ts';
import type { Verdict } from '../verify/verdict.ts';

/** What the harness knows about one past transaction when it picks the reason it is not MATCH. */
export type Facts = {
  readonly tx: SafeTx;
  readonly floor: FloorResult;
  readonly outcome:
    | { readonly kind: 'no-card' }
    | { readonly kind: 'verdict'; readonly verdict: Verdict }
    | { readonly kind: 'no-template'; readonly ids: readonly string[] }
    | { readonly kind: 'error'; readonly message: string };
};

/** `key` groups rows in the summary; `detail` says what about this transaction gave it. */
export type Reason = { readonly key: string; readonly detail: string };

const floorRules = (floor: FloorResult): string | undefined =>
  floor.kind === 'pass' ? undefined : [...new Set(floor.findings.map((f) => `${f.rule} at ${f.callPath}`))].join(', ');

function verdictCauses(outcome: Facts['outcome']): Reason | undefined {
  if (outcome.kind === 'no-card' || outcome.kind === 'no-template') return undefined;
  if (outcome.kind === 'error') return { key: 'error', detail: outcome.message };
  const { verdict } = outcome;
  if (verdict.kind === 'MATCH') return undefined;
  return {
    key: `${verdict.kind.toLowerCase()}: ${verdict.causes.map((c) => c.check).join('+')}`,
    detail:
      verdict.causes.length === 1
        ? (verdict.causes[0]?.details[0] ?? '')
        : verdict.causes.map((c) => `${c.check}: ${c.details[0] ?? ''}`).join('; '),
  };
}

/** Why a past transaction is not MATCH, first row that applies. A MATCH has no reason, whatever the rows say. */
export const REASONS: readonly { readonly key: string; readonly decide: (facts: Facts) => string | undefined }[] = [
  {
    key: 'refused-by-design',
    decide: ({ floor }) => floorRules(floor),
  },
  { key: 'no-card-yet', decide: ({ outcome }) => (outcome.kind === 'no-card' ? 'no card file, so no template covers it yet' : undefined) },
  {
    key: 'no-template',
    decide: ({ outcome }) => (outcome.kind === 'no-template' ? `the card names ${outcome.ids.join(', ')}, which origin/main does not hold` : undefined),
  },
];

export function reasonFor(facts: Facts): Reason | undefined {
  if (facts.outcome.kind === 'verdict' && facts.outcome.verdict.kind === 'MATCH') return undefined;
  for (const { key, decide } of REASONS) {
    const detail = decide(facts);
    if (detail !== undefined) return { key, detail };
  }
  return verdictCauses(facts.outcome);
}

/**
 * The reason of an approval without a card that a later nonce spends: the spender's, since the approval is half of that
 * operation. A spender without a reason, a MATCH, leaves the approval its own.
 */
export function spentReason(own: Reason | undefined, spender: { readonly nonce: number; readonly reason: Reason | undefined }): Reason | undefined {
  if (own?.key !== 'no-card-yet' || spender.reason === undefined) return own;
  return { key: spender.reason.key, detail: `its approval is spent by nonce ${spender.nonce}: ${spender.reason.detail}` };
}
