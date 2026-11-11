import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHttpsUrl } from '../registry.ts';
import type { HttpsUrl } from '../registry.ts';
import { TEMPLATES_DIR } from '../template/template.ts';

export const NOTES_FILE = 'notes.json';

/** One thing the AI says, with the pages it read it on. */
export type Note = { readonly title: string | undefined; readonly text: string; readonly sources: readonly HttpsUrl[] };

/** Something the AI asks the signer to judge, and what it recommends. */
export type Judgment = Note & { readonly recommendation: string };

/**
 * The AI's check of one program result the signer must look at. `confirmed` only when the AI checked the exact thing the
 * result names and it agrees: for an address the program did not find on a source page, that page showed that address;
 * for a code span, the code at that block. Evidence about anything else, however strong, is `concern`, as is a check
 * the AI could not make. The program shows it under the result and never changes the result for it.
 */
export type Review = { readonly status: 'confirmed' | 'concern'; readonly text: string; readonly recommendation: string };

/** One line the AI adds to the transaction's flow, after the template's call `after` (1-based): a step inside that call. */
export type FlowLine = { readonly after: number; readonly text: string };

/** The AI's one-line conclusion: `safe` when it found nothing to worry about, `caution` otherwise. It never changes a program result. */
export type Verdict = { readonly status: 'safe' | 'caution'; readonly text: string };

/**
 * What the AI wrote for a template's HTML report, in the signer's language. The program shows every piece as written by
 * the AI and decides nothing from it.
 */
export type Notes = {
  /** The report's heading: the operation in a few words, at most 100 characters. */
  readonly title: string;
  readonly summary: string;
  /** What happens inside the template's calls, which the program cannot see: a few short lines, each placed after its call. */
  readonly flow: readonly FlowLine[];
  /** What the past transactions and the tests showed, in one line. */
  readonly pastTxsConclusion: Verdict | undefined;
  /** The AI's overall view of the operation's risk, in one line, and what it recommends. */
  readonly verdict: (Verdict & { readonly recommendation: string }) | undefined;
  /** What the AI asks the signer to judge, beside the program's findings: a few, each a sentence or two. */
  readonly judgments: readonly Judgment[];
  /**
   * By result id, `<registry name>/<check key>` or a fixture's `fixture.<name>`: the AI's review of that result. Every
   * result the signer must look at needs one, and no other result may have one.
   */
  readonly reviews: ReadonlyMap<string, Review>;
  /** The protocol at a glance, each line a short label and a sentence or two: upgrades and admin, audits, incidents, size. */
  readonly overview: readonly Note[];
  /**
   * By registry name: the entry's role in this operation, what else the AI found about it, and by check key, such as
   * `source.page`, one line the page shows under that program result. A line explains a result; it cannot hide one.
   */
  readonly entries: ReadonlyMap<string, EntryNotes>;
  /** By field key, as the report's field table names it, such as `1.approve.spender`: what the field means. */
  readonly fields: ReadonlyMap<string, string>;
  /** What the test transactions showed beyond what the program states: a few short lines. */
  readonly tests: readonly Note[];
  /** Folded groups at the end, such as where each contract was deployed from. */
  readonly details: readonly { readonly title: string; readonly notes: readonly Note[] }[];
};

export type EntryNotes = { readonly role: string | undefined; readonly notes: readonly Note[]; readonly checks: ReadonlyMap<string, string> };

export class NotesError extends Error {
  override name = 'NotesError';
}

const MAX_TEXT = 2000;
/** The page lists judgments and test lines above the fold, so each stays a sentence or two. */
const MAX_SHORT = 200;
const MAX_JUDGMENTS = 4;
const MAX_TESTS = 2;
const MAX_OVERVIEW = 6;
const MAX_REVIEW = 300;
/** Flow lines and verdicts sit at the top of the page, so each stays one short line. */
const MAX_LINE = 100;
const MAX_FLOW = 4;
const CHECK_KEY = /^[A-Za-z0-9_.-]{1,120}$/;
const RESULT_ID = /^[A-Za-z0-9_.-]{1,80}(?:\/[A-Za-z0-9_.-]{1,120})?$/;
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

function text(path: string, raw: unknown, max = MAX_TEXT): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new NotesError(`${path}: not a non-empty string`);
  if (raw.length > max) throw new NotesError(`${path}: longer than ${max} characters`);
  if (CONTROL.test(raw)) throw new NotesError(`${path}: holds a control or bidirectional character`);
  return raw;
}

function list<T>(path: string, raw: unknown, item: (path: string, raw: unknown) => T, max = Infinity): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new NotesError(`${path}: not a list`);
  if (raw.length > max) throw new NotesError(`${path}: more than ${max} items`);
  return raw.map((r, i) => item(`${path}[${i}]`, r));
}

