import { percentText, resolveRef } from '../card.ts';
import type { ResolvedCard, ResolvedValue } from '../card.ts';
import { groupedTokens } from '../chain/decimals.ts';
import { CSS, Html, SYMBOLS, h, icon } from '../research/report-html.ts';
import type { State } from '../research/ledger.ts';
import { settingsChange } from '../floor/summary.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import { PERMIT2_MAX, UNLIMITED_ERC20 } from '../floor/floor.ts';
import { HTML_LANG } from '../language.ts';
import type { Language } from '../language.ts';
import type { Expectations, Expected, KeptSeen } from '../simulate/effects.ts';
import type { CallScan } from '../simulate/simulate.ts';
import type { Rule, Template } from '../template/template.ts';
import { CHECKLIST_CSS, checklist, checklistHtml, visible } from './checklist.ts';
import { amountToken, signedMessages } from './expected.ts';
import type { AmountToken, CallTree } from './expected.ts';
import type { CheckName, CheckState, Verdict } from './verdict.ts';
import { detailText } from './detail-text.ts';

export type VerdictPage = {
  readonly verdict: Verdict;
  readonly states: Readonly<Record<CheckName, CheckState>>;
  readonly nonce: bigint;
  readonly card: ResolvedCard;
  readonly cardHash: string;
  readonly registry: Registry;
  readonly templates: ReadonlyMap<string, Template>;
  readonly decimals: ReadonlyMap<Address, number>;
  readonly expected: Expectations;
  readonly calls: CallScan;
  /** The allowances the transaction leaves open that the card's templates keep. */
  readonly kept: readonly KeptSeen[];
  readonly tree: CallTree | undefined;
  readonly verdictFile: string;
  readonly language: Language;
};

type Does = 'gives' | 'gets' | 'unchanged' | 'net';
type Bound = 'all' | 'exactly' | 'at-least' | 'more-than' | 'less-than';

const ZH = {
  checks: {
    'template-approval': '模板已核准',
    'static-floor': '交易本身的底線規則',
    fields: '每個欄位符合模板和卡片',
    'vault-asset': '金庫的資產',
    'contract-code': '合約程式碼沒被換掉',
    mutation: '改動欄位會被抓到',
    simulation: '模擬',
    'simulated-floor': '模擬後的底線規則',
    effects: 'Safe 的資產變化符合卡片',
  } satisfies Record<CheckName, string>,
  stateNote: { passed: '', failed: '', unverifiable: '沒完成', 'not-run': '沒有執行', 'not-needed': '卡片用不到' } satisfies Record<CheckState, string>,
  banner: { MATCH: 'MATCH：交易符合你的卡片', MISMATCH: 'MISMATCH：交易和你的卡片不符，不要簽', UNVERIFIABLE: 'UNVERIFIABLE：有檢查無法完成，不要簽' } satisfies Record<Verdict['kind'], string>,
  unregistered: '未登記',
  baseUnits: (amount: string) => `${amount} 最小單位`,
  baseUnitsOf: '的 ',
  decimalsUnread: 'decimals() 沒讀到',
  decimalsNote: (base: string, decimals: number) => `${base}，${decimals} 位小數`,
  addressBook: '（地址簿）',
  card: '卡片',
  cardHash: '卡片 hash',
  does: { gives: '給出', gets: '收到', unchanged: '不變', net: '淨變化' } satisfies Record<Does, string>,
  bound: { all: '全部餘額', exactly: '剛好 ', 'at-least': '至少 ', 'more-than': '多於 ', 'less-than': '少於 ' } satisfies Record<Bound, string>,
  allOf: '的 ',
  cannotCompute: '無法算出',
  removeSigner: '移除簽署人',
  addSigner: '新增簽署人',
  threshold: '門檻',
  unchanged: '不變',
  becomes: '變成 ',
  effects: '預期效果',
  effectsLead: '卡片說 Safe 的每種資產該怎麼變，淨變化是收到減給出。「Safe 的資產變化符合卡片」這項檢查拿它和模擬或收據比對。',
  none: '無',
  noEffects: '卡片沒有說 Safe 的資產會變',
  later: (structs: string) => `這筆交易只簽了一則訊息（${structs}）的摘要。訊息要動的資產，要等之後有人執行它時才會變，不在這筆交易裡；下面只列這筆交易本身的變化。`,
  unixSecond: (seconds: bigint) => `第 ${seconds} 秒（UNIX 時間）`,
  unlimited: '無上限的 ',
  until: (date: string) => `，到 ${date} 為止（Permit2 的到期時間）`,
  viaPermit2: '透過 Permit2',
  erc20Allowance: 'ERC-20 授權',
  to: '給 ',
  colon: '：',
  kept: '交易後保留的授權',
  keptLead: '模板允許這些授權在交易後留著；登記資料寫了為什麼可以留。其他授權都不能比交易前高。',
  noKept: '這筆交易沒有留下新的授權',
  callsUnread: (reasons: readonly string[]) => `讀不到哪些呼叫不移動資產：${reasons.join('；')}`,
  everyCallMoves: '每個呼叫都會移動 Safe 的資產。',
  movesNothingLead: '這些呼叫不移動 Safe 的任何資產，它們做的事是改設定或給權限：',
  thisSafe: '本 Safe',
  noData: '沒有資料',
  calls: '不移動資產的呼叫',
  checklist: '比對清單',
  noHashes: '不顯示任何 hash。不要簽這筆交易。',
  checklistLeadEnglish: '',
  checklistLead: (command: Html) => h`每一列和獨立電腦上 ${command} 頁面的同一列比對：列號、欄位和值都要一模一樣。最右一欄是各自的名字，不用比。safeTxHash、domain hash 和 message hash 也要和硬體錢包逐字比對。`,
  causes: '原因',
  sub: 'kiss-sign 在工作電腦上對照你的卡片檢查這筆交易。',
  footer: (file: Html) => h`這頁由 <code>kiss-sign verify</code> 寫出。標 AI 的是模板裡 AI 寫的理由，程式不檢查它；其他都不是 AI 文字。判決檔：${file}，可以用 <code>bin/kiss-sign replay</code> 重算。`,
};

