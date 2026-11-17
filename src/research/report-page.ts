import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { resolveRef } from '../card.ts';
import type { ResolvedCard, ResolvedValue } from '../card.ts';
import { SHOWN_PLACES, groupedTokens, wholeTokens } from '../chain/decimals.ts';
import { castValue } from '../decode/cast.ts';
import type { AbiParam } from '../decode/abi.ts';
import { namedSignatureOfAbiEntry, paramName, parseFunctionSignature } from '../decode/abi.ts';
import type { AbiValue } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import { say } from '../language.ts';
import type { Language } from '../language.ts';
import { MARKET_PARAMS, parseHttpsUrl, sizeOf } from '../registry.ts';
import type { HttpsUrl, Market, Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { decodeTemplateCall } from '../template/check.ts';
import type { FixtureJudgement } from '../template/perturb.ts';
import { addressWord, isNamedToken, refNames, slippageBps, viewTargetNames, wordAddress } from '../template/template.ts';
import type { CardField, CardRef, ConstValue, EffectToken, KeptApproval, FreeClaim, PackedPart, Rule, Template, TemplateCall, Tolerance, TokenRef, ViewEffect, ViewExpectation } from '../template/template.ts';
import { distributionOf, effectText } from './amounts.ts';
import type { Difference } from './amounts.ts';
import type { FieldFact } from './erc7730.ts';
import { latestOf, packageKey } from './npm-package.ts';
import { tipUrlOf } from './source-page.ts';
import type { DeployerShare, SitePlace } from './listings.ts';
import { weightOf } from './grades.ts';
import type { Grade } from './grades.ts';
import { MIN_CONFIRMATIONS, addressRows, confidence, confirmations, docOf, forSigner, judge, needsSigner, sourcesOf, stateOf, strip, worst } from './ledger.ts';
import type { Confidence, FindingKind, Ledger, Phrase, ProgramSource, Result, ResultId, State, StripLine } from './ledger.ts';
import { NOTES_FILE, argumentTree, notesLanguages, notesPath, notesScope, parseNotes } from './notes.ts';
import type { ArgNode, Notes } from './notes.ts';
import { PERCENTILES, amountsOf, freeNumbers } from './past-txs.ts';
import type { PastTxsRecording } from './recording.ts';
import { factsScope } from './protocol-facts.ts';
import { functionNames, isOtherOperation, misfitText } from './study.ts';
import type { CallName, MisfitReason, Sender, TxStudy } from './study.ts';
import { readStoredEvidence } from './vault-evidence.ts';
import type { StoredPoint } from './vault-evidence.ts';
import type { ProtocolFacts, ProtocolSheet } from './protocol-facts.ts';
import { signedEntryNames } from './report.ts';
import type { ReportInputs, ReportTitle } from './report.ts';
import { WORDS } from './report-words.ts';
import type { Words } from './report-words.ts';

declare const anchorBrand: unique symbol;
/** An id the page itself gives an element: a section, or an address row (`a-<registry name>`). A link names only these or an HttpsUrl. */
export type Anchor = string & { readonly [anchorBrand]: true };
const anchor = (id: string): Anchor => id as Anchor;
export const entryAnchor = (name: string): Anchor => anchor(`a-${name}`);

/** Program text. Monospace only for what the signer compares character by character. */
export type Span =
  | string
  | { readonly code: string }
  | { readonly mono: string }
  | { readonly num: string }
  | { readonly href: HttpsUrl | Anchor; readonly label: string };
export type Inline = readonly Span[];

/** The dashed tag on AI text: research, a bare AI note, or the verdict's status. */
export type AiTag = 'research' | 'ai' | 'safe' | 'caution';

/** AI text. Never an Inline, so the renderer prints it only through the one function that adds the dashed tag. */
export type AiText = { readonly ai: string; readonly sources: readonly HttpsUrl[]; readonly tag: AiTag };

const research = (text: string, sources: readonly HttpsUrl[] = [], tag: AiTag = 'research'): AiText => ({ ai: text, sources, tag });

export type RailCount =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'states'; readonly counts: readonly { readonly state: State | 'ask'; readonly n: number; readonly grade?: Grade }[] };

export type Page = {
  readonly language: Language;
  /** The operation id, and for a per-vault report the vault it covers. */
  readonly id: string;
  readonly header: Header;
  readonly sections: readonly Section[];
  readonly footer: Inline;
};

export type Section = { readonly anchor: Anchor; readonly label: string; readonly count: RailCount | undefined; readonly body: Body };

export type Body =
  | { readonly kind: 'flow'; readonly flow: Flow }
  | { readonly kind: 'protocol'; readonly block: ProtocolBlock }
  | { readonly kind: 'vault'; readonly vault: VaultBlock }
  | { readonly kind: 'review'; readonly rows: readonly ReviewRow[]; readonly judgments: readonly Judgment[] }
  | { readonly kind: 'wallet'; readonly view: WalletView }
  | { readonly kind: 'addresses'; readonly open: readonly AddressRow[]; readonly folded: readonly AddressRow[] }
  | { readonly kind: 'past'; readonly same: Inline; readonly conclusion: AiText | undefined; readonly amounts: readonly PastAmounts[]; readonly spreads: readonly PastSpread[]; readonly recordings: readonly PastRecording[] }
  | { readonly kind: 'next'; readonly steps: readonly NextStep[]; readonly automatic: readonly Inline[] };

export type NextStep = { readonly say: Inline; readonly command: string | undefined; readonly then: readonly Inline[]; readonly hashes: boolean };

export type Header = {
  readonly title: AiText;
  readonly summary: AiText;
  /** Said when the notes hold this page's language alone: no page in another language exists. */
  readonly onlyIn: string | undefined;
  readonly strip: readonly StripItem[];
  /** The program's worst state over every result, never the AI's status, beside the AI's one line. */
  readonly verdict: { readonly state: State; readonly text: AiText };
};

export type StripItem = { readonly line: StripLine | 'providers'; readonly name: string; readonly state: State; readonly count: string | undefined; readonly explain: string };

export type Who = 'you-type' | 'you-pick' | 'fixed' | 'free' | 'bounded';
export type KeyItem = { readonly who: Who; readonly label: string; readonly means: string };
export type Chip = { readonly who: Who; readonly label: string };

/** A value from the example: of the first recorded test transaction, or naming its Safe as another Safe. */
export type ExampleTag = 'example' | 'other-safe';

export type ArgRow = {
  readonly key: string;
  readonly name: string;
  readonly chips: readonly Chip[];
  /** As `cast decode-calldata` prints it; `example` tags a value from the first recorded test transaction, naming its Safe as another Safe. */
  readonly value: { readonly cast: string; readonly example: ExampleTag | undefined } | undefined;
  readonly words: Inline;
  readonly qualifier: Inline | undefined;
  readonly id: Inline | undefined;
  /** What the argument does, from notes.json; none on a row the program adds, such as a call's `to`. */
  readonly ai: AiText | undefined;
  readonly parts: readonly { readonly label: Inline | undefined; readonly rows: readonly ArgRow[] }[];
  /** The nested call's documentation page, on a `bytes` argument the template binds to a call. */
  readonly doc: DocLine | undefined;
};

export type CallHead = { readonly kind: 'fn'; readonly contract: string; readonly fn: string; readonly selector: Hex; readonly doc: DocLine } | { readonly kind: 'no-data'; readonly text: string };
export type CallBlock = { readonly n: number; readonly head: CallHead; readonly sends: Inline | undefined; readonly args: readonly ArgRow[] };

export type AfterRow = { readonly label: Inline; readonly value: Inline; readonly note: Inline; readonly gains: boolean; readonly ai?: AiText };

export type Lifeline = { readonly name: string; readonly role: string };
export type Arrow =
  | { readonly kind: 'call'; readonly n: number; readonly to: number; readonly fn: string }
  | { readonly kind: 'inside'; readonly from: number; readonly to: number; readonly text: AiText }
  | { readonly kind: 'gets'; readonly from: number; readonly text: string };
export type Sequence = { readonly lifelines: readonly Lifeline[]; readonly arrows: readonly Arrow[]; readonly narration: string };

export type Flow = {
  readonly diagram: Sequence;
  /** The who-decides key: each word some row uses, in key order, with what it means; a free field once per claim it makes. */
  readonly key: readonly KeyItem[];
  /** Whether a call has data, so its rows print what `cast decode-calldata` prints. */
  readonly decoded: boolean;
  readonly example: Inline | undefined;
  /** The Safe transaction's own rules, such as a cancellation's nonce. */
  readonly safeTx: readonly ArgRow[];
  readonly calls: readonly CallBlock[];
  readonly after: readonly AfterRow[];
};

export type ProtocolRow = {
  readonly label: string;
  readonly value: Inline;
  readonly sub: Inline | undefined;
  readonly ai: AiText | undefined;
  readonly nested: readonly { readonly label: Inline; readonly value: Inline; readonly ai: AiText | undefined }[];
};
export type ProtocolBlock = { readonly read: string; readonly intro: AiText; readonly rows: readonly ProtocolRow[]; readonly sources: readonly { readonly label: string; readonly href: HttpsUrl | undefined }[] };

/** One monthly `totalAssets()` reading: `share` of the largest reading, undefined when there is no amount to draw. */
export type VaultBar = { readonly date: string; readonly words: string; readonly share: number | undefined };
export type VaultBlock = {
  readonly lead: Inline;
  readonly rows: readonly { readonly label: string; readonly value: Inline; readonly note: Inline }[];
  /** Oldest first. */
  readonly bars: readonly VaultBar[];
  readonly most: string | undefined;
};

export type ReviewRow = {
  readonly id: ResultId;
  readonly state: State;
  readonly grade: Grade;
  readonly title: Inline;
  readonly why: Inline;
  readonly entry: Anchor | undefined;
  readonly review: { readonly status: 'confirmed' | 'concern'; readonly text: AiText; readonly recommendation: AiText };
};
export type Judgment = { readonly text: AiText; readonly recommendation: AiText };

export type WalletCall = { readonly n: number; readonly title: Inline; readonly rows: readonly { readonly label: Inline; readonly value: Inline }[] | 'no-descriptor' };

/** A template of two or more calls goes through MultiSend, which no hardware wallet decodes, so it has no per-call view. */
export type WalletView =
  | { readonly kind: 'multisend'; readonly calls: number }
  | { readonly kind: 'no-data' }
  | { readonly kind: 'calls'; readonly calls: readonly WalletCall[]; readonly lines: readonly Inline[] };

/** A result on an address row: its state, and the words a result that did not pass adds to its icon. */
export type RowResult = { readonly state: State; readonly phrase: Phrase | undefined };
/** A place a site is compared with, by its word and its page. */
export type PlaceLink = { readonly word: string; readonly href: HttpsUrl | undefined };

/** A page's or the API's site, compared with the sites the places that list the entry's protocol `slug` name. */
export type SiteResult = RowResult & { readonly slug: string | undefined; readonly places: readonly PlaceLink[] };
/** What the newest version of a pinned page or SDK binds to the same label; `where` is its branch or npm version. */
export type NewestResult = RowResult & { readonly where: string; readonly others: readonly string[] };
/** A program source: whether it showed the address, for a page or the API its site, and for a pinned page or SDK its newest version. */
export type SourceLine = RowResult & {
  readonly label: string;
  readonly href: HttpsUrl | undefined;
  /** The addresses the source binds the label to instead of the entry's. */
  readonly others: readonly string[];
  readonly site: SiteResult | undefined;
  readonly newest: NewestResult | undefined;
};
/** A function's documentation page from docs.json, linked, with the worst of its results; a standard's page carries its caveat. */
export type DocLine = RowResult & { readonly label: string; readonly href: HttpsUrl; readonly note: string | undefined };
export type AiSourceResult = 'pass' | 'attention' | 'fail';
/** A source the AI checked by hand: its text and link, and its result, which is no program result. */
export type AiSource = { readonly text: AiText; readonly result: AiSourceResult };
/** The AI's reviews of an entry's results: all confirmed, or one with a concern. */
export type Reviewed = 'confirmed' | 'concern';

export type AddressRow = {
  readonly anchor: Anchor;
  readonly name: string;
  readonly state: State;
  readonly role: AiText | undefined;
  readonly confidence: Confidence;
  readonly reviewed: Reviewed | undefined;
  readonly address: string;
  readonly sources: readonly SourceLine[];
  /** The places that confirmed the address, in plain words. */
  readonly confirmed: string;
  readonly codeLines: readonly Inline[];
  readonly aiSources: readonly AiSource[];
};

/**
 * Transactions with the template's shape outside the registry at the same places, or that did not have the template's
 * shape for one reason; `calls` names their calls when the reason is about calls.
 */
export type PastGroup = { readonly count: number; readonly senders: number; readonly calls: Inline | undefined; readonly reason: Inline; readonly examples: readonly Span[] };
/** The transactions of one kind of sender that used the operation's calls: how many, how many had the template's shape, and why the rest did not. */
export type PastBlock = { readonly title: string; readonly lead: Inline; readonly groups: readonly PastGroup[] };
/** One party's differences from a stated amount: each number of base units with how many transactions ended there. */
export type PastAmountRow = { readonly party: string; readonly cells: readonly { readonly by: string; readonly n: string }[] };
/** One measured effect of one recording, shown beside its tolerance, with the finding when the evidence and the tolerance disagree. */
export type PastAmounts = {
  readonly effect: string;
  readonly tolerance: string;
  readonly tokens: readonly { readonly count: number; readonly lead: string; readonly rows: readonly PastAmountRow[] }[];
  readonly finding: string | undefined;
  readonly unmeasured: string | undefined;
};
/** One free number of one recording and sender type: the smallest value, the percentiles and the largest, each with its label. */
export type PastSpread = {
  readonly field: string;
  readonly who: string;
  readonly lead: string;
  readonly count: number;
  readonly cells: readonly { readonly label: string; readonly value: string }[];
  readonly unrecorded: string | undefined;
};
export type PastRecording = { readonly file: string; readonly count: string; readonly search: Inline; readonly blocks: readonly PastBlock[]; readonly others: readonly Inline[] };

