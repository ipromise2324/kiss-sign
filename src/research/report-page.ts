import { hexToBytes } from '@noble/hashes/utils.js';
import { resolveRef } from '../card.ts';
import type { ResolvedCard, ResolvedValue } from '../card.ts';
import { wholeTokens } from '../chain/decimals.ts';
import { castValue } from '../decode/cast.ts';
import type { AbiParam } from '../decode/abi.ts';
import { namedSignatureOfAbiEntry, paramName, parseFunctionSignature } from '../decode/abi.ts';
import type { AbiValue } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import { MARKET_PARAMS, parseHttpsUrl } from '../registry.ts';
import type { HttpsUrl, Market, Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { decodeTemplateCall } from '../template/check.ts';
import type { FixtureJudgement } from '../template/perturb.ts';
import { refNames, slippageBps } from '../template/template.ts';
import type { CardField, CardRef, ConstValue, FreeClaim, Rule, Template, TemplateCall, TokenRef } from '../template/template.ts';
import type { FieldFact } from './erc7730.ts';
import { MIN_CONFIRMATIONS, addressRows, confidence, confirmations, docOf, forSigner, judge, needsSigner, sourcesOf, stateOf, strip, worst } from './ledger.ts';
import type { Confidence, FindingKind, Ledger, ProgramSource, Result, ResultId, State, StripLine } from './ledger.ts';
import { NOTES_FILE, argumentTree, notesPath, notesScope, parseNotes } from './notes.ts';
import type { ArgNode, Notes } from './notes.ts';
import { factsScope } from './protocol-facts.ts';
import { functionNames, isOtherOperation, misfitText } from './study.ts';
import type { CallName, MisfitReason, OutsideKind, Sender, TxStudy } from './study.ts';
import { readStoredEvidence } from './vault-evidence.ts';
import type { StoredPoint } from './vault-evidence.ts';
import type { ProtocolFacts, ProtocolSheet } from './protocol-facts.ts';
import type { ReportInputs, ReportTitle } from './report.ts';

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

/** AI text. Never an Inline, so the renderer prints it only through the one function that adds the dashed tag. */
export type AiText = { readonly ai: string; readonly sources: readonly HttpsUrl[]; readonly tag: string };

const research = (text: string, sources: readonly HttpsUrl[] = [], tag = 'AI 研究'): AiText => ({ ai: text, sources, tag });

export type RailCount = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'states'; readonly counts: readonly { readonly state: State | 'ask'; readonly n: number }[] };