const EN: typeof ZH = {
  stateNote: { passed: '', failed: '', unverifiable: 'could not finish', 'not-run': 'not run', 'not-needed': 'not needed for this card' },
  checks: {
    'template-approval': 'Template approved',
    'static-floor': 'Floor rules on the transaction itself',
    fields: 'Every field fits the template and the card',
    'vault-asset': 'The vault\'s asset',
    'contract-code': 'Contract code unchanged',
    mutation: 'Changed fields are caught',
    simulation: 'Simulation',
    'simulated-floor': 'Floor rules after the simulation',
    effects: 'The Safe\'s asset changes fit the card',
  },
  banner: {
    MATCH: 'MATCH: the transaction fits your card',
    MISMATCH: 'MISMATCH: the transaction does not fit your card. Do not sign',
    UNVERIFIABLE: 'UNVERIFIABLE: a check could not finish. Do not sign',
  },
  unregistered: 'not registered',
  baseUnits: (amount: string) => `${amount} base units`,
  baseUnitsOf: ' of ',
  decimalsUnread: 'decimals() not read',
  decimalsNote: (base: string, decimals: number) => `${base}, ${decimals} decimals`,
  addressBook: ' (address book)',
  card: 'Card',
  cardHash: 'Card hash',
  does: { gives: 'Gives', gets: 'Gets', unchanged: 'Unchanged', net: 'Net change' },
  bound: { all: 'the whole balance', exactly: 'exactly ', 'at-least': 'at least ', 'more-than': 'more than ', 'less-than': 'less than ' },
  allOf: ' of ',
  cannotCompute: 'Cannot compute',
  removeSigner: 'Remove signer',
  addSigner: 'Add signer',
  threshold: 'Threshold',
  unchanged: 'unchanged',
  becomes: 'becomes ',
  effects: 'Expected effects',
  effectsLead: 'How the card says each asset of the Safe should change; the net change is what it gets minus what it gives. The check "The Safe\'s asset changes fit the card" compares this with the simulation or the receipt.',
  none: 'None',
  noEffects: 'The card says no asset of the Safe changes',
  later: (structs: string) =>
    `This transaction signs only the digest of a message (${structs}). The assets that message moves change later, when someone acts on it, not in this transaction; the rows below cover this transaction alone.`,
  unixSecond: (seconds: bigint) => `second ${seconds} (UNIX time)`,
  unlimited: 'unlimited ',
  until: (date: string) => `, until ${date} (the Permit2 expiration)`,
  viaPermit2: 'Through Permit2',
  erc20Allowance: 'ERC-20 allowance',
  to: 'to ',
  colon: ': ',
  kept: 'Allowances kept after the transaction',
  keptLead: 'The template lets these allowances stay open after the transaction; the registry says why each may stay. No other allowance may end higher than before.',
  noKept: 'This transaction leaves no new allowance',
  callsUnread: (reasons: readonly string[]) => `Could not read which calls move no asset: ${reasons.join('; ')}`,
  everyCallMoves: 'Every call moves an asset of the Safe.',
  movesNothingLead: 'These calls move no asset of the Safe; they change settings or grant permissions:',
  thisSafe: 'this Safe',
  noData: 'no data',
  calls: 'Calls that move no asset',
  checklist: 'Checklist',
  noHashes: 'No hash is shown. Do not sign this transaction.',
  checklistLeadEnglish:
    "The row ids, the field names and the group titles stay in Traditional Chinese, exactly as check.sh writes them, so the two pages compare byte for byte; only the last column is in English.",
  checklistLead: (command: Html) =>
    h`Compare each row with the same row of the ${command} page on the independent computer: the row id, the field and the value must be exactly the same. The last column is each page's own names; do not compare it. Also compare the safeTxHash, domain hash and message hash character by character with the hardware wallet.`,
  causes: 'Causes',
  sub: 'kiss-sign checked this transaction against your card on your work computer.',
  footer: (file: Html) =>
    h`Written by <code>kiss-sign verify</code>. Text marked AI is the template's reason, written by AI; the program does not check it. Nothing else is AI text. Verdict file: ${file}; <code>bin/kiss-sign replay</code> computes it again.`,
};

