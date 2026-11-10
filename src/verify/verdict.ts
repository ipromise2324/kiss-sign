import type { EngineChecks } from '../floor/summary.ts';
import type { FloorResult } from '../floor/floor.ts';
import type { Registry } from '../registry.ts';
import type { Hex } from '../safe/types.ts';
import { describeFinding } from '../simulate/effects.ts';
import type { AssetCheck } from './assets.ts';

/** A template's hash as read from origin/main, and the hash the signer approved, absent when never approved. */
export type TemplateApproval = { readonly template: string; readonly hash: Hex; readonly approved: Hex | undefined };

export type AllChecks = EngineChecks & { readonly approvals: readonly TemplateApproval[]; readonly assets: AssetCheck };

export type CheckName = 'template-approval' | 'static-floor' | 'fields' | 'vault-asset' | 'mutation' | 'simulation' | 'simulated-floor' | 'effects';

type Outcome = { readonly kind: 'pass' } | { readonly kind: 'fail' | 'unverifiable'; readonly details: readonly string[] };

export type Cause = { readonly check: CheckName; readonly details: readonly string[] };

export type Verdict =
  | { readonly kind: 'MATCH' }
  | { readonly kind: 'MISMATCH' | 'UNVERIFIABLE'; readonly causes: readonly Cause[] };

const PASS: Outcome = { kind: 'pass' };
const outcome = (kind: 'fail' | 'unverifiable', details: readonly string[]): Outcome => (details.length === 0 ? PASS : { kind, details });

const floor = (result: FloorResult): Outcome =>
  result.kind === 'pass' ? PASS : outcome('fail', result.findings.map((f) => `${f.rule} at ${f.callPath}: ${f.detail}`));

function approval(approvals: readonly TemplateApproval[]): Outcome {
  const changed = approvals.filter((a) => a.approved !== undefined && a.approved !== a.hash);
  if (changed.length > 0) {
    return outcome('fail', changed.map((a) => `${a.template} hashes to ${a.hash}, the approved hash is ${a.approved}`));
  }
  return outcome(
    'unverifiable',
    approvals.filter((a) => a.approved === undefined).map((a) => `${a.template} was never approved; run kiss-sign template approve ${a.template}`),
  );
}

/**
 * One row per check: how its result reads as pass, fail, or unverifiable. Any fail makes the verdict MISMATCH, else
 * any unverifiable makes it UNVERIFIABLE, else MATCH.
 */
const ROWS: readonly (readonly [CheckName, (checks: AllChecks, registry: Registry) => Outcome])[] = [
  ['template-approval', (c) => approval(c.approvals)],
  ['static-floor', (c) => floor(c.staticFloor)],
  [
    'fields',
    ({ fields }) => {
      if (fields.kind === 'match') return PASS;
      if (fields.kind === 'unverifiable') return outcome('unverifiable', fields.reasons);
      return outcome('fail', fields.findings.map((f) => `${f.callPath} ${f.arg}: expected ${f.expected}, got ${f.actual}`));
    },
  ],
  [
    'vault-asset',
    ({ assets }) => (assets.kind === 'pass' ? PASS : assets.kind === 'mismatch' ? outcome('fail', assets.findings) : outcome('unverifiable', assets.reasons)),
  ],
  [
    'mutation',
    ({ mutation }) => {
      if (mutation.kind === 'pass') return PASS;
      if (mutation.kind === 'not-run') return outcome('unverifiable', ['not run, because the fields did not match']);
      return outcome('unverifiable', mutation.uncaught.map((u) => `a change to ${u.leaf.callPath} ${u.leaf.arg} gave ${u.mutated}, not a mismatch`));
    },
  ],
  ['simulation', ({ simulation }) => (simulation.kind === 'unverifiable' ? outcome('unverifiable', simulation.reasons) : PASS)],
  ['simulated-floor', ({ simulation }) => (simulation.kind === 'observed' ? floor(simulation.floor) : PASS)],
  [
    'effects',
    ({ simulation }, registry) => {
      if (simulation.kind !== 'observed' || simulation.effects.kind === 'match') return PASS;
      const { effects } = simulation;
      if (effects.kind === 'unverifiable') return outcome('unverifiable', effects.reasons);
      return outcome('fail', effects.findings.map((f) => describeFinding(f, registry)));
    },
  ],
];

export function decideVerdict(checks: AllChecks, registry: Registry): Verdict {
  const rows = ROWS.map(([check, judge]) => ({ check, result: judge(checks, registry) }));
  for (const kind of ['fail', 'unverifiable'] as const) {
    const causes = rows.flatMap(({ check, result }) => (result.kind === kind ? [{ check, details: result.details }] : []));
    if (causes.length > 0) return { kind: kind === 'fail' ? 'MISMATCH' : 'UNVERIFIABLE', causes };
  }
  return { kind: 'MATCH' };
}