export type Page = {
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
  | { readonly kind: 'past'; readonly same: Inline; readonly conclusion: AiText | undefined; readonly recordings: readonly PastRecording[] }
  | { readonly kind: 'next'; readonly steps: readonly NextStep[]; readonly automatic: readonly Inline[] };

export type NextStep = { readonly say: Inline; readonly command: string | undefined; readonly then: readonly Inline[]; readonly hashes: boolean };

export type Header = {
  readonly title: AiText;
  readonly summary: AiText;
  readonly strip: readonly StripItem[];
  /** The program's worst state over every result, never the AI's status, beside the AI's one line. */
  readonly verdict: { readonly state: State; readonly text: AiText };
};

export type StripItem = { readonly line: StripLine | 'providers'; readonly name: string; readonly state: State; readonly count: string | undefined; readonly explain: string };

export type Who = 'you-type' | 'you-pick' | 'fixed' | 'free';
export type KeyItem = { readonly who: Who; readonly label: string; readonly means: string };
export type Chip = { readonly who: Who; readonly label: string };

export type ArgRow = {
  readonly key: string;
  readonly name: string;
  readonly chips: readonly Chip[];
  /** As `cast decode-calldata` prints it; `example` tags a value from the first recorded test transaction, naming its Safe as another Safe. */
  readonly value: { readonly cast: string; readonly example: '例' | '例：別的 Safe' | undefined } | undefined;
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

export type AfterRow = { readonly label: Inline; readonly value: Inline; readonly note: Inline; readonly gains: boolean };

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
export type RowResult = { readonly state: State; readonly phrase: string | undefined };
/** A page's or the API's site, compared with what DefiLlama lists for the entry's protocol `slug`. */
export type SiteResult = RowResult & { readonly slug: string | undefined; readonly href: HttpsUrl | undefined };
/** A program source: whether it showed the address, and for a page or the API its site, a second result. */
export type SourceLine = RowResult & { readonly label: string; readonly href: HttpsUrl | undefined; readonly site: SiteResult | undefined };
/** A function's documentation page from docs.json, linked, with the worst of its results; a standard's page carries its caveat. */
export type DocLine = RowResult & { readonly label: string; readonly href: HttpsUrl; readonly note: string | undefined };
/** A source the AI checked by hand: its text and link, and its result in words, which is no program result. */
export type AiSource = { readonly text: AiText; readonly result: 'AI 判斷：沒問題' | 'AI 判斷：要注意' | 'AI 判斷：有問題' };

export type AddressRow = {
  readonly anchor: Anchor;
  readonly name: string;
  readonly state: State;
  readonly role: AiText | undefined;
  readonly confidence: Confidence;
  readonly reviewed: 'AI 已確認' | 'AI 有疑慮' | undefined;
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
export type PastRecording = { readonly file: string; readonly count: string; readonly search: Inline; readonly blocks: readonly PastBlock[]; readonly others: readonly Inline[] };

/** Everything the HTML report reads beyond the Markdown report's inputs. */
export type HtmlInputs = ReportInputs & {
  readonly fixtures: readonly FixtureJudgement[];
  /** The first recorded test transaction of the template, with its card. */
  readonly example: { readonly name: string; readonly tx: SafeTx; readonly card: ResolvedCard } | undefined;
};

const STRIP_NAMES: Readonly<Record<StripLine | 'providers', string>> = { sources: '地址來源', abi: '原始碼驗證', code: '合約沒被換掉', params: '參數保護', providers: '雙節點比對' };
const CONFIDENCE_WORDS: Readonly<Record<Confidence, string>> = { high: '高信心', medium: '中信心', low: '低信心' };
const KIND_WORDS: Readonly<Record<RegistryEntry['kind'], string>> = {
  token: '代幣',
  vault: '金庫',
  router: '路由合約',
  multisend: 'MultiSend',
  adapter: '轉接合約',
  factory: '工廠合約',
  distributor: '發放合約',
  bridge: '跨鏈橋',
  lending: '借貸合約',
  oracle: '價格來源',
  irm: '利率模型',
};
const PART_WORDS: Readonly<Record<string, string>> = { asset: '資產', factory: '工廠', loanToken: '借出代幣', collateralToken: '抵押代幣', oracle: 'oracle', irm: '利率模型', lltv: 'LLTV' };

/** A card field's word from its kind; a typed amount by what it counts: 股份數 for a vault's own shares, 金額 for an asset or ETH. */
function kindWord(field: CardField, template: Template): string {
  switch (field.kind) {
    case 'contract':
      return KIND_WORDS[field.scope.registryKind];
    case 'amount': {
      if (field.computed !== undefined) return field.computed.bound === 'floor' ? '最少收到的數量' : '最多付出的數量';
      const of = field.of === 'eth' || field.of.attribute !== undefined ? undefined : template.card.get(field.of.field);
      return of?.kind === 'contract' && of.scope.registryKind === 'vault' ? '股份數' : '金額';
    }
    case 'address':
      return '地址';
    case 'recipient':
      return '收款人';
    case 'nonce':
      return 'nonce';
    case 'market':
      return '市場';
  }
}

/** A card field in the signer's words, from its kind; with its name in brackets when another field of the template has the same word. */
function fieldWord(template: Template, name: string): string {
  const field = template.card.get(name);
  if (field === undefined) return name;
  const word = kindWord(field, template);
  return [...template.card.values()].filter((f) => kindWord(f, template) === word).length > 1 ? `${word}（${name}）` : word;
}

/** A card reference in the signer's words: the field, and the attribute or market part it names. */
const refWord = (template: Template, ref: CardRef): string =>
  ref.attribute === undefined ? fieldWord(template, ref.field) : before(`${fieldWord(template, ref.field)}的`, PART_WORDS[ref.attribute] ?? ref.attribute);

/** Chinese text before a word, with a space only when the word starts in Latin script or a digit. */
const before = (prefix: string, word: string): string => (/^[A-Za-z0-9]/.test(word) ? `${prefix} ${word}` : `${prefix}${word}`);
const FREE_WORDS: Readonly<Record<FreeClaim, string>> = {
  scalar: '換成別的值測過，結果不變或交易失敗',
  proof: '合約會驗證它，換成別的值交易就失敗',
  unread: '合約不讀它，換成別的值結果一樣',
};
const SOURCE_LABELS: Readonly<Record<Exclude<ProgramSource, 'page' | `more.${number}`>, string>> = { api: '協議 API', coingecko: 'CoinGecko', factory: '工廠' };

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
  if (doc.standard !== undefined) return { ...result, label: `${doc.standard.name} 標準頁`, note: '標準定義這個函式，不代表合約照標準做' };
  return { ...result, label: pageLabel(doc.url, docs.filter((d) => d.standard === undefined).map((d) => d.url)), note: undefined };
}

const sourceWord = (entry: RegistryEntry, source: ProgramSource): string => pageLabels(entry).get(source) ?? SOURCE_LABELS[source as keyof typeof SOURCE_LABELS];

/** What a confirmation is called in the line that counts them: the `source` page is 官方頁, any other as `sourceWord` names it. */
const confirmationWord = (entry: RegistryEntry, source: ProgramSource): string => (source === 'page' ? '官方頁' : sourceWord(entry, source));

const confirmedWords = (entry: RegistryEntry, by: readonly ProgramSource[]): string =>
  by.length === 0 ? '沒有任何地方確認' : `${by.length >= MIN_CONFIRMATIONS ? '在' : '只在'} ${by.length} 個地方確認：${by.map((source) => confirmationWord(entry, source)).join('、')}`;
const AI_RESULTS = { pass: 'AI 判斷：沒問題', attention: 'AI 判斷：要注意', fail: 'AI 判斷：有問題' } as const;

/** What the program says about a result for the signer: a title naming what disagreed or could not be read, and why. */
const FINDING_WORDS: { readonly [K in FindingKind]?: { readonly title: string; readonly why: string } } = {
  'site-differs': { title: '網站跟 DefiLlama 列的不同', why: '這個頁面的網域或 GitHub 組織，不是 DefiLlama 列給這個協議的。' },
  'other-coin': { title: '地址跟 CoinGecko 不同', why: 'CoinGecko 在這個地址列的不是登記的那個幣，或列了不只一個。' },
  'other-answer': { title: '協議 API 回的是別的地址', why: '協議 API 在登記的路徑回了另一個地址、沒有地址，或不是 JSON。' },
  'pin-not-run': { title: '鏈上跑的不是登記的程式碼', why: '鏈上在這段區塊範圍跑的程式碼，跟 code pin 記錄的不一樣。' },
  'proof-not-pin': { title: '證明的程式碼不是現在登記的', why: 'ABI 證明用的程式碼，不是 code pin 現在的那一份。' },
  'not-created': { title: '工廠說這個金庫不是它建的', why: '登記的工廠合約回答，這個地址不是它建立的金庫，所以它不屬於工廠的協議。' },
  'factory-other-answer': { title: '工廠的回答看不懂', why: '問登記的工廠是否建立了這個金庫，它沒有回答 true、false 或一個地址（例如 revert），所以不能說這個金庫屬於工廠的協議。' },
  refused: { title: 'ABI 證明被拒絕', why: '重新編譯 Sourcify 的原始碼，得不到鏈上的程式碼。' },
  'judged-otherwise': { title: '測試交易現在的判定不同', why: '用現在的模板重跑記錄的測試交易，結果跟記錄時不一樣。' },
  'no-answer': { title: '讀取沒有回應', why: '程式重試後仍讀不到答案，記為 UNVERIFIABLE。' },
  'site-not-compared': { title: '沒辦法比對來源網站', why: 'DefiLlama 找不到這個協議，或網域無法判斷。' },
  'no-second-source': { title: '沒有第二個來源', why: 'DefiLlama 沒有列這個協議的網站或 GitHub 組織，CoinGecko 也沒有在這個地址列登記的幣，沒有別的來源能證明這個網站屬於這個協議。' },
  'unexplained-coin': { title: 'CoinGecko 在這個地址列了幣，登記沒有給 id', why: '登記沒有寫 coingecko id，所以程式沒有比對 CoinGecko 在這個地址列的幣是不是這個合約。' },
  'commit-unconfirmed': { title: 'GitHub commit 沒確認', why: 'GitHub 頁面沒有釘在預設分支上的 commit。' },
  'page-not-fetched': { title: '文件頁沒讀到', why: '程式沒有這個文件頁的內容。' },
  'name-not-on-page': { title: '文件頁上找不到這個函式', why: '文件頁的原始網頁裡沒有寫成程式的函式名稱：緊接著括號、放在反引號裡，或自成一行（例如標題、清單項目或表格欄）。只在一般文字裡出現不算。' },
  'no-chain-result': { title: '程式碼區段沒有鏈上結果', why: '這段 code pin 沒有從鏈上讀到判定。' },
  'factory-unread': { title: '沒有讀到工廠的回答', why: '沒有記錄登記的工廠是否建立了這個金庫。' },
  'not-pinned': { title: '沒有 code pin', why: '這個合約沒有登記程式碼，簽名時會是 UNVERIFIABLE。' },
  'no-abi-case': { title: '沒有 ABI 證明的紀錄', why: 'testdata/abi 沒有這個合約的 ABI 證明，程式沒有比對它的原始碼。' },
  'compiler-not-pinned': { title: '編譯器沒有釘選', why: '這個合約用的 solc 版本沒有釘選，程式沒有重新編譯它的原始碼。' },
  'pinned-before-spans': { title: 'code pin 沒有區段紀錄', why: '這個 code pin 寫在記錄區塊範圍之前，程式沒有讀鏈上從哪個區塊起跑這份程式碼。' },
};

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

const grouped = (whole: string): string => {
  const [integer = '', fraction] = whole.split('.');
  const withCommas = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? withCommas : `${withCommas}.${fraction}`;
};

/** A base-unit amount in whole tokens with grouping, cut to `places` fraction digits when given. */
function tokens(amount: bigint, decimals: number, places?: number): string {
  const whole = wholeTokens(amount, decimals);
  if (places === undefined) return grouped(whole);
  const [integer = '', fraction = ''] = whole.split('.');
  const cut = fraction.slice(0, places).replace(/0+$/, '');
  return grouped(cut === '' ? integer : `${integer}.${cut}`);
}

const usd = (value: number): string => {
  const steps: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  const [scale, unit] = steps.find(([s]) => value >= s) ?? [1, ''];
  return `$${(value / scale).toFixed(2)}${unit === '' ? '' : ` ${unit}`}`;
};

const percent = (a: bigint, b: bigint): string => {
  if (b === 0n) return '無法計算，分母是 0';
  const basis = (a * 10_000n) / b;
  return `${basis / 100n}.${(basis % 100n).toString().padStart(2, '0')}%`;
};

const lltvWords = (lltv: bigint): string => `${percent(lltv, 10n ** 18n).replace(/\.?0+%$/, '%')}`;

const marketWords = (market: Market): string => `${market.loanToken.name} / ${market.collateralToken.name}，LLTV ${lltvWords(market.lltv)}`;

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

const fieldsNote = (context: Context, key: string): AiText => research(context.notes.fields.get(key) as string, [], 'AI');

function decimalsOf(context: Context, token: Address): number | undefined {
  const read = context.facts?.decimals.get(token);
  return read?.kind === 'read' ? read.value : undefined;
}

function tokenOf(ref: TokenRef, context: Context): { readonly address: Address | 'eth'; readonly name: string } | undefined {
  if (ref === 'eth') return { address: 'eth', name: 'ETH' };
  if (context.card === undefined) {
    const names = refNames(ref, context.template, context.registry);
    const entry = names.length === 1 ? context.registry.entries.get(names[0] as string) : undefined;
    return entry === undefined ? undefined : { address: entry.address, name: entry.name };
  }
  const target = resolveRef(ref, context.card, context.registry);
  if ('problem' in target || target.kind !== 'address') return undefined;
  return { address: target.address, name: context.registry.byAddress.get(target.address)?.name ?? checksumAddress(target.address) };
}

/** An amount of `token` in whole tokens, from the recorded decimals; base units when they were not read. */
function amountWords(amount: bigint, ref: TokenRef, context: Context): { readonly words: Inline; readonly qualifier: Inline | undefined } {
  const token = tokenOf(ref, context);
  if (token === undefined) return { words: [{ num: amount.toString() }, ' 最小單位'], qualifier: undefined };
  const decimals = token.address === 'eth' ? 18 : decimalsOf(context, token.address);
  if (decimals === undefined) return { words: [{ num: amount.toString() }, ` 最小單位的 ${token.name}`], qualifier: ['decimals() 沒讀到'] };
  const shown = tokens(amount, decimals, SHOWN_PLACES);
  if (shown === tokens(amount, decimals)) return { words: [{ num: shown }, ` ${token.name}`], qualifier: [`${decimals} 位小數`] };
  return { words: ['約 ', { num: shown }, ` ${token.name}（`, { num: amount.toString() }, ' 最小單位）'], qualifier: [`${decimals} 位小數`] };
}

/** The most fraction digits an amount shows in words; a longer one is cut, marked 約, with its exact base units beside it. */
const SHOWN_PLACES = 6;

const SAFE = '你的 Safe';

/** The registry names a call's `to` can be, the name the page shows for it, and its role on the diagram's lifeline. */
function targetOf(rule: Rule, context: Context): { readonly label: string; readonly names: readonly string[]; readonly role: string } {
  const { registry } = context;
  const role = (name: string, otherwise: string): string => {
    const entry = registry.entries.get(name);
    return entry === undefined ? otherwise : KIND_WORDS[entry.kind];
  };
  if (rule.kind === 'safe') return { label: SAFE, names: ['safe'], role: '發起' };
  if (rule.kind === 'contract') return { label: rule.name, names: [rule.name], role: role(rule.name, '合約') };
  if (rule.kind === 'const' && rule.value.kind === 'address') {
    const entry = registry.byAddress.get(rule.value.value);
    return { label: entry?.name ?? checksumAddress(rule.value.value), names: entry === undefined ? [] : [entry.name], role: entry === undefined ? '固定的地址' : KIND_WORDS[entry.kind] };
  }
  if (rule.kind !== 'card') return { label: '?', names: [], role: '' };
  const names = refNames(rule.ref, context.template, registry);
  if (names.length === 1) return { label: names[0] as string, names, role: role(names[0] as string, '你選') };
  const picked = context.card === undefined ? undefined : resolveRef(rule.ref, context.card, registry);
  const name = picked === undefined || 'problem' in picked || picked.kind !== 'address' ? undefined : registry.byAddress.get(picked.address)?.name;
  return name === undefined ? { label: refWord(context.template, rule.ref), names, role: '你選' } : { label: name, names, role: role(name, '你選') };
}

const SHORT: Readonly<Record<Who, string>> = { 'you-type': '你填', 'you-pick': '你選', fixed: '固定', free: '不限' };

function whoOf(rule: Rule, template: Template): { readonly who: Who; readonly field: string | undefined } | undefined {
  switch (rule.kind) {
    case 'card': {
      const kind = template.card.get(rule.ref.field)?.kind;
      return { who: kind === 'amount' || kind === 'nonce' ? 'you-type' : 'you-pick', field: rule.ref.field };
    }
    case 'safe':
    case 'contract':
    case 'const':
      return { who: 'fixed', field: undefined };
    case 'free':
      return { who: 'free', field: undefined };
    case 'equals':
      return whoOf(rule.rule, template);
    case 'share-price':
      return { who: 'you-type', field: rule.assets.kind === 'card' ? rule.assets.field : undefined };
    case 'call':
    case 'items':
    case 'fields':
      return undefined;
  }
}

const chipLabel = (template: Template, who: Who, field: string | undefined): string =>
  who === 'free' ? 'app 填，不限' : field === undefined || who === 'fixed' ? SHORT[who] : `${SHORT[who]}：${fieldWord(template, field)}`;

function leaves(node: ArgNode, template: Template): { readonly node: ArgNode; readonly who: Who; readonly field: string | undefined }[] {
  if (node.rule.kind === 'call') return [];
  if (node.children.length > 0) return node.children.flatMap((child) => leaves(child, template));
  const who = whoOf(node.rule, template);
  return who === undefined ? [] : [{ node, ...who }];
}

/** One chip when every part agrees; else one per who, naming its parts (`kind 固定`, `data 不限`). A nested call carries none. */
function chipsOf(node: ArgNode, template: Template): Chip[] {
  const found = leaves(node, template);
  const distinct = [...new Map(found.map((leaf) => [`${leaf.who}/${leaf.field ?? ''}`, leaf])).values()];
  if (distinct.length <= 1) return distinct.map((leaf) => ({ who: leaf.who, label: chipLabel(template, leaf.who, leaf.field) }));
  const byWho = new Map<Who, string[]>();
  for (const leaf of found) byWho.set(leaf.who, [...(byWho.get(leaf.who) ?? []), leaf.node.name]);
  return [...byWho].map(([who, names]) => ({ who, label: `${names.join('、')} ${SHORT[who]}` }));
}

/** The card market field a `fields` rule binds whole, part by part. */
function wholeMarket(rule: Rule, template: Template): string | undefined {
  if (rule.kind !== 'fields' || rule.fields.length !== MARKET_PARAMS.length) return undefined;
  const fields = rule.fields.map((r, i) => (r.kind === 'card' && r.ref.attribute === MARKET_PARAMS[i] ? r.ref.field : undefined));
  const [field] = fields;
  return field !== undefined && fields.every((f) => f === field) && template.card.get(field)?.kind === 'market' ? field : undefined;
}

/** The one entry a contract card reference can name, as in a per-vault report, where the card can name only its vault. */
function onlyEntry(ref: CardRef, context: Context): RegistryEntry | undefined {
  if (context.template.card.get(ref.field)?.kind !== 'contract') return undefined;
  const names = refNames(ref, context.template, context.registry);
  return names.length === 1 ? context.registry.entries.get(names[0] as string) : undefined;
}

function cardWords(ref: CardRef, key: string, context: Context): { readonly words: Inline; readonly qualifier: Inline | undefined } {
  const field = context.template.card.get(ref.field);
  const only = onlyEntry(ref, context);
  const picks = before('你選的', refWord(context.template, ref));
  if (only !== undefined) return { words: [link(only)], qualifier: [picks] };
  const example = context.values.get(key);
  if (field?.kind === 'amount') {
    if (example?.kind !== 'uint') return { words: [before('你填的', fieldWord(context.template, ref.field))], qualifier: undefined };
    return amountWords(example.value, field.of, context);
  }
  if (field?.kind === 'nonce') return { words: [before('你填的', fieldWord(context.template, ref.field))], qualifier: undefined };
  const picked = example?.kind === 'address' ? context.registry.byAddress.get(example.value) : undefined;
  if (picked !== undefined) return { words: [link(picked)], qualifier: [picks] };
  if (field?.kind === 'market' && ref.attribute === 'lltv' && example?.kind === 'uint') return { words: [lltvWords(example.value)], qualifier: [picks] };
  return { words: [picks], qualifier: undefined };
}

function leafWords(node: ArgNode, context: Context): { readonly words: Inline; readonly qualifier: Inline | undefined } {
  const { rule } = node;
  switch (rule.kind) {
    case 'contract':
      return { words: [link(context.registry.entries.get(rule.name) as RegistryEntry)], qualifier: undefined };
    case 'safe':
      return { words: ['你的 Safe'], qualifier: undefined };
    case 'const': {
      if (rule.value.kind === 'address') {
        const entry = context.registry.byAddress.get(rule.value.value);
        return { words: rule.value.value === ZERO_ADDRESS ? ['無（零地址）'] : entry === undefined ? ['固定的地址'] : [link(entry)], qualifier: undefined };
      }
      const text = constCast(rule.value);
      return { words: [text.length <= 24 ? `固定為 ${text}` : '固定值'], qualifier: undefined };
    }
    case 'card':
      return cardWords(rule.ref, node.key, context);
    case 'free':
      return { words: ['每筆不同'], qualifier: [FREE_WORDS[rule.claim]] };
    case 'equals':
      return { words: ['跟 ', { code: rule.path }, ' 同一個數'], qualifier: undefined };
    case 'share-price':
      return { words: [rule.bound === 'max' ? '價格上限' : '價格下限'], qualifier: ['依你填的數量算出，交易裡的要一樣嚴或更嚴'] };
    case 'call':
      return { words: [{ code: rule.call.fn.name }, ' (', { mono: rule.call.fn.selector }, ')'], qualifier: undefined };
    case 'items':
      return { words: [`${rule.items.length} 項`], qualifier: undefined };
    case 'fields':
      return { words: [`${rule.fields.length} 個部分`], qualifier: undefined };
  }
}

function valueOf(node: ArgNode, context: Context): ArgRow['value'] {
  if (node.rule.kind === 'call' || node.rule.kind === 'items' || node.rule.kind === 'fields') return undefined;
  if (node.rule.kind === 'const') return { cast: constCast(node.rule.value), example: undefined };
  if (node.rule.kind === 'contract') return { cast: checksumAddress((context.registry.entries.get(node.rule.name) as RegistryEntry).address), example: undefined };
  const only = node.rule.kind === 'card' ? onlyEntry(node.rule.ref, context) : undefined;
  if (only !== undefined) return { cast: checksumAddress(only.address), example: undefined };
  const example = context.values.get(node.key);
  if (example === undefined) return undefined;
  const fromSafe = example.kind === 'address' && example.value === context.inputs.example?.tx.safe;
  return { cast: castValue(example), example: fromSafe ? '例：別的 Safe' : '例' };
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
      words: entry === undefined ? [lltvWords(market.lltv)] : [link(entry)],
      qualifier: undefined,
      id: undefined,
      ai: fieldsNote(context, child.key),
      parts: [],
      doc: undefined,
    };
  });
}

