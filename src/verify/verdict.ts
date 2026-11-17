import type { EngineChecks } from '../floor/summary.ts';
import type { FloorResult } from '../floor/floor.ts';
import type { Registry } from '../registry.ts';
import type { Hex } from '../safe/types.ts';
import { describeFinding } from '../simulate/effects.ts';
import type { Asset } from '../simulate/effects.ts';

/** A template's hash as read from origin/main, and the hash the signer approved, absent when never approved. */
export type TemplateApproval = { readonly template: string; readonly hash: Hex; readonly approved: Hex | undefined };

/** `not-needed` when the card names nothing the check reads, such as a vault's asset on a card with no vault. */
export type ChainCheck =
  | { readonly kind: 'pass' }
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'mismatch'; readonly findings: readonly string[] }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

export type AllChecks = EngineChecks & { readonly approvals: readonly TemplateApproval[]; readonly assets: ChainCheck; readonly code: ChainCheck };

export type CheckName = 'template-approval' | 'static-floor' | 'fields' | 'vault-asset' | 'contract-code' | 'mutation' | 'simulation' | 'simulated-floor' | 'effects';

/**
 * How one check ended, as the page shows it: `not-run` when it could not run because another check failed or could not
 * finish, `not-needed` when the card gives it nothing to check.
 */
export type CheckState = 'passed' | 'failed' | 'unverifiable' | 'not-run' | 'not-needed';

/** `skip` decides nothing; a `not-run` cause still keeps the verdict from MATCH. */
type Outcome =
  | { readonly kind: 'pass' }
  | { readonly kind: 'skip'; readonly state: 'not-run' | 'not-needed' }
  | { readonly kind: 'fail' | 'unverifiable'; readonly details: readonly string[]; readonly notRun?: true };

/** decimals() of each asset a balance finding names, so it reads in whole tokens; one missing is shown in base units. */
export type FindingDecimals = ReadonlyMap<Asset, number>;

export type Cause = { readonly check: CheckName; readonly details: readonly string[] };

export type Verdict =
  | { readonly kind: 'MATCH' }
  | { readonly kind: 'MISMATCH' | 'UNVERIFIABLE'; readonly causes: readonly Cause[] };

const PASS: Outcome = { kind: 'pass' };
const outcome = (kind: 'fail' | 'unverifiable', details: readonly string[]): Outcome => (details.length === 0 ? PASS : { kind, details });

const chain = (check: ChainCheck): Outcome =>
  check.kind === 'pass'
    ? PASS
    : check.kind === 'not-needed'
      ? { kind: 'skip', state: 'not-needed' }
      : check.kind === 'mismatch'
        ? outcome('fail', check.findings)
        : outcome('unverifiable', check.reasons);

const NOT_RUN: Outcome = { kind: 'skip', state: 'not-run' };

const floor = (result: FloorResult): Outcome =>
  result.kind === 'pass' ? PASS : outcome('fail', result.findings.map((f) => `${f.rule} at ${f.callPath}: ${f.detail}`));

function approval(approvals: readonly TemplateApproval[]): Outcome {
  const changed = approvals.filter((a) => a.approved !== undefined && a.approved !== a.hash);
  if (changed.length > 0) {
    return outcome('fail', changed.map((a) => `${a.template} hashes to ${a.hash}, the approved hash is ${a.approved}`));
  }
  return outcome(
    'unverifiable',
    approvals.filter((a) => a.approved === undefined).map((a) => `${a.template} was never approved; run pnpm kiss-sign template approve ${a.template}`),
  );
}

/**
 * One row per check: how its result reads as pass, fail, or unverifiable. Any fail makes the verdict MISMATCH, else
 * any unverifiable makes it UNVERIFIABLE, else MATCH.
 */
const ROWS: readonly (readonly [CheckName, (checks: AllChecks, registry: Registry, decimals: FindingDecimals) => Outcome])[] = [
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
  ['vault-asset', ({ assets }) => chain(assets)],
  ['contract-code', ({ code }) => chain(code)],
  [
    'mutation',
    ({ mutation }) => {
      if (mutation.kind === 'pass') return PASS;
      if (mutation.kind === 'not-run') return { kind: 'unverifiable', details: ['not run, because the fields did not match'], notRun: true };
      return outcome('unverifiable', mutation.uncaught.map((u) => `a change to ${u.leaf.callPath} ${u.leaf.arg} gave ${u.mutated}, not a mismatch`));
    },
  ],
  ['simulation', ({ simulation }) => (simulation.kind === 'unverifiable' ? outcome('unverifiable', simulation.reasons) : PASS)],
  ['simulated-floor', ({ simulation }) => (simulation.kind === 'observed' ? floor(simulation.floor) : NOT_RUN)],
  [
    'effects',
    ({ simulation }, registry, decimals) => {
      if (simulation.kind !== 'observed') return NOT_RUN;
      const { effects } = simulation;
      if (effects.kind === 'match') return PASS;
      if (effects.kind === 'unverifiable') return outcome('unverifiable', effects.reasons);
      return outcome('fail', effects.findings.map((f) => describeFinding(f, registry, decimals)));
    },
  ],
];

const outcomes = (checks: AllChecks, registry: Registry, decimals: FindingDecimals) => ROWS.map(([check, judge]) => ({ check, result: judge(checks, registry, decimals) }));

export function decideVerdict(checks: AllChecks, registry: Registry, decimals: FindingDecimals = new Map()): Verdict {
  const rows = outcomes(checks, registry, decimals);
  for (const kind of ['fail', 'unverifiable'] as const) {
    const causes = rows.flatMap(({ check, result }) => (result.kind === kind ? [{ check, details: result.details }] : []));
    if (causes.length > 0) return { kind: kind === 'fail' ? 'MISMATCH' : 'UNVERIFIABLE', causes };
  }
  return { kind: 'MATCH' };
}

const STATE: Readonly<Record<Exclude<Outcome['kind'], 'skip'>, CheckState>> = { pass: 'passed', fail: 'failed', unverifiable: 'unverifiable' };

/** Each check's state, for the page. */
export function checkStates(checks: AllChecks, registry: Registry): Readonly<Record<CheckName, CheckState>> {
  const stateOf = (result: Outcome): CheckState => (result.kind === 'skip' ? result.state : 'notRun' in result ? 'not-run' : STATE[result.kind]);
  return Object.fromEntries(outcomes(checks, registry, new Map()).map(({ check, result }) => [check, stateOf(result)])) as Record<CheckName, CheckState>;
}
