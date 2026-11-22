import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../canonical.ts';
import { canonicalType, parseFunctionSignature } from '../decode/abi.ts';
import type { AbiType } from '../decode/abi.ts';
import { ATTRIBUTES_PATH, MARKETS_PATH, MARKET_ENTRY_PARTS, REGISTRY_PATH, isEntryName } from '../registry.ts';
import type { Registry } from '../registry.ts';
import type { Address, Hex } from '../safe/types.ts';
import { TEMPLATES_DIR, cardRefs, loadTemplate, refNames } from '../template/template.ts';
import type { Template } from '../template/template.ts';
import { keccakText } from '../verify/verify.ts';
import { statedEffects } from './amounts.ts';
import type { Difference, Measurement } from './amounts.ts';
import { searchTop, yearBefore } from './past-txs.ts';
import type { Coverage, Found, Kept, PastTxs, PartyCheck, SafesFirst, SearchRun, Selection, WindowRun, YearSearch } from './past-txs.ts';
import { MAX_PAGES, MIN_PAGES, YEAR_PAGES, anchorOf, replayPastTxs, samplingOf } from './recording.ts';
import type { PastTxsRecording } from './recording.ts';
import { ANCHOR_KINDS, SOURCES, anchorEvent } from './sources.ts';
import type { SourceName } from './sources.ts';
import { shapesOf } from './study.ts';
import type { CallName, MisfitReason, NotStudiedReason, Outside, OutsideKind, Sender, UnprovenReason } from './study.ts';
import { parseRecordedTrace } from './trace.ts';
import type { TracedTx } from './trace.ts';

/** What the study's results were computed with, each as a hash `pnpm test` recomputes from the checkout. */
export type StudiedWith = {
  /** keccak256 of the template's template.json, as `kiss-sign template approve` hashes it. */
  readonly template: Hex;
  /** keccak256 of the registry entries the study could read: see `registryFingerprint`. */
  readonly registry: Hex;
  /** keccak256 of the code that computes a study, the files of `STUDY_FILES`. */
  readonly study: Hex;
};

/**
 * `testdata/research/<name>.json`: what one `pnpm past-txs --record` run searched and how the template judged each
 * transaction it studied. The answers it read stay in `.cache/past-txs/<name>.json` on the computer that ran it.
 */
export type PastTxsSummary = {
  /** Printed as the command that made it; `--same-windows-as` reads its sampling. */
  readonly query: PastTxsRecording['query'];
  /** The head block the search was placed by, so `--same-windows-as` needs no replay; absent for a block range. */
  readonly head: bigint | undefined;
  readonly studiedWith: StudiedWith;
  readonly search: { readonly run: SearchRun; readonly found: Found; readonly otherEmitter: readonly Hex[] };
  readonly studies: readonly Kept[];
  readonly measurements: ReadonlyMap<Hex, Measurement>;
  readonly traces: readonly TracedTx[];
};

export const SUMMARIES_DIR = join('testdata', 'research');
export const RECORDINGS_DIR = join('.cache', 'past-txs');

export class SummaryError extends Error {
  override name = 'SummaryError';
}

/**
 * The files whose code computes a study from a recording: every file `replayPastTxs` in `recording.ts` runs, found by
 * following its imports. The renderers (`past-txs-render.ts`, the report) are not among them, so a change of wording
 * keeps every summary. pnpm test fails when this list and the import graph disagree.
 */
export const STUDY_FILES: readonly string[] = [
  'src/canonical.ts',
  'src/card.ts',
  'src/chain/dns.ts',
  'src/chain/https.ts',
  'src/chain/providers.ts',
  'src/chain/reader.ts',
  'src/chain/recording.ts',
  'src/chain/rpc.ts',
  'src/chain/types.ts',
  'src/contracts/delegate.ts',
  'src/contracts/proxy.ts',
  'src/decode/abi.ts',
  'src/decode/codec.ts',
  'src/decode/multisend.ts',
  'src/keys.ts',
  'src/language.ts',
  'src/registry.ts',
  'src/research/amounts.ts',
  'src/research/github-token.ts',
  'src/research/messages.ts',
  'src/research/past-txs.ts',
  'src/research/recording.ts',
  'src/research/source-page.ts',
  'src/research/sources.ts',
  'src/research/study.ts',
  'src/research/trace.ts',
  'src/safe/deployments.ts',
  'src/safe/types.ts',
  'src/simulate/events.ts',
  'src/template/check.ts',
  'src/template/eip712.ts',
  'src/template/template.ts',
];

const PROGRAM_ROOT = join(import.meta.dirname, '..', '..');

/** keccak256 of each study file's path and text, so any change to the code that computes a study changes it. */
export const studyFingerprint = (): Hex => keccakText(STUDY_FILES.map((file) => `${file}\n${readFileSync(join(PROGRAM_ROOT, file), 'utf8')}`).join('\n'));

export const templateFingerprint = (repoRoot: string, template: string): Hex => keccakText(readFileSync(join(repoRoot, TEMPLATES_DIR, template, 'template.json'), 'utf8'));

