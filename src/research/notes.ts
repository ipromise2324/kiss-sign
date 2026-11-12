import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paramName } from '../decode/abi.ts';
import type { AbiParam } from '../decode/abi.ts';
import { parseHttpsUrl } from '../registry.ts';
import type { HttpsUrl } from '../registry.ts';
import { TEMPLATES_DIR, callTargetEntries } from '../template/template.ts';
import type { CallNode, Rule, Template } from '../template/template.ts';
import { needsSigner } from './ledger.ts';
import { factsScope } from './protocol-facts.ts';
import type { Ledger, ResultId } from './ledger.ts';
import type { ReportInputs } from './report.ts';

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

/** What notes.json may name and must name, derived from the template, the report's inputs and its ledger. */
export type NotesScope = {
  /** How many calls the template makes: a `flow` line's `after` is one of 1..calls. */
  readonly calls: number;
  /** The registry names a call or an effects' view targets: a `flow` line's `from` and `to`. */
  readonly contracts: ReadonlySet<string>;
  /** The registry entries the report covers; `entries` may name any of them. */
  readonly entries: ReadonlySet<string>;
  /** Each covered protocol by DefiLlama slug, every one required, with the hacks DefiLlama lists, or `unread`. */
  readonly protocols: ReadonlyMap<string, number | 'unread'>;
  /** Every argument and tuple part's field key, in page order, every one required. */
  readonly fields: readonly string[];
  /** The results the signer must look at, in ledger order, every one required. */
  readonly reviews: readonly ResultId[];
};

/** One argument, tuple part, array item or nested call's argument of a template call, with its HTML report field key. */
export type ArgNode = {
  readonly key: string;
  readonly name: string;
  readonly param: AbiParam | undefined;
  readonly rule: Rule;
  /** Tuple parts, array items, or a nested call's arguments. */
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
    return { key, name, param, rule, children: [] };
  };
  return template.calls.flatMap((c, i) => (c.data === 'empty' ? [] : [{ n: i + 1, node: c.data, args: call(`${i + 1}.${c.data.fn.name}`, c.data) }]));
}

/** Every key of `argumentTree`, depth first: every argument and tuple part notes.json's `fields` must explain. */
export function fieldKeys(template: Template): string[] {
  const keys = (nodes: readonly ArgNode[]): string[] => nodes.flatMap((node) => [node.key, ...keys(node.children)]);
  return argumentTree(template).flatMap((call) => keys(call.args));
}

export function notesScope(inputs: ReportInputs, ledger: Ledger, template: Template): NotesScope {
  const { registry } = inputs;
  const protocols: Map<string, number | 'unread'> =
    inputs.facts === undefined
      ? new Map(factsScope(template, registry, ledger.entries).protocols.map(({ slug }) => [slug, 'unread']))
      : new Map(inputs.facts.protocols.map((sheet) => [sheet.slug, sheet.listing.kind === 'read' ? sheet.hacks.length : 'unread']));
  return {
    calls: template.calls.length,
    contracts: new Set([...callTargetEntries(template, registry).map((entry) => entry.name), ...template.effects.views.map((view) => view.to)]),
    entries: new Set(ledger.entries.map((entry) => entry.name)),
    protocols,
    fields: fieldKeys(template),
    reviews: ledger.results.filter(needsSigner).map((result) => result.id),
  };
}

type P<T> = (path: string, raw: unknown, scope: NotesScope) => T;
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

const str =
  (max: number): P<string> =>
  (path, raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') return refuse(path, 'not a non-empty string');
    if (raw.length > max) return refuse(path, `longer than ${max} characters`);
    if (CONTROL.test(raw)) return refuse(path, 'holds a control or bidirectional character');
    return raw;
  };

const oneOf =
  <const T extends readonly string[]>(...values: T): P<T[number]> =>
  (path, raw) =>
    values.includes(raw as string) ? (raw as T[number]) : refuse(path, `not one of ${values.join(', ')}`);

const url: P<HttpsUrl> = (path, raw) => parseHttpsUrl(raw) ?? refuse(path, 'not an https URL in RFC 3986 characters');

const callNumber: P<number> = (path, raw, scope) =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 && raw <= scope.calls ? raw : refuse(path, `not one of the template's ${scope.calls} calls`);

const contract: P<string> = (path, raw, scope) => {
  const name = str(80)(path, raw, scope);
  return scope.contracts.has(name) ? name : refuse(path, `${shown(name)} is not a contract the calls or the effects' views target`);
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
  <T>(allowed: (scope: NotesScope) => readonly string[], what: string, required: boolean, item: (key: string) => P<T>): P<ReadonlyMap<string, T>> =>
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
  <T>(p: P<T>, check: (value: T, scope: NotesScope) => string | undefined): P<T> =>
  (path, raw, scope) => {
    const value = p(path, raw, scope);
    const problem = check(value, scope);
    return problem === undefined ? value : refuse(path, problem);
  };

const note = (max: number) => obj({ text: str(max), sources: optList(url) });

const protocolNotes = (slug: string) =>
  where(obj({ intro: str(200), audits: note(2000), incidents: list(note(2000)) }), (protocol, scope) => {
    const hacks = scope.protocols.get(slug);
    return hacks === 'unread' || protocol.incidents.length === hacks ? undefined : `incidents lists ${protocol.incidents.length}; DefiLlama lists ${hacks} hacks`;
  });

const NOTES_SCHEMA = obj({
  title: str(100),
  summary: str(2000),
  verdict: obj({ status: oneOf('safe', 'caution'), text: str(100) }),
  flow: optList(obj({ after: callNumber, from: contract, to: contract, text: str(100) }), 4),
  protocols: keyed((scope) => [...scope.protocols.keys()], 'a protocol the protocol facts cover', true, protocolNotes),
  judgments: optList(obj({ text: str(200), sources: optList(url), recommendation: str(200) }), 4),
  reviews: keyed((scope) => scope.reviews, 'a result the signer must look at', true, () =>
    obj({ status: oneOf('confirmed', 'concern'), text: str(300), recommendation: str(200) }),
  ),
  entries: opt(
    keyed((scope) => [...scope.entries], 'a registry entry this report covers', false, () =>
      obj({ role: opt(str(200)), sources: optList(obj({ text: str(200), url, result: oneOf('pass', 'attention', 'fail') })) }),
    ),
  ),
  fields: keyed((scope) => scope.fields, 'an argument of the template', true, () => str(2000)),
});

export type Notes = ReturnType<typeof NOTES_SCHEMA>;

/** `notes.json` against its scope: every key in the schema, every name the scope requires present, and no other name. */
export const parseNotes = (raw: unknown, scope: NotesScope): Notes => NOTES_SCHEMA(NOTES_FILE, raw, scope);
