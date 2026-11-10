import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { replayReader } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import { ABI_CASES_DIR, loadAbiCases, replayAbiCase } from '../contracts/abi-case.ts';
import type { AbiCase } from '../contracts/abi-case.ts';
import type { AbiProof, AbiRefusal } from '../contracts/prove.ts';
import type { Compilers } from '../contracts/solc.ts';
import { paramName } from '../decode/abi.ts';
import type { AbiFunction, AbiParam } from '../decode/abi.ts';
import { REGISTRY_PATH } from '../registry.ts';
import type { Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import { TEMPLATES_DIR, loadTemplate } from '../template/template.ts';
import type { CallNode, CardRef, Effect, Quantity, Rule, Template, TokenRef } from '../template/template.ts';
import type { Line, Listings, ListingsRecording } from './listings.ts';
import { checkSources, githubLine, parseCoinGeckoCoins, parseDefiLlamaProtocols, sourcePagesOf, sourceSiteLine, trimForRecording, trimPage } from './listings.ts';
import { DEFAULT_SPREAD, pastTxs, renderPastTxs } from './past-txs.ts';
import type { PastTxsRecording } from './recording.ts';
import { isGitHubPage, pageUrlOf } from './source-page.ts';
import type { SourcePages } from './source-page.ts';
import { chainAt, formatReports, studyEntries } from './erc7730.ts';
import type { ChainAccess, EntryReport, Snapshot } from './erc7730.ts';
import { constText } from './study.ts';
import { replayAsk } from './sources.ts';
import type { AnchorKind } from './sources.ts';

export type Subject = { readonly kind: 'template'; readonly template: Template; readonly docs: readonly DocLink[] } | { readonly kind: 'vault'; readonly vault: RegistryEntry };

/** The official page the AI names for one function. The program checks the page; the AI writes no text about it. */
export type DocLink = { readonly fn: AbiFunction; readonly contract: RegistryEntry; readonly url: string };

/** The ERC-7730 files the section read, cut as `pnpm erc7730 --record` cuts them, and the attestation reads. */
export type Erc7730Section = { readonly commit: string; readonly files: Readonly<Record<string, string>>; readonly chain: readonly Exchange[] };

/** A program-made recording of the live answers a template's report used, beside the ABI and past-transaction ones. */
export type ReportRecording = ListingsRecording & { readonly vaults: Readonly<Record<string, string>>; readonly erc7730: Erc7730Section };

export type PastTxsSummary = { readonly file: string; readonly query: PastTxsRecording['query']; readonly text: string };

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
  /** What `pnpm erc7730` prints for the entries. */
  readonly erc7730: string;
};

export class ReportError extends Error {
  override name = 'ReportError';
}

export const DOCS_FILE = 'docs.json';
export const GENERATED_FILE = 'report.generated.md';
export const REPORT_RECORDINGS_DIR = join('testdata', 'report');
const RESEARCH_DIR = join('testdata', 'research');

export const recordingName = (id: string): string => id.replace('/', '-');

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

/** `docs.json`: each function the template calls, by canonical signature, to `{ contract, url }`. Nothing else. */
export function parseDocs(raw: unknown, template: Template, registry: Registry): DocLink[] {
  if (!isRecord(raw)) throw new ReportError(`${DOCS_FILE}: not a JSON object`);
  const fns = templateFunctions(template);
  const extra = Object.keys(raw).find((key) => !fns.some((fn) => fn.signature === key));
  if (extra !== undefined) throw new ReportError(`${DOCS_FILE}: ${JSON.stringify(extra.slice(0, 80))} is not a function the template calls`);
  return fns.map((fn) => {
    const value = raw[fn.signature];
    if (value === undefined) throw new ReportError(`${DOCS_FILE}: no page for ${fn.signature}`);
    if (!isRecord(value) || Object.keys(value).sort().join() !== 'contract,url') throw new ReportError(`${DOCS_FILE}: ${fn.signature} must hold exactly contract and url`);
    const contract = typeof value.contract === 'string' ? registry.entries.get(value.contract) : undefined;
    if (contract === undefined) throw new ReportError(`${DOCS_FILE}: ${fn.signature}.contract is not a registry name`);
    if (typeof value.url !== 'string' || !/^https:\/\/\S+$/.test(value.url) || !URL.canParse(value.url)) throw new ReportError(`${DOCS_FILE}: ${fn.signature}.url is not an https URL`);
    return { fn, contract, url: value.url };
  });
}