function note(path: string, raw: unknown, max = MAX_TEXT): Note {
  const value = keys(path, raw, ['text'], ['title', 'sources']);
  const sources = list(`${path}.sources`, value.sources, (at, url) => {
    const parsed = parseHttpsUrl(url);
    if (parsed === undefined) throw new NotesError(`${at}: not an https URL in RFC 3986 characters`);
    return parsed;
  });
  return { title: value.title === undefined ? undefined : text(`${path}.title`, value.title, MAX_SHORT), text: text(`${path}.text`, value.text, max), sources };
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

const short = (path: string, raw: unknown): Note => note(path, raw, MAX_SHORT);

function judgment(path: string, raw: unknown): Judgment {
  const { recommendation, ...rest } = keys(path, raw, ['text', 'recommendation'], ['title', 'sources']);
  return { ...note(path, rest, MAX_SHORT), recommendation: text(`${path}.recommendation`, recommendation, MAX_SHORT) };
}

function review(path: string, raw: unknown): Review {
  const value = keys(path, raw, ['status', 'text', 'recommendation'], []);
  if (value.status !== 'confirmed' && value.status !== 'concern') throw new NotesError(`${path}.status: not "confirmed" or "concern"`);
  return { status: value.status, text: text(`${path}.text`, value.text, MAX_REVIEW), recommendation: text(`${path}.recommendation`, value.recommendation, MAX_SHORT) };
}

function flowLine(path: string, raw: unknown, calls: number): FlowLine {
  const value = keys(path, raw, ['after', 'text'], []);
  if (typeof value.after !== 'number' || !Number.isInteger(value.after) || value.after < 1 || value.after > calls) {
    throw new NotesError(`${path}.after: not the number of one of the template's ${calls} calls`);
  }
  return { after: value.after, text: text(`${path}.text`, value.text, MAX_LINE) };
}

function verdictStatus(path: string, raw: unknown): Verdict['status'] {
  if (raw !== 'safe' && raw !== 'caution') throw new NotesError(`${path}: not "safe" or "caution"`);
  return raw;
}

function conclusion(path: string, raw: unknown): Verdict {
  const value = keys(path, raw, ['status', 'text'], []);
  return { status: verdictStatus(`${path}.status`, value.status), text: text(`${path}.text`, value.text, MAX_LINE) };
}

function verdict(path: string, raw: unknown): Verdict & { readonly recommendation: string } {
  const value = keys(path, raw, ['status', 'text', 'recommendation'], []);
  return { ...conclusion(path, { status: value.status, text: value.text }), recommendation: text(`${path}.recommendation`, value.recommendation, MAX_LINE) };
}

function overviewItem(path: string, raw: unknown): Note {
  const item = note(path, raw, MAX_SHORT);
  if (item.title === undefined) throw new NotesError(`${path}: title is missing`);
  return item;
}

/**
 * `notes.json`, refused unless every key is known: `entries` may name only the registry entries the report covers, and
 * `fields` only the keys of the report's field table, and `flow` only the template's `calls`.
 */
export function parseNotes(raw: unknown, known: { readonly entries: ReadonlySet<string>; readonly fields: ReadonlySet<string>; readonly calls: number }): Notes {
  const value = keys(NOTES_FILE, raw, ['title', 'summary'], ['flow', 'pastTxsConclusion', 'verdict', 'judgments', 'reviews', 'overview', 'entries', 'fields', 'tests', 'details']);
  const reviews = value.reviews === undefined ? {} : value.reviews;
  if (!isRecord(reviews)) throw new NotesError(`${NOTES_FILE}.reviews: not a JSON object`);
  return {
    title: text(`${NOTES_FILE}.title`, value.title, MAX_LINE),
    summary: text(`${NOTES_FILE}.summary`, value.summary),
    flow: list(`${NOTES_FILE}.flow`, value.flow, (path, line) => flowLine(path, line, known.calls), MAX_FLOW),
    pastTxsConclusion: value.pastTxsConclusion === undefined ? undefined : conclusion(`${NOTES_FILE}.pastTxsConclusion`, value.pastTxsConclusion),
    verdict: value.verdict === undefined ? undefined : verdict(`${NOTES_FILE}.verdict`, value.verdict),
    judgments: list(`${NOTES_FILE}.judgments`, value.judgments, judgment, MAX_JUDGMENTS),
    reviews: new Map(
      Object.entries(reviews).map(([id, item]) => {
        if (!RESULT_ID.test(id)) throw new NotesError(`${NOTES_FILE}.reviews: ${JSON.stringify(id.slice(0, 80))} is not a result id`);
        return [id, review(`${NOTES_FILE}.reviews.${id}`, item)];
      }),
    ),
    overview: list(`${NOTES_FILE}.overview`, value.overview, overviewItem, MAX_OVERVIEW),
    entries: byName(`${NOTES_FILE}.entries`, value.entries, known.entries, 'a registry entry this report covers', (path, entry) => {
      const fields = keys(path, entry, [], ['role', 'notes', 'checks']);
      const checks = fields.checks === undefined ? {} : fields.checks;
      if (!isRecord(checks)) throw new NotesError(`${path}.checks: not a JSON object`);
      return {
        role: fields.role === undefined ? undefined : text(`${path}.role`, fields.role, MAX_SHORT),
        notes: list(`${path}.notes`, fields.notes, note),
        checks: new Map(
          Object.entries(checks).map(([key, line]) => {
            if (!CHECK_KEY.test(key)) throw new NotesError(`${path}.checks: ${JSON.stringify(key.slice(0, 80))} is not a check key`);
            return [key, text(`${path}.checks.${key}`, line, MAX_SHORT)];
          }),
        ),
      };
    }),
    fields: byName(`${NOTES_FILE}.fields`, value.fields, known.fields, "a key of the report's field table", text),
    tests: list(`${NOTES_FILE}.tests`, value.tests, short, MAX_TESTS),
    details: list(`${NOTES_FILE}.details`, value.details, (path, group) => {
      const fields = keys(path, group, ['title', 'notes'], []);
      return { title: text(`${path}.title`, fields.title), notes: list(`${path}.notes`, fields.notes, note) };
    }),
  };
}

export const notesPath = (template: string): string => join(TEMPLATES_DIR, template, NOTES_FILE);

/** The changed files that hold text the AI wrote for a template's HTML report, which no program checks. */
export const notesChanges = (changed: readonly string[]): string[] => changed.filter((file) => /^templates\/[^/]+\/[^/]+\/notes\.json$/.test(file));

/** The template's notes as JSON, or undefined when it has none. */
export function readNotes(repoRoot: string, template: string): unknown {
  const path = join(repoRoot, notesPath(template));
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined;
}
