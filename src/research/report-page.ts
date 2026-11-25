import { join } from 'node:path';
import { hexToBytes } from '@noble/hashes/utils.js';
import { groupedTokens } from '../chain/decimals.ts';
import { castValue } from '../decode/cast.ts';
import { OFFICIAL_MULTISEND } from '../decode/multisend.ts';
import type { AbiParam } from '../decode/abi.ts';
import { namedSignatureOfAbiEntry, paramName, parseFunctionSignature } from '../decode/abi.ts';
import { say } from '../language.ts';
import type { Language } from '../language.ts';
import { FLOOR_RULE } from '../price/reference.ts';
import { MARKET_PARAMS, parseHttpsUrl, sizeOf } from '../registry.ts';
import type { HttpsUrl, Market, Registry, RegistryEntry } from '../registry.ts';
import { SAFE_TX_TYPEHASH_HEX } from '../safe/hash.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { FixtureJudgement } from '../template/perturb.ts';
import { TEMPLATES_DIR, addressWord, callSites, isNamedToken, refNames, slippageBps, viewTargetNames } from '../template/template.ts';
import type { CardField, CardRef, Computed, ConstValue, EffectToken, Floor, KeptApproval, FreeClaim, Rule, Template, TemplateCall, Tolerance, TokenRef, ViewEffect, ViewExpectation } from '../template/template.ts';
import { distributionOf, effectText } from './amounts.ts';
import type { Difference } from './amounts.ts';
import type { FieldFact } from './erc7730.ts';
import { latestOf, packageKey } from './npm-package.ts';
import { tipUrlOf } from './source-page.ts';
import type { DeployerShare, SitePlace } from './listings.ts';
import { weightOf } from './grades.ts';
import type { Grade } from './grades.ts';
import { MIN_CONFIRMATIONS, addressRows, confidence, confirmations, docOf, flowResults, forSigner, judge, needsSigner, sourcesOf, stateOf, strip, worst } from './ledger.ts';
import type { Confidence, FindingKind, Ledger, Phrase, Place, ProgramSource, Result, ResultId, State, StripLine } from './ledger.ts';
import { NOTES_FILE, argumentTree, notesLanguages, notesScope, parseFlowLines, parseNotes } from './notes.ts';
import type { ArgNode, Notes } from './notes.ts';
import { amountsOf } from './past-txs-render.ts';
import { foundBy } from './past-txs.ts';
import type { PastTxs } from './past-txs.ts';
import type { PastTxsRecording } from './recording.ts';
import { factsScope } from './protocol-facts.ts';
import { isExact, newestFirst, pastDifferences, pastFields, studiedOnce } from './report-past.ts';
import type { PastCall, PastDifference, PastField, SpreadRow, Studied } from './report-past.ts';
import { cardAddresses, functionNames, isOtherOperation, shapesOf } from './study.ts';
import type { MisfitReason } from './study.ts';
import { readStoredEvidence } from './instance-evidence.ts';
import type { StoredPoint } from './instance-evidence.ts';
import type { ProtocolFacts, ProtocolSheet } from './protocol-facts.ts';
import { signedEntryNames } from './report.ts';
import type { ReportInputs, ReportTitle } from './report.ts';
import { WORDS, dateOf } from './report-words.ts';
import { compareFlow, sideOf, tokenUntested } from './trace.ts';
import type { FlowComparison, FlowEnd, LineTally, Payment, TracedTx, Uncovered } from './trace.ts';
import type { By, FreeTest, SafeParties, SearchSpan, Words } from './report-words.ts';
import { formatMillions, modelName, totalTokens, usagePath } from './usage.ts';
import type { Usage } from './usage.ts';

declare const anchorBrand: unique symbol;
/** An id the page itself gives an element: a section, or an address row (`a-<registry name>`). A link names only these or an HttpsUrl. */
export type Anchor = string & { readonly [anchorBrand]: true };
const anchor = (id: string): Anchor => id as Anchor;
export const entryAnchor = (name: string): Anchor => anchor(`a-${name}`);

/** Program text. Monospace only for what the signer compares character by character. */
export type Span =
  | string
  | { readonly code: string }
  /** `line` puts it on a line of its own, for a list of addresses. */
  | { readonly mono: string; readonly line?: true }
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

/** What the AI used to make the report, which is no result of its own. */
export type UsageBlock = { readonly lead: string; readonly table: { readonly head: readonly [string, string]; readonly rows: readonly (readonly [string, string])[]; readonly total: readonly [string, string] } | undefined; readonly notes: readonly string[] };

/** A table of past transactions; a `num` column's cells align right, a `wide` one's wrap, and a `value` one's are what the table is for. */
export type PastTable = { readonly head: readonly { readonly label: string; readonly as: 'num' | 'wide' | 'plain' | 'value' | 'links' }[]; readonly rows: readonly (readonly Inline[])[] };

export type Section = { readonly anchor: Anchor; readonly label: string; readonly count: RailCount | undefined; readonly body: Body };

export type Body =
  | { readonly kind: 'flow'; readonly flow: Flow }
  | { readonly kind: 'protocol'; readonly block: ProtocolBlock }
  | { readonly kind: 'vault'; readonly vault: VaultBlock }
  | { readonly kind: 'review'; readonly rows: readonly ReviewRow[]; readonly judgments: readonly Judgment[] }
  | { readonly kind: 'wallet'; readonly view: WalletView }
  | { readonly kind: 'addresses'; readonly open: readonly AddressRow[]; readonly folded: readonly AddressRow[] }
  | { readonly kind: 'past'; readonly past: PastBlock | undefined }
  | { readonly kind: 'usage'; readonly usage: UsageBlock }
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

export type Who = 'you-type' | 'you-pick' | 'computed' | 'fixed' | 'free' | 'bounded';
/** The who-decides legend, by who: the signer, the program and template, or the protocol's app. */
export type KeyGroup = { readonly title: string; readonly items: readonly KeyItem[] };
export type KeyItem = { readonly who: Who; readonly label: string; readonly means: string };
export type Chip = { readonly who: Who; readonly label: string };
/** Which of an argument's parts one decides, when its parts differ. */
export type Mix = Chip & { readonly parts: readonly string[] };

export type ArgRow = {
  readonly key: string;
  readonly name: string;
  /** One chip, or none when `mix` says who decides each of its parts. */
  readonly chips: readonly Chip[];
  readonly mix: readonly Mix[];
  /** As `cast decode-calldata` prints it, for a value the template fixes; none for a value decided at each signing. */
  readonly value: string | undefined;
  readonly words: Inline;
  readonly qualifier: Inline | undefined;
  /** More about the rule, folded under its label. */
  readonly more: { readonly label: string; readonly text: string } | undefined;
  readonly id: Inline | undefined;
  /** What the argument does, from notes.json; none on a row the program adds, such as a call's `to`. */
  readonly ai: AiText | undefined;
  readonly parts: readonly { readonly label: Inline | undefined; readonly rows: readonly ArgRow[] }[];
  /** The nested call's documentation page, on a `bytes` argument the template binds to a call. */
  readonly doc: DocLine | undefined;
  /** The template fixes it and every part of it, and no documentation page under it failed to pass: the page folds it with its group's other fixed rows. */
  readonly fixed: boolean;
};

export type CallHead = { readonly kind: 'fn'; readonly contract: string; readonly fn: string; readonly selector: Hex; readonly doc: DocLine } | { readonly kind: 'no-data'; readonly text: string };
export type CallBlock = { readonly n: number; readonly head: CallHead; readonly sends: Inline | undefined; readonly args: readonly ArgRow[] };

export type AfterRow = { readonly label: Inline; readonly value: Inline; readonly note: Inline; readonly gains: boolean; readonly ai?: AiText };

export type Lifeline = { readonly name: string; readonly role: string };
export type SeenLine = { readonly seen: number; readonly of: number; readonly state: 'confirmed' | 'partial' | 'some-tokens'; readonly tokens: readonly string[]; readonly fields: readonly string[] };
export type Arrow =
  | { readonly kind: 'call'; readonly n: number; readonly to: number; readonly fn: string }
  /** A call the template binds inside a call, such as a Bundler3 bundle item. */
  | { readonly kind: 'nested'; readonly from: number; readonly to: number; readonly fn: string }
  /**
   * An AI `flow` line; `seen` when the call traces saw it, with in how many of the transactions they tested:
   * `confirmed` in all of them and the AI names its sources, `partial` in some, `some-tokens` in all of them though none
   * held some token its card field can name, so it is confirmed only for those in `tokens`. `fields` counts each card
   * field it names by token.
   */
  | { readonly kind: 'inside'; readonly from: number; readonly to: number; readonly text: AiText; readonly seen: SeenLine | undefined }
  | { readonly kind: 'gets'; readonly from: number; readonly text: string };
/** `traced` when a call trace confirmed a `flow` line, so the page says what a trace shows and what it does not. */
export type Sequence = { readonly lifelines: readonly Lifeline[]; readonly arrows: readonly Arrow[]; readonly narration: string; readonly traced: boolean };

export type Flow = {
  readonly diagram: Sequence;
  /** Each word some row uses, with what it means, in groups; a free field once per claim it makes. */
  readonly key: readonly KeyGroup[];
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
  /** The AI's context about the instance, such as where its deposits go, each under its title. */
  readonly context: readonly { readonly title: AiText; readonly note: AiText }[];
};

export type ReviewRow = {
  readonly id: ResultId;
  readonly state: State;
  readonly grade: Grade;
  /** What kind of result it is, in plain words. */
  readonly title: string;
  /** The AI review's first sentence, shown open; the rest is folded. */
  readonly conclusion: AiText;
  /** What the result is about beyond the title, as the program names it: the source, span, call or flow line; none when the title says it all. */
  readonly subject: Inline | undefined;
  readonly why: Inline;
  readonly entry: Anchor | undefined;
  /** The AI review after its first sentence, which `conclusion` shows open; none when that sentence is all of it. */
  readonly review: { readonly status: 'confirmed' | 'concern'; readonly rest: AiText | undefined; readonly recommendation: AiText };
};
export type Judgment = { readonly conclusion: AiText; readonly rest: AiText | undefined; readonly recommendation: AiText };

export type WalletRows = readonly { readonly label: Inline; readonly value: Inline }[] | 'no-descriptor';
export type WalletCall = { readonly n: number; readonly title: Inline; readonly rows: WalletRows };