function argRow(node: ArgNode, context: Context, withChips: boolean): ArgRow {
  const chips = withChips ? chipsOf(node, context.template) : [];
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
      words: shown === undefined ? [before('你選的', fieldWord(context.template, market))] : [marketWords(shown)],
      qualifier: [`${MARKET_PARAMS.length} 個值，任何一個不同就 MISMATCH`],
      id: shown === undefined ? undefined : ['market id ', { mono: shown.id }],
      ai: fieldsNote(context, node.key),
      parts: markets.map((m) => ({ label: markets.length === 1 ? undefined : [marketWords(m), '，market id ', { mono: m.id }], rows: marketPartRows(node, m, context) })),
      doc: undefined,
    };
  }
  const nestedCall = node.rule.kind === 'call';
  const { words, qualifier } = leafWords(node, context);
  return {
    key: node.key,
    name: node.name,
    chips,
    value: valueOf(node, context),
    words,
    qualifier,
    id: undefined,
    ai: fieldsNote(context, node.key),
    parts: node.children.length === 0 ? [] : [{ label: undefined, rows: node.children.map((child) => argRow(child, context, nestedCall)) }],
    doc: node.rule.kind === 'call' ? docLine(node.rule.call.fn.signature, context) : undefined,
  };
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
  const { template, registry } = context;
  const lines: Lifeline[] = [{ name: SAFE, role: '發起' }];
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
    return entry === undefined ? '合約' : KIND_WORDS[entry.kind];
  };
  const callTo = template.calls.map((call) => {
    const target = targetOf(call.to, context);
    return add(target.label, target.names, target.role);
  });
  for (const view of template.effects.views) add(view.to, [view.to], kindOf(view.to));
  for (const name of context.notes.flow.flatMap((line) => [line.from, line.to])) {
    if (!names.some((of) => of.includes(name))) add(name, [name], kindOf(name));
  }
  return { lines, names, callTo };
}

function sequence(context: Context): Sequence {
  const { template, notes } = context;
  const { lines, names, callTo } = lifelines(context);
  const at = (name: string): number => names.findIndex((of) => of.includes(name));
  const arrows: Arrow[] = [];
  const narration: string[] = [];
  template.calls.forEach((call, i) => {
    const to = callTo[i] as number;
    const target = to === 0 ? '自己' : (lines[to]?.name as string);
    const sendsEth = !zeroValue(call);
    const fn = call.data !== 'empty' ? call.data.fn.name : sendsEth ? '轉 ETH' : '0 ETH、沒有資料';
    arrows.push({ kind: 'call', n: i + 1, to, fn });
    narration.push(
      call.data !== 'empty' ? `呼叫 ${i + 1}：Safe 呼叫 ${target} 的 ${fn}。` : `呼叫 ${i + 1}：Safe ${sendsEth ? before('轉 ETH 給', target) : before('呼叫', target)}，${sendsEth ? '沒有資料' : '0 ETH、沒有資料'}。`,
    );
    for (const line of notes.flow.filter((f) => f.after === i + 1)) arrows.push({ kind: 'inside', from: at(line.from), to: at(line.to), text: research(line.text) });
  });
  const last = callTo.at(-1) ?? 0;
  for (const effect of template.effects.gets) {
    const token = tokenOf(effect.token, context);
    const text = `你得到 ${token?.name ?? '代幣'}`;
    arrows.push({ kind: 'gets', from: last, text });
    narration.push(`結果：${text}。`);
  }
  for (const view of template.effects.views) {
    for (const { value } of view.changes.filter((c) => c.change === 'increases')) {
      const text = `你在 ${view.to} 的 ${paramName(view.returns[value] as AbiParam, value)} 增加`;
      arrows.push({ kind: 'gets', from: at(view.to), text });
      narration.push(`結果：${text}。`);
    }
  }
  return { lifelines: lines, arrows, narration: narration.join('') };
}

const zeroValue = (call: TemplateCall): boolean => call.value.kind === 'const' && call.value.value.kind === 'uint' && call.value.value.value === 0n;

function sends(call: TemplateCall, context: Context, n: number): Inline | undefined {
  if (zeroValue(call)) return undefined;
  const example = context.inputs.example === undefined ? undefined : unwrapSafeTx(context.inputs.example.tx);
  const inner = example !== undefined && 'calls' in example ? example.calls[n - 1] : undefined;
  const { words } = leafWords({ key: `${n}.value`, name: 'value', param: undefined, rule: call.value, children: [] }, context);
  return ['送出 ETH：', ...words, ...(inner === undefined ? [] : ['，例如 ', { num: wholeTokens(inner.value, 18) }, ' ETH'])];
}