/** Everything the HTML report reads beyond the Markdown report's inputs. */
export type HtmlInputs = ReportInputs & {
  readonly fixtures: readonly FixtureJudgement[];
  /** The first recorded test transaction of the template, with its card. */
  readonly example: { readonly name: string; readonly tx: SafeTx; readonly card: ResolvedCard } | undefined;
};

/** A card field's word from its kind; a typed amount by what it counts: shares for a vault's own shares, an amount for an asset or ETH. */
function kindWord(field: CardField, template: Template, w: Words): string {
  switch (field.kind) {
    case 'contract':
      return w.kind[field.scope.registryKind];
    case 'amount': {
      if (field.computed !== undefined) return field.computed.bound === 'floor' ? w.field.floor : w.field.ceiling;
      const of = field.of === 'eth' || field.of.attribute !== undefined ? undefined : template.card.get(field.of.field);
      return of?.kind === 'contract' && of.scope.registryKind === 'vault' ? w.field.shares : w.field.amount;
    }
    case 'address':
    case 'recipient':
    case 'nonce':
    case 'owner':
    case 'threshold':
    case 'market':
    case 'percent':
      return w.field[field.kind];
  }
}

/** A card field in the signer's words, from its kind; with its name in brackets when another field of the template has the same word. */
function fieldWord(template: Template, name: string, w: Words): string {
  const field = template.card.get(name);
  if (field === undefined) return name;
  const word = kindWord(field, template, w);
  return [...template.card.values()].filter((f) => kindWord(f, template, w) === word).length > 1 ? w.named(word, name) : word;
}

/** A card reference in the signer's words: the field, and the attribute or market part it names. */
const refWord = (template: Template, ref: CardRef, w: Words): string =>
  ref.attribute === undefined ? fieldWord(template, ref.field, w) : w.partOf(fieldWord(template, ref.field, w), (w.part as Readonly<Partial<Record<string, string>>>)[ref.attribute] ?? ref.attribute);

/**
 * Each official page of an entry by its short URL: the `source` as `page`, each of `moreSources` as `more.<n>`. Two
 * pages that would share a short URL, such as two files of one GitHub repository, each add their file name.
 */
function pageLabels(entry: RegistryEntry): Map<ProgramSource, string> {
  const pages: [ProgramSource, HttpsUrl][] = [['page', entry.source], ...(entry.moreSources ?? []).map((more, i): [ProgramSource, HttpsUrl] => [`more.${i + 1}`, more.url])];
  return new Map(pages.map(([source, url]) => [source, pageLabel(url, pages.map(([, other]) => other))]));
}

/** A page by its short URL, with its file name added when another of `among` would share that short URL. */
const pageLabel = (url: HttpsUrl, among: readonly HttpsUrl[]): string =>
  among.some((other) => other !== url && shortUrl(other) === shortUrl(url)) ? withFileName(url) : shortUrl(url);

const withFileName = (url: HttpsUrl): string => {
  const short = shortUrl(url);
  const file = new URL(url).pathname.split('/').filter((p) => p !== '').at(-1) ?? '';
  return file === '' || short.endsWith(`/${file}`) ? short : `${short}/…/${file}`;
};

function docLine(signature: string, context: Context): DocLine {
  const docs = context.inputs.subject.kind === 'template' ? context.inputs.subject.docs : [];
  const doc = docs.find((d) => d.fn.signature === signature);
  if (doc === undefined) throw new Error(`docs.json names no page for ${signature}`);
  const { state, phrase } = docOf(context.ledger, doc);
  const result = { state, phrase, href: doc.url };
  if (doc.standard !== undefined) return { ...result, label: context.w.standardPage(doc.standard.name), note: context.w.standardNote };
  return { ...result, label: pageLabel(doc.url, docs.filter((d) => d.standard === undefined).map((d) => d.url)), note: undefined };
}

const PLACE_PAGES: Readonly<Record<SitePlace['kind'], { readonly word: (w: Words) => string; readonly page: (id: string) => string }>> = {
  defillama: { word: () => 'DefiLlama', page: (id) => `https://defillama.com/protocol/${id}` },
  coingecko: { word: () => 'CoinGecko', page: (id) => `https://www.coingecko.com/en/coins/${id}` },
  immunefi: { word: () => 'Immunefi', page: (id) => `https://immunefi.com/bug-bounty/${id}/` },
  github: { word: (w) => w.githubDomains, page: (id) => `https://github.com/${id}` },
};

/** Each place a site was compared with, linked; with none, DefiLlama, the one place every entry names. */
const placeLinks = (entry: RegistryEntry, places: readonly SitePlace[], w: Words): PlaceLink[] =>
  places.length === 0
    ? [{ word: 'DefiLlama', href: entry.defillama === undefined ? undefined : parseHttpsUrl(PLACE_PAGES.defillama.page(entry.defillama)) }]
    : places.map((place) => ({ word: PLACE_PAGES[place.kind].word(w), href: parseHttpsUrl(PLACE_PAGES[place.kind].page(place.id)) }));

const sourceWord = (entry: RegistryEntry, source: ProgramSource, w: Words, registry: Registry): string =>
  source === 'sdk' && entry.sdk !== undefined
    ? `npm ${entry.sdk.package}@${entry.sdk.version}`
    : source === 'factory' && (registry.entries.get(entry.attributes.factory ?? '')?.instanceCheck?.length ?? 0) > 1
      ? w.factoryChecks
      : (pageLabels(entry).get(source) ?? w.source[source as Exclude<ProgramSource, 'page' | `more.${number}` | 'sdk'>]);

/** The newest version a source's newest result read: the default branch of a pinned GitHub page, or npm's latest version of the SDK. */
function newestWhere(entry: RegistryEntry, source: ProgramSource, inputs: ReportInputs): string {
  if (source === 'sdk' && entry.sdk !== undefined) {
    const read = inputs.pages.packages?.get(packageKey(latestOf(entry.sdk)));
    return read?.kind === 'read' ? `npm ${read.version}` : 'npm latest';
  }
  const url = source === 'page' ? entry.source : entry.moreSources?.[Number(source.slice(5)) - 1]?.url;
  return (url === undefined ? undefined : tipUrlOf(url, inputs.pages.commits)?.branch) ?? '';
}

/** An address row's line for a source: the deployer names its address and the confirmed entries it also deployed. */
function rowWord(entry: RegistryEntry, source: ProgramSource, shared: DeployerShare | undefined, w: Words, registry: Registry): string {
  if (source !== 'deployer' || shared === undefined) return sourceWord(entry, source, w, registry);
  return w.deployer(checksumAddress(shared.deployer), shared.siblings);
}

/** What a confirmation is called in the line that counts them: the `source` page is the official page, any other as `sourceWord` names it. */
const confirmationWord = (entry: RegistryEntry, source: ProgramSource, w: Words, registry: Registry): string => (source === 'page' ? w.officialPage : sourceWord(entry, source, w, registry));

const confirmedWords = (entry: RegistryEntry, by: readonly ProgramSource[], w: Words, registry: Registry): string =>
  w.confirmed(
    by.map((source) => confirmationWord(entry, source, w, registry)),
    by.length >= MIN_CONFIRMATIONS,
  );

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

const usd = (value: number): string => {
  const steps: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  const [scale, unit] = steps.find(([s]) => value >= s) ?? [1, ''];
  return `$${(value / scale).toFixed(2)}${unit === '' ? '' : ` ${unit}`}`;
};

const percent = (a: bigint, b: bigint, w: Words): string => {
  if (b === 0n) return w.noComputation;
  const basis = (a * 10_000n) / b;
  return `${basis / 100n}.${(basis % 100n).toString().padStart(2, '0')}%`;
};

const lltvWords = (lltv: bigint, w: Words): string => `${percent(lltv, 10n ** 18n, w).replace(/\.?0+%$/, '%')}`;

const marketWords = (market: Market, w: Words): string => w.market(market.loanToken.name, market.collateralToken.name, lltvWords(market.lltv, w));

export const constCast = (value: ConstValue): string => {
  const span = [0, 0] as const;
  switch (value.kind) {
    case 'uint':
    case 'int':
      return castValue({ kind: value.kind, value: value.value, span });
    case 'address':
      return castValue({ kind: value.kind, value: value.value, span });
    case 'bool':
      return castValue({ kind: value.kind, value: value.value, span });
    case 'fixed-bytes':
      return castValue({ kind: value.kind, value: value.value, span });
    case 'bytes':
    case 'string':
      return castValue({ kind: value.kind, value: hexToBytes(value.value.slice(2)), span });
  }
};

const link = (entry: RegistryEntry): Span => ({ href: entryAnchor(entry.name), label: entry.name });

/** A source's host and leading path, as far as it stays short: `docs.morpho.org/developers/contracts/addresses`, `github.com/coinbase/agentkit`. */
const shortUrl = (url: HttpsUrl): string => {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter((p) => p !== '');
  let label = parsed.hostname;
  for (const part of parsed.hostname === 'github.com' ? parts.slice(0, 2) : parts) {
    if (label.length + part.length + 1 > 56) break;
    label = `${label}/${part}`;
  }
  return label;
};

type Context = {
  readonly w: Words;
  readonly language: Language;
  readonly inputs: HtmlInputs;
  readonly template: Template;
  readonly registry: Registry;
  readonly facts: ProtocolFacts | undefined;
  readonly notes: Notes;
  readonly ledger: Ledger;
  /** The example's card values, when there is an example. */
  readonly card: ReadonlyMap<string, ResolvedValue> | undefined;
  /** The example's decoded value at each field key; empty without an example or when it does not decode. */
  readonly values: ReadonlyMap<string, AbiValue>;
};

const fieldsNote = (context: Context, key: string): AiText => research(context.notes.fields.get(key) as string, [], 'ai');

function decimalsOf(context: Context, token: Address): number | undefined {
  const read = context.facts?.decimals.get(token);
  return read?.kind === 'read' ? read.value : undefined;
}

function tokenOf(ref: EffectToken, context: Context): { readonly address: Address | 'eth'; readonly name: string } | undefined {
  if (ref === 'eth') return { address: 'eth', name: 'ETH' };
  if (isNamedToken(ref)) {
    const entry = context.registry.entries.get(ref.contract);
    return entry === undefined ? undefined : { address: entry.address, name: entry.name };
  }
  if (context.card === undefined) {
    const names = refNames(ref, context.template, context.registry);
    const entry = names.length === 1 ? context.registry.entries.get(names[0] as string) : undefined;
    return entry === undefined ? undefined : { address: entry.address, name: entry.name };
  }
  const target = resolveRef(ref, context.card, context.registry);
  if ('problem' in target || target.kind !== 'address') return undefined;
  return { address: target.address, name: context.registry.byAddress.get(target.address)?.name ?? checksumAddress(target.address) };
}

/** An effect's token by name: the registry name it resolves to, or the card field the signer picks it with. */
const effectTokenName = (token: EffectToken, context: Context): string =>
  tokenOf(token, context)?.name ?? (token === 'eth' ? 'ETH' : isNamedToken(token) ? token.contract : context.w.picked(refWord(context.template, token, context.w)));

/** An amount of `token` in whole tokens, from the recorded decimals; base units when they were not read. */
function amountWords(amount: bigint, ref: EffectToken, context: Context): { readonly words: Inline; readonly qualifier: Inline | undefined } {
  const { w } = context;
  const token = tokenOf(ref, context);
  if (token === undefined) return { words: [{ num: amount.toString() }, w.baseUnits], qualifier: undefined };
  const decimals = token.address === 'eth' ? 18 : decimalsOf(context, token.address);
  if (decimals === undefined) return { words: [{ num: amount.toString() }, w.baseUnitsOf(token.name)], qualifier: [w.decimalsUnread] };
  const shown = groupedTokens(amount, decimals, SHOWN_PLACES);
  if (shown === groupedTokens(amount, decimals)) return { words: [{ num: shown }, ` ${token.name}`], qualifier: [w.decimals(decimals)] };
  return { words: w.approx({ num: shown }, token.name, { num: amount.toString() }), qualifier: [w.decimals(decimals)] };
}

/** The registry names a call's `to` can be, the name the page shows for it, and its role on the diagram's lifeline. */
function targetOf(rule: Rule, context: Context): { readonly label: string; readonly names: readonly string[]; readonly role: string } {
  const { registry, w } = context;
  const role = (name: string, otherwise: string): string => {
    const entry = registry.entries.get(name);
    return entry === undefined ? otherwise : w.kind[entry.kind];
  };
  if (rule.kind === 'safe') return { label: w.safe, names: ['safe'], role: w.role.sender };
  if (rule.kind === 'contract') return { label: rule.name, names: [rule.name], role: role(rule.name, w.role.contract) };
  if (rule.kind === 'const' && rule.value.kind === 'address') {
    const entry = registry.byAddress.get(rule.value.value);
    return { label: entry?.name ?? checksumAddress(rule.value.value), names: entry === undefined ? [] : [entry.name], role: entry === undefined ? w.role.fixed : w.kind[entry.kind] };
  }
  if (rule.kind !== 'card') return { label: '?', names: [], role: '' };
  const names = refNames(rule.ref, context.template, registry);
  if (names.length === 1) return { label: names[0] as string, names, role: role(names[0] as string, w.role.picked) };
  const picked = context.card === undefined ? undefined : resolveRef(rule.ref, context.card, registry);
  const name = picked === undefined || 'problem' in picked || picked.kind !== 'address' ? undefined : registry.byAddress.get(picked.address)?.name;
  return name === undefined ? { label: refWord(context.template, rule.ref, w), names, role: w.role.picked } : { label: name, names, role: role(name, w.role.picked) };
}

