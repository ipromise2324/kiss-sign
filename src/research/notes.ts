import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHttpsUrl } from '../registry.ts';
import type { HttpsUrl } from '../registry.ts';
import { TEMPLATES_DIR } from '../template/template.ts';

export const NOTES_FILE = 'notes.json';

/** One thing the AI says, with the pages it read it on. */
export type Note = { readonly title: string | undefined; readonly text: string; readonly sources: readonly HttpsUrl[] };

/**
 * What the AI wrote for a template's HTML report, in the signer's language. The program shows every piece as written by
 * the AI and decides nothing from it.
 */
export type Notes = {
  /** The report's heading: the operation in a few words. */
  readonly title: string;
  readonly summary: string;
  /** What the transaction does, step by step. */
  readonly steps: readonly string[];
  /** What the AI asks the signer to judge, beside the program's findings. */
  readonly judgments: readonly Note[];
  /** By registry name: the entry's role in this operation, and what else the AI found about it. */
  readonly entries: ReadonlyMap<string, { readonly role: string | undefined; readonly notes: readonly Note[] }>;
  /** By field key, as the report's field table names it, such as `1.approve.spender`: what the field means. */
  readonly fields: ReadonlyMap<string, string>;
  /** The test transactions and what the past transactions taught. */
  readonly tests: readonly Note[];
  /** Folded groups at the end, such as where each contract was deployed from. */
  readonly details: readonly { readonly title: string; readonly notes: readonly Note[] }[];
};

export class NotesError extends Error {
  override name = 'NotesError';
}

const MAX_TEXT = 2000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function keys(path: string, raw: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw)) throw new NotesError(`${path}: not a JSON object`);
  const extra = Object.keys(raw).find((k) => !required.includes(k) && !optional.includes(k));
  if (extra !== undefined) throw new NotesError(`${path}: unknown key ${JSON.stringify(extra.slice(0, 80))}`);
  const missing = required.find((k) => !(k in raw));
  if (missing !== undefined) throw new NotesError(`${path}: ${missing} is missing`);
  return raw;
}

function text(path: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new NotesError(`${path}: not a non-empty string`);
  if (raw.length > MAX_TEXT) throw new NotesError(`${path}: longer than ${MAX_TEXT} characters`);
  if (CONTROL.test(raw)) throw new NotesError(`${path}: holds a control or bidirectional character`);
  return raw;
}

function list<T>(path: string, raw: unknown, item: (path: string, raw: unknown) => T): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new NotesError(`${path}: not a list`);
  return raw.map((r, i) => item(`${path}[${i}]`, r));
}

function note(path: string, raw: unknown): Note {
  const value = keys(path, raw, ['text'], ['title', 'sources']);
  const sources = list(`${path}.sources`, value.sources, (at, url) => {
    const parsed = parseHttpsUrl(url);
    if (parsed === undefined) throw new NotesError(`${at}: not an https URL in RFC 3986 characters`);
    return parsed;
  });
  return { title: value.title === undefined ? undefined : text(`${path}.title`, value.title), text: text(`${path}.text`, value.text), sources };
}

function byName<T>(path: string, raw: unknown, known: ReadonlySet<string>, what: string, item: (path: string, raw: unknown) => T): Map<string, T> {
  if (raw === undefined) return new Map();
  if (!isRecord(raw)) throw new NotesError(`${path}: not a JSON object`);
  return new Map(
    Object.entries(raw).map(([name, value]) => {
      if (!known.has(name)) throw new NotesError(`${path}: ${JSON.stringify(name.slice(0, 80))} is not ${what}`);
      return [name, item(`${path}.${name}`, value)];
    }),
  );
}

/**
 * `notes.json`, refused unless every key is known: `entries` may name only the registry entries the report covers, and
 * `fields` only the keys of the report's field table.
 */
export function parseNotes(raw: unknown, known: { readonly entries: ReadonlySet<string>; readonly fields: ReadonlySet<string> }): Notes {
  const value = keys(NOTES_FILE, raw, ['title', 'summary', 'steps'], ['judgments', 'entries', 'fields', 'tests', 'details']);
  return {
    title: text(`${NOTES_FILE}.title`, value.title),
    summary: text(`${NOTES_FILE}.summary`, value.summary),
    steps: list(`${NOTES_FILE}.steps`, value.steps, text),
    judgments: list(`${NOTES_FILE}.judgments`, value.judgments, note),
    entries: byName(`${NOTES_FILE}.entries`, value.entries, known.entries, 'a registry entry this report covers', (path, entry) => {
      const fields = keys(path, entry, [], ['role', 'notes']);
      return { role: fields.role === undefined ? undefined : text(`${path}.role`, fields.role), notes: list(`${path}.notes`, fields.notes, note) };
    }),
    fields: byName(`${NOTES_FILE}.fields`, value.fields, known.fields, "a key of the report's field table", text),
    tests: list(`${NOTES_FILE}.tests`, value.tests, note),
    details: list(`${NOTES_FILE}.details`, value.details, (path, group) => {
      const fields = keys(path, group, ['title', 'notes'], []);
      return { title: text(`${path}.title`, fields.title), notes: list(`${path}.notes`, fields.notes, note) };
    }),
  };
}

export const notesPath = (template: string): string => join(TEMPLATES_DIR, template, NOTES_FILE);

/** The template's notes as JSON, or undefined when it has none. */
export function readNotes(repoRoot: string, template: string): unknown {
  const path = join(repoRoot, notesPath(template));
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined;
}