const WORDS: Readonly<Record<Language, typeof ZH>> = { en: EN, 'zh-TW': ZH };
type Words = typeof ZH;

const CHECKS = Object.keys(ZH.checks) as CheckName[];

const BANNER: Readonly<Record<Verdict['kind'], State>> = { MATCH: 'ok', MISMATCH: 'bad', UNVERIFIABLE: 'warn' };

const ICON: Readonly<Record<CheckState, State>> = { passed: 'ok', failed: 'bad', unverifiable: 'warn', 'not-run': 'na', 'not-needed': 'na' };

const mono = (text: string): Html => h`<span class="addr">${text}</span>`;
const prop = (label: string, value: Html | string): Html => h`<div><dt>${label}</dt><dd>${value}</dd></div>`;

function nameOf(address: Address, page: VerdictPage): string {
  return page.registry.byAddress.get(address)?.name ?? WORDS[page.language].unregistered;
}

const tokenName = (token: AmountToken): Html | string => (token.address === 'eth' ? token.name : h`${token.name} ${mono(checksumAddress(token.address))}`);

function tokenAmount(value: bigint, token: AmountToken | undefined, page: VerdictPage): Html {
  const w = WORDS[page.language];
  const base = w.baseUnits(`${value < 0n ? '−' : ''}${value < 0n ? -value : value}`);
  if (token === undefined) return h`<span class="num">${base}</span>`;
  const named = tokenName(token);
  if (value === 0n) return h`<span class="num">0</span> ${named}`;
  const decimals = token.address === 'eth' ? 18 : page.decimals.get(token.address);
  if (decimals === undefined) return h`<span class="num">${base}</span>${w.baseUnitsOf}${named}<span class="sub2">${w.decimalsUnread}</span>`;
  return h`<span class="num">${groupedTokens(value, decimals)}</span> ${named}<span class="sub2">${w.decimalsNote(base, decimals)}</span>`;
}

function cardValue(value: ResolvedValue, token: AmountToken | undefined, page: VerdictPage): Html {
  switch (value.kind) {
    case 'contract':
      return h`${value.name} ${mono(checksumAddress(value.entry.address))}`;
    case 'address':
      return h`${value.name}${value.from === 'address-book' ? WORDS[page.language].addressBook : ''} ${mono(checksumAddress(value.address))}`;
    case 'amount':
      return tokenAmount(value.value, token, page);
    case 'nonce':
    case 'threshold':
      return h`<span class="num">${`${value.value}`}</span>`;
    case 'percent':
      return h`<span class="num">${percentText(value.value)}</span><span class="sub2">${WORDS[page.language].baseUnits(`${value.value}`)}</span>`;
    case 'market':
      return h`${value.market.name} ${mono(value.market.id)}`;
  }
}

function cardSection(page: VerdictPage): Html {
  const w = WORDS[page.language];
  return h`
<section>
  <h2>${w.card}</h2>
  <p class="lead">${w.cardHash} ${mono(page.cardHash)}</p>
  ${page.card.operations.map(
    (op) => h`<h3><code>${op.template}</code></h3>
  <dl class="props two">${[...op.values].map(([field, value]) => {
    const kind = page.templates.get(op.template)?.card.get(field);
    return prop(field, cardValue(value, kind?.kind === 'amount' ? amountToken(kind.of, op.values, page.registry) : undefined, page));
  })}</dl>`,
  )}
</section>`;
}

