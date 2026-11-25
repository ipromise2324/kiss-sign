import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paramName, parseFunctionSignature } from '../decode/abi.ts';
import type { AbiParam } from '../decode/abi.ts';
import { LANGUAGES } from '../language.ts';
import type { Language } from '../language.ts';
import { parseHttpsUrl } from '../registry.ts';
import type { HttpsUrl, RegistryEntry } from '../registry.ts';
import { TEMPLATES_DIR, callSites, callTargetEntries, effectTokenNames, refNames, viewTargetNames } from '../template/template.ts';
import type { CallNode, Rule, Template } from '../template/template.ts';
import { needsSigner } from './ledger.ts';
import { factsScope } from './protocol-facts.ts';
import type { Ledger, ResultId } from './ledger.ts';
import { instanceReportDir } from './report.ts';
import type { ReportInputs } from './report.ts';

export const NOTES_FILE = 'notes.json';

export class NotesError extends Error {
  override name = 'NotesError';
}

/** The template's notes, or with `instance` the notes of that instance's report of it. */
export const notesPath = (repoRoot: string, template: string, instance?: string): string =>
  join(instance === undefined ? join(TEMPLATES_DIR, template) : instanceReportDir(template, instance), NOTES_FILE);

const readJson = (path: string): unknown => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined);

/**
 * What a vault's notes may hold: the text about that vault alone, and `flow` lines, which name the vault or its asset
 * and so differ per vault. Everything else every vault's report shares.
 */
const VAULT_KEYS: readonly string[] = ['verdict', 'flow', 'judgments', 'reviews', 'entries', 'pastTxsConclusion', 'context'];
/** Keys about one instance alone, which only its own notes may hold. */
const INSTANCE_ONLY: readonly string[] = ['context'];
/** Lists both files may add to, joined: the limit on their length counts both. */
const JOINED = ['flow', 'judgments'];
const KEYED = ['reviews', 'entries'];

/**
 * The template's notes and a vault's, as one: each key once, except that `flow` and `judgments` join and `reviews` and `entries`
 * join by name. A vault's notes may hold only `VAULT_KEYS`, may review and describe only the entries in `owned`, the
 * vault, the entries its attributes name and those it depends on, and the call traces' results, and a key or name both define is refused. A template's `flow` line that
 * names an entry in `owned` is refused, since another vault's report could not name it.
 */
/** The results the call traces give, which a vault's notes review, since each vault's report traces only its own recordings. */
const TRACED = /^(flow|trace)\./;

export function mergeNotes(shared: unknown, vault: unknown, vaultPath: string, owned: ReadonlySet<string>): unknown {
  const flow = isRecord(shared) ? own(shared, 'flow') : undefined;
  const named = Array.isArray(flow) ? flow.flatMap((line) => (isRecord(line) ? [own(line, 'from'), own(line, 'to')] : [])).find((name) => owned.has(name as string)) : undefined;
  if (named !== undefined) refuse(`${NOTES_FILE}.flow`, `${shown(String(named))} differs per vault; its flow line belongs in ${vaultPath}`);
  if (vault === undefined || !isRecord(shared)) return shared;
  if (!isRecord(vault)) return refuse(vaultPath, 'not a JSON object');
  const merged: Record<string, unknown> = { ...shared };
  for (const key of Object.keys(vault)) {
    const value = own(vault, key);
    if (!VAULT_KEYS.includes(key)) refuse(vaultPath, `${shown(key)} belongs in the template's ${NOTES_FILE}, which every vault's report shares`);
    if (KEYED.includes(key) && isRecord(value)) {
      const other = Object.keys(value).find((name) => !(key === 'reviews' && TRACED.test(name)) && !owned.has(key === 'reviews' ? name.split('/')[0]! : name));
      if (other !== undefined) refuse(`${vaultPath}.${key}`, `${shown(other)} is not the vault or an entry it names (${[...owned].join(', ')}); a shared contract belongs in the template's ${NOTES_FILE}`);
    }
    const before = own(shared, key);
    if (before === undefined) merged[key] = value;
    else if (JOINED.includes(key) && Array.isArray(before) && Array.isArray(value)) merged[key] = [...before, ...value];
    else if (KEYED.includes(key) && isRecord(before) && isRecord(value)) {
      const twice = Object.keys(value).find((name) => own(before, name) !== undefined);
      if (twice !== undefined) refuse(`${vaultPath}.${key}`, `${shown(twice)} is in the template's ${NOTES_FILE} too`);
      merged[key] = { ...before, ...value };
    } else refuse(vaultPath, `${key} is in the template's ${NOTES_FILE} too`);
  }
  return merged;
}