function whoOf(rule: Rule, template: Template): { readonly who: Who; readonly field: string | undefined } | undefined {
  switch (rule.kind) {
    case 'card': {
      const kind = template.card.get(rule.ref.field)?.kind;
      return { who: kind === 'amount' || kind === 'nonce' || kind === 'threshold' || kind === 'percent' ? 'you-type' : 'you-pick', field: rule.ref.field };
    }
    case 'owner-before':
      return { who: 'fixed', field: undefined };
    case 'address-word':
      return whoOf(rule.rule, template);
    case 'safe':
    case 'contract':
    case 'const':
      return { who: 'fixed', field: undefined };
    case 'free':
      return { who: 'free', field: undefined };
    case 'within-seconds':
      return { who: 'bounded', field: undefined };
    case 'equals':
      return whoOf(rule.rule, template);
    case 'share-price':
      return { who: 'you-type', field: rule.assets.kind === 'card' ? rule.assets.field : undefined };
    case 'at-least':
    case 'at-most':
      return { who: 'you-type', field: rule.field };
    case 'call':
    case 'items':
    case 'fields':
    case 'packed':
    case 'eip712':
      return undefined;
  }
}

const chipLabel = (template: Template, who: Who, field: string | undefined, w: Words): string =>
  who === 'free' ? w.appFills : who === 'bounded' ? w.appBounded : field === undefined || who === 'fixed' ? w.who[who] : w.chip(w.who[who], fieldWord(template, field, w));

function leaves(node: ArgNode, template: Template): { readonly node: ArgNode; readonly who: Who; readonly field: string | undefined }[] {
  if (node.rule.kind === 'call') return [];
  if (node.children.length > 0) return node.children.flatMap((child) => leaves(child, template));
  const who = whoOf(node.rule, template);
  return who === undefined ? [] : [{ node, ...who }];
}

/** One chip when every part agrees; else one per who, naming its parts (`kind fixed`, `data any`). A nested call carries none. */
function chipsOf(node: ArgNode, template: Template, w: Words): Chip[] {
  const found = leaves(node, template);
  const distinct = [...new Map(found.map((leaf) => [`${leaf.who}/${leaf.field ?? ''}`, leaf])).values()];
  if (distinct.length <= 1) return distinct.map((leaf) => ({ who: leaf.who, label: chipLabel(template, leaf.who, leaf.field, w) }));
  const byWho = new Map<Who, string[]>();
  for (const leaf of found) {
    const names = byWho.get(leaf.who) ?? [];
    if (!names.includes(leaf.node.name)) byWho.set(leaf.who, [...names, leaf.node.name]);
  }
  return [...byWho].map(([who, names]) => ({ who, label: w.chipParts(names, w.who[who]) }));
}

/** The card market field a `fields` rule binds whole, part by part. */
function wholeMarket(rule: Rule, template: Template): string | undefined {
  if (rule.kind !== 'fields' || rule.fields.length !== MARKET_PARAMS.length) return undefined;
  const fields = rule.fields.map((r, i) => (r.kind === 'card' && r.ref.attribute === MARKET_PARAMS[i] ? r.ref.field : undefined));
  const [field] = fields;
  return field !== undefined && fields.every((f) => f === field) && template.card.get(field)?.kind === 'market' ? field : undefined;
}

/** The one entry a contract card reference can name, as in a per-vault report, where the card can name only its vault. */
/** Whether a view reads the Safe's own position, so a rise is something the Safe gets; a vault's setting is not. */
const readsSafe = (rule: Rule): boolean =>
  rule.kind === 'safe' || (rule.kind === 'fields' && rule.fields.some(readsSafe)) || (rule.kind === 'items' && rule.items.some(readsSafe));

/** What a view effect requires, in the signer's words. */
function changeWords(change: ViewExpectation, context: Context): Inline {
  const { w } = context;
  return typeof change === 'string' ? [w.change[change]] : [w.equalsTyped(fieldWord(context.template, change.equals, w))];
}

/** The contract a view effect reads, by name: its registry name, or the one entry its card field names in this report. */
function viewLabel(view: ViewEffect, context: Context): string {
  if (view.to.kind === 'contract') return view.to.name;
  return onlyEntry(view.to.ref, context)?.name ?? `card.${view.to.ref.field}${view.to.ref.attribute === undefined ? '' : `.${view.to.ref.attribute}`}`;
}

/** The call a view's argument encodes, such as the `increaseAbsoluteCap` whose `executableAt` it reads, in brackets; empty for none. */
function viewSubject(view: ViewEffect, w: Words): string {
  const inner = view.args.flatMap((arg) => (arg.kind === 'call' || arg.kind === 'keccak' ? [arg.call.fn.name] : []));
  return inner.length === 0 ? '' : w.inParens(inner);
}

function onlyEntry(ref: CardRef, context: Context): RegistryEntry | undefined {
  if (context.template.card.get(ref.field)?.kind !== 'contract') return undefined;
  const names = refNames(ref, context.template, context.registry);
  return names.length === 1 ? context.registry.entries.get(names[0] as string) : undefined;
}

function cardWords(ref: CardRef, key: string, context: Context): { readonly words: Inline; readonly qualifier: Inline | undefined } {
  const { w } = context;
  const field = context.template.card.get(ref.field);
  const only = onlyEntry(ref, context);
  const picks = w.picked(refWord(context.template, ref, w));
  if (only !== undefined) return { words: [link(only)], qualifier: [picks] };
  const example = context.values.get(key);
  const typed = w.typed(fieldWord(context.template, ref.field, w));
  if (field?.kind === 'amount') {
    if (example?.kind !== 'uint') return { words: [typed], qualifier: undefined };
    return amountWords(example.value, field.of, context);
  }
  if (field?.kind === 'percent') {
    if (example?.kind !== 'uint') return { words: [typed], qualifier: undefined };
    return { words: [typed, w.forExample, { num: `${wholeTokens(example.value * 100n, 18)}%` }], qualifier: undefined };
  }
  if (field?.kind === 'nonce' || field?.kind === 'threshold') return { words: [typed], qualifier: undefined };
  const picked = example?.kind === 'address' ? context.registry.byAddress.get(example.value) : undefined;
  if (picked !== undefined) return { words: [link(picked)], qualifier: [picks] };
  if (field?.kind === 'market' && ref.attribute === 'lltv' && example?.kind === 'uint') return { words: [lltvWords(example.value, w)], qualifier: [picks] };
  return { words: [picks], qualifier: undefined };
}

function leafWords(node: ArgNode, context: Context): { readonly words: Inline; readonly qualifier: Inline | undefined } {
  const { rule } = node;
  const { w } = context;
  switch (rule.kind) {
    case 'contract':
      return { words: [link(context.registry.entries.get(rule.name) as RegistryEntry)], qualifier: undefined };
    case 'safe':
      return { words: [w.safe], qualifier: undefined };
    case 'const': {
      if (rule.value.kind === 'address') {
        const entry = context.registry.byAddress.get(rule.value.value);
        return { words: rule.value.value === ZERO_ADDRESS ? [w.zeroAddress] : entry === undefined ? [w.fixedAddress] : [link(entry)], qualifier: undefined };
      }
      const text = constCast(rule.value);
      return { words: [text.length <= 24 ? w.fixedTo(text) : w.fixedValue], qualifier: undefined };
    }
    case 'card':
      return cardWords(rule.ref, node.key, context);
    case 'address-word': {
      const inner = leafWords({ ...node, rule: rule.rule }, context);
      return { words: [...inner.words, w.asWord], qualifier: inner.qualifier };
    }
    case 'free':
      return { words: [w.differs], qualifier: [w.free[rule.claim]] };
    case 'within-seconds':
      return { words: [w.within(rule.seconds)], qualifier: [w.withinHow] };
    case 'equals':
      return { words: w.sameAs({ code: rule.path }), qualifier: undefined };
    case 'owner-before':
      return { words: [w.ownerBefore(refWord(context.template, rule.ref, w))], qualifier: [w.ownerBeforeHow] };
    case 'share-price':
      return { words: [rule.bound === 'max' ? w.priceMax : w.priceMin], qualifier: [w.priceHow] };
    case 'at-least':
      return { words: [w.atLeastTyped(fieldWord(context.template, rule.field, w))], qualifier: [w.atLeastHow] };
    case 'at-most':
      return { words: [w.atMostTyped(fieldWord(context.template, rule.field, w))], qualifier: [w.atMostHow] };
    case 'call':
      return rule.call.encoding === 'params'
        ? { words: w.argsOf({ code: rule.call.fn.name }), qualifier: undefined }
        : { words: [{ code: rule.call.fn.name }, ' (', { mono: rule.call.fn.selector }, ')'], qualifier: undefined };
    case 'packed':
      return { words: [w.packed(rule.parts.reduce((sum, part) => sum + part.size, 0), rule.parts.length)], qualifier: undefined };
    case 'eip712':
      return { words: w.eip712({ code: rule.message.struct.name }), qualifier: [w.eip712How] };
    case 'keccak':
      return { words: w.keccak({ code: rule.call.fn.name }), qualifier: undefined };
    case 'items':
      return { words: [w.items(rule.items.length)], qualifier: undefined };
    case 'fields':
      return { words: [w.parts(rule.fields.length)], qualifier: undefined };
  }
}

function valueOf(node: ArgNode, context: Context): ArgRow['value'] {
  if (['call', 'items', 'fields', 'packed'].includes(node.rule.kind)) return undefined;
  if (node.rule.kind === 'const') return { cast: constCast(node.rule.value), example: undefined };
  const word = node.rule.kind === 'address-word';
  const rule = node.rule.kind === 'address-word' ? node.rule.rule : node.rule;
  const cast = (address: Address): string => (word ? addressWord(address) : checksumAddress(address));
  if (rule.kind === 'contract') return { cast: cast((context.registry.entries.get(rule.name) as RegistryEntry).address), example: undefined };
  const only = rule.kind === 'card' ? onlyEntry(rule.ref, context) : undefined;
  if (only !== undefined) return { cast: cast(only.address), example: undefined };
  const example = context.values.get(node.key);
  if (example === undefined) return undefined;
  const address = example.kind === 'address' ? example.value : word && example.kind === 'fixed-bytes' ? wordAddress(example.value) : undefined;
  const fromSafe = address !== undefined && address === context.inputs.example?.tx.safe;
  return { cast: castValue(example), example: fromSafe ? 'other-safe' : 'example' };
}

function marketPartRows(node: ArgNode, market: Market, context: Context): ArgRow[] {
  return node.children.map((child, i) => {
    const part = MARKET_PARAMS[i] as (typeof MARKET_PARAMS)[number];
    const entry = part === 'lltv' ? undefined : market[part];
    return {
      key: child.key,
      name: child.name,
      chips: [],
      value: { cast: entry === undefined ? market.lltv.toString() : checksumAddress(entry.address), example: undefined },
      words: entry === undefined ? [lltvWords(market.lltv, context.w)] : [link(entry)],
      qualifier: undefined,
      id: undefined,
      ai: fieldsNote(context, child.key),
      parts: [],
      doc: undefined,
    };
  });
}

function argRow(node: ArgNode, context: Context, withChips: boolean, inMessage = false): ArgRow {
  const { w } = context;
  const chips = withChips ? chipsOf(node, context.template, w) : [];
  const market = wholeMarket(node.rule, context.template);
  if (market !== undefined) {
    const markets = [...context.registry.markets.values()];
    const picked = context.card?.get(market);
    const shown = picked?.kind === 'market' ? picked.market : markets.length === 1 ? markets[0] : undefined;
    return {
      key: node.key,
      name: node.name,
      chips,
      value: undefined,
      words: shown === undefined ? [w.picked(fieldWord(context.template, market, w))] : [marketWords(shown, w)],
      qualifier: [w.marketHow(MARKET_PARAMS.length)],
      id: shown === undefined ? undefined : ['market id ', { mono: shown.id }],
      ai: fieldsNote(context, node.key),
      parts: markets.map((m) => ({ label: markets.length === 1 ? undefined : [marketWords(m, w), w.marketId, { mono: m.id }], rows: marketPartRows(node, m, context) })),
      doc: undefined,
    };
  }
  const nestedCall = node.rule.kind === 'call';
  const leaf = leafWords(node, context);
  const { words } = leaf;
  /** A free member of a signed message is no value of this transaction: the digest fixes it, and no perturbation tries another. */
  const qualifier = inMessage && node.rule.kind === 'free' ? [w.freeMember] : leaf.qualifier;
  return {
    key: node.key,
    name: node.name,
    chips,
    value: valueOf(node, context),
    words,
    qualifier,
    id: undefined,
    ai: fieldsNote(context, node.key),
    parts: node.children.length === 0 ? [] : [{ label: undefined, rows: node.children.map((child) => argRow(child, context, nestedCall, inMessage || node.rule.kind === 'eip712')) }],
    doc: node.rule.kind === 'call' && node.rule.call.encoding === 'call' ? docLine(node.rule.call.fn.signature, context) : undefined,
  };
}

