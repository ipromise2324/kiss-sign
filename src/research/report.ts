import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Reader } from '../chain/reader.ts';
import { replayReader } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import type { BlockTag } from '../chain/types.ts';
import { ABI_CASES_DIR, loadAbiCases, replayAbiCase } from '../contracts/abi-case.ts';
import type { AbiCase } from '../contracts/abi-case.ts';
import { pinOf, readRunningCodeAt, samePin } from '../contracts/code.ts';
import type { AbiProof, AbiRefusal } from '../contracts/prove.ts';
import type { Compilers } from '../contracts/solc.ts';
import { canonicalType, paramName } from '../decode/abi.ts';
import type { AbiFunction, AbiParam } from '../decode/abi.ts';
import { MARKETS_PATH, MARKET_ENTRY_PARTS, REGISTRY_PATH, isAttribute, isMarketEntryPart, parseHttpsUrl } from '../registry.ts';
import type { CodePin, HttpsUrl, Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import { TEMPLATES_DIR, loadTemplate } from '../template/template.ts';
import type { CallNode, CardRef, Effect, Quantity, Rule, Template, TokenRef, ViewEffect } from '../template/template.ts';
import type { Line, Listings, ListingsRecording } from './listings.ts';
import { checkSources, githubLine, parseCoinGeckoCoins, parseDefiLlamaProtocols, sourcePagesOf, sourceSiteLine, trimForRecording, trimPage } from './listings.ts';
import { DEFAULT_SPREAD, pastTxs, renderPastTxs } from './past-txs.ts';
import type { PastTxs } from './past-txs.ts';
import type { PastTxsRecording } from './recording.ts';
import { isGitHubPage, pageUrlOf } from './source-page.ts';
import type { SourcePages } from './source-page.ts';
import { chainAt, formatReports, studyEntries } from './erc7730.ts';
import type { ChainAccess, EntryReport, Snapshot } from './erc7730.ts';
import { constText } from './study.ts';
import { ANCHOR_KINDS, replayAsk } from './sources.ts';
import type { AnchorKind } from './sources.ts';

export type Subject = { readonly kind: 'template'; readonly template: Template; readonly docs: readonly DocLink[] } | { readonly kind: 'vault'; readonly vault: RegistryEntry };

/** The official page the AI names for one function. The program checks the page; the AI writes no text about it. */
export type DocLink = { readonly fn: AbiFunction; readonly contract: RegistryEntry; readonly url: HttpsUrl };

/** What a report is of: a template by id, or one registry vault by name. */
export type Target = { readonly template: string } | { readonly vault: string };

/** The ERC-7730 files the section read, cut as `pnpm erc7730 --record` cuts them, and the attestation reads. */
export type Erc7730Section = { readonly commit: string; readonly files: Readonly<Record<string, string>>; readonly chain: readonly Exchange[] };

/** A program-made recording of the live answers a template's report used, beside the ABI and past-transaction ones. */
export type ReportRecording = ListingsRecording & {
  readonly vaults: Readonly<Record<string, string>>;
  readonly erc7730: Erc7730Section;
  /** The code reads that check each code span. */
  readonly code: readonly Exchange[];
};

export type PastTxsSummary = { readonly file: string; readonly query: PastTxsRecording['query']; readonly text: string; readonly run: PastTxs };

export type ReportInputs = {
  readonly subject: Subject;
  readonly registry: Registry;
  readonly listings: Listings;
  readonly pages: SourcePages;
  readonly fetched: string;
  /** Absent: no proof was read for that address. */
  readonly abi: ReadonlyMap<Address, AbiProof | AbiRefusal>;
  /** What `pnpm vault-evidence` printed, by vault name. Absent: not read. */
  readonly vaults: ReadonlyMap<string, string>;
  readonly pastTxs: readonly PastTxsSummary[];
  /** Each pinned entry's spans as `checkSpans` judged them, oldest first. */
  readonly spans: ReadonlyMap<Address, readonly SpanCheck[]>;
  /** What `pnpm erc7730` prints for the entries, and the facts it prints them from. */
  readonly erc7730: { readonly text: string; readonly reports: readonly EntryReport[] };
};

export class ReportError extends Error {
  override name = 'ReportError';
}

export const DOCS_FILE = 'docs.json';
export const GENERATED_SUFFIX = '.generated.md';
export const GENERATED_FILE = `report${GENERATED_SUFFIX}`;
export const VAULT_REPORTS_DIR = join('registry', 'reports');
export const REPORT_RECORDINGS_DIR = join('testdata', 'report');
const RESEARCH_DIR = join('testdata', 'research');

export const generatedPath = (target: Target): string =>
  'vault' in target ? join(VAULT_REPORTS_DIR, `${target.vault}${GENERATED_SUFFIX}`) : join(TEMPLATES_DIR, target.template, GENERATED_FILE);

export const reportRecordingPath = (target: Target): string =>
  'vault' in target ? join(REPORT_RECORDINGS_DIR, 'vaults', `${target.vault}.json`) : join(REPORT_RECORDINGS_DIR, `${target.template.replace('/', '-')}.json`);

/** Every function the template calls, nested calls included, once each, in the order the template names them. */
export function templateFunctions(template: Template): AbiFunction[] {
  const found = new Map<string, AbiFunction>();
  const visitRule = (rule: Rule): void => {
    if (rule.kind === 'call') visitCall(rule.call);
    if (rule.kind === 'items') rule.items.forEach(visitRule);
    if (rule.kind === 'fields') rule.fields.forEach(visitRule);
  };
  const visitCall = (node: CallNode): void => {
    if (!found.has(node.fn.signature)) found.set(node.fn.signature, node.fn);
    node.args.forEach(visitRule);
  };
  for (const call of template.calls) if (call.data !== 'empty') visitCall(call.data);
  return [...found.values()];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The registry names a card reference can resolve to, in registry order. */
export function refNames(ref: CardRef, template: Template, registry: Registry): string[] {
  const field = template.card.get(ref.field);
  const { attribute } = ref;
  if (field?.kind === 'market') {
    return attribute !== undefined && isMarketEntryPart(attribute) ? [...new Set([...registry.markets.values()].map((m) => m[attribute].name))] : [];
  }
  if (field?.kind !== 'contract') return [];
  const candidates = [...registry.entries.values()].filter((e) => e.kind === field.registryKind);
  if (attribute === undefined) return candidates.map((e) => e.name);
  return isAttribute(attribute) ? [...new Set(candidates.flatMap((e) => e.attributes[attribute] ?? []))] : [];
}

function targetNames(rule: Rule, template: Template, registry: Registry): string[] | undefined {
  if (rule.kind === 'contract') return [rule.name];
  const names = rule.kind === 'card' ? refNames(rule.ref, template, registry) : [];
  return names.length > 0 ? names : undefined;
}

/**
 * For each function, by signature, the registry names the template calls it on: a call's `to`, or for a call nested in
 * a tuple, such as a Bundler3 bundle item, the tuple's one address field. Absent when no call site binds its target.
 */
function callTargets(template: Template, registry: Registry): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  const visitCall = (node: CallNode, target: Rule | undefined): void => {
    const names = target === undefined ? undefined : targetNames(target, template, registry);
    if (names !== undefined) targets.set(node.fn.signature, [...new Set([...(targets.get(node.fn.signature) ?? []), ...names])]);
    node.fn.params.forEach((param, i) => visitArg(node.args[i] as Rule, param));
  };
  const visitArg = (rule: Rule, param: AbiParam | undefined): void => {
    if (rule.kind === 'call') visitCall(rule.call, undefined);
    if (rule.kind === 'items') {
      const item = param?.type.kind === 'array' || param?.type.kind === 'fixed-array' ? { name: undefined, type: param.type.item } : undefined;
      rule.items.forEach((r) => visitArg(r, item));
    }
    if (rule.kind === 'fields') {
      const components = param?.type.kind === 'tuple' ? param.type.components : [];
      const addresses = components.flatMap((c, i) => (c.type.kind === 'address' ? [rule.fields[i] as Rule] : []));
      const target = addresses.length === 1 ? addresses[0] : undefined;
      rule.fields.forEach((r, i) => (r.kind === 'call' ? visitCall(r.call, target) : visitArg(r, components[i])));
    }
  };
  for (const call of template.calls) if (call.data !== 'empty') visitCall(call.data, call.to);
  return targets;
}

/**
 * `docs.json`: each function the template calls, by canonical signature, to `{ contract, url }`. Nothing else. The
 * contract must be one the template calls the function on, when the template binds that target.
 */
export function parseDocs(raw: unknown, template: Template, registry: Registry): DocLink[] {
  if (!isRecord(raw)) throw new ReportError(`${DOCS_FILE}: not a JSON object`);
  const fns = templateFunctions(template);
  const targets = callTargets(template, registry);
  const extra = Object.keys(raw).find((key) => !fns.some((fn) => fn.signature === key));
  if (extra !== undefined) throw new ReportError(`${DOCS_FILE}: ${JSON.stringify(extra.slice(0, 80))} is not a function the template calls`);
  return fns.map((fn) => {
    const value = raw[fn.signature];
    if (value === undefined) throw new ReportError(`${DOCS_FILE}: no page for ${fn.signature}`);
    if (!isRecord(value) || Object.keys(value).sort().join() !== 'contract,url') throw new ReportError(`${DOCS_FILE}: ${fn.signature} must hold exactly contract and url`);
    const contract = typeof value.contract === 'string' ? registry.entries.get(value.contract) : undefined;
    if (contract === undefined) throw new ReportError(`${DOCS_FILE}: ${fn.signature}.contract is not a registry name`);
    const names = targets.get(fn.signature);
    if (names !== undefined && !names.includes(contract.name)) {
      throw new ReportError(`${DOCS_FILE}: ${fn.signature}.contract is ${contract.name}, but the template calls it on ${names.length === 1 ? names[0] : `one of ${names.join(', ')}`}`);
    }
    const url = parseHttpsUrl(value.url);
    if (url === undefined) throw new ReportError(`${DOCS_FILE}: ${fn.signature}.url is not an https URL`);
    return { fn, contract, url };
  });
}

export function loadSubject(repoRoot: string, registry: Registry, target: Target): Subject {
  if ('vault' in target) {
    const vault = registry.entries.get(target.vault);
    if (vault?.kind !== 'vault') throw new ReportError(`${target.vault} is not a vault in the registry`);
    return { kind: 'vault', vault };
  }
  const template = loadTemplate(repoRoot, target.template, registry);
  const docs = JSON.parse(readFileSync(join(repoRoot, TEMPLATES_DIR, target.template, DOCS_FILE), 'utf8')) as unknown;
  return { kind: 'template', template, docs: parseDocs(docs, template, registry) };
}

function namedInRules(template: Template): Set<string> {
  const names = new Set<string>();
  const visit = (rule: Rule | undefined): void => {
    if (rule?.kind === 'contract') names.add(rule.name);
    if (rule?.kind === 'equals') visit(rule.rule);
    if (rule?.kind === 'share-price') for (const q of [rule.assets, rule.shares]) if (q.kind === 'path') visit(q.rule);
    if (rule?.kind === 'call') rule.call.args.forEach(visit);
    if (rule?.kind === 'items') rule.items.forEach(visit);
    if (rule?.kind === 'fields') rule.fields.forEach(visit);
  };
  visit(template.nonce);
  for (const call of template.calls) {
    visit(call.to);
    visit(call.value);
    if (call.data !== 'empty') call.data.args.forEach(visit);
  }
  for (const view of template.effects.views) {
    names.add(view.to);
    view.args.forEach(visit);
  }
  return names;
}

export const hasMarket = (template: Template): boolean => [...template.card.values()].some((field) => field.kind === 'market');

/** Every registry entry a card field can name: a contract of the field's kind, or a part of any market. */
function cardCandidates(template: Template, registry: Registry): RegistryEntry[] {
  const inMarkets = new Set(hasMarket(template) ? [...registry.markets.values()].flatMap((market) => MARKET_ENTRY_PARTS.map((part) => market[part].name)) : []);
  return [...registry.entries.values()].filter(
    (entry) => inMarkets.has(entry.name) || [...template.card.values()].some((field) => field.kind === 'contract' && field.registryKind === entry.kind),
  );
}

export const vaultsOf = (subject: Subject, registry: Registry): RegistryEntry[] =>
  subject.kind === 'vault' ? [subject.vault] : cardCandidates(subject.template, registry).filter((entry) => entry.kind === 'vault');

/**
 * Every registry entry the operation can touch, in registry order: those the template names, those a card field can
 * name, and every entry those name as an attribute, such as a vault's asset and factory.
 */
export function entriesOf(subject: Subject, registry: Registry): RegistryEntry[] {
  const names = new Set<string>();
  const roots = subject.kind === 'vault' ? [subject.vault] : [...[...namedInRules(subject.template)].map((n) => registry.entries.get(n) as RegistryEntry), ...cardCandidates(subject.template, registry)];
  for (const entry of roots) {
    names.add(entry.name);
    for (const target of Object.values(entry.attributes)) names.add(target);
  }
  if (subject.kind === 'template') for (const doc of subject.docs) names.add(doc.contract.name);
  return [...registry.entries.values()].filter((entry) => names.has(entry.name));
}

export const wordOf = (fn: AbiFunction): RegExp => new RegExp(`(?<![A-Za-z0-9_$])${fn.name.replace(/\$/g, '\\$')}(?![A-Za-z0-9_$])`);

/** Keeps of each page only what the report's checks read: the entries' addresses and the documented function names. */
export function trimReportRecording(
  subject: Subject,
  entries: readonly RegistryEntry[],
  listings: Listings,
  pages: SourcePages,
  fetched: Date,
  vaults: ReadonlyMap<string, string>,
  erc7730: Erc7730Section,
  code: readonly Exchange[],
): ReportRecording {
  const base = trimForRecording(entries, listings, pages, fetched);
  const docs = subject.kind === 'template' ? subject.docs : [];
  const trimmed = Object.fromEntries(
    [...pages.pages].map(([url, page]) => [
      url,
      trimPage(
        page,
        entries.filter((e) => pageUrlOf(e.source) === url).map((e) => e.address),
        docs.filter((d) => pageUrlOf(d.url) === url).map((d) => wordOf(d.fn)),
      ),
    ]),
  );
  return { ...base, pages: trimmed, vaults: Object.fromEntries(vaults), erc7730, code };
}

export async function erc7730Text(entries: readonly RegistryEntry[], registry: Registry, snapshot: Snapshot, chain: () => Promise<ChainAccess>): Promise<{ text: string; reports: EntryReport[] }> {
  const reports = await studyEntries(entries, registry, snapshot, chain);
  return { text: formatReports(snapshot, reports), reports };
}

/** Every `pnpm past-txs --record` recording the subject's report summarizes: of the template, or anchored on the vault. */
export function pastTxsRecordings(repoRoot: string, subject: Subject): { readonly file: string; readonly recording: PastTxsRecording }[] {
  const dir = join(repoRoot, RESEARCH_DIR);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: join(RESEARCH_DIR, f), recording: JSON.parse(readFileSync(join(dir, f), 'utf8')) as PastTxsRecording }))
    .filter(({ file, recording: { query } }) => {
      if (!printableQuery(file, query)) throw new ReportError(`${file}: its name or query holds a value \`pnpm past-txs --record\` never writes`);
      return subject.kind === 'template' ? query.template === subject.template.id : query.token.toLowerCase() === subject.vault.address;
    });
}