/** Whether a notes value is one AI text: an object keyed by languages alone. */
const isText = (raw: unknown): raw is Record<string, unknown> => isRecord(raw) && Object.keys(raw).length > 0 && Object.keys(raw).every((key) => (LANGUAGES as readonly string[]).includes(key));

/** The languages every text of one notes file holds, in `LANGUAGES` order, undefined with no text; a file whose texts differ is refused. */
function fileLanguages(raw: unknown, path: string): readonly Language[] | undefined {
  const sets = new Set<string>();
  const walk = (value: unknown): void => {
    if (isText(value)) sets.add(LANGUAGES.filter((language) => own(value, language) !== undefined).join(' and '));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (isRecord(value)) Object.values(value).forEach(walk);
  };
  walk(raw);
  if (sets.size > 1) refuse(path, `holds texts in ${[...sets].join(', in ')}; every text in one file holds the same languages`);
  const [only] = sets;
  return only === undefined ? undefined : LANGUAGES.filter((language) => only.split(' and ').includes(language));
}

/** The notes with every text cut to `keep`. */
const keepLanguages = (raw: unknown, keep: readonly Language[]): unknown =>
  isText(raw)
    ? Object.fromEntries(keep.map((language) => [language, own(raw, language)]))
    : Array.isArray(raw)
      ? raw.map((value) => keepLanguages(value, keep))
      : isRecord(raw)
        ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, keepLanguages(value, keep)]))
        : raw;

/**
 * The template's notes and a vault's, each cut to the languages both hold, so a vault's notes in the signer's one
 * language join a template's in both. Refused when they share none.
 */
export function joinLanguages(shared: unknown, vault: unknown, sharedPath: string, vaultPath: string): readonly [unknown, unknown] {
  const [ours, theirs] = [fileLanguages(shared, sharedPath), fileLanguages(vault, vaultPath)];
  if (ours === undefined || theirs === undefined) return [shared, vault];
  const both = ours.filter((language) => theirs.includes(language));
  if (both.length === 0) refuse(vaultPath, `holds ${theirs.join(' and ')} and ${sharedPath} holds ${ours.join(' and ')}; a vault's report is written in a language both hold`);
  return [keepLanguages(shared, both), keepLanguages(vault, both)];
}

/**
 * The notes a report reads, as JSON: the template's, merged with the vault's for a per-vault report, both in the
 * languages both hold; undefined without the template's.
 */
export function readNotes(repoRoot: string, template: string, vault?: RegistryEntry): unknown {
  const sharedPath = notesPath(repoRoot, template);
  const shared = readJson(join(repoRoot, sharedPath));
  const instanceKey = isRecord(shared) ? INSTANCE_ONLY.find((key) => own(shared, key) !== undefined) : undefined;
  if (instanceKey !== undefined) refuse(`${sharedPath}.${instanceKey}`, "is about one instance; it belongs in that instance's notes.json");
  if (vault === undefined) return shared;
  const path = notesPath(repoRoot, template, vault.name);
  const [ours, theirs] = joinLanguages(shared, readJson(join(repoRoot, path)), sharedPath, path);
  return mergeNotes(ours, theirs, path, new Set([vault.name, ...Object.values(vault.attributes), ...(vault.dependsOn ?? [])]));
}

/** What notes.json may name and must name, derived from the template, the report's inputs and its ledger. */
export type NotesScope = {
  /** How many calls the template makes: a `flow` line's `after` is one of 1..calls. */
  readonly calls: number;
  /** The registry names a call or an effects' view targets, the entries those depend on, and the tokens the effects move: a `flow` line's `from` and `to`. */
  readonly contracts: ReadonlySet<string>;
  /**
   * Each call nested in a template call, such as a Bundler3 bundle item: the call number, the names the top-level call's
   * target and the nested call's target can be, and its selector. The template binds it, so no `flow` line may name it.
   */
  readonly nested: readonly { readonly after: number; readonly from: readonly string[]; readonly to: readonly string[] | undefined; readonly selector: string }[];
  /** The registry entries the report covers; `entries` may name any of them. */
  readonly entries: ReadonlySet<string>;
  /** The covered entries with `routes`, each of which `entries` must describe, with a role and its sources. */
  readonly routed: ReadonlySet<string>;
  /** Each covered protocol by DefiLlama slug, every one required, with the hacks DefiLlama lists, or `unread`. */
  readonly protocols: ReadonlyMap<string, number | 'unread'>;
  /** Every argument and tuple part's field key, in page order, every one required. */
  readonly fields: readonly string[];
  /** The results the signer must look at, in ledger order, every one required. */
  readonly reviews: readonly ResultId[];
  /** The language the page is written in, one of those the notes hold. */
  readonly language: Language;
};