/**
 * Every Safe transaction is first a `SafeTx` message, shown by its own descriptor. A template of two or more calls goes
 * through MultiSend, which no descriptor decodes, so it has no per-call view.
 */
export type WalletView = { readonly safeTx: WalletRows; readonly lines: readonly Inline[] } & (
  | { readonly kind: 'multisend'; readonly calls: number }
  | { readonly kind: 'no-data' }
  | { readonly kind: 'calls'; readonly calls: readonly WalletCall[] }
);

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

/** One token's measured balances against the stated amount. */
export type PastTokenAmounts = { readonly lead: string; readonly table: PastTable };
/** One measured effect of one recording, shown beside its tolerance, with the finding when the evidence and the tolerance disagree. */
export type PastAmounts = {
  readonly effect: string;
  readonly tolerance: string;
  readonly tokens: readonly PastTokenAmounts[];
  /** The tokens no card can name, folded. */
  readonly outside: { readonly label: string; readonly tokens: readonly PastTokenAmounts[] } | undefined;
  readonly finding: string | undefined;
  readonly unmeasured: string | undefined;
};
/** The past values at one place the app fills. */
export type PastNumbers = { readonly name: string; readonly lead: string; readonly table: PastTable | undefined; readonly says: Inline | undefined; readonly limit: readonly [string, string, string] | undefined; readonly notes: readonly string[]; readonly exact: Inline | undefined };
export type PastBlock = {
  readonly worked: { readonly answer: string; readonly rest: Inline };
  readonly numbers: readonly PastNumbers[];
  readonly differ: { readonly lead: string; readonly open: PastTable | undefined; readonly more: { readonly label: string; readonly table: PastTable } | undefined };
  readonly conclusion: AiText | undefined;
  readonly amounts: readonly PastAmounts[];
  readonly search: readonly { readonly count: string; readonly lines: readonly Inline[] }[];
};

/** Everything the HTML report reads beyond the Markdown report's inputs. */
export type HtmlInputs = ReportInputs & {
  readonly fixtures: readonly FixtureJudgement[];
};

/** A card field's word from its kind; a typed amount by what it counts: shares for a vault's own shares, an amount for an asset or ETH. */
function kindWord(field: CardField, template: Template, w: Words): string {
  switch (field.kind) {
    case 'contract':
      return w.kind[field.scope.registryKind];
    case 'amount': {
      if (field.floor !== undefined) return w.field.floor;
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

/** A card field's word with who decides its value. */
const byWord = (template: Template, name: string, w: Words): By => ({ field: fieldWord(template, name, w), computed: isComputed(template, name) });

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
  const { docs } = context.inputs.subject;
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

const placeWords = (entry: RegistryEntry, owner: string, sources: readonly ProgramSource[], w: Words, registry: Registry): string => {
  const words = sources.map((source) => confirmationWord(entry, source, w, registry));
  return words.length === 1 ? (words[0] as string) : `${words.join(' + ')} (${owner})`;
};

const confirmedWords = (entry: RegistryEntry, by: readonly Place[], w: Words, registry: Registry): string =>
  w.confirmed(by.map(({ owner, sources }) => placeWords(entry, owner, sources, w, registry)), by.length >= MIN_CONFIRMATIONS);

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
  /** The `flow` lines and money calls against the past transactions' call traces. */
  readonly comparison: FlowComparison;
};

/** What the program's results need, before any note is parsed. */
type Judged = Omit<Context, 'notes'>;

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
  const names = refNames(ref, context.template, context.registry);
  const entry = names.length === 1 ? context.registry.entries.get(names[0] as string) : undefined;
  return entry === undefined ? undefined : { address: entry.address, name: entry.name };
}

/** An effect's token by name: the registry name it resolves to, or the card field the signer picks it with. */
const effectTokenName = (token: EffectToken, context: Context): string =>
  tokenOf(token, context)?.name ?? (token === 'eth' ? 'ETH' : isNamedToken(token) ? token.contract : context.w.picked(refWord(context.template, token, context.w)));

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
  return { label: refWord(context.template, rule.ref, w), names, role: w.role.picked };
}

/**
 * Where a card amount comes from: the chip, the words of its rules, `card new`'s step and the trial line all ask here.
 * A new source is one more member, which `promptStep` must then word.
 */
type AmountSource = { readonly kind: 'typed' } | { readonly kind: 'computed'; readonly computed: Computed } | { readonly kind: 'floor'; readonly floor: Floor };
const sourceOfAmount = (field: Extract<CardField, { kind: 'amount' }>): AmountSource => {
  if (field.floor !== undefined) return { kind: 'floor', floor: field.floor };
  return field.computed === undefined ? { kind: 'typed' } : { kind: 'computed', computed: field.computed };
};

const isComputed = (template: Template, name: string): boolean => {
  const field = template.card.get(name);
  return field?.kind === 'amount' && sourceOfAmount(field).kind !== 'typed';
};

