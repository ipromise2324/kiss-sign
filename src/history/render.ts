import { WIDTH, padTo, paint, wrap } from '../cli/format.ts';
import type { Paint } from '../cli/format.ts';
import type { Labels } from '../cli/labels.ts';
import type { Reason } from './reasons.ts';

export type Row = {
  readonly nonce: number;
  readonly date: string;
  readonly intent: string;
  readonly verdict: 'MATCH' | 'MISMATCH' | 'UNVERIFIABLE' | 'ERROR' | 'not run';
  readonly reason: Reason | undefined;
  readonly note: string | undefined;
  /** Absent without a card; otherwise who supplied the values the signer did not confirm. */
  readonly card: string | undefined;
};

export type Report = {
  readonly commit: string;
  readonly templates: readonly { readonly id: string; readonly hash: string }[];
  /** How many registry entries came from `history/registry.json`. */
  readonly overlay: number;
  readonly rows: readonly Row[];
};

type HistoryWords = Labels['history'];

const reasonText = (row: Row, H: HistoryWords): string =>
  [row.reason === undefined ? '' : `${row.reason.key}: ${row.reason.detail}`, row.note === undefined ? '' : `${H.note}: ${row.note}`]
    .filter((part) => part !== '')
    .join('; ');

function header(report: Report, H: HistoryWords): string[] {
  const used = report.templates.length === 0 ? H.noneUsed : report.templates.map((t) => `${t.id} ${t.hash}`).join(', ');
  return [H.count(report.rows.length), H.approved(report.commit, used), H.cards, H.registry(report.overlay)];
}

function summary(rows: readonly Row[]): { key: string; nonces: number[] }[] {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const key = row.reason?.key ?? row.verdict;
    groups.set(key, [...(groups.get(key) ?? []), row.nonce]);
  }
  const order = (key: string) => (key === 'MATCH' ? 0 : 1);
  return [...groups].map(([key, nonces]) => ({ key, nonces })).sort((a, b) => order(a.key) - order(b.key) || b.nonces.length - a.nonces.length || (a.key < b.key ? -1 : 1));
}

const VERDICT_PAINT = { MATCH: 'ok', MISMATCH: 'bad', UNVERIFIABLE: 'warn', ERROR: 'warn', 'not run': 'dim' } as const;

/** A long line wrapped at the terminal's width, each further line indented two more spaces. */
const hanging = (line: string, indent: number): string[] =>
  wrap(line, WIDTH - indent - 2).map((part, i) => `${' '.repeat(i === 0 ? indent : indent + 2)}${part}`);

export function renderText(report: Report, H: HistoryWords, p: Paint = paint(false)): string {
  const { date, verdict, intent } = H.columns;
  const lines = [...header(report, H).flatMap((line) => hanging(line, 0)), '', p.heading(['nonce', padTo(date, 10), padTo(verdict, 12), intent].join('  '))];
  for (const row of report.rows) {
    const verdict = p[VERDICT_PAINT[row.verdict]](row.verdict.padEnd(12));
    lines.push(`${String(row.nonce).padStart(5)}  ${row.date.padEnd(10)}  ${verdict}  ${row.intent}`);
    const reason = reasonText(row, H);
    if (reason !== '') lines.push(...hanging(reason, 33));
    if (row.card !== undefined) lines.push(...hanging(`${H.columns.card}: ${row.card}`, 33));
  }
  lines.push('', p.heading(H.summary));
  for (const { key, nonces } of summary(report.rows)) lines.push(`  ${key.padEnd(28)} ${String(nonces.length).padStart(4)}  ${nonces.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

const cell = (text: string): string => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMarkdown(report: Report, H: HistoryWords): string {
  const c = H.columns;
  const lines = [`# ${H.title}`, '', ...header(report, H).map((line) => `${line}  `), ''];
  lines.push(`| nonce | ${c.date} | ${c.intent} | ${c.verdict} | ${c.reason} | ${c.card} |`, '| ---: | --- | --- | --- | --- | --- |');
  for (const row of report.rows) {
    lines.push(`| ${row.nonce} | ${row.date} | ${cell(row.intent)} | ${row.verdict} | ${cell(reasonText(row, H))} | ${cell(row.card ?? '')} |`);
  }
  lines.push('', `## ${H.summary}`, '', `| ${c.result} | ${c.count} | nonces |`, '| --- | ---: | --- |');
  for (const { key, nonces } of summary(report.rows)) lines.push(`| ${cell(key)} | ${nonces.length} | ${nonces.join(', ')} |`);
  return `${lines.join('\n')}\n`;
}