/** The packed parts of `value` as leaves, or undefined when its length is not theirs. */
function packedParts(parts: readonly PackedPart[], value: { readonly value: Uint8Array; readonly span: readonly [number, number] }): AbiValue[] | undefined {
  if (parts.reduce((sum, part) => sum + part.size, 0) !== value.value.length) return undefined;
  let offset = 0;
  return parts.map((part): AbiValue => {
    const bytes = value.value.subarray(offset, offset + part.size);
    const span = [value.span[0] + offset, value.span[0] + offset + part.size] as const;
    offset += part.size;
    const hex = `0x${bytesToHex(bytes)}`;
    switch (part.type.kind) {
      case 'address':
        return { kind: 'address', value: hex as Address, span };
      case 'bool':
        return { kind: 'bool', value: BigInt(hex) !== 0n, span };
      case 'fixed-bytes':
        return { kind: 'fixed-bytes', value: hex as Hex, span };
      case 'int':
        return { kind: 'int', value: BigInt.asIntN(part.type.bits, BigInt(hex)), span };
      default:
        return { kind: 'uint', value: BigInt(hex), span };
    }
  });
}

/** Each argument's value in the example, keyed as `argumentTree` keys it; empty when any call does not decode. */
function exampleValues(template: Template, tx: SafeTx): Map<string, AbiValue> {
  const values = new Map<string, AbiValue>();
  const unwrapped = unwrapSafeTx(tx);
  if (!('calls' in unwrapped) || unwrapped.calls.length !== template.calls.length) return values;
  const walk = (nodes: readonly ArgNode[], decoded: readonly AbiValue[], root: Uint8Array): boolean =>
    nodes.every((node, i) => {
      const value = decoded[i];
      if (value === undefined) return false;
      values.set(node.key, value);
      if (node.rule.kind === 'call') {
        if (value.kind !== 'bytes') return false;
        const inner = decodeTemplateCall(node.rule.call, { root, start: value.span[0], end: value.span[1] });
        return inner.kind === 'decoded' && walk(node.children, inner.args, root);
      }
      if (node.rule.kind === 'eip712') return true;
      if (node.rule.kind === 'packed') {
        if (value.kind !== 'bytes') return false;
        const parts = packedParts(node.rule.parts, value);
        return parts !== undefined && walk(node.children, parts, root);
      }
      if (node.children.length === 0) return true;
      const items = value.kind === 'tuple' ? value.fields : value.kind === 'array' ? value.items : undefined;
      return items !== undefined && walk(node.children, items, root);
    });
  const ok = argumentTree(template).every(({ n, node, args }) => {
    const inner = unwrapped.calls[n - 1];
    if (inner === undefined) return false;
    const decoded = decodeTemplateCall(node, inner.data);
    return decoded.kind === 'decoded' && walk(args, decoded.args, inner.data.root);
  });
  if (!ok) return new Map();
  const none = [0, 0] as const;
  unwrapped.calls.forEach((call, i) => {
    values.set(`${i + 1}.to`, { kind: 'address', value: call.to, span: none });
    values.set(`${i + 1}.value`, { kind: 'uint', value: call.value, span: none });
  });
  values.set('nonce', { kind: 'uint', value: tx.nonce, span: none });
  return values;
}

function lifelines(context: Context): { readonly lines: Lifeline[]; readonly names: (readonly string[])[]; readonly callTo: number[] } {
  const { template, registry, w } = context;
  const lines: Lifeline[] = [{ name: w.safe, role: w.role.sender }];
  const names: (readonly string[])[] = [['safe']];
  const add = (label: string, of: readonly string[], role: string): number => {
    const at = lines.findIndex((l) => l.name === label);
    if (at !== -1) return at;
    lines.push({ name: label, role });
    names.push(of);
    return lines.length - 1;
  };
  const kindOf = (name: string): string => {
    const entry = registry.entries.get(name);
    return entry === undefined ? w.role.contract : w.kind[entry.kind];
  };
  const callTo = template.calls.map((call) => {
    const target = targetOf(call.to, context);
    return add(target.label, target.names, target.role);
  });
  for (const view of template.effects.views) {
    const label = viewLabel(view, context);
    add(label, viewTargetNames(view.to, template, registry), kindOf(label));
  }
  for (const name of context.notes.flow.flatMap((line) => [line.from, line.to])) {
    if (!names.some((of) => of.includes(name))) add(name, [name], kindOf(name));
  }
  return { lines, names, callTo };
}

function sequence(context: Context): Sequence {
  const { template, notes, w } = context;
  const { lines, names, callTo } = lifelines(context);
  const at = (name: string): number => names.findIndex((of) => of.includes(name));
  const arrows: Arrow[] = [];
  const narration: string[] = [];
  template.calls.forEach((call, i) => {
    const to = callTo[i] as number;
    const target = to === 0 ? w.self : (lines[to]?.name as string);
    const sendsEth = !zeroValue(call);
    const fn = call.data !== 'empty' ? call.data.fn.name : sendsEth ? w.sendEth : w.noDataZero;
    arrows.push({ kind: 'call', n: i + 1, to, fn });
    narration.push(call.data !== 'empty' ? w.narrateCall(i + 1, target, fn) : w.narrateEmpty(i + 1, target, sendsEth));
    for (const line of notes.flow.filter((f) => f.after === i + 1)) arrows.push({ kind: 'inside', from: at(line.from), to: at(line.to), text: research(line.text) });
  });
  const last = callTo.at(-1) ?? 0;
  for (const effect of template.effects.gets) {
    const token = tokenOf(effect.token, context);
    const text = effect.amount.kind === 'any' ? w.youMayGet(token?.name) : w.youGet(token?.name);
    arrows.push({ kind: 'gets', from: last, text });
    narration.push(w.result(text));
  }
  for (const view of template.effects.views.filter((v) => v.args.some(readsSafe))) {
    for (const { value } of view.changes.filter((c) => c.change === 'increases')) {
      const label = viewLabel(view, context);
      const text = w.increases(label, paramName(view.returns[value] as AbiParam, value));
      arrows.push({ kind: 'gets', from: at(label), text });
      narration.push(w.result(text));
    }
  }
  return { lifelines: lines, arrows, narration: w.sentences(narration) };
}

const zeroValue = (call: TemplateCall): boolean => call.value.kind === 'const' && call.value.value.kind === 'uint' && call.value.value.value === 0n;

function sends(call: TemplateCall, context: Context, n: number): Inline | undefined {
  if (zeroValue(call)) return undefined;
  const example = context.inputs.example === undefined ? undefined : unwrapSafeTx(context.inputs.example.tx);
  const inner = example !== undefined && 'calls' in example ? example.calls[n - 1] : undefined;
  const { words } = leafWords({ key: `${n}.value`, name: 'value', param: undefined, rule: call.value, children: [] }, context);
  return context.w.sends(words, inner === undefined ? undefined : { num: wholeTokens(inner.value, 18) });
}

function afterRows(context: Context): AfterRow[] {
  const { template, w } = context;
  const field = (name: string): string => fieldWord(template, name, w);
  const amountOf = (effect: Template['effects']['gives'][number], gives: boolean): Inline => {
    if (effect.amount.kind === 'all') return [w.all];
    if (effect.amount.kind === 'positive') return [gives ? w.givesMore : w.getsMore];
    if (effect.amount.kind === 'any') return [w.getsAny];
    if (effect.amount.kind === 'at-least') return [w.atLeastTyped(field(effect.amount.field))];
    if (effect.amount.kind === 'at-most') return [w.atMostTyped(field(effect.amount.field))];
    const value = context.card?.get(effect.amount.field);
    if (value?.kind !== 'amount') return [w.typed(field(effect.amount.field))];
    const { words } = amountWords(value.value, effect.token, context);
    const sign = gives ? '−' : '+';
    return words[0] === w.about ? [w.about, sign, ...words.slice(1)] : [sign, ...words];
  };
  const note = (effect: Template['effects']['gives'][number]): Inline => {
    const amount =
      effect.amount.kind === 'card'
        ? w.exactlyTyped(field(effect.amount.field))
        : effect.amount.kind === 'at-least'
          ? w.getsAtLeast(field(effect.amount.field))
          : effect.amount.kind === 'at-most'
            ? w.givesAtMost(field(effect.amount.field))
            : effect.amount.kind === 'all'
              ? w.wholeBalance
              : effect.amount.kind === 'any'
                ? w.riseOrStay
                : w.directionOnly;
    const slack = effect.tolerance === undefined ? [] : [w.listSep, w.tolerance(effect.tolerance.less, effect.tolerance.more)];
    return [amount, ...(effect.to === undefined ? [] : [w.toWhom(refWord(template, effect.to, w))]), ...slack];
  };
  const reason = (tolerance: Tolerance | undefined): { readonly ai?: AiText } => (tolerance === undefined ? {} : { ai: research(say(tolerance.why, context.language), [], 'ai') });
  const name = (token: EffectToken) => effectTokenName(token, context);
  const rows: AfterRow[] = [
    ...template.effects.gives.map((e) => ({ label: [w.safeOf(name(e.token))], value: amountOf(e, true), note: note(e), gains: false, ...reason(e.tolerance) })),
    ...template.effects.gets.map((e) => ({ label: [w.safeOf(name(e.token))], value: amountOf(e, false), note: note(e), gains: true, ...reason(e.tolerance) })),
    ...template.effects.touches.map((t) => ({ label: [w.safeOf(name({ contract: t.token }))], value: [w.touched], note: [w.tolerance(t.tolerance.less, t.tolerance.more)], gains: false, ...reason(t.tolerance) })),
  ];
  const settings = template.effects.safe;
  if (settings !== undefined) {
    const owners: Inline =
      settings.add !== undefined && settings.remove !== undefined
        ? [w.replaces(refWord(template, settings.remove, w), refWord(template, settings.add, w))]
        : settings.add !== undefined
          ? [w.adds(refWord(template, settings.add, w))]
          : settings.remove !== undefined
            ? [w.removes(refWord(template, settings.remove, w))]
            : [w.unchanged];
    rows.push({ label: [w.safeOwners], value: owners, note: [w.ownersHow], gains: false });
    rows.push({
      label: [w.safeThreshold],
      value: settings.threshold === undefined ? [w.unchanged] : [w.becomesTyped(field(settings.threshold.field))],
      note: [w.thresholdHow],
      gains: false,
    });
  }
  for (const view of template.effects.views) {
    for (const { value, change } of view.changes) {
      rows.push({
        label: [{ code: paramName(view.returns[value] as AbiParam, value) }],
        value: changeWords(change, context),
        note: [w.readAround(`${viewLabel(view, context)}.${view.fn.name}${viewSubject(view, w)}`)],
        gains: change === 'increases' && view.args.some(readsSafe),
      });
    }
  }
  const shown = new Set<KeptApproval>();
  for (const call of template.calls) {
    if (call.data === 'empty' || call.data.fn.signature !== 'approve(address,uint256)') continue;
    const spender = call.data.args[0] as Rule;
    const label = w.allowance(ruleWords(spender, context), targetOf(call.to, context).label, false);
    const open = template.effects.approves.find((a) => a.via === 'erc20' && spender.kind === 'contract' && a.spender === spender.name && call.to.kind === 'card' && JSON.stringify(call.to.ref) === JSON.stringify(a.token));
    if (open !== undefined) shown.add(open);
    if (open === undefined) rows.push({ label, value: [{ num: '0' }], note: [w.usedUp], gains: false });
    else if (open.amount.kind === 'card') rows.push({ label, value: [w.atMostTyped(field(open.amount.field))], note: [w.keptForOrder], gains: false });
    else rows.push({ label, value: [w.mayRemain], note: [w.registryWhy], gains: false });
  }
  for (const open of template.effects.approves.filter((a) => !shown.has(a))) {
    const spender = context.registry.entries.get(open.spender) as RegistryEntry;
    const value: Inline = open.amount.kind === 'unlimited' ? [w.mayRemain] : [w.atMostTyped(field(open.amount.field))];
    const note: Inline = open.via === 'permit2' ? [w.permit2Expiry] : [w.registryWhy];
    rows.push({ label: w.allowance([link(spender)], name(open.token), open.via === 'permit2'), value, note, gains: false });
  }
  return rows;
}

/** A row for a rule of the Safe transaction or of a call with no data, which no ABI names and notes.json does not explain. */
function ruleRow(key: string, name: string, rule: Rule, context: Context): ArgRow {
  const node: ArgNode = { key, name, param: undefined, rule, children: [] };
  const who = whoOf(rule, context.template);
  const { words, qualifier } = leafWords(node, context);
  return {
    key,
    name,
    chips: who === undefined ? [] : [{ who: who.who, label: chipLabel(context.template, who.who, who.field, context.w) }],
    value: valueOf(node, context),
    words,
    qualifier,
    id: undefined,
    ai: undefined,
    parts: [],
    doc: undefined,
  };
}

const noDataRow = (key: string, w: Words): ArgRow => ({
  key,
  name: 'data',
  chips: [{ who: 'fixed', label: w.who.fixed }],
  value: { cast: '0x', example: undefined },
  words: [w.noData],
  qualifier: undefined,
  id: undefined,
  ai: undefined,
  parts: [],
  doc: undefined,
});

function callBlocks(context: Context): CallBlock[] {
  const { template } = context;
  const decoded = new Map(argumentTree(template).map((tree) => [tree.n, tree]));
  return template.calls.map((call, i): CallBlock => {
    const n = i + 1;
    const target = targetOf(call.to, context);
    const tree = decoded.get(n);
    if (tree !== undefined) {
      const { fn } = tree.node;
      return { n, head: { kind: 'fn', contract: target.label, fn: fn.name, selector: fn.selector, doc: docLine(fn.signature, context) }, sends: sends(call, context, n), args: tree.args.map((arg) => argRow(arg, context, true)) };
    }
    const text = context.w.emptyHead(target.label, !zeroValue(call));
    return { n, head: { kind: 'no-data', text }, sends: undefined, args: [ruleRow(`${n}.to`, 'to', call.to, context), ruleRow(`${n}.value`, 'value', call.value, context), noDataRow(`${n}.data`, context.w)] };
  });
}