function afterRows(context: Context): AfterRow[] {
  const { template } = context;
  const amountOf = (effect: Template['effects']['gives'][number], gives: boolean): Inline => {
    if (effect.amount.kind === 'all') return ['全部'];
    if (effect.amount.kind === 'positive') return [gives ? '給出多於 0' : '收到多於 0'];
    const value = context.card?.get(effect.amount.field);
    if (value?.kind !== 'amount') return [before('你填的', fieldWord(template, effect.amount.field))];
    const { words } = amountWords(value.value, effect.token, context);
    const sign = gives ? '−' : '+';
    return words[0] === '約 ' ? ['約 ', sign, ...words.slice(1)] : [sign, ...words];
  };
  const note = (effect: Template['effects']['gives'][number]): Inline => {
    const amount = effect.amount.kind === 'card' ? before('剛好你填的', fieldWord(template, effect.amount.field)) : effect.amount.kind === 'all' ? '全部餘額，交易後一個都不剩' : '程式只查方向，不查數量';
    return effect.to === undefined ? [amount] : [amount, before('，給', refWord(template, effect.to))];
  };
  const name = (token: TokenRef) => tokenOf(token, context)?.name ?? (token === 'eth' ? 'ETH' : before('你選的', refWord(template, token)));
  const rows: AfterRow[] = [
    ...template.effects.gives.map((e) => ({ label: [`Safe 的 ${name(e.token)}`], value: amountOf(e, true), note: note(e), gains: false })),
    ...template.effects.gets.map((e) => ({ label: [`Safe 的 ${name(e.token)}`], value: amountOf(e, false), note: note(e), gains: true })),
  ];
  for (const view of template.effects.views) {
    for (const { value, change } of view.changes) {
      rows.push({
        label: [{ code: paramName(view.returns[value] as AbiParam, value) }],
        value: [{ increases: '增加', decreases: '減少', same: '不變' }[change]],
        note: [`${view.to}.${view.fn.name}，交易前後各讀一次`],
        gains: change === 'increases',
      });
    }
  }
  for (const call of template.calls) {
    if (call.data === 'empty' || call.data.fn.signature !== 'approve(address,uint256)') continue;
    const spender = call.data.args[0] as Rule;
    rows.push({ label: ['給 ', ...ruleWords(spender, context), ` 的 ${targetOf(call.to, context).label} 授權`], value: [{ num: '0' }], note: ['交易內用完，不能比交易前高'], gains: false });
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
    chips: who === undefined ? [] : [{ who: who.who, label: chipLabel(context.template, who.who, who.field) }],
    value: valueOf(node, context),
    words,
    qualifier,
    id: undefined,
    ai: undefined,
    parts: [],
    doc: undefined,
  };
}

const NO_DATA_ROW: ArgRow = { key: 'data', name: 'data', chips: [{ who: 'fixed', label: SHORT.fixed }], value: { cast: '0x', example: undefined }, words: ['沒有資料'], qualifier: undefined, id: undefined, ai: undefined, parts: [], doc: undefined };

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
    const text = zeroValue(call) ? `${before('呼叫', target.label)}，0 ETH、沒有資料` : before('轉 ETH 給', target.label);
    return { n, head: { kind: 'no-data', text }, sends: undefined, args: [ruleRow(`${n}.to`, 'to', call.to, context), ruleRow(`${n}.value`, 'value', call.value, context), { ...NO_DATA_ROW, key: `${n}.data` }] };
  });
}

const FREE_KEY: Readonly<Record<FreeClaim, string>> = { scalar: '換成別的值，結果一樣或交易失敗', proof: '換成別的值，交易就失敗', unread: '合約不讀它，換成別的值結果一樣' };

/** The who-decides key for the words the rows use: a free field's line by each claim the template makes. */
function keyItems(used: ReadonlySet<Who>, template: Template): KeyItem[] {
  return [
    ...(used.has('you-type') ? [{ who: 'you-type' as const, label: SHORT['you-type'], means: '每次簽名填' }] : []),
    ...(used.has('you-pick') ? [{ who: 'you-pick' as const, label: SHORT['you-pick'], means: '每次簽名選' }] : []),
    ...(used.has('fixed') ? [{ who: 'fixed' as const, label: SHORT.fixed, means: '改了就 MISMATCH' }] : []),
    ...(used.has('free') ? [...freeClaims(template)].map((claim) => ({ who: 'free' as const, label: 'app 填，不限', means: FREE_KEY[claim] })) : []),
  ];
}

function flowSection(context: Context): Section {
  const { template } = context;
  const calls = callBlocks(context);
  const safeTx = template.nonce === undefined ? [] : [ruleRow('nonce', 'nonce', template.nonce, context)];
  const rows = (list: readonly ArgRow[]): ArgRow[] => list.flatMap((row) => [row, ...rows(row.parts.flatMap((part) => part.rows))]);
  const sent = template.calls.flatMap((call) => {
    const who = call.data === 'empty' || zeroValue(call) ? undefined : whoOf(call.value, template)?.who;
    return who === undefined ? [] : [who];
  });
  const used = new Set([...rows([...safeTx, ...calls.flatMap((call) => call.args)]).flatMap((row) => row.chips.map((c) => c.who)), ...sent]);
  const { example } = context.inputs;
  const chosen = chosenWords(used);
  const vault = context.inputs.subject.kind === 'template' ? context.inputs.subject.vault : undefined;
  let lead: Inline | undefined;
  if (chosen === '') lead = undefined;
  else if (example !== undefined && context.values.size > 0) {
    const amounts = [...template.card].flatMap(([field, card]): Inline[] => {
      const value = context.card?.get(field);
      return card.kind === 'amount' && value?.kind === 'amount' ? [[`${fieldWord(template, field)} `, ...amountWords(value.value, card.of, context).words]] : [];
    });
    const test = vault === undefined ? '第一筆測試交易 ' : `${vault.name} 的第一筆測試交易 `;
    lead = [before(`標「例」的${chosen}的值取自`, test), { code: example.name }, ...amounts.flatMap((a) => ['，', ...a]), '。'];
  } else {
    lead = [vault === undefined ? '沒有換值測試的記錄可以當例子' : `${vault.name} 沒有換值測試的記錄可以當例子`, '，每次簽名才決定的值只寫規則。'];
  }
  return {
    anchor: anchor('flow'),
    label: '流程',
    count: { kind: 'text', text: `${template.calls.length} 個呼叫` },
    body: {
      kind: 'flow',
      flow: { diagram: sequence(context), key: keyItems(used, template), decoded: calls.some((call) => call.head.kind === 'fn'), example: lead, safeTx, calls, after: afterRows(context) },
    },
  };
}

/** The values the signer and the app give, in words, such as 你填、你選和 app 填. */
const chosenWords = (used: ReadonlySet<Who>): string => {
  const words = [...(used.has('you-type') ? ['你填'] : []), ...(used.has('you-pick') ? ['你選'] : []), ...(used.has('free') ? ['app 填'] : [])];
  return words.length <= 1 ? words.join('') : before(`${words.slice(0, -1).join('、')}和`, words.at(-1) as string);
};

type ProtocolNote = NonNullable<ReturnType<Notes['protocols']['get']>>;

function sheetRows(context: Context, sheet: ProtocolSheet, facts: ProtocolFacts, note: ProtocolNote | undefined): ProtocolRow[] {
  const { template, registry } = context;
  const rows: ProtocolRow[] = [];
  const { listing } = sheet;
  if (listing.kind === 'unread') rows.push({ label: 'TVL', value: ['讀不到'], sub: undefined, ai: undefined, nested: [] });
  else {
    const { tvl, ethereumTvl, listedFrom } = listing.value;
    rows.push({ label: 'TVL', value: tvl === undefined ? ['DefiLlama 沒給'] : [{ num: usd(tvl) }], sub: ethereumTvl === undefined ? undefined : ['Ethereum 上 ', { num: usd(ethereumTvl) }], ai: undefined, nested: [] });
    rows.push({ label: '上線', value: [listedFrom === undefined ? 'DefiLlama 沒給' : { num: listedFrom }], sub: ['DefiLlama 開始列的日期'], ai: undefined, nested: [] });
  }
  const proxyWords = { proxy: '是 proxy，可以換實作', 'not a proxy': '不是 proxy', 'not pinned': '沒有 code pin' } as const;
  const [only, ...more] = sheet.contracts;
  rows.push(
    only !== undefined && more.length === 0
      ? { label: 'proxy', value: [proxyWords[only.proxy]], sub: [link(only.entry), '，從 code pin 讀到'], ai: undefined, nested: [] }
      : {
          label: 'proxy',
          value: [`${sheet.contracts.length} 個合約`],
          sub: ['從 code pin 讀到'],
          ai: undefined,
          nested: sheet.contracts.map(({ entry, proxy }) => ({ label: [link(entry)], value: [proxyWords[proxy]], ai: undefined })),
        },
  );
  if (note !== undefined) rows.push({ label: '稽核', value: [], sub: undefined, ai: research(note.audits.text, note.audits.sources), nested: [] });
  const incidents = note?.incidents ?? [];
  rows.push({
    label: '事故',
    value: listing.kind === 'unread' ? ['讀不到'] : [`${sheet.hacks.length} 起`],
    sub: ['DefiLlama hacks 列在這個協議或它上層協議下的'],
    ai: undefined,
    nested: sheet.hacks.map((hack, i) => {
      const incident = incidents[i];
      return {
        label: [{ num: hack.date }],
        value: [hack.amount === undefined ? '金額沒給' : { num: usd(hack.amount) }],
        ai: incident === undefined ? undefined : research(incident.text, incident.sources),
      };
    }),
  });
  for (const fact of template.facts.filter((f) => registry.entries.get(f.to)?.defillama === sheet.slug)) {
    for (const reading of facts.readings.filter((r) => r.fact === fact)) {
      const value = reading.value;
      const nested: ProtocolRow['nested'][number][] = [];
      if (reading.read.kind === 'unread') nested.push({ label: [{ code: fact.fn.name }], value: ['讀不到'], ai: undefined });
      else {
        const amounts = reading.read.value;
        fact.units.forEach((unit, i) => {
          const amount = amounts[i] as (typeof amounts)[number];
          const decimals = amount.token === 'eth' ? 18 : decimalsOf(context, amount.token);
          const name = amount.token === 'eth' ? 'ETH' : (registry.byAddress.get(amount.token)?.name ?? '');
          nested.push({
            label: [{ code: paramName(fact.returns[unit.value] as AbiParam, unit.value) }],
            value: decimals === undefined ? [{ num: amount.amount.toString() }, ' 最小單位'] : [{ num: tokens(amount.amount, decimals, 2) }, ` ${name}`],
            ai: undefined,
          });
        });
        if (fact.ratio !== undefined) {
          const [a, b] = fact.ratio;
          const at = (position: number) => amounts[fact.units.findIndex((u) => u.value === position)]?.amount as bigint;
          const named = (position: number) => paramName(fact.returns[position] as AbiParam, position);
          nested.push({ label: [{ code: `${named(a)} / ${named(b)}` }], value: [{ num: percent(at(a), at(b)) }], ai: undefined });
        }
      }
      rows.push({
        label: value.kind === 'market' ? value.market.name : value.entry.name,
        value: value.kind === 'market' ? [marketWords(value.market)] : [link(value.entry)],
        sub: [`${fact.to}.${fact.fn.name}，區塊 ${facts.block.number}`],
        ai: undefined,
        nested,
      });
    }
  }
  return rows;
}

