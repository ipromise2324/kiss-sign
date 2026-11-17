import { WIDTH, paint, wrap } from '../cli/format.ts';
import type { Paint } from '../cli/format.ts';
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

const reasonText = (row: Row): string =>
  [row.reason === undefined ? '' : `${row.reason.key}: ${row.reason.detail}`, row.note === undefined ? '' : `note: ${row.note}`]
    .filter((part) => part !== '')
    .join('; ');

function header(report: Report): string[] {
  const used = report.templates.length === 0 ? 'none used' : report.templates.map((t) => `${t.id} ${t.hash}`).join(', ');
  return [
    `Safe history: ${report.rows.length} executed transactions, run through the verify checks.`,
    `Templates are approved at their origin/main hash (${report.commit}) for this run only, since history is not a signing: ${used}.`,
    `Cards come from history/cards and are hashed as sealed cards; values the signer did not confirm are marked.`,
    `Registry: registry/contracts.json at that commit${report.overlay === 0 ? '' : `, plus ${report.overlay} local entries from history/registry.json`}.`,
  ];
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

export function renderText(report: Report, p: Paint = paint(false)): string {
  const lines = [...header(report).flatMap((line) => hanging(line, 0)), '', p.heading('nonce  date        verdict       intent')];
  for (const row of report.rows) {
    const verdict = p[VERDICT_PAINT[row.verdict]](row.verdict.padEnd(12));
    lines.push(`${String(row.nonce).padStart(5)}  ${row.date.padEnd(10)}  ${verdict}  ${row.intent}`);
    const reason = reasonText(row);
    if (reason !== '') lines.push(...hanging(reason, 33));
    if (row.card !== undefined) lines.push(...hanging(`card: ${row.card}`, 33));
  }
  lines.push('', p.heading('Summary'));
  for (const { key, nonces } of summary(report.rows)) lines.push(`  ${key.padEnd(28)} ${String(nonces.length).padStart(4)}  ${nonces.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

const cell = (text: string): string => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMarkdown(report: Report): string {
  const lines = ['# Safe history coverage', '', ...header(report).map((line) => `${line}  `), ''];
  lines.push('| nonce | date | intent | verdict | reason | card |', '| ---: | --- | --- | --- | --- | --- |');
  for (const row of report.rows) {
    lines.push(`| ${row.nonce} | ${row.date} | ${cell(row.intent)} | ${row.verdict} | ${cell(reasonText(row))} | ${cell(row.card ?? '')} |`);
  }
  lines.push('', '## Summary', '', '| result | count | nonces |', '| --- | ---: | --- |');
  for (const { key, nonces } of summary(report.rows)) lines.push(`| ${cell(key)} | ${nonces.length} | ${nonces.join(', ')} |`);
  return `${lines.join('\n')}\n`;
}