/** The report prints a recording's file name and query as a command, so each must be what `pnpm past-txs` writes. */
function printableQuery(file: string, query: PastTxsRecording['query']): boolean {
  const address = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
  const block = (v: unknown) => v === undefined || (typeof v === 'string' && /^\d+$/.test(v));
  return (
    /^[a-z0-9-]+\.json$/.test(file.replace(/^.*\//, '')) &&
    /^[a-z0-9-]+\/[a-z0-9-]+$/.test(query.template) &&
    address(query.token) &&
    (query.from === undefined || address(query.from)) &&
    (query.to === undefined || address(query.to)) &&
    (ANCHOR_KINDS as readonly string[]).includes(query.anchor) &&
    block(query.fromBlock) &&
    block(query.toBlock) &&
    Number.isSafeInteger(query.maxTxs)
  );
}

/**
 * Runs the study again on a recording, with the template as it is now. With `live`, the search answers and head block
 * still come from the recording, but each found transaction, its receipt and its sender's code are read again through
 * `live`, so a transaction the chain does not hold as recorded changes the summary.
 */
export async function summarizePastTxs(repoRoot: string, registry: Registry, file: string, recording: PastTxsRecording, live?: Reader): Promise<PastTxsSummary> {
  const { query } = recording;
  const recorded = replayReader(recording.exchanges);
  const reader: Reader = live === undefined ? recorded : { ...live, blockNumber: () => recorded.blockNumber() };
  const run = await pastTxs(
    {
      template: loadTemplate(repoRoot, query.template, registry),
      anchor: {
        token: query.token as Address,
        kind: query.anchor as AnchorKind,
        ...(query.from === undefined ? {} : { from: query.from as Address }),
        ...(query.to === undefined ? {} : { to: query.to as Address }),
      },
      sampling:
        query.fromBlock === undefined || query.toBlock === undefined ? DEFAULT_SPREAD : { kind: 'range', range: { fromBlock: BigInt(query.fromBlock), toBlock: BigInt(query.toBlock) } },
    },
    { ask: replayAsk(recording.sources), reader, registry, exclude: undefined, maxTxs: query.maxTxs },
  );
  return { file, query, text: renderPastTxs(run, registry), run };
}

/** Text the AI wrote, as literal Markdown on one line: every character Markdown or a table cell reads is escaped. */
const inline = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .replace(/[\\`*_[\]<>|~#!&]/g, (c) => `\\${c}`)
    // GitHub links an @mention and renders $math$ even after a backslash or as an entity, but not across a tag.
    .replace(/[@$]/g, (c) => `<span>${c}</span>`);
const byAi = (text: string): string => `written by the AI in the template: ${inline(text)}`;
/** Names, addresses, hashes, selectors and file paths, each parsed into a charset that holds no backtick or `|`. */
const code = (text: string): string => `\`${text}\``;
const full = (entry: RegistryEntry): string => `${code(entry.name)} ${code(checksumAddress(entry.address))}`;
const verdict = (line: Line | undefined): string => (line === undefined ? 'n/a' : line.kind === 'agrees' ? 'PASS' : 'FINDING');

function refText(ref: CardRef): string {
  return ref.attribute === undefined ? `the card's ${code(ref.field)}` : `the ${code(ref.attribute)} of the card's ${code(ref.field)}`;
}

function refAddresses(ref: CardRef, template: Template, registry: Registry): string {
  const kind = template.card.get(ref.field)?.kind;
  const names = refNames(ref, template, registry);
  if (kind !== 'contract' && (kind !== 'market' || names.length === 0)) return '';
  return `: one of ${names.map((n) => full(registry.entries.get(n) as RegistryEntry)).join(', ')}`;
}

const FREE_CLAIMS = { scalar: 'free', proof: 'free, claimed `proof`: every changed value must revert or be refused', unread: 'free, claimed `unread`: no changed value may change anything' } as const;

const quantityText = (q: Quantity): string => (q.kind === 'card' ? `the card's ${code(q.field)}` : `the number at ${code(q.path)}`);

function ruleText(rule: Rule, template: Template, registry: Registry): string {
  switch (rule.kind) {
    case 'card':
      return `${refText(rule.ref)}${refAddresses(rule.ref, template, registry)}`;
    case 'safe':
      return 'the Safe';
    case 'contract':
      return `registry ${full(registry.entries.get(rule.name) as RegistryEntry)}`;
    case 'const':
      return `constant ${code(constText(rule.value))}`;
    case 'free':
      return `${FREE_CLAIMS[rule.claim]}; ${byAi(rule.reason)}`;
    case 'equals':
      return `the same number as ${code(rule.path)}, which is ${ruleText(rule.rule, template, registry)}`;
    case 'share-price':
      return `${rule.bound === 'max' ? 'at most' : 'at least'} assets × 1e27 / shares, with assets ${quantityText(rule.assets)} and shares ${quantityText(rule.shares)}`;
    case 'call':
    case 'items':
    case 'fields':
      return '';
  }
}

function argRows(params: readonly AbiParam[], rules: readonly Rule[], path: string, template: Template, registry: Registry): string[] {
  return params.flatMap((param, i) => rowsOf(rules[i] as Rule, `${path}${paramName(param, i)}`, param, template, registry));
}

function rowsOf(rule: Rule, path: string, param: AbiParam | undefined, template: Template, registry: Registry): string[] {
  switch (rule.kind) {
    case 'call':
      return callRows(rule.call, `${path} → `, template, registry);
    case 'items': {
      const item = param?.type.kind === 'array' || param?.type.kind === 'fixed-array' ? { name: undefined, type: param.type.item } : undefined;
      return [`| ${code(path)} | exactly ${rule.items.length} item${rule.items.length === 1 ? '' : 's'} |`, ...rule.items.flatMap((r, i) => rowsOf(r, `${path}[${i}]`, item, template, registry))];
    }
    case 'fields': {
      const components = param?.type.kind === 'tuple' ? param.type.components : [];
      return argRows(components, rule.fields, `${path}.`, template, registry);
    }
    default:
      return [`| ${code(path)} | ${ruleText(rule, template, registry)} |`];
  }
}

function callRows(node: CallNode, prefix: string, template: Template, registry: Registry): string[] {
  const trailer = node.trailer === undefined ? 'no bytes after the arguments' : `at most ${node.trailer.maxBytes} bytes after the arguments; ${byAi(node.trailer.why)}`;
  return [
    `| ${code(`${prefix}${node.fn.name}`)} | calls ${code(node.fn.signature)}, selector ${code(node.fn.selector)}; ${trailer} |`,
    ...argRows(node.fn.params, node.args, `${prefix}${node.fn.name}.`, template, registry),
  ];
}

function tokenText(token: TokenRef, template: Template, registry: Registry): string {
  return token === 'eth' ? 'ETH' : `${refText(token)}${refAddresses(token, template, registry)}`;
}

function effectRow(side: string, effect: Effect, template: Template, registry: Registry): string {
  const amount = effect.amount.kind === 'card' ? `the card's ${code(effect.amount.field)}` : effect.amount.kind === 'positive' ? 'more than nothing' : 'its whole balance';
  const to = effect.to === undefined ? '' : `, to ${refText(effect.to)}`;
  return `| ${side} | ${tokenText(effect.token, template, registry)} | ${amount}${to} |`;
}

function argumentText(rule: Rule, param: AbiParam, template: Template, registry: Registry): string {
  if (rule.kind !== 'fields' || param.type.kind !== 'tuple') return ruleText(rule, template, registry);
  const { components } = param.type;
  return `(${rule.fields.map((field, i) => `${code(paramName(components[i] as AbiParam, i))} ${argumentText(field, components[i] as AbiParam, template, registry)}`).join('; ')})`;
}

function viewRow(view: ViewEffect, template: Template, registry: Registry): string {
  const returns = view.returns.map((r, i) => `${canonicalType(r.type)} ${paramName(r, i)}`).join(', ');
  const args = view.fn.params.map((param, i) => `${code(paramName(param, i))} ${argumentText(view.args[i] as Rule, param, template, registry)}`).join('; ');
  const changes = view.changes.map(({ value, change }) => `${code(paramName(view.returns[value] as AbiParam, value))} ${change}`).join('; ');
  return `| registry ${full(registry.entries.get(view.to) as RegistryEntry)} | ${code(view.fn.signature)}, selector ${code(view.fn.selector)}, returns ${code(`(${returns})`)} | ${args} | ${changes} |`;
}

function templateSections(template: Template, docs: readonly DocLink[], inputs: ReportInputs): string[] {
  const { registry } = inputs;
  const out: string[] = ['## Card', '', '| Field | The signer gives |', '| --- | --- |'];
  for (const [name, field] of template.card) {
    const takes =
      field.kind === 'contract'
        ? `a registry ${code(field.registryKind)}, picked by number from the list below`
        : field.kind === 'amount'
          ? `an integer in base units of ${field.of === 'eth' ? 'ETH' : refText(field.of)}`
          : field.kind === 'nonce'
            ? 'a Safe nonce'
            : field.kind === 'market'
              ? `a market from ${code(MARKETS_PATH)}, picked by number from the list below`
              : field.kind === 'address'
              ? 'a registry name, an address-book name, or the Safe, each confirmed by the signer'
              : 'an address-book name or the Safe, each confirmed by the signer';
    out.push(`| ${code(name)} | ${takes} |`);
  }
  for (const [name, field] of template.card) {
    if (field.kind !== 'contract') continue;
    out.push('', `${code(name)} can name:`, '', '| Name | Address | Attributes |', '| --- | --- | --- |');
    for (const entry of registry.entries.values()) {
      if (entry.kind !== field.registryKind) continue;
      const attributes = Object.entries(entry.attributes).map(([key, target]) => `${key} ${full(registry.entries.get(target) as RegistryEntry)}`);
      out.push(`| ${code(entry.name)} | ${code(checksumAddress(entry.address))} | ${attributes.join('; ')} |`);
    }
  }
  for (const [name, field] of template.card) {
    if (field.kind !== 'market') continue;
    out.push('', `${code(name)} can name:`, '', '| Name | Market id | LLTV | Parts |', '| --- | --- | --- | --- |');
    for (const market of registry.markets.values()) {
      const parts = MARKET_ENTRY_PARTS.map((part) => `${part} ${full(market[part])}`);
      out.push(`| ${code(market.name)} | ${code(market.id)} | ${market.lltv} | ${parts.join('; ')} |`);
    }
  }
  if (template.same.length > 0) out.push('', `Must name one address: ${template.same.map(refText).join(', ')}.`);
  if (template.nonce !== undefined) out.push('', `The Safe transaction's nonce: ${ruleText(template.nonce, template, registry)}.`);

  out.push('', '## Calls and field rules', '');
  template.calls.forEach((call, i) => {
    out.push(`### Call ${i + 1} of ${template.calls.length}`, '', '| Field | Rule |', '| --- | --- |');
    out.push(`| ${code('to')} | ${ruleText(call.to, template, registry)} |`, `| ${code('value')} | ${ruleText(call.value, template, registry)} |`);
    if (call.data === 'empty') out.push(`| ${code('data')} | empty |`);
    else out.push(...callRows(call.data, '', template, registry));
    if (call.merge !== undefined) out.push('', `Several operations on one card share this call; ${byAi(call.merge)}`);
    out.push('');
  });

  out.push('## Effects', '', '| Side | Token | Amount |', '| --- | --- | --- |');
  for (const effect of template.effects.gives) out.push(effectRow('the Safe gives', effect, template, registry));
  for (const effect of template.effects.gets) out.push(effectRow('the Safe gets', effect, template, registry));
  if (template.effects.views.length > 0) {
    out.push('', 'The program calls each of these views just before and just after the transaction, and requires each named value to change as the row says:', '');
    out.push('| Contract | Function | Arguments | Change |', '| --- | --- | --- | --- |', ...template.effects.views.map((view) => viewRow(view, template, registry)));
  }

  out.push(
    '',
    '## Official documentation',
    '',
    `Each page comes from ${code(DOCS_FILE)}, whose contract must be the one the template calls the function on when the template binds it. The program compares the page's registrable domain, or GitHub organization, with the DefiLlama protocol of that contract, checks that a GitHub page is pinned to a commit on the default branch, and looks for the function's bare name as a whole word in the page as served, without scripts. A PASS there shows that the page names a function of that name, not that it documents this contract's function.`,
    '',
    '| Function | Contract | Page | Site | GitHub commit | Function name appears on page |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const doc of docs) {
    const url = new URL(doc.url);
    const page = inputs.pages.pages.get(pageUrlOf(doc.url));
    const named = page?.kind === 'served' && page.blocks.some((block) => wordOf(doc.fn).test(block.text)) ? 'PASS' : 'FINDING';
    const github = isGitHubPage(url) ? verdict(githubLine(url, inputs.pages.commits)) : 'n/a';
    out.push(`| ${code(doc.fn.signature)} | ${code(doc.contract.name)} | <${doc.url}> | ${verdict(sourceSiteLine(doc.url, doc.contract.defillama, inputs.listings))} | ${github} | ${named} |`);
  }
  out.push('');
  return out;
}

function pinText(pin: CodePin): string {
  return pin.implementation === undefined ? code(pin.hash) : `${code(pin.hash)}; implementation ${code(checksumAddress(pin.implementation.address))} ${code(pin.implementation.hash)}`;
}

/**
 * One span of a code pin as `checkSpans` judged it: `text` is what the Markdown report prints. `not-read` is a lone pin
 * from block 0, written before ranges.
 */
export type SpanCheck = { readonly kind: 'pass' | 'finding' | 'unverifiable' | 'not-read'; readonly text: string };

/**
 * Each span of each entry's code pin checked on the chain, oldest first: the code at its `from` is its pin, and the
 * code at the block before is the span before's pin, or for the first span, code `pnpm pin-code` cannot pin. A lone
 * pin from block 0, written before ranges, is not read. Prints no text a provider gave.
 */
export async function checkSpans(reader: Reader, entries: readonly RegistryEntry[]): Promise<Map<Address, SpanCheck[]>> {
  const checked = new Map<Address, SpanCheck[]>();
  for (const entry of entries) {
    if (entry.code === undefined) continue;
    const spans = [...entry.code.earlier, entry.code.current];
    if (spans.length === 1 && entry.code.current.from === 0n) {
      checked.set(entry.address, [{ kind: 'not-read', text: 'pinned before ranges, not read' }]);
      continue;
    }
    const verdicts: SpanCheck[] = [];
    const pass = (): number => verdicts.push({ kind: 'pass', text: 'PASS' });
    const finding = (text: string): number => verdicts.push({ kind: 'finding', text: `FINDING: ${text}` });
    const unverifiable = (block: bigint): number => verdicts.push({ kind: 'unverifiable', text: `UNVERIFIABLE at block ${block}` });
    for (const [i, { from, pin }] of spans.entries()) {
      const at = await readRunningCodeAt(reader, entry.address, from);
      if (at.kind === 'refused') {
        if (at.refusal.why === 'unverifiable') unverifiable(from);
        else finding(`block ${from} runs no code it can pin, ${code(at.refusal.why)}`);
        continue;
      }
      if (!samePin(pinOf(at.code), pin)) {
        finding(`block ${from} runs ${pinText(pinOf(at.code))}`);
        continue;
      }
      if (from === 0n) {
        pass();
        continue;
      }
      const previous = spans[i - 1]?.pin;
      const before = await readRunningCodeAt(reader, entry.address, from - 1n);
      if (before.kind === 'refused' && before.refusal.why === 'unverifiable') unverifiable(from - 1n);
      else if (before.kind === 'read' && (previous === undefined || !samePin(pinOf(before.code), previous))) finding(`block ${from - 1n} runs ${pinText(pinOf(before.code))}`);
      else if (before.kind === 'refused' && previous !== undefined) finding(`block ${from - 1n} runs no code it can pin, ${code(before.refusal.why)}`);
      else pass();
    }
    checked.set(entry.address, verdicts);
  }
  return checked;
}

function spanRows(entry: RegistryEntry, verdicts: readonly SpanCheck[] | undefined): string[] {
  const name = `| ${code(entry.name)} |`;
  if (entry.code === undefined) return [`${name} | not pinned | | |`];
  return [...entry.code.earlier, entry.code.current].map(({ from, pin }, i) => {
    const implementation = pin.implementation === undefined ? 'none' : `${code(checksumAddress(pin.implementation.address))} ${code(pin.implementation.hash)}`;
    return `${name} ${from} | ${code(pin.hash)} | ${implementation} | ${verdicts?.[i]?.text ?? 'not read'} |`;
  });
}

/** The pin names the code the proof compiled: the proxy's code and its implementation's, or the contract's own. */
export function pinVerdict(entry: RegistryEntry, proof: AbiProof): string {
  const pin = entry.code?.current.pin;
  if (pin === undefined) return 'not pinned';
  const same = (a: string, b: string | undefined) => a.toLowerCase() === b?.toLowerCase();
  const matches =
    proof.proxy.kind === 'none'
      ? pin.implementation === undefined && same(pin.hash, proof.codeHash)
      : pin.implementation !== undefined && same(pin.hash, proof.proxyCodeHash) && same(pin.implementation.address, proof.proven) && same(pin.implementation.hash, proof.codeHash);
  return matches ? 'PASS' : 'FINDING';
}

function abiRow(entry: RegistryEntry, proof: AbiProof | AbiRefusal | undefined): string {
  const name = `| ${code(entry.name)} | ${code(checksumAddress(entry.address))} |`;
  if (proof === undefined) return `${name} not read | | | | | | |`;
  if (proof.kind === 'refused') return `${name} REFUSED: ${code(proof.refusal.why)}${proof.refusal.why === 'compiler-not-pinned' ? ` solc ${code(proof.refusal.version)}` : ''} | | | | | | ${proof.block.number} |`;
  const proxy = proof.proxy.kind === 'none' ? 'none' : `${proof.proxy.kind}, implementation ${code(checksumAddress(proof.proven))}`;
  const contract = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(proof.contractName) ? code(proof.contractName) : 'a name that is not a Solidity identifier';
  const masked = `${proof.immutablesMasked} immutable, ${proof.librariesMasked} library spans masked${proof.metadataHashMasked ? '; metadata hash differs' : ''}`;
  return `${name} PROVEN | ${proxy} | ${contract}, solc ${code(proof.compiler)} | ${code(proof.codeHash)} | ${pinVerdict(entry, proof)} | ${masked} | ${proof.block.number} |`;
}

const COMMAND_FLAGS = ['token', 'anchor', 'from', 'to', 'fromBlock', 'toBlock', 'maxTxs'] as const;

function pastTxsCommand({ query, file }: PastTxsSummary): string {
  const flag = (key: (typeof COMMAND_FLAGS)[number]) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  const args = COMMAND_FLAGS.flatMap((key) => (query[key] === undefined ? [] : [`${flag(key)} ${String(query[key])}`]));
  return `pnpm past-txs ${query.template} ${args.join(' ')} --record ${file.replace(/^.*\//, '').replace(/\.json$/, '')}`;
}

/** The characters `pnpm vault-evidence` prints. Its text is stored, not recomputed, so anything else is refused. */
const VAULT_TEXT = /^[A-Za-z0-9 \n%(),.:;=_/'-]*$/;

/** A ```text block. Program output never holds three backticks, so text that does could close the block and is refused. */
function fenced(text: string): string[] {
  if (text.includes('```')) throw new ReportError('a section to print in a text block holds ```');
  return ['```text', text, '```'];
}

export const compareCommand = (subject: Subject): string => (subject.kind === 'template' ? `pnpm report ${subject.template.id} --compare` : `pnpm report --vault ${subject.vault.name} --compare`);

export function renderReport(inputs: ReportInputs, title: ReportTitle): string {
  const { subject, registry } = inputs;
  const entries = entriesOf(subject, registry);
  const name = subject.kind === 'template' ? subject.template.id : subject.vault.name;
  const out: string[] = [
    `# Generated evidence: ${name}`,
    '',
    `Written by ${code(title.command)} from ${title.sources.map(code).join(', ')}. The listings and pages were read on ${inputs.fetched}. ${code('pnpm test')} computes it again from these files and fails on any difference: every section is recomputed from the recorded answers except the vault evidence, which is stored as ${code('pnpm vault-evidence')} printed it. The recordings were made on the AI's computer; ${code(compareCommand(subject))} reads the listings, pages, ABI proofs, code spans and ERC-7730 attestations live, reads each vault again at the blocks its evidence names, fetches each recorded past transaction again by hash, and prints each fact that differs. It does not search for past transactions again, so it cannot show that a search found every one. Text from outside the program appears only as identifiers: a contract name Sourcify gives, printed only when it is a Solidity identifier, and the file paths, field paths and format names ${code('pnpm erc7730')} prints. The URLs come from the registry and ${code(DOCS_FILE)}, in RFC 3986 characters only. Text the AI wrote appears only where a row says it was written by the AI in the template. Do not edit this file.`,
    '',
  ];
  if (subject.kind === 'template') out.push(...templateSections(subject.template, subject.docs, inputs));

  const checked = checkSources(entries, inputs.listings, inputs.pages);
  out.push(
    '## Registry entries',
    '',
    `${code('pnpm check-sources')} on every entry the operation can touch. ${code(`pnpm check-sources ${entries.map((e) => e.name).join(' ')}`)} prints what each check compared.`,
    '',
    '| Entry | Address | Kind | Source | DefiLlama site | CoinGecko coin | GitHub commit | Address on page |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const { entry, lines } of checked) {
    const of = (check: Line['check']) => lines.find((l) => l.check === check);
    out.push(
      `| ${code(entry.name)} | ${code(checksumAddress(entry.address))} | ${entry.kind} | <${entry.source}> | ${verdict(of('defillama'))} | ${verdict(of('coingecko'))} | ${verdict(of('github'))} | ${verdict(of('page') ?? of('url'))} |`,
    );
  }
  const findings = checked.flatMap((r) => r.lines.filter((l) => l.kind === 'finding'));
  out.push('', `${checked.length} entries, ${findings.length} findings.`, '');

  out.push(
    '## Code pins',
    '',
    `Every span of each entry's registry code pin, oldest first: a span holds from its block to the block before the next span's. A transaction to sign must run the last span's code, and an executed one the code of the span that holds its block. ${code('pnpm pin-code')} writes the spans from the chain, not from a review of that code. Chain: whether, through both providers, the code at the span's first block is its pin, and the code at the block before is the previous span's pin, or for the first span, no code ${code('pnpm pin-code')} can pin. A lone pin from block 0 was written before ranges and is not read.`,
    '',
    '| Entry | From block | Code hash | Implementation | Chain |',
    '| --- | --- | --- | --- | --- |',
    ...entries.flatMap((entry) => spanRows(entry, inputs.spans.get(entry.address))),
    '',
  );

  out.push(
    '## ABI proofs',
    '',
    `${code('pnpm prove-abi')}: Sourcify's source, compiled with a pinned solc, against the code both providers return. Equals pin: whether the proved code, and the implementation behind a proxy, are the last span of the registry's code pin, which every signing of a new transaction requires.`,
    '',
    '| Entry | Address | Result | Proxy | Contract and compiler | Code hash | Equals pin | Masked | Block |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...entries.map((entry) => abiRow(entry, inputs.abi.get(entry.address))),
    '',
  );

  const vaults = vaultsOf(subject, registry);
  if (vaults.length > 0) {
    out.push('## Vaults', '', `For each vault, the stored output of ${code('pnpm vault-evidence')}, not recomputed by ${code('pnpm test')}; ${code('pnpm report --compare')} reads it again at the blocks it names.`, '');
    for (const vault of vaults) {
      const text = inputs.vaults.get(vault.name) ?? 'not read';
      if (!VAULT_TEXT.test(text)) throw new ReportError(`the stored vault evidence of ${vault.name} holds a character ${code('pnpm vault-evidence')} never prints`);
      out.push(`### ${code(vault.name)}`, '', ...fenced(text), '');
    }
  }

  out.push('## Past transactions', '');
  if (inputs.pastTxs.length === 0) out.push(`No ${code('pnpm past-txs --record')} recording names this ${subject.kind}.`, '');
  for (const summary of inputs.pastTxs) {
    out.push(`### ${code(summary.file)}`, '', `Recorded with ${code(pastTxsCommand(summary))}, and studied again here with the template as it is now.`, '', ...fenced(summary.text.trimEnd()), '');
  }

  out.push(
    '## ERC-7730',
    '',
    `${code(`pnpm erc7730 ${entries.map((e) => e.name).join(' ')}`)}: each entry's calldata descriptors in the pinned ERC-7730 registry, and each ERC-8176 attestation checked. A second opinion on field meanings, never a rule.`,
    '',
    ...fenced(inputs.erc7730.text),
    '',
  );
  return out.join('\n');
}

/** ABI proofs from the recorded cases alone, compiled again with the pinned solc. */
export async function replayAbiProofs(entries: readonly RegistryEntry[], cases: ReadonlyMap<Address, AbiCase>, compilers: Compilers): Promise<Map<Address, AbiProof | AbiRefusal>> {
  const proofs = new Map<Address, AbiProof | AbiRefusal>();
  for (const entry of entries) {
    const recorded = cases.get(entry.address);
    if (recorded !== undefined) proofs.set(entry.address, await replayAbiCase(recorded, compilers));
  }
  return proofs;
}

export type ReportTitle = { readonly command: string; readonly sources: readonly string[] };

/** The report from the repository and its recordings alone, as its committed `.generated.md` holds it. */
export async function replayReport(repoRoot: string, registry: Registry, target: Target, compilers: Compilers, suffixes: Listings['suffixes']): Promise<string> {
  const { inputs, title } = await replayInputs(repoRoot, registry, target, compilers, suffixes);
  return renderReport(inputs, title);
}

/** Every input a generated report renders, from the repository and its recordings alone. */
export async function replayInputs(
  repoRoot: string,
  registry: Registry,
  target: Target,
  compilers: Compilers,
  suffixes: Listings['suffixes'],
): Promise<{ readonly inputs: ReportInputs; readonly title: ReportTitle }> {
  const subject = loadSubject(repoRoot, registry, target);
  const recordingPath = reportRecordingPath(target);
  const recording = JSON.parse(readFileSync(join(repoRoot, recordingPath), 'utf8')) as ReportRecording;
  const entries = entriesOf(subject, registry);
  const pastRecordings = pastTxsRecordings(repoRoot, subject);
  const snapshot: Snapshot = { commit: recording.erc7730.commit, files: new Map(Object.entries(recording.erc7730.files)) };
  const inputs: ReportInputs = {
    subject,
    registry,
    listings: { protocols: parseDefiLlamaProtocols(recording.defillama), coinsByAddress: parseCoinGeckoCoins(recording.coingecko), suffixes },
    pages: sourcePagesOf(recording),
    fetched: recording.fetched,
    abi: await replayAbiProofs(entries, loadAbiCases(repoRoot), compilers),
    vaults: new Map(Object.entries(recording.vaults)),
    pastTxs: await Promise.all(pastRecordings.map(({ file, recording: r }) => summarizePastTxs(repoRoot, registry, file, r))),
    spans: await checkSpans(replayReader(recording.code), entries),
    erc7730: await erc7730Text(entries, registry, snapshot, () => chainAt(replayReader(recording.erc7730.chain))),
  };
  const registryFiles = subject.kind === 'template' && hasMarket(subject.template) ? [REGISTRY_PATH, MARKETS_PATH] : [REGISTRY_PATH];
  const inputsFiles = 'vault' in target ? registryFiles : [join(TEMPLATES_DIR, target.template, 'template.json'), join(TEMPLATES_DIR, target.template, DOCS_FILE), ...registryFiles];
  const sources = [...inputsFiles, recordingPath, ABI_CASES_DIR, ...pastRecordings.map((p) => p.file)];
  const command = 'vault' in target ? `pnpm report --vault ${target.vault} --record` : `pnpm report ${target.template} --record`;
  return { inputs, title: { command, sources } };
}

/**
 * Where a fact sits in a report: its heading, then a table row's first cell and the column, or for a text line, the
 * nearest line above it at the left margin, such as the ERC-7730 entry an attestation belongs to.
 */
type Facts = { readonly cells: Map<string, string>; readonly lines: Map<string, string[]> };

/** The block an answer was read at, which changes between two honest reads. A vault's evidence is read again at its own blocks. */
const IGNORED_COLUMNS = new Set(['Block']);
const atBlock = (line: string): string => line.replace(/\bblock \d+/g, 'block N');

function factsOf(markdown: string): Facts {
  const cells = new Map<string, string>();
  const lines = new Map<string, string[]>();
  const addLine = (key: string, line: string) => lines.set(key, [...(lines.get(key) ?? []), section === 'Vaults' ? line : atBlock(line)]);
  let section = '';
  let heading = '';
  let columns: string[] | undefined;
  let inFence = false;
  let margin = '';
  const rows = markdown.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i] as string;
    if (inFence) {
      if (line === '```') inFence = false;
      else {
        if (!line.startsWith(' ')) margin = line;
        addLine(line.startsWith(' ') ? `${heading} › ${atBlock(margin)}` : heading, line);
      }
      continue;
    }
    columns = line.startsWith('|') ? columns : undefined;
    if (line.startsWith('```')) [inFence, margin] = [true, ''];
    else if (line.startsWith('#')) {
      heading = line.replace(/^#+ /, '');
      if (line.startsWith('## ')) section = heading;
    } else if (line.startsWith('|') && columns === undefined) {
      columns = splitRow(line);
      i++;
    } else if (line.startsWith('|') && columns !== undefined) {
      const row = splitRow(line);
      let key = `${heading} › ${row[0]}`;
      for (let n = 2; cells.has(`${key} › ${columns[1]}`); n++) key = `${heading} › ${row[0]} (${n})`;
      row.forEach((value, j) => {
        const column = columns?.[j] ?? `column ${j + 1}`;
        if (j > 0 && !IGNORED_COLUMNS.has(column)) cells.set(`${key} › ${column}`, value);
      });
    } else if (line !== '' && !line.startsWith('Written by ')) addLine(heading, line);
  }
  return { cells, lines };
}

const splitRow = (row: string): string[] => row.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());

/**
 * Each fact that differs between the committed report and one read live: every table cell but the block an ABI proof
 * was read at, every text line with block numbers set aside, and every line of a vault's evidence exactly, since the
 * live report reads each vault at the blocks the committed one names (`vaultsAt`). Empty when they agree.
 */
export function compareReports(committed: string, live: string): string[] {
  const [was, now] = [factsOf(committed), factsOf(live)];
  const out: string[] = [];
  for (const key of new Set([...was.cells.keys(), ...now.cells.keys()])) {
    const [a, b] = [was.cells.get(key), now.cells.get(key)];
    if (a !== b) out.push(`${key}: committed ${a ?? 'absent'}, live ${b ?? 'absent'}`);
  }
  for (const key of new Set([...was.lines.keys(), ...now.lines.keys()])) {
    const remaining = [...(now.lines.get(key) ?? [])];
    for (const line of was.lines.get(key) ?? []) {
      const at = remaining.indexOf(line);
      if (at === -1) out.push(`${key} › only committed: ${line}`);
      else remaining.splice(at, 1);
    }
    for (const line of remaining) out.push(`${key} › only live: ${line}`);
  }
  return out;
}

/** The block each vault's evidence in a report was read at, by vault name: its `latest block` line. */
function vaultBlocks(markdown: string): Map<string, bigint> {
  const blocks = new Map<string, bigint>();
  let section = '';
  let vault: string | undefined;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) section = line.slice(3);
    else if (line.startsWith('### ')) vault = section === 'Vaults' ? /^### `([a-z0-9.-]+)`$/.exec(line)?.[1] : undefined;
    const latest = /^latest block (\d+) 0x[0-9a-f]{64}$/.exec(line);
    if (vault !== undefined && latest !== null && !blocks.has(vault)) blocks.set(vault, BigInt(latest[1] as string));
  }
  return blocks;
}

/**
 * Each vault's evidence read again as of the block the committed report names for it, so every number, date and the
 * holder count can be compared exactly; at the latest block for a vault the report names no block for.
 */
export async function vaultsAt(
  committed: string,
  vaults: readonly RegistryEntry[],
  read: (vault: RegistryEntry, at: BlockTag) => Promise<string>,
): Promise<Map<string, string>> {
  const blocks = vaultBlocks(committed);
  const texts = new Map<string, string>();
  for (const vault of vaults) texts.set(vault.name, await read(vault, blocks.get(vault.name) ?? 'latest'));
  return texts;
}

/** What a pull request may change and still be only data: anything else changes the program the signer runs. */
const DATA_DIRS = ['templates/', 'registry/', 'testdata/'];

export const programChanges = (changed: readonly string[]): string[] => changed.filter((file) => !DATA_DIRS.some((dir) => file.startsWith(dir)));