/** The scope a text is parsed in: the report's, and the languages its notes hold. */
type Scope = NotesScope & { readonly held: readonly Language[] };

/** One argument, tuple part, array item or nested call's argument of a template call, with its HTML report field key. */
export type ArgNode = {
  readonly key: string;
  readonly name: string;
  readonly param: AbiParam | undefined;
  readonly rule: Rule;
  /** Tuple parts, array items, a nested call's arguments, packed parts, or a signed message's members. */
  readonly children: readonly ArgNode[];
};

/**
 * Each function call of the template, by its 1-based call number, with its arguments as a tree in call order. A key is
 * `<call>.<function>.<argument>`, a part after a dot (`2.blueBundlesV1Supply.marketParams.oracle`), an item in brackets,
 * and a nested call's arguments after its function's name (`1.multicall.bundle[1].data.erc4626Deposit.assets`).
 */
export function argumentTree(template: Template): { readonly n: number; readonly node: CallNode; readonly args: readonly ArgNode[] }[] {
  const call = (prefix: string, node: CallNode): ArgNode[] => node.fn.params.map((param, i) => arg(`${prefix}.${paramName(param, i)}`, paramName(param, i), node.args[i] as Rule, param));
  const arg = (key: string, name: string, rule: Rule, param: AbiParam | undefined): ArgNode => {
    if (rule.kind === 'call') return { key, name, param, rule, children: call(`${key}.${rule.call.fn.name}`, rule.call) };
    if (rule.kind === 'items') {
      const item = param?.type.kind === 'array' || param?.type.kind === 'fixed-array' ? { name: undefined, type: param.type.item } : undefined;
      return { key, name, param, rule, children: rule.items.map((r, i) => arg(`${key}[${i}]`, `[${i}]`, r, item)) };
    }
    if (rule.kind === 'fields') {
      const components = param?.type.kind === 'tuple' ? param.type.components : [];
      return {
        key,
        name,
        param,
        rule,
        children: rule.fields.map((r, i) => {
          const part = components[i] === undefined ? String(i) : paramName(components[i], i);
          return arg(`${key}.${part}`, part, r, components[i]);
        }),
      };
    }
    if (rule.kind === 'packed') return { key, name, param, rule, children: rule.parts.map((part) => arg(`${key}.${part.name}`, part.name, part.rule, { name: part.name, type: part.type })) };
    if (rule.kind === 'eip712') {
      const { struct, fields } = rule.message;
      return { key, name, param, rule, children: struct.members.map((member, i) => arg(`${key}.${member.name}`, member.name as string, fields[i] as Rule, member)) };
    }
    return { key, name, param, rule, children: [] };
  };
  return template.calls.flatMap((c, i) => (c.data === 'empty' ? [] : [{ n: i + 1, node: c.data, args: call(`${i + 1}.${c.data.fn.name}`, c.data) }]));
}

/** Every key of `argumentTree`, depth first: every argument and tuple part notes.json's `fields` must explain. */
export function fieldKeys(template: Template): string[] {
  const keys = (nodes: readonly ArgNode[]): string[] => nodes.flatMap((node) => [node.key, ...keys(node.children)]);
  return argumentTree(template).flatMap((call) => keys(call.args));
}

function nestedCalls(template: Template, registry: ReportInputs['registry']): NotesScope['nested'] {
  const sites = callSites(template, registry);
  return sites.flatMap((site) => {
    const top = sites.find((s) => s.call === site.call && !s.nested);
    return site.nested ? [{ after: site.call + 1, from: top?.names ?? [], to: site.names, selector: site.fn.selector }] : [];
  });
}