/** The who-decides key for the words the rows use: a free field's line by each claim the template makes. */
function keyItems(used: ReadonlySet<Who>, template: Template, w: Words): KeyItem[] {
  return [
    ...(used.has('you-type') ? [{ who: 'you-type' as const, label: w.who['you-type'], means: w.whoMeans['you-type'] }] : []),
    ...(used.has('you-pick') ? [{ who: 'you-pick' as const, label: w.who['you-pick'], means: w.whoMeans['you-pick'] }] : []),
    ...(used.has('fixed') ? [{ who: 'fixed' as const, label: w.who.fixed, means: w.whoMeans.fixed }] : []),
    ...(used.has('free') ? [...freeRules(template).claims].map((claim) => ({ who: 'free' as const, label: w.appFills, means: w.freeKey[claim] })) : []),
    ...(used.has('free') && freeRules(template).member ? [{ who: 'free' as const, label: w.appFills, means: w.whoMeans.member }] : []),
    ...(used.has('bounded') ? [{ who: 'bounded' as const, label: w.appBounded, means: w.whoMeans.bounded }] : []),
  ];
}

function flowSection(context: Context): Section {
  const { template, w } = context;
  const calls = callBlocks(context);
  const safeTx = template.nonce === undefined ? [] : [ruleRow('nonce', 'nonce', template.nonce, context)];
  const rows = (list: readonly ArgRow[]): ArgRow[] => list.flatMap((row) => [row, ...rows(row.parts.flatMap((part) => part.rows))]);
  const sent = template.calls.flatMap((call) => {
    const who = call.data === 'empty' || zeroValue(call) ? undefined : whoOf(call.value, template)?.who;
    return who === undefined ? [] : [who];
  });
  const used = new Set([...rows([...safeTx, ...calls.flatMap((call) => call.args)]).flatMap((row) => row.chips.map((c) => c.who)), ...sent]);
  const { example } = context.inputs;
  const chosen = chosenWords(used, w);
  const vault = context.inputs.subject.kind === 'template' ? context.inputs.subject.vault : undefined;
  let lead: Inline | undefined;
  if (chosen === '') lead = undefined;
  else if (example !== undefined && context.values.size > 0) {
    const amounts = [...template.card].flatMap(([field, card]): Inline[] => {
      const value = context.card?.get(field);
      return card.kind === 'amount' && value?.kind === 'amount' ? [[`${fieldWord(template, field, w)} `, ...amountWords(value.value, card.of, context).words]] : [];
    });
    lead = w.exampleLead(chosen, vault?.name, { code: example.name }, amounts);
  } else {
    lead = w.noExample(vault?.name);
  }
  return {
    anchor: anchor('flow'),
    label: w.flow,
    count: { kind: 'text', text: w.calls(template.calls.length) },
    body: {
      kind: 'flow',
      flow: { diagram: sequence(context), key: keyItems(used, template, w), decoded: calls.some((call) => call.head.kind === 'fn'), example: lead, safeTx, calls, after: afterRows(context) },
    },
  };
}

/** Who gives the values, in words, such as `you type, you pick and the app fills`. */
const chosenWords = (used: ReadonlySet<Who>, w: Words): string =>
  w.and((['you-type', 'you-pick', 'free'] as const).filter((who) => used.has(who) || (who === 'free' && used.has('bounded'))).map((who) => w.chosen[who]));

type ProtocolNote = NonNullable<ReturnType<Notes['protocols']['get']>>;

function sheetRows(context: Context, sheet: ProtocolSheet, facts: ProtocolFacts, note: ProtocolNote | undefined): ProtocolRow[] {
  const { template, registry, w } = context;
  const rows: ProtocolRow[] = [];
  const { listing } = sheet;
  if (listing.kind === 'unread') rows.push({ label: 'TVL', value: [w.notRead], sub: undefined, ai: undefined, nested: [] });
  else {
    const { tvl, ethereumTvl, listedFrom } = listing.value;
    rows.push({ label: 'TVL', value: tvl === undefined ? [w.noneFromDefillama] : [{ num: usd(tvl) }], sub: ethereumTvl === undefined ? undefined : [w.onEthereum, { num: usd(ethereumTvl) }], ai: undefined, nested: [] });
    rows.push({ label: w.listed, value: [listedFrom === undefined ? w.noneFromDefillama : { num: listedFrom }], sub: [w.listedHow], ai: undefined, nested: [] });
  }
  const [only, ...more] = sheet.contracts;
  rows.push(
    only !== undefined && more.length === 0
      ? { label: 'proxy', value: [w.proxy[only.proxy]], sub: [link(only.entry), w.fromPin], ai: undefined, nested: [] }
      : {
          label: 'proxy',
          value: [w.contracts(sheet.contracts.length)],
          sub: [w.fromPinAlone],
          ai: undefined,
          nested: sheet.contracts.map(({ entry, proxy }) => ({ label: [link(entry)], value: [w.proxy[proxy]], ai: undefined })),
        },
  );
  if (note !== undefined) rows.push({ label: w.audits, value: [], sub: undefined, ai: research(note.audits.text, note.audits.sources), nested: [] });
  const incidents = note?.incidents ?? [];
  rows.push({
    label: w.incidents,
    value: listing.kind === 'unread' ? [w.notRead] : [w.incidentCount(sheet.hacks.length)],
    sub: [w.incidentsHow],
    ai: undefined,
    nested: sheet.hacks.map((hack, i) => {
      const incident = incidents[i];
      return {
        label: [{ num: hack.date }],
        value: [hack.amount === undefined ? w.noAmount : { num: usd(hack.amount) }],
        ai: incident === undefined ? undefined : research(incident.text, incident.sources),
      };
    }),
  });
  for (const fact of template.facts.filter((f) => registry.entries.get(f.to)?.defillama === sheet.slug)) {
    for (const reading of facts.readings.filter((r) => r.fact === fact)) {
      const value = reading.value;
      const nested: ProtocolRow['nested'][number][] = [];
      if (reading.read.kind === 'unread') nested.push({ label: [{ code: fact.fn.name }], value: [w.notRead], ai: undefined });
      else {
        const amounts = reading.read.value;
        fact.units.forEach((unit, i) => {
          const amount = amounts[i] as (typeof amounts)[number];
          const decimals = amount.token === 'eth' ? 18 : decimalsOf(context, amount.token);
          const name = amount.token === 'eth' ? 'ETH' : (registry.byAddress.get(amount.token)?.name ?? '');
          nested.push({
            label: [{ code: paramName(fact.returns[unit.value] as AbiParam, unit.value) }],
            value: decimals === undefined ? [{ num: amount.amount.toString() }, w.baseUnits] : [{ num: groupedTokens(amount.amount, decimals, 2) }, ` ${name}`],
            ai: undefined,
          });
        });
        if (fact.ratio !== undefined) {
          const [a, b] = fact.ratio;
          const at = (position: number) => amounts[fact.units.findIndex((u) => u.value === position)]?.amount as bigint;
          const named = (position: number) => paramName(fact.returns[position] as AbiParam, position);
          nested.push({ label: [{ code: `${named(a)} / ${named(b)}` }], value: [{ num: percent(at(a), at(b), w) }], ai: undefined });
        }
      }
      rows.push({
        label: value.kind === 'market' ? value.market.name : value.entry.name,
        value: value.kind === 'market' ? [marketWords(value.market, w)] : [link(value.entry)],
        sub: [w.atBlock(`${fact.to}.${fact.fn.name}`, `${facts.block.number}`)],
        ai: undefined,
        nested,
      });
    }
  }
  return rows;
}

function unreadRows(note: ProtocolNote | undefined, w: Words): ProtocolRow[] {
  return [
    { label: w.protocolData, value: [w.notReadShort], sub: [w.noProtocolData], ai: undefined, nested: [] },
    ...(note === undefined
      ? []
      : [
          { label: w.audits, value: [], sub: undefined, ai: research(note.audits.text, note.audits.sources), nested: [] },
          { label: w.incidents, value: [w.notReadShort], sub: undefined, ai: undefined, nested: note.incidents.map((incident, i) => ({ label: [`${i + 1}`], value: [], ai: research(incident.text, incident.sources) })) },
        ]),
  ];
}

function protocolSections(context: Context): Section[] {
  const { facts, notes, template, registry, w } = context;
  const slugs = (facts?.protocols ?? factsScope(template, registry, context.ledger.entries).protocols).map((p) => p.slug);
  return slugs.map((slug): Section => {
    const note = notes.protocols.get(slug);
    const sheet = facts?.protocols.find((s) => s.slug === slug);
    const rows = facts === undefined || sheet === undefined ? unreadRows(note, w) : sheetRows(context, sheet, facts, note);
    const apis = context.ledger.entries.flatMap((e) => (e.defillama === slug && e.apiSource !== undefined ? [e.apiSource.url] : []));
    const sources = [
      { label: 'DefiLlama', href: parseHttpsUrl(`https://defillama.com/protocol/${slug}`) },
      { label: 'DefiLlama hacks', href: parseHttpsUrl('https://defillama.com/hacks') },
      { label: w.onChain, href: undefined },
      ...[...new Set(apis)].map((href) => ({ label: w.readApi, href })),
    ];
    return {
      anchor: anchor(`protocol-${slug}`),
      label: slug,
      count: undefined,
      body: { kind: 'protocol', block: { read: context.inputs.fetched, intro: research((note?.intro ?? '') || slug), rows, sources } },
    };
  });
}

/** The card's vault in a per-vault report, from its stored `pnpm vault-evidence` output alone. */
function vaultSection(context: Context): Section[] {
  const { subject } = context.inputs;
  if (subject.kind !== 'template' || subject.vault === undefined) return [];
  const { w } = context;
  const vault = subject.vault;
  const text = context.inputs.vaults.get(vault.name);
  const section = (block: VaultBlock): Section[] => [{ anchor: anchor(`vault-${vault.name}`), label: w.vault, count: undefined, body: { kind: 'vault', vault: block } }];
  const lead: Inline = w.vaultLead(link(vault), { code: 'pnpm vault-evidence' });
  if (text === undefined) return section({ lead: w.vaultNone(link(vault), { code: 'pnpm vault-evidence' }), rows: [], bars: [], most: undefined });
  const evidence = readStoredEvidence(text, vault, context.registry);
  const unit = evidence.asset?.name === undefined ? '' : ` ${evidence.asset.name}`;
  const amount = (value: bigint): string => (evidence.asset === undefined ? `${value}${w.baseUnits}` : `${groupedTokens(value, evidence.asset.decimals, 2)}${unit}`);
  const point = (kind: Exclude<StoredPoint['assets']['kind'], 'amount'>): string => w.point[kind];
  const most = evidence.points.reduce<bigint | undefined>((top, p) => (p.assets.kind === 'amount' && (top === undefined || p.assets.amount > top) ? p.assets.amount : top), undefined);
  const bars = evidence.points.map(
    (p): VaultBar => ({
      date: p.date ?? w.dateUnknown,
      words: p.assets.kind === 'amount' ? amount(p.assets.amount) : point(p.assets.kind),
      share: p.assets.kind !== 'amount' || most === undefined || most === 0n ? undefined : Number(p.assets.amount) / Number(most),
    }),
  );
  const latest = evidence.points.at(-1);
  const { factory } = vault.attributes;
  const size = sizeOf(vault, context.registry);
  const rows: VaultBlock['rows'] = [
    {
      label: w.factory,
      value:
        evidence.admitted !== undefined
          ? evidence.admitted.answers.flatMap((answer, i) => [...(i === 0 ? [] : ['; ']), ...w.answers(answer.asker, { code: answer.check }, answer.answer)])
          : [factory === undefined ? w.noFactory : w.noFactoryAnswer(factory)],
      note: evidence.admitted === undefined ? [] : [w.block(`${evidence.admitted.block}`)],
    },
    {
      label: w.sizeNow(size?.fn.name ?? w.notRead),
      value: latest === undefined ? [w.notRead] : [{ num: latest.assets.kind === 'amount' ? amount(latest.assets.amount) : point(latest.assets.kind) }],
      note: latest === undefined ? [] : [w.atBlock(latest.date ?? w.dateUnknown, `${latest.block}`)],
    },
    ...(size?.holders !== true
      ? []
      : evidence.holders === undefined
      ? [{ label: w.holders, value: [w.notRead], note: [] }]
      : [
          { label: w.holders, value: w.holderCount({ num: `${evidence.holders.holders}` }, { num: `${evidence.holders.candidates}` }), note: [] },
          { label: w.largest, value: [{ num: evidence.holders.largest ?? w.notRead }], note: [w.ofShares] },
          { label: w.top10, value: [{ num: evidence.holders.top10 }], note: [w.ofShares] },
        ]),
  ];
  return section({ lead, rows, bars, most: most === undefined ? undefined : amount(most) });
}