export function loadSubject(repoRoot: string, registry: Registry, target: { readonly template: string } | { readonly vault: string }): Subject {
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
  return names;
}

const cardCandidates = (template: Template, registry: Registry): RegistryEntry[] =>
  [...registry.entries.values()].filter((entry) => [...template.card.values()].some((field) => field.kind === 'contract' && field.registryKind === entry.kind));

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

const wordOf = (fn: AbiFunction): RegExp => new RegExp(`(?<![A-Za-z0-9_$])${fn.name.replace(/\$/g, '\\$')}(?![A-Za-z0-9_$])`);

/** Keeps of each page only what the report's checks read: the entries' addresses and the documented function names. */
export function trimReportRecording(
  subject: Subject,
  entries: readonly RegistryEntry[],
  listings: Listings,
  pages: SourcePages,
  fetched: Date,
  vaults: ReadonlyMap<string, string>,
  erc7730: Erc7730Section,
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
  return { ...base, pages: trimmed, vaults: Object.fromEntries(vaults), erc7730 };
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
    .filter(({ recording: { query } }) => (subject.kind === 'template' ? query.template === subject.template.id : query.token.toLowerCase() === subject.vault.address));
}

/** Runs the study again on a recording, with the template as it is now. */
export async function summarizePastTxs(repoRoot: string, registry: Registry, file: string, recording: PastTxsRecording): Promise<PastTxsSummary> {
  const { query } = recording;
  const run = await pastTxs(
    {
      template: loadTemplate(repoRoot, query.template, registry),
      anchor: { token: query.token as Address, kind: query.anchor as AnchorKind, ...(query.from === undefined ? {} : { from: query.from as Address }) },
      sampling:
        query.fromBlock === undefined || query.toBlock === undefined ? DEFAULT_SPREAD : { kind: 'range', range: { fromBlock: BigInt(query.fromBlock), toBlock: BigInt(query.toBlock) } },
    },
    { ask: replayAsk(recording.sources), reader: replayReader(recording.exchanges), registry, exclude: undefined, maxTxs: query.maxTxs },
  );
  return { file, query, text: renderPastTxs(run, registry) };
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const code = (text: string): string => `\`${text}\``;
const full = (entry: RegistryEntry): string => `${code(entry.name)} ${code(checksumAddress(entry.address))}`;
const verdict = (line: Line | undefined): string => (line === undefined ? 'n/a' : line.kind === 'agrees' ? 'PASS' : 'FINDING');

function refText(ref: CardRef): string {
  return ref.attribute === undefined ? `the card's ${code(ref.field)}` : `the ${code(ref.attribute)} of the card's ${code(ref.field)}`;
}

function refAddresses(ref: CardRef, template: Template, registry: Registry): string {
  const field = template.card.get(ref.field);
  if (field?.kind !== 'contract') return '';
  const { attribute } = ref;
  const candidates = [...registry.entries.values()].filter((e) => e.kind === field.registryKind);
  const names = attribute === undefined ? candidates.map((e) => e.name) : candidates.flatMap((e) => e.attributes[attribute] ?? []);
  return `: one of ${[...new Set(names)].map((n) => full(registry.entries.get(n) as RegistryEntry)).join(', ')}`;
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
      return `${FREE_CLAIMS[rule.claim]}; the template's reason: ${rule.reason}`;
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
      return [`| ${code(path)} | ${cell(ruleText(rule, template, registry))} |`];
  }
}

function callRows(node: CallNode, prefix: string, template: Template, registry: Registry): string[] {
  const trailer = node.trailer === undefined ? 'no bytes after the arguments' : `at most ${node.trailer.maxBytes} bytes after the arguments; the template's reason: ${node.trailer.why}`;
  return [
    `| ${code(`${prefix}${node.fn.name}`)} | calls ${code(node.fn.signature)}, selector ${code(node.fn.selector)}; ${cell(trailer)} |`,
    ...argRows(node.fn.params, node.args, `${prefix}${node.fn.name}.`, template, registry),
  ];
}