function unreadRows(note: ProtocolNote | undefined): ProtocolRow[] {
  return [
    { label: '協議資料', value: ['沒讀到'], sub: ['這份報告的紀錄沒有協議資料：TVL、上線日期、proxy、事故和 facts 都沒有程式結果'], ai: undefined, nested: [] },
    ...(note === undefined
      ? []
      : [
          { label: '稽核', value: [], sub: undefined, ai: research(note.audits.text, note.audits.sources), nested: [] },
          { label: '事故', value: ['沒讀到'], sub: undefined, ai: undefined, nested: note.incidents.map((incident, i) => ({ label: [`${i + 1}`], value: [], ai: research(incident.text, incident.sources) })) },
        ]),
  ];
}

function protocolSections(context: Context): Section[] {
  const { facts, notes, template, registry } = context;
  const slugs = (facts?.protocols ?? factsScope(template, registry, context.ledger.entries).protocols).map((p) => p.slug);
  return slugs.map((slug): Section => {
    const note = notes.protocols.get(slug);
    const sheet = facts?.protocols.find((s) => s.slug === slug);
    const rows = facts === undefined || sheet === undefined ? unreadRows(note) : sheetRows(context, sheet, facts, note);
    const apis = context.ledger.entries.flatMap((e) => (e.defillama === slug && e.apiSource !== undefined ? [e.apiSource.url] : []));
    const sources = [
      { label: 'DefiLlama', href: parseHttpsUrl(`https://defillama.com/protocol/${slug}`) },
      { label: 'DefiLlama hacks', href: parseHttpsUrl('https://defillama.com/hacks') },
      { label: '鏈上', href: undefined },
      ...[...new Set(apis)].map((href) => ({ label: '協議 API', href })),
    ];
    return {
      anchor: anchor(`protocol-${slug}`),
      label: slug,
      count: undefined,
      body: { kind: 'protocol', block: { read: context.inputs.fetched, intro: research((note?.intro ?? '') || slug), rows, sources } },
    };
  });
}

const POINT_WORDS: Readonly<Record<Exclude<StoredPoint['assets']['kind'], 'amount'>, string>> = { unread: '讀不到', 'no-code': '還沒有程式碼', reverted: 'totalAssets() revert' };

/** The card's vault in a per-vault report, from its stored `pnpm vault-evidence` output alone. */
function vaultSection(context: Context): Section[] {
  const { subject } = context.inputs;
  if (subject.kind !== 'template' || subject.vault === undefined) return [];
  const vault = subject.vault;
  const text = context.inputs.vaults.get(vault.name);
  const section = (block: VaultBlock): Section[] => [{ anchor: anchor(`vault-${vault.name}`), label: '金庫', count: undefined, body: { kind: 'vault', vault: block } }];
  const lead: Inline = [link(vault), '：程式記錄的 ', { code: 'pnpm vault-evidence' }, ' 輸出，每個數字都同時問兩家節點。這裡不換算成美元。'];
  if (text === undefined) return section({ lead: [link(vault), '：沒有 ', { code: 'pnpm vault-evidence' }, ' 的記錄。'], rows: [], bars: [], most: undefined });
  const evidence = readStoredEvidence(text, vault, context.registry);
  const unit = evidence.asset?.name === undefined ? '' : ` ${evidence.asset.name}`;
  const amount = (value: bigint): string => (evidence.asset === undefined ? `${value} 最小單位` : `${tokens(value, evidence.asset.decimals, 2)}${unit}`);
  const most = evidence.points.reduce<bigint | undefined>((top, p) => (p.assets.kind === 'amount' && (top === undefined || p.assets.amount > top) ? p.assets.amount : top), undefined);
  const bars = evidence.points.map(
    (p): VaultBar => ({
      date: p.date ?? '日期不明',
      words: p.assets.kind === 'amount' ? amount(p.assets.amount) : POINT_WORDS[p.assets.kind],
      share: p.assets.kind !== 'amount' || most === undefined || most === 0n ? undefined : Number(p.assets.amount) / Number(most),
    }),
  );
  const latest = evidence.points.at(-1);
  const { factory } = vault.attributes;
  const rows: VaultBlock['rows'] = [
    {
      label: '工廠',
      value:
        evidence.admitted !== undefined
          ? [evidence.admitted.factory, ' 回答 ', { code: evidence.admitted.check }, ` = ${evidence.admitted.answer}`]
          : [factory === undefined ? '沒有登記工廠，沒有工廠為它的程式碼背書' : `沒有記錄到 ${factory} 回答它建立了這個金庫`],
      note: evidence.admitted === undefined ? [] : [`區塊 ${evidence.admitted.block}`],
    },
    {
      label: '現在的 totalAssets',
      value: latest === undefined ? ['讀不到'] : [{ num: latest.assets.kind === 'amount' ? amount(latest.assets.amount) : POINT_WORDS[latest.assets.kind] }],
      note: latest === undefined ? [] : [`${latest.date ?? '日期不明'}，區塊 ${latest.block}`],
    },
    ...(evidence.holders === undefined
      ? [{ label: '持有人', value: ['讀不到'], note: [] }]
      : [
          { label: '持有人', value: [{ num: `${evidence.holders.holders}` }, ' 個地址持有，曾經收過的 ', { num: `${evidence.holders.candidates}` }, ' 個'], note: [] },
          { label: '最大持有人', value: [{ num: evidence.holders.largest ?? '讀不到' }], note: ['占全部股份'] },
          { label: '前 10 名', value: [{ num: evidence.holders.top10 }], note: ['占全部股份'] },
        ]),
  ];
  return section({ lead, rows, bars, most: most === undefined ? undefined : amount(most) });
}

function reviewTitle(result: Result, context: Context): { readonly title: Inline; readonly why: Inline } {
  const words = FINDING_WORDS[result.finding.kind] ?? { title: '要你看', why: '' };
  if (result.about.kind === 'fixture') {
    const detail = result.finding.kind === 'judged-otherwise' ? ` ${result.finding.detail}` : '';
    return { title: ['測試交易 ', { code: result.about.name }, `：${words.title}`], why: [`${words.why}${detail}`] };
  }
  const name = result.about.entry.name;
  const doc = /\/doc\.(0x[0-9a-f]{8})\.(\w+)$/.exec(result.id);
  if (doc !== null && context.inputs.subject.kind === 'template') {
    const found = context.inputs.subject.docs.find((d) => d.fn.selector === doc[1]);
    const page = found?.standard === undefined ? '文件頁' : `${found.standard.name} 標準頁`;
    const why = found?.standard !== undefined && result.finding.kind === 'name-not-on-page' ? `標準頁上沒有這個函式在 ${found.standard.name} 裡的宣告。` : words.why;
    return { title: [`${name}：${page} `, { code: found?.fn.name ?? (doc[1] as string) }, `，${words.title}`], why: [why] };
  }
  if (result.finding.kind === 'few-confirmations') {
    return {
      title: [`${name}：地址${confirmedWords(result.about.entry, result.finding.by)}`],
      why: [`至少要 ${MIN_CONFIRMATIONS} 個地方列出同一個地址：官方頁、協議 API、CoinGecko，或金庫的登記工廠。網址本身含有地址的頁面不算，它只會照網址印出來。`],
    };
  }
  const span = /\/code\.(\d+)$/.exec(result.id);
  const where = span !== null ? `（第 ${span[1]} 段）` : result.id.endsWith('/code.today') ? '（最新區塊）' : '';
  const refused = result.finding.kind === 'refused' ? ` 原因：${result.finding.why}。` : '';
  return { title: [`${name}：${words.title}${where}`], why: [`${words.why}${refused}`] };
}

function reviewSection(context: Context): Section {
  const { notes, ledger } = context;
  const rows = forSigner(ledger).map((result): ReviewRow => {
    const review = notes.reviews.get(result.id) as Notes['reviews'] extends ReadonlyMap<string, infer R> ? R : never;
    const { title, why } = reviewTitle(result, context);
    return {
      id: result.id,
      state: stateOf(result),
      title,
      why,
      entry: result.about.kind === 'entry' ? entryAnchor(result.about.entry.name) : undefined,
      review: { status: review.status, text: research(review.text), recommendation: research(review.recommendation) },
    };
  });
  const judgments = notes.judgments.map((j) => ({ text: research(j.text, j.sources), recommendation: research(j.recommendation) }));
  const counts = [...(rows.length === 0 ? [] : [{ state: worst(forSigner(ledger)), n: rows.length }]), ...(judgments.length === 0 ? [] : [{ state: 'ask' as const, n: judgments.length }])];
  const count: RailCount = { kind: 'states', counts: counts.length === 0 ? [{ state: 'ok', n: 0 }] : counts };
  return { anchor: anchor('review'), label: '待確認', count, body: { kind: 'review', rows, judgments } };
}

const WALLET_WORDS: Readonly<Record<string, string>> = {
  assets: '金額',
  amount: '金額',
  value: '金額',
  shares: '股份數',
  deadline: '期限',
  loanToken: '借出代幣',
  collateralToken: '抵押代幣',
  oracle: 'oracle',
  irm: '利率模型',
  lltv: 'LLTV',
  receiver: '收款地址',
  spender: '被授權者',
  referralFeePct: '推薦費比例',
  referralFeeRecipient: '推薦費收款地址',
};

