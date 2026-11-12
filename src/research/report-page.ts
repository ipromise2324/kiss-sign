import { hexToBytes } from '@noble/hashes/utils.js';
import { resolveRef } from '../card.ts';
import type { ResolvedCard, ResolvedValue } from '../card.ts';
import { wholeTokens } from '../chain/decimals.ts';
import { castValue } from '../decode/cast.ts';
import type { AbiParam } from '../decode/abi.ts';
import { paramName } from '../decode/abi.ts';
import type { AbiValue } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import { MARKET_PARAMS, parseHttpsUrl } from '../registry.ts';
import type { HttpsUrl, Market, Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { decodeTemplateCall } from '../template/check.ts';
import type { FixtureJudgement } from '../template/perturb.ts';
import { refNames } from '../template/template.ts';
import type { CardRef, ConstValue, Rule, Template, TemplateCall, TokenRef } from '../template/template.ts';
import type { FieldFact } from './erc7730.ts';
import { addressRows, confidence, forSigner, judge, needsSigner, sourcesOf, stateOf, strip, worst } from './ledger.ts';
import type { Confidence, FindingKind, Ledger, ProgramSource, Result, ResultId, State, StripLine } from './ledger.ts';
import { NOTES_FILE, argumentTree, notesPath, notesScope, parseNotes } from './notes.ts';
import type { ArgNode, Notes } from './notes.ts';
import { factsScope } from './protocol-facts.ts';
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

export type RailCount = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'state'; readonly state: State | 'ask'; readonly n: number };

export type Page = {
  readonly id: string;
  readonly header: Header;
  readonly sections: readonly Section[];
  readonly footer: Inline;
};

export type Section = { readonly anchor: Anchor; readonly label: string; readonly count: RailCount | undefined; readonly body: Body };

export type Body =
  | { readonly kind: 'flow'; readonly flow: Flow }
  | { readonly kind: 'protocol'; readonly block: ProtocolBlock }
  | { readonly kind: 'review'; readonly rows: readonly ReviewRow[]; readonly judgments: readonly Judgment[] }
  | { readonly kind: 'wallet'; readonly calls: readonly WalletCall[]; readonly lines: readonly Inline[] }
  | { readonly kind: 'addresses'; readonly open: readonly AddressRow[]; readonly folded: readonly AddressRow[] }
  | { readonly kind: 'past'; readonly recordings: readonly PastRecording[] }
  | { readonly kind: 'signing'; readonly steps: readonly Inline[]; readonly automatic: readonly Inline[] };

export type Header = {
  readonly title: AiText;
  readonly summary: AiText;
  readonly strip: readonly StripItem[];
  /** The program's worst state over every result, never the AI's status, beside the AI's one line. */
  readonly verdict: { readonly state: State; readonly text: AiText };
};

export type StripItem = { readonly line: StripLine | 'providers'; readonly name: string; readonly state: State; readonly count: string | undefined; readonly explain: string };

export type Who = 'you-type' | 'you-pick' | 'fixed' | 'free';
export type Chip = { readonly who: Who; readonly label: string };

export type ArgRow = {
  readonly key: string;
  readonly name: string;
  readonly chips: readonly Chip[];
  /** As `cast decode-calldata` prints it; `example` when it comes from the first recorded test transaction. */
  readonly value: { readonly cast: string; readonly example: boolean } | undefined;
  readonly words: Inline;
  readonly qualifier: Inline | undefined;
  readonly id: Inline | undefined;
  readonly ai: AiText;
  readonly parts: readonly { readonly label: Inline | undefined; readonly rows: readonly ArgRow[] }[];
};

export type CallBlock = { readonly n: number; readonly contract: string; readonly fn: string; readonly selector: Hex; readonly sends: Inline | undefined; readonly args: readonly ArgRow[] };

export type AfterRow = { readonly label: Inline; readonly value: Inline; readonly note: Inline; readonly gains: boolean };

