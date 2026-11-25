import { join } from 'node:path';
import { LANGUAGES } from '../language.ts';
import type { Language } from '../language.ts';
import type { RegistryEntry } from '../registry.ts';
import { LENGTH, LIMITS, TRACED, argumentTree, fileLanguages, isRecord, notesPath, notesScope, own, ownedEntries, readJson, readNotes } from './notes.ts';
import type { ArgNode } from './notes.ts';
import { toReview } from './report-page.ts';
import type { HtmlInputs } from './report-page.ts';

/** A JSON value whose empty strings are the texts still to write. */
type Json = string | readonly Json[] | { readonly [key: string]: Json };

/** One thing `--render` requires, at `path` in `file`: its whole shape with empty texts, and what asks for it. */
type Requirement = { readonly file: string; readonly path: readonly [string, ...string[]]; readonly shape: Json; readonly from: string; readonly limit: string };

export type NotesNeeded = {
  readonly languages: Readonly<Record<string, readonly Language[]>>;
  /** Each notes file's missing texts, nested as the file nests them. */
  readonly skeleton: Readonly<Record<string, Json>>;
  /** What asks for each missing key and the length it may have. */
  readonly about: Readonly<Record<string, string>>;
  /** Every result under To review, written or not, with the program's current words for it. */
  readonly toReview: Readonly<Record<string, string>>;
  /** Keys a file holds that `--render` refuses because this report has no such result, argument or protocol. */
  readonly remove: readonly string[];
};

const chars = (max: number, languages: readonly Language[]): string => languages.map((l) => `${l} ${max * LENGTH[l]}`).join(', ');

/** The part of `shape` that `held` leaves empty or out, or undefined when it holds it all. */
function gap(shape: Json, held: unknown): Json | undefined {
  if (typeof shape === 'string') return typeof held === 'string' ? (held.trim() === '' ? shape : undefined) : held === undefined ? shape : undefined;
  if (Array.isArray(shape)) {
    const items = Array.isArray(held) ? held : [];
    const gaps = shape.map((item, i) => gap(item, items[i]));
    return Array.isArray(held) && gaps.every((g) => g === undefined) ? undefined : gaps.map((g) => g ?? {});
  }
  const record = isRecord(held) ? held : {};
  const gaps = Object.entries(shape).flatMap(([key, value]) => {
    const missing = gap(value, own(record, key));
    return missing === undefined ? [] : [[key, missing] as const];
  });
  return isRecord(held) && gaps.length === 0 ? undefined : Object.fromEntries(gaps);
}

const at = (raw: unknown, path: readonly string[]): unknown => path.reduce<unknown>((value, key) => (isRecord(value) ? own(value, key) : undefined), raw);

function put(tree: Record<string, unknown>, [key, ...rest]: readonly [string, ...string[]], value: Json): void {
  const [next, ...more] = rest;
  if (next === undefined) tree[key] = value;
  else put((isRecord(tree[key]) ? tree[key] : (tree[key] = {})) as Record<string, unknown>, [next, ...more], value);
}

