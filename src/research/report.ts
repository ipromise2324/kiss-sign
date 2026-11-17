import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { LANGUAGES, LANGUAGE_NAMES } from '../language.ts';
import type { Prose } from '../language.ts';
import { join } from 'node:path';
import type { Reader } from '../chain/reader.ts';
import { replayReader, trimBlockAnswers } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import type { BlockRef, BlockTag } from '../chain/types.ts';
import { ABI_CASES_DIR, loadAbiCases, replayAbiCase } from '../contracts/abi-case.ts';
import type { AbiCase } from '../contracts/abi-case.ts';
import { pinOf, readRunningCode, readRunningCodeAt, samePin } from '../contracts/code.ts';
import { proveInstance } from '../contracts/instance.ts';
import type { InstanceAnswers, InstanceUnasked } from '../contracts/instance.ts';
import type { AbiProof, AbiRefusal } from '../contracts/prove.ts';
import type { Compilers } from '../contracts/solc.ts';
import { AbiSignatureError, canonicalType, namedSignatureOfAbiEntry, paramName, parseFunctionSignature } from '../decode/abi.ts';
import type { AbiFunction, AbiParam } from '../decode/abi.ts';
import { MARKETS_PATH, MARKET_ENTRY_PARTS, REGISTRY_PATH, pageUrlsOf, parseHttpsUrl, sizeOf } from '../registry.ts';
import type { CodePin, HttpsUrl, Registry, RegistryEntry, Route, SelectorRouting } from '../registry.ts';
import { wholeTokens } from '../chain/decimals.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { TEMPLATES_DIR, WAD, callTargetEntries, callTargets, cardRefs, computedOutput, effectTokenNames, inScope, isNamedToken, loadTemplate, namedEffectTokens, refNames, ruleLeaves, scopeEntries, slippageBps, viewTargetNames } from '../template/template.ts';
import type { MemberSource } from '../template/eip712.ts';
import { GENERATED_FILE, reportUnit, reportedVaultsIn, severalVaults, vaultReportDir } from '../template/vault-reports.ts';
import type { CallNode, CardRef, Computed, ComputedRead, Effect, EffectToken, Quantity, Rule, Template, Tolerance, TokenRef, ViewEffect } from '../template/template.ts';
import type { Line, Listings, ListingsRecording, SiteOwner } from './listings.ts';
import { checkSources, githubLine, listingsFor, recordedListingReads, sourcePagesOf, sourceSiteLine, trimForRecording, trimSourcePage } from './listings.ts';
import { DEFAULT_SPREAD, pastTxs, renderPastTxs } from './past-txs.ts';
import { factsScope, parseFactsRecording, protocolFacts, replaySources } from './protocol-facts.ts';
import type { FactReading, FactsScope, ProtocolFacts } from './protocol-facts.ts';
import type { PastTxs, Sampling } from './past-txs.ts';
import type { PastTxsRecording } from './recording.ts';
import { pathText } from './api-source.ts';
import { provenanceRepositories } from './npm-package.ts';
import { judge } from './ledger.ts';
import type { Result } from './ledger.ts';
import { githubRef, isGitHubPage, pageUrlOf } from './source-page.ts';
import type { SourcePages } from './source-page.ts';
import { chainAt, formatReports, studyEntries } from './erc7730.ts';
import type { ChainAccess, EntryReport, Snapshot } from './erc7730.ts';
import { constText } from './study.ts';
import { ANCHOR_KINDS, replayAsk } from './sources.ts';
import { STANDARDS } from './standards.ts';
import type { Standard } from './standards.ts';
import type { AnchorKind } from './sources.ts';
import { readRecording } from '../chain/bytecode.ts';
import { toleranceSpan } from './report-words.ts';

/** A template, with the one vault its report covers when it is reported per vault; or one registry vault alone. */
export type Subject =
  | { readonly kind: 'template'; readonly template: Template; readonly docs: readonly DocLink[]; readonly vault: RegistryEntry | undefined }
  | { readonly kind: 'vault'; readonly vault: RegistryEntry };

/** The official page for one function. The program checks the page; the AI writes no text about it. */
export type DocLink = { readonly fn: AbiFunction; readonly contract: RegistryEntry; readonly publisher: SiteOwner; readonly url: HttpsUrl; readonly standard: Standard | undefined };

/** What a report is of: a template by id, with `cardVault` for one reported per vault; or one registry vault by name. */
export type Target = { readonly template: string; readonly cardVault?: string } | { readonly vault: string };

/** The ERC-7730 files the section read, cut as `pnpm erc7730 --record` cuts them, and the attestation reads. */
export type Erc7730Section = { readonly commit: string; readonly files: Readonly<Record<string, string>>; readonly chain: readonly Exchange[] };

/** A program-made recording of the live answers a template's report used, beside the ABI and past-transaction ones. */
export type ReportRecording = ListingsRecording & {
  readonly vaults: Readonly<Record<string, string>>;
  readonly erc7730: Erc7730Section;
  /** The code reads that check each code span, and those `checkToday` made at `today`. */
  readonly code: readonly Exchange[];
  /** The block `checkToday` read at; absent when no entry needed it, and in older recordings. */
  readonly today?: { readonly number: string; readonly hash: Hex };
  /** The block `readInstances` asked the factories and vaults at, its reads in `code`; absent when none was asked, and in older recordings. */
  readonly instances?: { readonly number: string; readonly hash: Hex };
  /** A template's protocol facts, parsed by `parseFactsRecording`; absent in a vault's and in older recordings. */
  readonly facts?: unknown;
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
  /** What `checkToday` read for `todayEntries`; undefined when none needs it or the recording predates it. */
  readonly today: { readonly block: BlockRef; readonly checks: ReadonlyMap<Address, TodayCheck> } | undefined;
  /** What `readInstances` asked for `instanceEntries`; undefined when none needs it or the recording predates it. */
  readonly instances: { readonly block: BlockRef; readonly answers: ReadonlyMap<string, InstanceAnswers | InstanceUnasked> } | undefined;
  /** What `pnpm erc7730` prints for the entries, and the facts it prints them from. */
  readonly erc7730: { readonly text: string; readonly reports: readonly EntryReport[] };
  /** A template's protocol facts; undefined for a vault, or when the recording predates them. */
  readonly facts: ProtocolFacts | undefined;
};

export class ReportError extends Error {
  override name = 'ReportError';
}

export const DOCS_FILE = 'docs.json';
export const GENERATED_SUFFIX = '.generated.md';
export { GENERATED_FILE };
export const VAULT_REPORTS_DIR = join('registry', 'reports');
export const REPORT_RECORDINGS_DIR = join('testdata', 'report');
const RESEARCH_DIR = join('testdata', 'research');

/** The folder a template report's files sit in: the template's, or for a per-vault report its vault's under it. */
export const reportDir = (target: { readonly template: string; readonly cardVault?: string }): string =>
  target.cardVault === undefined ? join(TEMPLATES_DIR, target.template) : vaultReportDir(target.template, target.cardVault);

export const generatedPath = (target: Target): string => ('vault' in target ? join(VAULT_REPORTS_DIR, `${target.vault}${GENERATED_SUFFIX}`) : join(reportDir(target), GENERATED_FILE));

export function reportRecordingPath(target: Target): string {
  if ('vault' in target) return join(REPORT_RECORDINGS_DIR, 'vaults', `${target.vault}.json`);
  const name = target.template.replace('/', '-');
  return target.cardVault === undefined ? join(REPORT_RECORDINGS_DIR, `${name}.json`) : join(REPORT_RECORDINGS_DIR, name, `${target.cardVault}.json`);
}

/** Every template report the repository holds: one per template, or one per reported vault of a template reported per vault. */
export function templateTargets(repoRoot: string, registry: Registry): { readonly template: string; readonly cardVault?: string }[] {
  const dir = join(repoRoot, TEMPLATES_DIR);
  return readdirSync(dir)
    .sort()
    .flatMap((protocol) => readdirSync(join(dir, protocol)).sort().map((operation) => `${protocol}/${operation}`))
    .flatMap((template) =>
      reportUnit(loadTemplate(repoRoot, template, registry)).kind === 'vault' ? [...reportedVaultsIn(repoRoot, template)].sort().map((cardVault) => ({ template, cardVault })) : [{ template }],
    );
}

/** Every function the template calls, nested calls included, once each, in the order the template names them. */
export function templateFunctions(template: Template): AbiFunction[] {
  const found = new Map<string, AbiFunction>();
  const visitRule = (rule: Rule): void => {
    if (rule.kind === 'call') visitCall(rule.call);
    if (rule.kind === 'items') rule.items.forEach(visitRule);
    if (rule.kind === 'fields') rule.fields.forEach(visitRule);
  };
  const visitCall = (node: CallNode): void => {
    if (node.encoding === 'call' && !found.has(node.fn.signature)) found.set(node.fn.signature, node.fn);
    node.args.forEach(visitRule);
  };
  for (const call of template.calls) if (call.data !== 'empty') visitCall(call.data);
  return [...found.values()];
}

/**
 * Each function the template calls or reads on a registry entry, by entry name: each call whose target the template
 * binds, each function on the contract its `docs.json` names, which covers a call nested in `bytes` such as a
 * `multicall` item, each call to the Safe itself on every registry singleton, each effect view, each `facts` view and
 * each computed field's read. A proven ABI must hold each of them by its canonical signature.
 */
export function functionsOn(subject: Subject, registry: Registry): Map<string, AbiFunction[]> {
  if (subject.kind !== 'template') return new Map();
  const { template } = subject;
  const on = new Map<string, Map<string, AbiFunction>>();
  const add = (names: readonly string[], fn: AbiFunction): void => {
    for (const name of names) on.set(name, (on.get(name) ?? new Map()).set(fn.signature, fn));
  };
  const called = new Map(templateFunctions(template).map((fn) => [fn.signature, fn]));
  for (const [signature, names] of callTargets(template, registry)) {
    const fn = called.get(signature);
    if (fn !== undefined) add(names, fn);
  }
  for (const doc of subject.docs) add([doc.contract.name], doc.fn);
  const singletons = [...registry.entries.values()].filter((entry) => entry.kind === 'singleton').map((entry) => entry.name);
  for (const call of template.calls) if (call.to.kind === 'safe' && call.data !== 'empty') add(singletons, call.data.fn);
  for (const view of template.effects.views) add(viewTargetNames(view.to, template, registry), view.fn);
  for (const fact of template.facts) add([fact.to], fact.fn);
  const read = (r: ComputedRead): void => {
    add(viewTargetNames(r.to, template, registry), r.fn);
    for (const arg of r.args) if (arg.kind === 'read') read(arg.read);
  };
  for (const field of template.card.values()) if (field.kind === 'amount' && field.computed !== undefined) read(field.computed.read);
  return new Map([...on].map(([name, fns]) => [name, [...fns.values()]]));
}