const readJson = (repoRoot: string, path: string, fallback: unknown): unknown => {
  try {
    return JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
};

const stringsIn = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(stringsIn) : typeof value === 'object' && value !== null ? Object.values(value).flatMap(stringsIn) : [];

/**
 * keccak256 of the entries of `registry` a summary's study could read, so adding an unrelated entry keeps it: each entry
 * the template names, each a card reference can name (a field's scope, the attribute it reads, a market's parts), each the
 * query's token, --from or --to is, each whose address occurs anywhere in the summary's results, every market when a
 * card field is one, each market all of whose entries are among those, and the rows of the attribute table those
 * entries or the template name, as `registry/` holds them, in canonical JSON. `registry` is the one the study read, which for a template reported per vault holds that
 * vault alone of those its field accepts.
 */
export function registryFingerprint(repoRoot: string, registry: Registry, query: PastTxsRecording['query'], results: unknown): Hex {
  const contracts = readJson(repoRoot, REGISTRY_PATH, {}) as Record<string, { readonly address?: unknown }>;
  const markets = readJson(repoRoot, MARKETS_PATH, {}) as Record<string, Record<string, unknown>>;
  const template = loadTemplate(repoRoot, query.template, registry);
  const templateStrings = stringsIn(JSON.parse(readFileSync(join(repoRoot, TEMPLATES_DIR, query.template, 'template.json'), 'utf8')));
  const anyMarket = [...template.card.values()].some((field) => field.kind === 'market');
  const marketParts = anyMarket ? [...registry.markets.values()].flatMap((market) => MARKET_ENTRY_PARTS.map((part) => market[part].name)) : [];
  const queried = [query.token, query.from, query.to].flatMap((address) => (address === undefined ? [] : (registry.byAddress.get(address.toLowerCase() as Address)?.name ?? [])));
  const named = new Set([
    ...templateStrings.filter(isEntryName),
    ...cardRefs(template).flatMap((ref) => refNames(ref, template, registry)),
    ...marketParts,
    ...queried,
  ]);
  const text = JSON.stringify(results).toLowerCase();
  const kept = [...registry.entries.values()].filter((entry) => named.has(entry.name) || text.includes(entry.address.slice(2))).map((entry) => entry.name);
  const keptMarkets = [...registry.markets.keys()].filter((name) => anyMarket || MARKET_ENTRY_PARTS.every((part) => kept.includes(String(markets[name]?.[part]))));
  const table = readJson(repoRoot, ATTRIBUTES_PATH, null) as Record<string, unknown> | null;
  const read = new Set([
    ...kept.flatMap((name) => [...Object.keys(registry.entries.get(name)?.attributes ?? {}), ...stringsIn(contracts[name])]),
    ...templateStrings.flatMap((s) => s.split('.')),
  ]);
  return keccakText(
    canonicalJson({
      contracts: Object.fromEntries(kept.sort().map((name) => [name, contracts[name]])),
      markets: Object.fromEntries(keptMarkets.sort().map((name) => [name, markets[name]])),
      attributes: table === null ? null : Object.fromEntries(Object.entries(table).filter(([name]) => read.has(name))),
    }),
  );
}

/** A recording studied again from its answers, with `registry` and the template as this checkout holds it. */
export async function studyRecording(repoRoot: string, recording: PastTxsRecording, registry: Registry): Promise<PastTxsSummary> {
  const template = loadTemplate(repoRoot, recording.query.template, registry);
  return summaryOf(repoRoot, registry, recording.query, await replayPastTxs(recording, template, registry));
}

type Results = Omit<PastTxsSummary, 'query' | 'head' | 'studiedWith'>;

/** The summary of a run, with what it was studied with in this checkout. */
export function summaryOf(repoRoot: string, registry: Registry, query: PastTxsRecording['query'], run: PastTxs): PastTxsSummary {
  const results: Results = {
    search: { run: run.search, found: run.found, otherEmitter: run.otherEmitter },
    studies: run.studies,
    measurements: run.measurements,
    traces: run.traces,
  };
  return { query, head: run.head, studiedWith: studiedWith(repoRoot, registry, query, results), ...results };
}

const studiedWith = (repoRoot: string, registry: Registry, query: PastTxsRecording['query'], results: Results): StudiedWith => ({
  template: templateFingerprint(repoRoot, query.template),
  registry: registryFingerprint(repoRoot, registry, query, resultsJson(results)),
  study: studyFingerprint(),
});

/** Each of the summary's hashes that differs from what this checkout gives with `registry`, by what it names. */
export function staleParts(repoRoot: string, registry: Registry, summary: PastTxsSummary): string[] {
  const now = studiedWith(repoRoot, registry, summary.query, summary);
  return [
    ...(now.template === summary.studiedWith.template ? [] : ['template']),
    ...(now.registry === summary.studiedWith.registry ? [] : ['registry entries it reads']),
    ...(now.study === summary.studiedWith.study ? [] : ['study code']),
  ];
}

const block = (n: bigint): string => n.toString();
const rangeJson = (range: { readonly fromBlock: bigint; readonly toBlock: bigint }) => ({ fromBlock: block(range.fromBlock), toBlock: block(range.toBlock) });

const safesFirstJson = ({ check, selection }: SafesFirst) => ({ check: check.kind === 'checked' ? { ...check, block: block(check.block) } : check, selection });

function yearJson(year: YearSearch): unknown {
  if (year.kind === 'overflow') return { kind: 'overflow', range: rangeJson(year.range), pages: year.pages, sources: year.sources };
  const { safesFirst } = year;
  return { kind: 'covered', range: rangeJson(year.range), pages: Object.fromEntries(year.pages), ...(safesFirst === undefined ? {} : { safesFirst: safesFirstJson(safesFirst) }) };
}

function searchJson(run: SearchRun): object {
  if (run.kind === 'windows') {
    return {
      ...(run.year === undefined ? {} : { year: yearJson(run.year) }),
      windows: run.windows.map((w) => ({ asked: rangeJson(w.asked), range: rangeJson(w.range), found: w.found, studied: w.studied })),
      perWindow: run.perWindow,
    };
  }
  const { kind, range, pages, time } = run.coverage;
  return {
    coverage: { kind, range: rangeJson(range), pages, ...(time === undefined ? {} : { time: { from: block(time.from), to: block(time.to) } }) },
    safesFirst: safesFirstJson(run.safesFirst),
  };
}

/**
 * A text the study may have decoded from the chain, such as a signed message's string member: as it is when the
 * program could have written it (`TEXT`), else its UTF-8 bytes in hex, so a summary holds any string a run can see.
 */
const chainTextJson = (text: string): unknown => (TEXT.test(text) ? text : { utf8: `0x${Buffer.from(text, 'utf8').toString('hex')}` });

function studyJson(study: Kept): unknown {
  switch (study.kind) {
    case 'fit': {
      const values = study.values.map((value, i) => (study.types[i]?.kind === 'string' ? chainTextJson(value) : value));
      return { ...study, block: block(study.block), types: study.types.map(canonicalType), values, time: study.time === undefined ? undefined : block(study.time) };
    }
    case 'misfit':
      if (study.reason.kind === 'late') return { ...study, reason: { ...study.reason, seconds: block(study.reason.seconds) } };
      if (study.reason.kind === 'field') return { ...study, reason: { ...study.reason, expected: chainTextJson(study.reason.expected), actual: chainTextJson(study.reason.actual) } };
      return study;
    default:
      return study;
  }
}

function resultsJson(results: Results): unknown {
  return {
    search: {
      ...searchJson(results.search.run),
      found: results.search.found,
      otherEmitter: results.search.otherEmitter,
    },
    studies: results.studies.map(studyJson),
    measurements: [...results.measurements].map(([hash, m]) => (m.kind === 'measured' ? { hash, kind: m.kind, differences: m.differences.map((d) => ({ ...d, by: block(d.by) })) } : { hash, ...m })),
    traces: results.traces,
  };
}

/** The summary's file text: JSON, one value per line, as `--record` and `--restudy` write it. */
export function summaryText(summary: PastTxsSummary): string {
  const json = {
    query: summary.query,
    ...(summary.head === undefined ? {} : { head: block(summary.head) }),
    studiedWith: summary.studiedWith,
    ...(resultsJson(summary) as object),
  };
  return `${JSON.stringify(json, null, 1)}\n`;
}

/**
 * The characters of a reason the program writes, such as `expected canonical transfer(address,uint256)`, with no link
 * (`](` or `://`). A summary is printed in the report, so a hand-edited one holding Markdown or HTML is refused.
 */
const TEXT = /^(?!.*\]\()(?!.*:\/\/)[A-Za-z0-9 ,.:;()'_/=+?%[\]-]*$/;
const PATH = /^[A-Za-z0-9_.[\]$]+$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SELECTOR = /^0x[0-9a-f]{8}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SIGNED = /^(0|-?[1-9][0-9]*)$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

type Json = Readonly<Record<string, unknown>>;

/** One summary file's parser: each check names where in the file it failed. */
function parser(file: string) {
  const fail = (at: string, what: string): never => {
    throw new SummaryError(`${file}: ${at}: ${what}`);
  };
  const object = (at: string, raw: unknown, required: readonly string[], optional: readonly string[] = []): Json => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail(at, 'not an object');
    for (const key of required) if (!Object.hasOwn(raw, key)) fail(at, `no ${key}`);
    for (const key of Object.keys(raw)) if (!required.includes(key) && !optional.includes(key)) fail(at, `${key} is not a field here`);
    return raw as Json;
  };
  const list = <T>(at: string, raw: unknown, item: (at: string, raw: unknown) => T): T[] => (Array.isArray(raw) ? raw.map((x, i) => item(`${at}[${i}]`, x)) : fail(at, 'not a list'));
  const matching = (pattern: RegExp, what: string) => (at: string, raw: unknown): string => (typeof raw === 'string' && pattern.test(raw) ? raw : fail(at, `not ${what}`));
  const hash = matching(HASH, 'a transaction hash') as (at: string, raw: unknown) => Hex;
  const address = matching(ADDRESS, 'a lowercase address') as (at: string, raw: unknown) => Address;
  const text = matching(TEXT, 'text of the characters the program writes');
  const path = matching(PATH, 'a field path');
  const selector = matching(SELECTOR, 'a selector') as (at: string, raw: unknown) => Hex;
  const decimal = (at: string, raw: unknown): bigint => BigInt(matching(DECIMAL, 'a decimal number')(at, raw));
  const signed = (at: string, raw: unknown): bigint => BigInt(matching(SIGNED, 'a signed decimal number')(at, raw));
  const count = (at: string, raw: unknown): number => (Number.isSafeInteger(raw) && (raw as number) >= 0 ? (raw as number) : fail(at, 'not a count'));
  const oneOf = <T extends string>(options: readonly T[]) => (at: string, raw: unknown): T => (options as readonly unknown[]).includes(raw) ? (raw as T) : fail(at, `not one of ${options.join(', ')}`);
  const optional = <T>(at: string, raw: unknown, read: (at: string, raw: unknown) => T): T | undefined => (raw === undefined ? undefined : read(at, raw));
  const chainText = (at: string, raw: unknown): string => {
    if (typeof raw === 'string') return text(at, raw);
    const hex = matching(/^0x([0-9a-f]{2})*$/, 'hex bytes')(`${at}.utf8`, object(at, raw, ['utf8']).utf8);
    let decoded: string;
    try {
      decoded = UTF8.decode(Buffer.from(hex.slice(2), 'hex'));
    } catch {
      return fail(`${at}.utf8`, 'not UTF-8');
    }
    return TEXT.test(decoded) ? fail(`${at}.utf8`, 'text of the characters the program writes, kept as it is') : decoded;
  };
  return { fail, object, list, hash, address, text, chainText, path, selector, decimal, signed, count, oneOf, optional };
}

type Parser = ReturnType<typeof parser>;

const NOT_STUDIED: readonly NotStudiedReason[] = ['execTransaction calldata does not decode', 'no ExecutionSuccess from the Safe', 'calls no function the template calls'];
const UNPROVEN: readonly UnprovenReason[] = ['its code is not a known Safe proxy', 'its singleton is not an official Safe singleton'];
const OUTSIDE_KINDS: readonly OutsideKind[] = ['market', 'token', 'vault', 'address'];
/** What a transaction's first four bytes are recorded as: a selector, fewer bytes, none, or a contract creation. */
const CALLED = /^(0x[0-9a-f]{0,8}|no data|contract creation)$/;

function parseSender(p: Parser, at: string, raw: unknown): Sender {
  const kind = p.oneOf(['safe', 'eoa'] as const)(`${at}.kind`, (raw as Json | undefined)?.kind);
  if (kind === 'safe') {
    const o = p.object(at, raw, ['kind', 'address']);
    return { kind, address: p.address(`${at}.address`, o.address) };
  }
  const o = p.object(at, raw, ['kind', 'address', 'call']);
  return { kind, address: p.address(`${at}.address`, o.address), call: p.count(`${at}.call`, o.call) };
}

function parseCallName(p: Parser, at: string, raw: unknown): CallName {
  const o = p.object(at, raw, [], ['to', 'selector']);
  return { to: p.optional(`${at}.to`, o.to, p.address), selector: p.optional(`${at}.selector`, o.selector, p.selector) };
}

function parseReason(p: Parser, at: string, raw: unknown): MisfitReason {
  const kinds = ['foreign-delegatecall', 'multisend-noncanonical', 'calls', 'trailer', 'items', 'field', 'not-sender', 'differs', 'late', 'entry', 'other'] as const;
  const kind = p.oneOf(kinds)(`${at}.kind`, (raw as Json | undefined)?.kind);
  switch (kind) {
    case 'foreign-delegatecall':
    case 'multisend-noncanonical':
    case 'other':
      p.object(at, raw, ['kind']);
      return { kind };
    case 'calls': {
      const o = p.object(at, raw, ['kind', 'calls']);
      return { kind, calls: p.list(`${at}.calls`, o.calls, (a, x) => parseCallName(p, a, x)) };
    }
    case 'trailer':
    case 'not-sender': {
      const o = p.object(at, raw, ['kind', 'at']);
      return { kind, at: p.text(`${at}.at`, o.at) };
    }
    case 'items': {
      const o = p.object(at, raw, ['kind', 'at', 'expected', 'got'], ['calls']);
      return { kind, at: p.path(`${at}.at`, o.at), expected: p.count(`${at}.expected`, o.expected), got: p.count(`${at}.got`, o.got), calls: p.optional(`${at}.calls`, o.calls, (a, x) => p.list(a, x, (b, y) => parseCallName(p, b, y))) };
    }
    case 'field': {
      const o = p.object(at, raw, ['kind', 'at', 'expected', 'actual']);
      return { kind, at: p.path(`${at}.at`, o.at), expected: p.chainText(`${at}.expected`, o.expected), actual: p.chainText(`${at}.actual`, o.actual) };
    }
    case 'differs': {
      const o = p.object(at, raw, ['kind', 'at', 'other']);
      return { kind, at: p.path(`${at}.at`, o.at), other: p.path(`${at}.other`, o.other) };
    }
    case 'late': {
      const o = p.object(at, raw, ['kind', 'at', 'seconds']);
      return { kind, at: p.path(`${at}.at`, o.at), seconds: p.decimal(`${at}.seconds`, o.seconds) };
    }
    case 'entry': {
      const o = p.object(at, raw, ['kind', 'at', 'expected', 'actual']);
      const name = (a: string, x: unknown) => (typeof x === 'string' && isEntryName(x) ? x : p.fail(a, 'not a registry name'));
      return { kind, at: p.path(`${at}.at`, o.at), expected: p.list(`${at}.expected`, o.expected, name), actual: p.address(`${at}.actual`, o.actual) };
    }
  }
}

function parseType(p: Parser, at: string, raw: unknown): AbiType {
  if (typeof raw !== 'string' || !/^[a-z0-9()[\],]+$/.test(raw)) return p.fail(at, 'not an ABI type');
  try {
    const type = (parseFunctionSignature(`f(${raw})`).params[0] as { type: AbiType }).type;
    return canonicalType(type) === raw ? type : p.fail(at, 'not a canonical ABI type');
  } catch {
    return p.fail(at, 'not an ABI type');
  }
}

/** A leaf's value as `leafValue` writes it for its type; an address-word leaf holds the address it carries. */
function checkValue(p: Parser, at: string, raw: unknown, type: AbiType): string {
  if (type.kind === 'string') return p.chainText(at, raw);
  const pattern =
    type.kind === 'uint' ? DECIMAL
    : type.kind === 'int' ? SIGNED
    : type.kind === 'address' ? ADDRESS
    : type.kind === 'bool' ? /^(true|false)$/
    : /^0x([0-9a-f]{2})*$/;
  return typeof raw === 'string' && pattern.test(raw) ? raw : p.fail(at, `not a ${canonicalType(type)} value`);
}

function parseStudy(p: Parser, at: string, raw: unknown): Kept {
  const kind = p.oneOf(['unreadable', 'not-studied', 'unproven', 'misfit', 'fit'] as const)(`${at}.kind`, (raw as Json | undefined)?.kind);
  switch (kind) {
    case 'unreadable': {
      const o = p.object(at, raw, ['kind', 'hash', 'reason']);
      return { kind, hash: p.hash(`${at}.hash`, o.hash), reason: p.text(`${at}.reason`, o.reason) };
    }
    case 'not-studied': {
      const o = p.object(at, raw, ['kind', 'hash', 'why', 'selector'], ['to']);
      const selector = typeof o.selector === 'string' && CALLED.test(o.selector) ? o.selector : p.fail(`${at}.selector`, 'not what a transaction calls');
      return { kind, hash: p.hash(`${at}.hash`, o.hash), why: p.oneOf(NOT_STUDIED)(`${at}.why`, o.why), to: p.optional(`${at}.to`, o.to, p.address), selector };
    }
    case 'unproven': {
      const o = p.object(at, raw, ['kind', 'hash', 'contract', 'why']);
      return { kind, hash: p.hash(`${at}.hash`, o.hash), contract: p.address(`${at}.contract`, o.contract), why: p.oneOf(UNPROVEN)(`${at}.why`, o.why) };
    }
    case 'misfit': {
      const o = p.object(at, raw, ['kind', 'hash', 'sender', 'reason']);
      return { kind, hash: p.hash(`${at}.hash`, o.hash), sender: parseSender(p, `${at}.sender`, o.sender), reason: parseReason(p, `${at}.reason`, o.reason) };
    }
    case 'fit': {
      const o = p.object(at, raw, ['kind', 'hash', 'block', 'sender', 'paths', 'types', 'values', 'outside'], ['time']);
      const paths = p.list(`${at}.paths`, o.paths, p.path);
      const types = p.list(`${at}.types`, o.types, (a, x) => parseType(p, a, x));
      if (!Array.isArray(o.values) || o.values.length !== paths.length || types.length !== paths.length) p.fail(at, 'paths, types and values differ in length');
      const outside = p.list(`${at}.outside`, o.outside, (a, x): Outside => {
        const r = p.object(a, x, ['at', 'kind']);
        return { at: p.path(`${a}.at`, r.at), kind: p.oneOf(OUTSIDE_KINDS)(`${a}.kind`, r.kind) };
      });
      return {
        kind,
        hash: p.hash(`${at}.hash`, o.hash),
        block: p.decimal(`${at}.block`, o.block),
        sender: parseSender(p, `${at}.sender`, o.sender),
        paths,
        types,
        values: (o.values as unknown[]).map((v, i) => checkValue(p, `${at}.values[${i}]`, v, types[i] as AbiType)),
        outside,
        time: p.optional(`${at}.time`, o.time, p.decimal),
      };
    }
  }
}

function parseMeasurement(p: Parser, at: string, raw: unknown): readonly [Hex, Measurement] {
  const kind = p.oneOf(['measured', 'unmeasured'] as const)(`${at}.kind`, (raw as Json | undefined)?.kind);
  if (kind === 'unmeasured') {
    const o = p.object(at, raw, ['hash', 'kind', 'why']);
    return [p.hash(`${at}.hash`, o.hash), { kind, why: p.text(`${at}.why`, o.why) }];
  }
  const o = p.object(at, raw, ['hash', 'kind', 'differences']);
  const differences = p.list(`${at}.differences`, o.differences, (a, x): Difference => {
    const d = p.object(a, x, ['effect', 'token', 'party', 'by']);
    return { effect: p.count(`${a}.effect`, d.effect), token: p.address(`${a}.token`, d.token), party: p.oneOf(['sender', 'receiver'] as const)(`${a}.party`, d.party), by: p.signed(`${a}.by`, d.by) };
  });
  return [p.hash(`${at}.hash`, o.hash), { kind, differences }];
}

function parseTraced(p: Parser, at: string, raw: unknown): TracedTx {
  const kind = p.oneOf(['traced', 'unverifiable'] as const)(`${at}.kind`, (raw as Json | undefined)?.kind);
  if (kind === 'unverifiable') {
    const o = p.object(at, raw, ['kind', 'hash', 'why']);
    return { kind, hash: p.hash(`${at}.hash`, o.hash), why: p.text(`${at}.why`, o.why) };
  }
  const o = p.object(at, raw, ['kind', 'hash', 'sender', 'calls']);
  const hash = p.hash(`${at}.hash`, o.hash);
  let trace;
  try {
    trace = parseRecordedTrace({ hash, calls: o.calls }, at);
  } catch (error) {
    return p.fail(at, (error as Error).message);
  }
  if (!('calls' in trace)) return p.fail(at, 'no calls');
  return { kind, hash, sender: parseSender(p, `${at}.sender`, o.sender), calls: trace.calls };
}

function parseRange(p: Parser, at: string, raw: unknown) {
  const o = p.object(at, raw, ['fromBlock', 'toBlock']);
  const range = { fromBlock: p.decimal(`${at}.fromBlock`, o.fromBlock), toBlock: p.decimal(`${at}.toBlock`, o.toBlock) };
  return range.fromBlock <= range.toBlock ? range : p.fail(at, 'ends before it starts');
}

function parseSafesFirst(p: Parser, at: string, raw: unknown): SafesFirst {
  const s = p.object(at, raw, ['check', 'selection']);
  const checked = p.oneOf(['checked', 'not-checked'] as const)(`${at}.check.kind`, (s.check as Json | undefined)?.kind);
  let check: PartyCheck;
  if (checked === 'not-checked') check = { kind: checked, why: p.text(`${at}.check.why`, p.object(`${at}.check`, s.check, ['kind', 'why']).why) };
  else {
    const c = p.object(`${at}.check`, s.check, ['kind', 'noun', 'block', 'parties', 'safes', 'unreadable']);
    check = { kind: checked, noun: p.text(`${at}.check.noun`, c.noun), block: p.decimal(`${at}.check.block`, c.block), parties: p.count(`${at}.check.parties`, c.parties), safes: p.count(`${at}.check.safes`, c.safes), unreadable: p.count(`${at}.check.unreadable`, c.unreadable) };
  }
  const n = p.object(`${at}.selection`, s.selection, ['safes', 'safesChosen', 'rest', 'restChosen']);
  const selection: Selection = { safes: p.count(`${at}.selection.safes`, n.safes), safesChosen: p.count(`${at}.selection.safesChosen`, n.safesChosen), rest: p.count(`${at}.selection.rest`, n.rest), restChosen: p.count(`${at}.selection.restChosen`, n.restChosen) };
  return { check, selection };
}

const parsePages = (p: Parser, at: string, raw: unknown): Map<SourceName, number> =>
  new Map(Object.entries(p.object(at, raw, [], SOURCES)).map(([name, n]) => [name as SourceName, p.count(`${at}.${name}`, n)]));

/** Legacy until every summary is recorded again: the year a recording asked before its windows. */
function parseYear(p: Parser, at: string, raw: unknown): YearSearch {
  const kind = p.oneOf(['covered', 'overflow'] as const)(`${at}.kind`, (raw as Json | undefined)?.kind);
  const source = p.oneOf(SOURCES);
  if (kind === 'overflow') {
    const o = p.object(at, raw, ['kind', 'range', 'pages', 'sources']);
    return { kind, range: parseRange(p, `${at}.range`, o.range), pages: p.count(`${at}.pages`, o.pages), sources: p.list(`${at}.sources`, o.sources, source) };
  }
  const o = p.object(at, raw, ['kind', 'range', 'pages'], ['safesFirst']);
  return { kind, range: parseRange(p, `${at}.range`, o.range), pages: parsePages(p, `${at}.pages`, o.pages), safesFirst: p.optional(`${at}.safesFirst`, o.safesFirst, (a, x) => parseSafesFirst(p, a, x)) };
}

/**
 * The range a newest-first search read, held to what the search can give: it ends on the block the head places, starts
 * on the year's first block for `year` and after it for `recent`, and took at most `maxPages` pages, and for `recent`
 * exactly that many, since only the cap stops a search short of the year.
 */
function parseCoverage(p: Parser, at: string, raw: unknown, head: bigint, maxPages: number): Coverage {
  const o = p.object(at, raw, ['kind', 'range', 'pages'], ['time']);
  const kind = p.oneOf(['year', 'recent'] as const)(`${at}.kind`, o.kind);
  const range = parseRange(p, `${at}.range`, o.range);
  const year = yearBefore(head);
  if (range.toBlock !== searchTop(head)) p.fail(`${at}.range.toBlock`, `not ${searchTop(head)}, the block the head places`);
  if (kind === 'year' ? range.fromBlock !== year.fromBlock : range.fromBlock <= year.fromBlock) p.fail(`${at}.range.fromBlock`, kind === 'year' ? `not ${year.fromBlock}, the year's first block` : `not after ${year.fromBlock}, the year's first block`);
  const pages = p.count(`${at}.pages`, o.pages);
  if (pages > maxPages || (kind === 'recent' && pages !== maxPages)) p.fail(`${at}.pages`, kind === 'recent' ? `not ${maxPages}, the cap that stops a search short of the year` : `more than ${maxPages}, the cap`);
  const time = p.optional(`${at}.time`, o.time, (a, x) => {
    const t = p.object(a, x, ['from', 'to']);
    const times = { from: p.decimal(`${a}.from`, t.from), to: p.decimal(`${a}.to`, t.to) };
    return times.from <= times.to ? times : p.fail(a, 'ends before it starts');
  });
  return { kind, range, pages, time };
}

function canonicalEvent(signature: string): boolean {
  try {
    return anchorEvent(signature).signature === signature;
  } catch {
    return false;
  }
}

/** The report prints a summary's file name and query as a command, so each must be what `pnpm past-txs` writes. */
function parseQuery(file: string, raw: unknown): PastTxsRecording['query'] {
  const query = raw as PastTxsRecording['query'];
  const address = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
  const block = (v: unknown) => v === undefined || (typeof v === 'string' && /^\d+$/.test(v));
  const keys = ['template', 'token', 'anchor', 'from', 'to', 'event', 'fromBlock', 'toBlock', 'head', 'wholeYear', 'yearPages', 'maxPages', 'maxTxs'];
  const printable =
    typeof raw === 'object' &&
    raw !== null &&
    Object.keys(raw).every((key) => keys.includes(key)) &&
    /^[a-z0-9-]+\.json$/.test(file.replace(/^.*\//, '')) &&
    typeof query.template === 'string' &&
    /^[a-z0-9-]+\/[a-z0-9-]+$/.test(query.template) &&
    (query.anchor === 'event' ? query.token === undefined || address(query.token) : address(query.token)) &&
    (query.from === undefined || address(query.from)) &&
    (query.to === undefined || address(query.to)) &&
    (ANCHOR_KINDS as readonly string[]).includes(query.anchor) &&
    (query.anchor === 'event') === (query.event !== undefined) &&
    (query.event === undefined || (typeof query.event === 'string' && canonicalEvent(query.event))) &&
    block(query.fromBlock) &&
    block(query.toBlock) &&
    block(query.head) &&
    (query.head === undefined || (query.fromBlock === undefined && query.toBlock === undefined)) &&
    (query.wholeYear === undefined || (query.wholeYear === true && query.head !== undefined)) &&
    (query.yearPages === undefined || (Number.isSafeInteger(query.yearPages) && query.yearPages >= 1 && query.yearPages <= YEAR_PAGES && query.head !== undefined && query.wholeYear === undefined)) &&
    (query.maxPages === undefined || (Number.isSafeInteger(query.maxPages) && query.maxPages >= MIN_PAGES && query.maxPages <= MAX_PAGES && query.head !== undefined && query.wholeYear === undefined && query.yearPages === undefined)) &&
    Number.isSafeInteger(query.maxTxs);
  if (!printable) throw new SummaryError(`${file}: its name or query holds a value \`pnpm past-txs --record\` never writes`);
  return query;
}

/** A summary file's text, parsed once into the summary it holds; refused, naming the place, when anything is not as the program writes it. */
export function parseSummary(file: string, text: string): PastTxsSummary {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SummaryError(`${file}: not JSON`);
  }
  const p = parser(file);
  const o = p.object('summary', raw, ['query', 'studiedWith', 'search', 'studies', 'measurements', 'traces'], ['head']);
  const query = parseQuery(file, o.query);
  const w = p.object('studiedWith', o.studiedWith, ['template', 'registry', 'study']);
  const newest = query.maxPages !== undefined;
  const s = newest ? p.object('search', o.search, ['coverage', 'safesFirst', 'found', 'otherEmitter']) : p.object('search', o.search, ['windows', 'perWindow', 'found', 'otherEmitter'], ['year']);
  const f = p.object('search.found', s.found, ['total', 'only']);
  const only = p.object('search.found.only', f.only, SOURCES);
  const found: Found = {
    total: p.count('search.found.total', f.total),
    only: Object.fromEntries(SOURCES.map((source) => [source, p.list(`search.found.only.${source}`, only[source], p.hash)])) as Record<SourceName, Hex[]>,
  };
  if (SOURCES.reduce((n, source) => n + found.only[source].length, 0) > found.total) p.fail('search.found.only', 'more hashes than the search found');
  const head = p.optional('head', o.head, p.decimal);
  if ((head === undefined) !== (query.fromBlock !== undefined)) p.fail('head', 'kept for a year or windows search, and only for one');
  if (query.head !== undefined && head !== BigInt(query.head)) p.fail('head', "not the query's head");
  const studies = p.list('studies', o.studies, (a, x) => parseStudy(p, a, x));
  const fits = new Set(studies.flatMap((study) => (study.kind === 'fit' ? [study.hash] : [])));
  const measurements = p.list('measurements', o.measurements, (a, x) => parseMeasurement(p, a, x));
  measurements.forEach(([hash], i) => fits.has(hash) || p.fail(`measurements[${i}].hash`, 'not a transaction that fit'));
  const traces = p.list('traces', o.traces, (a, x) => parseTraced(p, a, x));
  traces.forEach(({ hash }, i) => fits.has(hash) || p.fail(`traces[${i}].hash`, 'not a transaction that fit'));
  return {
    query,
    head,
    studiedWith: { template: p.hash('studiedWith.template', w.template), registry: p.hash('studiedWith.registry', w.registry), study: p.hash('studiedWith.study', w.study) },
    search: {
      run: newest
        ? {
            kind: 'newest-first',
            coverage: parseCoverage(p, 'search.coverage', s.coverage, head as bigint, query.maxPages as number),
            safesFirst: parseSafesFirst(p, 'search.safesFirst', s.safesFirst),
          }
        : {
            kind: 'windows',
            year: p.optional('search.year', s.year, (a, x) => parseYear(p, a, x)),
            windows: p.list('search.windows', s.windows, (a, x): WindowRun => {
              const r = p.object(a, x, ['asked', 'range', 'found', 'studied']);
              return { asked: parseRange(p, `${a}.asked`, r.asked), range: parseRange(p, `${a}.range`, r.range), found: p.count(`${a}.found`, r.found), studied: p.count(`${a}.studied`, r.studied) };
            }),
            perWindow: p.count('search.perWindow', s.perWindow),
          },
      found,
      otherEmitter: p.list('search.otherEmitter', s.otherEmitter, p.hash),
    },
    studies,
    measurements: new Map(measurements),
    traces,
  };
}

/**
 * The text `--record` and `--restudy` write for `summary` at `testdata/research/<name>.json`, refused before anything is
 * written when it would not read back as the same summary, or holds `safe`'s address.
 */
export function summaryFile(name: string, summary: PastTxsSummary, safe: Address | undefined): { readonly path: string; readonly text: string } {
  const path = join(SUMMARIES_DIR, `${name}.json`);
  const text = summaryText(summary);
  try {
    if (summaryText(parseSummary(path, text)) !== text) throw new SummaryError(`${path}: reads back as another summary`);
  } catch (error) {
    throw new SummaryError(`${(error as Error).message}; nothing written`);
  }
  if (safe !== undefined && text.toLowerCase().includes(safe.slice(2).toLowerCase())) throw new SummaryError(`${path}: holds the configured Safe's address; nothing written`);
  return { path, text };
}

/** The run a summary holds, rebuilt with the template it was studied with, for the renderers to print. */
export function runOf(summary: PastTxsSummary, template: Template): PastTxs {
  const { query } = summary;
  const effects = statedEffects(template);
  for (const [hash, m] of summary.measurements) {
    const beyond = m.kind === 'measured' ? m.differences.find((d) => d.effect >= effects.length) : undefined;
    if (beyond !== undefined) throw new SummaryError(`the measurement of ${hash} names effect ${beyond.effect}, and the template states ${effects.length}`);
  }
  return {
    query: {
      template,
      anchor: anchorOf(query),
      sampling: samplingOf(query),
    },
    head: summary.head,
    search: summary.search.run,
    found: summary.search.found,
    otherEmitter: summary.search.otherEmitter,
    studies: summary.studies,
    shapes: shapesOf(template),
    excluded: { found: new Set(), sampled: new Set() },
    effects,
    measurements: summary.measurements,
    traces: summary.traces,
  };
}