/** Each text an unwritten `notes.json` needs for `--render` to accept it, from the report's recorded inputs and the notes as they stand. */
export function notesNeeded(repoRoot: string, inputs: HtmlInputs, signer: readonly Language[]): NotesNeeded {
  const { template, vault } = inputs.subject;
  const shared = notesPath(repoRoot, template.id);
  const mine = vault === undefined ? shared : notesPath(repoRoot, template.id, vault.name);
  const raws = new Map([...new Set([shared, mine])].map((file) => [file, readJson(join(repoRoot, file))]));
  const languages = new Map([...raws].map(([file, raw]) => [file, fileLanguages(raw, file) ?? signer] as const));
  const held = (file: string) => languages.get(file) as readonly Language[];
  const merged = readNotes(repoRoot, template.id, vault);
  const flow = isRecord(merged) && own(merged, 'flow') !== undefined ? merged : undefined;
  const page = LANGUAGES.find((l) => held(shared).includes(l) && held(mine).includes(l)) ?? (held(mine)[0] as Language);
  const { ledger, rows } = toReview(inputs, page, flow);
  const scope = notesScope(inputs, ledger, template, page);
  const owner = entryFiles(shared, mine, vault);

  const empty = (file: string): Json => Object.fromEntries(held(file).map((l) => [l, '']));
  const upTo = (file: string, max: number) => chars(max, held(file));
  const need = (file: string, path: Requirement['path'], from: string, limit: string, shape: Json): Requirement => ({ file, path, shape, from, limit });
  const text = (file: string, path: Requirement['path'], from: string, max: number): Requirement => need(file, path, from, upTo(file, max), empty(file));
  const hacks = new Map((inputs.facts?.protocols ?? []).map((sheet) => [sheet.slug, sheet.hacks] as const));

  const named: readonly Requirement[] = [
    text(shared, ['title'], 'the page title', LIMITS.title),
    text(shared, ['summary'], 'the page summary', LIMITS.summary),
    need(mine, ['verdict'], 'your advice; status is safe or caution', upTo(mine, LIMITS.verdict), { status: '', text: empty(mine) }),
    ...[...scope.protocols].map(([slug, count]) => {
      const listed = hacks.get(slug) ?? [];
      const incidents = count === 'unread' ? [] : Array.from({ length: count }, (): Json => ({ text: empty(shared) }));
      const dated = listed.map((hack) => `${hack.date}${hack.amount === undefined ? '' : ` ${hack.amount} USD`}`).join(', ');
      return need(shared, ['protocols', slug], `the protocol facts; incidents in order: ${dated === '' ? 'none' : dated}`, `intro ${upTo(shared, LIMITS.intro)}; each note ${upTo(shared, LIMITS.protocolNote)}`, {
        intro: empty(shared),
        audits: { text: empty(shared) },
        incidents,
      });
    }),
    ...argumentTree(template).flatMap((call) => call.args.flatMap(withParts)).map((node) => text(shared, ['fields', node.key], `an argument, its rule: ${node.rule.kind}`, LIMITS.field)),
    ...rows.map(({ id, title, why }) => {
      const file = owner(id);
      return need(file, ['reviews', id], `${title}: ${why}; status is confirmed or concern`, `text ${upTo(file, LIMITS.review)}; recommendation ${upTo(file, LIMITS.recommendation)}`, { status: '', text: empty(file), recommendation: empty(file) });
    }),
    ...[...scope.routed].map((name) => {
      const file = owner(name);
      return need(file, ['entries', name], "its routes' history; result is pass, attention or fail", `role ${upTo(file, LIMITS.role)}; each source ${upTo(file, LIMITS.entrySource)}`, { role: empty(file), sources: [{ text: empty(file), url: '', result: '' }] });
    }),
  ];

  const bare = ['protocols', 'fields', 'reviews'].filter((key) => !named.some((r) => r.path[0] === key));
  const requirements = [...named, ...bare.map((key) => need(shared, [key], 'required though this report has none', 'an empty object', {}))];

  const skeleton: Record<string, Record<string, unknown>> = {};
  const about: Record<string, string> = {};
  for (const { file, path, shape, from, limit } of requirements) {
    const written = [file, ...raws.keys()].map((f) => at(raws.get(f), path)).find((value) => value !== undefined);
    const missing = gap(shape, written);
    if (missing === undefined) continue;
    put((skeleton[file] ??= {}), path, missing);
    about[path.join(' ')] = `${from} [${limit}]`;
  }

  const known: Readonly<Record<string, ReadonlySet<string>>> = { reviews: new Set(scope.reviews), fields: new Set(scope.fields), protocols: new Set(scope.protocols.keys()), entries: scope.entries };
  const remove = [...raws].flatMap(([file, raw]) =>
    Object.entries(known).flatMap(([key, names]) => Object.keys((isRecord(at(raw, [key])) ? at(raw, [key]) : {}) as object).flatMap((name) => (names.has(name) ? [] : [`${file} ${key} ${name}`]))),
  );
  return {
    languages: Object.fromEntries(languages),
    skeleton: skeleton as Readonly<Record<string, Json>>,
    about,
    toReview: Object.fromEntries(rows.map(({ id, state, title, why }) => [id, `${state === 'bad' ? 'red' : 'amber'}: ${title}: ${why}`])),
    remove,
  };
}

const withParts = (node: ArgNode): ArgNode[] => [node, ...node.children.flatMap(withParts)];

/** The file a review or an entry goes in: the instance's for what it alone owns and for the call traces' results, else the template's. */
const entryFiles =
  (shared: string, mine: string, vault: RegistryEntry | undefined) =>
  (id: string): string =>
    vault !== undefined && (TRACED.test(id) || ownedEntries(vault).has(id.split('/')[0] as string)) ? mine : shared;
