import type { ResolvedCard, ResolvedValue } from '../card.ts';
import { SHOWN_PLACES, groupedTokens } from '../chain/decimals.ts';
import { CSS, Html, SYMBOLS, h, icon } from '../research/report-html.ts';
import type { State } from '../research/ledger.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import { PERMIT2_MAX, UNLIMITED_ERC20 } from '../floor/floor.ts';
import type { Expectations, Expected, KeptSeen } from '../simulate/effects.ts';
import type { CallScan } from '../simulate/simulate.ts';
import type { Template } from '../template/template.ts';
import { CHECKLIST_CSS, checklist, checklistHtml, visible } from './checklist.ts';
import { amountToken } from './expected.ts';
import type { AmountToken, CallTree } from './expected.ts';
import type { CheckName, Verdict } from './verdict.ts';

export type VerdictPage = {
  readonly verdict: Verdict;
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
};

const CHECK_NAMES: Readonly<Record<CheckName, string>> = {
  'template-approval': '模板已核准',
  'static-floor': '交易本身的底線規則',
  fields: '每個欄位符合模板和卡片',
  'vault-asset': '金庫的資產',
  'contract-code': '合約程式碼沒被換掉',
  mutation: '改動欄位會被抓到',
  simulation: '模擬',
  'simulated-floor': '模擬後的底線規則',
  effects: 'Safe 的資產變化符合卡片',
};
const CHECKS = Object.entries(CHECK_NAMES) as [CheckName, string][];
/** Checks that read the simulation, and so did not run when it is unverifiable, though they report no cause then. */
const ON_SIMULATION: readonly CheckName[] = ['simulated-floor', 'effects'];

const BANNER: Readonly<Record<Verdict['kind'], { readonly state: State; readonly text: string }>> = {
  MATCH: { state: 'ok', text: 'MATCH：交易符合你的卡片' },
  MISMATCH: { state: 'bad', text: 'MISMATCH：交易和你的卡片不符，不要簽' },
  UNVERIFIABLE: { state: 'warn', text: 'UNVERIFIABLE：有檢查無法完成，不要簽' },
};

/**
 * A check's state as the verdict shows it. A MISMATCH names only the checks that failed, so the others are not
 * known to have passed; an UNVERIFIABLE has no failed check, so every check it does not name passed.
 */
function stateOf(verdict: Verdict, check: CheckName): State {
  if (verdict.kind === 'MATCH') return 'ok';
  const named = verdict.causes.some((cause) => cause.check === check);
  if (verdict.kind === 'MISMATCH') return named ? 'bad' : 'na';
  if (named) return 'warn';
  return ON_SIMULATION.includes(check) && verdict.causes.some((cause) => cause.check === 'simulation') ? 'na' : 'ok';
}

const mono = (text: string): Html => h`<span class="addr">${text}</span>`;
const prop = (label: string, value: Html | string): Html => h`<div><dt>${label}</dt><dd>${value}</dd></div>`;

function nameOf(address: Address, registry: Registry): string {
  return registry.byAddress.get(address)?.name ?? '未登記';
}

const tokenName = (token: AmountToken): Html | string => (token.address === 'eth' ? token.name : h`${token.name} ${mono(checksumAddress(token.address))}`);

function tokenAmount(value: bigint, token: AmountToken | undefined, page: VerdictPage): Html {
  const base = `${value < 0n ? '−' : ''}${value < 0n ? -value : value} 最小單位`;
  if (token === undefined) return h`<span class="num">${base}</span>`;
  const named = tokenName(token);
  if (value === 0n) return h`<span class="num">0</span> ${named}`;
  const decimals = token.address === 'eth' ? 18 : page.decimals.get(token.address);
  if (decimals === undefined) return h`<span class="num">${base}</span>的 ${named}<span class="sub2">decimals() 沒讀到</span>`;
  const shown = groupedTokens(value, decimals, SHOWN_PLACES);
  const cut = shown !== groupedTokens(value, decimals);
  return h`${cut ? '約 ' : ''}<span class="num">${shown}</span> ${named}<span class="sub2">${base}，${`${decimals}`} 位小數</span>`;
}