export function notesScope(inputs: ReportInputs, ledger: Ledger, template: Template, language: Language): NotesScope {
  const { registry } = inputs;
  const protocols: Map<string, number | 'unread'> =
    inputs.facts === undefined
      ? new Map(factsScope(template, registry, ledger.entries).protocols.map(({ slug }) => [slug, 'unread']))
      : new Map(inputs.facts.protocols.map((sheet) => [sheet.slug, sheet.listing.kind === 'read' ? sheet.hacks.length : 'unread']));
  const targets = [...callTargetEntries(template, registry).map((entry) => entry.name), ...template.effects.views.flatMap((view) => viewTargetNames(view.to, template, registry))];
  return {
    calls: template.calls.length,
    contracts: new Set([
      ...targets,
      ...targets.flatMap((name) => registry.entries.get(name)?.dependsOn ?? []),
      ...[...template.effects.gives, ...template.effects.gets].flatMap((effect) => effectTokenNames(effect.token, template, registry)),
      ...template.effects.touches.map((touch) => touch.token),
    ]),
    nested: nestedCalls(template, registry),
    entries: new Set(ledger.entries.map((entry) => entry.name)),
    routed: new Set(ledger.entries.filter((entry) => entry.routes !== undefined).map((entry) => entry.name)),
    protocols,
    fields: fieldKeys(template),
    reviews: ledger.results.filter(needsSigner).map((result) => result.id),
    language,
  };
}

type P<T> = (path: string, raw: unknown, scope: Scope) => T;
type Opt<T> = { readonly optional: P<T>; readonly absent: T };
type Shape = Readonly<Record<string, P<unknown> | Opt<unknown>>>;
type Parsed<S extends Shape> = { readonly [K in keyof S]: S[K] extends Opt<infer T> ? T : S[K] extends P<infer T> ? T : never };

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
const refuse = (path: string, rule: string): never => {
  throw new NotesError(`${path}: ${rule}`);
};
const shown = (key: string): string => JSON.stringify(key.slice(0, 80));

/** What may stand between two backticks: one identifier, such as a function or argument name, with or without `()`. */
const CODE_SPAN = /^[A-Za-z_][A-Za-z0-9_]*(\(\))?$/;

/**
 * AI text split at its backticks: plain text at even positions, code spans at odd ones. Undefined when a backtick is
 * not closed or a span holds anything but one identifier.
 */
export function codeSpans(text: string): readonly string[] | undefined {
  const parts = text.split('`');
  return parts.length % 2 === 1 && parts.every((part, i) => i % 2 === 0 || CODE_SPAN.test(part)) ? parts : undefined;
}

const str =
  (max: number): P<string> =>
  (path, raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') return refuse(path, 'not a non-empty string');
    if (CONTROL.test(raw)) return refuse(path, 'holds a control or bidirectional character');
    const parts = codeSpans(raw);
    if (parts === undefined) return refuse(path, 'holds a backtick that does not open or close a code span around one identifier, such as `erc4626Deposit`');
    if (parts.join('').length > max) return refuse(path, `longer than ${max} characters`);
    return raw;
  };

/** How many characters a language may use for what Traditional Chinese says in `max`. */
const LENGTH: Readonly<Record<Language, number>> = { 'zh-TW': 1, en: 3 };
/** Chinese characters and full-width punctuation, which the English page must not show. */
const CHINESE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/u;

/**
 * AI text keyed by language, `{ "zh-TW": ... }` or `{ "en": ..., "zh-TW": ... }`, holding exactly the languages the notes
 * hold, each under its limit, the English with no Chinese; the page's language is returned.
 */
const text =
  (max: number): P<string> =>
  (path, raw, scope) => {
    const held = scope.held.join(' and ');
    if (!isRecord(raw)) return refuse(path, `not a JSON object with ${held}`);
    const extra = Object.keys(raw).find((key) => !(LANGUAGES as readonly string[]).includes(key));
    if (extra !== undefined) refuse(path, `${shown(extra)} is not a language; use ${LANGUAGES.join(' or ')}`);
    const other = Object.keys(raw).find((key) => !(scope.held as readonly string[]).includes(key));
    if (other !== undefined) refuse(path, `${other} is not in the title; every text holds the languages the title holds, ${held}`);
    const each = Object.fromEntries(
      scope.held.map((language) => {
        const value = own(raw, language);
        if (value === undefined) return refuse(path, `${language} is missing; every text holds the languages the title holds, ${held}`);
        const parsed = str(max * LENGTH[language])(`${path}.${language}`, value, scope);
        return [language, language === 'en' && CHINESE.test(parsed) ? refuse(`${path}.en`, 'holds Chinese characters or full-width punctuation') : parsed];
      }),
    ) as Record<Language, string>;
    return each[scope.language];
  };