function changeWords(change: Expected): { readonly does: Does; readonly bound: Bound; readonly amount: bigint | undefined } {
  if (change.kind === 'all') return { does: 'gives', bound: 'all', amount: undefined };
  const { change: c } = change;
  const by = c < 0n ? -c : c;
  if (change.kind === 'exactly') return { does: c === 0n ? 'unchanged' : c < 0n ? 'gives' : 'gets', bound: 'exactly', amount: by };
  if (change.kind === 'at-least') return c >= 0n ? { does: 'gets', bound: 'at-least', amount: c } : { does: 'net', bound: 'at-least', amount: c };
  if (change.kind === 'more-than') return c >= 0n ? { does: 'gets', bound: 'more-than', amount: c } : { does: 'net', bound: 'more-than', amount: c };
  return c <= 0n ? { does: 'gives', bound: 'more-than', amount: by } : { does: 'net', bound: 'less-than', amount: c };
}

function effectsSection(page: VerdictPage): Html {
  const { expected } = page;
  const w = WORDS[page.language];
  const rows =
    expected.kind === 'unverifiable'
      ? expected.reasons.map((reason) => prop(w.cannotCompute, reason))
      : [...expected.changes].map(([asset, change]) => {
          const token: AmountToken = asset === 'eth' ? { address: 'eth', name: 'ETH' } : { address: asset, name: nameOf(asset, page) };
          const { does, bound, amount } = changeWords(change);
          return prop(w.does[does], amount === undefined ? h`${w.bound[bound]}${w.allOf}${tokenName(token)}` : h`${w.bound[bound]}${tokenAmount(amount, token, page)}`);
        });
  const change = settingsChange(page.card, page.templates);
  if (change !== undefined) {
    if (change.remove !== undefined) rows.push(prop(w.removeSigner, mono(checksumAddress(change.remove))));
    if (change.add !== undefined) rows.push(prop(w.addSigner, mono(checksumAddress(change.add))));
    rows.push(prop(w.threshold, change.threshold === undefined ? w.unchanged : h`${w.becomes}<span class="num">${`${change.threshold}`}</span>`));
  }
  const structs = signedMessages(page.card, page.templates);
  return h`
<section>
  <h2>${w.effects}</h2>
  <p class="lead">${w.effectsLead}</p>${structs.length === 0 ? '' : h`
  <p class="lead">${w.later(structs.join(', '))}</p>`}
  <dl class="props two">${rows.length === 0 ? prop(w.none, w.noEffects) : rows}</dl>
</section>`;
}

const isUnlimited = ({ via, amount }: KeptSeen): boolean => amount >= (via === 'permit2' ? PERMIT2_MAX : UNLIMITED_ERC20);