function cardValue(value: ResolvedValue, token: AmountToken | undefined, page: VerdictPage): Html {
  switch (value.kind) {
    case 'contract':
      return h`${value.name} ${mono(checksumAddress(value.entry.address))}`;
    case 'address':
      return h`${value.name}${value.from === 'address-book' ? '（地址簿）' : ''} ${mono(checksumAddress(value.address))}`;
    case 'amount':
      return tokenAmount(value.value, token, page);
    case 'nonce':
      return h`<span class="num">${`${value.value}`}</span>`;
    case 'market':
      return h`${value.market.name} ${mono(value.market.id)}`;
  }
}

function cardSection(page: VerdictPage): Html {
  return h`
<section>
  <h2>卡片</h2>
  <p class="lead">卡片 hash ${mono(page.cardHash)}</p>
  ${page.card.operations.map(
    (op) => h`<h3><code>${op.template}</code></h3>
  <dl class="props two">${[...op.values].map(([field, value]) => {
    const kind = page.templates.get(op.template)?.card.get(field);
    return prop(field, cardValue(value, kind?.kind === 'amount' ? amountToken(kind.of, op.values, page.registry) : undefined, page));
  })}</dl>`,
  )}
</section>`;
}

function changeWords(change: Expected): { readonly does: string; readonly bound: string; readonly amount: bigint | undefined } {
  if (change.kind === 'all') return { does: '給出', bound: '全部餘額', amount: undefined };
  const { change: c } = change;
  const by = c < 0n ? -c : c;
  if (change.kind === 'exactly') return { does: c === 0n ? '不變' : c < 0n ? '給出' : '收到', bound: '剛好 ', amount: by };
  if (change.kind === 'more-than') return c >= 0n ? { does: '收到', bound: '多於 ', amount: c } : { does: '淨變化', bound: '多於 ', amount: c };
  return c <= 0n ? { does: '給出', bound: '多於 ', amount: by } : { does: '淨變化', bound: '少於 ', amount: c };
}

function effectsSection(page: VerdictPage): Html {
  const { expected, registry } = page;
  const rows =
    expected.kind === 'unverifiable'
      ? expected.reasons.map((reason) => prop('無法算出', reason))
      : [...expected.changes].map(([asset, change]) => {
          const token: AmountToken = asset === 'eth' ? { address: 'eth', name: 'ETH' } : { address: asset, name: nameOf(asset, registry) };
          const { does, bound, amount } = changeWords(change);
          return prop(does, amount === undefined ? h`${bound}的 ${tokenName(token)}` : h`${bound}${tokenAmount(amount, token, page)}`);
        });
  return h`
<section>
  <h2>預期效果</h2>
  <p class="lead">卡片說 Safe 的每種資產該怎麼變，淨變化是收到減給出。「Safe 的資產變化符合卡片」這項檢查拿它和模擬或收據比對。</p>
  <dl class="props two">${rows.length === 0 ? prop('無', '卡片沒有說 Safe 的資產會變') : rows}</dl>
</section>`;
}

const isUnlimited = ({ via, amount }: KeptSeen): boolean => amount >= (via === 'permit2' ? PERMIT2_MAX : UNLIMITED_ERC20);