const oneOf =
  <const T extends readonly string[]>(...values: T): P<T[number]> =>
  (path, raw) =>
    values.includes(raw as string) ? (raw as T[number]) : refuse(path, `not one of ${values.join(', ')}`);

const url: P<HttpsUrl> = (path, raw) => parseHttpsUrl(raw) ?? refuse(path, 'not an https URL in RFC 3986 characters');

const callNumber: P<number> = (path, raw, scope) =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 && raw <= scope.calls ? raw : refuse(path, `not one of the template's ${scope.calls} calls`);

/** A function's canonical signature, such as `approve(address,uint256)`, with the selector it hashes to. */
const signature: P<{ readonly signature: string; readonly selector: string }> = (path, raw, scope) => {
  const written = str(400)(path, raw, scope);
  let canonical: string | undefined;
  let selector = '';
  try {
    ({ signature: canonical, selector } = parseFunctionSignature(written));
  } catch {
    canonical = undefined;
  }
  return canonical === written ? { signature: written, selector } : refuse(path, 'not a canonical function signature, such as `approve(address,uint256)`');
};

const contract: P<string> = (path, raw, scope) => {
  const name = str(80)(path, raw, scope);
  return scope.contracts.has(name) ? name : refuse(path, `${shown(name)} is not a contract the calls or the effects' views target, an entry one of those depends on, nor a token the effects move`);
};

const list =
  <T>(item: P<T>, max = Infinity): P<readonly T[]> =>
  (path, raw, scope) => {
    if (!Array.isArray(raw)) return refuse(path, 'not a list');
    if (raw.length > max) return refuse(path, `more than ${max} items`);
    return raw.map((r, i) => item(`${path}[${i}]`, r, scope));
  };

const opt = <T>(p: P<T>): Opt<T | undefined> => ({ optional: p, absent: undefined });
const optList = <T>(item: P<T>, max?: number): Opt<readonly T[]> => ({ optional: list(item, max), absent: [] });

const obj =
  <S extends Shape>(shape: S): P<Parsed<S>> =>
  (path, raw, scope) => {
    if (!isRecord(raw)) return refuse(path, 'not a JSON object');
    const extra = Object.keys(raw).find((key) => !Object.hasOwn(shape, key));
    if (extra !== undefined) refuse(path, `unknown key ${shown(extra)}`);
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const value = own(raw, key);
      if (typeof field !== 'function') out[key] = value === undefined ? field.absent : field.optional(`${path}.${key}`, value, scope);
      else if (value === undefined) refuse(path, `${key} is missing`);
      else out[key] = field(`${path}.${key}`, value, scope);
    }
    return out as Parsed<S>;
  };

/** A JSON object keyed by names the scope allows, checked and returned in the scope's order. */
const keyed =
  <T>(allowed: (scope: Scope) => readonly string[], what: string, required: boolean, item: (key: string) => P<T>): P<ReadonlyMap<string, T>> =>
  (path, raw, scope) => {
    if (!isRecord(raw)) return refuse(path, 'not a JSON object');
    const names = allowed(scope);
    const extra = Object.keys(raw).find((key) => !names.includes(key));
    if (extra !== undefined) refuse(path, `${shown(extra)} is not ${what}`);
    const missing = required ? names.find((name) => own(raw, name) === undefined) : undefined;
    if (missing !== undefined) refuse(path, `${missing} is missing`);
    return new Map(names.filter((name) => own(raw, name) !== undefined).map((name) => [name, item(name)(`${path}.${name}`, own(raw, name), scope)]));
  };

const where =
  <T>(p: P<T>, check: (value: T, scope: Scope) => string | undefined): P<T> =>
  (path, raw, scope) => {
    const value = p(path, raw, scope);
    const problem = check(value, scope);
    return problem === undefined ? value : refuse(path, problem);
  };

const note = (max: number) => obj({ text: text(max), sources: optList(url) });