/** The latest second a JavaScript date holds; a later expiration is shown in seconds. */
const LAST_DATE = 8_640_000_000_000n;
const utc = (seconds: bigint, w: Words): string => (seconds > LAST_DATE ? w.unixSecond(seconds) : `${new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);

function keptSection(page: VerdictPage): Html {
  if (![...page.templates.values()].some((t) => t.effects.approves.length > 0)) return h``;
  const w = WORDS[page.language];
  const rows = page.kept.map((kept) => {
    const token: AmountToken = { address: kept.token, name: nameOf(kept.token, page) };
    const amount = isUnlimited(kept) ? h`${w.unlimited}${tokenName(token)}` : tokenAmount(kept.amount, token, page);
    const expires = kept.expiration === undefined ? '' : w.until(utc(kept.expiration, w));
    return prop(kept.via === 'permit2' ? w.viaPermit2 : w.erc20Allowance, h`${w.to}${nameOf(kept.spender, page)} ${mono(checksumAddress(kept.spender))}${w.colon}${amount}${expires}`);
  });
  return h`
<section>
  <h2>${w.kept}</h2>
  <p class="lead">${w.keptLead}</p>
  <dl class="props two">${rows.length === 0 ? prop(w.none, w.noKept) : rows}</dl>
</section>`;
}

/** Each function a template on the card calls, by the address it calls and its selector. */
function calledFunctions(page: VerdictPage): ReadonlyMap<string, string> {
  const target = (rule: Rule, values: ResolvedCard['operations'][number]['values']): Address | undefined => {
    if (rule.kind === 'safe') return page.card.safe;
    if (rule.kind === 'contract') return page.registry.entries.get(rule.name)?.address;
    if (rule.kind !== 'card') return undefined;
    const resolved = resolveRef(rule.ref, values, page.registry);
    return 'kind' in resolved && resolved.kind === 'address' ? resolved.address : undefined;
  };
  return new Map(
    page.card.operations.flatMap((op) =>
      (page.templates.get(op.template)?.calls ?? []).flatMap((call) => {
        const to = target(call.to, op.values);
        return call.data === 'empty' || to === undefined ? [] : [[`${to}|${call.data.fn.selector}`, call.data.fn.signature] as const];
      }),
    ),
  );
}

function callsSection(page: VerdictPage): Html {
  const { calls } = page;
  const w = WORDS[page.language];
  const functions = calledFunctions(page);
  const body =
    calls.kind === 'unverifiable'
      ? h`<p class="intro">${w.callsUnread(calls.reasons)}</p>`
      : calls.movesNothing.length === 0
        ? h`<p class="intro">${w.everyCallMoves}</p>`
        : h`<p class="intro">${w.movesNothingLead}</p>
  <dl class="props two">${calls.movesNothing.map(({ path, to, selector }) =>
    prop(path, h`${to === page.card.safe ? w.thisSafe : nameOf(to, page)} ${mono(checksumAddress(to))} ${selector === undefined ? w.noData : functions.has(`${to}|${selector}`) ? mono(`${functions.get(`${to}|${selector}`)} ${selector}`) : h`selector ${mono(selector)}`}`),
  )}</dl>`;
  return h`
<section>
  <h2>${w.calls}</h2>${body}
</section>`;
}

function checklistSection(page: VerdictPage): Html {
  const w = WORDS[page.language];
  if (page.tree === undefined) {
    return h`
<section>
  <h2>${w.checklist}</h2>
  <p class="intro">${w.noHashes}</p>
</section>`;
  }
  return h`
<section>
  <h2>${w.checklist}</h2>
  <p class="lead">${w.checklistLead(h`<code>./check.sh ${`${page.nonce}`}</code>`)}</p>${w.checklistLeadEnglish === '' ? '' : h`
  <p class="lead">${w.checklistLeadEnglish}</p>`}
${new Html(checklistHtml(checklist(page.tree, page.language)))}
</section>`;
}

function causesSection(verdict: Verdict, language: Language): Html {
  const w = WORDS[language];
  if (verdict.kind === 'MATCH') return h``;
  return h`
<section>
  <h2>${w.causes}</h2>
  <div class="rows">${verdict.causes.map(
    (cause) => h`
    <div class="row">${icon(verdict.kind === 'MISMATCH' ? 'bad' : 'warn', language)}<div><div class="t">${w.checks[cause.check]} <code>${cause.check}</code></div>${cause.details.map((detail) => h`<div class="meta">${detailText(detail, language)}</div>`)}</div></div>`,
  )}
  </div>
</section>`;
}

/** Sets this page apart from check.sh's, which uses another accent. */
const PAGE_CSS = `:root{--accent:#6ea8fe}
.program{border-left:4px solid var(--accent);padding-left:18px}
.program .prog{color:var(--accent)}
.cl .nm .byai{margin:0 6px 0 2px}`;

/** The page `verify` writes beside its verdict file: no script, nothing loaded from outside, every value escaped. */
export function verdictPage(page: VerdictPage): string {
  const w = WORDS[page.language];
  const banner = BANNER[page.verdict.kind];
  const body = h`<header>
  <div class="program">
    <h1><span class="prog">kiss-sign verify</span> · nonce ${`${page.nonce}`} · ${page.verdict.kind}</h1>
    <p class="sub">${w.sub}</p>
  </div>
  <div class="banner ${banner}">${icon(banner, page.language)}${w.banner[page.verdict.kind]}</div>
  <ul class="checks">${CHECKS.map((check) => {
    const state = page.states[check];
    return h`
    <li>${icon(ICON[state], page.language)}${w.checks[check]}${w.stateNote[state] === '' ? '' : h`<span class="n">· ${w.stateNote[state]}</span>`}</li>`;
  })}
  </ul>
</header>
${causesSection(page.verdict, page.language)}
${checklistSection(page)}
${cardSection(page)}
${effectsSection(page)}
${keptSection(page)}
${callsSection(page)}
<footer class="foot">${w.footer(h`<code>${page.verdictFile}</code>`)}</footer>`;
  const text = `<!doctype html>
<html lang="${HTML_LANG[page.language]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>kiss-sign verify · nonce ${page.nonce} · ${page.verdict.kind}</title>
<style>
${CSS}
${CHECKLIST_CSS}
${PAGE_CSS}
</style>
</head>
<body>
${SYMBOLS}
<div class="wrap">
<div class="main solo">
${body.text}
</div>
</div>
</body>
</html>
`;
  return text.split('\n').map(visible).join('\n');
}