function reviewTitle(result: Result, context: Context): { readonly title: Inline; readonly why: Inline } {
  const { w } = context;
  const words = (w.finding as Readonly<Partial<Record<FindingKind, { readonly title: string; readonly why: string }>>>)[result.finding.kind] ?? { title: w.needsReview, why: '' };
  if (result.about.kind === 'fixture') {
    const detail = result.finding.kind === 'judged-otherwise' ? ` ${result.finding.detail}` : '';
    return { title: w.fixtureTitle({ code: result.about.name }, words.title), why: [`${words.why}${detail}`] };
  }
  const name = result.about.entry.name;
  const doc = /\/doc\.(0x[0-9a-f]{8})\.(\w+)$/.exec(result.id);
  if (doc !== null && context.inputs.subject.kind === 'template') {
    const found = context.inputs.subject.docs.find((d) => d.fn.selector === doc[1]);
    const page = found?.standard === undefined ? w.docsPage : w.standardPage(found.standard.name);
    const why = found?.standard !== undefined && result.finding.kind === 'name-not-on-page' ? w.notInStandard(found.standard.name) : words.why;
    return { title: w.docTitle(name, page, { code: found?.fn.name ?? (doc[1] as string) }, words.title), why: [why] };
  }
  if (result.finding.kind === 'few-confirmations') {
    return { title: [w.addressConfirmed(name, confirmedWords(result.about.entry, result.finding.by, w, context.registry))], why: [w.fewConfirmationsWhy(MIN_CONFIRMATIONS)] };
  }
  const span = /\/code\.(\d+)$/.exec(result.id);
  const where = span !== null ? w.span(span[1] as string) : result.id.endsWith('/code.today') ? w.latestBlock : '';
  const refused =
    result.finding.kind === 'refused'
      ? w.refusedWhy(result.finding.why)
      : result.finding.kind === 'fn-not-in-abi'
        ? ` ${result.finding.signatures.join(', ')}`
        : result.finding.kind === 'label-differs'
          ? ` ${(result.others ?? []).map(checksumAddress).join(', ')}`
          : '';
  const source = result.source === undefined ? undefined : sourceWord(result.about.entry, result.source.of, w, context.registry);
  return { title: [w.resultTitle(name, source, words.title, where)], why: [`${words.why}${refused}`] };
}

function reviewSection(context: Context): Section {
  const { notes, ledger } = context;
  const graded = (grade: Grade) => forSigner(ledger).filter((r) => weightOf(r) === grade);
  const grades = ['key', 'reference'] as const;
  const rows = grades.flatMap((grade) => graded(grade).map((result): ReviewRow => {
    const review = notes.reviews.get(result.id) as Notes['reviews'] extends ReadonlyMap<string, infer R> ? R : never;
    const { title, why } = reviewTitle(result, context);
    return {
      id: result.id,
      state: stateOf(result),
      grade,
      title,
      why,
      entry: result.about.kind === 'entry' ? entryAnchor(result.about.entry.name) : undefined,
      review: { status: review.status, text: research(review.text), recommendation: research(review.recommendation) },
    };
  }));
  const judgments = notes.judgments.map((j) => ({ text: research(j.text, j.sources), recommendation: research(j.recommendation) }));
  const counts = [
    ...grades.flatMap((grade) => (graded(grade).length === 0 ? [] : [{ state: worst(graded(grade)), n: graded(grade).length, grade }])),
    ...(judgments.length === 0 ? [] : [{ state: 'ask' as const, n: judgments.length }]),
  ];
  const count: RailCount = { kind: 'states', counts: counts.length === 0 ? [{ state: 'ok', n: 0 }] : counts };
  return { anchor: anchor('review'), label: context.w.review, count, body: { kind: 'review', rows, judgments } };
}

/** The template's rule in the signer's words, for the wallet table: never the example's value. */
function ruleWords(rule: Rule, context: Context): Inline {
  const { w } = context;
  switch (rule.kind) {
    case 'contract':
      return [link(context.registry.entries.get(rule.name) as RegistryEntry)];
    case 'safe':
      return [w.safe];
    case 'const':
      return rule.value.kind === 'address' && rule.value.value === ZERO_ADDRESS ? [w.zeroAddress] : [{ mono: constCast(rule.value) }];
    case 'card': {
      const only = onlyEntry(rule.ref, context);
      if (only !== undefined) return [link(only)];
      const kind = context.template.card.get(rule.ref.field)?.kind;
      const ref = refWord(context.template, rule.ref, w);
      return [kind === 'amount' || kind === 'nonce' || kind === 'threshold' || kind === 'percent' ? w.typed(ref) : w.picked(ref)];
    }
    case 'owner-before':
      return [w.ownerBeforeShort(refWord(context.template, rule.ref, w))];
    case 'address-word':
      return [...ruleWords(rule.rule, context), w.asWord];
    case 'free':
      return [w.any];
    case 'within-seconds':
      return [w.within(rule.seconds)];
    case 'equals':
      return w.sameAs({ code: rule.path });
    case 'share-price':
      return [rule.bound === 'max' ? w.priceMax : w.priceMin];
    case 'at-least':
      return [w.atLeastTyped(fieldWord(context.template, rule.field, w))];
    case 'at-most':
      return [w.atMostTyped(fieldWord(context.template, rule.field, w))];
    case 'call':
      return w.callsThen({ code: rule.call.fn.name });
    case 'keccak':
      return w.keccak({ code: rule.call.fn.name });
    case 'items':
    case 'fields':
    case 'packed':
    case 'eip712':
      return [w.seeFlow];
  }
}