export type Lifeline = { readonly name: string; readonly role: string };
export type Arrow =
  | { readonly kind: 'call'; readonly n: number; readonly to: number; readonly fn: string }
  | { readonly kind: 'inside'; readonly from: number; readonly to: number; readonly text: AiText }
  | { readonly kind: 'gets'; readonly from: number; readonly text: string };
export type Sequence = { readonly lifelines: readonly Lifeline[]; readonly arrows: readonly Arrow[]; readonly narration: string };

export type Flow = { readonly diagram: Sequence; readonly example: Inline | undefined; readonly calls: readonly CallBlock[]; readonly after: readonly AfterRow[] };

export type ProtocolRow = {
  readonly label: string;
  readonly value: Inline;
  readonly sub: Inline | undefined;
  readonly ai: AiText | undefined;
  readonly nested: readonly { readonly label: Inline; readonly value: Inline; readonly ai: AiText | undefined }[];
};
export type ProtocolBlock = { readonly read: string; readonly intro: AiText; readonly rows: readonly ProtocolRow[]; readonly sources: readonly { readonly label: string; readonly href: HttpsUrl | undefined }[] };

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

export type SourceLine =
  | { readonly by: 'program'; readonly label: string; readonly href: HttpsUrl | undefined; readonly state: State; readonly phrase: string | undefined }
  | { readonly by: 'ai'; readonly text: AiText; readonly state: State };

export type AddressRow = {
  readonly anchor: Anchor;
  readonly name: string;
  readonly state: State;
  readonly role: AiText | undefined;
  readonly confidence: Confidence;
  readonly reviewed: 'AI 已確認' | 'AI 有疑慮' | undefined;
  readonly address: string;
  readonly sources: readonly SourceLine[];
};

export type PastRecording = { readonly file: string; readonly count: string; readonly rows: readonly { readonly label: string; readonly value: Inline; readonly note: Inline }[] };

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
const FIELD_WORDS: Readonly<Record<string, string>> = { amount: '金額', nonce: 'nonce' };
const FREE_WORDS: Readonly<Record<Extract<Rule, { kind: 'free' }>['claim'], string>> = {
  scalar: '換成別的值測過，結果不變或交易失敗',
  proof: '合約會驗證它，換成別的值交易就失敗',
  unread: '合約不讀它，換成別的值結果一樣',
};
const SOURCE_LABELS: Readonly<Record<Exclude<ProgramSource, 'page'>, string>> = { api: '協議 API', coingecko: 'CoinGecko', defillama: 'DefiLlama' };
const AI_RESULTS = { pass: 'ok', attention: 'warn', fail: 'bad' } as const satisfies Readonly<Record<string, State>>;