/** The template's rule in the signer's words, for the wallet table: never the example's value. */
function ruleWords(rule: Rule, context: Context): Inline {
  switch (rule.kind) {
    case 'contract':
      return [link(context.registry.entries.get(rule.name) as RegistryEntry)];
    case 'safe':
      return ['你的 Safe'];
    case 'const':
      return rule.value.kind === 'address' && rule.value.value === ZERO_ADDRESS ? ['無（零地址）'] : [{ mono: constCast(rule.value) }];
    case 'card': {
      const only = onlyEntry(rule.ref, context);
      if (only !== undefined) return [link(only)];
      const kind = context.template.card.get(rule.ref.field)?.kind;
      return [before(kind === 'amount' || kind === 'nonce' ? '你填的' : '你選的', refWord(context.template, rule.ref))];
    }
    case 'free':
      return ['不限'];
    case 'equals':
      return ['跟 ', { code: rule.path }, ' 同一個數'];
    case 'share-price':
      return [rule.bound === 'max' ? '價格上限' : '價格下限'];
    case 'call':
      return ['呼叫 ', { code: rule.call.fn.name }, '，參數見流程'];
    case 'items':
    case 'fields':
      return ['見流程'];
  }
}

function walletSection(context: Context): Section {
  const { template, registry, inputs } = context;
  const section = (view: WalletView): Section => ({ anchor: anchor('wallet'), label: '錢包顯示', count: undefined, body: { kind: 'wallet', view } });
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
    if (without.length > 0) lines.push([`呼叫 ${n}：列的是 ${[...describedNames].join('、')} 的描述檔；${without.join('、')} 沒有描述檔，錢包只顯示原始資料。`]);
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
      if (field.path === '@.value') return [{ label: ['送出的 ETH'], value: ruleWords(call.value, context) }];
      const targets = find(field.path);
      if (targets.length === 0) return [{ label: ['不是這個函式的參數'], value: ['—'] }];
      return targets.map(({ path, node }) => ({
        label: targets.length > 1 ? [{ code: path }] : [Object.hasOwn(WALLET_WORDS, node.name) ? (WALLET_WORDS[node.name] as string) : node.name],
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
    if (hidden.length > 0) lines.push([`呼叫 ${n}：錢包不顯示 `, ...hidden.flatMap((h, i): Span[] => [...(i === 0 ? [] : ['、']), { code: h }]), '。']);
    const blind = args.some((a) => wholeMarket(a.rule, template) !== undefined && a.children.some((c) => hidden.includes(`${a.name}.${c.name}`)));
    if (blind) lines.push([`呼叫 ${n}：同樣兩種代幣的不同 market，只看錢包分不出來。`]);
    return { n, title, rows };
  });
  return section({ kind: 'calls', calls, lines });
}

function codeLines(ledger: Ledger, entry: RegistryEntry): Inline[] {
  const lines: Inline[] = [];
  const notCalled = ledger.results.some((r) => r.finding.kind === 'not-called' && r.about.kind === 'entry' && r.about.entry.name === entry.name);
  if (notCalled) {
    const dependents = ledger.entries.filter((other) => other.dependsOn?.includes(entry.name));
    const links = dependents.flatMap((other, i): Span[] => [...(i === 0 ? [] : ['、']), { href: entryAnchor(other.name), label: other.name }]);
    lines.push(['沒有呼叫直接打到這個合約，所以沒有 ABI 證明。', ...(entry.code === undefined ? [] : ['每次簽名碰到 ', ...links, ' 時，程式也確認它的程式碼還是 code pin 記錄的那份。'])]);
  }
  const routes = entry.code?.current.pin.routes;
  if (routes !== undefined) {
    lines.push([`它依函式選擇器把呼叫分給各自的實作${notCalled ? '' : '，沒有一份程式碼能做 ABI 證明'}。code pin 的 seeds 接到 ${routes.length} 個實作：`]);
    for (const route of routes) lines.push([{ mono: checksumAddress(route.address) }, '，程式碼 hash ', { mono: route.hash }, `，${route.selectors.length} 個函式`]);
    lines.push(['沒有 seed 接到的實作，code pin 沒有記錄，程式也不檢查。']);
  }
  return lines;
}

function addressSection(context: Context): Section[] {
  const { ledger, notes } = context;
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
        label: sourceWord(entry, line.source),
        href: line.link,
        state: line.state,
        phrase: line.phrase,
        site: line.site === undefined ? undefined : { state: line.site.state, phrase: line.site.phrase, slug: entry.defillama, href: line.site.link },
      }),
    );
    return {
      anchor: entryAnchor(entry.name),
      name: entry.name,
      state: worst(results),
      role: note?.role === undefined ? undefined : research(note.role),
      confidence: level,
      reviewed: reviews.length === 0 ? undefined : reviews.some((r) => r.status === 'concern') ? 'AI 有疑慮' : 'AI 已確認',
      address: checksumAddress(entry.address),
      sources,
      confirmed: confirmedWords(entry, confirmations(ledger, entry)),
      codeLines: codeLines(ledger, entry),
      aiSources: (note?.sources ?? []).map((s) => ({ text: research(s.text, [s.url], 'AI'), result: AI_RESULTS[s.result] })),
    };
  };
  const { open, folded } = addressRows(ledger);
  return [
    {
      anchor: anchor('addresses'),
      label: '地址',
      count: { kind: 'text', text: `${ledger.entries.length}` },
      body: { kind: 'addresses', open: open.map(row), folded: folded.map(row) },
    },
  ];
}

const NO_SELECTOR_WORDS: Readonly<Record<string, string>> = { 'no data': '（沒有資料）', 'contract creation': '（建立合約）' };

/** A search anchor in words: a mint or burn of a vault's shares is a deposit or a withdrawal, of any other token only a mint or burn. */
function anchorWords(anchor: string, token: RegistryEntry | undefined): string {
  const vault = token?.kind === 'vault';
  if (anchor === 'mint') return vault ? '鑄造（存款）' : '鑄造';
  if (anchor === 'burn') return vault ? '銷毀（提款）' : '銷毀';
  return '轉帳';
}

type Misfit = Extract<TxStudy, { kind: 'misfit' }>;
type Fit = Extract<TxStudy, { kind: 'fit' }>;
type Studied = Fit | Misfit;

const OUTSIDE_WORDS: Readonly<Record<OutsideKind, string>> = { market: '市場', token: '代幣', vault: '金庫', address: '地址' };

/** What fits outside the registry used, such as `用的是 registry 外的市場或地址`. */
const outsideWords = (fits: readonly Fit[]): string => `用的是 registry 外的${[...new Set(fits.flatMap((fit) => fit.outside.map((o) => OUTSIDE_WORDS[o.kind])))].join('或')}`;

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
function misfitWords(reason: MisfitReason, template: string, registry: Registry): Inline {
  const last = (at: string): string => at.split('.').at(-1) ?? at;
  switch (reason.kind) {
    case 'entry': {
      const named = registry.byAddress.get(reason.actual)?.name;
      const actual: Span = named === undefined ? { mono: checksumAddress(reason.actual) } : named;
      const allowed = reason.expected.length === 1 ? `模板的 ${reason.expected[0]}` : `模板允許的 ${reason.expected.slice(0, -1).join('、')} 或 ${reason.expected.at(-1)}`;
      return last(reason.at) === 'to' ? ['呼叫的合約是 ', actual, `，不是${allowed}`] : [{ code: last(reason.at) }, ' 是 ', actual, `，不是${allowed}`];
    }
    case 'calls':
      return ['呼叫跟模板不同，模板是 ', { code: template }];
    case 'items':
      return [{ code: last(reason.at) }, ` 有 ${reason.got} 項，模板是 ${reason.expected} 項`];
    case 'field':
      return [{ code: reason.at }, ' 的值跟模板不同：模板要 ', { mono: reason.expected }, '，交易是 ', { mono: reason.actual }];
    case 'trailer':
      return ['參數後面多了模板不允許的位元組，在 ', { code: reason.at }];
    case 'foreign-delegatecall':
      return ['delegatecall 到不是官方 MultiSend 的合約'];
    case 'multisend-noncanonical':
      return ['MultiSend 的編碼不標準'];
    case 'other':
      return ['形狀跟模板不同'];
  }
}