function walletSection(context: Context): Section {
  const { template, registry, inputs, w } = context;
  const section = (view: WalletView): Section => ({ anchor: anchor('wallet'), label: w.wallet, count: undefined, body: { kind: 'wallet', view } });
  if (template.calls.length > 1) return section({ kind: 'multisend', calls: template.calls.length });
  if (template.calls.every((call) => call.data === 'empty')) return section({ kind: 'no-data' });
  const reports = inputs.erc7730.reports;
  const lines: Inline[] = [];
  const calls = argumentTree(template).map(({ n, node, args }): WalletCall => {
    const call = template.calls[n - 1] as TemplateCall;
    const target = targetOf(call.to, context);
    const title: Inline = [`${n} ${target.label}.${node.fn.name}`];
    const described = reports
      .filter((r) => target.names.includes(r.entry.name) || registry.entries.get(target.label)?.address === r.entry.address)
      .flatMap((r) => r.descriptors.flatMap((d) => d.functions).filter((f) => f.selector === node.fn.selector).map((fn) => ({ entry: r.entry.name, fn })));
    const first = described[0];
    if (first === undefined) return { n, title, rows: 'no-descriptor' };
    const fn = first.fn;
    const describedNames = new Set(described.map((d) => d.entry));
    const without = target.names.filter((name) => !describedNames.has(name));
    if (without.length > 0) lines.push([w.descriptorsOf(n, [...describedNames], without)]);
    const flat = (facts: readonly FieldFact[], prefix = ''): { path: string; format: string; visible: string }[] =>
      facts.flatMap((f) => (f.kind === 'group' ? flat(f.fields, `${prefix}${f.path}.`) : [{ path: `${prefix}${f.path}`, format: f.format, visible: f.visible }]));
    const shown = flat(fn.fields).filter((f) => f.visible !== 'never' && f.format !== 'none');
    // A descriptor names arguments as its contract's ABI does, and a template call to a card token is decoded with one
    // token's ABI, so USDT's `_spender` is the `spender` of USDC's: names compare without leading underscores.
    const same = (a: string, b: string): boolean => a.replace(/^_+/, '') === b.replace(/^_+/, '');
    const find = (path: string): { readonly path: string; readonly node: ArgNode }[] => {
      let found: { readonly path: string; readonly node: ArgNode }[] = [{ path: '', node: { children: args } as ArgNode }];
      for (const segment of path.replace(/^#\./, '').split('.')) {
        found = found.flatMap(({ path: at, node }) =>
          node.children.filter((a) => (segment === '[]' ? /^\[\d+\]$/.test(a.name) : same(a.name, segment))).map((a) => ({ path: `${at}${at === '' ? '' : '.'}${a.name}`, node: a })),
        );
      }
      return found;
    };
    const rows = shown.flatMap((field): { readonly label: Inline; readonly value: Inline }[] => {
      if (field.path === '@.value') return [{ label: [w.ethSent], value: ruleWords(call.value, context) }];
      const targets = find(field.path);
      if (targets.length === 0) return [{ label: [w.notAnArgument], value: [w.noValue] }];
      return targets.map(({ path, node }) => ({
        label: targets.length > 1 ? [{ code: path }] : [Object.hasOwn(w.walletArg, node.name) ? ((w.walletArg as Readonly<Record<string, string>>)[node.name] as string) : node.name],
        value: ruleWords(node.rule, context),
      }));
    });
    const shownPaths = shown.flatMap((f) => find(f.path).map((t) => t.path));
    const covered = (path: string) => shownPaths.some((p) => path === p || path.startsWith(`${p}.`));
    const hidden: string[] = [];
    const visit = (nodes: readonly ArgNode[], prefix: string): void => {
      for (const a of nodes) {
        const path = `${prefix}${a.name}`;
        if (a.children.length > 0 && a.rule.kind !== 'call') visit(a.children, `${path}.`);
        else if (a.rule.kind !== 'free' && !covered(path)) hidden.push(path);
      }
    };
    visit(args, '');
    if (hidden.length > 0) lines.push(w.walletHides(n, hidden.map((h): Span => ({ code: h }))));
    const blind = args.some((a) => wholeMarket(a.rule, template) !== undefined && a.children.some((c) => hidden.includes(`${a.name}.${c.name}`)));
    if (blind) lines.push([w.sameTokens(n)]);
    return { n, title, rows };
  });
  return section({ kind: 'calls', calls, lines });
}

function codeLines(ledger: Ledger, entry: RegistryEntry, signed: ReadonlySet<string>, w: Words): Inline[] {
  const lines: Inline[] = [];
  const notCalled = ledger.results.some((r) => r.finding.kind === 'not-called' && r.about.kind === 'entry' && r.about.entry.name === entry.name);
  if (notCalled) {
    const dependents = ledger.entries.filter((other) => other.dependsOn?.includes(entry.name));
    const links = dependents.flatMap((other, i): Span[] => [...(i === 0 ? [] : [w.sep]), { href: entryAnchor(other.name), label: other.name }]);
    const checked: Inline = dependents.length > 0 ? w.checkedWith(links) : signed.has(entry.name) ? [w.checkedWhenUsed] : [w.readAtLatest];
    lines.push(w.noProof(entry.code === undefined ? [] : checked));
  }
  const routes = entry.code?.current.pin.routes;
  if (routes !== undefined) {
    lines.push([w.routes(routes.length, notCalled)]);
    for (const route of routes) lines.push(w.route({ mono: checksumAddress(route.address) }, { mono: route.hash }, route.selectors.length));
    lines.push([w.unseeded]);
  }
  return lines;
}

function addressSection(context: Context): Section[] {
  const { ledger, notes, w } = context;
  if (ledger.entries.length === 0) return [];
  const row = (entry: RegistryEntry): AddressRow => {
    const results = ledger.results.filter((r) => r.about.kind === 'entry' && r.about.entry.name === entry.name);
    const level = confidence(ledger, entry);
    const reviews = results.filter(needsSigner).flatMap((r) => {
      const review = notes.reviews.get(r.id);
      return review === undefined ? [] : [review];
    });
    const note = notes.entries?.get(entry.name);
    const sources = sourcesOf(ledger, entry).map(
      (line): SourceLine => ({
        label: rowWord(entry, line.source, line.shared, w, context.registry),
        href: line.link,
        state: line.state,
        phrase: line.phrase,
        others: line.others.map(checksumAddress),
        site: line.site === undefined ? undefined : { state: line.site.state, phrase: line.site.phrase, slug: entry.defillama, places: placeLinks(entry, line.site.places, w) },
        newest:
          line.newest === undefined
            ? undefined
            : { state: line.newest.state, phrase: line.newest.phrase, where: newestWhere(entry, line.source, context.inputs), others: line.newest.others.map(checksumAddress) },
      }),
    );
    return {
      anchor: entryAnchor(entry.name),
      name: entry.name,
      state: worst(results),
      role: note?.role === undefined ? undefined : research(note.role),
      confidence: level,
      reviewed: reviews.length === 0 ? undefined : reviews.some((r) => r.status === 'concern') ? 'concern' : 'confirmed',
      address: checksumAddress(entry.address),
      sources,
      confirmed: confirmedWords(entry, confirmations(ledger, entry), w, context.registry),
      codeLines: codeLines(ledger, entry, signedEntryNames(context.template, context.registry), w),
      aiSources: (note?.sources ?? []).map((s) => ({ text: research(s.text, [s.url], 'ai'), result: s.result })),
    };
  };
  const { open, folded } = addressRows(ledger);
  return [
    {
      anchor: anchor('addresses'),
      label: w.addresses,
      count: { kind: 'text', text: `${ledger.entries.length}` },
      body: { kind: 'addresses', open: open.map(row), folded: folded.map(row) },
    },
  ];
}

/** A search anchor in words: a mint or burn of a vault's shares is a deposit or a withdrawal, of any other token only a mint or burn. */
function anchorWords(query: PastTxsRecording['query'], token: RegistryEntry | undefined, w: Words): string {
  const { anchor } = query;
  if (anchor === 'event') return query.event?.split('(')[0] ?? anchor;
  const vault = token?.kind === 'vault';
  if (anchor === 'mint') return vault ? w.anchor.mintVault : w.anchor.mint;
  if (anchor === 'burn') return vault ? w.anchor.burnVault : w.anchor.burn;
  return w.anchor.transfer;
}

type Misfit = Extract<TxStudy, { kind: 'misfit' }>;
type Fit = Extract<TxStudy, { kind: 'fit' }>;
type Studied = Fit | Misfit;

/** What fits outside the registry used, such as `use a market or address outside the registry`. */
const outsideWords = (fits: readonly Fit[], w: Words): string => w.outside([...new Set(fits.flatMap((fit) => fit.outside.map((o) => w.outsideKind[o.kind])))]);

/**
 * The group a transaction found by several recordings keeps, lowest first: exactly the template, which no anchor
 * changes; another contract where the template binds one, which one anchor proves; its shape outside the registry;
 * another shape.
 */
const rank = (s: Studied): number => (s.kind === 'fit' ? (s.outside.length === 0 ? 0 : 2) : s.reason.kind === 'entry' ? 1 : 3);
const shapeGroup = (s: Studied): 'exact' | 'outside' | 'other' => (s.kind === 'misfit' ? 'other' : s.outside.length === 0 ? 'exact' : 'outside');

/** Each function name the report's ABI proofs and the template know, by selector. */
function knownFunctions(context: Context): Map<string, string> {
  const names = new Map<string, string>();
  for (const proof of context.inputs.abi.values()) {
    if (proof.kind !== 'proven') continue;
    for (const entry of proof.abi) {
      if (entry.type !== 'function') continue;
      const fn = parseFunctionSignature(namedSignatureOfAbiEntry(entry));
      names.set(fn.selector, fn.name);
    }
  }
  for (const [selector, name] of functionNames(context.template)) names.set(selector, name);
  return names;
}

const txLink = (hash: Hex): Span => ({ href: parseHttpsUrl(`https://etherscan.io/tx/${hash}`) as HttpsUrl, label: `${hash.slice(0, 10)}…` });

/** Why a group did not have the template's shape, in the signer's words; `template` names the template's calls in order. */
function misfitWords(reason: MisfitReason, template: string, registry: Registry, w: Words): Inline {
  const last = (at: string): string => at.split('.').at(-1) ?? at;
  switch (reason.kind) {
    case 'entry': {
      const named = registry.byAddress.get(reason.actual)?.name;
      const actual: Span = named === undefined ? { mono: checksumAddress(reason.actual) } : named;
      const allowed = w.misfit.allowed(reason.expected);
      return last(reason.at) === 'to' ? w.misfit.to(actual, allowed) : w.misfit.entry({ code: last(reason.at) }, actual, allowed);
    }
    case 'calls':
      return w.misfit.calls({ code: template });
    case 'items':
      return w.misfit.items({ code: last(reason.at) }, reason.got, reason.expected);
    case 'field':
      return w.misfit.field({ code: reason.at }, { mono: reason.expected }, { mono: reason.actual });
    case 'not-sender':
      return w.misfit.notSender({ code: reason.at });
    case 'differs':
      return w.misfit.differs({ code: reason.at }, { code: reason.other });
    case 'late':
      return w.misfit.late({ code: reason.at }, reason.seconds);
    case 'trailer':
      return w.misfit.trailer({ code: reason.at });
    case 'foreign-delegatecall':
      return [w.misfit.foreignDelegatecall];
    case 'multisend-noncanonical':
      return [w.misfit.noncanonical];
    case 'other':
      return [w.misfit.other];
  }
}

function pastSection(context: Context): Section {
  const { registry, template, w } = context;
  const nameOf = (address: string): string => registry.byAddress.get(address.toLowerCase() as Address)?.name ?? checksumAddress(address as Address);
  const known = knownFunctions(context);
  const fnOf = (selector: string): string => known.get(selector) ?? selector;
  const noSelector: Readonly<Record<string, string>> = { 'no data': w.noDataParens, 'contract creation': w.creation };
  /** Another operation's call: its contract by registry name or full address, then its function. */
  const otherWords = (to: Address | undefined, selector: string | undefined): string => {
    const named = selector !== undefined && /^0x[0-9a-f]{8}$/.test(selector);
    const fn = selector === undefined ? w.noDataParens : named ? fnOf(selector) : (noSelector[selector] ?? selector);
    if (to === undefined) return fn;
    const contract = registry.byAddress.get(to.toLowerCase() as Address)?.name ?? checksumAddress(to);
    return named || (selector !== undefined && noSelector[selector] === undefined) ? `${contract}.${fn}` : w.bareCall(contract, fn);
  };
  const callWords = ({ to, selector }: CallName): string => {
    const contract = to === undefined ? w.otherContract : (registry.byAddress.get(to)?.name ?? checksumAddress(to));
    return selector === undefined ? w.bareCall(contract, w.noDataParens) : `${contract}.${fnOf(selector)}`;
  };
  const sequence = (calls: readonly CallName[]): Inline => [{ code: calls.map(callWords).join(' → ') }];
  const templateCalls = template.calls.map((call) => (call.data === 'empty' ? w.noDataParens : call.data.fn.name)).join(' → ');
  const otherOperation = (s: Studied): boolean => isOtherOperation(s, template);
  const groupsOf = (misfits: readonly Misfit[]): PastGroup[] => {
    const names = functionNames(template);
    const groups = new Map<string, Misfit[]>();
    for (const m of misfits) {
      const key = misfitText(m.reason, registry, names);
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    return [...groups.values()]
      .sort((a, b) => b.length - a.length)
      .map((members): PastGroup => {
        const { reason } = members[0] as Misfit;
        const calls = reason.kind === 'calls' ? reason.calls : reason.kind === 'items' ? reason.calls : undefined;
        return {
          count: members.length,
          senders: new Set(members.map((m) => m.sender.address)).size,
          calls: calls === undefined ? undefined : sequence(calls),
          reason: misfitWords(reason, templateCalls, registry, w),
          examples: members.slice(0, 3).map((m) => txLink(m.hash)),
        };
      });
  };
  const outsideGroups = (fits: readonly Fit[]): PastGroup[] => {
    const groups = new Map<string, Fit[]>();
    for (const fit of fits) {
      const key = fit.outside.map((o) => `${o.at}:${o.kind}`).join(' ');
      groups.set(key, [...(groups.get(key) ?? []), fit]);
    }
    return [...groups.values()]
      .sort((a, b) => b.length - a.length)
      .map((members): PastGroup => {
        const { outside } = members[0] as Fit;
        return {
          count: members.length,
          senders: new Set(members.map((m) => m.sender.address)).size,
          calls: undefined,
          reason: w.sameShapeBut(outside.map((o) => [{ code: o.at.endsWith('.to') ? o.at : (o.at.split('.').at(-1) ?? o.at) }, w.outsideKind[o.kind]] as const)),
          examples: members.slice(0, 3).map((m) => txLink(m.hash)),
        };
      });
  };
  const recordings = context.inputs.pastTxs.map(({ file, query, run }): PastRecording => {
    const studied = run.studies.filter((s): s is Studied => s.kind === 'fit' || s.kind === 'misfit');
    const counted = studied.filter((s) => !otherOperation(s));
    const block = (title: string, of: readonly Studied[], who: 'safe' | 'address'): PastBlock => {
      const fits = of.filter((s): s is Fit => s.kind === 'fit');
      const outside = fits.filter((s) => s.outside.length > 0);
      const senders = new Set(of.map((s) => s.sender.address)).size;
      return {
        title,
        lead: w.blockLead(of.length, senders, who, fits.length - outside.length, outside.length, outside.length === 0 ? '' : outsideWords(outside, w)),
        groups: [...outsideGroups(outside), ...groupsOf(of.filter((s): s is Misfit => s.kind === 'misfit'))],
      };
    };
    const bySender = (match: (sender: Sender) => boolean) => counted.filter((s) => match(s.sender));
    const blocks = [
      block('Safe', bySender((sender) => sender.kind === 'safe'), 'safe'),
      ...run.shapes.calls.flatMap((shape, call) => {
        const of = bySender((sender) => sender.kind === 'eoa' && sender.call === call);
        const data = shape.template.calls[0]?.data;
        return of.length === 0 ? [] : [block(w.eoaCalls(data === undefined || data === 'empty' ? w.noDataParens : data.fn.name), of, 'address')];
      }),
    ];
    const elsewhere = [
      ...run.studies.flatMap((s) => (s.kind === 'not-studied' && s.why === 'calls no function the template calls' ? [otherWords(s.to, s.selector)] : [])),
      ...studied.filter(otherOperation).flatMap((s) => (s.kind === 'misfit' && s.reason.kind === 'calls' ? [otherWords(s.reason.calls[0]?.to, s.reason.calls[0]?.selector)] : [])),
    ];
    const tally = new Map<string, number>();
    for (const name of elsewhere) tally.set(name, (tally.get(name) ?? 0) + 1);
    const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const skipped = run.studies.length - studied.length - run.studies.filter((s) => s.kind === 'not-studied' && s.why === 'calls no function the template calls').length;
    const others: Inline[] = [
      ...(elsewhere.length === 0 ? [] : [w.otherOperations(elsewhere.length, top.map(([name, n]) => [{ code: name }, n] as const), tally.size > top.length)]),
      ...(skipped === 0 ? [] : [[w.skipped(skipped)]]),
    ];
    const bySource = (source: string) => [...run.found.values()].filter((s) => s.includes(source as never)).length;
    const [alchemy, etherscan] = [bySource('alchemy'), bySource('etherscan')];
    const same = [...run.found.values()].every((s) => s.length === 2);
    return {
      file,
      count: w.searchCount(nameOf(query.token), anchorWords(query, registry.byAddress.get(query.token.toLowerCase() as Address), w), run.found.size, run.studies.length),
      search: query.anchor === 'event' ? w.searchEtherscanOnly({ num: `${etherscan}` }) : w.searchSame(same, { num: `${alchemy} ${same ? '=' : '≠'} ${etherscan}` }),
      blocks,
      others,
    };
  });
  const amounts = context.inputs.pastTxs.flatMap(({ run }): PastAmounts[] => {
    const { effects, unmeasured } = amountsOf(run, registry);
    const missed = [...unmeasured.values()].reduce((n, hashes) => n + hashes.length, 0);
    const row = (party: 'sender' | 'receiver', differences: readonly Difference[]): PastAmountRow => ({
      party: w.amountsParty(party),
      cells: [...distributionOf(differences).counts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([by, n]) => ({ by: w.amountsBy(by), n: w.amountsCount(n) })),
    });
    return effects.map(({ effect, tokens, finding }) => ({
      effect: effectText(effect),
      tolerance: w.amountsTolerance(effect.tolerance?.less ?? 0n, effect.tolerance?.more ?? 0n),
      tokens: tokens.map((t) => ({
        count: t.sender.length,
        lead: w.amountsToken(nameOf(t.token), t.safes, t.eoas, t.inRegistry),
        rows: [row('sender', t.sender), ...(t.receiver.length === 0 ? [] : [row('receiver', t.receiver)])],
      })),
      finding: finding === undefined ? undefined : finding.kind === 'beyond' ? w.amountsBeyond(finding.lower, finding.higher) : w.amountsUnfounded,
      unmeasured: missed === 0 ? undefined : w.amountsUnmeasured(missed),
    }));
  });
  const spreads = context.inputs.pastTxs.flatMap(({ run }): PastSpread[] => {
    const fits = run.studies.filter((s): s is Fit => s.kind === 'fit');
    const groups = [
      { safe: true, fits: fits.filter((f) => f.sender.kind === 'safe'), rules: run.shapes.whole.loosened.rules },
      ...run.shapes.calls.map((shape, call) => ({ safe: false, fits: fits.filter((f) => f.sender.kind === 'eoa' && f.sender.call === call), rules: shape.loosened.rules })),
    ];
    return groups.flatMap(({ safe, fits: of, rules }) =>
      freeNumbers(of, rules).map(({ path, time, spread, unrecorded }): PastSpread => {
        const value = (n: bigint) => (time ? w.spreadSeconds(n) : `${n}`);
        const cells = spread === undefined ? [] : [['min', spread.min] as const, ...PERCENTILES.map((p, i) => [`p${p}`, spread.percentiles[i] as bigint] as const), ['max', spread.max] as const];
        return { field: path, who: w.spreadWho(safe), lead: w.spreadTime(time), count: spread?.count ?? 0, cells: cells.map(([label, n]) => ({ label, value: value(n) })), unrecorded: unrecorded === 0 ? undefined : w.spreadUnrecorded(unrecorded) };
      }),
    );
  });
  const conclusion = context.notes.pastTxsConclusion === undefined ? undefined : research(context.notes.pastTxsConclusion);
  return { anchor: anchor('past'), label: w.past, count: undefined, body: { kind: 'past', same: sameShape(context), conclusion, amounts, spreads, recordings } };
}

function sameShape(context: Context): Inline {
  const { registry, template, w } = context;
  const best = new Map<Hex, Studied>();
  for (const { run } of context.inputs.pastTxs) {
    for (const s of run.studies) {
      if ((s.kind !== 'fit' && s.kind !== 'misfit') || isOtherOperation(s, template)) continue;
      const seen = best.get(s.hash);
      if (seen === undefined || rank(s) < rank(seen)) best.set(s.hash, s);
    }
  }
  const all = [...best.values()];
  const exact = all.filter((s): s is Fit => shapeGroup(s) === 'exact');
  const outside = all.filter((s): s is Fit => shapeGroup(s) === 'outside');
  const misfits = all.length - exact.length - outside.length;
  const by = (of: readonly Fit[]): Span[] => {
    const parts = (['safe', 'eoa'] as const).map((kind): Span[] => {
      const mine = of.filter((s) => s.sender.kind === kind);
      return w.bySender(kind, { num: `${mine.length}` }, mine.length, new Set(mine.map((s) => s.sender.address)).size);
    });
    return of.length === 0 ? [] : w.bySenders(parts);
  };
  const latest = (of: readonly Fit[]): Span[] =>
    [...of]
      .sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1))
      .slice(0, 3)
      .flatMap((s, i): Span[] => [...(i === 0 ? [] : [w.sep]), txLink(s.hash)]);
  const searched = [
    ...new Set(
      context.inputs.pastTxs.map(({ query }) => {
        const token = registry.byAddress.get(query.token.toLowerCase() as Address);
        return w.searched(token?.name ?? checksumAddress(query.token as Address), anchorWords(query, token, w));
      }),
    ),
  ];
  const line = w.sameLine(exact.length, by(exact), outside.length === 0 ? w.anyOutside : outsideWords(outside, w), outside.length, by(outside), misfits);
  if (exact.length + outside.length === 0) return line;
  return [
    ...line,
    w.succeeded(exact.length + outside.length === 1, searched),
    ...(exact.length === 0 ? [] : [w.latestExact(Math.min(exact.length, 3)), ...latest(exact), w.end]),
    ...(outside.length === 0 ? [] : [w.latestShape(Math.min(outside.length, 3)), ...latest(outside), w.end]),
  ];
}

