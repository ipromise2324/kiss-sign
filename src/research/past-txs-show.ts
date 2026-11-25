import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Template } from '../template/template.ts';
import type { PastTxsSummary } from './past-txs-summary.ts';
import type { Kept } from './past-txs.ts';
import { functionNames, misfitText } from './study.ts';

const senderText = (study: Kept): string => ('sender' in study ? `${study.sender.kind} ${checksumAddress(study.sender.address)}` : study.kind === 'unproven' ? `contract ${checksumAddress(study.contract)}` : '');

/** How the study ended, which the totals group by: a fit with a place outside the registry is not exactly the template. */
const outcome = (study: Kept): string => `${study.kind === 'fit' ? (study.outside.length === 0 ? 'exact' : 'fit, outside the registry') : study.kind}${'sender' in study ? ` from ${study.sender.kind === 'safe' ? 'a Safe' : 'an EOA'}` : ''}`;

/**
 * A recorded summary in short: its query, how many transactions ended each way, and each transaction that fits
 * or misfits on a line of its own, Safes' first, with its hash, block, sender and why it does not fit; with `tx`, the start of a hash, only those, each with
 * every value the study read and its traced calls.
 */
export function showSummary(summary: PastTxsSummary, template: Template, registry: Registry, tx?: string): string {
  const names = functionNames(template);
  const why = (study: Kept): string =>
    study.kind === 'misfit'
      ? misfitText(study.reason, registry, names)
      : study.kind === 'fit'
        ? study.outside.map((o) => `${o.kind} outside the registry at ${o.at}`).join(', ')
        : study.kind === 'unproven' || study.kind === 'not-studied'
          ? study.why
          : study.reason;
  const line = (study: Kept): string => [study.hash, 'block' in study && study.block !== undefined ? String(study.block) : '-', outcome(study), senderText(study), why(study)].filter((part) => part !== '').join('  ');
  if (tx !== undefined) {
    const found = summary.studies.filter((study) => study.hash.startsWith(tx.toLowerCase()));
    return found
      .flatMap((study) => [
        line(study),
        ...('time' in study && study.time !== undefined ? [`  block time ${study.time}`] : []),
        ...(study.kind === 'fit' ? study.paths.map((path, i) => `  ${path} = ${study.values[i]}`) : []),
        ...(study.kind === 'misfit' ? study.free.map((value) => `  free field ${value.field} = ${value.value}`) : []),
        ...summary.traces.filter((trace) => trace.hash === study.hash).flatMap((trace) => (trace.kind === 'traced' ? trace.calls.map((call) => `  trace ${JSON.stringify(call, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}`) : [`  no trace: ${trace.why}`])),
      ])
      .map((text) => `${text}\n`)
      .join('');
  }
  const totals = new Map<string, number>();
  for (const study of summary.studies) totals.set(outcome(study), (totals.get(outcome(study)) ?? 0) + 1);
  const listed = summary.studies.filter((study) => study.kind !== 'not-studied' && study.kind !== 'unproven');
  const order = (study: Kept): number => ['exact from a Safe', 'fit, outside the registry from a Safe', 'misfit from a Safe', 'exact from an EOA'].indexOf(outcome(study)) + 1 || 9;
  return [
    `query ${JSON.stringify(summary.query)}`,
    `traces ${summary.traces.length}`,
    ...[...totals].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n} ${kind}`),
    ...listed.sort((a, b) => order(a) - order(b)).map(line),
    '',
  ].join('\n');
}