function pastSection(context: Context): Section {
  const { registry, template } = context;
  const nameOf = (address: string): string => registry.byAddress.get(address.toLowerCase() as Address)?.name ?? checksumAddress(address as Address);
  const known = knownFunctions(context);
  const fnOf = (selector: string): string => known.get(selector) ?? selector;
  /** Another operation's call: its contract by registry name or full address, then its function. */
  const otherWords = (to: Address | undefined, selector: string | undefined): string => {
    const fn = selector === undefined ? '（沒有資料）' : /^0x[0-9a-f]{8}$/.test(selector) ? fnOf(selector) : (NO_SELECTOR_WORDS[selector] ?? selector);
    return to === undefined ? fn : `${registry.byAddress.get(to.toLowerCase() as Address)?.name ?? checksumAddress(to)}${fn.startsWith('（') ? '' : '.'}${fn}`;
  };
  const callWords = ({ to, selector }: CallName): string =>
    `${to === undefined ? '別的合約' : (registry.byAddress.get(to)?.name ?? checksumAddress(to))}${selector === undefined ? '（沒有資料）' : `.${fnOf(selector)}`}`;
  const sequence = (calls: readonly CallName[]): Inline => [{ code: calls.map(callWords).join(' → ') }];
  const templateCalls = template.calls.map((call) => (call.data === 'empty' ? '（沒有資料）' : call.data.fn.name)).join(' → ');
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
          reason: misfitWords(reason, templateCalls, registry),
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
          reason: [
            '形狀一樣，但 ',
            ...outside.flatMap((o, i): Span[] => [...(i === 0 ? [] : ['、']), { code: o.at.endsWith('.to') ? o.at : (o.at.split('.').at(-1) ?? o.at) }, ` 用的是 registry 外的${OUTSIDE_WORDS[o.kind]}`]),
          ],
          examples: members.slice(0, 3).map((m) => txLink(m.hash)),
        };
      });
  };
  const recordings = context.inputs.pastTxs.map(({ file, query, run }): PastRecording => {
    const studied = run.studies.filter((s): s is Studied => s.kind === 'fit' || s.kind === 'misfit');
    const counted = studied.filter((s) => !otherOperation(s));
    const block = (title: string, of: readonly Studied[], who: string): PastBlock => {
      const fits = of.filter((s): s is Fit => s.kind === 'fit');
      const outside = fits.filter((s) => s.outside.length > 0);
      const senders = new Set(of.map((s) => s.sender.address)).size;
      return {
        title,
        lead: [
          { num: `${of.length}` },
          ` 筆用了這個操作的呼叫（${senders} 個${who}），`,
          { num: `${fits.length - outside.length}` },
          ' 筆跟模板一模一樣',
          ...(outside.length === 0 ? [] : ['，', { num: `${outside.length}` }, ` 筆形狀一樣、但${outsideWords(outside)}`]),
          '。',
        ],
        groups: [...outsideGroups(outside), ...groupsOf(of.filter((s): s is Misfit => s.kind === 'misfit'))],
      };
    };
    const bySender = (match: (sender: Sender) => boolean) => counted.filter((s) => match(s.sender));
    const blocks = [
      block('Safe', bySender((sender) => sender.kind === 'safe'), ' Safe'),
      ...run.shapes.calls.flatMap((shape, call) => {
        const of = bySender((sender) => sender.kind === 'eoa' && sender.call === call);
        const data = shape.template.calls[0]?.data;
        return of.length === 0 ? [] : [block(`EOA 直接呼叫 ${data === undefined || data === 'empty' ? '（沒有資料）' : data.fn.name}`, of, '地址')];
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
      ...(elsewhere.length === 0
        ? []
        : [
            [
              `另外 ${elsewhere.length} 筆是別的操作，不列入：`,
              ...top.flatMap(([name, n], i): Span[] => [...(i === 0 ? [] : ['、']), { code: name }, ` ${n} 筆`]),
              ...(tally.size > top.length ? ['，還有別的'] : []),
              '。',
            ] as Inline,
          ]),
      ...(skipped === 0 ? [] : [[`另外 ${skipped} 筆來自不是 Safe 的合約、執行失敗或讀不到，不列入。`] as Inline]),
    ];
    const bySource = (source: string) => [...run.found.values()].filter((s) => s.includes(source as never)).length;
    const [alchemy, etherscan] = [bySource('alchemy'), bySource('etherscan')];
    const same = [...run.found.values()].every((s) => s.length === 2);
    return {
      file,
      count: `搜尋 ${nameOf(query.token)} 的${anchorWords(query.anchor, registry.byAddress.get(query.token.toLowerCase() as Address))}，找到 ${run.found.size} 筆，研究 ${run.studies.length} 筆`,
      search: [same ? 'Alchemy 和 Etherscan 找到的完全一樣' : 'Alchemy 和 Etherscan 找到的不一樣', '（', { num: `${alchemy} ${same ? '=' : '≠'} ${etherscan}` }, '）。'],
      blocks,
      others,
    };
  });
  const conclusion = context.notes.pastTxsConclusion === undefined ? undefined : research(context.notes.pastTxsConclusion);
  return { anchor: anchor('past'), label: '過去交易', count: undefined, body: { kind: 'past', same: sameShape(context), conclusion, recordings } };
}

function sameShape(context: Context): Inline {
  const { registry, template } = context;
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
    const parts = (['safe', 'eoa'] as const).flatMap((kind): Span[][] => {
      const mine = of.filter((s) => s.sender.kind === kind);
      const senders = new Set(mine.map((s) => s.sender.address)).size;
      return [[kind === 'safe' ? 'Safe ' : 'EOA ', { num: `${mine.length}` }, mine.length === 0 ? ' 筆' : ` 筆（${senders} 個${kind === 'safe' ? ' Safe' : '地址，各自送模板的一個呼叫'}）`]];
    });
    return of.length === 0 ? [] : ['：', ...parts.flatMap((p, i) => [...(i === 0 ? [] : ['、']), ...p])];
  };
  const latest = (of: readonly Fit[]): Span[] =>
    [...of]
      .sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1))
      .slice(0, 3)
      .flatMap((s, i): Span[] => [...(i === 0 ? [] : ['、']), txLink(s.hash)]);
  const searched = [
    ...new Set(
      context.inputs.pastTxs.map(({ query }) => {
        const token = registry.byAddress.get(query.token.toLowerCase() as Address);
        return `${token?.name ?? checksumAddress(query.token as Address)} ${anchorWords(query.anchor, token)}時`;
      }),
    ),
  ];
  const line: Span[] = [
    '過去的記錄裡，跟模板一模一樣的有 ',
    { num: `${exact.length}` },
    ' 筆',
    ...by(exact),
    `；形狀一樣、但${outside.length === 0 ? '有地址不在 registry 裡' : outsideWords(outside)}的有 `,
    { num: `${outside.length}` },
    ' 筆',
    ...by(outside),
    '；形狀不同的有 ',
    { num: `${misfits}` },
    misfits === 0 ? ' 筆。' : ' 筆，列在其他做法。',
  ];
  if (exact.length + outside.length === 0) return line;
  return [
    ...line,
    `${exact.length + outside.length === 1 ? '它成功執行：它是' : '這些交易全部成功執行：它們是'}從 ${searched.join('、')}的 Transfer 紀錄找到的，失敗的交易不會留下紀錄。`,
    ...(exact.length === 0 ? [] : [`一模一樣的最近 ${Math.min(exact.length, 3)} 筆：`, ...latest(exact), '。']),
    ...(outside.length === 0 ? [] : [`形狀一樣的最近 ${Math.min(outside.length, 3)} 筆：`, ...latest(outside), '。']),
  ];
}

function onlyName(ref: CardRef, context: Context): RegistryEntry | undefined {
  const names = refNames(ref, context.template, context.registry);
  return names.length === 1 ? context.registry.entries.get(names[0] as string) : undefined;
}


function promptStep(name: string, field: CardField, context: Context): NextStep {
  const step = (say: Inline, then: readonly Inline[] = []): NextStep => ({ say, command: undefined, then, hashes: false });
  const word = kindWord(field, context.template);
  const cardNewPrompt: Inline = word === name ? [{ code: name }] : [`${word}（`, { code: name }, '）'];
  switch (field.kind) {
    case 'contract': {
      const only = onlyName({ field: name, attribute: undefined }, context);
      if (only !== undefined) {
        return step(
          [...cardNewPrompt, '：它列出可選的合約，每個附完整地址。選 ', link(only), '，地址是 ', { mono: checksumAddress(only.address) }],
          [['列表的編號可能跟別人的不同，照名字選；也可以直接打名字 ', { code: only.name }, ' 。']],
        );
      }
      return step([...cardNewPrompt, `：它列出可選的${KIND_WORDS[field.scope.registryKind]}，每個附完整地址。選你要的那個，名字和完整地址都要對。`]);
    }
    case 'market':
      return step([...cardNewPrompt, '：它列出每個市場的 id、lltv 和每個組成的完整地址。選你要的市場，id 要對。']);
    case 'address':
    case 'recipient':
      return step([...cardNewPrompt, '：它列出你的 Safe 和地址簿裡的名字，每個附完整地址。選你要的那個，完整地址要對。']);
    case 'nonce':
      return step([...cardNewPrompt, '：打 Safe 交易的 nonce，純數字。']);
    case 'amount': {
      const token = field.of === 'eth' ? 'ETH' : (onlyName(field.of, context)?.name ?? before('你選的', refWord(context.template, field.of)));
      if (field.computed === undefined) {
        return step(
          [...cardNewPrompt, `：打 ${token} 的數量，用整顆幣，例如 `, { code: '1250.5' }, ' ；可以有千位逗號，例如 ', { code: '1,000,611.448606' }, ' 。'],
          [['它印出整顆和 base units 兩種寫法，核對數字是你要的。']],
        );
      }
      const { computed } = field;
      const margin = computed.margin === undefined ? '' : `，再加 ${percent(BigInt(computed.margin.bps), 10_000n)} 餘裕`;
      return step(
        [...cardNewPrompt, '：不用填。協議的 app 自己會填這個值，不會問使用者，所以程式自己算。'],
        [
          ['它在鏈上讀 ', { code: computed.read.fn.name }, `，兩個節點答案一樣才用，印出預期的 ${token} 數量，再${computed.bound === 'floor' ? '少' : '多'} ${percent(BigInt(slippageBps(computed)), 10_000n)}（協議預設的 ${percent(BigInt(computed.default.bps), 10_000n)}${margin}），${computed.bound === 'floor' ? '無條件捨去' : '無條件進位'}。`],
          ['預設值的來源：', { href: computed.default.source, label: shortUrl(computed.default.source) }, '。核對印出的預期數量跟最後的數字合理。'],
        ],
      );
    }
  }
}