function tokenText(token: TokenRef, template: Template, registry: Registry): string {
  return token === 'eth' ? 'ETH' : `${refText(token)}${refAddresses(token, template, registry)}`;
}

function effectRow(side: string, effect: Effect, template: Template, registry: Registry): string {
  const amount = effect.amount.kind === 'card' ? `the card's ${code(effect.amount.field)}` : effect.amount.kind === 'positive' ? 'more than nothing' : 'its whole balance';
  const to = effect.to === undefined ? '' : `, to ${refText(effect.to)}`;
  return `| ${side} | ${cell(tokenText(effect.token, template, registry))} | ${amount}${to} |`;
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
  if (template.same.length > 0) out.push('', `Must name one address: ${template.same.map(refText).join(', ')}.`);
  if (template.nonce !== undefined) out.push('', `The Safe transaction's nonce: ${ruleText(template.nonce, template, registry)}.`);

  out.push('', '## Calls and field rules', '');
  template.calls.forEach((call, i) => {
    out.push(`### Call ${i + 1} of ${template.calls.length}`, '', '| Field | Rule |', '| --- | --- |');
    out.push(`| ${code('to')} | ${cell(ruleText(call.to, template, registry))} |`, `| ${code('value')} | ${cell(ruleText(call.value, template, registry))} |`);
    if (call.data === 'empty') out.push(`| ${code('data')} | empty |`);
    else out.push(...callRows(call.data, '', template, registry));
    if (call.merge !== undefined) out.push('', `Several operations on one card share this call; the template's reason: ${call.merge}`);
    out.push('');
  });

  out.push('## Effects', '', '| Side | Token | Amount |', '| --- | --- | --- |');
  for (const effect of template.effects.gives) out.push(effectRow('the Safe gives', effect, template, registry));
  for (const effect of template.effects.gets) out.push(effectRow('the Safe gets', effect, template, registry));

  out.push(
    '',
    '## Official documentation',
    '',
    `Each page comes from ${code(DOCS_FILE)}. The program compares its registrable domain, or GitHub organization, with the DefiLlama protocol of the contract named, checks that a GitHub page is pinned to a commit on the default branch, and looks for the function's name in the page as served, without scripts.`,
    '',
    '| Function | Contract | Page | Site | GitHub commit | Name on page |',
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

function pinText(entry: RegistryEntry): string {
  const pin = entry.code;
  if (pin === undefined) return 'not pinned';
  return pin.implementation === undefined ? code(pin.hash) : `${code(pin.hash)}; implementation ${code(checksumAddress(pin.implementation.address))} ${code(pin.implementation.hash)}`;
}

/** The pin names the code the proof compiled: the proxy's code and its implementation's, or the contract's own. */
function pinVerdict(entry: RegistryEntry, proof: AbiProof): string {
  const pin = entry.code;
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

const COMMAND_FLAGS = ['token', 'anchor', 'from', 'fromBlock', 'toBlock', 'maxTxs'] as const;

function pastTxsCommand({ query, file }: PastTxsSummary): string {
  const flag = (key: (typeof COMMAND_FLAGS)[number]) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  const args = COMMAND_FLAGS.flatMap((key) => (query[key] === undefined ? [] : [`${flag(key)} ${String(query[key])}`]));
  return `pnpm past-txs ${query.template} ${args.join(' ')} --record ${file.replace(/^.*\//, '').replace(/\.json$/, '')}`;
}

export function renderReport(inputs: ReportInputs, title: { readonly command: string; readonly sources: readonly string[] }): string {
  const { subject, registry } = inputs;
  const entries = entriesOf(subject, registry);
  const name = subject.kind === 'template' ? subject.template.id : subject.vault.name;
  const out: string[] = [
    `# Generated evidence: ${name}`,
    '',
    `Written by ${code(title.command)} from ${title.sources.map(code).join(', ')}. The listings and pages were read on ${inputs.fetched}. It holds no text from a web page, a token, a contract's source, an ERC-7730 descriptor, or an API answer, and no prose from the AI except the reasons the template states. Do not edit it: ${code('pnpm test')} writes it again from the same files and fails on any difference.`,
    '',
  ];
  if (subject.kind === 'template') out.push(...templateSections(subject.template, subject.docs, inputs));

  const checked = checkSources(entries, inputs.listings, inputs.pages);
  out.push(
    '## Registry entries',
    '',
    `${code('pnpm check-sources')} on every entry the operation can touch. ${code(`pnpm check-sources ${entries.map((e) => e.name).join(' ')}`)} prints what each check compared.`,
    '',
    '| Entry | Address | Kind | Source | DefiLlama site | CoinGecko coin | GitHub commit | Address on page | Code pin |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const { entry, lines } of checked) {
    const of = (check: Line['check']) => lines.find((l) => l.check === check);
    out.push(
      `| ${code(entry.name)} | ${code(checksumAddress(entry.address))} | ${entry.kind} | <${entry.source}> | ${verdict(of('defillama'))} | ${verdict(of('coingecko'))} | ${verdict(of('github'))} | ${verdict(of('page') ?? of('url'))} | ${pinText(entry)} |`,
    );
  }
  const findings = checked.flatMap((r) => r.lines.filter((l) => l.kind === 'finding'));
  out.push('', `${checked.length} entries, ${findings.length} findings.`, '');

  out.push(
    '## ABI proofs',
    '',
    `${code('pnpm prove-abi')}: Sourcify's source, compiled with a pinned solc, against the code both providers return. Equals pin: whether the proved code, and the implementation behind a proxy, are the registry's code pin, which every signing requires.`,
    '',
    '| Entry | Address | Result | Proxy | Contract and compiler | Code hash | Equals pin | Masked | Block |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...entries.map((entry) => abiRow(entry, inputs.abi.get(entry.address))),
    '',
  );

  const vaults = vaultsOf(subject, registry);
  if (vaults.length > 0) {
    out.push('## Vaults', '', `${code('pnpm vault-evidence')} for each vault.`, '');
    for (const vault of vaults) out.push(`### ${code(vault.name)}`, '', '```text', inputs.vaults.get(vault.name) ?? 'not read', '```', '');
  }

  out.push('## Past transactions', '');
  if (inputs.pastTxs.length === 0) out.push(`No ${code('pnpm past-txs --record')} recording names this ${subject.kind}.`, '');
  for (const summary of inputs.pastTxs) {
    out.push(`### ${code(summary.file)}`, '', `Recorded with ${code(pastTxsCommand(summary))}, and studied again here with the template as it is now.`, '', '```text', summary.text.trimEnd(), '```', '');
  }

  out.push(
    '## ERC-7730',
    '',
    `${code(`pnpm erc7730 ${entries.map((e) => e.name).join(' ')}`)}: each entry's calldata descriptors in the pinned ERC-7730 registry, and each ERC-8176 attestation checked. A second opinion on field meanings, never a rule.`,
    '',
    '```text',
    inputs.erc7730,
    '```',
    '',
  );
  return out.join('\n');
}

export const reportRecordingPath = (id: string): string => join(REPORT_RECORDINGS_DIR, `${recordingName(id)}.json`);

/** ABI proofs from the recorded cases alone, compiled again with the pinned solc. */
export async function replayAbiProofs(entries: readonly RegistryEntry[], cases: ReadonlyMap<Address, AbiCase>, compilers: Compilers): Promise<Map<Address, AbiProof | AbiRefusal>> {
  const proofs = new Map<Address, AbiProof | AbiRefusal>();
  for (const entry of entries) {
    const recorded = cases.get(entry.address);
    if (recorded !== undefined) proofs.set(entry.address, await replayAbiCase(recorded, compilers));
  }
  return proofs;
}

/** The report of a template from the repository and its recordings alone, as `report.generated.md` holds it. */
export async function replayTemplateReport(repoRoot: string, registry: Registry, id: string, compilers: Compilers, suffixes: Listings['suffixes']): Promise<string> {
  const subject = loadSubject(repoRoot, registry, { template: id });
  const recordingPath = reportRecordingPath(id);
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
    erc7730: (await erc7730Text(entries, registry, snapshot, () => chainAt(replayReader(recording.erc7730.chain)))).text,
  };
  const sources = [join(TEMPLATES_DIR, id, 'template.json'), join(TEMPLATES_DIR, id, DOCS_FILE), REGISTRY_PATH, recordingPath, ABI_CASES_DIR, ...pastRecordings.map((p) => p.file)];
  return renderReport(inputs, { command: `pnpm report ${id} --record`, sources });
}