/** What the program says about a result for the signer: a title naming what disagreed or could not be read, and why. */
const FINDING_WORDS: { readonly [K in FindingKind]?: { readonly title: string; readonly why: string } } = {
  'site-differs': { title: '網站跟 DefiLlama 列的不同', why: '這個頁面的網域或 GitHub 組織，不是 DefiLlama 列給這個協議的。' },
  'other-coin': { title: '地址跟 CoinGecko 不同', why: 'CoinGecko 在這個地址列的不是登記的那個幣，或列了不只一個。' },
  'other-answer': { title: '協議 API 回的是別的地址', why: '協議 API 在登記的路徑回了另一個地址、沒有地址，或不是 JSON。' },
  'pin-not-run': { title: '鏈上跑的不是登記的程式碼', why: '鏈上在這段區塊範圍跑的程式碼，跟 code pin 記錄的不一樣。' },
  'proof-not-pin': { title: '證明的程式碼不是現在登記的', why: 'ABI 證明用的程式碼，不是 code pin 現在的那一份。' },
  refused: { title: 'ABI 證明被拒絕', why: '重新編譯 Sourcify 的原始碼，得不到鏈上的程式碼。' },
  'judged-otherwise': { title: '測試交易現在的判定不同', why: '用現在的模板重跑記錄的測試交易，結果跟記錄時不一樣。' },
  'no-answer': { title: '讀取沒有回應', why: '程式重試後仍讀不到答案，記為 UNVERIFIABLE。' },
  'page-unread': { title: '程式讀不到官方頁上的地址', why: '程式只讀不跑腳本的原始網頁，在登記的標籤旁邊找不到這個地址。' },
  'url-holds-address': { title: '來源網址本身含有地址', why: '網址裡帶著地址，頁面上的地址可能只是照網址印出來，不能證明什麼。' },
  'site-not-compared': { title: '沒辦法比對來源網站', why: 'DefiLlama 找不到這個協議，或網域無法判斷。' },
  'no-second-source': { title: '沒有第二個來源', why: '沒有第二個來源能證明這個來源屬於這個協議。' },
  'no-coin': { title: 'CoinGecko 沒有列這個地址', why: 'CoinGecko 在這個地址沒有列幣，或登記沒有給 CoinGecko id。' },
  'commit-unconfirmed': { title: 'GitHub commit 沒確認', why: 'GitHub 頁面沒有釘在預設分支上的 commit。' },
  'page-not-fetched': { title: '文件頁沒讀到', why: '程式沒有這個文件頁的內容。' },
  'name-not-on-page': { title: '文件頁上找不到函式名稱', why: '文件頁的原始網頁裡沒有這個函式的名稱。' },
  'no-chain-result': { title: '程式碼區段沒有鏈上結果', why: '這段 code pin 沒有從鏈上讀到判定。' },
  'not-pinned': { title: '沒有 code pin', why: '這個合約沒有登記程式碼，簽名時會是 UNVERIFIABLE。' },
  'no-abi-case': { title: '沒有 ABI 證明的紀錄', why: 'testdata/abi 沒有這個合約的 ABI 證明，程式沒有比對它的原始碼。' },
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
  return { words: [{ num: tokens(amount, decimals) }, ` ${token.name}`], qualifier: [`${decimals} 位小數`] };
}

