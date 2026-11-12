import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATES_DIR } from '../template/template.ts';

export const NOTES_FILE = 'notes.json';

export class NotesError extends Error {
  override name = 'NotesError';
}

export const notesPath = (template: string): string => join(TEMPLATES_DIR, template, NOTES_FILE);

/** The changed files that hold text the AI wrote for a template's HTML report, which no program checks. */
export const notesChanges = (changed: readonly string[]): string[] => changed.filter((file) => /^templates\/[^/]+\/[^/]+\/notes\.json$/.test(file));

/** The template's notes as JSON, or undefined when it has none. */
export function readNotes(repoRoot: string, template: string): unknown {
  const path = join(repoRoot, notesPath(template));
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined;
}