/** The signatures of the functions the subject's template calls or reads on `entry` that its proven ABI does not hold. */
export function missingFromAbi(subject: Subject, registry: Registry, entry: RegistryEntry, proof: AbiProof): string[] {
  const fns = functionsOn(subject, registry).get(entry.name) ?? [];
  if (fns.length === 0) return [];
  const proven = new Set(proof.abi.filter((item) => item.type === 'function').flatMap((item) => signatureOf(item) ?? []));
  return fns.map((fn) => fn.signature).filter((signature) => !proven.has(signature));
}

/** The canonical signature of an ABI function entry, or undefined for one with a type no template can name, such as `function`. */
function signatureOf(item: Readonly<Record<string, unknown>>): string | undefined {
  try {
    return parseFunctionSignature(namedSignatureOfAbiEntry(item)).signature;
  } catch (error) {
    if (error instanceof AbiSignatureError) return undefined;
    throw error;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function publisherOf(contract: RegistryEntry, registry: Registry): SiteOwner {
  const factory = contract.attributes.factory;
  return (factory === undefined ? undefined : registry.entries.get(factory)) ?? contract;
}

/**
 * `docs.json`: each function the template calls, by canonical signature, to `{ contract, url }`, or `{ contract,
 * standard }` for a function a standard in `STANDARDS` defines for that contract's kind. Nothing else. The contract
 * must be one the template calls the function on, when the template binds that target.
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
    const keys = isRecord(value) ? Object.keys(value).sort().join() : '';
    if (!isRecord(value) || (keys !== 'contract,url' && keys !== 'contract,standard')) throw new ReportError(`${DOCS_FILE}: ${fn.signature} must hold exactly contract and url, or contract and standard`);
    const contract = typeof value.contract === 'string' ? registry.entries.get(value.contract) : undefined;
    if (contract === undefined) throw new ReportError(`${DOCS_FILE}: ${fn.signature}.contract is not a registry name`);
    const standard = typeof value.standard === 'string' ? STANDARDS.get(value.standard) : undefined;
    if (keys === 'contract,standard') {
      if (standard === undefined) throw new ReportError(`${DOCS_FILE}: ${fn.signature}.standard is not one of ${[...STANDARDS.keys()].join(', ')}`);
      if (standard.only !== undefined && contract.address !== standard.only) throw new ReportError(`${DOCS_FILE}: ${fn.signature}.contract ${contract.name} is not ${standard.name}, which is the one contract at ${standard.only}`);
      if (!standard.kinds.includes(contract.kind)) throw new ReportError(`${DOCS_FILE}: ${fn.signature}.contract ${contract.name} is a ${contract.kind}; ${standard.name} applies to ${standard.kinds.join(' and ')} entries`);
      if (!standard.declarations.has(fn.signature)) throw new ReportError(`${DOCS_FILE}: ${standard.name} does not define ${fn.signature}`);
    }
    const onSafe = template.calls.some((call) => call.to.kind === 'safe' && call.data !== 'empty' && call.data.fn.signature === fn.signature);
    if (onSafe && contract.kind !== 'singleton') throw new ReportError(`${DOCS_FILE}: ${fn.signature} is called on the Safe itself, so its contract must be a registry singleton, not ${contract.name}`);
    const names = targets.get(fn.signature);
    if (names !== undefined && !names.includes(contract.name)) {
      throw new ReportError(`${DOCS_FILE}: ${fn.signature}.contract is ${contract.name}, but the template calls it on ${names.length === 1 ? names[0] : `one of ${names.join(', ')}`}`);
    }
    const publisher = publisherOf(contract, registry);
    if (standard !== undefined) return { fn, contract, publisher, url: standard.page, standard };
    const url = parseHttpsUrl(value.url);
    if (url === undefined) throw new ReportError(`${DOCS_FILE}: ${fn.signature}.url is not an https URL`);
    return { fn, contract, publisher, url, standard: undefined };
  });
}

/**
 * The registry as a per-vault report reads it: `vault` is the only entry the field accepts. Every other entry of that
 * scope is left out, so neither it nor an asset, factory or dependency only it names reaches any section.
 */
function onlyVault(registry: Registry, template: Template, field: string, vault: RegistryEntry): Registry {
  const card = template.card.get(field);
  const others = new Set(card?.kind === 'contract' ? scopeEntries(card.scope, registry).filter((e) => e.name !== vault.name).map((e) => e.name) : []);
  const kept = [...registry.entries.values()].filter((entry) => !others.has(entry.name));
  const dangling = kept.flatMap((entry) => [...Object.values(entry.attributes), ...(entry.dependsOn ?? [])]).find((name) => others.has(name));
  if (dangling !== undefined) throw new ReportError(`${dangling} is another vault the field accepts, but a registry entry the report keeps names it`);
  return { attributes: registry.attributes, entries: new Map(kept.map((entry) => [entry.name, entry])), byAddress: new Map(kept.map((entry) => [entry.address, entry])), markets: registry.markets };
}

/**
 * What a report covers and the registry it reads. A template reported per vault needs `cardVault`, a vault its field
 * accepts, and reads the registry as if that vault were the only one; any other template refuses `cardVault`.
 */
export function loadReport(repoRoot: string, registry: Registry, target: Target): { readonly subject: Subject; readonly registry: Registry } {
  if ('vault' in target) {
    const vault = registry.entries.get(target.vault);
    if (vault?.kind !== 'vault') throw new ReportError(`${target.vault} is not a vault in the registry`);
    return { subject: { kind: 'vault', vault }, registry };
  }
  const template = loadTemplate(repoRoot, target.template, registry);
  const unit = reportUnit(template);
  if (unit.kind === 'several-vaults') throw new ReportError(severalVaults(template.id));
  if (unit.kind === 'template' && target.cardVault !== undefined) throw new ReportError(`${template.id} has one report, not one per vault; leave out the vault`);
  if (unit.kind === 'vault' && target.cardVault === undefined) {
    const reported = [...reportedVaultsIn(repoRoot, template.id)].sort();
    throw new ReportError(`${template.id} is reported per vault; name the vault (${reported.length === 0 ? 'no vault has a report yet' : `reports exist for ${reported.join(', ')}`})`);
  }
  let seen = registry;
  let vault: RegistryEntry | undefined;
  if (unit.kind === 'vault') {
    const field = template.card.get(unit.field);
    vault = registry.entries.get(target.cardVault as string);
    if (vault === undefined || field?.kind !== 'contract' || !inScope(field.scope, vault, registry)) throw new ReportError(`${target.cardVault} is not a vault the card's ${unit.field} of ${template.id} accepts`);
    seen = onlyVault(registry, template, unit.field, vault);
  }
  return { subject: { kind: 'template', template, docs: parseDocs(readDocs(repoRoot, template.id, vault?.name), template, seen), vault }, registry: seen };
}

/** The `docs.json` files a report reads: the template's, and its vault's when that vault's report has one, as a file of its own. */
export function docsPaths(repoRoot: string, template: string, vault?: string): string[] {
  const own = vault === undefined ? undefined : join(vaultReportDir(template, vault), DOCS_FILE);
  const found = own === undefined ? undefined : lstatSync(join(repoRoot, own), { throwIfNoEntry: false });
  if (found === undefined) return [join(TEMPLATES_DIR, template, DOCS_FILE)];
  if (!found.isFile()) throw new ReportError(`${own}: not a regular file`);
  return [join(TEMPLATES_DIR, template, DOCS_FILE), own as string];
}

/** The template's `docs.json` joined with its vault's, which may not name a function the template's names. */
export function readDocs(repoRoot: string, template: string, vault?: string): unknown {
  const [sharedPath, ownPath] = docsPaths(repoRoot, template, vault);
  const read = (path: string): unknown => JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
  const shared = read(sharedPath as string);
  if (ownPath === undefined) return shared;
  const own = read(ownPath);
  if (!isRecord(shared) || !isRecord(own)) throw new ReportError(`${isRecord(shared) ? ownPath : DOCS_FILE}: not a JSON object`);
  const twice = Object.keys(own).find((key) => Object.hasOwn(shared, key));
  if (twice !== undefined) throw new ReportError(`${ownPath}: ${JSON.stringify(twice.slice(0, 80))} is in the template's ${DOCS_FILE} too`);
  return { ...shared, ...own };
}

function namedInRules(template: Template): Set<string> {
  const names = new Set<string>();
  const visit = (rule: Rule | undefined): void => {
    if (rule?.kind === 'contract') names.add(rule.name);
    if (rule?.kind === 'equals' || rule?.kind === 'address-word') visit(rule.rule);
    if (rule?.kind === 'share-price') for (const q of [rule.assets, rule.shares]) if (q.kind === 'path') visit(q.rule);
    if (rule?.kind === 'call' || rule?.kind === 'keccak') rule.call.args.forEach(visit);
    if (rule?.kind === 'items') rule.items.forEach(visit);
    if (rule?.kind === 'fields') rule.fields.forEach(visit);
    if (rule?.kind === 'packed') rule.parts.forEach((part) => visit(part.rule));
    if (rule?.kind === 'eip712') {
      names.add(rule.message.domain.verifyingContract);
      rule.message.fields.forEach(visit);
    }
  };
  visit(template.nonce);
  for (const call of template.calls) {
    visit(call.to);
    visit(call.value);
    if (call.data !== 'empty') call.data.args.forEach(visit);
  }
  for (const view of template.effects.views) {
    if (view.to.kind === 'contract') names.add(view.to.name);
    view.args.forEach(visit);
  }
  namedEffectTokens(template.effects).forEach((name) => names.add(name));
  return names;
}

/** The registry contracts a computed field's reads call or pass, which `card new` reads and only the report checks. */
function namedInReads(template: Template): string[] {
  const read = ({ to, args }: ComputedRead): string[] => [
    ...(to.kind === 'contract' ? [to.name] : []),
    ...args.flatMap((arg) => (arg.kind === 'read' ? read(arg.read) : ruleLeaves(arg.rule).flatMap((rule) => (rule.kind === 'contract' ? [rule.name] : [])))),
  ];
  return [...template.card.values()].flatMap((field) => (field.kind === 'amount' && field.computed !== undefined ? read(field.computed.read) : []));
}

export const hasMarket = (template: Template): boolean => [...template.card.values()].some((field) => field.kind === 'market');

/** Every registry entry a card field can name: a contract of the field's kind, or a part of any market. */
function cardCandidates(template: Template, registry: Registry): RegistryEntry[] {
  const inMarkets = new Set(hasMarket(template) ? [...registry.markets.values()].flatMap((market) => MARKET_ENTRY_PARTS.map((part) => market[part].name)) : []);
  return [...registry.entries.values()].filter(
    (entry) => inMarkets.has(entry.name) || [...template.card.values()].some((field) => field.kind === 'contract' && inScope(field.scope, entry, registry)),
  );
}

/** The instance whose `pnpm vault-evidence` the report holds: a per-instance report's, or a `--vault` report's vault. */
export const evidenceEntries = (subject: Subject): RegistryEntry[] => (subject.kind === 'vault' ? [subject.vault] : subject.vault === undefined ? [] : [subject.vault]);

function directlyTouched(subject: Subject, registry: Registry): Set<string> {
  const names = new Set<string>();
  const roots = subject.kind === 'vault' ? [subject.vault] : [...[...namedInRules(subject.template), ...namedInReads(subject.template)].map((n) => registry.entries.get(n) as RegistryEntry), ...cardCandidates(subject.template, registry)];
  const named = (entry: RegistryEntry): void => {
    if (names.has(entry.name)) return;
    names.add(entry.name);
    for (const target of Object.values(entry.attributes)) {
      const attribute = registry.entries.get(target);
      if (attribute === undefined) names.add(target);
      else named(attribute);
    }
  };
  roots.forEach(named);
  if (subject.kind === 'template') for (const doc of subject.docs) names.add(doc.contract.name);
  if (subject.kind === 'template' && callsSafeWithData(subject.template)) {
    for (const entry of registry.entries.values()) if (entry.kind === 'singleton') names.add(entry.name);
  }
  return names;
}

/** A call to the Safe itself with data runs the Safe's singleton, one of the registry's. */
const callsSafeWithData = (template: Template): boolean => template.calls.some((call) => call.to.kind === 'safe' && call.data !== 'empty');

/**
 * Every registry entry the operation can touch, in registry order: those the template names, those a card field can
 * name, every entry those name as an attribute, such as a vault's asset and factory, and its attributes in turn, such as
 * the factory of a vault's adapter, and every entry any of these depends on.
 */
export function entriesOf(subject: Subject, registry: Registry): RegistryEntry[] {
  const names = directlyTouched(subject, registry);
  for (const name of [...names]) for (const target of registry.entries.get(name)?.dependsOn ?? []) names.add(target);
  return [...registry.entries.values()].filter((entry) => names.has(entry.name));
}

/**
 * The entries `verify` compares with their code pin at each signing, as `codeClaims` names them: each contract a rule
 * or a view names, each entry a card field can name, each a card reference's attribute names, and each these depend on.
 * An attribute no card reference reads, such as a vault's factory, is checked only by the report.
 */
export function signedEntryNames(template: Template, registry: Registry): Set<string> {
  const names = new Set([
    ...namedInRules(template),
    ...cardCandidates(template, registry).map((entry) => entry.name),
    ...cardRefs(template).flatMap((ref) => (ref.attribute === undefined ? [] : refNames(ref, template, registry))),
  ]);
  for (const name of [...names]) for (const target of registry.entries.get(name)?.dependsOn ?? []) names.add(target);
  return names;
}

/**
 * The entries whose ABI the program uses: each contract a call targets, a nested call's included, each a function's
 * page documents, each a view of the effects or a `facts` view reads, each token the effects move or an amount field
 * counts, each a computed field's read calls, each token or vault whose `decimals()` the protocol facts read, each Safe
 * singleton a call to the Safe itself runs, each vault the report holds evidence for, with its asset and its factory, whose `instanceCheck` it asks,
 * and the factory of each of `instanceEntries`, whose `instanceCheck` it asks too.
 */
function abiUsed(subject: Subject, registry: Registry): Set<string> {
  const names = new Set(evidenceEntries(subject).flatMap((entry) => [entry.name, ...[sizeOf(entry, registry)?.unit?.attribute, 'factory'].flatMap((key) => (key === undefined ? [] : (entry.attributes[key] ?? [])))]));
  for (const entry of instanceEntries(subject, registry)) names.add(entry.attributes.factory as string);
  if (subject.kind === 'vault') return names;
  const { template } = subject;
  subject.docs.forEach((doc) => names.add(doc.contract.name));
  if (callsSafeWithData(template)) for (const entry of registry.entries.values()) if (entry.kind === 'singleton') names.add(entry.name);
  for (const entry of entriesOf(subject, registry)) if (entry.kind === 'token' || entry.kind === 'vault') names.add(entry.name);
  const token = (ref: TokenRef): string[] => (ref === 'eth' ? [] : refNames(ref, template, registry));
  const read = (r: ComputedRead): string[] => [...viewTargetNames(r.to, template, registry), ...r.args.flatMap((arg) => (arg.kind === 'read' ? read(arg.read) : []))];
  [
    ...callTargetEntries(template, registry).map((entry) => entry.name),
    ...template.effects.views.flatMap((view) => viewTargetNames(view.to, template, registry)),
    ...template.facts.map((fact) => fact.to),
    ...[...template.effects.gives, ...template.effects.gets].flatMap((effect) => effectTokenNames(effect.token, template, registry)),
    ...template.effects.touches.map((touch) => touch.token),
    ...[...template.card.values()].flatMap((field) => (field.kind === 'amount' ? [...token(field.of), ...(field.computed === undefined ? [] : read(field.computed.read))] : [])),
  ].forEach((name) => names.add(name));
  return names;
}

/** The entries the operation can touch whose ABI the program does not use: no call or answer is decoded with it. */
export function abiUnused(subject: Subject, registry: Registry): Set<string> {
  const used = abiUsed(subject, registry);
  return new Set(entriesOf(subject, registry).flatMap((entry) => (used.has(entry.name) ? [] : [entry.name])));
}

/**
 * The entries `pnpm prove-abi` proves: not one whose ABI the program does not use, nor one with `routes`, whose calls
 * run in the implementations its routes reach, so no proof of one contract covers it.
 */
export function provedEntries(subject: Subject, registry: Registry): RegistryEntry[] {
  const unused = abiUnused(subject, registry);
  return entriesOf(subject, registry).filter((entry) => !unused.has(entry.name) && entry.routes === undefined);
}

/** The entries that name a registry factory, other than one whose stored evidence holds its factory's answers: the report asks these at its latest block (`readInstances`). */
export function instanceEntries(subject: Subject, registry: Registry): RegistryEntry[] {
  const stored = new Set(evidenceEntries(subject).map((entry) => entry.name));
  return entriesOf(subject, registry).filter((entry) => !stored.has(entry.name) && entry.attributes.factory !== undefined);
}

/** Every view of each of `instanceEntries`' factory's `instanceCheck`; undefined when there is none. */
export async function readInstances(reader: Reader, subject: Subject, registry: Registry, block: BlockRef): Promise<ReportInputs['instances']> {
  const asked = instanceEntries(subject, registry);
  if (asked.length === 0) return undefined;
  const answers = new Map<string, InstanceAnswers | InstanceUnasked>();
  for (const entry of asked) answers.set(entry.name, await proveInstance(reader, registry, entry.name, block));
  return { block, answers };
}

/** The entries no ABI proof compares with the chain, so the report reads their code at its latest block (`checkToday`). */
export function todayEntries(subject: Subject, registry: Registry): RegistryEntry[] {
  const proved = new Set(provedEntries(subject, registry).map((entry) => entry.name));
  return entriesOf(subject, registry).filter((entry) => !proved.has(entry.name));
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const declarationOf = (standard: Standard, fn: AbiFunction): string => standard.declarations.get(fn.signature) as string;

export function functionOnPage(doc: DocLink): RegExp {
  if (doc.standard !== undefined) return new RegExp(`${escaped(declarationOf(doc.standard, doc.fn))}(?![A-Za-z0-9_])`);
  const name = escaped(doc.fn.name);
  const called = `(?<![A-Za-z0-9_$])${name}\\(`;
  const inBackticks = `\`${name}\``;
  const aloneOrMarkdownHeading = `^(?:#{1,6} )?${name}$`;
  return new RegExp([called, inBackticks, aloneOrMarkdownHeading].join('|'));
}

export function docSiteLine(doc: DocLink, listings: Listings): Line {
  if (doc.standard === undefined) return sourceSiteLine(doc.url, doc.publisher, listings);
  const ref = githubRef(new URL(doc.url));
  const org = ref.kind === 'pinned' ? ref.owner.toLowerCase() : undefined;
  if (org === doc.standard.org) return { kind: 'agrees', check: 'defillama', text: `GitHub org ${org} publishes ${doc.standard.name}` };
  return { kind: 'finding', check: 'defillama', text: `source is GitHub org ${org ?? 'none'}; ${doc.standard.name} is published by ${doc.standard.org}`, cause: 'differs' };
}

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
  today: BlockRef | undefined,
  instances: BlockRef | undefined,
): ReportRecording {
  const base = trimForRecording(entries, listings, pages, fetched);
  const docs = subject.kind === 'template' ? subject.docs : [];
  const trimmed = Object.fromEntries(
    [...pages.pages].map(([url, page]) => [
      url,
      trimSourcePage(
        entries,
        pages.commits,
        url,
        page,
        docs.filter((d) => pageUrlOf(d.url) === url).map(functionOnPage),
      ),
    ]),
  );
  const at = (block: BlockRef) => ({ number: block.number.toString(), hash: block.hash });
  return {
    ...base,
    pages: trimmed,
    vaults: Object.fromEntries(vaults),
    erc7730,
    code: code.map(trimBlockAnswers),
    ...(today === undefined ? {} : { today: at(today) }),
    ...(instances === undefined ? {} : { instances: at(instances) }),
  };
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
    .map((f) => ({ file: join(RESEARCH_DIR, f), recording: readRecording(join(dir, f)) as PastTxsRecording }))
    .filter(({ file, recording: { query } }) => {
      if (!printableQuery(file, query)) throw new ReportError(`${file}: its name or query holds a value \`pnpm past-txs --record\` never writes`);
      const onVault = subject.vault === undefined || query.token.toLowerCase() === subject.vault.address;
      return subject.kind === 'template' ? query.template === subject.template.id && onVault : onVault;
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
    block(query.head) &&
    (query.head === undefined || (query.fromBlock === undefined && query.toBlock === undefined)) &&
    Number.isSafeInteger(query.maxTxs)
  );
}

export function pastTxsSampling(query: PastTxsRecording['query']): Sampling {
  if (query.fromBlock !== undefined && query.toBlock !== undefined) return { kind: 'range', range: { fromBlock: BigInt(query.fromBlock), toBlock: BigInt(query.toBlock) } };
  return query.head === undefined ? DEFAULT_SPREAD : { ...DEFAULT_SPREAD, head: BigInt(query.head) };
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
      sampling: pastTxsSampling(query),
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
/** A template's reason in each language it holds, so the signer reviews every text `card new` or `verify` may show. */
const byAi = (prose: Prose): string =>
  `written by the AI in the template: ${LANGUAGES.flatMap((language, i) => (prose[language] === undefined ? [] : [`${i === 0 ? '' : `in ${LANGUAGE_NAMES[language]}: `}${inline(prose[language])}`])).join('; ')}`;
/** Names, addresses, hashes, selectors and file paths, each parsed into a charset that holds no backtick or `|`. */
const code = (text: string): string => `\`${text}\``;
const full = (entry: RegistryEntry): string => `${code(entry.name)} ${code(checksumAddress(entry.address))}`;
const VERDICTS: Readonly<Record<Line['kind'], string>> = { agrees: 'PASS', absent: 'NOT LISTED', finding: 'FINDING', unverifiable: 'UNVERIFIABLE' };
const verdict = (line: Line | undefined): string => (line === undefined ? 'n/a' : VERDICTS[line.kind]);
/** A newest version that binds the label to other addresses names them, since no other line of the report does. */
const newestVerdict = (line: Line | undefined): string =>
  line?.kind === 'finding' && line.others !== undefined ? `FINDING: lists ${line.others.map((a) => code(checksumAddress(a))).join(', ')} under the same label` : verdict(line);

/** The deployer as the ledger counts it: PASS only through an entry confirmed in two other places, which it names. */
function deployerCell(line: Line | undefined, result: Result | undefined): string {
  if (line === undefined || result === undefined) return verdict(line);
  const word = line.kind === 'unverifiable' ? VERDICTS.unverifiable : result.finding.kind === 'agrees' ? VERDICTS.agrees : VERDICTS.finding;
  const shared = result.shared;
  return shared === undefined ? word : `${word} ${code(checksumAddress(shared.deployer))}${shared.siblings.length === 0 ? '' : `, also ${shared.siblings.map(code).join(', ')}`}`;
}

function readText(read: ComputedRead, template: Template, registry: Registry): string {
  const args = read.args.map((arg, i) => (arg.kind === 'read' ? readText(arg.read, template, registry) : argumentText(arg.rule, read.fn.params[i] as AbiParam, template, registry)));
  const to = read.to.kind === 'contract' ? `registry ${full(registry.entries.get(read.to.name) as RegistryEntry)}` : refText(read.to.ref);
  const output = read.returns.length === 1 && read.output.length === 1 ? '' : `, its ${code(computedOutput(read).name)}`;
  return `${code(read.fn.signature)} on ${to}${args.length === 0 ? '' : ` of ${args.join(', ')}`}${output}`;
}

function computedText(computed: Computed, template: Template, registry: Registry): string {
  const margin = computed.margin === undefined ? '' : `, plus a margin of ${computed.margin.bps} bps, ${byAi(computed.margin.why)}`;
  return `${readText(computed.read, template, registry)}, ${computed.bound === 'floor' ? 'less' : 'plus'} ${slippageBps(computed)} bps and rounded ${computed.bound === 'floor' ? 'down' : 'up'}: the protocol's default of ${computed.default.bps} bps, from ${computed.default.source}${margin}`;
}

function refText(ref: CardRef): string {
  return ref.attribute === undefined ? `the card's ${code(ref.field)}` : `the ${code(ref.attribute)} of the card's ${code(ref.field)}`;
}

function refAddresses(ref: CardRef, template: Template, registry: Registry): string {
  const kind = template.card.get(ref.field)?.kind;
  const names = refNames(ref, template, registry);
  if (kind !== 'contract' && (kind !== 'market' || names.length === 0)) return '';
  return `: one of ${names.map((n) => full(registry.entries.get(n) as RegistryEntry)).join(', ')}`;
}

const FREE_CLAIMS = {
  scalar: 'free',
  proof: 'free, claimed `proof`: every changed value must revert or be refused',
  unread: 'free, claimed `unread`: no changed value may change anything',
  route: "free, claimed `route`: a changed value may pick another pool, and must still meet every effect, which bounds each token the Safe gets",
} as const;

const quantityText = (q: Quantity): string => (q.kind === 'card' ? `the card's ${code(q.field)}` : `the number at ${code(q.path)}`);

function ruleText(rule: Rule, template: Template, registry: Registry): string {
  switch (rule.kind) {
    case 'card':
      return `${refText(rule.ref)}${refAddresses(rule.ref, template, registry)}`;
    case 'safe':
      return 'the Safe';
    case 'contract':
      return `registry ${full(registry.entries.get(rule.name) as RegistryEntry)}`;
    case 'address-word':
      return `${ruleText(rule.rule, template, registry)}, as a 32-byte word: the address left-padded with 12 zero bytes, and any other 32 bytes refused`;
    case 'const':
      return `constant ${code(rule.value.kind === 'string' ? JSON.stringify(Buffer.from(rule.value.value.slice(2), 'hex').toString('utf8')) : constText(rule.value))}`;
    case 'free':
      return `${FREE_CLAIMS[rule.claim]}; ${byAi(rule.reason)}`;
    case 'equals':
      return `the same number as ${code(rule.path)}, which is ${ruleText(rule.rule, template, registry)}`;
    case 'owner-before':
      return `the owner listed just before ${refText(rule.ref)} in the Safe's ${code('getOwners()')}, read on chain, or the sentinel ${code('0x0000000000000000000000000000000000000001')} when it is first`;
    case 'share-price':
      return `${rule.bound === 'max' ? 'at most' : 'at least'} assets × 1e${rule.scale} / shares, with assets ${quantityText(rule.assets)} and shares ${quantityText(rule.shares)}`;
    case 'at-least':
    case 'at-most':
      return `at ${rule.kind === 'at-least' ? 'least' : 'most'} the card's ${code(rule.field)}`;
    case 'call':
    case 'keccak':
    case 'items':
    case 'fields':
    case 'packed':
    case 'eip712':
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
    case 'packed': {
      const layout = rule.parts.map((part) => `${code(part.name)} ${code(canonicalType(part.type))}`).join(', ');
      const size = rule.parts.reduce((sum, part) => sum + part.size, 0);
      return [
        `| ${code(path)} | exactly ${size} bytes, packed with no padding: ${layout} |`,
        ...rule.parts.flatMap((part) => rowsOf(part.rule, `${path}.${part.name}`, { name: part.name, type: part.type }, template, registry)),
      ];
    }
    case 'eip712': {
      const { domain, struct, separator, lookup, answer } = rule.message;
      const contract = full(registry.entries.get(domain.verifyingContract) as RegistryEntry);
      const where = struct.members.flatMap((member, i) => {
        const source = answer.members[i] as MemberSource;
        const own = source.path.length === 1 && source.path[0] === member.name;
        return own && source.encoding === 'plain' ? [] : [`${code(member.name as string)} at ${code(pathText([...answer.path, ...source.path]))}${source.encoding === 'hex' ? ' in hex' : ''}`];
      });
      const held = answer.path.length === 0 ? '' : ` under ${code(pathText(answer.path))}`;
      return [
        `| ${code(path)} | the EIP-712 digest of a ${code(struct.encoded)} message, domain name ${code(domain.name)}, version ${code(domain.version)}, chain 1, verifying contract ${contract} (domain separator ${code(separator)}); the message is read from ${lookup.replace('{arg}', '<argument>')}${held}${where.length === 0 ? '' : `, ${where.join(', ')}`} and must hash to this digest |`,
        ...argRows(struct.members, rule.message.fields, `${path}.`, template, registry),
      ];
    }
    default:
      return [`| ${code(path)} | ${ruleText(rule, template, registry)} |`];
  }
}

function callRows(node: CallNode, prefix: string, template: Template, registry: Registry): string[] {
  const trailer = node.trailer === undefined ? 'no bytes after the arguments' : `at most ${node.trailer.maxBytes} bytes after the arguments; ${byAi(node.trailer.why)}`;
  if (node.encoding === 'params') {
    return [
      `| ${code(`${prefix}${node.fn.name}`)} | holds the parameters ${code(node.fn.signature)}, ABI-encoded with no selector; no bytes after them |`,
      ...argRows(node.fn.params, node.args, `${prefix}${node.fn.name}.`, template, registry),
    ];
  }
  return [
    `| ${code(`${prefix}${node.fn.name}`)} | calls ${code(node.fn.signature)}, selector ${code(node.fn.selector)}; ${trailer} |`,
    ...argRows(node.fn.params, node.args, `${prefix}${node.fn.name}.`, template, registry),
  ];
}

function tokenText(token: EffectToken, template: Template, registry: Registry): string {
  if (token === 'eth') return 'ETH';
  if (!isNamedToken(token)) return `${refText(token)}${refAddresses(token, template, registry)}`;
  const entry = registry.entries.get(token.contract);
  return entry === undefined ? code(token.contract) : full(entry);
}

/** A tolerance with the template's reason for it, after the amount it widens. */
const toleranceText = ({ less, more, why }: Tolerance): string => `; the Safe's balance may end ${toleranceSpan(less, more)} than that, for rounding; ${byAi(why)}`;

function effectRow(side: string, effect: Effect, template: Template, registry: Registry): string {
  const amount =
    effect.amount.kind === 'card'
      ? `the card's ${code(effect.amount.field)}`
      : effect.amount.kind === 'at-least' || effect.amount.kind === 'at-most'
        ? `at ${effect.amount.kind === 'at-least' ? 'least' : 'most'} the card's ${code(effect.amount.field)}${effect.amount.kind === 'at-most' ? ', and none gained' : ''}`
        : effect.amount.kind === 'positive'
          ? 'more than nothing'
          : effect.amount.kind === 'any'
            ? 'any amount, none included'
            : 'its whole balance';
  const to = effect.to === undefined ? '' : `, to ${refText(effect.to)}`;
  return `| ${side} | ${tokenText(effect.token, template, registry)} | ${amount}${to}${effect.tolerance === undefined ? '' : toleranceText(effect.tolerance)} |`;
}

function argumentText(rule: Rule, param: AbiParam, template: Template, registry: Registry): string {
  if (rule.kind === 'call' || rule.kind === 'keccak') {
    const { fn, args } = rule.call;
    const inner = fn.params.map((p, i) => `${code(paramName(p, i))} ${argumentText(args[i] as Rule, p, template, registry)}`).join('; ');
    return `${rule.kind === 'keccak' ? 'keccak256 of ' : ''}${code(fn.signature)} with (${inner})`;
  }
  if (rule.kind !== 'fields' || param.type.kind !== 'tuple') return ruleText(rule, template, registry);
  const { components } = param.type;
  return `(${rule.fields.map((field, i) => `${code(paramName(components[i] as AbiParam, i))} ${argumentText(field, components[i] as AbiParam, template, registry)}`).join('; ')})`;
}

function viewRow(view: ViewEffect, template: Template, registry: Registry): string {
  const returns = view.returns.map((r, i) => `${canonicalType(r.type)} ${paramName(r, i)}`).join(', ');
  const args = view.fn.params.map((param, i) => `${code(paramName(param, i))} ${argumentText(view.args[i] as Rule, param, template, registry)}`).join('; ');
  const changes = view.changes
    .map(({ value, change }) => `${code(paramName(view.returns[value] as AbiParam, value))} ${typeof change === 'string' ? change : `equals the card's ${code(change.equals)}`}`)
    .join('; ');
  const to = view.to.kind === 'contract' ? `registry ${full(registry.entries.get(view.to.name) as RegistryEntry)}` : `${refText(view.to.ref)}${refAddresses(view.to.ref, template, registry)}`;
  return `| ${to} | ${code(view.fn.signature)}, selector ${code(view.fn.selector)}, returns ${code(`(${returns})`)} | ${args} | ${changes} |`;
}

function templateSections(template: Template, docs: readonly DocLink[], inputs: ReportInputs): string[] {
  const { registry } = inputs;
  const out: string[] = ['## Card', '', '| Field | The signer gives |', '| --- | --- |'];
  for (const [name, field] of template.card) {
    const takes =
      field.kind === 'contract'
        ? `a registry ${code(field.scope.registryKind)}${field.scope.protocol === undefined ? '' : ` of the DefiLlama protocol ${code(field.scope.protocol)}`}${field.scope.marketPart === undefined ? '' : ` that is the ${code(field.scope.marketPart)} of a market in ${code(MARKETS_PATH)}`}, picked by number from the list below`
        : field.kind === 'amount'
          ? field.computed === undefined
            ? `an integer in base units of ${field.of === 'eth' ? 'ETH' : refText(field.of)}${field.max === undefined ? '' : `, or ${code('max')}, ${field.max.value}: ${byAi(field.max.why)}`}`
            : `nothing: computed by ${code('card new')} in base units of ${field.of === 'eth' ? 'ETH' : refText(field.of)}, ${computedText(field.computed, template, registry)}`
          : field.kind === 'percent'
            ? `a percent, at most 100, held in WAD base units (100% is ${WAD})`
          : field.kind === 'nonce'
            ? 'a Safe nonce'
            : field.kind === 'threshold'
              ? 'a whole number from 1: how many owners must sign'
            : field.kind === 'owner'
              ? 'an address-book name, confirmed by the signer'
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
    for (const entry of scopeEntries(field.scope, registry)) {
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
    const reads = call.to.kind === 'contract' && call.data !== 'empty' && call.data.trailer !== undefined ? registry.entries.get(call.to.name)?.ignoresTrailer : undefined;
    if (reads !== undefined) out.push('', `The registry entry of ${code(call.to.kind === 'contract' ? call.to.name : '')} declares it never reads calldata past a call's arguments, so this call's trailer may be longer than 19 bytes; ${byAi({ en: reads })}`);
    out.push('');
  });

  out.push('## Effects', '');
  if (template.effects.gives.length + template.effects.gets.length + template.effects.touches.length === 0) out.push(`The Safe gives and gets nothing: any change to its balances is a ${code('MISMATCH')}.`);
  else {
    out.push('| Side | Token | Amount |', '| --- | --- | --- |');
    for (const effect of template.effects.gives) out.push(effectRow('the Safe gives', effect, template, registry));
    for (const effect of template.effects.gets) out.push(effectRow('the Safe gets', effect, template, registry));
    for (const { token, tolerance } of template.effects.touches) {
      out.push(`| the Safe keeps | ${tokenText({ contract: token }, template, registry)} | unchanged${toleranceText(tolerance)} |`);
    }
  }
  const settings = template.effects.safe;
  if (settings !== undefined) {
    const owners = [
      ...(settings.remove === undefined ? [] : [`lose exactly ${refText(settings.remove)}, who must be an owner before`]),
      ...(settings.add === undefined ? [] : [`gain exactly ${refText(settings.add)}, who must not be an owner before`]),
    ];
    out.push(
      '',
      `The Safe's own settings, read just before and just after the transaction: its owners ${owners.length === 0 ? 'stay the same' : owners.join(', and ')}, compared as a set; its threshold ${settings.threshold === undefined ? 'stays the same' : `ends at ${refText(settings.threshold)}`}; its singleton, modules, guard and fallback handler stay the same. Any other change is a ${code('MISMATCH')}.`,
    );
  }
  for (const open of template.effects.approves) {
    const spender = registry.entries.get(open.spender) as RegistryEntry;
    const route = open.via === 'permit2' ? ', inside Permit2,' : '';
    const bound =
      open.amount.kind === 'card'
        ? `at no more than the card's ${code(open.amount.field)}`
        : `at any amount, unlimited included, as the registry entry declares a standing allowance: ${byAi({ en: spender.standingAllowance?.why ?? '' })}`;
    out.push('', `The Safe's allowance of ${tokenText(open.token, template, registry)}${route} to registry ${full(spender)} may end higher than it started, ${bound}; every other allowance may not rise.`);
  }
  if (template.effects.views.length > 0) {
    out.push('', 'The program calls each of these views just before and just after the transaction, and requires each named value to change as the row says:', '');
    out.push('| Contract | Function | Arguments | Change |', '| --- | --- | --- | --- |', ...template.effects.views.map((view) => viewRow(view, template, registry)));
  }

  out.push('', '## Official documentation', '');
  if (docs.length === 0) return [...out, `The template calls no function, so ${code(DOCS_FILE)} names no page.`, ''];
  out.push(
    `Each page comes from ${code(DOCS_FILE)}, whose contract must be the one the template calls the function on when the template binds it. The program compares the page's registrable domain, or GitHub organization, with the DefiLlama protocol that contract belongs to, its factory's for an entry a factory deploys, checks that a GitHub page is pinned to a commit on the default branch, and looks in the page as served, without scripts, for the function's name written as code: directly followed by ${code('(')}, between backticks, or alone as a block, such as a heading, a list item or a table cell. A PASS there shows that the page names a function of that name, not that it documents this contract's function. A function a token standard defines may instead name that standard: its page, the GitHub org that publishes it and the function's declaration are held by the program, the page must hold that declaration, and its org is compared with the standard's, not with the contract's protocol. Such a PASS shows that the standard defines the function, not that this contract follows the standard.`,
    '',
    '| Function | Contract | Page | Site | GitHub commit | Function on page |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const doc of docs) {
    const url = new URL(doc.url);
    const page = inputs.pages.pages.get(pageUrlOf(doc.url));
    const named = page?.kind === 'unread' ? 'UNVERIFIABLE' : page?.kind === 'served' && page.blocks.some((block) => functionOnPage(doc).test(block.text)) ? 'PASS' : 'FINDING';
    const github = isGitHubPage(url) ? verdict(githubLine(url, inputs.pages.commits)) : 'n/a';
    const link = doc.standard === undefined ? `<${doc.url}>` : `${doc.standard.name} standard page <${doc.url}>`;
    out.push(`| ${code(doc.fn.signature)} | ${code(doc.contract.name)} | ${link} | ${verdict(docSiteLine(doc, inputs.listings))} | ${github} | ${named} |`);
  }
  for (const doc of docs) {
    if (doc.standard !== undefined) out.push('', `${code(doc.fn.signature)} on ${code(doc.contract.name)}: the ${doc.standard.name} standard defines this function, as ${code(declarationOf(doc.standard, doc.fn))}; this does not show that the contract follows the standard.`);
  }
  out.push('');
  return out;
}

const routesText = (routes: readonly Route[]): string =>
  `routes ${routes.length === 0 ? 'none' : routes.map((route) => `${code(checksumAddress(route.address))} ${code(route.hash)} (${route.selectors.length} selectors)`).join(', ')}`;

function pinText(pin: CodePin): string {
  return [
    code(pin.hash),
    ...(pin.implementation === undefined ? [] : [`implementation ${code(checksumAddress(pin.implementation.address))} ${code(pin.implementation.hash)}`]),
    ...(pin.routes === undefined ? [] : [routesText(pin.routes)]),
  ].join('; ');
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
      const at = await readRunningCodeAt(reader, entry.address, from, entry);
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
      const before = await readRunningCodeAt(reader, entry.address, from - 1n, entry);
      if (before.kind === 'refused' && before.refusal.why === 'unverifiable') unverifiable(from - 1n);
      else if (before.kind === 'read' && (previous === undefined || !samePin(pinOf(before.code), previous))) finding(`block ${from - 1n} runs ${pinText(pinOf(before.code))}`);
      else if (before.kind === 'refused' && previous !== undefined) finding(`block ${from - 1n} runs no code it can pin, ${code(before.refusal.why)}`);
      else pass();
    }
    checked.set(entry.address, verdicts);
  }
  return checked;
}

/** An entry's code at the report's latest block as `checkToday` judged it: `text` is what the Markdown report prints. */
export type TodayCheck = { readonly kind: 'pass' | 'finding' | 'unverifiable'; readonly text: string };

/**
 * For each pinned entry, whether the code a call to it runs at `block`, its routes included, is its current pin, read
 * through both providers. Prints no text a provider gave.
 */
export async function checkToday(reader: Reader, entries: readonly RegistryEntry[], block: BlockRef): Promise<Map<Address, TodayCheck>> {
  const checked = new Map<Address, TodayCheck>();
  for (const entry of entries) {
    if (entry.code === undefined) continue;
    const read = await readRunningCode(reader, entry.address, block, entry);
    if (read.kind === 'refused') {
      checked.set(entry.address, read.refusal.why === 'unverifiable' ? { kind: 'unverifiable', text: 'UNVERIFIABLE' } : { kind: 'finding', text: `FINDING: runs no code it can pin, ${code(read.refusal.why)}` });
    } else {
      const now = pinOf(read.code);
      checked.set(entry.address, samePin(now, entry.code.current.pin) ? { kind: 'pass', text: 'PASS' } : { kind: 'finding', text: `FINDING: runs ${pinText(now)}` });
    }
  }
  return checked;
}

function spanRows(entry: RegistryEntry, verdicts: readonly SpanCheck[] | undefined): string[] {
  const name = `| ${code(entry.name)} |`;
  if (entry.code === undefined) return [`${name} | not pinned | | |`];
  return [...entry.code.earlier, entry.code.current].map(({ from, pin }, i) => {
    const implementation = pin.implementation === undefined ? 'none' : `${code(checksumAddress(pin.implementation.address))} ${code(pin.implementation.hash)}`;
    const routes = pin.routes === undefined ? '' : `; ${routesText(pin.routes)}`;
    return `${name} ${from} | ${code(pin.hash)} | ${implementation}${routes} | ${verdicts?.[i]?.text ?? 'not read'} |`;
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

function abiRow(entry: RegistryEntry, proof: AbiProof | AbiRefusal | undefined, unused: boolean, subject: Subject, registry: Registry): string {
  const name = `| ${code(entry.name)} | ${code(checksumAddress(entry.address))} |`;
  if (unused) return `${name} not proved: no call targets it and nothing the program reads is decoded with its ABI; its code pin is above | | | | | | | |`;
  if (entry.routes !== undefined) return `${name} not provable: a selector-routed proxy, whose calls run in the implementations its routes reach; its routes are pinned above | | | | | | | |`;
  if (proof === undefined) return `${name} not read | | | | | | | |`;
  if (proof.kind === 'refused') return `${name} REFUSED: ${code(proof.refusal.why)}${proof.refusal.why === 'compiler-not-pinned' ? ` solc ${code(proof.refusal.version)}` : ''} | | | | | | | ${proof.block.number} |`;
  const proxy = proof.proxy.kind === 'none' ? 'none' : `${proof.proxy.kind}, implementation ${code(checksumAddress(proof.proven))}`;
  const contract = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(proof.contractName) ? code(proof.contractName) : 'a name that is not a Solidity identifier';
  const metadata = proof.metadataHashMasked ? '; FINDING: the metadata hash differs, so the verified source is not the deployed text and its parameter names are not proven' : '';
  const masked = `${proof.immutablesMasked} immutable, ${proof.librariesMasked} library spans masked${metadata}`;
  const fns = functionsOn(subject, registry).get(entry.name) ?? [];
  const missing = missingFromAbi(subject, registry, entry, proof);
  const called = fns.length === 0 ? 'none' : missing.length === 0 ? `PASS, all ${fns.length}` : `FINDING: not in the ABI: ${missing.map(code).join(', ')}`;
  return `${name} PROVEN | ${proxy} | ${contract}, solc ${code(proof.compiler)} | ${code(proof.codeHash)} | ${pinVerdict(entry, proof)} | ${called} | ${masked} | ${proof.block.number} |`;
}

const COMMAND_FLAGS = ['token', 'anchor', 'from', 'to', 'fromBlock', 'toBlock', 'maxTxs'] as const;

/** A recording that keeps its head names itself with `--same-windows-as`, so the command searches its windows again. */
function pastTxsCommand({ query, file }: PastTxsSummary): string {
  const name = file.replace(/^.*\//, '').replace(/\.json$/, '');
  const flag = (key: (typeof COMMAND_FLAGS)[number]) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  const args = COMMAND_FLAGS.flatMap((key) => (query[key] === undefined ? [] : [`${flag(key)} ${String(query[key])}`]));
  const windows = query.head === undefined ? [] : [`--same-windows-as ${name}`];
  return `pnpm past-txs ${query.template} ${[...args, ...windows].join(' ')} --record ${name}`;
}

/** The characters `pnpm vault-evidence` prints. Its text is stored, not recomputed, so anything else is refused. */
const VAULT_TEXT = /^[A-Za-z0-9 \n%(),.:;=_/'"-]*$/;

/** A ```text block. Program output never holds three backticks, so text that does could close the block and is refused. */
function fenced(text: string): string[] {
  if (text.includes('```')) throw new ReportError('a section to print in a text block holds ```');
  return ['```text', text, '```'];
}

/** The `pnpm report` arguments that name a subject's report. */
export const reportArgs = (subject: Subject): string =>
  subject.kind === 'vault' ? `--vault ${subject.vault.name}` : `${subject.template.id}${subject.vault === undefined ? '' : ` --vault-of ${subject.vault.name}`}`;

export const compareCommand = (subject: Subject): string => `pnpm report ${reportArgs(subject)} --compare`;

const usdText = (usd: number | undefined): string => (usd === undefined ? 'none given' : Math.round(usd).toString());

function amountText(amount: bigint, token: 'eth' | Address, facts: ProtocolFacts, registry: Registry): string {
  if (token === 'eth') return `${code(amount.toString())} (${wholeTokens(amount, 18)} ETH)`;
  const name = registry.byAddress.get(token)?.name ?? checksumAddress(token);
  const decimals = facts.decimals.get(token);
  return decimals?.kind === 'read' ? `${code(amount.toString())} (${wholeTokens(amount, decimals.value)} ${code(name)})` : `${code(amount.toString())} base units of ${code(name)}`;
}

function ratioText(a: bigint, b: bigint): string {
  if (b === 0n) return 'n/a, divides by zero';
  const basis = (a * 10_000n) / b;
  return `${basis / 100n}.${(basis % 100n).toString().padStart(2, '0')}%`;
}

function readingRow(reading: FactReading, facts: ProtocolFacts, registry: Registry): string {
  const { fact, value, read } = reading;
  const name = value.kind === 'market' ? value.market.name : value.entry.name;
  if (read.kind === 'unread') return `| ${code(name)} | not read: ${read.why} |${' |'.repeat(fact.units.length - 1 + (fact.ratio === undefined ? 0 : 1))}`;
  const cells = read.value.map(({ amount, token }) => amountText(amount, token, facts, registry));
  if (fact.ratio !== undefined) {
    const at = (position: number) => read.value[fact.units.findIndex((u) => u.value === position)]?.amount as bigint;
    cells.push(ratioText(at(fact.ratio[0]), at(fact.ratio[1])));
  }
  return `| ${code(name)} | ${cells.join(' | ')} |`;
}

function factsSection(template: Template, facts: ProtocolFacts | undefined, registry: Registry): string[] {
  const out = ['## Protocol facts', ''];
  if (facts === undefined) return [...out, `Not read: this report's recording predates the protocol facts; ${code(`pnpm report ${template.id} --record`)} reads them.`, ''];
  if (facts.protocols.length + facts.unlisted.length + template.facts.length + facts.decimals.size === 0) {
    return [...out, 'Nothing to read: no call of this template goes to a registry contract other than a token, it declares no facts view, and no registry token or vault is in its scope.', ''];
  }
  out.push(
    `What DefiLlama and the chain say about the protocols this template's calls go to, other than a token's issuer, and the size of what each card field can name. They decide nothing, and ${code('verify')} never reads them. TVL is DefiLlama's estimate. DefiLlama's hacks list holds only what someone reported, and a hack counts here only when DefiLlama files it under the protocol's DefiLlama id or its parent's. Each view and ${code('decimals()')} is read through both providers at block ${facts.block.number} ${code(facts.block.hash)}; a read they do not agree on prints as not read.`,
    '',
  );
  if (facts.protocols.length === 0) out.push('No call of this template goes to a contract other than a token.', '');
  else {
    out.push('| Protocol | DefiLlama id | Parent | Listed from | TVL (USD, DefiLlama) | Ethereum TVL (USD, DefiLlama) |', '| --- | --- | --- | --- | --- | --- |');
    for (const { slug, listing } of facts.protocols) {
      if (listing.kind === 'unread') out.push(`| ${code(slug)} | not read: ${listing.why} | | | | |`);
      else {
        const { id, parent, listedFrom, tvl, ethereumTvl } = listing.value;
        out.push(`| ${code(slug)} | ${code(id)} | ${parent === undefined ? 'none' : code(parent)} | ${listedFrom ?? 'none given'} | ${usdText(tvl)} | ${usdText(ethereumTvl)} |`);
      }
    }
    out.push('', '| Protocol | Hack date | Amount (USD) |', '| --- | --- | --- |');
    for (const { slug, listing, hacks } of facts.protocols) {
      if (listing.kind === 'unread') out.push(`| ${code(slug)} | not read | |`);
      else if (hacks.length === 0) out.push(`| ${code(slug)} | none filed under its id or its parent's | |`);
      else for (const hack of hacks) out.push(`| ${code(slug)} | ${hack.date} | ${usdText(hack.amount)} |`);
    }
    out.push('', '| Contract | Address | Protocol | Proxy, from its code pin |', '| --- | --- | --- | --- |');
    for (const { slug, contracts } of facts.protocols) {
      for (const { entry, proxy } of contracts) out.push(`| ${code(entry.name)} | ${code(checksumAddress(entry.address))} | ${code(slug)} | ${proxy} |`);
    }
    out.push('');
  }
  for (const entry of facts.unlisted) out.push(`${full(entry)} names no DefiLlama protocol, so no protocol facts are read for it.`, '');
  for (const fact of template.facts) {
    const names = fact.units.map((u) => paramName(fact.returns[u.value] as AbiParam, u.value));
    const ratio = fact.ratio === undefined ? [] : [`${paramName(fact.returns[fact.ratio[0]] as AbiParam, fact.ratio[0])} / ${paramName(fact.returns[fact.ratio[1]] as AbiParam, fact.ratio[1])}`];
    out.push(`### ${code(fact.fn.signature)} on ${code(fact.to)}`, '', `For each value the card's ${code(fact.field)} can name.${fact.reason === undefined ? '' : ` The ratio: ${byAi(fact.reason)}`}`, '');
    out.push(`| Value | ${[...names, ...ratio].join(' | ')} |`, `| --- |${' --- |'.repeat(names.length + ratio.length)}`);
    for (const reading of facts.readings.filter((r) => r.fact === fact)) out.push(readingRow(reading, facts, registry));
    out.push('');
  }
  if (facts.decimals.size > 0) {
    out.push('### Token decimals', '', '| Token | Address | decimals() |', '| --- | --- | --- |');
    for (const [address, decimals] of facts.decimals) {
      const entry = registry.byAddress.get(address) as RegistryEntry;
      out.push(`| ${code(entry.name)} | ${code(checksumAddress(address))} | ${decimals.kind === 'read' ? decimals.value : `not read: ${decimals.why}`} |`);
    }
    out.push('');
  }
  return out;
}

function factoryAnswersSection(inputs: ReportInputs): string[] {
  const asked = instanceEntries(inputs.subject, inputs.registry);
  if (asked.length === 0) return [];
  const block = inputs.instances?.block.number ?? '';
  const rows = asked.flatMap((entry) => {
    const proof = inputs.instances?.answers.get(entry.name);
    const factory = entry.attributes.factory as string;
    if (proof === undefined) return [`| ${code(entry.name)} | ${code(factory)} | not read | ${block} |`];
    if (proof.kind === 'unasked') return [`| ${code(entry.name)} | ${code(factory)} | REFUSED: ${proof.why} | ${block} |`];
    return proof.answers.map((read) => {
      const namedBy = read.namer !== undefined && read.asker?.name !== read.namer.name ? `, for ${code(read.namer.name)}` : '';
      const asker = read.asker === undefined ? '' : `${code(read.asker.name)} `;
      return `| ${code(entry.name)} | ${asker}${code(read.asked)}${namedBy} | ${read.kind === 'vouched' ? read.answered : `REFUSED: ${read.why}`} | ${block} |`;
    });
  });
  return [
    '### Factory answers',
    '',
    `Each entry that names a registry ${code('factory')}, other than an instance whose stored evidence holds its factory's answers: what, through both providers at the report's latest block, every view of that factory's ${code('instanceCheck')} answered, each asked of the factory, the entry itself, or a registry entry it names or that names it. An entry's answers together are one place for its address, which counts only when every one passes.`,
    '',
    '| Entry | Asked | Answer | Block |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ];
}

function todaySection(inputs: ReportInputs): string[] {
  const checked = todayEntries(inputs.subject, inputs.registry);
  if (checked.length === 0) return [];
  const result = (entry: RegistryEntry): string => (entry.code === undefined ? 'not pinned' : (inputs.today?.checks.get(entry.address)?.text ?? 'not read'));
  return [
    "### Today's code",
    '',
    `No ABI proof compares these entries' code with the chain: no call or answer is decoded with one's ABI, or its calls run in the implementations its ${code('routes')} reach. Today: whether, through both providers, the code a call to it runs at the report's latest block, its routes included, is its current pin.`,
    '',
    '| Entry | Today | Block |',
    '| --- | --- | --- |',
    ...checked.map((entry) => `| ${code(entry.name)} | ${result(entry)} | ${inputs.today?.block.number ?? ''} |`),
    '',
  ];
}

function routesSection(entries: readonly RegistryEntry[]): string[] {
  const routed = entries.filter((entry) => entry.routes !== undefined);
  if (routed.length === 0) return [];
  const rows = (entry: RegistryEntry): string[] =>
    (entry.code === undefined ? [] : [...entry.code.earlier, entry.code.current]).flatMap(({ from, pin }) =>
      (pin.routes ?? []).map((route) => `| ${code(entry.name)} | ${from} | ${code(checksumAddress(route.address))} | ${route.selectors.map(code).join(', ')} |`),
    );
  return [
    '### Routes',
    '',
    `Each implementation an entry's ${code('routes')} reach, in every span of its code pin, with every selector it serves. ${code('pnpm pin-code')} reaches an implementation only through a seed: it asks the proxy which implementation each seed routes to, then which selectors that implementation serves. No view lists the implementations, so one no seed reaches is not in the pin, and neither the report nor a signing checks it.`,
    '',
    ...routed.flatMap((entry) => [`${code(entry.name)} seeds: ${(entry.routes as SelectorRouting).seeds.map(code).join(', ')}.`, '']),
    '| Entry | From block | Implementation | Selectors |',
    '| --- | --- | --- | --- |',
    ...routed.flatMap(rows),
    '',
  ];
}

function entrySections(entries: readonly RegistryEntry[], inputs: ReportInputs): string[] {
  const out: string[] = [];
  const unused = abiUnused(inputs.subject, inputs.registry);
  const checked = checkSources(entries, inputs.listings, inputs.pages);
  out.push(
    '## Registry entries',
    '',
    `${code('pnpm check-sources')} on every entry the operation can touch. ${code(`pnpm check-sources ${entries.map((e) => e.name).join(' ')}`)} prints what each check compared.`,
    '',
    `Newest version: for a source pinned to a GitHub commit on the default branch, which addresses the same file at the tip of that branch binds to the same label; it is the same place, so it never counts as one.`,
    '',
    '| Entry | Address | Kind | Source | Site | CoinGecko coin | GitHub commit | Newest version | Address on page |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const { entry, lines } of checked) {
    const of = (check: Line['check']) => lines.find((l) => l.check === check && l.more === undefined);
    out.push(
      `| ${code(entry.name)} | ${code(checksumAddress(entry.address))} | ${entry.kind} | <${entry.source}> | ${verdict(of('defillama'))} | ${verdict(of('coingecko'))} | ${verdict(of('github'))} | ${newestVerdict(of('tip'))} | ${verdict(of('page') ?? of('url'))} |`,
    );
  }
  const more = checked.flatMap(({ entry, lines }) => (entry.moreSources ?? []).map((page, i) => ({ entry, page, lines: lines.filter((l) => l.more === i + 1) })));
  if (more.length > 0) {
    out.push(
      '',
      `Each entry's ${code('moreSources')}: more official pages that list its address, each checked as the source is.`,
      '',
      '| Entry | Page | Site | GitHub commit | Newest version | Address on page |',
      '| --- | --- | --- | --- | --- | --- |',
      ...more.map(({ entry, page, lines }) => {
        const of = (check: Line['check']) => lines.find((l) => l.check === check);
        return `| ${code(entry.name)} | <${page.url}> | ${verdict(of('defillama'))} | ${verdict(of('github'))} | ${newestVerdict(of('tip'))} | ${verdict(of('page'))} |`;
      }),
    );
  }
  const deployers = new Map(judge(inputs, []).results.flatMap((r) => (r.source?.of === 'deployer' && r.about.kind === 'entry' ? [[r.about.entry.name, r] as const] : [])));
  const placed = checked.filter(({ lines }) => lines.some((l) => l.check === 'bounty' || l.check === 'sdk' || l.check === 'deployer'));
  if (placed.length > 0) {
    out.push(
      '',
      `More places that may name the address: the scope of every Immunefi program tied to the entry's protocol, which the program finds, and of the one the entry names; its pinned SDK package (the address next to its label in the file, and the GitHub organization npm's provenance names for the tarball), and which addresses npm's latest version binds to the same label; and who sent the transaction that created it, with the other entries of its protocol here the same sender created. A shared deployer counts only through an entry confirmed in two other places; a program not tied to the protocol and the SDK's latest version never count.`,
      '',
      '| Entry | Bounty scope | SDK file | SDK publisher | SDK latest | Deployer |',
      '| --- | --- | --- | --- | --- | --- |',
      ...placed.map(({ entry, lines }) => {
        const of = (check: Line['check']) => lines.find((l) => l.check === check);
        return `| ${code(entry.name)} | ${verdict(of('bounty'))} | ${verdict(of('sdk'))} | ${verdict(of('sdk-site'))} | ${newestVerdict(of('sdk-latest'))} | ${deployerCell(of('deployer'), deployers.get(entry.name))} |`;
      }),
    );
  }
  const findings = checked.flatMap((r) => r.lines.filter((l) => l.kind === 'finding'));
  out.push('', `${checked.length} entries, ${findings.length} findings.`, '');
  const asked = checked.filter(({ entry }) => entry.apiSource !== undefined);
  if (asked.length > 0) {
    out.push(
      '### Official APIs',
      '',
      `Each entry's ${code('apiSource')}: the protocol's own API, asked with the request the registry holds, and the address at the path the registry names in its JSON answer. Address in answer: whether it is the entry's address. API site: the API's registrable domain against the DefiLlama protocol's website, as for the source. Both are counted in the findings above.`,
      '',
      '| Entry | API | Path | Address in answer | API site |',
      '| --- | --- | --- | --- | --- |',
      ...asked.map(({ entry, lines }) => {
        const of = (check: Line['check']) => lines.find((l) => l.check === check);
        const api = entry.apiSource as NonNullable<RegistryEntry['apiSource']>;
        return `| ${code(entry.name)} | ${api.method} <${api.url}> | ${code(pathText(api.path))} | ${verdict(of('api'))} | ${verdict(of('api-site'))} |`;
      }),
      '',
    );
  }
  out.push(...factoryAnswersSection(inputs));

  out.push(
    '## Code pins',
    '',
    `Every span of each entry's registry code pin, oldest first: a span holds from its block to the block before the next span's. A transaction to sign must run the last span's code, and an executed one the code of the span that holds its block. ${code('pnpm pin-code')} writes the spans from the chain, not from a review of that code. Chain: whether, through both providers, the code at the span's first block is its pin, and the code at the block before is the previous span's pin, or for the first span, no code ${code('pnpm pin-code')} can pin. A lone pin from block 0 was written before ranges and is not read.`,
    '',
    ...(entries.some((entry) => entry.routes !== undefined)
      ? [
          `An entry with ${code('routes')} sends each function selector to an implementation of its own: after its implementation, the span lists each implementation its seeds reach, with its code hash and how many selectors it serves.`,
          '',
        ]
      : []),
    '| Entry | From block | Code hash | Implementation | Chain |',
    '| --- | --- | --- | --- | --- |',
    ...entries.flatMap((entry) => spanRows(entry, inputs.spans.get(entry.address))),
    '',
    ...todaySection(inputs),
    ...routesSection(entries),
  );

  out.push(
    '## ABI proofs',
    '',
    `${code('pnpm prove-abi')}: Etherscan's verified source, compiled with a pinned solc, against the code both providers return; Etherscan's own ABI is not read. Equals pin: whether the proved code, and the implementation behind a proxy, are the last span of the registry's code pin, which every signing of a new transaction requires. Template functions: whether every function the template calls or reads on the entry, by canonical signature, is in the compiled ABI.`,
    '',
    '| Entry | Address | Result | Proxy | Contract and compiler | Code hash | Equals pin | Template functions | Masked | Block |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...entries.map((entry) => abiRow(entry, inputs.abi.get(entry.address), unused.has(entry.name), inputs.subject, inputs.registry)),
    '',
  );
  return out;
}

export function renderReport(inputs: ReportInputs, title: ReportTitle): string {
  const { subject, registry } = inputs;
  const entries = entriesOf(subject, registry);
  const name = subject.kind === 'template' ? subject.template.id : subject.vault.name;
  const out: string[] = [
    `# Generated evidence: ${name}`,
    '',
    `Written by ${code(title.command)} from ${title.sources.map(code).join(', ')}. The listings and pages were read on ${inputs.fetched}. ${code('pnpm test')} computes it again from these files and fails on any difference: every section is recomputed from the recorded answers except the vault evidence, which is stored as ${code('pnpm vault-evidence')} printed it. The recordings were made on the AI's computer; ${code(compareCommand(subject))} reads the listings, pages, ABI proofs, code spans, ERC-7730 attestations and DefiLlama's protocol entries and hacks live, reads each vault again at the blocks its evidence names and each protocol fact and token's decimals at the block it was read at, fetches each recorded past transaction again by hash, and prints each fact that differs. It does not search for past transactions again, so it cannot show that a search found every one. Text from outside the program appears only as identifiers: a contract name Etherscan gives, printed only when it is a Solidity identifier, and the file paths, field paths and format names ${code('pnpm erc7730')} prints. The URLs come from the registry and ${code(DOCS_FILE)}, in RFC 3986 characters only. Text the AI wrote appears only where a row says it was written by the AI in the template. Do not edit this file.`,
    '',
  ];
  if (subject.kind === 'template') out.push(...templateSections(subject.template, subject.docs, inputs));

  if (entries.length === 0) {
    for (const heading of ['Registry entries', 'Code pins', 'ABI proofs']) out.push(`## ${heading}`, '', 'The operation touches no registry entry.', '');
  } else out.push(...entrySections(entries, inputs));

  const vaults = evidenceEntries(subject);
  if (vaults.length > 0) {
    out.push('## Vaults', '', `For each vault, the stored output of ${code('pnpm vault-evidence')}, not recomputed by ${code('pnpm test')}; ${code('pnpm report --compare')} reads it again at the blocks it names.`, '');
    for (const vault of vaults) {
      const text = inputs.vaults.get(vault.name) ?? 'not read';
      if (!VAULT_TEXT.test(text)) throw new ReportError(`the stored vault evidence of ${vault.name} holds a character ${code('pnpm vault-evidence')} never prints`);
      out.push(`### ${code(vault.name)}`, '', ...fenced(text), '');
    }
  }

  if (subject.kind === 'template') out.push(...factsSection(subject.template, inputs.facts, registry));

  out.push('## Past transactions', '');
  if (inputs.pastTxs.length === 0) out.push(`No ${code('pnpm past-txs --record')} recording names this ${subject.kind}.`, '');
  for (const summary of inputs.pastTxs) {
    out.push(`### ${code(summary.file)}`, '', `Recorded with ${code(pastTxsCommand(summary))}, and studied again here with the template as it is now.`, '', ...fenced(summary.text.trimEnd()), '');
  }

  out.push('## ERC-7730', '');
  if (entries.length === 0) out.push('The operation touches no registry entry, so no descriptor can apply.', '');
  else {
    out.push(
      `${code(`pnpm erc7730 ${entries.map((e) => e.name).join(' ')}`)}: each entry's calldata descriptors in the pinned ERC-7730 registry, and each ERC-8176 attestation checked. A second opinion on field meanings, never a rule.`,
      '',
      ...fenced(inputs.erc7730.text),
      '',
    );
  }
  return out.join('\n');
}

/** `checkToday` on `todayEntries` at `block`; undefined when no entry needs it. */
export async function readToday(reader: Reader, subject: Subject, registry: Registry, block: BlockRef): Promise<ReportInputs['today']> {
  const checked = todayEntries(subject, registry);
  return checked.length === 0 ? undefined : { block, checks: await checkToday(reader, checked, block) };
}

/** ABI proofs from the recorded cases alone, compiled again with the pinned solc. */
export async function replayAbiProofs(entries: readonly RegistryEntry[], cases: ReadonlyMap<Address, AbiCase>, compilers: Compilers): Promise<Map<Address, AbiProof | AbiRefusal>> {
  const proofs = new Map<Address, AbiProof | AbiRefusal>();
  for (const entry of entries) {
    const recorded = cases.get(entry.address);
    if (recorded !== undefined) proofs.set(entry.address, await replayAbiCase(recorded, compilers, entry));
  }
  return proofs;
}

export type ReportTitle = { readonly command: string; readonly sources: readonly string[] };

/** The report from the repository and its recordings alone, as its committed `.generated.md` holds it. */
export async function replayReport(repoRoot: string, registry: Registry, target: Target, compilers: Compilers, suffixes: Listings['suffixes']): Promise<string> {
  const { inputs, title } = await replayInputs(repoRoot, registry, target, compilers, suffixes);
  return renderReport(inputs, title);
}

async function replayFacts(template: Template, registry: Registry, entries: readonly RegistryEntry[], raw: unknown): Promise<ProtocolFacts | undefined> {
  const recorded = parseFactsRecording(raw);
  return recorded === undefined ? undefined : protocolFacts(factsScope(template, registry, entries), registry, replaySources(recorded));
}

/** Every input a generated report renders, from the repository and its recordings alone. */
export async function replayInputs(
  repoRoot: string,
  full: Registry,
  target: Target,
  compilers: Compilers,
  suffixes: Listings['suffixes'],
): Promise<{ readonly inputs: ReportInputs; readonly title: ReportTitle }> {
  const { subject, registry } = loadReport(repoRoot, full, target);
  const recordingPath = reportRecordingPath(target);
  const recording = readRecording(join(repoRoot, recordingPath)) as ReportRecording;
  const entries = entriesOf(subject, registry);
  const docUrls = subject.kind === 'template' ? subject.docs.map((d) => d.url) : [];
  const pages = sourcePagesOf(recording);
  const pastRecordings = pastTxsRecordings(repoRoot, subject);
  const snapshot: Snapshot = { commit: recording.erc7730.commit, files: new Map(Object.entries(recording.erc7730.files)) };
  const inputs: ReportInputs = {
    subject,
    registry,
    listings: await listingsFor(entries, suffixes, recordedListingReads(recording), [...entries.flatMap(pageUrlsOf), ...docUrls, ...provenanceRepositories(pages.packages ?? new Map())]),
    pages,
    fetched: recording.fetched,
    abi: await replayAbiProofs(provedEntries(subject, registry), loadAbiCases(repoRoot), compilers),
    vaults: new Map(Object.entries(recording.vaults)),
    pastTxs: await Promise.all(pastRecordings.map(({ file, recording: r }) => summarizePastTxs(repoRoot, registry, file, r))),
    spans: await checkSpans(replayReader(recording.code), entries),
    today: recording.today === undefined ? undefined : await readToday(replayReader(recording.code), subject, registry, { number: BigInt(recording.today.number), hash: recording.today.hash }),
    instances:
      recording.instances === undefined ? undefined : await readInstances(replayReader(recording.code), subject, registry, { number: BigInt(recording.instances.number), hash: recording.instances.hash }),
    erc7730: await erc7730Text(entries, registry, snapshot, () => chainAt(replayReader(recording.erc7730.chain))),
    facts: subject.kind === 'template' ? await replayFacts(subject.template, registry, entries, recording.facts) : undefined,
  };
  const registryFiles = subject.kind === 'template' && hasMarket(subject.template) ? [REGISTRY_PATH, MARKETS_PATH] : [REGISTRY_PATH];
  const inputsFiles = 'vault' in target ? registryFiles : [join(TEMPLATES_DIR, target.template, 'template.json'), ...docsPaths(repoRoot, target.template, target.cardVault), ...registryFiles];
  const sources = [...inputsFiles, recordingPath, ABI_CASES_DIR, ...pastRecordings.map((p) => p.file)];
  const command = `pnpm report ${reportArgs(subject)} --record`;
  return { inputs, title: { command, sources } };
}

/**
 * Where a fact sits in a report: its heading, then a table row's first cell and the column, or for a text line, the
 * nearest line above it at the left margin, such as the ERC-7730 entry an attestation belongs to.
 */
type Facts = { readonly cells: Map<string, string>; readonly lines: Map<string, string[]> };

/**
 * What changes between two honest reads: the block an answer was read at, and DefiLlama's TVL. A vault's evidence and
 * the protocol facts are read again at their own blocks.
 */
const IGNORED_COLUMNS = new Set(['Block', 'TVL (USD, DefiLlama)', 'Ethereum TVL (USD, DefiLlama)']);
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
