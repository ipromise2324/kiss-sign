import { join } from 'node:path';
import { TEMPLATES_DIR } from '../template/template.ts';
import { NOTES_FILE, NotesError, readNotes } from './notes.ts';
import type { ReportInputs } from './report.ts';

export const GENERATED_HTML_FILE = 'report.generated.html';
export const generatedHtmlPath = (template: string): string => join(TEMPLATES_DIR, template, GENERATED_HTML_FILE);

/** The template's HTML report as the program writes it from the recordings and `notes.json`; undefined without notes. */
export function generatedHtml(repoRoot: string, inputs: ReportInputs): string | undefined {
  const { subject } = inputs;
  if (subject.kind !== 'template' || readNotes(repoRoot, subject.template.id) === undefined) return undefined;
  throw new NotesError(`${subject.template.id}/${NOTES_FILE}: this program writes no HTML report yet`);
}

/** Up to 160 characters of a line from where it first differs, quoted so no control character reaches the terminal. */
const quoted = (line: string | undefined, at: number): string => {
  if (line === undefined) return 'nothing';
  const start = Math.max(0, at - 60);
  return JSON.stringify(`${start > 0 ? '…' : ''}${line.slice(start, start + 160)}${start + 160 < line.length ? '…' : ''}`);
};

/** Where the committed HTML report differs from what the program writes, byte for byte, or undefined when it does not. */
export function htmlDifference(committed: string | undefined, written: string | undefined): string | undefined {
  if (committed === written) return undefined;
  if (committed === undefined) return `there is ${NOTES_FILE} but no committed ${GENERATED_HTML_FILE}`;
  if (written === undefined) return `${GENERATED_HTML_FILE} is committed but there is no ${NOTES_FILE} to write it from`;
  const [was, now] = [committed.split('\n'), written.split('\n')];
  const at = was.findIndex((line, i) => line !== now[i]);
  const line = at === -1 ? was.length : at;
  const [a, b] = [was[line] ?? '', now[line] ?? ''];
  let column = 0;
  while (column < a.length && a[column] === b[column]) column++;
  return `line ${line + 1}: committed ${quoted(was[line], column)}, the program writes ${quoted(now[line], column)}`;
}