/** The latest second a JavaScript date holds; a later expiration is shown in seconds. */
const LAST_DATE = 8_640_000_000_000n;
const utc = (seconds: bigint): string => (seconds > LAST_DATE ? `第 ${seconds} 秒（UNIX 時間）` : `${new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);

function keptSection(page: VerdictPage): Html {
  if (![...page.templates.values()].some((t) => t.effects.approves.length > 0)) return h``;
  const { registry } = page;
  const rows = page.kept.map((kept) => {
    const token: AmountToken = { address: kept.token, name: nameOf(kept.token, registry) };
    const amount = isUnlimited(kept) ? h`無上限的 ${tokenName(token)}` : tokenAmount(kept.amount, token, page);
    const expires = kept.expiration === undefined ? '' : h`，到 ${utc(kept.expiration)} 為止（Permit2 的到期時間）`;
    return prop(kept.via === 'permit2' ? '透過 Permit2' : 'ERC-20 授權', h`給 ${nameOf(kept.spender, registry)} ${mono(checksumAddress(kept.spender))}：${amount}${expires}`);
  });
  return h`
<section>
  <h2>交易後保留的授權</h2>
  <p class="lead">模板允許這些授權在交易後留著；登記資料寫了為什麼可以留。其他授權都不能比交易前高。</p>
  <dl class="props two">${rows.length === 0 ? prop('無', '這筆交易沒有留下新的授權') : rows}</dl>
</section>`;
}

function callsSection(page: VerdictPage): Html {
  const { calls, registry } = page;
  const body =
    calls.kind === 'unverifiable'
      ? h`<p class="intro">讀不到哪些呼叫不移動資產：${calls.reasons.join('；')}</p>`
      : calls.movesNothing.length === 0
        ? h`<p class="intro">每個呼叫都會移動 Safe 的資產。</p>`
        : h`<p class="intro">這些呼叫不移動 Safe 的任何資產，它們做的事是改設定或給權限：</p>
  <dl class="props two">${calls.movesNothing.map(({ path, to, selector }) =>
    prop(path, h`${nameOf(to, registry)} ${mono(checksumAddress(to))} ${selector === undefined ? '沒有資料' : h`selector ${mono(selector)}`}`),
  )}</dl>`;
  return h`
<section>
  <h2>不移動資產的呼叫</h2>${body}
</section>`;
}

function checklistSection(page: VerdictPage): Html {
  if (page.tree === undefined) {
    return h`
<section>
  <h2>比對清單</h2>
  <p class="intro">不顯示任何 hash。不要簽這筆交易。</p>
</section>`;
  }
  return h`
<section>
  <h2>比對清單</h2>
  <p class="lead">每一列和獨立電腦上 <code>./check.sh ${`${page.nonce}`}</code> 頁面的同一列比對：列號、欄位和值都要一模一樣。最右一欄是各自的名字，不用比。safeTxHash、domain hash 和 message hash 也要和硬體錢包逐字比對。</p>
${new Html(checklistHtml(checklist(page.tree)))}
</section>`;
}

function causesSection(verdict: Verdict): Html {
  if (verdict.kind === 'MATCH') return h``;
  return h`
<section>
  <h2>原因</h2>
  <div class="rows">${verdict.causes.map(
    (cause) => h`
    <div class="row">${icon(verdict.kind === 'MISMATCH' ? 'bad' : 'warn')}<div><div class="t">${CHECK_NAMES[cause.check]} <code>${cause.check}</code></div>${cause.details.map((detail) => h`<div class="meta">${detail}</div>`)}</div></div>`,
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
  const banner = BANNER[page.verdict.kind];
  const body = h`<header>
  <div class="program">
    <h1><span class="prog">kiss-sign verify</span> · nonce ${`${page.nonce}`} · ${page.verdict.kind}</h1>
    <p class="sub">kiss-sign 在工作電腦上對照你的卡片檢查這筆交易。</p>
  </div>
  <div class="banner ${banner.state}">${icon(banner.state)}${banner.text}</div>
  <ul class="checks">${CHECKS.map(([check, name]) => h`
    <li>${icon(stateOf(page.verdict, check))}${name}</li>`)}
  </ul>
</header>
${causesSection(page.verdict)}
${checklistSection(page)}
${cardSection(page)}
${effectsSection(page)}
${keptSection(page)}
${callsSection(page)}
<footer class="foot">這頁由 <code>kiss-sign verify</code> 寫出。標 AI 的是模板裡 AI 寫的理由，程式不檢查它；其他都不是 AI 文字。判決檔：<code>${page.verdictFile}</code>，可以用 <code>bin/kiss-sign replay</code> 重算。</footer>`;
  const text = `<!doctype html>
<html lang="zh-Hant">
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