const protocolNotes = (slug: string) =>
  where(obj({ intro: text(200), audits: note(2000), incidents: list(note(2000)) }), (protocol, scope) => {
    const hacks = scope.protocols.get(slug);
    return hacks === 'unread' || protocol.incidents.length === hacks ? undefined : `incidents lists ${protocol.incidents.length}; DefiLlama lists ${hacks} hacks`;
  });

const FLOW = optList(
  where(obj({ after: callNumber, from: contract, to: contract, function: signature, text: text(100), sources: where(list(url), (sources) => (sources.length === 0 ? 'names no source: the contract source read and a past transaction checked' : undefined)) }), (line, scope) =>
    scope.nested.some((n) => n.after === line.after && n.selector === line.function.selector && n.from.includes(line.from) && (n.to === undefined || n.to.includes(line.to)))
      ? 'names a call the template binds itself, which the diagram draws from the template'
      : undefined,
  ),
  4,
);

const NOTES_FIELDS = obj({
  title: text(100),
  summary: text(2000),
  verdict: obj({ status: oneOf('safe', 'caution'), text: text(100) }),
  flow: FLOW,
  protocols: keyed((scope) => [...scope.protocols.keys()], 'a protocol the protocol facts cover', true, protocolNotes),
  judgments: optList(obj({ text: text(200), sources: optList(url), recommendation: text(200) }), 4),
  reviews: keyed((scope) => scope.reviews, 'a result the signer must look at', true, () =>
    obj({ status: oneOf('confirmed', 'concern'), text: text(300), recommendation: text(200) }),
  ),
  entries: opt(
    keyed((scope) => [...scope.entries], 'a registry entry this report covers', false, () =>
      obj({ role: opt(text(200)), sources: optList(obj({ text: text(200), url, result: oneOf('pass', 'attention', 'fail') })) }),
    ),
  ),
  fields: keyed((scope) => scope.fields, 'an argument of the template', true, () => text(2000)),
  times: optList(where(str(400), (key, scope) => (scope.fields.includes(key) ? undefined : `${shown(key)} is not an argument of the template`))),
  pastTxsConclusion: opt(text(200)),
  context: optList(obj({ title: text(40), text: text(400), sources: where(list(url), (sources) => (sources.length === 0 ? 'names no source' : undefined)) }), 4),
});

const NOTES_SCHEMA = where(NOTES_FIELDS, (notes, scope) => {
  const undescribed = [...scope.routed].find((name) => {
    const entry = notes.entries?.get(name);
    return entry?.role === undefined || entry.sources.length === 0;
  });
  return undescribed === undefined
    ? undefined
    : `entries.${undescribed} needs a role and at least one source: its routes reach only the implementations its seeds name, so list the history that shows a seed reaches every implementation still set`;
});

export type Notes = ReturnType<typeof NOTES_SCHEMA>;

/** The languages the notes are written in, in `LANGUAGES` order: those their `title` holds, which every text must hold. */
export function notesLanguages(raw: unknown): readonly Language[] {
  if (!isRecord(raw)) return refuse(NOTES_FILE, 'not a JSON object');
  const title = own(raw, 'title');
  if (title === undefined) return refuse(NOTES_FILE, 'title is missing');
  const held = isRecord(title) ? LANGUAGES.filter((language) => own(title, language) !== undefined) : [];
  return held.length > 0 ? held : refuse(`${NOTES_FILE}.title`, `not a JSON object with ${LANGUAGES.join(' or ')}, or both`);
}

/**
 * `notes.json` against its scope: every key in the schema, every name the scope requires present, no other name, and
 * every text in the languages the title holds, the page's among them.
 */
export function parseNotes(raw: unknown, scope: NotesScope): Notes {
  const held = notesLanguages(raw);
  if (!held.includes(scope.language)) refuse(`${NOTES_FILE}.title`, `holds no ${scope.language} text, so there is no ${scope.language} page to write`);
  return NOTES_SCHEMA(NOTES_FILE, raw, { ...scope, held });
}

/** The `flow` lines alone, parsed as `parseNotes` parses them, so the call traces can judge them before the reviews are read. */
export function parseFlowLines(raw: unknown, scope: NotesScope): Notes['flow'] {
  const held = notesLanguages(raw);
  const flow = isRecord(raw) ? own(raw, 'flow') : undefined;
  return flow === undefined ? FLOW.absent : FLOW.optional(`${NOTES_FILE}.flow`, flow, { ...scope, held });
}