function nextSection(context: Context): Section {
  const { template } = context;
  const fields = [...template.card];
  const typed = (field: CardField): boolean => field.kind === 'amount' || field.kind === 'nonce';
  const computed = (field: CardField): boolean => field.kind === 'amount' && field.computed !== undefined;
  const vault = context.inputs.subject.kind === 'template' && context.inputs.subject.vault !== undefined;
  const trial = fields.some(([, f]) => f.kind === 'amount' && f.computed === undefined) ? `（第一次用這個模板${vault ? '或這個金庫' : ''}，先用小額）` : '';
  const prompts = [
    ...fields.filter(([, f]) => !typed(f)),
    ...fields.filter(([, f]) => typed(f) && !computed(f)),
    ...fields.filter(([, f]) => computed(f)),
  ].map(([name, field]) => promptStep(name, field, context));
  const steps: NextStep[] = [
    {
      say: ['第一次用這個模板，或模板改過之後，先核准它'],
      command: `bin/kiss-sign template approve ${template.id}`,
      then: [['它印出模板、GitHub 上 main 的 commit 和模板的 keccak256。是你審過的那份才回答 ', { code: 'y' }, '。']],
      hashes: false,
    },
    ...(fields.some(([, f]) => f.kind === 'recipient')
      ? [
          {
            say: ['收款人不是你的 Safe 時，先把它加進地址簿。名字自己取，用小寫英文和 - 連接；地址從聊天以外的來源取得'],
            command: 'bin/kiss-sign book add <name> <address>',
            then: [['它印出名字和完整地址，問 ', { code: 'Add this entry? [y/N]' }, ' 。每個字元都跟聊天以外的來源核對過才打 ', { code: 'y' }, ' 。同一個收款人只要加一次。']],
            hashes: false,
          } satisfies NextStep,
        ]
      : []),
    {
      say: ['做卡片'],
      command: `bin/kiss-sign card new ${template.id}`,
      then: [['你這份 clone 的 ', { code: 'templates/' }, ' 或 ', { code: 'registry/' }, ' 跟 GitHub 上的 main 不一樣時，它什麼都不問就停下，叫你先跑 ', { code: 'git pull' }, ' 。']],
      hashes: false,
    },
    ...prompts,
    {
      say: ['它印出整張卡片，每個名字都附完整地址，最後問 ', { code: 'Is this what you mean to do? [y/N]' }, ' 。全部是你要的才打 ', { code: 'y' }, ' 。'],
      command: undefined,
      then: [['它印出 ', { code: 'Sealed card 0x…' }, ' ，這是卡片的 hash，下一步要用。']],
      hashes: false,
    },
    {
      say: [`在 Safe web app 提出交易${trial}，複製它的 safeTxHash，然後跑`],
      command: 'bin/kiss-sign verify --card <card hash> --safe-tx-hash <safeTxHash>',
      then: [
        [{ code: 'MATCH' }, '：它印出 safeTxHash 和一個網頁的路徑，網頁上有 domain hash、message hash 和比對清單，往下走。'],
        [{ code: 'MISMATCH' }, ' 或 ', { code: 'UNVERIFIABLE' }, '：不要簽。看它列出的檢查，再看本報告「', { href: anchor('review'), label: '待確認' }, '」裡 AI 的判斷，可能說明原因。'],
      ],
      hashes: false,
    },
    {
      say: ['加強等級：在獨立電腦上跑'],
      command: './check.sh <nonce>',
      then: [['它算出的 hash 跟硬體錢包比對；它的網頁上的比對清單跟 ', { code: 'verify' }, ' 網頁上的逐列比對。']],
      hashes: false,
    },
    { say: ['硬體錢包上的 domain hash 和 message hash，跟 ', { code: 'verify' }, ' 網頁上的逐字比對，一樣才簽。'], command: undefined, then: [], hashes: true },
  ];
  const tokenName = (token: TokenRef) => tokenOf(token, context)?.name ?? (token === 'eth' ? 'ETH' : before('你選的', refWord(template, token)));
  const automatic: Inline[] = [
    [`交易只有這 ${template.calls.length} 個呼叫，MultiSend 也一個個解開`],
    ['每個參數符合上面的規則，重新編碼要一模一樣'],
    ...template.effects.gives.map((e): Inline => [`模擬後 Safe 給出的 ${tokenName(e.token)} ${e.amount.kind === 'card' ? before('剛好是你填的', fieldWord(template, e.amount.field)) : e.amount.kind === 'all' ? '是全部餘額' : '多於 0'}`]),
    ...template.effects.gets.map((e): Inline => [`模擬後 Safe 收到 ${tokenName(e.token)}`]),
    ...(template.effects.gives.length + template.effects.gets.length === 0 ? [['模擬後 Safe 的餘額一點都不能變'] as Inline] : []),
    ...(template.nonce === undefined ? [] : [['Safe 交易的 nonce 是', ...ruleWords(template.nonce, context)] as Inline]),
    ['沒有任何授權在交易後變高'],
    ...template.effects.views.map((v): Inline => [
      { code: `${v.to}.${v.fn.name}` },
      `：${v.changes.map((c) => `${paramName(v.returns[c.value] as AbiParam, c.value)} ${{ increases: '增加', decreases: '減少', same: '不變' }[c.change]}`).join('、')}`,
    ]),
    ...(context.ledger.entries.length === 0 ? [] : [[`碰到的 ${new Set(context.ledger.entries.map((e) => e.name)).size} 個登記合約，程式碼還是 code pin 記錄的那份`] as Inline]),
  ];
  return { anchor: anchor('next'), label: '下一步', count: undefined, body: { kind: 'next', steps, automatic } };
}

/** The claims of the template's free arguments, in claim order; empty when every argument is bound. */
function freeClaims(template: Template): Set<FreeClaim> {
  const found = new Set<FreeClaim>();
  const visit = (rule: Rule): void => {
    if (rule.kind === 'free') found.add(rule.claim);
    if (rule.kind === 'equals') visit(rule.rule);
    if (rule.kind === 'call') rule.call.args.forEach(visit);
    if (rule.kind === 'items') rule.items.forEach(visit);
    if (rule.kind === 'fields') rule.fields.forEach(visit);
  };
  for (const call of template.calls) {
    visit(call.to);
    visit(call.value);
    if (call.data !== 'empty') call.data.args.forEach(visit);
  }
  return new Set((['scalar', 'proof', 'unread'] as const).filter((claim) => found.has(claim)));
}

/** 參數保護 when no test transaction is recorded, from the template. */
const unrecordedParams = (template: Template): string =>
  freeClaims(template).size > 0
    ? '模板有不限的參數，但沒有換值測試的記錄，程式沒有測過它們。'
    : '模板沒有不限的參數：每個參數都綁定卡片或固定值，沒有參數要換值測試，所以沒有換值測試的記錄。每次簽名，verify 都把每個綁定的參數逐一改掉，確認都變成 MISMATCH。';

function stripItems(ledger: Ledger, template: Template): StripItem[] {
  const subjects = new Set(ledger.entries.map((e) => e.name)).size;
  const recorded = ledger.results.some((r) => r.line === 'params');
  const named = (match: (result: Result) => boolean): string[] => [...new Set(ledger.results.flatMap((r) => (match(r) && r.about.kind === 'entry' ? [r.about.entry.name] : [])))];
  const notCalled = named((r) => r.finding.kind === 'not-called');
  const unprovable = named((r) => r.finding.kind === 'routed-proxy');
  const today = named((r) => r.id.endsWith('/code.today'));
  const routed = ledger.entries.filter((entry) => entry.routes !== undefined).map((entry) => entry.name);
  const explain: Readonly<Record<StripLine, (passed: number, counted: number) => string>> = {
    sources: (p, c) =>
      p === c
        ? `${c === 1 ? '這個地址' : `${c} 個地址都`}至少在 ${MIN_CONFIRMATIONS} 個地方確認：官方頁、協議 API、CoinGecko 或金庫的登記工廠列出同一個地址。`
        : `${c - p} 個地址有結果要你看，見「待確認」。${p === 0 ? '' : p === 1 ? `另外那個地址至少在 ${MIN_CONFIRMATIONS} 個地方確認。` : `其餘 ${p} 個都至少在 ${MIN_CONFIRMATIONS} 個地方確認。`}`,
    abi: () =>
      `Sourcify 的原始碼用固定版本的編譯器重新編譯，跟鏈上的程式碼一模一樣，所以解碼交易用的函式定義確實屬於這些合約。${
        notCalled.length === 0 ? '' : `${notCalled.join('、')} 沒有呼叫直接打到，也不用它的函式定義解碼，所以沒有證明，不算在內；它跑的程式碼在「合約沒被換掉」比對。`
      }${unprovable.length === 0 ? '' : `${unprovable.join('、')} 依函式選擇器把呼叫分給各自的實作，沒有一份程式碼能證明，不算在內；它的 routes 在「合約沒被換掉」比對。`}`,
    code: () =>
      `每次簽名都確認${subjects === 1 ? '這個合約' : `這 ${subjects} 個合約`}還是研究時那份程式碼。被升級或換掉就擋下。${
        today.length === 0 ? '' : `${today.join('、')} 沒有 ABI 證明比對它今天的程式碼，報告另外在最新區塊讀它跑的程式碼，跟 code pin 現在那一份比對。`
      }${routed.length === 0 ? '' : `${routed.join('、')} 依函式選擇器把呼叫分給各自的實作：seeds 接到的每個實作和它的函式清單也一樣確認，沒有 seed 接到的實作不檢查。`}`,
    params: (_, c) => (!recorded ? unrecordedParams(template) : `程式把 ${c} 筆測試交易的每個綁定參數逐一改掉，都要變成 MISMATCH；不限的參數換成別的值，結果要跟原本一樣。`),
  };
  const items = strip(ledger)
    .filter((s) => s.line === 'params' || ledger.results.some((r) => r.line === s.line))
    .map(
    (s): StripItem => ({ line: s.line, name: STRIP_NAMES[s.line], state: s.state, count: s.line === 'params' && !recorded ? '沒有測試' : s.counted === 0 ? undefined : `${s.passed} / ${s.counted}`, explain: explain[s.line](s.passed, s.counted) }),
  );
  return [...items, { line: 'providers', name: STRIP_NAMES.providers, state: 'ok', count: undefined, explain: '所有鏈上資料都同時問兩家節點，答案不一樣就不給結果。' }];
}

/**
 * The signer's page, from the report's inputs and the raw notes.json. The ledger judges every result; notes.json is
 * parsed against the scope the template and the ledger derive, so it cannot name what the page does not show nor leave
 * out a review the page needs. Throws NotesError for notes the program refuses.
 */
export function buildPage(inputs: HtmlInputs, rawNotes: unknown, title: ReportTitle): Page {
  const { subject, registry } = inputs;
  if (subject.kind !== 'template') throw new Error('an HTML report is written for a template only');
  const { template } = subject;
  const ledger = judge(inputs, inputs.fixtures);
  const notes = parseNotes(rawNotes, notesScope(inputs, ledger, template));
  const { example } = inputs;
  const context: Context = {
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
    id: subject.vault === undefined ? template.id : `${template.id} · ${subject.vault.name}`,
    header: {
      title: research(notes.title),
      summary: research(notes.summary),
      strip: stripItems(ledger, template),
      verdict: { state: worst(ledger.results), text: research(notes.verdict.text, [], notes.verdict.status === 'safe' ? 'AI 研究：可以用' : 'AI 研究：要小心') },
    },
    sections,
    footer: ['由 ', { code: title.command }, ' 從 ', ...sources.flatMap((s, i): Span[] => [...(i === 0 ? [] : ['、']), { code: s }]), ` 寫出，資料在 ${inputs.fetched} 讀取。不要手改；`, { code: 'pnpm test' }, ` 會重算並比對。${NOTES_FILE} 是 AI 寫的，標 AI 的文字沒有程式檢查。`],
  };
}