/** The registry names a call's `to` can be, and the name the page shows for it. */
function targetOf(rule: Rule, context: Context): { readonly label: string; readonly names: readonly string[] } {
  if (rule.kind === 'contract') return { label: rule.name, names: [rule.name] };
  if (rule.kind !== 'card') return { label: '?', names: [] };
  const names = refNames(rule.ref, context.template, context.registry);
  if (names.length === 1) return { label: names[0] as string, names };
  const picked = context.card === undefined ? undefined : resolveRef(rule.ref, context.card, context.registry);
  const name = picked === undefined || 'problem' in picked || picked.kind !== 'address' ? undefined : context.registry.byAddress.get(picked.address)?.name;
  return { label: name ?? `card.${rule.ref.field}${rule.ref.attribute === undefined ? '' : `.${rule.ref.attribute}`}`, names };
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

const chipLabel = (who: Who, field: string | undefined): string =>
  who === 'free' ? 'app 填，不限' : field === undefined || who === 'fixed' ? SHORT[who] : `${SHORT[who]}：${FIELD_WORDS[field] ?? field}`;

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
  if (distinct.length <= 1) return distinct.map((leaf) => ({ who: leaf.who, label: chipLabel(leaf.who, leaf.field) }));
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

function cardWords(ref: CardRef, key: string, context: Context): { readonly words: Inline; readonly qualifier: Inline | undefined } {
  const field = context.template.card.get(ref.field);
  const example = context.values.get(key);
  if (field?.kind === 'amount') {
    if (example?.kind !== 'uint') return { words: ['你填的金額'], qualifier: undefined };
    return amountWords(example.value, field.of, context);
  }
  if (field?.kind === 'nonce') return { words: ['你填的 nonce'], qualifier: undefined };
  const picked = example?.kind === 'address' ? context.registry.byAddress.get(example.value) : undefined;
  if (picked !== undefined) return { words: [link(picked)], qualifier: [`你選的 ${ref.field}`] };
  if (field?.kind === 'market' && ref.attribute === 'lltv' && example?.kind === 'uint') return { words: [lltvWords(example.value)], qualifier: [`你選的 ${ref.field}`] };
  return { words: [`你選的 ${ref.field}${ref.attribute === undefined ? '' : ` 的 ${ref.attribute}`}`], qualifier: undefined };
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
  if (node.rule.kind === 'const') return { cast: constCast(node.rule.value), example: false };
  if (node.rule.kind === 'contract') return { cast: checksumAddress((context.registry.entries.get(node.rule.name) as RegistryEntry).address), example: false };
  const example = context.values.get(node.key);
  return example === undefined ? undefined : { cast: castValue(example), example: true };
}

function marketPartRows(node: ArgNode, market: Market, context: Context): ArgRow[] {
  return node.children.map((child, i) => {
    const part = MARKET_PARAMS[i] as (typeof MARKET_PARAMS)[number];
    const entry = part === 'lltv' ? undefined : market[part];
    return {
      key: child.key,
      name: child.name,
      chips: [],
      value: { cast: entry === undefined ? market.lltv.toString() : checksumAddress(entry.address), example: false },
      words: entry === undefined ? [lltvWords(market.lltv)] : [link(entry)],
      qualifier: undefined,
      id: undefined,
      ai: fieldsNote(context, child.key),
      parts: [],
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
      words: shown === undefined ? [`你選的 ${market}`] : [marketWords(shown)],
      qualifier: [`${MARKET_PARAMS.length} 個值，任何一個不同就 MISMATCH`],
      id: shown === undefined ? undefined : ['market id ', { mono: shown.id }],
      ai: fieldsNote(context, node.key),
      parts: markets.map((m) => ({ label: markets.length === 1 ? undefined : [marketWords(m), '，market id ', { mono: m.id }], rows: marketPartRows(node, m, context) })),
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
  return ok ? values : new Map();
}

function lifelines(context: Context): { readonly lines: Lifeline[]; readonly names: (readonly string[])[]; readonly callTo: number[] } {
  const { template, registry } = context;
  const lines: Lifeline[] = [{ name: '你的 Safe', role: '發起' }];
  const names: (readonly string[])[] = [['safe']];
  const add = (label: string, of: readonly string[]): number => {
    const at = lines.findIndex((l) => l.name === label);
    if (at !== -1) return at;
    const entry = registry.entries.get(label);
    lines.push({ name: label, role: entry === undefined ? '你選的合約' : KIND_WORDS[entry.kind] });
    names.push(of);
    return lines.length - 1;
  };
  const callTo = template.calls.map((call) => {
    const target = targetOf(call.to, context);
    return add(target.label, target.names);
  });
  for (const view of template.effects.views) add(view.to, [view.to]);
  return { lines, names, callTo };
}

function sequence(context: Context): Sequence {
  const { template, notes } = context;
  const { lines, names, callTo } = lifelines(context);
  const at = (name: string): number => names.findIndex((of) => of.includes(name));
  const arrows: Arrow[] = [];
  const narration: string[] = [];
  template.calls.forEach((call, i) => {
    const fn = call.data === 'empty' ? '轉 ETH' : call.data.fn.name;
    arrows.push({ kind: 'call', n: i + 1, to: callTo[i] as number, fn });
    narration.push(`呼叫 ${i + 1}：Safe 呼叫 ${lines[callTo[i] as number]?.name} 的 ${fn}。`);
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

function sends(call: TemplateCall, context: Context, n: number): Inline | undefined {
  if (call.value.kind === 'const' && call.value.value.kind === 'uint' && call.value.value.value === 0n) return undefined;
  const example = context.inputs.example === undefined ? undefined : unwrapSafeTx(context.inputs.example.tx);
  const inner = example !== undefined && 'calls' in example ? example.calls[n - 1] : undefined;
  const { words } = leafWords({ key: `${n}.value`, name: 'value', param: undefined, rule: call.value, children: [] }, context);
  return ['送出 ETH：', ...words, ...(inner === undefined ? [] : ['，例如 ', { num: wholeTokens(inner.value, 18) }, ' ETH'])];
}

function afterRows(context: Context): AfterRow[] {
  const { template } = context;
  const amountOf = (effect: Template['effects']['gives'][number], sign: string): Inline => {
    if (effect.amount.kind === 'all') return ['全部'];
    if (effect.amount.kind === 'positive') return ['多於 0'];
    const value = context.card?.get(effect.amount.field);
    if (value?.kind !== 'amount') return ['你填的金額'];
    const { words } = amountWords(value.value, effect.token, context);
    return [sign, ...words];
  };
  const note = (effect: Template['effects']['gives'][number]): Inline => {
    const amount = effect.amount.kind === 'card' ? '剛好你填的金額' : effect.amount.kind === 'all' ? '全部餘額，交易後一個都不剩' : '要多於 0';
    return effect.to === undefined ? [amount] : [amount, `，給你選的 ${effect.to.field}`];
  };
  const name = (token: TokenRef) => tokenOf(token, context)?.name ?? (token === 'eth' ? 'ETH' : `你選的 ${token.field}`);
  const rows: AfterRow[] = [
    ...template.effects.gives.map((e) => ({ label: [`Safe 的 ${name(e.token)}`], value: amountOf(e, '−'), note: note(e), gains: false })),
    ...template.effects.gets.map((e) => ({ label: [`Safe 的 ${name(e.token)}`], value: amountOf(e, '+'), note: note(e), gains: true })),
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

function flowSection(context: Context): Section {
  const { template } = context;
  const calls = argumentTree(template).map(({ n, node, args }): CallBlock => {
    const call = template.calls[n - 1] as TemplateCall;
    return { n, contract: targetOf(call.to, context).label, fn: node.fn.name, selector: node.fn.selector, sends: sends(call, context, n), args: args.map((arg) => argRow(arg, context, true)) };
  });
  const { example } = context.inputs;
  let lead: Inline | undefined;
  if (example !== undefined && context.values.size > 0) {
    const amounts = [...template.card].flatMap(([field, card]) => {
      const value = context.card?.get(field);
      return card.kind === 'amount' && value?.kind === 'amount' ? [amountWords(value.value, card.of, context).words] : [];
    });
    lead = ['你填、你選和 app 填的值取自第一筆測試交易 ', { code: example.name }, ...(amounts.length === 0 ? [] : ['，金額 ', ...amounts.flatMap((a, i) => [...(i === 0 ? [] : ['、']), ...a])]), '。'];
  }
  return {
    anchor: anchor('flow'),
    label: '流程',
    count: { kind: 'text', text: `${template.calls.length} 個呼叫` },
    body: { kind: 'flow', flow: { diagram: sequence(context), example: lead, calls, after: afterRows(context) } },
  };
}

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

function reviewTitle(result: Result, context: Context): { readonly title: Inline; readonly why: Inline } {
  const words = FINDING_WORDS[result.finding.kind] ?? { title: '要你看', why: '' };
  if (result.about.kind === 'fixture') {
    const detail = result.finding.kind === 'judged-otherwise' ? ` ${result.finding.detail}` : '';
    return { title: ['測試交易 ', { code: result.about.name }, `：${words.title}`], why: [`${words.why}${detail}`] };
  }
  const name = result.about.entry.name;
  const doc = /\/doc\.(0x[0-9a-f]{8})\.(\w+)$/.exec(result.id);
  if (doc !== null && context.inputs.subject.kind === 'template') {
    const fn = context.inputs.subject.docs.find((d) => d.fn.selector === doc[1])?.fn.name ?? doc[1];
    return { title: [`${name}：文件頁 `, { code: fn as string }, `，${words.title}`], why: [words.why] };
  }
  const span = /\/code\.(\d+)$/.exec(result.id);
  const where = span === null ? '' : `（第 ${span[1]} 段）`;
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
  const count: RailCount = rows.length > 0 ? { kind: 'state', state: worst(forSigner(ledger)), n: rows.length + judgments.length } : { kind: 'state', state: judgments.length > 0 ? 'ask' : 'ok', n: judgments.length };
  return { anchor: anchor('review'), label: '待確認', count, body: { kind: 'review', rows, judgments } };
}

const WALLET_WORDS: Readonly<Record<string, string>> = {
  assets: '金額',
  amount: '金額',
  value: '金額',
  shares: '份額',
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
      const kind = context.template.card.get(rule.ref.field)?.kind;
      const verb = kind === 'amount' || kind === 'nonce' ? '你填的' : '你選的';
      return [`${verb} ${rule.ref.field}${rule.ref.attribute === undefined ? '' : ` 的 ${rule.ref.attribute}`}`];
    }
    case 'free':
      return ['不限'];
    case 'equals':
      return ['跟 ', { code: rule.path }, ' 同一個數'];
    case 'share-price':
      return [rule.bound === 'max' ? '價格上限' : '價格下限'];
    case 'call':
    case 'items':
    case 'fields':
      return ['見上方'];
  }
}

function walletSection(context: Context): Section {
  const { template, registry, inputs } = context;
  const reports = inputs.erc7730.reports;
  const lines: Inline[] = [];
  const calls = argumentTree(template).map(({ n, node, args }): WalletCall => {
    const call = template.calls[n - 1] as TemplateCall;
    const target = targetOf(call.to, context);
    const title: Inline = [`${n} ${target.label}.${node.fn.name}`];
    const fn = reports
      .filter((r) => target.names.includes(r.entry.name) || registry.entries.get(target.label)?.address === r.entry.address)
      .flatMap((r) => r.descriptors.flatMap((d) => d.functions))
      .find((f) => f.selector === node.fn.selector);
    if (fn === undefined) return { n, title, rows: 'no-descriptor' };
    const flat = (facts: readonly FieldFact[], prefix = ''): { path: string; format: string; visible: string }[] =>
      facts.flatMap((f) => (f.kind === 'group' ? flat(f.fields, `${prefix}${f.path}.`) : [{ path: `${prefix}${f.path}`, format: f.format, visible: f.visible }]));
    const shown = flat(fn.fields).filter((f) => f.visible !== 'never' && f.format !== 'none');
    const find = (path: string): ArgNode | undefined => {
      const segments = path.replace(/^#\./, '').split('.');
      let nodes: readonly ArgNode[] = args;
      let found: ArgNode | undefined;
      for (const segment of segments) {
        found = nodes.find((a) => a.name === segment);
        if (found === undefined) return undefined;
        nodes = found.children;
      }
      return found;
    };
    const rows = shown.map((field) => {
      if (field.path === '@.value') return { label: ['送出的 ETH'], value: ruleWords(call.value, context) };
      const target = find(field.path);
      if (target === undefined) return { label: ['不是這個函式的參數'], value: ['—'] };
      return { label: [Object.hasOwn(WALLET_WORDS, target.name) ? (WALLET_WORDS[target.name] as string) : target.name], value: ruleWords(target.rule, context) };
    });
    const shownPaths = shown.map((f) => f.path.replace(/^#\./, ''));
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
  lines.push(['現在的硬體錢包解不開 Safe 的 MultiSend，簽名時比對 hash。']);
  return { anchor: anchor('wallet'), label: '錢包顯示', count: undefined, body: { kind: 'wallet', calls, lines } };
}

function addressSection(context: Context): Section {
  const { ledger, notes } = context;
  const row = (entry: RegistryEntry): AddressRow => {
    const results = ledger.results.filter((r) => r.about.kind === 'entry' && r.about.entry.name === entry.name);
    const level = confidence(ledger, entry);
    const reviews = results.filter(needsSigner).flatMap((r) => {
      const review = notes.reviews.get(r.id);
      return review === undefined ? [] : [review];
    });
    const note = notes.entries?.get(entry.name);
    const program = sourcesOf(ledger, entry).map(
      (line): SourceLine => ({ by: 'program', label: line.source === 'page' ? shortUrl(entry.source) : SOURCE_LABELS[line.source], href: line.link, state: line.state, phrase: line.phrase }),
    );
    const ai = (note?.sources ?? []).map((s): SourceLine => ({ by: 'ai', text: research(s.text, [s.url], 'AI'), state: AI_RESULTS[s.result] }));
    return {
      anchor: entryAnchor(entry.name),
      name: entry.name,
      state: worst(results),
      role: note?.role === undefined ? undefined : research(note.role),
      confidence: level,
      reviewed: reviews.length === 0 ? undefined : reviews.some((r) => r.status === 'concern') ? 'AI 有疑慮' : 'AI 已確認',
      address: checksumAddress(entry.address),
      sources: [...program, ...ai],
    };
  };
  const { open, folded } = addressRows(ledger);
  return {
    anchor: anchor('addresses'),
    label: '地址',
    count: { kind: 'text', text: `${ledger.entries.length}` },
    body: { kind: 'addresses', open: open.map(row), folded: folded.map(row) },
  };
}

function pastSection(context: Context): Section {
  const recordings = context.inputs.pastTxs.map(({ file, run }): PastRecording => {
    const studied = run.studies.filter((s) => s.kind === 'fit' || s.kind === 'misfit');
    const of = (kind: 'safe' | 'eoa') => {
      const group = studied.filter((s) => s.sender.kind === kind);
      return { fit: group.filter((s) => s.kind === 'fit').length, all: group.length, senders: new Set(group.map((s) => s.sender.address)).size };
    };
    const [eoa, safe] = [of('eoa'), of('safe')];
    const bySource = (source: string) => [...run.found.values()].filter((s) => s.includes(source as never)).length;
    const [alchemy, etherscan] = [bySource('alchemy'), bySource('etherscan')];
    const same = [...run.found.values()].every((s) => s.length === 2);
    return {
      file,
      count: `找到 ${run.found.size} 筆，研究 ${run.studies.length} 筆`,
      rows: [
        { label: 'EOA 直接呼叫', value: [{ num: `${eoa.fit} / ${eoa.all}` }, ' 符合'], note: [`${eoa.senders} 個地址`] },
        { label: 'Safe', value: [{ num: `${safe.fit} / ${safe.all}` }, ' 符合'], note: [`${safe.senders} 個 Safe`] },
        {
          label: '搜尋來源',
          value: [same ? 'Alchemy 和 Etherscan 找到的完全一樣' : 'Alchemy 和 Etherscan 找到的不一樣'],
          note: [{ num: `${alchemy} ${same ? '=' : '≠'} ${etherscan}` }],
        },
      ],
    };
  });
  return { anchor: anchor('past'), label: '過去交易', count: undefined, body: { kind: 'past', recordings } };
}

function signingSection(context: Context): Section {
  const { template } = context;
  const fields = [...template.card].map(([field, card]) => `${card.kind === 'amount' || card.kind === 'nonce' ? '填' : '選'} ${field}`);
  const steps: Inline[] = [
    ['用 ', { code: `bin/kiss-sign card new ${template.id}` }, ` 做卡片：${fields.join('、')}。第一次先填小額。`],
    ['跑 ', { code: 'verify' }, '，要印出 ', { code: 'MATCH' }, '。'],
    ['硬體錢包上的 domain hash 和 message hash，跟 ', { code: 'verify' }, ' 印的逐字比對，一樣才簽。'],
  ];
  const tokenName = (token: TokenRef) => tokenOf(token, context)?.name ?? (token === 'eth' ? 'ETH' : `你選的 ${token.field}`);
  const automatic: Inline[] = [
    [`交易只有這 ${template.calls.length} 個呼叫，MultiSend 也一個個解開`],
    ['每個參數符合上面的規則，重新編碼要一模一樣'],
    ...template.effects.gives.map((e): Inline => [`模擬後 Safe 給出的 ${tokenName(e.token)} ${e.amount.kind === 'card' ? '剛好是你填的金額' : e.amount.kind === 'all' ? '是全部餘額' : '多於 0'}`]),
    ...template.effects.gets.map((e): Inline => [`模擬後 Safe 收到 ${tokenName(e.token)}`]),
    ['沒有任何授權在交易後變高'],
    ...template.effects.views.map((v): Inline => [
      { code: `${v.to}.${v.fn.name}` },
      `：${v.changes.map((c) => `${paramName(v.returns[c.value] as AbiParam, c.value)} ${{ increases: '增加', decreases: '減少', same: '不變' }[c.change]}`).join('、')}`,
    ]),
    [`碰到的 ${new Set(context.ledger.entries.map((e) => e.name)).size} 個登記合約，程式碼還是 code pin 記錄的那份`],
  ];
  return { anchor: anchor('sign'), label: '簽名', count: undefined, body: { kind: 'signing', steps, automatic } };
}

function stripItems(ledger: Ledger): StripItem[] {
  const subjects = new Set(ledger.entries.map((e) => e.name)).size;
  const explain: Readonly<Record<StripLine, (passed: number, counted: number) => string>> = {
    sources: (p, c) =>
      p === c
        ? `程式在 ${c} 個地址的來源頁讀到登記的地址；有協議 API 或 CoinGecko 的，也是同一個地址。`
        : `${c - p} 個地址有結果要你看，見「待確認」。其餘 ${p} 個在來源頁讀到登記的地址。`,
    abi: () => 'Sourcify 的原始碼用固定版本的編譯器重新編譯，跟鏈上的程式碼一模一樣，所以解碼交易用的函式定義確實屬於這些合約。',
    code: () => `每次簽名都確認這 ${subjects} 個合約還是研究時那份程式碼。被升級或換掉就擋下。`,
    params: (_, c) => `程式把 ${c} 筆測試交易的每個綁定參數逐一改掉，都要變成 MISMATCH；不限的參數換成別的值，結果要跟原本一樣。`,
  };
  const items = strip(ledger).map(
    (s): StripItem => ({ line: s.line, name: STRIP_NAMES[s.line], state: s.state, count: s.counted === 0 ? undefined : `${s.passed} / ${s.counted}`, explain: explain[s.line](s.passed, s.counted) }),
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
  const sections = [flowSection(context), ...protocolSections(context), reviewSection(context), walletSection(context), addressSection(context), pastSection(context), signingSection(context)];
  const sources = [...title.sources, 'testdata/perturb', 'testdata/safe-tx', notesPath(template.id)];
  return {
    id: template.id,
    header: {
      title: research(notes.title),
      summary: research(notes.summary),
      strip: stripItems(ledger),
      verdict: { state: worst(ledger.results), text: research(notes.verdict.text, [], notes.verdict.status === 'safe' ? 'AI 研究：可以用' : 'AI 研究：要小心') },
    },
    sections,
    footer: ['由 ', { code: title.command }, ' 從 ', ...sources.flatMap((s, i): Span[] => [...(i === 0 ? [] : ['、']), { code: s }]), ` 寫出，資料在 ${inputs.fetched} 讀取。不要手改；`, { code: 'pnpm test' }, ` 會重算並比對。${NOTES_FILE} 是 AI 寫的，標 AI 的文字沒有程式檢查。`],
  };
}
