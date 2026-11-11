import { join } from 'node:path';
import type { AbiProof, AbiRefusal } from '../contracts/prove.ts';
import { paramName } from '../decode/abi.ts';
import type { AbiParam } from '../decode/abi.ts';
import { MARKETS_PATH, MARKET_ENTRY_PARTS } from '../registry.ts';
import type { HttpsUrl, Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import { TEMPLATES_DIR } from '../template/template.ts';
import type { CallNode, CardRef, Effect, Quantity, Rule, Template, TokenRef, ViewEffect } from '../template/template.ts';
import { checkSources, githubLine, sourceSiteLine } from './listings.ts';
import type { Line } from './listings.ts';
import { parseNotes, readNotes } from './notes.ts';
import type { Note, Notes } from './notes.ts';
import { entriesOf, hasMarket, pinVerdict, refNames, spanKind, vaultsOf, wordOf } from './report.ts';
import type { DocLink, PastTxsSummary, ReportInputs, ReportTitle, Subject } from './report.ts';
import { isGitHubPage, pageUrlOf } from './source-page.ts';
import type { SourceName } from './sources.ts';
import { constText } from './study.ts';

export const GENERATED_HTML_FILE = 'report.generated.html';
export const generatedHtmlPath = (template: string): string => join(TEMPLATES_DIR, template, GENERATED_HTML_FILE);

/** HTML the program wrote. Every other value placed into it goes through `h`, which escapes it. */
class Html {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}
type Part = Html | string | number | bigint | readonly Part[] | undefined | false;

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const piece = (part: Part): string =>
  part === undefined || part === false ? '' : part instanceof Html ? part.text : Array.isArray(part) ? part.map(piece).join('') : String(part).replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

function h(strings: TemplateStringsArray, ...parts: Part[]): Html {
  return new Html(strings.reduce((out, s, i) => out + s + (i < parts.length ? piece(parts[i] as Part) : ''), ''));
}
const joined = (parts: readonly Part[], separator: Part): Html => new Html(parts.map(piece).join(piece(separator)));

const c = (text: string): Html => h`<code>${text}</code>`;
/** A field path that may wrap after each dot rather than inside a name. */
const breakable = (path: string): Html => h`<code>${joined(path.split('.'), h`.<wbr>`)}</code>`;
const mono = (text: string): Html => h`<span class="mono">${text}</span>`;
const link = (url: HttpsUrl, label?: Part): Html => h`<a href="${url}">${label ?? url}</a>`;
const PROGRAM = h`<span class="by prog">程式</span>`;
const AI = h`<span class="by ai">AI 研究</span>`;
const full = (entry: RegistryEntry): Html => h`${c(entry.name)} ${mono(checksumAddress(entry.address))}`;
/** Text the AI wrote, in quotes, always with its tag. */
const aiQuote = (text: string): Html => h`<span class="ai-quote">「${text}」</span>${AI}`;

type Status = 'ok' | 'warn' | 'na';
const MARKS: Readonly<Record<Status, Html>> = { ok: h`<span class="mark ok">✓</span>`, warn: h`<span class="mark warn">!</span>`, na: h`<span class="mark na">–</span>` };

/** One program check, as the signer reads it. `flag` is the word the Markdown report prints, when the check did not pass. */
type Check = { readonly status: Status; readonly flag?: 'FINDING' | 'REFUSED' | 'UNVERIFIABLE'; readonly text: Html; readonly why?: Html };
const pass = (text: Html): Check => ({ status: 'ok', text });
const finding = (text: Html, why?: Html): Check => (why === undefined ? { status: 'warn', flag: 'FINDING', text } : { status: 'warn', flag: 'FINDING', text, why });
const needsJudgment = (check: Check): boolean => check.status === 'warn' || check.flag !== undefined;

const checkItem = (check: Check, tag: Html = PROGRAM): Html =>
  h`<li>${MARKS[check.status]}<div>${check.text}${tag}${check.why === undefined ? '' : h`<div class="why">${check.why}</div>`}</div></li>`;

function noteItem(note: Note, mark?: Status): Html {
  const title = note.title === undefined ? '' : h`<b>${note.title}</b> `;
  const sources = note.sources.length === 0 ? '' : h`<div class="why">來源：${joined(note.sources.map((url) => link(url)), '、')}</div>`;
  const body = h`${title}${note.text}${AI}${sources}`;
  return mark === undefined ? h`<li>${body}</li>` : h`<li>${MARKS[mark]}<div>${body}</div></li>`;
}

const refZh = (ref: CardRef): Html => (ref.attribute === undefined ? h`card 上的 ${c(ref.field)}` : h`card 上 ${c(ref.field)} 的 ${c(ref.attribute)}`);

function refChoices(ref: CardRef, template: Template, registry: Registry): Html {
  const kind = template.card.get(ref.field)?.kind;
  const names = refNames(ref, template, registry);
  if (kind !== 'contract' && (kind !== 'market' || names.length === 0)) return h``;
  return h`，可能是 ${joined(names.map((n) => full(registry.entries.get(n) as RegistryEntry)), '、')}`;
}

const quantityZh = (q: Quantity): Html => (q.kind === 'card' ? h`card 上的 ${c(q.field)}` : h`${c(q.path)} 的數字`);

const FREE_CLAIMS: Readonly<Record<'scalar' | 'proof' | 'unread', string>> = {
  scalar: '不限',
  proof: '不限（模板宣稱：改成別的值，交易一定失敗或被擋下）',
  unread: '不限（模板宣稱：合約不會讀它，改成別的值不會改變任何結果）',
};

function ruleZh(rule: Rule, template: Template, registry: Registry): Html {
  switch (rule.kind) {
    case 'card':
      return h`${refZh(rule.ref)}${refChoices(rule.ref, template, registry)}`;
    case 'safe':
      return h`你的 Safe`;
    case 'contract':
      return h`registry 的 ${full(registry.entries.get(rule.name) as RegistryEntry)}`;
    case 'const':
      return h`固定為 ${c(constText(rule.value))}`;
    case 'free':
      return h`${FREE_CLAIMS[rule.claim]}。${aiQuote(rule.reason)}`;
    case 'equals':
      return h`跟 ${c(rule.path)} 同一個數字，也就是${ruleZh(rule.rule, template, registry)}`;
    case 'share-price':
      return h`${rule.bound === 'max' ? '至多' : '至少'} assets × 1e27 / shares，assets 是${quantityZh(rule.assets)}，shares 是${quantityZh(rule.shares)}`;
    case 'call':
      return h`呼叫 ${c(rule.call.fn.signature)}`;
    case 'items':
      return h`剛好 ${rule.items.length} 項`;
    case 'fields':
      return h`每個欄位見下面幾列`;
  }
}

/** The registry names a rule can be, for the roles each entry plays. */
function namesOf(rule: Rule, template: Template, registry: Registry): string[] {
  if (rule.kind === 'contract') return [rule.name];
  if (rule.kind === 'card') return refNames(rule.ref, template, registry);
  if (rule.kind === 'equals') return namesOf(rule.rule, template, registry);
  return [];
}

type FieldRow = { readonly key: string; readonly path: string; readonly rule: Html; readonly names: readonly string[] };
type FieldGroup = { readonly title: Html; readonly rows: readonly FieldRow[] };

/** The template's field table: one group per call, one row per field, keyed `<call>.<path>` for `notes.json`. */
function fieldGroups(template: Template, registry: Registry): FieldGroup[] {
  const row = (key: string, path: string, rule: Rule, text?: Html): FieldRow => ({ key, path, rule: text ?? ruleZh(rule, template, registry), names: namesOf(rule, template, registry) });
  const callRows = (call: number, node: CallNode, prefix: string): FieldRow[] => {
    const trailer = node.trailer === undefined ? h`參數後面不能附加任何資料` : h`參數後面最多附加 ${node.trailer.maxBytes} bytes。${aiQuote(node.trailer.why)}`;
    const path = `${prefix}${node.fn.name}`;
    return [
      { key: `${call}.${path}`, path, rule: h`呼叫 ${c(node.fn.signature)}，selector ${c(node.fn.selector)}；${trailer}`, names: [] },
      ...argRows(call, node.fn.params, node.args, `${path}.`),
    ];
  };
  const argRows = (call: number, params: readonly AbiParam[], rules: readonly Rule[], path: string): FieldRow[] =>
    params.flatMap((param, i) => rowsOf(call, rules[i] as Rule, `${path}${paramName(param, i)}`, param));
  const rowsOf = (call: number, rule: Rule, path: string, param: AbiParam | undefined): FieldRow[] => {
    if (rule.kind === 'call') return callRows(call, rule.call, `${path} → `);
    if (rule.kind === 'items') {
      const item = param?.type.kind === 'array' || param?.type.kind === 'fixed-array' ? { name: undefined, type: param.type.item } : undefined;
      return [row(`${call}.${path}`, path, rule), ...rule.items.flatMap((r, i) => rowsOf(call, r, `${path}[${i}]`, item))];
    }
    if (rule.kind === 'fields') return argRows(call, param?.type.kind === 'tuple' ? param.type.components : [], rule.fields, `${path}.`);
    return [row(`${call}.${path}`, path, rule)];
  };
  const groups: FieldGroup[] = template.calls.map((call, i) => {
    const n = i + 1;
    const rows = [row(`${n}.to`, 'to', call.to), row(`${n}.value`, 'value', call.value)];
    if (call.data === 'empty') rows.push({ key: `${n}.data`, path: 'data', rule: h`空的`, names: [] });
    else rows.push(...callRows(n, call.data, ''));
    if (call.merge !== undefined) rows.push({ key: `${n}.merge`, path: 'merge', rule: h`同一張 card 上的幾個操作共用這個呼叫。${aiQuote(call.merge)}`, names: [] });
    const fn = call.data === 'empty' ? h`沒有呼叫函式` : c(call.data.fn.name);
    return { title: h`呼叫 ${n} / ${template.calls.length}：${fn}`, rows };
  });
  const whole: FieldRow[] = [];
  if (template.nonce !== undefined) whole.push(row('nonce', 'nonce', template.nonce));
  if (template.same.length > 0) whole.push({ key: 'same', path: 'same', rule: h`這些必須是同一個地址：${joined(template.same.map(refZh), '、')}`, names: [] });
  if (whole.length > 0) groups.push({ title: h`整筆 Safe 交易`, rows: whole });
  return groups;
}

const tokenZh = (token: TokenRef, template: Template, registry: Registry): Html =>
  token === 'eth' ? h`ETH` : h`${refZh(token)}${refChoices(token, template, registry)}`;

/** Where the template, the card and the markets name the entry. */
function rolesOf(entry: RegistryEntry, subject: Extract<Subject, { kind: 'template' }>, registry: Registry, groups: readonly FieldGroup[]): Html[] {
  const { template } = subject;
  const roles: Html[] = [];
  groups.forEach((group) => {
    for (const r of group.rows) if (r.names.includes(entry.name)) roles.push(h`${group.title} 的 ${c(r.path)}`);
  });
  for (const [field, card] of template.card) if (card.kind === 'contract' && card.registryKind === entry.kind) roles.push(h`card 的 ${c(field)} 可以選它`);
  for (const market of registry.markets.values()) {
    for (const part of MARKET_ENTRY_PARTS) if (market[part].name === entry.name && hasMarket(template)) roles.push(h`market ${c(market.name)} 的 ${c(part)}`);
  }
  for (const other of entriesOf(subject, registry)) {
    for (const [attribute, target] of Object.entries(other.attributes)) if (target === entry.name) roles.push(h`${c(other.name)} 的 ${c(attribute)}`);
  }
  for (const view of template.effects.views) if (view.to === entry.name) roles.push(h`交易前後讀它的 ${c(view.fn.name)}`);
  const sides: [string, readonly Effect[]][] = [['Safe 付出的代幣', template.effects.gives], ['Safe 收到的代幣', template.effects.gets]];
  for (const [side, effects] of sides) {
    for (const effect of effects) if (effect.token !== 'eth' && refNames(effect.token, template, registry).includes(entry.name)) roles.push(h`${side}`);
  }
  for (const doc of subject.docs) if (doc.contract.name === entry.name) roles.push(h`${c(doc.fn.name)} 的官方文件屬於它`);
  return roles;
}

function sourceChecks(entry: RegistryEntry, lines: readonly Line[]): Check[] {
  const github = isGitHubPage(new URL(entry.source));
  const command = h`<code>pnpm check-sources ${entry.name}</code> 會印出比對的內容。`;
  const source = link(entry.source, github ? 'GitHub 上的來源檔案' : new URL(entry.source).hostname);
  const order: readonly Line['check'][] = ['page', 'url', 'defillama', 'github', 'coingecko'];
  return [...lines].sort((a, b) => order.indexOf(a.check) - order.indexOf(b.check)).map((line): Check => {
    const ok = line.kind === 'agrees';
    switch (line.check) {
      case 'page':
        return ok
          ? pass(h`登記的來源頁面（不跑 JavaScript 直接讀）在標籤旁邊列出這個地址：${source}`)
          : finding(h`登記的來源頁面上沒找到這個地址：${source}`, h`程式讀頁面時不跑 JavaScript。可能是地址要跑 JavaScript 才出現、頁面讀取失敗，或地址不在標籤旁邊。${command}`);
      case 'url':
        return finding(h`登記的來源網址本身就含有這個地址：${source}`, h`很多頁面會把自己的網址顯示出來，所以頁面上出現這個地址證明不了什麼，程式不讀這種頁面。`);
      case 'defillama':
        return ok
          ? pass(github ? h`來源的 GitHub 組織是 DefiLlama 上 ${c(entry.defillama ?? '')} 登記的組織` : h`來源網站跟 DefiLlama 上 ${c(entry.defillama ?? '')} 登記的網站是同一個網域`)
          : finding(
              github ? h`沒辦法確認來源的 GitHub 組織屬於這個協議` : h`沒辦法確認來源網站屬於這個協議`,
              h`跟 DefiLlama 上登記的${github ? ' GitHub 組織' : '網站'}比不起來：可能不同、DefiLlama 沒有登記，或 registry 沒寫 DefiLlama 名稱。${command}`,
            );
      case 'github':
        return ok
          ? pass(h`來源檔案固定在一個 commit，而且這個 commit 在 repo 的預設分支上`)
          : finding(h`來源檔案的 commit 沒能確認在預設分支上`, h`可能沒固定在 commit、commit 不在預設分支，或 GitHub 讀不到。${command}`);
      case 'coingecko':
        return ok
          ? pass(h`CoinGecko 在這個地址列的就是 registry 寫的幣 ${c(entry.coingecko ?? '')}`)
          : finding(h`CoinGecko 在這個地址沒有列出 registry 寫的幣`, h`可能沒列、列的是別的幣，或 registry 沒寫 CoinGecko 名稱。${command}`);
    }
  });
}

function docChecks(doc: DocLink, inputs: ReportInputs): Check[] {
  const url = new URL(doc.url);
  const page = inputs.pages.pages.get(pageUrlOf(doc.url));
  const named = page?.kind === 'served' && page.blocks.some((block) => wordOf(doc.fn).test(block.text));
  const fn = c(doc.fn.name);
  const site = sourceSiteLine(doc.url, doc.contract.defillama, inputs.listings).kind === 'agrees';
  const checks: Check[] = [
    named
      ? pass(h`官方文件頁面寫了 ${fn} 這個函式名稱：${link(doc.url)}`)
      : finding(h`官方文件頁面上找不到 ${fn} 這個函式名稱：${link(doc.url)}`, h`程式讀頁面時不跑 JavaScript，名稱可能要跑 JavaScript 才出現，或頁面讀取失敗。`),
    site
      ? pass(h`${fn} 的文件頁面網站跟 DefiLlama 上登記的相符`)
      : finding(h`${fn} 的文件頁面網站沒能跟 DefiLlama 上登記的對上`, h`網域或 GitHub 組織跟 DefiLlama 登記的不同，或 DefiLlama 沒有登記可比對的東西。`),
  ];
  if (isGitHubPage(url)) {
    checks.push(
      githubLine(url, inputs.pages.commits).kind === 'agrees'
        ? pass(h`${fn} 的文件固定在一個 commit，而且在預設分支上`)
        : finding(h`${fn} 的文件 commit 沒能確認在預設分支上`),
    );
  }
  return checks;
}

function spanChecks(entry: RegistryEntry, verdicts: readonly string[] | undefined): Check[] {
  if (entry.code === undefined) return [{ status: 'warn', text: h`registry 沒有記錄它的程式碼指紋`, why: h`簽名時碰到它會得到 UNVERIFIABLE。` }];
  const spans = [...entry.code.earlier, entry.code.current];
  return spans.map(({ from, pin }, i): Check => {
    const verdict = verdicts?.[i] ?? 'not read';
    const which = spans.length === 1 ? h`` : h`第 ${i + 1} / ${spans.length} 段：`;
    const proxy = pin.implementation === undefined ? h`` : h`（代理合約，背後的實作 ${mono(checksumAddress(pin.implementation.address))} 也算在內）`;
    switch (spanKind(verdict)) {
      case 'pass':
        return { status: 'ok', text: h`${which}從區塊 <span class="num">${from}</span> 起執行的是記錄的程式碼${proxy}，前一個區塊${i === 0 ? '還沒有' : '是上一段的'}程式碼，兩個節點都確認` };
      case 'finding':
        return finding(h`${which}區塊 <span class="num">${from}</span> 前後的程式碼跟記錄的不符${proxy}`, h`記錄的指紋或起始區塊可能寫錯。鏈上讀到的見最下面「程式碼指紋」。`);
      case 'unverifiable':
        return { status: 'warn', flag: 'UNVERIFIABLE', text: h`${which}區塊 <span class="num">${from}</span> 前後的程式碼讀不到，或兩個節點答案不同` };
      case 'not-read':
        return {
          status: 'na',
          text: h`沒有回頭查這個程式碼指紋從哪個區塊開始${proxy}`,
          why: h`這個指紋記錄得比較早，沒有記起始區塊。簽名時程式仍會比對現在的程式碼跟指紋。`,
        };
    }
  });
}

function abiCheck(entry: RegistryEntry, proof: AbiProof | AbiRefusal | undefined): Check {
  if (proof === undefined) return { status: 'na', text: h`沒有用原始碼重新編譯來比對`, why: h`repo 裡沒有這個地址的 ABI 記錄。` };
  if (proof.kind === 'refused') {
    const { refusal } = proof;
    if (refusal.why === 'compiler-not-pinned') {
      return { status: 'na', flag: 'REFUSED', text: h`沒有用原始碼重新編譯來比對`, why: h`它需要的編譯器 solc ${refusal.version} 還沒固定在 repo 裡。` };
    }
    return { status: 'warn', flag: 'REFUSED', text: h`原始碼重新編譯比對沒有完成（${c(refusal.why)}）`, why: h`程式沒能證明鏈上的程式碼就是公開的原始碼。<code>pnpm prove-abi ${checksumAddress(entry.address)}</code> 會印出原因。` };
  }
  const name = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(proof.contractName) ? h`${c(proof.contractName)}，` : '';
  const proxy = proof.proxy.kind === 'none' ? '' : h`（代理合約，比對的是背後的實作 ${mono(checksumAddress(proof.proven))}）`;
  const what = h`Sourcify 上的原始碼用固定版本的編譯器重新編譯後，跟鏈上的程式碼一樣${proxy}（${name}solc ${proof.compiler}）`;
  switch (pinVerdict(entry, proof)) {
    case 'PASS':
      return pass(h`${what}，也就是 registry 記錄的現在指紋`);
    case 'FINDING':
      return finding(h`${what}，但不是 registry 記錄的現在指紋`, h`簽名時程式比對的是指紋，所以被證明的程式碼跟簽名時要求的程式碼不是同一份。`);
    default:
      return { status: 'warn', text: h`${what}，但 registry 沒有記錄程式碼指紋` };
  }
}

function marketChecks(entry: RegistryEntry, template: Template, registry: Registry): Check[] {
  if (!hasMarket(template)) return [];
  return [...registry.markets.values()].flatMap((market) =>
    MARKET_ENTRY_PARTS.filter((part) => market[part].name === entry.name).map(
      (part): Check => ({
        status: 'ok',
        text: h`是 market ${c(market.name)} 的 ${c(part)}，跟 market id 對得上`,
        why: h`market id ${mono(market.id)} 是五個參數算出來的雜湊，程式每次讀 ${c(MARKETS_PATH)} 都重算比對，對不上就拒絕。`,
      }),
    ),
  );
}

type EntryCard = { readonly entry: RegistryEntry; readonly roles: readonly Html[]; readonly checks: readonly Check[] };

function entryCards(subject: Extract<Subject, { kind: 'template' }>, inputs: ReportInputs, groups: readonly FieldGroup[]): EntryCard[] {
  const { registry } = inputs;
  return checkSources(entriesOf(subject, registry), inputs.listings, inputs.pages).map(({ entry, lines }) => ({
    entry,
    roles: rolesOf(entry, subject, registry, groups),
    checks: [
      ...sourceChecks(entry, lines),
      ...subject.docs.filter((doc) => doc.contract.name === entry.name).flatMap((doc) => docChecks(doc, inputs)),
      ...marketChecks(entry, subject.template, registry),
      abiCheck(entry, inputs.abi.get(entry.address)),
      ...spanChecks(entry, inputs.spans.get(entry.address)),
    ],
  }));
}

function effectZh(side: 'gives' | 'gets', effect: Effect, template: Template, registry: Registry): Html {
  const amount = effect.amount.kind === 'card' ? h`剛好是 card 上的 ${c(effect.amount.field)}` : effect.amount.kind === 'positive' ? h`大於 0` : h`是它的全部餘額`;
  const to = effect.to === undefined ? '' : h`，給 ${refZh(effect.to)}`;
  return h`模擬執行後，Safe ${side === 'gives' ? '付出' : '收到'} ${tokenZh(effect.token, template, registry)}，數量${amount}${to}。`;
}

const CHANGES = { increases: '要增加', decreases: '要減少', same: '不變' } as const;

function viewZh(view: ViewEffect, template: Template, registry: Registry): Html {
  const args = view.fn.params.map((param, i) => h`${c(paramName(param, i))} 是${ruleZh(view.args[i] as Rule, template, registry)}`);
  const changes = view.changes.map(({ value, change }) => h`${c(paramName(view.returns[value] as AbiParam, value))} ${CHANGES[change]}`);
  return h`交易前後各讀一次 ${full(registry.entries.get(view.to) as RegistryEntry)} 的 ${c(view.fn.name)}（${joined(args, '；')}）：${joined(changes, '，')}。`;
}

function signingChecks(template: Template, registry: Registry): Html[] {
  const calls = template.calls.length;
  const vaultAssets = [...template.card.values()].some((field) => field.kind === 'contract' && field.registryKind === 'vault');
  return [
    h`交易只有這 ${calls} 個呼叫${calls > 1 ? '（用官方 MultiSend 包在一起）' : ''}，每個欄位都符合下面「交易裡每個欄位必須是什麼」的表，而且交易要能逐 byte 重新編碼成一樣的內容。`,
    h`程式把每個被綁住的欄位一個一個改掉，確認模板每次都給 MISMATCH。`,
    h`不允許無上限的授權、不允許 delegatecall 到官方 MultiSend 以外的合約、不允許改 Safe 的擁有者、模組、guard、門檻或實作；Safe 自己的手續費欄位都必須是 0。`,
    ...template.effects.gives.map((effect) => effectZh('gives', effect, template, registry)),
    ...template.effects.gets.map((effect) => effectZh('gets', effect, template, registry)),
    h`Safe 的餘額只能有上面這些變化；交易結束後，Safe 給出的任何授權都不能比交易前高。`,
    ...template.effects.views.map((view) => viewZh(view, template, registry)),
    ...(vaultAssets ? [h`card 上的 vault，它的 ${c('asset()')} 必須是 registry 寫的代幣。`] : []),
    h`這筆交易碰到的每個 registry 合約，現在執行的程式碼都必須是 registry 記錄的程式碼指紋，代理合約背後的實作也一樣。程式碼被換過就會擋下。`,
    h`以上的鏈上資料都向兩家不同公司的節點讀；兩邊答案不一樣，結果就是 UNVERIFIABLE，不會給 MATCH。`,
  ];
}

function pastTxsFacts(summary: PastTxsSummary): Html {
  const { run } = summary;
  const found = [...run.found.values()];
  const by = (source: SourceName) => found.filter((s) => s.includes(source)).length;
  const both = found.filter((s) => s.length > 1).length;
  const kept = run.studies;
  const judged = kept.flatMap((s) => (s.kind === 'fit' || s.kind === 'misfit' ? [s] : []));
  const fromSafe = judged.filter((s) => s.sender.kind === 'safe');
  const fromEoa = judged.filter((s) => s.sender.kind === 'eoa');
  const count = (list: readonly { readonly kind: string }[], kind: string) => list.filter((s) => s.kind === kind).length;
  const safes = new Set(fromSafe.map((s) => s.sender.address)).size;
  const eoas = new Set(fromEoa.map((s) => s.sender.address)).size;
  const window = run.query.sampling.kind === 'spread' ? h`搜尋了過去一年平均分布的 ${run.windows.length} 段區塊` : h`搜尋了一段指定的區塊範圍`;
  return h`<div class="panel"><p>${c(summary.file)}：${window}，Alchemy 找到 ${by('alchemy')} 筆、Etherscan 找到 ${by('etherscan')} 筆，兩邊都找到 ${both} 筆。抽查 ${kept.length} 筆：${PROGRAM}</p>
<ul class="steps" style="list-style:disc">
<li>從 Safe（確認是官方 Safe 合約）送出的 ${fromSafe.length} 筆，來自 ${safes} 個 Safe：符合模板 ${count(fromSafe, 'fit')} 筆，不符合 ${count(fromSafe, 'misfit')} 筆。</li>
<li>EOA 直接呼叫模板裡的函式 ${fromEoa.length} 筆，來自 ${eoas} 個 EOA：符合那個呼叫的形狀 ${count(fromEoa, 'fit')} 筆，不符合 ${count(fromEoa, 'misfit')} 筆。</li>
<li>不能確認是官方 Safe 的合約送出的 ${count(kept, 'unproven')} 筆，沒有再細看。</li>
<li>呼叫的不是模板裡的函式 ${count(kept, 'not-studied')} 筆；讀不到的 ${count(kept, 'unreadable')} 筆。</li>
</ul></div>`;
}

const CSS = `:root {
  --bg: #f7f8f7; --paper: #ffffff; --ink: #18201e; --muted: #5d6965; --rule: #dfe4e2; --accent: #1d5f8a;
  --ok: #1d7a3c; --ok-bg: #e4f3e8; --warn: #8f5600; --warn-bg: #fcf0d9; --na: #66716d; --na-bg: #eceeed; --code-bg: #eff2f1;
  --font-body: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #111615; --paper: #182020; --ink: #e3eae7; --muted: #9aa7a2; --rule: #2b3634;
    --accent: #79b8e3; --ok: #7fd49a; --ok-bg: #1a3223; --warn: #f2bb62; --warn-bg: #3a2b12;
    --na: #a0aba7; --na-bg: #252e2c; --code-bg: #212a28; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #111615; --paper: #182020; --ink: #e3eae7; --muted: #9aa7a2; --rule: #2b3634;
  --accent: #79b8e3; --ok: #7fd49a; --ok-bg: #1a3223; --warn: #f2bb62; --warn-bg: #3a2b12;
  --na: #a0aba7; --na-bg: #252e2c; --code-bg: #212a28; color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  background: var(--bg); color: var(--ink); font-family: var(--font-body); font-size: 16px; line-height: 1.7; margin: 0;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 0 80px;
}
.wrap { max-width: 760px; margin: 0 auto; display: grid; gap: 40px; }
header { padding-top: 40px; display: grid; gap: 8px; }
.kicker { font-family: var(--font-mono); font-size: 13px; color: var(--muted); }
h1 { font-size: clamp(25px, 4.5vw, 32px); line-height: 1.3; margin: 0; text-wrap: balance; }
h2 { font-size: 21px; margin: 0; text-wrap: balance; }
h3 { font-size: 17px; margin: 0; }
p { margin: 0; max-width: 66ch; }
section { display: grid; gap: 14px; }
.lede { font-size: 17px; }
.note { color: var(--muted); font-size: 14.5px; }
.mono, code { font-family: var(--font-mono); font-size: 0.84em; overflow-wrap: anywhere; }
code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
a { color: var(--accent); overflow-wrap: anywhere; }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.steps { margin: 0; padding-left: 1.4em; display: grid; gap: 6px; }
.panel { background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; padding: 18px 20px; display: grid; gap: 12px; }
.panel.attention { border-color: var(--warn); }
.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.checks li { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 4px 10px; align-items: start; }
.mark { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 13px; font-weight: 700; margin-top: 3px; }
.mark.ok { color: var(--ok); background: var(--ok-bg); }
.mark.warn { color: var(--warn); background: var(--warn-bg); }
.mark.na { color: var(--na); background: var(--na-bg); }
.why { color: var(--muted); font-size: 14.5px; }
.flag { font-family: var(--font-mono); font-size: 12px; color: var(--warn); margin-right: 6px; }
.by { font-size: 12px; font-weight: 500; letter-spacing: .03em; padding: 0 7px; border-radius: 999px; white-space: nowrap; vertical-align: 1px; margin-left: 6px; }
.by.prog { color: var(--accent); border: 1px solid var(--accent); }
.by.ai { color: var(--muted); border: 1px dashed var(--muted); }
.ai-quote { color: var(--muted); }
.addr { background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
.addr-head { padding: 16px 20px 12px; display: grid; gap: 4px; border-bottom: 1px solid var(--rule); }
.addr-head .name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.addr-head .full { font-family: var(--font-mono); font-size: 14px; overflow-wrap: anywhere; }
.role { color: var(--muted); font-size: 15px; }
.addr-body { padding: 16px 20px; display: grid; gap: 14px; }
.ai-notes { border-top: 1px dashed var(--rule); padding-top: 12px; display: grid; gap: 6px; font-size: 14.5px; color: var(--muted); }
.ai-notes ul { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; }
.table-frame { overflow-x: auto; background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 15px; line-height: 1.55; }
th, td { text-align: left; vertical-align: top; padding: 10px 14px; border-bottom: 1px solid var(--rule); }
th { font-size: 13px; color: var(--muted); font-weight: 500; background: var(--code-bg); }
tr:last-child td { border-bottom: 0; }
td.path { width: 32%; }
td.path code { overflow-wrap: normal; word-break: normal; }
td.nowrap { white-space: nowrap; }
td.group { background: var(--code-bg); font-weight: 500; font-size: 14px; }
.num { font-variant-numeric: tabular-nums; }
details { background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; padding: 12px 18px; }
summary { cursor: pointer; font-weight: 500; }
details[open] summary { margin-bottom: 10px; }
pre { font-family: var(--font-mono); font-size: 12px; line-height: 1.5; overflow-x: auto; background: var(--code-bg); padding: 12px; border-radius: 6px; margin: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13.5px; color: var(--muted); align-items: center; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend .mark { margin-top: 0; }
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }`;

const FONTS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap';

function percent(lltv: bigint): string {
  const unit = 10n ** 16n;
  return lltv % unit === 0n ? `（${lltv / unit}%）` : '';
}

function cardSection(template: Template, registry: Registry): Html {
  const takes = (name: string): Html => {
    const field = template.card.get(name);
    switch (field?.kind) {
      case 'contract':
        return h`從 registry 裡 kind 是 ${c(field.registryKind)} 的合約選一個`;
      case 'amount':
        return h`${tokenZh(field.of, template, registry)} 的數量（輸入整顆代幣數，程式讀 decimals() 換算）`;
      case 'market':
        return h`從 ${c(MARKETS_PATH)} 的 market 清單選一個`;
      case 'nonce':
        return h`Safe 的 nonce`;
      case 'address':
        return h`registry 名稱、通訊錄名稱或你的 Safe`;
      default:
        return h`通訊錄名稱或你的 Safe`;
    }
  };
  const rows = [...template.card.keys()].map((name) => h`<tr><td class="nowrap">${c(name)}</td><td>${takes(name)}</td></tr>`);
  const lists: Html[] = [];
  for (const [name, field] of template.card) {
    if (field.kind === 'contract') {
      const items = [...registry.entries.values()].filter((e) => e.kind === field.registryKind).map((e) => h`<tr><td>${c(e.name)}</td><td class="mono">${checksumAddress(e.address)}</td></tr>`);
      lists.push(h`<p>card 的 ${c(name)} 可以選：</p><div class="table-frame"><table><thead><tr><th>名稱</th><th>地址</th></tr></thead><tbody>${items}</tbody></table></div>`);
    }
    if (field.kind === 'market') {
      const items = [...registry.markets.values()].map(
        (m) => h`<tr><td>${c(m.name)}</td><td class="mono">${m.id}</td><td class="num">${m.lltv}${percent(m.lltv)}</td></tr>`,
      );
      lists.push(h`<p>card 的 ${c(name)} 可以選（每個 market 的五個參數見下面的地址卡）：</p><div class="table-frame"><table><thead><tr><th>名稱</th><th>market id</th><th>LLTV</th></tr></thead><tbody>${items}</tbody></table></div>`);
    }
  }
  return h`<p>你在 card 上要填：${PROGRAM}</p><div class="table-frame"><table><thead><tr><th>card 欄位</th><th>填什麼</th></tr></thead><tbody>${rows}</tbody></table></div>${lists}`;
}

function entryArticle(card: EntryCard, notes: Notes): Html {
  const { entry } = card;
  const ai = notes.entries.get(entry.name);
  const role = ai?.role === undefined ? '' : h`<div class="role">${ai.role}${AI}</div>`;
  const roles = card.roles.length === 0 ? '' : h`<div class="role">在這筆交易裡：${joined(card.roles, '；')}${PROGRAM}</div>`;
  const aiNotes = ai === undefined || ai.notes.length === 0 ? '' : h`<div class="ai-notes"><b>AI 另外查到</b><ul>${ai.notes.map((n) => noteItem(n))}</ul></div>`;
  return h`<article class="addr" id="entry-${entry.name}">
<div class="addr-head"><div class="name"><h3>${entry.name}</h3><span class="role">${entry.kind}</span></div><div class="full">${checksumAddress(entry.address)}</div>${role}${roles}</div>
<div class="addr-body"><ul class="checks">${card.checks.map((check) => checkItem(check))}</ul>${aiNotes}</div>
</article>`;
}

function judgmentSection(cards: readonly EntryCard[], notes: Notes): Html {
  const program = cards.flatMap(({ entry, checks }) =>
    checks.filter(needsJudgment).map(
      (check) =>
        h`<li>${MARKS[check.status]}<div>${check.flag === undefined ? '' : h`<span class="flag">${check.flag}</span>`}<b><a href="#entry-${entry.name}">${entry.name}</a>：</b>${check.text}${PROGRAM}${check.why === undefined ? '' : h`<div class="why">${check.why}</div>`}</div></li>`,
    ),
  );
  const items = [...program, ...notes.judgments.map((note) => noteItem(note, 'warn'))];
  if (items.length === 0) return h`<p>沒有。</p>`;
  return h`<div class="panel attention"><ul class="checks">${items}</ul></div>`;
}

function fieldTable(groups: readonly FieldGroup[], notes: Notes): Html {
  const body = groups.map(
    (group) =>
      h`<tr><td class="group" colspan="3">${group.title}</td></tr>${group.rows.map((row) => {
        const meaning = notes.fields.get(row.key);
        return h`<tr><td class="path">${breakable(row.path)}</td><td>${meaning === undefined ? '' : h`${meaning}${AI}`}</td><td>${row.rule}</td></tr>`;
      })}`,
  );
  return h`<div class="table-frame"><table><thead><tr><th>欄位</th><th>意思 ${AI}</th><th>必須是 ${PROGRAM}</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function detailsSection(inputs: ReportInputs, entries: readonly RegistryEntry[], notes: Notes, subject: Subject): Html {
  const spans = entries.flatMap((entry) =>
    entry.code === undefined
      ? [h`<tr><td>${c(entry.name)}</td><td colspan="4">沒有記錄</td></tr>`]
      : [...entry.code.earlier, entry.code.current].map(({ from, pin }, i) => {
          const implementation = pin.implementation === undefined ? '無' : h`${mono(checksumAddress(pin.implementation.address))} ${mono(pin.implementation.hash)}`;
          return h`<tr><td>${c(entry.name)}</td><td class="num">${from}</td><td class="mono">${pin.hash}</td><td>${implementation}</td><td>${inputs.spans.get(entry.address)?.[i] ?? 'not read'}</td></tr>`;
        }),
  );
  const abi = entries.map((entry) => {
    const proof = inputs.abi.get(entry.address);
    if (proof === undefined) return h`<tr><td>${c(entry.name)}</td><td colspan="4">沒有讀</td></tr>`;
    if (proof.kind === 'refused') return h`<tr><td>${c(entry.name)}</td><td colspan="3">REFUSED ${c(proof.refusal.why)}</td><td class="num">${proof.block.number}</td></tr>`;
    const masked = `${proof.immutablesMasked} 個 immutable、${proof.librariesMasked} 段 library 位址比對時遮掉${proof.metadataHashMasked ? '；metadata hash 不同' : ''}`;
    return h`<tr><td>${c(entry.name)}</td><td>PROVEN，solc ${proof.compiler}</td><td class="mono">${proof.codeHash}</td><td>${masked}</td><td class="num">${proof.block.number}</td></tr>`;
  });
  const vaults = vaultsOf(subject, inputs.registry).map((vault) => h`<details><summary>${vault.name} 的 vault-evidence 輸出</summary><pre>${inputs.vaults.get(vault.name) ?? 'not read'}</pre></details>`);
  const past = inputs.pastTxs.map((p) => h`<details><summary>過去交易搜尋的原始輸出：${p.file}</summary><pre>${p.text.trimEnd()}</pre></details>`);
  const groups = notes.details.map((group) => h`<details><summary>${group.title}${AI}</summary><ul class="steps" style="list-style:disc">${group.notes.map((n) => noteItem(n))}</ul></details>`);
  return h`${past}
<details><summary>程式碼指紋（每一段從哪個區塊開始）</summary><div class="table-frame"><table><thead><tr><th>合約</th><th>起始區塊</th><th>程式碼指紋</th><th>背後的實作</th><th>鏈上檢查</th></tr></thead><tbody>${spans}</tbody></table></div></details>
<details><summary>原始碼重新編譯的結果</summary><div class="table-frame"><table><thead><tr><th>合約</th><th>結果</th><th>程式碼指紋</th><th>比對時遮掉的部分</th><th>讀取區塊</th></tr></thead><tbody>${abi}</tbody></table></div></details>
${vaults}
<details><summary>ERC-7730 錢包顯示描述檔（只當第二意見，不是規則）</summary><pre>${inputs.erc7730}</pre></details>
${groups}`;
}

/** The HTML report of a template: the same recordings as its Markdown report, read for the signer, with the AI's notes beside them. */
export function renderHtml(inputs: ReportInputs, notes: Notes, title: ReportTitle): string {
  const { subject, registry } = inputs;
  if (subject.kind !== 'template') throw new Error('an HTML report is of a template');
  const { template } = subject;
  const groups = fieldGroups(template, registry);
  const cards = entryCards(subject, inputs, groups);
  const tests = notes.tests.length === 0 ? '' : h`<ul class="steps" style="list-style:disc">${notes.tests.map((n) => noteItem(n))}</ul>`;
  const past = inputs.pastTxs.length === 0 ? h`<p>沒有 ${c('pnpm past-txs --record')} 的記錄。${PROGRAM}</p>` : inputs.pastTxs.map(pastTxsFacts);
  const page = h`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${template.id} 報告</title>
<link rel="stylesheet" href="${FONTS}">
<style>
${new Html(CSS)}
</style>
</head>
<body>
<div class="wrap">

<header>
<div class="kicker">${template.id} · 資料讀於 ${inputs.fetched} · 以太坊主網</div>
<h1>${notes.title}${AI}</h1>
<p class="lede">${notes.summary}${AI}</p>
<p class="note">這份報告由 ${c(title.command)} 從 repo 和錄下的資料產生，${c('pnpm test')} 會重算並比對，不要手動修改。標「程式」的是程式檢查的結果，可以重跑；標「AI 研究」的是 AI 寫的，程式沒有驗證。合併前用 ${c(`pnpm report ${template.id} --compare`)} 重新即時讀一次。</p>
</header>

<section>
<h2>這筆交易會做的事</h2>
<ol class="steps">${notes.steps.map((step) => h`<li>${step}${AI}</li>`)}</ol>
${cardSection(template, registry)}
</section>

<section>
<h2>每次簽名前，程式會自動檢查</h2>
<div class="panel"><ul class="checks">${signingChecks(template, registry).map((text) => checkItem(pass(text)))}</ul></div>
</section>

<section>
<h2>需要你自己判斷的事</h2>
${judgmentSection(cards, notes)}
</section>

<section>
<h2>每個地址確認了什麼</h2>
<div class="legend">
<span>${MARKS.ok}確認了</span>
<span>${MARKS.warn}沒確認到，需要你判斷</span>
<span>${MARKS.na}沒做這項檢查</span>
<span><span class="by prog" style="margin:0">程式</span>程式檢查、可重跑</span>
<span><span class="by ai" style="margin:0">AI 研究</span>AI 查的，程式沒驗</span>
</div>
${cards.map((card) => entryArticle(card, notes))}
</section>

<section>
<h2>交易裡每個欄位必須是什麼</h2>
${fieldTable(groups, notes)}
</section>

<section>
<h2>拿真實交易測過</h2>
${past}
${tests}
</section>

<section>
<h2>細節</h2>
${detailsSection(inputs, entriesOf(subject, registry), notes, subject)}
</section>

</div>
</body>
</html>
`;
  return page.text;
}

/** The keys `notes.json` may use for a template's report. */
export function notesKeys(subject: Extract<Subject, { kind: 'template' }>, registry: Registry): { entries: Set<string>; fields: Set<string> } {
  return {
    entries: new Set(entriesOf(subject, registry).map((e) => e.name)),
    fields: new Set(fieldGroups(subject.template, registry).flatMap((g) => g.rows.map((r) => r.key))),
  };
}

/** The template's `notes.json`, parsed against its report, or undefined when it has none. */
export function loadNotes(repoRoot: string, subject: Extract<Subject, { kind: 'template' }>, registry: Registry): Notes | undefined {
  const raw = readNotes(repoRoot, subject.template.id);
  return raw === undefined ? undefined : parseNotes(raw, notesKeys(subject, registry));
}