function onlyName(ref: CardRef, context: Context): RegistryEntry | undefined {
  const names = refNames(ref, context.template, context.registry);
  return names.length === 1 ? context.registry.entries.get(names[0] as string) : undefined;
}

function promptStep(name: string, field: CardField, context: Context): NextStep {
  const { w } = context;
  const step = (say: Inline, then: readonly Inline[] = []): NextStep => ({ say, command: undefined, then, hashes: false });
  const word = kindWord(field, context.template, w);
  const cardNewPrompt: Inline = word === name ? [{ code: name }] : w.prompt(word, { code: name });
  switch (field.kind) {
    case 'contract': {
      const only = onlyName({ field: name, attribute: undefined }, context);
      if (only !== undefined) return step([...cardNewPrompt, ...w.pickOnly(link(only), { mono: checksumAddress(only.address) })], [w.byName({ code: only.name })]);
      return step([...cardNewPrompt, w.pickKind(w.kind[field.scope.registryKind], field.scope.marketPart === undefined ? undefined : w.part[field.scope.marketPart])]);
    }
    case 'market':
      return step([...cardNewPrompt, w.pickMarket]);
    case 'address':
    case 'recipient':
      return step([...cardNewPrompt, w.pickAddress]);
    case 'nonce':
      return step([...cardNewPrompt, w.typeNonce]);
    case 'percent':
      return step([...cardNewPrompt, ...w.typePercent({ code: '100' }, { code: '35.5' })], [[w.percentPrints]]);
    case 'threshold':
      return step([...cardNewPrompt, w.typeThreshold]);
    case 'owner':
      return step([...cardNewPrompt, w.pickOwner]);
    case 'amount': {
      const token = field.of === 'eth' ? 'ETH' : (onlyName(field.of, context)?.name ?? w.picked(refWord(context.template, field.of, w)));
      if (field.computed === undefined) {
        return step(
          [...cardNewPrompt, ...w.typeAmount(token, { code: '1250.5' }, { code: '1,000,611.448606' })],
          [[w.amountPrints], ...(field.max === undefined ? [] : [w.orMax({ code: 'max' }, `${field.max.value}`)])],
        );
      }
      const { computed } = field;
      const bps = (n: number | bigint): string => percent(BigInt(n), 10_000n, w);
      const margin = computed.margin === undefined ? '' : w.margin(bps(computed.margin.bps));
      return step(
        [...cardNewPrompt, w.computedPrompt],
        [
          w.computedHow({ code: computed.read.fn.name }, token, computed.bound === 'floor', bps(slippageBps(computed)), bps(computed.default.bps), margin),
          w.presetSource({ href: computed.default.source, label: shortUrl(computed.default.source) }),
        ],
      );
    }
  }
}

function nextSection(context: Context): Section {
  const { template, w } = context;
  const fields = [...template.card];
  const typed = (field: CardField): boolean => field.kind === 'amount' || field.kind === 'nonce' || field.kind === 'threshold' || field.kind === 'percent';
  const computed = (field: CardField): boolean => field.kind === 'amount' && field.computed !== undefined;
  const vault = context.inputs.subject.kind === 'template' && context.inputs.subject.vault !== undefined;
  const trial = fields.some(([, f]) => f.kind === 'amount' && f.computed === undefined) ? w.trial(vault) : '';
  const prompts = [
    ...fields.filter(([, f]) => !typed(f)),
    ...fields.filter(([, f]) => typed(f) && !computed(f)),
    ...fields.filter(([, f]) => computed(f)),
  ].map(([name, field]) => promptStep(name, field, context));
  const y: Span = { code: 'y' };
  const book = (say: string, recipient: boolean): NextStep => ({
    say: [say],
    command: 'bin/kiss-sign book add <name> <address>',
    then: [w.bookThen({ code: 'Add this entry? [y/N]' }, y, recipient)],
    hashes: false,
  });
  const steps: NextStep[] = [
    { say: [w.approveSay], command: `bin/kiss-sign template approve ${template.id}`, then: [w.approveThen(y)], hashes: false },
    ...(fields.some(([, f]) => f.kind === 'owner') ? [book(w.ownerBook, false)] : []),
    ...(fields.some(([, f]) => f.kind === 'recipient') ? [book(w.recipientBook, true)] : []),
    { say: [w.makeCard], command: `bin/kiss-sign card new ${template.id}`, then: [w.cardNewStops({ code: 'templates/' }, { code: 'registry/' }, { code: 'git pull' })], hashes: false },
    ...prompts,
    { say: w.sealSay({ code: 'Is this what you mean to do? [y/N]' }, y), command: undefined, then: [w.sealThen({ code: 'Sealed card 0x…' })], hashes: false },
    {
      say: [w.propose(trial)],
      command: 'bin/kiss-sign verify --card <card hash> --safe-tx-hash <safeTxHash>',
      then: [w.onMatch({ code: 'MATCH' }), w.onMismatch({ code: 'MISMATCH' }, { code: 'UNVERIFIABLE' }, { href: anchor('review'), label: w.review })],
      hashes: false,
    },
    { say: [w.hardened], command: './check.sh <nonce>', then: [w.hardenedThen({ code: 'verify' })], hashes: false },
    { say: w.compareHashes({ code: 'verify' }), command: undefined, then: [], hashes: true },
  ];
  const tokenName = (token: EffectToken) => effectTokenName(token, context);
  const field = (name: string): string => fieldWord(template, name, w);
  const automatic: Inline[] = [
    [w.onlyCalls(template.calls.length)],
    [w.everyArgument],
    ...template.effects.gives.map((e): Inline => [
      w.gives(tokenName(e.token), e.amount.kind === 'card' || e.amount.kind === 'at-most' ? { kind: e.amount.kind, field: field(e.amount.field) } : { kind: e.amount.kind === 'all' ? 'all' : 'positive' }),
    ]),
    ...template.effects.gets.map((e): Inline => (e.amount.kind === 'any' ? [w.getsAnyAmount(tokenName(e.token))] : w.gets(tokenName(e.token), e.amount.kind === 'at-least' ? field(e.amount.field) : undefined))),
    ...[...template.effects.gives, ...template.effects.gets, ...template.effects.touches.map((t) => ({ ...t, token: { contract: t.token } }))].flatMap((e): Inline[] =>
      e.tolerance === undefined ? [] : [[w.toleranceLine(tokenName(e.token), w.tolerance(e.tolerance.less, e.tolerance.more))]],
    ),
    ...(template.effects.gives.length + template.effects.gets.length + template.effects.touches.length === 0 ? [[w.noBalanceChange]] : []),
    ...(template.nonce === undefined ? [] : [[w.nonceIs, ...ruleWords(template.nonce, context)]]),
    ...(template.effects.safe === undefined ? [] : [[w.safeSettings]]),
    template.effects.approves.length === 0
      ? [w.noAllowance]
      : template.effects.approves.every((a) => a.amount.kind === 'card')
        ? [w.allowanceKeptFor(template.effects.approves.map((a) => a.spender))]
        : [w.allowanceKept],
    ...template.effects.views.map((v): Inline => [
      { code: `${viewLabel(v, context)}.${v.fn.name}` },
      w.viewChanges(v.changes.map((c) => [paramName(v.returns[c.value] as AbiParam, c.value), typeof c.change === 'string' ? w.change[c.change] : w.equalsTypedList(field(c.change.equals))] as const)),
    ]),
    ...(context.ledger.entries.length === 0 ? [] : [[w.pinned]]),
  ];
  return { anchor: anchor('next'), label: w.next, count: undefined, body: { kind: 'next', steps, automatic } };
}

/** The free rules of the transaction's own fields, and whether a signed message has a free member, which no perturbation tries. */
function freeRules(template: Template): { readonly claims: Set<FreeClaim>; readonly member: boolean } {
  const found = new Set<FreeClaim>();
  const members = new Set<Rule>();
  const collect = (rule: Rule): void => {
    if (rule.kind === 'eip712') rule.message.fields.forEach((field) => members.add(field));
    if (rule.kind === 'packed') rule.parts.forEach((part) => collect(part.rule));
    if (rule.kind === 'call') rule.call.args.forEach(collect);
    if (rule.kind === 'items') rule.items.forEach(collect);
    if (rule.kind === 'fields') rule.fields.forEach(collect);
  };
  const visit = (rule: Rule): void => {
    if (rule.kind === 'free' && !members.has(rule)) found.add(rule.claim);
    if (rule.kind === 'equals') visit(rule.rule);
    if (rule.kind === 'packed') rule.parts.forEach((part) => visit(part.rule));
    if (rule.kind === 'call') rule.call.args.forEach(visit);
    if (rule.kind === 'items') rule.items.forEach(visit);
    if (rule.kind === 'fields') rule.fields.forEach(visit);
  };
  const calls = template.calls.flatMap((call) => [call.to, call.value, ...(call.data === 'empty' ? [] : call.data.args)]);
  calls.forEach(collect);
  calls.forEach(visit);
  return { claims: new Set((['scalar', 'route', 'proof', 'unread'] as const).filter((claim) => found.has(claim))), member: [...members].some((rule) => rule.kind === 'free') };
}

/** The parameter checks line when no test transaction is recorded, from the template. */
const unrecordedParams = (template: Template, w: Words): string => (freeRules(template).claims.size > 0 ? w.unrecorded : w.allBound(freeRules(template).member));

function stripItems(ledger: Ledger, template: Template, signed: ReadonlySet<string>, w: Words): StripItem[] {
  const names = [...new Set(ledger.entries.map((e) => e.name))];
  const subjects = names.filter((name) => signed.has(name)).length;
  const reportOnly = names.filter((name) => !signed.has(name));
  const recorded = ledger.results.some((r) => r.line === 'params');
  const named = (match: (result: Result) => boolean): string[] => [...new Set(ledger.results.flatMap((r) => (match(r) && r.about.kind === 'entry' ? [r.about.entry.name] : [])))];
  const notCalled = named((r) => r.finding.kind === 'not-called');
  const unprovable = named((r) => r.finding.kind === 'routed-proxy');
  const today = named((r) => r.id.endsWith('/code.today'));
  const routed = ledger.entries.filter((entry) => entry.routes !== undefined).map((entry) => entry.name);
  const explain: Readonly<Record<StripLine, (passed: number, counted: number) => string>> = {
    sources: (p, c) => (p === c ? w.sourcesOk(c, MIN_CONFIRMATIONS) : w.sourcesSome(c - p, p, MIN_CONFIRMATIONS)),
    abi: () => w.abiExplain(notCalled, unprovable),
    code: () => w.codeExplain(subjects === 1, reportOnly, today, routed),
    params: (_, c) => (!recorded ? unrecordedParams(template, w) : w.paramsExplain(c)),
  };
  const items = strip(ledger)
    .filter((s) => s.line === 'params' || ledger.results.some((r) => r.line === s.line))
    .map(
    (s): StripItem => ({ line: s.line, name: w.strip[s.line], state: s.state, count: s.line === 'params' && !recorded ? w.noTests : s.counted === 0 ? undefined : `${s.passed} / ${s.counted}`, explain: explain[s.line](s.passed, s.counted) }),
  );
  return [...items, { line: 'providers', name: w.strip.providers, state: 'ok', count: undefined, explain: w.providersExplain }];
}

/**
 * The signer's page in `language`, from the report's inputs and the raw notes.json. The ledger judges every result;
 * notes.json is parsed against the scope the template and the ledger derive, so it cannot name what the page does not
 * show nor leave out a review the page needs. Throws NotesError for notes the program refuses.
 */
export function buildPage(inputs: HtmlInputs, rawNotes: unknown, title: ReportTitle, language: Language): Page {
  const { subject, registry } = inputs;
  if (subject.kind !== 'template') throw new Error('an HTML report is written for a template only');
  const { template } = subject;
  const ledger = judge(inputs, inputs.fixtures);
  const notes = parseNotes(rawNotes, notesScope(inputs, ledger, template, language));
  const { example } = inputs;
  const w = WORDS[language];
  const context: Context = {
    w,
    language,
    inputs,
    template,
    registry,
    facts: inputs.facts,
    notes,
    ledger,
    card: example?.card.operations.find((op) => op.template === template.id)?.values,
    values: example === undefined ? new Map() : exampleValues(template, example.tx),
  };
  const sections = [flowSection(context), ...protocolSections(context), ...vaultSection(context), reviewSection(context), walletSection(context), ...addressSection(context), pastSection(context), nextSection(context)];
  const sources = [...title.sources, 'testdata/perturb', 'testdata/safe-tx', notesPath(template.id), ...(subject.vault === undefined ? [] : [notesPath(template.id, subject.vault.name)])];
  return {
    language,
    id: subject.vault === undefined ? template.id : `${template.id} · ${subject.vault.name}`,
    header: {
      title: research(notes.title),
      summary: research(notes.summary),
      onlyIn: notesLanguages(rawNotes).length === 1 ? w.onlyIn : undefined,
      strip: stripItems(ledger, template, signedEntryNames(template, registry), w),
      verdict: { state: worst(ledger.results), text: research(notes.verdict.text, [], notes.verdict.status === 'safe' ? 'safe' : 'caution') },
    },
    sections,
    footer: w.footer({ code: title.command }, sources.map((s): Span => ({ code: s })), inputs.fetched, { code: 'pnpm test' }, NOTES_FILE),
  };
}
