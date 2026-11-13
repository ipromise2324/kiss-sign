import type { ResolvedCard, ResolvedValue } from '../card.ts';
import { CSS, Html, SYMBOLS, h, icon } from '../research/report-html.ts';
import type { State } from '../research/ledger.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import type { Expectations } from '../simulate/effects.ts';
import type { CallScan } from '../simulate/simulate.ts';
import { CHECKLIST_CSS, checklist, checklistHtml, visible } from './checklist.ts';
import type { CallTree } from './expected.ts';
import type { CheckName, Verdict } from './verdict.ts';

export type VerdictPage = {
  readonly verdict: Verdict;
  readonly nonce: bigint;
  readonly card: ResolvedCard;
  readonly cardHash: string;
  readonly registry: Registry;
  readonly expected: Expectations;
  readonly calls: CallScan;
  readonly tree: CallTree | undefined;
  readonly verdictFile: string;
};

const CHECK_NAMES: Readonly<Record<CheckName, string>> = {
  'template-approval': '模板已核准',
  'static-floor': '交易本身的底線規則',
  fields: '每個欄位符合模板和卡片',
  'vault-asset': 'vault 的資產',
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

function cardValue(value: ResolvedValue): Html {
  switch (value.kind) {
    case 'contract':
      return h`${value.name} ${mono(checksumAddress(value.entry.address))}`;
    case 'address':
      return h`${value.name}${value.from === 'address-book' ? '（地址簿）' : ''} ${mono(checksumAddress(value.address))}`;
    case 'amount':
      return h`<span class="num">${`${value.value}`}</span> <span class="f3">base units</span>`;
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
  <dl class="props two">${[...op.values].map(([field, value]) => prop(field, cardValue(value)))}</dl>`,
  )}
</section>`;
}

function effectsSection(page: VerdictPage): Html {
  const { expected, registry } = page;
  const rows =
    expected.kind === 'unverifiable'
      ? expected.reasons.map((reason) => prop('無法算出', reason))
      : [...expected.changes].map(([asset, change]) => {
          const name = asset === 'eth' ? 'ETH' : h`${nameOf(asset, registry)} ${mono(checksumAddress(asset))}`;
          const amount =
            change.kind === 'all'
              ? '給出全部餘額'
              : change.kind === 'exactly'
                ? `剛好 ${change.change}`
                : `${change.kind === 'more-than' ? '多於' : '少於'} ${change.change}`;
          return h`<div><dt>${name}</dt><dd><span class="num">${amount}</span></dd></div>`;
        });
  return h`
<section>
  <h2>預期效果</h2>
  <p class="lead">卡片說 Safe 的資產該怎麼變（base units，正數是收到，負數是給出）。「Safe 的資產變化符合卡片」這項檢查拿它和模擬或收據比對。</p>
  <dl class="props two">${rows.length === 0 ? prop('無', '卡片沒有說 Safe 的資產會變') : rows}</dl>
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

/** The page `verify` writes beside its verdict file: no script, nothing loaded from outside, every value escaped. */
export function verdictPage(page: VerdictPage): string {
  const banner = BANNER[page.verdict.kind];
  const body = h`<header>
  <h1>kiss-sign verify</h1>
  <span class="opid">nonce ${`${page.nonce}`}</span>
  <div class="banner ${banner.state}">${icon(banner.state)}${banner.text}</div>
  <ul class="checks">${CHECKS.map(([check, name]) => h`
    <li>${icon(stateOf(page.verdict, check))}${name}</li>`)}
  </ul>
</header>
${checklistSection(page)}
${causesSection(page.verdict)}
${cardSection(page)}
${effectsSection(page)}
${callsSection(page)}
<footer class="foot">這頁由 <code>kiss-sign verify</code> 寫出，不含 AI 文字。判決檔：<code>${page.verdictFile}</code>，可以用 <code>bin/kiss-sign replay</code> 重算。</footer>`;
  const text = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>kiss-sign verify ${page.verdict.kind} nonce ${page.nonce}</title>
<style>
${CSS}
${CHECKLIST_CSS}
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
