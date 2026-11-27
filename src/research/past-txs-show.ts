import { replayReader } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import type { Registry } from '../registry.ts';
import type { Hex } from '../safe/types.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Template } from '../template/template.ts';
import type { PastTxsSummary } from './past-txs-summary.ts';
import type { Kept } from './past-txs.ts';
import { EXEC_TRANSACTION, safeExecutionLine } from './safe-nonce.ts';
import { plain, quoted } from './shown.ts';
import { impliedCard } from './implied-card.ts';
import { functionNames, misfitText, shapesOf } from './study.ts';

const senderText = (study: Kept): string => ('sender' in study ? `${study.sender.kind} ${checksumAddress(study.sender.address)}` : study.kind === 'unproven' ? `contract ${checksumAddress(study.contract)}` : '');

/** How the study ended, which the totals group by: a fit with a place outside the registry is not exactly the template. */
const outcome = (study: Kept): string => `${study.kind === 'fit' ? (study.outside.length === 0 ? 'exact' : 'fit, outside the registry') : study.kind}${'sender' in study ? ` from ${study.sender.kind === 'safe' ? 'a Safe' : 'an EOA'}` : ''}`;

/**
 * The card a fit implies, as `pnpm template implied-card` prints it for a fixture: of the whole template for a Safe, of
 * the one call an EOA made, with `safe` naming the EOA.
 */
function impliedLines(fit: Extract<Kept, { kind: 'fit' }>, template: Template, registry: Registry): string[] {
  const shapes = shapesOf(template);
  const shape = fit.sender.kind === 'safe' ? shapes.whole : shapes.calls[fit.sender.call];
  if (shape === undefined) return [];
  const implied = impliedCard(template, shape.loosened.rules, fit.values, fit.sender.address, registry);
  return [
    `  implied card ${plain(JSON.stringify(implied.card))}${fit.sender.kind === 'eoa' ? `, of call ${fit.sender.call + 1} alone, with safe the EOA` : ''}`,
    ...(implied.book.size > 0 ? [`  implied book ${plain(JSON.stringify(Object.fromEntries(implied.book)))}`] : []),
    ...implied.missing.map(({ field, why }) => `  implied card lacks ${field}: ${plain(why)}`),
  ];
}

/**
 * A recorded summary in short: its query, how many transactions ended each way, and each transaction that fits
 * or misfits on a line of its own, Safes' first, with its hash, block, sender and why it does not fit; with `tx`, the start of a hash, only those, each with
 * every value the study read, the card a fit implies, its traced calls, and `executions`' line of each Safe transaction.
 * The card pairs the summary's values with the rules of `template` by position, so with `stale`, why the checkout's
 * template, registry or study code is not what the summary was studied with, the card is left out for that line.
 */
export function showSummary(summary: PastTxsSummary, template: Template, registry: Registry, tx?: string, executions: ReadonlyMap<Hex, string> = new Map(), stale?: string): string {
  const names = functionNames(template);
  const why = (study: Kept): string =>
    study.kind === 'misfit'
      ? plain(misfitText(study.reason, registry, names))
      : study.kind === 'fit'
        ? study.outside.map((o) => `${o.kind} outside the registry at ${o.at}`).join(', ')
        : study.kind === 'unproven' || study.kind === 'not-studied'
          ? study.why
          : quoted(study.reason, Infinity);
  const line = (study: Kept): string => [study.hash, 'block' in study && study.block !== undefined ? String(study.block) : '-', outcome(study), senderText(study), why(study)].filter((part) => part !== '').join('  ');
  if (tx !== undefined) {
    const found = summary.studies.filter((study) => study.hash.startsWith(tx.toLowerCase()));
    return found
      .flatMap((study) => [
        line(study),
        ...('time' in study && study.time !== undefined ? [`  block time ${study.time}`] : []),
        ...(executions.has(study.hash) ? [`  ${executions.get(study.hash)}`] : []),
        ...(study.kind === 'fit' ? study.paths.map((path, i) => `  ${path} = ${quoted(study.values[i], Infinity)}`) : []),
        ...(study.kind !== 'fit' ? [] : stale === undefined ? impliedLines(study, template, registry) : [`  no implied card: ${plain(stale)}`]),
        ...(study.kind === 'misfit' ? study.free.map((value) => `  free field ${value.field} = ${quoted(value.value, Infinity)}`) : []),
        ...summary.traces.filter((trace) => trace.hash === study.hash).flatMap((trace) => (trace.kind === 'traced' ? trace.calls.map((call) => `  trace ${plain(JSON.stringify(call, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v)))}`) : [`  no trace: ${quoted(trace.why, Infinity)}`])),
      ])
      .map((text) => `${text}\n`)
      .join('');
  }
  const totals = new Map<string, number>();
  for (const study of summary.studies) totals.set(outcome(study), (totals.get(outcome(study)) ?? 0) + 1);
  const listed = summary.studies.filter((study) => study.kind !== 'not-studied' && study.kind !== 'unproven');
  const order = (study: Kept): number => ['exact from a Safe', 'fit, outside the registry from a Safe', 'misfit from a Safe', 'exact from an EOA'].indexOf(outcome(study)) + 1 || 9;
  return [
    `query ${plain(JSON.stringify(summary.query))}`,
    `traces ${summary.traces.length}`,
    ...[...totals].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n} ${kind}`),
    ...listed.sort((a, b) => order(a) - order(b)).map(line),
    '',
  ].join('\n');
}

/**
 * The Safe nonce and safeTxHash of each Safe transaction among `hashes`, read offline from a recording's transaction
 * and receipt; a transaction the recording does not hold both of is left out.
 */
export async function safeExecutions(exchanges: readonly Exchange[], hashes: readonly Hex[]): Promise<Map<Hex, string>> {
  const reader = replayReader(exchanges);
  const lines = new Map<Hex, string>();
  for (const hash of hashes) {
    const [tx, receipt] = await Promise.all([reader.getTransaction(hash), reader.getTransactionReceipt(hash)]).catch(() => [undefined, undefined] as const);
    const sent = tx?.kind === 'agreed' ? tx.value : null;
    const logs = receipt?.kind === 'agreed' ? receipt.value?.logs : undefined;
    if (sent === null || sent.to === null || logs === undefined || !sent.input.startsWith(EXEC_TRANSACTION.selector)) continue;
    lines.set(hash, safeExecutionLine(sent.to, sent.input, logs));
  }
  return lines;
}