function whoOf(rule: Rule, template: Template): { readonly who: Who; readonly field: string | undefined } | undefined {
  switch (rule.kind) {
    case 'card': {
      const field = template.card.get(rule.ref.field);
      if (isComputed(template, rule.ref.field)) return { who: 'computed', field: rule.ref.field };
      return { who: field?.kind === 'amount' || field?.kind === 'nonce' || field?.kind === 'threshold' || field?.kind === 'percent' ? 'you-type' : 'you-pick', field: rule.ref.field };
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
    case 'share-price': {
      const computed = [rule.shares, rule.assets].find((q) => q.kind === 'card' && isComputed(template, q.field));
      if (computed?.kind === 'card') return { who: 'computed', field: computed.field };
      return { who: 'you-type', field: rule.assets.kind === 'card' ? rule.assets.field : undefined };
    }
    case 'at-least':
    case 'at-most':
      return { who: isComputed(template, rule.field) ? 'computed' : 'you-type', field: rule.field };
    case 'call':
    case 'items':
    case 'fields':
    case 'packed':
    case 'eip712':
      return undefined;
  }
}

const chipLabel = (template: Template, who: Who, field: string | undefined, w: Words): string =>
  field === undefined || who === 'fixed' ? w.who[who] : w.chip(w.who[who], fieldWord(template, field, w));

function leaves(node: ArgNode, template: Template): { readonly node: ArgNode; readonly who: Who; readonly field: string | undefined }[] {
  if (node.rule.kind === 'call') return [];
  if (node.children.length > 0) return node.children.flatMap((child) => leaves(child, template));
  const who = whoOf(node.rule, template);
  return who === undefined ? [] : [{ node, ...who }];
}

const WHO_ORDER: readonly Who[] = ['you-pick', 'you-type', 'computed', 'fixed', 'bounded', 'free'];

/** One chip when every part agrees; else who decides each part, by name. A nested call carries neither. */
function decided(node: ArgNode, template: Template, w: Words): { readonly chips: readonly Chip[]; readonly mix: readonly Mix[] } {
  const found = leaves(node, template);
  const distinct = [...new Map(found.map((leaf) => [`${leaf.who}/${leaf.field ?? ''}`, leaf])).values()];
  if (distinct.length <= 1) return { chips: distinct.map((leaf) => ({ who: leaf.who, label: chipLabel(template, leaf.who, leaf.field, w) })), mix: [] };
  const mix = WHO_ORDER.flatMap((who): Mix[] => {
    const parts = [...new Set(found.flatMap((leaf) => (leaf.who === who ? [leaf.node.name] : [])))];
    return parts.length === 0 ? [] : [{ who, label: w.who[who], parts }];
  });
  return { chips: [], mix };
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
  return typeof change === 'string' ? [w.change[change]] : [w.equalsTyped(byWord(context.template, change.equals, w))];
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

function cardWords(ref: CardRef, context: Context): { readonly words: Inline; readonly qualifier: Inline | undefined } {
  const { w } = context;
  const field = context.template.card.get(ref.field);
  const only = onlyEntry(ref, context);
  const picks = w.picked(refWord(context.template, ref, w));
  if (only !== undefined) return { words: [link(only)], qualifier: [picks] };
  if (field?.kind === 'amount' || field?.kind === 'percent' || field?.kind === 'nonce' || field?.kind === 'threshold') return { words: [w.typed(byWord(context.template, ref.field, w))], qualifier: undefined };
  return { words: [picks], qualifier: undefined };
}

function freeTest(rule: Rule, context: Context): FreeTest {
  const outcomes = context.inputs.fixtures.flatMap(({ outcome }) =>
    outcome.kind === 'card-refused' || outcome.perturbation.kind === 'not-run' ? [] : outcome.perturbation.runs.filter((run) => run.leaf.rule === rule && run.outcome !== 'unverifiable').map((run) => run.outcome),
  );
  return outcomes.length === 0 ? 'not-tested' : outcomes.every((outcome) => outcome === 'reverted' || outcome === 'refused') ? 'all-failed' : 'tested';
}

/** The claims whose words say a test tried other values, which only a test that did can say. */
const TESTED_CLAIMS: ReadonlySet<FreeClaim> = new Set(['scalar', 'route']);

function freeWords(rule: Extract<Rule, { kind: 'free' }>, context: Context): string {
  const { w } = context;
  const test = TESTED_CLAIMS.has(rule.claim) ? freeTest(rule, context) : 'tested';
  return test === 'not-tested' ? w.freeNotTested : test === 'all-failed' ? w.freeAllFailed : w.free[rule.claim];
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
      return cardWords(rule.ref, context);
    case 'address-word': {
      const inner = leafWords({ ...node, rule: rule.rule }, context);
      return { words: [...inner.words, w.asWord], qualifier: inner.qualifier };
    }
    case 'free':
      return { words: [w.differs], qualifier: [freeWords(rule, context)] };
    case 'within-seconds':
      return { words: [w.within(rule.seconds)], qualifier: undefined };
    case 'equals':
      return { words: w.sameAs({ code: rule.path }), qualifier: undefined };
    case 'owner-before':
      return { words: [w.ownerBefore(refWord(context.template, rule.ref, w))], qualifier: [w.ownerBeforeHow] };
    case 'share-price':
      return { words: [rule.bound === 'max' ? w.priceMax : w.priceMin], qualifier: [w.priceHow] };
    case 'at-least':
      return { words: [w.atLeastTyped(byWord(context.template, rule.field, w))], qualifier: [w.atLeastHow] };
    case 'at-most':
      return { words: [w.atMostTyped(byWord(context.template, rule.field, w))], qualifier: [w.atMostHow] };
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

/** How a time rule counts, which its row folds. */
const moreOf = (rule: Rule, w: Words): ArgRow['more'] => (rule.kind === 'within-seconds' ? { label: w.withinLabel, text: w.withinHow(rule.seconds) } : undefined);

function valueOf(node: ArgNode, context: Context): ArgRow['value'] {
  if (node.rule.kind === 'const') return constCast(node.rule.value);
  const word = node.rule.kind === 'address-word';
  const rule = node.rule.kind === 'address-word' ? node.rule.rule : node.rule;
  const cast = (address: Address): string => (word ? addressWord(address) : checksumAddress(address));
  if (rule.kind === 'contract') return cast((context.registry.entries.get(rule.name) as RegistryEntry).address);
  const only = rule.kind === 'card' ? onlyEntry(rule.ref, context) : undefined;
  return only === undefined ? undefined : cast(only.address);
}

function marketPartRows(node: ArgNode, market: Market, context: Context): ArgRow[] {
  return node.children.map((child, i) => {
    const part = MARKET_PARAMS[i] as (typeof MARKET_PARAMS)[number];
    const entry = part === 'lltv' ? undefined : market[part];
    return {
      key: child.key,
      name: child.name,
      chips: [],
      mix: [],
      value: entry === undefined ? market.lltv.toString() : checksumAddress(entry.address),
      words: entry === undefined ? [lltvWords(market.lltv, context.w)] : [link(entry)],
      qualifier: undefined,
      more: undefined,
      id: undefined,
      ai: fieldsNote(context, child.key),
      parts: [],
      doc: undefined,
      fixed: false,
    };
  });
}

function argRow(node: ArgNode, context: Context, withChips: boolean, inMessage = false): ArgRow {
  const { w } = context;
  const { chips, mix } = withChips ? decided(node, context.template, w) : { chips: [], mix: [] };
  const market = wholeMarket(node.rule, context.template);
  if (market !== undefined) {
    const markets = [...context.registry.markets.values()];
    const shown = markets.length === 1 ? markets[0] : undefined;
    return {
      key: node.key,
      name: node.name,
      chips,
      mix,
      value: undefined,
      words: shown === undefined ? [w.picked(fieldWord(context.template, market, w))] : [marketWords(shown, w)],
      qualifier: [w.marketHow(MARKET_PARAMS.length)],
      more: undefined,
      id: shown === undefined ? undefined : ['market id ', { mono: shown.id }],
      ai: fieldsNote(context, node.key),
      parts: markets.map((m) => ({ label: markets.length === 1 ? undefined : [marketWords(m, w), w.marketId, { mono: m.id }], rows: marketPartRows(node, m, context) })),
      doc: undefined,
      fixed: false,
    };
  }
  const nestedCall = node.rule.kind === 'call';
  const leaf = leafWords(node, context);
  const { words } = leaf;
  /** A free member of a signed message is no value of this transaction: the digest fixes it, and no perturbation tries another. */
  const qualifier = inMessage && node.rule.kind === 'free' ? [w.freeMember] : leaf.qualifier;
  const rows = node.children.map((child) => argRow(child, context, nestedCall, inMessage || node.rule.kind === 'eip712'));
  const doc = node.rule.kind === 'call' && node.rule.call.encoding === 'call' ? docLine(node.rule.call.fn.signature, context) : undefined;
  return {
    key: node.key,
    name: node.name,
    chips,
    mix,
    value: valueOf(node, context),
    words,
    qualifier,
    more: moreOf(node.rule, w),
    id: undefined,
    ai: fieldsNote(context, node.key),
    parts: rows.length === 0 ? [] : [{ label: undefined, rows }],
    doc,
    fixed: (rows.length === 0 ? whoOf(node.rule, context.template)?.who === 'fixed' : rows.every((row) => row.fixed)) && (doc === undefined || doc.state === 'ok'),
  };
}

const cardTarget = (field: string, context: Context) => targetOf({ kind: 'card', ref: { field, attribute: undefined } }, context);

/** Each card field a line names with its tokens: in how many transactions that held the token the line was seen, and the tokens none held. */
const fieldWords = ({ fields }: LineTally, context: Judged): string[] =>
  fields.map(({ field, tokens }) =>
    context.w.seenByToken(
      fieldWord(context.template, field, context.w),
      tokens.filter(({ of }) => of > 0).map(({ name, seen, of }) => `${name} ${context.w.seenOf(seen, of)}`),
      tokens.filter(({ of }) => of === 0).map(({ name }) => name),
    ),
  );

function seenLine(line: LineTally, context: Context): SeenLine | undefined {
  const { seen, of } = line;
  if (seen === 0) return undefined;
  const tokens = line.fields.map((field) => {
    const held = context.w.list(field.tokens.filter((token) => token.seen > 0).map(({ name }) => name));
    return line.fields.length === 1 ? held : context.w.tokensOf(fieldWord(context.template, field.field, context.w), held);
  });
  return { seen, of, state: seen < of ? 'partial' : tokenUntested(line) ? 'some-tokens' : 'confirmed', tokens, fields: fieldWords(line, context) };
}

function lifelines(context: Context): { readonly lines: Lifeline[]; readonly names: (readonly string[])[]; readonly callTo: number[]; readonly getsFrom: number[] } {
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
  for (const site of nestedSites(context)) {
    if (!names.some((of) => of.some((name) => site.names.includes(name)))) add(site.names.join(' | '), site.names, kindOf(site.names[0] as string));
  }
  const ends = context.notes.flow.flatMap((line) => [line.from, line.to]);
  for (const end of ends) {
    if (end.kind === 'entry' && !names.some((of) => of.includes(end.name))) add(end.name, [end.name], kindOf(end.name));
  }
  for (const end of ends) {
    if (end.kind !== 'card') continue;
    const target = cardTarget(end.field, context);
    add(target.label, target.names, target.role);
  }
  const getsFrom = template.effects.gets.map(({ token }) => {
    if (token === 'eth') return callTo.at(-1) ?? 0;
    const target = targetOf(isNamedToken(token) ? { kind: 'contract', name: token.contract } : { kind: 'card', ref: token }, context);
    return add(target.label, target.names, target.role);
  });
  return { lines, names, callTo, getsFrom };
}

/** Each call the template binds inside a call whose target it names. */
const nestedSites = (context: Context) =>
  callSites(context.template, context.registry).flatMap((site) => (site.nested && site.names !== undefined && site.names.length > 0 ? [{ ...site, names: site.names }] : []));

function sequence(context: Context): Sequence {
  const { template, notes, w, comparison } = context;
  const { lines, names, callTo, getsFrom } = lifelines(context);
  const at = (name: string): number => names.findIndex((of) => of.includes(name));
  const endAt = (end: FlowEnd): number => (end.kind === 'entry' ? at(end.name) : lines.findIndex((line) => line.name === cardTarget(end.field, context).label));
  const nested = nestedSites(context);
  const arrows: Arrow[] = [];
  const narration: string[] = [];
  template.calls.forEach((call, i) => {
    const to = callTo[i] as number;
    const target = to === 0 ? w.self : (lines[to]?.name as string);
    const sendsEth = !zeroValue(call);
    const fn = call.data !== 'empty' ? call.data.fn.name : sendsEth ? w.sendEth : w.noDataZero;
    arrows.push({ kind: 'call', n: i + 1, to, fn });
    narration.push(call.data !== 'empty' ? w.narrateCall(i + 1, target, fn) : w.narrateEmpty(i + 1, target, sendsEth));
    for (const site of nested.filter((s) => s.call === i)) arrows.push({ kind: 'nested', from: to, to: names.findIndex((of) => of.some((name) => site.names.includes(name))), fn: site.fn.name });
    notes.flow.forEach((line, l) => {
      if (line.after !== i + 1) return;
      const tally = comparison.lines[l];
      const seen = tally === undefined ? undefined : seenLine(tally, context);
      arrows.push({ kind: 'inside', from: endAt(line.from), to: endAt(line.to), text: research(line.text, line.sources), seen });
    });
  });
  template.effects.gets.forEach((effect, i) => {
    const token = tokenOf(effect.token, context);
    const text = effect.amount.kind === 'any' ? w.youMayGet(token?.name) : w.youGet(token?.name);
    arrows.push({ kind: 'gets', from: getsFrom[i] as number, text });
    narration.push(w.result(text));
  });
  for (const view of template.effects.views.filter((v) => v.args.some(readsSafe))) {
    for (const { value } of view.changes.filter((c) => c.change === 'increases')) {
      const label = viewLabel(view, context);
      const text = w.increases(label, paramName(view.returns[value] as AbiParam, value));
      arrows.push({ kind: 'gets', from: at(label), text });
      narration.push(w.result(text));
    }
  }
  return { lifelines: lines, arrows, narration: w.sentences(narration), traced: arrows.some((arrow) => arrow.kind === 'inside' && arrow.seen !== undefined && arrow.seen.state !== 'partial') };
}

const zeroValue = (call: TemplateCall): boolean => call.value.kind === 'const' && call.value.value.kind === 'uint' && call.value.value.value === 0n;

function sends(call: TemplateCall, context: Context, n: number): Inline | undefined {
  if (zeroValue(call)) return undefined;
  const { words } = leafWords({ key: `${n}.value`, name: 'value', param: undefined, rule: call.value, children: [] }, context);
  return context.w.sends(words);
}

function afterRows(context: Context): AfterRow[] {
  const { template, w } = context;
  const field = (name: string): By => byWord(template, name, w);
  const amountOf = (effect: Template['effects']['gives'][number], gives: boolean): Inline => {
    if (effect.amount.kind === 'all') return [w.all];
    if (effect.amount.kind === 'positive') return [gives ? w.givesMore : w.getsMore];
    if (effect.amount.kind === 'any') return [w.getsAny];
    if (effect.amount.kind === 'at-least') return [w.atLeastTyped(field(effect.amount.field))];
    if (effect.amount.kind === 'at-most') return [w.atMostTyped(field(effect.amount.field))];
    return [w.typed(field(effect.amount.field))];
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
    mix: [],
    value: valueOf(node, context),
    words,
    qualifier,
    more: moreOf(rule, context.w),
    id: undefined,
    ai: undefined,
    parts: [],
    doc: undefined,
    fixed: who?.who === 'fixed',
  };
}

const noDataRow = (key: string, w: Words): ArgRow => ({
  key,
  name: 'data',
  chips: [{ who: 'fixed', label: w.who.fixed }],
  mix: [],
  value: '0x',
  words: [w.noData],
  qualifier: undefined,
  more: undefined,
  id: undefined,
  ai: undefined,
  parts: [],
  doc: undefined,
  fixed: true,
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

/** The who-decides legend for the words the rows use: a free field's line by each claim the template makes. */
function keyGroups(used: ReadonlySet<Who>, context: Context): KeyGroup[] {
  const { template, w } = context;
  const item = (who: Who, means: string): KeyItem[] => (used.has(who) ? [{ who, label: w.who[who], means }] : []);
  const { rules, member } = freeRules(template);
  const claims = (['scalar', 'route', 'proof', 'unread'] as const).filter((claim) => rules.some((rule) => rule.claim === claim));
  const amounts = new Set([...template.card.values()].flatMap((field) => (field.kind === 'amount' ? [sourceOfAmount(field).kind] : [])));
  const computed = (['computed', 'floor'] as const).filter((kind) => amounts.has(kind)).map((kind) => w.whoMeans[kind]);
  const free = claims.map((claim) => {
    const tests = TESTED_CLAIMS.has(claim) ? rules.filter((rule) => rule.claim === claim).map((rule) => freeTest(rule, context)) : [];
    if (tests.includes('not-tested')) return tests.every((test) => test === 'not-tested') ? w.freeKeyNotTested : w.freeKeySomeNotTested;
    return tests.length > 0 && tests.every((test) => test === 'all-failed') ? w.freeKeyAllFailed : w.freeKey[claim];
  });
  return [
    { title: w.whoGroup.you, items: [...item('you-type', w.whoMeans['you-type']), ...item('you-pick', w.whoMeans['you-pick'])] },
    { title: w.whoGroup.program, items: [...computed.flatMap((means) => item('computed', means)), ...item('fixed', w.whoMeans.fixed)] },
    { title: w.whoGroup.app, items: [...[...new Set(free)].flatMap((means) => item('free', means)), ...(member ? item('free', w.whoMeans.member) : []), ...item('bounded', w.whoMeans.bounded)] },
  ].filter((group) => group.items.length > 0);
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
  const used = new Set([...rows([...safeTx, ...calls.flatMap((call) => call.args)]).flatMap((row) => [...row.chips, ...row.mix].map((c) => c.who)), ...sent]);
  return {
    anchor: anchor('flow'),
    label: w.flow,
    count: { kind: 'text', text: w.calls(template.calls.length) },
    body: {
      kind: 'flow',
      flow: { diagram: sequence(context), key: keyGroups(used, context), safeTx, calls, after: afterRows(context) },
    },
  };
}

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

/** The card's vault in a per-vault report, from its stored `pnpm instance-evidence` output alone. */
function vaultSection(context: Context): Section[] {
  const { subject } = context.inputs;
  if (subject.vault === undefined) return [];
  const { w } = context;
  const vault = subject.vault;
  const text = context.inputs.vaults.get(vault.name);
  const section = (block: VaultBlock): Section[] => [{ anchor: anchor(`vault-${vault.name}`), label: w.vault, count: undefined, body: { kind: 'vault', vault: block } }];
  const command = { code: 'pnpm instance-evidence' };
  const lead: Inline = w.vaultLead(link(vault), command);
  const about = context.notes.context.map((c) => ({ title: research(c.title), note: research(c.text, c.sources) }));
  if (text === undefined) return section({ lead: w.vaultNone(link(vault), command), rows: [], bars: [], most: undefined, context: about });
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
  return section({ lead, rows, bars, most: most === undefined ? undefined : amount(most), context: about });
}

const findingWords = (result: Result, w: Words): { readonly title: string; readonly why: string } =>
  (w.finding as Readonly<Partial<Record<FindingKind, { readonly title: string; readonly why: string }>>>)[result.finding.kind] ?? { title: w.needsReview, why: '' };

/** AI text as its first sentence, shown open, and the rest, folded; the sources go with the rest, or with the sentence when it is all of the text. */
function splitFirst(text: string, sources: readonly HttpsUrl[] = []): { readonly conclusion: AiText; readonly rest: AiText | undefined } {
  const first = firstSentence(text);
  const rest = text.slice(first.length).trim();
  return rest === '' ? { conclusion: research(first, sources), rest: undefined } : { conclusion: research(first), rest: research(rest, sources) };
}

/** The text up to its first sentence end outside a code span, or all of it. */
function firstSentence(text: string): string {
  let at = 0;
  for (const [i, part] of text.split('`').entries()) {
    const end = i % 2 === 0 ? /[.!?](?=\s)|[。！？]/.exec(part) : null;
    if (end !== null) return text.slice(0, at + end.index + 1);
    at += part.length + 1;
  }
  return text;
}

/** One side of a past payment: whoever sent that transaction, or the full address with its registry name. */
function partyWords(party: Payment['from'], context: Judged): string {
  if (party === 'safe') return context.w.money.sender;
  const name = context.registry.byAddress.get(party)?.name;
  return name === undefined ? checksumAddress(party) : `${name} ${checksumAddress(party)}`;
}

/**
 * A trace result's title: who paid whom in how many past transactions, and that the template does not describe it. It
 * never says what the signer's own Safe pays, since a past sender may have moved the tokens the other way.
 */
function moneyTitle({ kind, to, pays, sides, call, transactions }: Uncovered, context: Judged): string {
  const { w } = context;
  const token = to === 'other' ? w.kind.token : to;
  const side = (parties: readonly Payment['from'][]): string => {
    const distinct = [...new Set(parties)];
    return distinct.length === 1 ? partyWords(distinct[0] as Payment['from'], context) : w.money.several(distinct.length, w.money.addresses);
  };
  const past = (said: string): string => `${w.money.inPast(transactions)}${said}${w.money.notDescribed}`;
  const said = (['out', 'in', 'between', 'unread'] as const).flatMap((s) => {
    const n = sides[s];
    if (n === undefined) return [];
    const inSome = n === transactions ? '' : w.money.inSome(n);
    if (s === 'unread') return [`${inSome}${w.money.unread(kind, call, token)}`];
    const group = pays.filter((p) => sideOf(p) === s);
    const [from, payee] = [side(group.map((p) => p.from)), side(group.map((p) => p.to))];
    return [`${inSome}${kind === 'eth' ? w.money.eth(from, payee) : w.money[kind === 'approve' ? 'approve' : 'transfer'](from, payee, token)}`];
  });
  return past(w.money.and(said));
}

/** What a result is about beyond its row's title, which already names its kind and its entry or test transaction, and why it is shown. */
function reviewSubject(result: Result, context: Judged): { readonly subject: Inline | undefined; readonly why: Inline } {
  const { w } = context;
  const words = findingWords(result, w);
  if (result.about.kind === 'fixture') {
    const detail = result.finding.kind === 'judged-otherwise' ? ` ${result.finding.detail}` : '';
    return { subject: undefined, why: [`${words.why}${detail}`] };
  }
  if (result.about.kind === 'flow') {
    const tally = context.comparison.lines[result.about.line - 1];
    const byToken = tally === undefined ? [] : fieldWords(tally, context);
    const counted = result.finding.kind === 'line-not-every' ? ` ${w.seenIn(result.finding.seen, result.finding.of)}${byToken.length === 0 ? '' : ` ${w.sentences(byToken.map(w.sentence))}`}` : '';
    return { subject: [w.flowLine(result.about.line)], why: [`${words.why}${counted}`] };
  }
  if (result.about.kind === 'money') {
    const { call, pays, others } = result.about.uncovered;
    const pairs = pays.length < 2 ? '' : ` ${w.money.parties(pays.slice(0, 5).map((p) => `${partyWords(p.from, context)} → ${partyWords(p.to, context)}`), pays.length)}`;
    const outside = others.length === 0 ? '' : ` ${w.outsideRegistry(others.slice(0, 5).map(checksumAddress), others.length)}`;
    return { subject: undefined, why: [`${w.money.under(call)} ${words.why}${pairs}${outside}`] };
  }
  const doc = /\/doc\.(0x[0-9a-f]{8})\.(\w+)$/.exec(result.id);
  if (doc !== null) {
    const found = context.inputs.subject.docs.find((d) => d.fn.selector === doc[1]);
    const page = found?.standard === undefined ? w.docsPage : w.standardPage(found.standard.name);
    const why = found?.standard !== undefined && result.finding.kind === 'name-not-on-page' ? w.notInStandard(found.standard.name) : words.why;
    return { subject: w.docSubject(page, { code: found?.fn.name ?? (doc[1] as string) }), why: [why] };
  }
  if (result.finding.kind === 'few-confirmations') {
    const { entry } = result.about;
    const places = result.finding.by.map(({ owner, sources }) => placeWords(entry, owner, sources, w, context.registry));
    return { subject: undefined, why: w.fewConfirmations({ mono: checksumAddress(entry.address) }, places, MIN_CONFIRMATIONS) };
  }
  const span = /\/code\.(\d+)$/.exec(result.id);
  const where = span !== null ? w.span(span[1] as string) : result.id.endsWith('/code.today') ? w.latestBlock : undefined;
  const refused =
    result.finding.kind === 'refused'
      ? w.refusedWhy(result.finding.why)
      : result.finding.kind === 'fn-not-in-abi'
        ? ` ${result.finding.signatures.join(', ')}`
        : result.finding.kind === 'label-differs'
          ? ` ${(result.others ?? []).map(checksumAddress).join(', ')}`
          : '';
  const source = result.source === undefined ? undefined : sourceWord(result.about.entry, result.source.of, w, context.registry);
  const subject = w.resultSubject(source, where);
  return { subject: subject === undefined ? undefined : [subject], why: [`${words.why}${refused}`] };
}

function titleOf(result: Result, context: Judged): string {
  const plain = result.about.kind === 'money' ? moneyTitle(result.about.uncovered, context) : findingWords(result, context.w).title;
  return `${plain.charAt(0).toUpperCase()}${plain.slice(1)}${result.about.kind === 'entry' ? ` · ${result.about.entry.name}` : result.about.kind === 'fixture' ? ` · ${result.about.name}` : ''}`;
}

function reviewSection(context: Context): Section {
  const { notes, ledger } = context;
  const graded = (grade: Grade) => forSigner(ledger).filter((r) => weightOf(r) === grade);
  const grades = ['key', 'reference'] as const;
  const rows = grades.flatMap((grade) => graded(grade).map((result): ReviewRow => {
    const review = notes.reviews.get(result.id) as Notes['reviews'] extends ReadonlyMap<string, infer R> ? R : never;
    const { subject, why } = reviewSubject(result, context);
    const { conclusion, rest } = splitFirst(review.text);
    return {
      id: result.id,
      state: stateOf(result),
      grade,
      title: titleOf(result, context),
      conclusion,
      subject,
      why,
      entry: result.about.kind === 'entry' ? entryAnchor(result.about.entry.name) : undefined,
      review: { status: review.status, rest, recommendation: research(review.recommendation) },
    };
  }));
  const judgments = notes.judgments.map((j): Judgment => ({ ...splitFirst(j.text, j.sources), recommendation: research(j.recommendation) }));
  const counts = [
    ...grades.flatMap((grade) => (graded(grade).length === 0 ? [] : [{ state: worst(graded(grade)), n: graded(grade).length, grade }])),
    ...(judgments.length === 0 ? [] : [{ state: 'ask' as const, n: judgments.length }]),
  ];
  const count: RailCount = { kind: 'states', counts: counts.length === 0 ? [{ state: 'ok', n: 0 }] : counts };
  return { anchor: anchor('review'), label: context.w.review, count, body: { kind: 'review', rows, judgments } };
}

/** The template's rule in the signer's words, for the wallet table. */
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
      return [kind === 'amount' || kind === 'nonce' || kind === 'threshold' || kind === 'percent' ? w.typed({ field: ref, computed: isComputed(context.template, rule.ref.field) }) : w.picked(ref)];
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
      return [w.atLeastTyped(byWord(context.template, rule.field, w))];
    case 'at-most':
      return [w.atMostTyped(byWord(context.template, rule.field, w))];
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

/** The `SafeTx` struct's fields, in its type string's order. */
const SAFE_TX_FIELDS = ['to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver', 'nonce'] as const;

const safeSingletons = (registry: Registry): string[] => [...registry.entries.values()].filter((entry) => entry.kind === 'singleton').map((entry) => entry.name);

function pinnedImplementation(name: string, registry: Registry): string[] {
  const implementation = registry.entries.get(name)?.code?.current.pin.implementation?.address;
  const entry = implementation === undefined ? undefined : registry.byAddress.get(implementation);
  return entry === undefined ? [] : [entry.name];
}

const flatFields = (facts: readonly FieldFact[], prefix = ''): { path: string; format: string; visible: string }[] =>
  facts.flatMap((f) => (f.kind === 'group' ? flatFields(f.fields, `${prefix}${f.path}.`) : [{ path: `${prefix}${f.path}`, format: f.format, visible: f.visible }]));
const isShown = (f: { format: string; visible: string }): boolean => f.visible !== 'never' && f.format !== 'none';

function safeTxRows(context: Context, lines: Inline[]): WalletRows {
  const { template, registry, inputs, w } = context;
  const singletons = safeSingletons(registry);
  const described = inputs.erc7730.reports
    .filter((r) => singletons.includes(r.entry.name))
    .flatMap((r) => r.descriptors.flatMap((d) => (d.kind === 'eip712' ? d.messages : [])).filter((m) => m.typeHash === SAFE_TX_TYPEHASH_HEX).map((message) => ({ entry: r.entry.name, message })));
  const first = described[0];
  if (first === undefined) return 'no-descriptor';
  const describedNames = [...new Set(described.map((d) => d.entry))];
  const without = singletons.filter((name) => !describedNames.includes(name));
  if (without.length > 0) lines.push([w.safeTxDescriptorsOf(describedNames, without)]);
  lines.push([w.throughProxy(w.safe, singletons)]);
  const one = template.calls.length === 1 ? (template.calls[0] as TemplateCall) : undefined;
  const value = (path: (typeof SAFE_TX_FIELDS)[number]): Inline => {
    switch (path) {
      case 'to':
        return one === undefined ? [w.officialMultiSendOf(OFFICIAL_MULTISEND.length), ...OFFICIAL_MULTISEND.map((d): Span => ({ mono: checksumAddress(d.address), line: true }))] : ruleWords(one.to, context);
      case 'value':
        return one === undefined ? [{ mono: '0' }] : ruleWords(one.value, context);
      case 'operation':
        return [one === undefined ? w.safeTxDelegate : w.safeTxCall];
      case 'data':
        return [one === undefined ? w.multisendData : one.data === 'empty' ? w.emptyData : w.innerCall];
      case 'safeTxGas':
      case 'baseGas':
      case 'gasPrice':
        return [{ mono: '0' }];
      case 'gasToken':
      case 'refundReceiver':
        return [w.zeroAddress];
      case 'nonce':
        return [w.noValue];
    }
  };
  const shown = flatFields(first.message.fields).filter(isShown);
  const hidden = SAFE_TX_FIELDS.filter((name) => !shown.some((f) => f.path === name));
  if (hidden.length > 0) lines.push(w.safeTxHides(hidden.map((h): Span => ({ code: h }))));
  if (one !== undefined) lines.push([w.safeTxWrapped]);
  const field = (path: string) => SAFE_TX_FIELDS.find((name) => name === path);
  return shown.map((f) => {
    const name = field(f.path);
    return name === undefined ? { label: [w.notAnArgument], value: [w.noValue] } : { label: [{ code: name }], value: value(name) };
  });
}

function walletSection(context: Context): Section {
  const { template, inputs, registry, w } = context;
  const lines: Inline[] = [];
  const safeTx = safeTxRows(context, lines);
  const section = (view: WalletView): Section => {
    const shown = [...new Map([...view.lines, ...(view.safeTx === 'no-descriptor' ? [] : [[w.ledgerHash]])].map((line) => [JSON.stringify(line), line])).values()];
    return { anchor: anchor('wallet'), label: w.wallet, count: undefined, body: { kind: 'wallet', view: { ...view, lines: shown } } };
  };
  if (template.calls.length > 1) return section({ kind: 'multisend', calls: template.calls.length, safeTx, lines });
  if (template.calls.every((call) => call.data === 'empty')) return section({ kind: 'no-data', safeTx, lines });
  const reports = inputs.erc7730.reports;
  const functionsOf = (name: string, selector: Hex) =>
    reports
      .filter((r) => r.entry.name === name)
      .flatMap((r) => r.descriptors.flatMap((d) => (d.kind === 'calldata' ? d.functions : [])).filter((f) => f.selector === selector).map((fn) => ({ entry: name, fn })));
  const calls = argumentTree(template).map(({ n, node, args }): WalletCall => {
    const call = template.calls[n - 1] as TemplateCall;
    const target = targetOf(call.to, context);
    const title: Inline = [`${n} ${target.label}.${node.fn.name}`];
    const proxies: { readonly name: string; readonly implementations: readonly string[] }[] = [];
    const described = target.names.flatMap((name) => {
      const own = functionsOf(name, node.fn.selector);
      if (own.length > 0) return own;
      const implementations = name === 'safe' ? safeSingletons(registry) : pinnedImplementation(name, registry);
      const through = implementations.flatMap((implementation) => functionsOf(implementation, node.fn.selector)).map((d) => ({ ...d, entry: name }));
      if (through.length > 0) proxies.push({ name, implementations });
      return through;
    });
    const first = described[0];
    if (first === undefined) return { n, title, rows: 'no-descriptor' };
    for (const proxy of proxies) lines.push([w.throughProxy(proxy.name === 'safe' ? w.safe : proxy.name, proxy.implementations)]);
    const fn = first.fn;
    const describedNames = new Set(described.map((d) => d.entry));
    const without = target.names.filter((name) => !describedNames.has(name));
    if (without.length > 0) lines.push([w.descriptorsOf(n, [...describedNames], without)]);
    const shown = flatFields(fn.fields).filter(isShown);
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
  return section({ kind: 'calls', calls, safeTx, lines });
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
  const { open, folded } = addressRows(ledger, (entry) => (notes.entries?.get(entry.name)?.sources ?? []).some((s) => s.result !== 'pass'));
  return [
    {
      anchor: anchor('addresses'),
      label: w.addresses,
      count: { kind: 'text', text: `${ledger.entries.length}` },
      body: { kind: 'addresses', open: open.map(row), folded: folded.map(row) },
    },
  ];
}

const SELF_LOGGED = 'Safe';

/** A search anchor in words: a mint or burn of a vault's shares is a deposit or a withdrawal, of any other token only a mint or burn. */
function anchorWords(query: PastTxsRecording['query'], token: RegistryEntry | undefined, w: Words): string {
  const { anchor } = query;
  if (anchor === 'event') return query.event?.split('(')[0] ?? anchor;
  const vault = token?.kind === 'vault';
  if (anchor === 'mint') return vault ? w.anchor.mintVault : w.anchor.mint;
  if (anchor === 'burn') return vault ? w.anchor.burnVault : w.anchor.burn;
  return w.anchor.transfer;
}

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

/** The most past transactions linked for one group. */
const MOST_LINKS = 3;
const txLinks = (of: readonly Studied[]): Span[] => of.slice(0, MOST_LINKS).flatMap((s, i) => [...(i === 0 ? [] : [' ']), txLink(s.hash)]);

const txLink = (hash: Hex): Span => ({ href: parseHttpsUrl(`https://etherscan.io/tx/${hash}`) as HttpsUrl, label: `${hash.slice(0, 10)}…` });

function safeParties(search: PastTxs['search']): SafeParties | undefined {
  const chosen = search.kind === 'newest-first' ? search.safesFirst : search.year?.kind === 'covered' ? search.year.safesFirst : undefined;
  if (chosen?.check.kind !== 'checked') return undefined;
  return { found: chosen.selection.safes, studied: chosen.selection.safesChosen };
}

/** The range a newest-first search read, as the report states it; nothing for a legacy windows search. */
function searchSpan(search: PastTxs['search']): SearchSpan | undefined {
  if (search.kind !== 'newest-first') return undefined;
  const { kind, range, pages, time } = search.coverage;
  return { kind, from: range.fromBlock, to: range.toBlock, time, cap: pages };
}

/** When a transaction ran: its block's date, or its block's number when the recording does not hold the date. */
const ranAt = (s: Studied, w: Words): string =>
  s.time !== undefined ? dateOf(s.time) : s.block !== undefined ? w.atBlockNumber(s.block) : w.dateUnknown;

const isNumber = (value: string): boolean => /^-?\d+$/.test(value);

/** A number with its thousands grouped, or by name when it is the largest a wide unsigned type holds. */
function numberText(n: bigint): string {
  const bits = n > 0n ? n.toString(2) : '';
  return bits.length >= 96 && bits.length % 8 === 0 && !bits.includes('0') ? `uint${bits.length} max (2^${bits.length} - 1)` : grouped(n);
}

/** A past value in a table: a number in full, anything else as it is. */
const shownValue = (value: string): Span => (isNumber(value) ? { num: numberText(BigInt(value)) } : { mono: value });
const grouped = (n: bigint): string => groupedTokens(n, 0);

/** The fewest values whose 99th percentile says more than their largest. */
const PERCENTILE_VALUES = 100;

function spreadTable(rows: readonly SpreadRow[], time: boolean, w: Words): PastTable {
  const { pastHead } = w;
  const most = rows.some((row) => (row.spread?.count ?? 0) >= PERCENTILE_VALUES);
  const shown = (n: bigint | undefined, row: SpreadRow, at: 'up' | 'down' = 'up'): Inline => [n !== undefined ? { num: time ? w.duration(n, at) : numberText(n) } : row.unrecorded > 0 ? w.pastNotRecorded : w.pastNone];
  return {
    head: [
      { label: pastHead.transactions, as: 'wide' },
      { label: pastHead.count, as: 'num' },
      { label: time ? pastHead.shortest : pastHead.smallest, as: 'value' },
      { label: pastHead.half, as: 'value' },
      ...(most ? [{ label: pastHead.most, as: 'value' as const }] : []),
      { label: time ? pastHead.longest : pastHead.largest, as: 'value' },
    ],
    rows: rows.map((row) => {
      const { group, spread, unrecorded } = row;
      return [
        [w.pastGroup[group]],
        [{ num: `${spread?.count ?? unrecorded}` }],
        shown(spread?.min, row, 'down'),
        shown(spread?.percentiles[0], row),
        ...(most ? [(spread?.count ?? 0) >= PERCENTILE_VALUES ? shown(spread?.percentiles[2], row) : []] : []),
        shown(spread?.max, row),
      ];
    }),
  };
}

function pastNumbers({ name, key, past }: PastField, w: Words): PastNumbers {
  const base = { name, limit: undefined, notes: [], exact: undefined, says: undefined };
  switch (past.kind) {
    case 'time': {
      const path: Span = { code: key.slice(key.indexOf('.') + 1) };
      const exact = past.rows.flatMap(({ group, spread }) => (spread === undefined ? [] : [`${w.pastGroup[group]}: ${[spread.min, spread.percentiles[0] as bigint, spread.max].join(' / ')}`]));
      return {
        ...base,
        lead: w.pastTimeLead,
        table: spreadTable(past.rows, true, w),
        limit: past.limit === undefined ? undefined : w.pastLimit(past.limit),
        notes: past.rows.flatMap(({ group, spread, unrecorded }) => (spread === undefined || unrecorded === 0 ? [] : [w.pastUnrecorded(w.pastGroup[group], unrecorded)])),
        exact: exact.length === 0 ? undefined : [...w.pastExactTime(path), exact.join('; ')],
      };
    }
    case 'numbers':
      return { ...base, lead: w.pastNumberLead, table: spreadTable(past.rows, false, w) };
    case 'values':
      if (past.values.length === 0) return { ...base, lead: w.pastValueLead, table: undefined, says: [w.pastNoNumberValues] };
      return {
        ...base,
        lead: w.pastValueLead,
        table: {
          head: [{ label: w.pastHead.value, as: 'wide' }, ...past.groups.map((group) => ({ label: w.pastGroup[group], as: 'num' as const }))],
          rows: past.values.map((v) => [[shownValue(v.value)], ...past.groups.map((group): Inline => [{ num: `${v.counts[group]}` }])]),
        },
      };
    case 'distinct':
      return {
        ...base,
        lead: w.pastValueLead,
        table: {
          head: [
            { label: w.pastHead.transactions, as: 'wide' },
            { label: w.pastHead.count, as: 'num' },
            { label: w.pastHead.distinct, as: 'num' },
            { label: w.pastHead.commonest, as: 'wide' },
          ],
          rows: past.rows.map(({ group, count, distinct, most }) => [[w.pastGroup[group]], [{ num: `${count}` }], [{ num: `${distinct}` }], w.pastMost(cutValue(most.value), most.times)]),
        },
      };
  }
}

/** A misfit's place as the signer reads it, without the call it sits in. */
const placeOf = (at: string): string => at.replace(/^(call|multiSend\[\d+\])\./, '');

/** Hex that reads as a short word, such as a string argument's. */
const WORD = /^0x((?:2d|5f|3[0-9]|[46][1-9a-f]|[57][0-9a])+)$/;

/** A value in a difference: a number in full, hex or text too long for a table's cell cut with its length, and a short word as text beside its hex. */
const cutValue = (value: string): Span => {
  if (isNumber(value)) return { mono: numberText(BigInt(value)) };
  const text = value.length <= 34 ? WORD.exec(value)?.[1] : undefined;
  if (text !== undefined && text.length >= 6) return { mono: `"${Buffer.from(text, 'hex').toString('latin1')}" (${value})` };
  if (value.length <= 66) return { mono: value };
  return { mono: /^0x(?:[0-9a-f]{2})*$/i.test(value) ? `${value.slice(0, 18)}…(${(value.length - 2) / 2} bytes)` : `${value.slice(0, 60)}…` };
};

/** What the past transactions of one group did differently, in the signer's words. */
function differenceWords({ reason }: PastDifference, context: Context, sequence: (calls: readonly PastCall[]) => Span): Inline {
  const { w, registry } = context;
  switch (reason.kind) {
    case 'outside':
      return w.sameShapeBut(reason.outside.map((o) => [{ code: placeOf(o.at) }, w.outsideKind[o.kind]] as const));
    case 'batch':
      return [w.pastBatch(reason.over)];
    case 'missing':
      return w.pastCallsMissing({ code: w.list(reason.missing) }, sequence(reason.calls));
    case 'calls':
      return reason.how === 'extra' ? w.pastCallsExtra(sequence(reason.calls)) : w.pastCallsOther(sequence(reason.calls));
    case 'values': {
      const { reason: misfit, different } = reason;
      const at: Span = { code: placeOf(misfit.at) };
      if (misfit.kind === 'field' && misfit.at.endsWith('.encoding')) return w.pastEncoding({ code: misfit.expected.replace(/^canonical /, '') });
      if (misfit.kind === 'field') return different === 1 ? w.misfit.field(at, cutValue(misfit.expected), cutValue(misfit.actual)) : w.pastFieldMany(at, different, cutValue(misfit.expected));
      const allowed = w.misfit.allowed(misfit.expected);
      if (different > 1) return w.pastEntryMany(at, different, allowed);
      const name = registry.byAddress.get(misfit.actual)?.name;
      const actual: Span = name === undefined ? { mono: checksumAddress(misfit.actual) } : name;
      return misfit.at.endsWith('.to') ? w.misfit.to(actual, allowed) : w.misfit.entry(at, actual, allowed);
    }
    case 'items':
      return [...w.misfit.items({ code: placeOf(reason.at) }, reason.got, reason.expected), ...(reason.calls === undefined ? [] : [w.inCalls, sequence(reason.calls)])];
    case 'misfit':
      return misfitWords(reason.reason, w);
  }
}

function misfitWords(reason: Exclude<MisfitReason, { kind: 'calls' | 'items' | 'field' | 'entry' }>, w: Words): Inline {
  switch (reason.kind) {
    case 'not-sender':
      return w.misfit.notSender({ code: placeOf(reason.at) });
    case 'differs':
      return w.misfit.differs({ code: placeOf(reason.at) }, { code: placeOf(reason.other) });
    case 'late':
      return w.misfit.late({ code: placeOf(reason.at) }, reason.seconds);
    case 'trailer':
      return w.misfit.trailer({ code: placeOf(reason.at) });
    case 'foreign-delegatecall':
      return [w.misfit.foreignDelegatecall];
    case 'multisend-noncanonical':
      return [w.misfit.noncanonical];
    case 'other':
      return [w.misfit.other];
  }
}

/** The differences the page lists open, the commonest; the rest fold. */
const OPEN_DIFFERENCES = 8;

function differ(differences: readonly PastDifference[], context: Context, sequence: (calls: readonly PastCall[]) => Span): PastBlock['differ'] {
  const { w } = context;
  const { pastHead } = w;
  const by = (of: readonly Studied[], kind: 'safe' | 'eoa'): Inline => [{ num: `${of.filter((s) => s.sender.kind === kind).length}` }];
  const table = (list: readonly PastDifference[]): PastTable => ({
    head: [
      { label: pastHead.what, as: 'wide' },
      { label: pastHead.safe, as: 'num' },
      { label: pastHead.eoa, as: 'num' },
      { label: pastHead.newest, as: 'plain' },
      { label: pastHead.example, as: 'links' },
    ],
    rows: list.map((difference) => {
      const sorted = newestFirst(difference.studies);
      const [newest] = sorted ?? [];
      return [
        differenceWords(difference, context, sequence),
        by(difference.studies, 'safe'),
        by(difference.studies, 'eoa'),
        [newest === undefined ? w.pastNotRecorded : ranAt(newest, w)],
        txLinks(sorted ?? difference.studies),
      ];
    }),
  });
  const [open, rest] = [differences.slice(0, OPEN_DIFFERENCES), differences.slice(OPEN_DIFFERENCES)];
  const count = (list: readonly PastDifference[]): number => list.reduce((n, d) => n + d.studies.length, 0);
  return {
    lead: differences.length === 0 ? w.pastNoDiffer : w.pastDifferLead(count(differences)),
    open: open.length === 0 ? undefined : table(open),
    more: rest.length === 0 ? undefined : { label: w.pastMore(rest.length, count(rest)), table: table(rest) },
  };
}

function worked(exact: readonly Studied[], template: Template, w: Words): PastBlock['worked'] {
  const senders = (kind: 'safe' | 'eoa') => {
    const mine = exact.filter((s) => s.sender.kind === kind);
    return { times: mine.length, senders: new Set(mine.map((s) => s.sender.address)).size };
  };
  const [safe, eoa] = [senders('safe'), senders('eoa')];
  const sorted = newestFirst(exact);
  const [newest] = sorted ?? [];
  return {
    answer: safe.times === 0 ? w.pastNo : w.pastYes(safe.times, safe.senders),
    rest: [
      w.sentences([w.pastEoa(eoa.times, eoa.senders, template.calls.length === 1), ...(newest === undefined ? [] : [w.pastNewest(ranAt(newest, w))]), ...(exact.length === 0 ? [] : [w.pastSucceeded])]),
      ...(exact.length === 0 ? [] : [w.pastLinks(Math.min(exact.length, MOST_LINKS), sorted !== undefined), ...txLinks(sorted ?? exact)]),
    ],
  };
}

function pastSection(context: Context): Section {
  const { template, w } = context;
  const runs = context.inputs.pastTxs.map(({ run }) => run);
  const section = (past: PastBlock | undefined): Section => ({ anchor: anchor('past'), label: w.past, count: undefined, body: { kind: 'past', past } });
  if (runs.length === 0) return section(undefined);
  const studies = studiedOnce(runs, template);
  const exact = studies.filter(isExact);
  return section({
    worked: worked(exact, template, w),
    numbers: pastFields(studies, template, context.notes.times).map((field) => pastNumbers(field, w)),
    differ: differ(pastDifferences(studies, template), context, callNamer(context).sequence),
    conclusion: context.notes.pastTxsConclusion === undefined ? undefined : research(context.notes.pastTxsConclusion),
    amounts: pastAmounts(context),
    search: pastSearch(context, exact.length > 0),
  });
}

/** Past calls in words, by registry name and by the functions the report knows. */
function callNamer(context: Context) {
  const { registry, w } = context;
  const known = knownFunctions(context);
  const fnOf = (selector: string): string => known.get(selector) ?? selector;
  const contractOf = (to: Address): string => registry.byAddress.get(to.toLowerCase() as Address)?.name ?? checksumAddress(to);
  const callWords = ({ to, selector }: PastCall): string => {
    const contract = to === undefined ? w.otherContract : to === 'sender' ? w.senderItself : contractOf(to);
    return selector === undefined ? w.bareCall(contract, w.noDataParens) : `${contract}.${fnOf(selector)}`;
  };
  const noSelector: Readonly<Record<string, string>> = { 'no data': w.noDataParens, 'contract creation': w.creation };
  return {
    contractOf,
    sequence: (calls: readonly PastCall[]): Span => ({ code: calls.map(callWords).join(' → ') }),
    /** Another operation's call: its contract by registry name or full address, then its function. */
    other: (to: Address | undefined, selector: string | undefined): string => {
      const named = selector !== undefined && /^0x[0-9a-f]{8}$/.test(selector);
      const fn = selector === undefined ? w.noDataParens : named ? fnOf(selector) : (noSelector[selector] ?? selector);
      if (to === undefined) return fn;
      return named || (selector !== undefined && noSelector[selector] === undefined) ? `${contractOf(to)}.${fn}` : w.bareCall(contractOf(to), fn);
    },
  };
}

/** Where each recording searched, and what it found but did not count. */
function pastSearch(context: Context, succeeded: boolean): PastBlock['search'] {
  const { registry, template, w } = context;
  const { contractOf, other } = callNamer(context);
  return context.inputs.pastTxs.map(({ query, run }, i) => {
    const studied = run.studies.filter((s): s is Studied => s.kind === 'fit' || s.kind === 'misfit');
    const notCalled = run.studies.flatMap((s) => (s.kind === 'not-studied' && s.why === 'calls no function the template calls' ? [other(s.to, s.selector)] : []));
    const otherOperations = studied.flatMap((s) => (s.kind === 'misfit' && s.reason.kind === 'calls' && isOtherOperation(s, template) ? [other(s.reason.calls[0]?.to, s.reason.calls[0]?.selector)] : []));
    const elsewhere = [...notCalled, ...otherOperations];
    const tally = new Map<string, number>();
    for (const name of elsewhere) tally.set(name, (tally.get(name) ?? 0) + 1);
    const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const skipped = run.studies.length - studied.length - notCalled.length;
    const [alchemy, etherscan] = [foundBy(run.found, 'alchemy'), foundBy(run.found, 'etherscan')];
    const same = run.found.only.alchemy.length + run.found.only.etherscan.length === 0;
    const span = searchSpan(run.search);
    const token = query.token === undefined ? undefined : registry.byAddress.get(query.token.toLowerCase() as Address);
    const name = query.token === undefined ? SELF_LOGGED : contractOf(query.token as Address);
    return {
      count: w.searchCount(name, anchorWords(query, token, w), run.found.total, run.studies.length, safeParties(run.search)),
      lines: [
        [...(span === undefined ? [] : [w.searchSpan(span)]), ...(query.anchor === 'event' ? w.searchEtherscanOnly({ num: `${etherscan}` }) : w.searchSame(same, { num: `${alchemy} ${same ? '=' : '≠'} ${etherscan}` }))],
        ...(i === 0 && succeeded ? [[w.pastSucceededWhy]] : []),
        ...(elsewhere.length === 0 ? [] : [w.otherOperations(elsewhere.length, top.map(([called, n]) => [{ code: called }, n] as const), tally.size > top.length)]),
        ...(skipped === 0 ? [] : [[w.skipped(skipped)]]),
      ],
    };
  });
}

function pastAmounts(context: Context): PastAmounts[] {
  const { registry, w } = context;
  const { contractOf } = callNamer(context);
  return context.inputs.pastTxs.flatMap(({ run }): PastAmounts[] => {
    const { effects, unmeasured } = amountsOf(run, registry);
    const missed = [...unmeasured.values()].reduce((n, hashes) => n + hashes.length, 0);
    const table = (sender: readonly Difference[], receiver: readonly Difference[]): PastTable => {
      const [sent, got] = [distributionOf(sender).counts, distributionOf(receiver).counts];
      const both = receiver.length > 0;
      const amounts = [...new Set([...sent.keys(), ...got.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return {
        head: [{ label: w.amountsHead.by, as: 'wide' }, { label: w.amountsHead.sender, as: 'num' }, ...(both ? [{ label: w.amountsHead.receiver, as: 'num' as const }] : [])],
        rows: amounts.map((by) => [[w.amountsBy(by)], [{ num: `${sent.get(by) ?? 0}` }], ...(both ? [[{ num: `${got.get(by) ?? 0}` }]] : [])]),
      };
    };
    return effects.map(({ effect, tokens, finding }): PastAmounts => {
      const shown = (inRegistry: boolean): PastTokenAmounts[] =>
        tokens.filter((t) => t.inRegistry === inRegistry).map((t) => ({ lead: w.amountsToken(contractOf(t.token), t.sender.length, t.safes, t.eoas), table: table(t.sender, t.receiver) }));
      const outside = shown(false);
      return {
        effect: effectText(effect),
        tolerance: w.amountsTolerance(effect.tolerance?.less ?? 0n, effect.tolerance?.more ?? 0n),
        tokens: shown(true),
        outside: outside.length === 0 ? undefined : { label: w.amountsOutside(outside.length), tokens: outside },
        finding: finding === undefined ? undefined : finding.kind === 'beyond' ? w.amountsBeyond(finding.lower, finding.higher) : w.amountsUnfounded,
        unmeasured: missed === 0 ? undefined : w.amountsUnmeasured(missed),
      };
    });
  });
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
      const source = sourceOfAmount(field);
      switch (source.kind) {
        case 'typed':
          return step(
            [...cardNewPrompt, ...w.typeAmount(token, { code: '1250.5' }, { code: '1,000,611.448606' })],
            [[w.amountPrints], ...(field.max === undefined ? [] : [w.orMax({ code: 'max' }, `${field.max.value}`)])],
          );
        case 'floor': {
          const bps = (n: number): string => percent(BigInt(n), 10_000n, w);
          return step(
            [...cardNewPrompt, ...w.floorPrompt({ code: source.floor.sells })],
            [[w.floorHow(token, bps(FLOOR_RULE.slippageBps), bps(FLOOR_RULE.maxSlippageBps), bps(FLOOR_RULE.marginBps))], [w.floorElse(bps(FLOOR_RULE.retypeBps))]],
          );
        }
        case 'computed': {
          const { computed } = source;
          const bps = (n: number | bigint): string => percent(BigInt(n), 10_000n, w);
          const margin = computed.margin === undefined ? '' : w.margin(bps(computed.margin.bps));
          return step(
            [...cardNewPrompt, w.computedPrompt(carries(context.template, name))],
            [
              w.computedHow({ code: computed.read.fn.name }, token, computed.bound === 'floor', bps(slippageBps(computed)), bps(computed.default.bps), margin),
              w.presetSource({ href: computed.default.source, label: shortUrl(computed.default.source) }),
            ],
          );
        }
      }
    }
  }
}

/** Whether the transaction carries the card field's value, so a rule on one of its arguments binds it. */
function carries(template: Template, name: string): boolean {
  const names = (rule: Rule): boolean => {
    switch (rule.kind) {
      case 'card':
      case 'owner-before':
        return rule.ref.field === name;
      case 'at-least':
      case 'at-most':
        return rule.field === name;
      case 'share-price':
        return [rule.assets, rule.shares].some((q) => q.kind === 'card' && q.field === name);
      case 'address-word':
      case 'equals':
        return names(rule.rule);
      case 'call':
      case 'keccak':
        return rule.call.args.some(names);
      case 'items':
        return rule.items.some(names);
      case 'fields':
        return rule.fields.some(names);
      case 'packed':
        return rule.parts.some((part) => names(part.rule));
      case 'eip712':
        return rule.message.fields.some(names);
      case 'safe':
      case 'contract':
      case 'const':
      case 'free':
      case 'within-seconds':
        return false;
    }
  };
  return template.calls.some((call) => [call.to, call.value, ...(call.data === 'empty' ? [] : call.data.args)].some(names));
}

function nextSection(context: Context): Section {
  const { template, w } = context;
  const fields = [...template.card];
  const typed = (field: CardField): boolean => field.kind === 'amount' || field.kind === 'nonce' || field.kind === 'threshold' || field.kind === 'percent';
  const source = (field: CardField): AmountSource['kind'] => (field.kind === 'amount' ? sourceOfAmount(field).kind : 'typed');
  const vault = context.inputs.subject.vault !== undefined;
  const trial = fields.some(([, f]) => f.kind === 'amount' && sourceOfAmount(f).kind === 'typed') ? w.trial(vault) : '';
  const prompts = [
    ...fields.filter(([, f]) => !typed(f)),
    ...(['typed', 'floor', 'computed'] as const).flatMap((kind) => fields.filter(([, f]) => typed(f) && source(f) === kind)),
  ].map(([name, field]) => promptStep(name, field, context));
  const y: Span = { code: 'y' };
  const book = (say: string, recipient: boolean): NextStep => ({
    say: [say],
    command: 'pnpm kiss-sign book add <name> <address>',
    then: [w.bookThen({ code: 'Add this entry? [y/N]' }, y, recipient)],
    hashes: false,
  });
  const steps: NextStep[] = [
    ...(context.ledger.entries.length === 0 ? [] : [{ say: w.openSources({ href: anchor('addresses'), label: w.addresses }), command: undefined, then: [], hashes: false }]),
    { say: [w.approveSay], command: `pnpm kiss-sign template approve ${template.id}`, then: [w.approveThen(y)], hashes: false },
    ...(fields.some(([, f]) => f.kind === 'owner') ? [book(w.ownerBook, false)] : []),
    ...(fields.some(([, f]) => f.kind === 'recipient') ? [book(w.recipientBook, true)] : []),
    { say: [w.makeCard], command: `pnpm kiss-sign card new ${template.id}`, then: [w.cardNewStops({ code: 'templates/' }, { code: 'registry/' }, { code: 'git pull' })], hashes: false },
    ...prompts,
    { say: w.sealSay({ code: 'Is this what you mean to do? [y/N]' }, y), command: undefined, then: [w.sealThen({ code: 'Sealed card 0x…' })], hashes: false },
    {
      say: [w.propose(trial)],
      command: 'pnpm kiss-sign verify --card <card hash> --safe-tx-hash <safeTxHash>',
      then: [w.onMatch({ code: 'MATCH' }), w.onMismatch({ code: 'MISMATCH' }, { code: 'UNVERIFIABLE' }, { href: anchor('review'), label: w.review })],
      hashes: false,
    },
    { say: [w.hardened], command: './check.sh <nonce>', then: [w.hardenedThen({ code: 'verify' })], hashes: false },
    { say: w.compareHashes({ code: 'verify' }), command: undefined, then: [[w.ledgerHash]], hashes: true },
  ];
  const tokenName = (token: EffectToken) => effectTokenName(token, context);
  const field = (name: string): By => byWord(template, name, w);
  const automatic: Inline[] = [
    [w.onlyCalls(template.calls.length)],
    [w.everyArgument],
    ...template.effects.gives.map((e): Inline => [
      w.gives(tokenName(e.token), e.amount.kind === 'card' || e.amount.kind === 'at-most' ? { kind: e.amount.kind, by: field(e.amount.field) } : { kind: e.amount.kind === 'all' ? 'all' : 'positive' }),
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
function freeRules(template: Template): { readonly rules: readonly Extract<Rule, { kind: 'free' }>[]; readonly member: boolean } {
  const found: Extract<Rule, { kind: 'free' }>[] = [];
  const members = new Set<Rule>();
  const collect = (rule: Rule): void => {
    if (rule.kind === 'eip712') rule.message.fields.forEach((field) => members.add(field));
    if (rule.kind === 'packed') rule.parts.forEach((part) => collect(part.rule));
    if (rule.kind === 'call') rule.call.args.forEach(collect);
    if (rule.kind === 'items') rule.items.forEach(collect);
    if (rule.kind === 'fields') rule.fields.forEach(collect);
  };
  const visit = (rule: Rule): void => {
    if (rule.kind === 'free' && !members.has(rule)) found.push(rule);
    if (rule.kind === 'equals') visit(rule.rule);
    if (rule.kind === 'packed') rule.parts.forEach((part) => visit(part.rule));
    if (rule.kind === 'call') rule.call.args.forEach(visit);
    if (rule.kind === 'items') rule.items.forEach(visit);
    if (rule.kind === 'fields') rule.fields.forEach(visit);
  };
  const calls = template.calls.flatMap((call) => [call.to, call.value, ...(call.data === 'empty' ? [] : call.data.args)]);
  calls.forEach(collect);
  calls.forEach(visit);
  return { rules: found, member: [...members].some((rule) => rule.kind === 'free') };
}

/** The parameter checks line when no test transaction is recorded, from the template. */
const unrecordedParams = (template: Template, w: Words): string => (freeRules(template).rules.length > 0 ? w.unrecorded : w.allBound(freeRules(template).member));

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
  const untested = ledger.results.filter((r) => r.finding.kind === 'line-token-untested').length;
  const explain: Readonly<Record<StripLine, (passed: number, counted: number) => string>> = {
    sources: (p, c) => (p === c ? w.sourcesOk(c, MIN_CONFIRMATIONS) : w.sourcesSome(c - p, p, MIN_CONFIRMATIONS)),
    abi: () => w.abiExplain(notCalled, unprovable),
    code: () => w.codeExplain(subjects === 1, reportOnly, today, routed),
    params: (_, c) => (!recorded ? unrecordedParams(template, w) : w.paramsExplain(c)),
    trace: (p, c) => w.traceExplain(p, c, untested),
  };
  const items = strip(ledger)
    .filter((s) => s.line === 'params' || ledger.results.some((r) => r.line === s.line))
    .map(
    (s): StripItem => ({ line: s.line, name: w.strip[s.line], state: s.state, count: s.line === 'params' && !recorded ? w.noTests : s.counted === 0 ? undefined : `${s.passed} / ${s.counted}`, explain: explain[s.line](s.passed, s.counted) }),
  );
  return [...items, { line: 'providers', name: w.strip.providers, state: 'ok', count: undefined, explain: w.providersExplain }];
}

/** Each transaction whose trace counts, once, though two recordings of the template may both hold it. */
const tracedOnce = (traces: readonly TracedTx[]): Extract<TracedTx, { kind: 'traced' }>[] => [
  ...new Map(traces.flatMap((t) => (t.kind === 'traced' ? [[t.hash, t] as const] : []))).values(),
];

const usageBlock = (usage: Usage | undefined, w: Words): UsageBlock =>
  usage === undefined
    ? { lead: w.usageUnmeasured, table: undefined, notes: [] }
    : {
        lead: w.usageCalls(usage.models.map(modelName).join(' + '), usage.calls, usage.minutes),
        table: {
          head: [w.usageItem, w.usageTokens],
          rows: [
            [w.usageReread, formatMillions(usage.cacheRead)],
            [w.usageFresh, formatMillions(usage.input + usage.cacheWrite)],
            [w.usageOutput, formatMillions(usage.output)],
          ],
          total: [w.usageTotal, formatMillions(totalTokens(usage))],
        },
        notes: [...(usage.kind === 'past-txs-rerun' ? [w.usagePartial] : []), w.usageSource],
      };

const usageSection = (usage: Usage | undefined, w: Words): Section => ({ anchor: anchor('usage'), label: w.usage, count: undefined, body: { kind: 'usage', usage: usageBlock(usage, w) } });

/** The report's results, those of the notes' `flow` lines against the call traces included; with no notes, no line. */
function withFlow(inputs: HtmlInputs, language: Language, rawNotes: unknown): Pick<Context, 'ledger' | 'comparison'> {
  const { registry } = inputs;
  const { template } = inputs.subject;
  const judged = judge(inputs, inputs.fixtures);
  const flow = rawNotes === undefined ? [] : parseFlowLines(rawNotes, notesScope(inputs, judged, template, language));
  const shapes = shapesOf(template);
  const comparison = compareFlow(
    template,
    registry,
    flow.map((line) => ({ after: line.after, from: line.from, to: line.to, selector: line.function.selector as Hex })),
    tracedOnce(inputs.pastTxs.flatMap(({ run }) => run.traces)),
    new Map(inputs.pastTxs.flatMap(({ run }) => run.studies).flatMap((study) => (study.kind === 'fit' ? [[study.hash, cardAddresses(study, shapes)] as const] : []))),
  );
  return { comparison, ledger: { ...judged, results: [...judged.results, ...flowResults(comparison)] } };
}

export type ToReview = { readonly id: ResultId; readonly state: State; readonly title: string; readonly why: string };

/** Each result the notes must review and the report's ledger, with or without any notes yet, in the page's own words. */
export function toReview(inputs: HtmlInputs, language: Language, rawNotes: unknown): { readonly ledger: Ledger; readonly rows: readonly ToReview[] } {
  const w = WORDS[language];
  const { ledger, comparison } = withFlow(inputs, language, rawNotes);
  const context: Judged = { w, language, inputs, template: inputs.subject.template, registry: inputs.registry, facts: inputs.facts, ledger, comparison };
  const words = (spans: Inline) => spans.map((s) => (typeof s === 'string' ? s : 'code' in s ? s.code : 'mono' in s ? s.mono : 'num' in s ? s.num : s.label)).join('');
  const rows = forSigner(ledger).map((result): ToReview => {
    const { subject, why } = reviewSubject(result, context);
    return { id: result.id, state: stateOf(result), title: titleOf(result, context), why: [...(subject === undefined ? [] : [words(subject)]), words(why)].join(': ') };
  });
  return { ledger, rows };
}

/**
 * The signer's page in `language`, from the report's inputs and the raw notes.json. The ledger judges every result;
 * notes.json is parsed against the scope the template and the ledger derive, so it cannot name what the page does not
 * show nor leave out a review the page needs. Throws NotesError for notes the program refuses.
 */
export function buildPage(inputs: HtmlInputs, rawNotes: unknown, title: ReportTitle, language: Language): Page {
  const { subject, registry } = inputs;
  const { template } = subject;
  const { ledger, comparison } = withFlow(inputs, language, rawNotes);
  const notes = parseNotes(rawNotes, notesScope(inputs, ledger, template, language));
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
    comparison,
  };
  const sections = [reviewSection(context), flowSection(context), ...protocolSections(context), ...vaultSection(context), walletSection(context), ...addressSection(context), pastSection(context), nextSection(context), usageSection(inputs.usage, w)];
  const sources = [...title.sources, 'testdata/perturb', 'testdata/safe-tx', join(TEMPLATES_DIR, template.id, NOTES_FILE), ...(subject.vault === undefined ? [] : [join(subject.dir, NOTES_FILE)]), ...(inputs.usage === undefined ? [] : [usagePath({ template: template.id, instance: subject.vault?.name })])];
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
    footer: w.footer({ code: title.command }, sources.map((s): Span => ({ code: s })), inputs.fetched, { code: 'pnpm test' }, NOTES_FILE, inputs.usage !== undefined),
  };
}
