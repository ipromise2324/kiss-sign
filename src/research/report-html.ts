import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCard, resolveCard } from '../card.ts';
import type { AbiProof, AbiRefusal } from '../contracts/prove.ts';
import { paramName } from '../decode/abi.ts';
import type { AbiParam } from '../decode/abi.ts';
import { MARKETS_PATH, MARKET_ENTRY_PARTS } from '../registry.ts';
import type { HttpsUrl, Registry, RegistryEntry } from '../registry.ts';
import { parseServiceTx } from '../safe/parse.ts';
import { checksumAddress } from '../safe/types.ts';
import { checkMutations } from '../template/mutation.ts';
import type { MutationResult } from '../template/mutation.ts';
import { TEMPLATES_DIR } from '../template/template.ts';
import type { CallNode, CardRef, Effect, Quantity, Rule, Template, TokenRef, ViewEffect } from '../template/template.ts';
import type { FieldFact } from './erc7730.ts';
import { checkSources, githubLine, sourceSiteLine } from './listings.ts';
import type { Line } from './listings.ts';
import { NOTES_FILE, NotesError, parseNotes, readNotes } from './notes.ts';
import type { Judgment, Note, Notes, Review } from './notes.ts';
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
const bullets = (items: readonly Part[]): Html => h`<ul class="steps" style="list-style:disc">${items}</ul>`;

/** `ok` passed; `act` is for the signer to look at; `na` had nothing to compare, or was not done. */
type Status = 'ok' | 'act' | 'na';
const MARKS: Readonly<Record<Status, Html>> = { ok: h`<span class="mark ok">✓</span>`, act: h`<span class="mark warn">!</span>`, na: h`<span class="mark na">–</span>` };
/** A line that states what was found, with no result to pass or fail. */
const INFO = h`<span class="mark info">i</span>`;

/**
 * One program result, as the signer reads it. `key` names it in `notes.json`; `flag` is the word the Markdown report
 * prints for it. The program alone sets `status`: an AI line can explain a result but never change where it shows.
 */
type Check = { readonly key: string; readonly status: Status; readonly flag?: 'FINDING' | 'REFUSED' | 'UNVERIFIABLE'; readonly text: Html; readonly why?: Html };
const pass = (key: string, text: Html): Check => ({ key, status: 'ok', text });
const act = (key: string, text: Html, why?: Html): Check => ({ key, status: 'act', flag: 'FINDING', text, ...(why === undefined ? {} : { why }) });

const why = (text: Html | undefined): Part => (text === undefined ? '' : h`<div class="why">${text}</div>`);
const explained = (line: string | undefined): Part => (line === undefined ? '' : h`<div class="why">${line}${AI}</div>`);
const flagOf = (check: Check): Part => (check.flag === undefined ? '' : h`<span class="flag">${check.flag}</span>`);

const checkItem = (check: Check, line: string | undefined, head: Part = ''): Html =>
  h`<li>${MARKS[check.status]}<div>${flagOf(check)}${head}${check.text}${PROGRAM}${why(check.why)}${explained(line)}</div></li>`;

const sourcesOf = (note: Note): Part => (note.sources.length === 0 ? '' : h`<div class="why">來源：${joined(note.sources.map((url) => link(url)), '、')}</div>`);

function noteItem(note: Note, mark?: Html): Html {
  const title = note.title === undefined ? '' : h`<b>${note.title}</b> `;
  const body = h`${title}${note.text}${AI}${sourcesOf(note)}`;
  return mark === undefined ? h`<li>${body}</li>` : h`<li>${mark}<div>${body}</div></li>`;
}

const recommend = (text: string): Html => h`<div class="rec"><b>建議：</b>${text}${AI}</div>`;

const judgmentItem = (judgment: Judgment): Html =>
  h`<li>${MARKS.act}<div>${judgment.title === undefined ? '' : h`<b>${judgment.title}</b> `}${judgment.text}${AI}${sourcesOf(judgment)}${recommend(judgment.recommendation)}</div></li>`;

const REVIEWED: Readonly<Record<Review['status'], string>> = { confirmed: 'AI 已確認', concern: 'AI 有疑慮' };

const reviewBlock = (review: Review): Html =>
  h`<div class="review ${review.status}"><div><b>${REVIEWED[review.status]}：</b>${review.text}${AI}</div>${recommend(review.recommendation)}</div>`;

const refZh = (ref: CardRef): Html => (ref.attribute === undefined ? h`card 上的 ${c(ref.field)}` : h`card 上 ${c(ref.field)} 的 ${c(ref.attribute)}`);

function refChoices(ref: CardRef, template: Template, registry: Registry): Html {
  const kind = template.card.get(ref.field)?.kind;
  const names = refNames(ref, template, registry);
  if (kind !== 'contract' && (kind !== 'market' || names.length === 0)) return h``;
  return h`，只能是 ${joined(names.map((n) => full(registry.entries.get(n) as RegistryEntry)), '、')}`;
}

const quantityZh = (q: Quantity): Html => (q.kind === 'card' ? h`card 上的 ${c(q.field)}` : h`${c(q.path)} 的數字`);

const FREE_CLAIMS: Readonly<Record<'scalar' | 'proof' | 'unread', string>> = {
  scalar: '不限',
  proof: '不限（模板宣稱：改成別的值，交易一定失敗或被擋下）',
  unread: '不限（模板宣稱：合約不會讀它，改成別的值不會改變任何結果）',
};

/** A field's rule in plain words. The template's English reasons stay in the Markdown report. */
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
      return h`${FREE_CLAIMS[rule.claim]}`;
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

/** `of` is the template's rule, absent for a row the program states itself, such as a call's selector. */
type FieldRow = { readonly key: string; readonly path: string; readonly of: Rule | undefined; readonly rule: Html; readonly names: readonly string[]; readonly bound: boolean };
type FieldGroup = { readonly call: number | undefined; readonly title: Html; readonly rows: readonly FieldRow[] };

/** The template's field table: one group per call, one row per field, keyed `<call>.<path>` for `notes.json`. */
function fieldGroups(template: Template, registry: Registry): FieldGroup[] {
  const row = (key: string, path: string, rule: Rule): FieldRow => ({ key, path, of: rule, rule: ruleZh(rule, template, registry), names: namesOf(rule, template, registry), bound: rule.kind !== 'free' });
  const fixed = (key: string, path: string, rule: Html): FieldRow => ({ key, path, of: undefined, rule, names: [], bound: true });
  const callRows = (call: number, node: CallNode, prefix: string): FieldRow[] => {
    const trailer = node.trailer === undefined ? h`參數後面不能附加任何資料` : h`參數後面最多附加 ${node.trailer.maxBytes} bytes`;
    const path = `${prefix}${node.fn.name}`;
    return [fixed(`${call}.${path}`, path, h`呼叫 ${c(node.fn.signature)}，selector ${c(node.fn.selector)}；${trailer}`), ...argRows(call, node.fn.params, node.args, `${path}.`)];
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
    if (call.data === 'empty') rows.push(fixed(`${n}.data`, 'data', h`空的`));
    else rows.push(...callRows(n, call.data, ''));
    if (call.merge !== undefined) rows.push(fixed(`${n}.merge`, 'merge', h`同一張 card 上的幾個操作共用這個呼叫`));
    const fn = call.data === 'empty' ? h`沒有呼叫函式` : c(call.data.fn.name);
    return { call: n, title: h`呼叫 ${n} / ${template.calls.length}：${fn}`, rows };
  });
  const whole: FieldRow[] = [];
  if (template.nonce !== undefined) whole.push(row('nonce', 'nonce', template.nonce));
  if (template.same.length > 0) whole.push(fixed('same', 'same', h`這些必須是同一個地址：${joined(template.same.map(refZh), '、')}`));
  if (whole.length > 0) groups.push({ call: undefined, title: h`整筆 Safe 交易`, rows: whole });
  return groups;
}

/** A call's argument path without its function name, such as `marketParams.oracle`; undefined for `to`, `value` and nested calls. */
function argPath(row: FieldRow, template: Template, call: number): string | undefined {
  const data = template.calls[call - 1]?.data;
  if (data === undefined || data === 'empty' || row.path.includes(' → ') || !row.path.startsWith(`${data.fn.name}.`)) return undefined;
  return row.path.slice(data.fn.name.length + 1);
}

/** Where a field sits, as the signer reads it: `呼叫 2 的 marketParams 參數：oracle`. */
function plainField(row: FieldRow, template: Template, call: number): Html {
  if (row.path === 'to') return h`呼叫 ${call} 的對象`;
  if (row.path === 'value') return h`呼叫 ${call} 送出的 ETH`;
  const arg = argPath(row, template, call);
  if (arg === undefined) return h`呼叫 ${call} 的 ${breakable(row.path)}`;
  const [first, ...rest] = arg.split('.');
  return rest.length === 0 ? h`呼叫 ${call} 的 ${c(first as string)} 參數` : h`呼叫 ${call} 的 ${c(first as string)} 參數：${c(rest.join('.'))}`;
}

const tokenZh = (token: TokenRef, template: Template, registry: Registry): Html =>
  token === 'eth' ? h`ETH` : h`${refZh(token)}${refChoices(token, template, registry)}`;

/** Where the template, the card and the markets name the entry. */
function rolesOf(entry: RegistryEntry, subject: Extract<Subject, { kind: 'template' }>, registry: Registry, groups: readonly FieldGroup[]): Html[] {
  const { template } = subject;
  const roles: Html[] = [];
  for (const group of groups) {
    for (const r of group.rows) if (r.names.includes(entry.name)) roles.push(group.call === undefined ? h`整筆交易的 ${c(r.path)}` : plainField(r, template, group.call));
  }
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
  return roles.filter((role, i) => roles.findIndex((r) => r.text === role.text) === i);
}

const SOURCE_KEYS: Readonly<Record<Line['check'], string>> = { defillama: 'source.site', coingecko: 'source.coingecko', github: 'source.commit', url: 'source.url', page: 'source.page' };

/** The site check of a page, against the DefiLlama protocol `slug`: `what` names the page, such as 來源. */
function siteCheck(key: string, what: Html, url: URL, slug: string | undefined, line: Line, command?: Html): Check {
  const github = isGitHubPage(url);
  const thing = github ? ' GitHub 組織' : '網站';
  const protocol = slug === undefined ? h`` : h` ${c(slug)}`;
  if (line.kind === 'agrees') {
    return pass(key, github ? h`${what}的 GitHub 組織是 DefiLlama 上${protocol} 登記的組織` : h`${what}跟 DefiLlama 上${protocol} 登記的網站是同一個網域`);
  }
  if (line.cause === 'unlisted') {
    return { key, status: 'na', flag: 'FINDING', text: h`沒比對${what}的${thing}`, why: h`DefiLlama 上${protocol} 沒有登記${thing}，沒有東西可比。` };
  }
  if (slug === undefined) return act(key, h`registry 沒寫它的 DefiLlama 名稱，${what}的${thing}沒比對`, command);
  return act(key, h`${what}的${thing}跟 DefiLlama 上${protocol} 登記的對不上`, h`可能不同、DefiLlama 有不只一個或沒有這個名稱，或讀不到 Public Suffix List。${command ?? ''}`);
}

function sourceChecks(entry: RegistryEntry, lines: readonly Line[]): Check[] {
  const url = new URL(entry.source);
  const github = isGitHubPage(url);
  const command = h`<code>pnpm check-sources ${entry.name}</code> 會印出比對的內容。`;
  const source = link(entry.source, github ? 'GitHub 上的來源檔案' : url.hostname);
  const sought = h`來源頁面 ${link(entry.source)}；要找的 ${entry.kind} 地址是 ${mono(checksumAddress(entry.address))}。`;
  const order: readonly Line['check'][] = ['page', 'url', 'defillama', 'github', 'coingecko'];
  return [...lines].sort((a, b) => order.indexOf(a.check) - order.indexOf(b.check)).map((line): Check => {
    const key = SOURCE_KEYS[line.check];
    const ok = line.kind === 'agrees';
    switch (line.check) {
      case 'page':
        if (ok) return pass(key, h`登記的來源頁面（不跑 JavaScript 直接讀）在標籤旁邊列出這個地址：${source}`);
        if (line.cause === 'not-served') return act(key, h`程式不跑 JavaScript，讀到的來源頁面上沒有這個地址`, sought);
        if (line.cause === 'not-fetched') return act(key, h`程式沒讀到來源頁面`, h`${sought}${command}`);
        return act(key, h`來源頁面上有這個地址，但不在標籤旁邊：${source}`, h`可能不在標籤旁邊、大小寫不對，或 registry 沒寫標籤。${command}`);
      case 'url':
        return act(key, h`登記的來源網址本身就含有這個地址：${source}`, h`很多頁面會把自己的網址顯示出來，所以頁面上出現這個地址證明不了什麼，程式不讀這種頁面。`);
      case 'defillama':
        return siteCheck(key, h`來源`, url, entry.defillama, line, command);
      case 'github':
        return ok
          ? pass(key, h`來源檔案固定在一個 commit，而且這個 commit 在 repo 的預設分支上`)
          : act(key, h`來源檔案的 commit 沒能確認在預設分支上`, h`可能沒固定在 commit、commit 不在預設分支，或 GitHub 讀不到。${command}`);
      case 'coingecko':
        return ok
          ? pass(key, h`CoinGecko 在這個地址列的就是 registry 寫的幣 ${c(entry.coingecko ?? '')}`)
          : act(key, h`CoinGecko 在這個地址沒有列出 registry 寫的幣`, h`可能沒列、列的是別的幣，或 registry 沒寫 CoinGecko 名稱。${command}`);
    }
  });
}

function docChecks(doc: DocLink, inputs: ReportInputs): Check[] {
  const url = new URL(doc.url);
  const page = inputs.pages.pages.get(pageUrlOf(doc.url));
  const named = page?.kind === 'served' && page.blocks.some((block) => wordOf(doc.fn).test(block.text));
  const fn = c(doc.fn.name);
  const key = (check: string) => `doc.${doc.fn.name}.${check}`;
  const checks: Check[] = [
    named
      ? pass(key('page'), h`官方文件頁面寫了 ${fn} 這個函式名稱：${link(doc.url)}`)
      : act(key('page'), h`程式不跑 JavaScript，讀到的文件頁面上沒有 ${fn} 這個名稱`, h`文件頁面 ${link(doc.url)}。`),
    siteCheck(key('site'), h`${fn} 的文件頁面`, url, doc.contract.defillama, sourceSiteLine(doc.url, doc.contract.defillama, inputs.listings)),
  ];
  if (isGitHubPage(url)) {
    checks.push(
      githubLine(url, inputs.pages.commits).kind === 'agrees'
        ? pass(key('commit'), h`${fn} 的文件固定在一個 commit，而且在預設分支上`)
        : act(key('commit'), h`${fn} 的文件 commit 沒能確認在預設分支上`),
    );
  }
  return checks;
}

function spanChecks(entry: RegistryEntry, verdicts: readonly string[] | undefined): Check[] {
  if (entry.code === undefined) return [{ key: 'code', status: 'act', text: h`registry 沒有記錄它的程式碼指紋`, why: h`簽名時碰到它會得到 UNVERIFIABLE。` }];
  const spans = [...entry.code.earlier, entry.code.current];
  return spans.map(({ from, pin }, i): Check => {
    const key = `code.${i + 1}`;
    const verdict = verdicts?.[i] ?? 'not read';
    const which = spans.length === 1 ? h`` : h`第 ${i + 1} / ${spans.length} 段：`;
    const proxy = pin.implementation === undefined ? h`` : h`（代理合約，背後的實作 ${mono(checksumAddress(pin.implementation.address))} 也算在內）`;
    switch (spanKind(verdict)) {
      case 'pass':
        return pass(key, h`${which}從區塊 <span class="num">${from}</span> 起執行的是記錄的程式碼${proxy}，前一個區塊${i === 0 ? '還沒有' : '是上一段的'}程式碼，兩個節點都確認`);
      case 'finding':
        return act(key, h`${which}區塊 <span class="num">${from}</span> 前後的程式碼跟記錄的不符${proxy}`, h`記錄的指紋或起始區塊可能寫錯。鏈上讀到的見「程式碼指紋」。`);
      case 'unverifiable':
        return { key, status: 'act', flag: 'UNVERIFIABLE', text: h`${which}區塊 <span class="num">${from}</span> 前後的程式碼讀不到，或兩個節點答案不同` };
      case 'not-read':
        return {
          key,
          status: 'na',
          text: h`沒有回頭查這個程式碼指紋從哪個區塊開始${proxy}`,
          why: h`這個指紋記錄得比較早，沒有記起始區塊。簽名時程式仍會比對現在的程式碼跟指紋。`,
        };
    }
  });
}

function abiCheck(entry: RegistryEntry, proof: AbiProof | AbiRefusal | undefined): Check {
  const key = 'abi';
  if (proof === undefined) return { key, status: 'na', text: h`沒有用原始碼重新編譯來比對`, why: h`repo 裡沒有這個地址的 ABI 記錄。` };
  if (proof.kind === 'refused') {
    const { refusal } = proof;
    if (refusal.why === 'compiler-not-pinned') {
      return { key, status: 'na', flag: 'REFUSED', text: h`沒有用原始碼重新編譯來比對`, why: h`它需要的編譯器 solc ${refusal.version} 還沒固定在 repo 裡。` };
    }
    return { key, status: 'act', flag: 'REFUSED', text: h`原始碼重新編譯比對沒有完成（${c(refusal.why)}）`, why: h`程式沒能證明鏈上的程式碼就是公開的原始碼。<code>pnpm prove-abi ${checksumAddress(entry.address)}</code> 會印出原因。` };
  }
  const name = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(proof.contractName) ? h`${c(proof.contractName)}，` : '';
  const proxy = proof.proxy.kind === 'none' ? '' : h`（代理合約，比對的是背後的實作 ${mono(checksumAddress(proof.proven))}）`;
  const what = h`Sourcify 上的原始碼用固定版本的編譯器重新編譯後，跟鏈上的程式碼一樣${proxy}（${name}solc ${proof.compiler}）`;
  switch (pinVerdict(entry, proof)) {
    case 'PASS':
      return pass(key, h`${what}，也就是 registry 記錄的現在指紋`);
    case 'FINDING':
      return act(key, h`${what}，但不是 registry 記錄的現在指紋`, h`簽名時程式比對的是指紋，所以被證明的程式碼跟簽名時要求的程式碼不是同一份。`);
    default:
      return { key, status: 'act', text: h`${what}，但 registry 沒有記錄程式碼指紋` };
  }
}

function marketChecks(entry: RegistryEntry, template: Template, registry: Registry): Check[] {
  if (!hasMarket(template)) return [];
  return [...registry.markets.values()].flatMap((market) =>
    MARKET_ENTRY_PARTS.filter((part) => market[part].name === entry.name).map(
      (part): Check => ({
        key: `market.${market.name}.${part}`,
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

/** A recorded Safe transaction and its card from `testdata/perturb/`, checked again with the template as it is now. */
export type FixtureRun = { readonly name: string } & ({ readonly kind: 'refused'; readonly why: string } | { readonly kind: 'checked'; readonly mutations: MutationResult });

/** Every `pnpm perturb --record` recording whose card names only this template, its fields and mutations checked offline. */
export function templateFixtures(repoRoot: string, template: Template, registry: Registry): FixtureRun[] {
  const dir = join(repoRoot, 'testdata', 'perturb');
  const templates = new Map([[template.id, template]]);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((file): FixtureRun[] => {
      const recording = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { safeTx: string; card: unknown; template?: unknown };
      const card = parseCard(recording.card);
      if (recording.template !== undefined || !card.operations.every((op) => op.template === template.id)) return [];
      const fixture = JSON.parse(readFileSync(join(repoRoot, 'testdata', 'safe-tx', `${recording.safeTx}.json`), 'utf8'));
      const tx = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
      const resolved = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
      if (resolved.kind === 'refused') return [{ name: recording.safeTx, kind: 'refused', why: resolved.detail }];
      return [{ name: recording.safeTx, kind: 'checked', mutations: checkMutations(tx, resolved.card, templates, registry) }];
    });
}

function fixtureCheck(run: FixtureRun): Check {
  const key = `fixture.${run.name}`;
  const what = h`${c(run.name)}（別的 Safe 已執行的交易，配上錄下的 card）`;
  if (run.kind === 'refused') return act(key, h`${what}：card 被拒絕`, h`${run.why}`);
  const { mutations } = run;
  switch (mutations.kind) {
    case 'pass':
      return pass(key, h`${what}：每個欄位都符合；${mutations.bound} 個被綁住的欄位一個一個改掉，每次都得到 MISMATCH`);
    case 'weak-template':
      return act(key, h`${what}：每個欄位都符合，但 ${mutations.uncaught.length} 個被綁住的欄位改掉後沒被擋下`);
    case 'not-run':
      return act(key, h`${what}：欄位檢查得到 ${mutations.check.kind.toUpperCase()}`);
  }
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
    h`交易只有這 ${calls} 個呼叫${calls > 1 ? '（用官方 MultiSend 包在一起）' : ''}，每個欄位都符合「交易裡每個欄位必須是什麼」的表，而且交易要能逐 byte 重新編碼成一樣的內容。`,
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

/** One line for a past-transactions recording; its raw output is folded under it. */
function pastTxsLine(summary: PastTxsSummary): Html {
  const { run } = summary;
  const found = [...run.found.values()];
  const by = (source: SourceName) => found.filter((s) => s.includes(source)).length;
  const kept = run.studies;
  const judged = kept.flatMap((s) => (s.kind === 'fit' || s.kind === 'misfit' ? [s] : []));
  const fromSafe = judged.filter((s) => s.sender.kind === 'safe');
  const fromEoa = judged.filter((s) => s.sender.kind === 'eoa');
  const fits = (list: readonly { readonly kind: string }[]) => list.filter((s) => s.kind === 'fit').length;
  const other = kept.length - fromSafe.length - fromEoa.length;
  const when = run.query.sampling.kind === 'spread' ? '過去一年' : '一段指定區塊';
  return h`<li>${INFO}<div>${when}的交易（${c(summary.file)}）：Alchemy 找到 ${by('alchemy')} 筆、Etherscan ${by('etherscan')} 筆；抽查 ${kept.length} 筆，Safe 送出的 ${fromSafe.length} 筆裡 ${fits(fromSafe)} 筆符合模板，EOA 直接呼叫的 ${fromEoa.length} 筆裡 ${fits(fromEoa)} 筆符合，其他 ${other} 筆不是這個操作。${PROGRAM}</div></li>`;
}

type Shown = 'shown' | 'shown-unless' | 'optional' | 'hidden' | 'absent' | 'unknown';
const SHOWN: Readonly<Record<string, Shown>> = { always: 'shown', 'shown-unless-listed-value': 'shown-unless', optional: 'optional', never: 'hidden', 'never-but-must-match': 'hidden' };

/** Each descriptor field with its path from the call's arguments, such as `marketParams.oracle`. */
function flatFields(fields: readonly FieldFact[], prefix: string): { readonly path: string; readonly visible: string }[] {
  return fields.flatMap((f) => {
    const own = f.path.replace(/^#\./, '');
    const path = f.path.startsWith('#.') || prefix === '' ? own : `${prefix}.${own}`;
    return f.kind === 'group' ? flatFields(f.fields, path) : [{ path, visible: f.visible }];
  });
}

const covers = (field: string, arg: string) => arg === field || arg.startsWith(`${field}.`);

function shownOf(arg: string, fields: readonly { readonly path: string; readonly visible: string }[], excluded: readonly string[]): Shown {
  if (excluded.some((e) => covers(e.replace(/^#\./, ''), arg))) return 'hidden';
  const [field] = fields.filter((f) => covers(f.path, arg)).sort((a, b) => b.path.length - a.path.length);
  return field === undefined ? 'absent' : (SHOWN[field.visible] ?? 'unknown');
}

/**
 * The signer's words for a call argument, by its path from the call's arguments or by its own name. A descriptor's label
 * text is never shown: any argument not here shows its ABI name.
 */
const LABELS: Readonly<Record<string, string>> = {
  'loanTokenPermit.kind': '拉代幣方式',
  'loanTokenPermit.data': 'permit 簽章',
  assets: '金額',
  amount: '金額',
  value: '金額',
  shares: '份額',
  spender: '授權對象',
  receiver: '收款人',
  onBehalf: '代表誰',
  owner: '擁有者',
  loanToken: '借出代幣',
  collateralToken: '抵押品',
  oracle: 'oracle',
  irm: '利率模型',
  lltv: 'LLTV',
  deadline: '截止時間',
  referralFeePct: '推薦費比例',
  referralFeeRecipient: '推薦費收款人',
};
const labelOf = (arg: string): string => LABELS[arg] ?? LABELS[arg.split('.').at(-1) as string] ?? (arg.split('.').at(-1) as string);

/** A field's rule as one short value on the mock wallet screen, such as `cbbtc` or `86%`. */
function screenValue(rule: Rule, template: Template, registry: Registry): Html {
  switch (rule.kind) {
    case 'card': {
      const field = template.card.get(rule.ref.field);
      if (field?.kind === 'amount') {
        const tokens = field.of === 'eth' ? ['ETH'] : refNames(field.of, template, registry);
        return h`你在 card 填的數量${tokens.length === 0 ? '' : h`（${tokens.join('、')}）`}`;
      }
      if (field?.kind === 'market' && rule.ref.attribute === 'lltv') {
        return h`${joined([...registry.markets.values()].map((m) => percent(m.lltv) || String(m.lltv)), '、')}`;
      }
      if (field?.kind === 'market' && rule.ref.attribute === undefined) return h`${joined([...registry.markets.values()].map((m) => m.name), '、')}`;
      const names = refNames(rule.ref, template, registry);
      return names.length === 0 ? h`card 上的 ${rule.ref.field}` : h`${names.join('、')}`;
    }
    case 'safe':
      return h`你的 Safe`;
    case 'contract':
      return h`${rule.name}`;
    case 'const':
      return h`${constText(rule.value)}`;
    case 'free':
      return h`任意`;
    case 'equals':
      return screenValue(rule.rule, template, registry);
    default:
      return ruleZh(rule, template, registry);
  }
}

/** Whether a rule names a part of a card market, which a wallet must show for the signer to tell markets apart. */
const namesMarketPart = (rule: Rule, template: Template): boolean =>
  rule.kind === 'equals' ? namesMarketPart(rule.rule, template) : rule.kind === 'card' && template.card.get(rule.ref.field)?.kind === 'market';

const RAW_SCREEN = h`<div class="screen raw"><div class="line">原始資料（看不懂的十六進位）</div></div>`;

/** A mock of the hardware-wallet screen for each call the template makes, from the ERC-7730 descriptor facts alone. */
function walletSection(template: Template, groups: readonly FieldGroup[], inputs: ReportInputs): Html {
  const { registry } = inputs;
  const calls = template.calls.flatMap((call, i) => {
    if (call.data === 'empty') return [];
    const n = i + 1;
    const fn = call.data.fn;
    const rows = (groups.find((g) => g.call === n)?.rows ?? []).flatMap((row) => {
      const arg = argPath(row, template, n);
      return arg === undefined || row.of === undefined ? [] : [{ row, arg, rule: row.of }];
    });
    return namesOf(call.to, template, registry).map((name) => {
      const head = h`<h3>呼叫 ${n}：${c(fn.name)}，對象 ${c(name)}</h3>`;
      const report = inputs.erc7730.reports.find((r) => r.entry.name === name);
      if (report === undefined) return h`<div class="device">${head}${RAW_SCREEN}<p class="note">程式沒有讀這個合約的 ERC-7730 描述檔。${PROGRAM}</p></div>`;
      const found = report.descriptors.flatMap((d) => d.functions.filter((f) => f.selector === fn.selector).map((f) => ({ d, f })));
      if (found.length === 0) return h`<div class="device">${head}${RAW_SCREEN}<p class="note">沒有描述這個函式的描述檔，錢包只能顯示原始資料。${PROGRAM}</p></div>`;
      return found.map(({ d, f }) => {
        const fields = flatFields(f.fields, '');
        const seen = rows.map((r) => ({ ...r, shown: shownOf(r.arg, fields, f.excluded) }));
        const lines = seen.filter((r) => r.shown === 'shown' || r.shown === 'shown-unless').map((r) => h`<div class="line"><span class="label">${labelOf(r.arg)}</span>${screenValue(r.rule, template, registry)}</div>`);
        const unseen = (which: readonly Shown[]) => seen.filter((r) => r.row.bound && which.includes(r.shown));
        const hidden = unseen(['hidden', 'absent', 'unknown']);
        const maybe = unseen(['optional']);
        const says: Html[] = [];
        if (hidden.length > 0) {
          const market = hidden.some((r) => namesMarketPart(r.rule, template)) ? '只看錢包分不出是哪個 market。' : '這些只有 kiss-sign 會檢查。';
          says.push(h`<p class="unseen"><b>錢包不會顯示：</b>${hidden.map((r) => labelOf(r.arg)).join('、')}。${market}${PROGRAM}</p>`);
        }
        if (maybe.length > 0) says.push(h`<p class="unseen"><b>錢包不一定顯示：</b>${maybe.map((r) => labelOf(r.arg)).join('、')}。${PROGRAM}</p>`);
        const screen = lines.length === 0 ? RAW_SCREEN : h`<div class="screen">${lines}</div>`;
        return h`<div class="device">${head}${screen}${says}<p class="note">描述檔 ${c(d.path)}${PROGRAM}</p></div>`;
      });
    });
  });
  return h`<p class="note">畫面是程式用 repo 固定版本的 ERC-7730 描述檔排出來的：只列描述檔說錢包會顯示的欄位，名稱用中文或參數原名，值是模板對它的規定。實際字樣以錢包為準，描述檔的原文不放在這頁。</p>${calls}`;
}

const CSS = `:root {
  color-scheme: dark;
  --bg: #101318; --paper: #171b22; --raised: #1d232c; --ink: #e3e7ed; --muted: #9aa3b0; --rule: #2a313b; --accent: #7fa8de;
  --ok: #a9b8cb; --ok-bg: #242c37; --warn: #e3ac52; --warn-bg: #33281a; --na: #8b94a1; --na-bg: #222831; --code-bg: #1f252e;
  --screen: #07090c; --screen-ink: #d6dbe2; --screen-rule: #3a4350;
  --font-body: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  background: var(--bg); color: var(--ink); font-family: var(--font-body); font-size: 16px; line-height: 1.7; margin: 0;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 0 80px;
}
.wrap { max-width: 760px; margin: 0 auto; display: grid; gap: 40px; }
header { padding-top: 40px; display: grid; gap: 8px; }
.kicker { font-family: var(--font-mono); font-size: 13px; color: var(--muted); }
h1 { font-size: clamp(25px, 4.5vw, 32px); line-height: 1.3; margin: 0; text-wrap: balance; color: var(--ink); }
h2 { font-size: 21px; margin: 0; text-wrap: balance; color: var(--ink); }
h3 { font-size: 17px; margin: 0; color: var(--ink); }
p { margin: 0; max-width: 66ch; }
section { display: grid; gap: 14px; }
.lede { font-size: 17px; }
.note { color: var(--muted); font-size: 14.5px; }
.mono, code { font-family: var(--font-mono); font-size: 0.84em; overflow-wrap: anywhere; }
code { background: var(--code-bg); color: var(--ink); padding: 1px 5px; border-radius: 4px; }
a { color: var(--accent); overflow-wrap: anywhere; }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.steps { margin: 0; padding-left: 1.4em; display: grid; gap: 6px; }
.panel { background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; padding: 18px 20px; display: grid; gap: 12px; }
.panel.attention { border-color: var(--warn); }
.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.checks li { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 4px 10px; align-items: start; }
.panel.attention .checks { gap: 18px; }
.mark { width: 22px; height: 22px; border-radius: 50%; display: inline-grid; vertical-align: middle; place-items: center; font-size: 13px; font-weight: 700; margin-top: 3px; }
.mark.ok { color: var(--ok); background: var(--ok-bg); }
.mark.warn { color: var(--warn); background: var(--warn-bg); }
.mark.na { color: var(--na); background: var(--na-bg); }
.mark.info { color: var(--accent); background: var(--ok-bg); font-family: var(--font-mono); font-size: 12px; }
.why { color: var(--muted); font-size: 14.5px; }
.result { display: block; }
.review { margin-top: 8px; padding: 10px 14px; border-radius: 6px; background: var(--raised); border-left: 3px solid var(--na); display: grid; gap: 4px; font-size: 15px; }
.review.confirmed { border-left-color: var(--accent); }
.review.confirmed > div:first-child b { color: var(--accent); }
.review.concern { border-left-color: var(--warn); background: var(--warn-bg); }
.review.concern > div:first-child b { color: var(--warn); }
.rec { font-size: 14.5px; color: var(--ink); margin-top: 4px; }
.flag { font-family: var(--font-mono); font-size: 12px; color: var(--warn); margin-right: 6px; }
.by { font-size: 12px; font-weight: 500; letter-spacing: .03em; padding: 0 7px; border-radius: 999px; white-space: nowrap; vertical-align: 1px; margin-left: 6px; }
.by.prog { color: var(--accent); border: 1px solid var(--accent); }
.by.ai { color: var(--muted); border: 1px dashed var(--muted); }
.addr { background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
.addr-head { padding: 16px 20px 12px; display: grid; gap: 4px; border-bottom: 1px solid var(--rule); }
.addr-head .name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.addr-head .full { font-family: var(--font-mono); font-size: 14px; overflow-wrap: anywhere; }
.role { color: var(--muted); font-size: 15px; }
.addr-body { padding: 16px 20px; display: grid; gap: 14px; }
.table-frame { overflow-x: auto; background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 15px; line-height: 1.55; color: var(--ink); }
th, td { text-align: left; vertical-align: top; padding: 10px 14px; border-bottom: 1px solid var(--rule); }
th { font-size: 13px; color: var(--muted); font-weight: 500; background: var(--raised); }
tr:last-child td { border-bottom: 0; }
td.path { width: 32%; }
td.path code { overflow-wrap: normal; word-break: normal; }
td.nowrap { white-space: nowrap; }
td.group { background: var(--raised); font-weight: 500; font-size: 14px; }
.num { font-variant-numeric: tabular-nums; }
details { background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; padding: 12px 18px; }
summary { cursor: pointer; font-weight: 500; }
details[open] summary { margin-bottom: 10px; }
pre { font-family: var(--font-mono); font-size: 12px; line-height: 1.5; overflow-x: auto; background: var(--code-bg); color: var(--ink); padding: 12px; border-radius: 6px; margin: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13.5px; color: var(--muted); align-items: center; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend .mark, summary .mark { margin-top: 0; }
.tally { font-size: 14.5px; }
.addr-body details, .panel details { background: none; border: 0; padding: 0; }
.addr-body details summary, .panel details summary { color: var(--muted); font-size: 14.5px; font-weight: 400; }
.wallet { display: grid; gap: 22px; }
.device { display: grid; gap: 10px; }
.device h3 { font-size: 15.5px; }
.screen { background: var(--screen); color: var(--screen-ink); border: 2px solid var(--screen-rule); border-radius: 12px; padding: 14px 16px; max-width: 420px; font-family: var(--font-mono); font-size: 13.5px; display: grid; gap: 8px; }
.screen .line { display: grid; gap: 0; border-bottom: 1px solid var(--screen-rule); padding-bottom: 6px; overflow-wrap: anywhere; }
.screen .line:last-child { border-bottom: 0; padding-bottom: 0; }
.screen .label { color: var(--muted); font-family: var(--font-body); font-size: 12.5px; }
.screen.raw { color: var(--muted); }
.unseen { font-size: 15px; }
.unseen b { color: var(--warn); }
.overview { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.overview > li { display: grid; grid-template-columns: 8.5em minmax(0, 1fr); gap: 2px 14px; font-size: 15px; }
.overview > li .label { color: var(--muted); font-size: 14px; }
.overview ul { margin: 0; padding-left: 1.2em; }
@media (max-width: 560px) { .overview > li { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }`;


const FONTS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap';

function percent(lltv: bigint): string {
  const unit = 10n ** 16n;
  return lltv % unit === 0n ? `${lltv / unit}%` : '';
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
      lists.push(h`<details><summary>card 的 ${c(name)} 可以選的合約</summary><div class="table-frame"><table><thead><tr><th>名稱</th><th>地址</th></tr></thead><tbody>${items}</tbody></table></div></details>`);
    }
    if (field.kind === 'market') {
      const items = [...registry.markets.values()].map(
        (m) => h`<tr><td>${c(m.name)}</td><td class="mono">${m.id}</td><td class="num">${m.lltv}${percent(m.lltv) === '' ? '' : `（${percent(m.lltv)}）`}</td></tr>`,
      );
      lists.push(
        h`<details><summary>card 的 ${c(name)} 可以選的 market（五個參數見各地址）</summary><div class="table-frame"><table><thead><tr><th>名稱</th><th>market id</th><th>LLTV</th></tr></thead><tbody>${items}</tbody></table></div></details>`,
      );
    }
  }
  return h`<div class="table-frame"><table><thead><tr><th>card 欄位</th><th>填什麼 ${PROGRAM}</th></tr></thead><tbody>${rows}</tbody></table></div>${lists}`;
}

function tally(checks: readonly Check[]): Html {
  const count = (status: Status) => checks.filter((check) => check.status === status).length;
  const parts = [h`${count('ok')} 項確認`];
  if (count('act') > 0) parts.push(h`${count('act')} 項需要你看`);
  if (count('na') > 0) parts.push(h`${count('na')} 項沒比對`);
  return joined(parts, '、');
}

function entryArticle(card: EntryCard, notes: Notes): Html {
  const { entry } = card;
  const ai = notes.entries.get(entry.name);
  const line = (check: Check) => ai?.checks.get(check.key);
  const role = ai?.role === undefined ? '' : h`<div class="role">${ai.role}${AI}</div>`;
  const acts = card.checks.filter((check) => check.status === 'act');
  const rest = card.checks.filter((check) => check.status !== 'act');
  const roles = card.roles.length === 0 ? '' : h`<p class="why">在這筆交易裡：${joined(card.roles, '；')}${PROGRAM}</p>`;
  const folded = h`<details><summary>其他 ${rest.length} 項（${MARKS.ok} 確認、${MARKS.na} 沒比對）</summary>${roles}<ul class="checks">${rest.map((check) => checkItem(check, line(check)))}</ul></details>`;
  const aiNotes = ai === undefined || ai.notes.length === 0 ? '' : h`<details><summary>AI 另外查到（${ai.notes.length} 則）</summary>${bullets(ai.notes.map((n) => noteItem(n)))}</details>`;
  return h`<article class="addr" id="entry-${entry.name}">
<div class="addr-head"><div class="name"><h3>${entry.name}</h3><span class="role">${entry.kind}</span></div><div class="full">${checksumAddress(entry.address)}</div>${role}<div class="tally">${tally(card.checks)}${PROGRAM}</div></div>
<div class="addr-body">${acts.length === 0 ? '' : h`<ul class="checks">${acts.map((check) => checkItem(check, line(check)))}</ul>`}${folded}${aiNotes}</div>
</article>`;
}

/** A program result the signer must look at, with its id in `notes.json`'s `reviews`. */
type Action = { readonly id: string; readonly check: Check; readonly head: Part };

function actionsOf(cards: readonly EntryCard[], fixtures: readonly Check[]): Action[] {
  return [
    ...cards.flatMap(({ entry, checks }) =>
      checks.filter((check) => check.status === 'act').map((check) => ({ id: `${entry.name}/${check.key}`, check, head: h`<b><a href="#entry-${entry.name}">${entry.name}</a>：</b>` })),
    ),
    ...fixtures.filter((check) => check.status === 'act').map((check) => ({ id: check.key, check, head: '' })),
  ];
}

/** Refuses notes that leave a result the signer must look at without the AI's review, or review any other result. */
function reviewsKnown(actions: readonly Action[], notes: Notes): void {
  const ids = actions.map((action) => action.id);
  const missing = ids.find((id) => !notes.reviews.has(id));
  if (missing !== undefined) throw new NotesError(`${NOTES_FILE}.reviews: "${missing}" is a result the signer must look at and has no review`);
  const extra = [...notes.reviews.keys()].find((id) => !ids.includes(id));
  if (extra !== undefined) throw new NotesError(`${NOTES_FILE}.reviews: "${extra}" is not a result the signer must look at; those are ${ids.join(', ') || 'none'}`);
}

/** Each program result for the signer to look at, its one line and then the AI's review of it, then the AI's few judgments. */
function actionSection(actions: readonly Action[], notes: Notes): Html {
  const program = actions.map(
    ({ id, check, head }) => h`<li>${MARKS[check.status]}<div><div class="result">${flagOf(check)}${head}${check.text}${PROGRAM}</div>${reviewBlock(notes.reviews.get(id) as Review)}</div></li>`,
  );
  const items = [...program, ...notes.judgments.map(judgmentItem)];
  if (items.length === 0) return h`<p>沒有。</p>`;
  return h`<div class="panel attention"><ul class="checks">${items}</ul></div>`;
}

/** The protocol at a glance: the AI's overview lines, then how long each contract's code has run unchanged. */
function overviewSection(entries: readonly RegistryEntry[], inputs: ReportInputs, notes: Notes): Html {
  const ai = notes.overview.map((item) => h`<li><span class="label">${item.title}</span><div>${item.text}${AI}${sourcesOf(item)}</div></li>`);
  const code = entries.map((entry) => {
    if (entry.code === undefined) return h`<li>${c(entry.name)}：registry 沒有記錄程式碼指紋</li>`;
    const { from } = entry.code.current;
    const verdict = inputs.spans.get(entry.address)?.[entry.code.earlier.length] ?? 'not read';
    const kind = spanKind(verdict);
    const said = kind === 'pass' ? h`程式碼自區塊 <span class="num">${from}</span> 起沒變過` : kind === 'not-read' ? h`程式碼沒查從哪個區塊開始` : h`程式碼從哪個區塊開始沒能確認（${verdict.split(' ')[0]}）`;
    return h`<li>${c(entry.name)}：${said}</li>`;
  });
  return h`<ul class="overview">${ai}<li><span class="label">程式碼多久沒變</span><div><ul>${code}</ul>${PROGRAM}</div></li></ul>`;
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
  const groups = notes.details.map((group) => h`<details><summary>${group.title}${AI}</summary>${bullets(group.notes.map((n) => noteItem(n)))}</details>`);
  return h`<details><summary>程式碼指紋（每一段從哪個區塊開始）</summary><div class="table-frame"><table><thead><tr><th>合約</th><th>起始區塊</th><th>程式碼指紋</th><th>背後的實作</th><th>鏈上檢查</th></tr></thead><tbody>${spans}</tbody></table></div></details>
<details><summary>原始碼重新編譯的結果</summary><div class="table-frame"><table><thead><tr><th>合約</th><th>結果</th><th>程式碼指紋</th><th>比對時遮掉的部分</th><th>讀取區塊</th></tr></thead><tbody>${abi}</tbody></table></div></details>
${vaults}
${groups}`;
}

/** Refuses a `notes.json` check line whose key no result of that entry's card has, so no line hangs unseen. */
function checkLinesKnown(cards: readonly EntryCard[], notes: Notes): void {
  for (const [name, entry] of notes.entries) {
    const keys = new Set(cards.find((card) => card.entry.name === name)?.checks.map((check) => check.key) ?? []);
    for (const key of entry.checks.keys()) {
      if (!keys.has(key)) throw new NotesError(`${NOTES_FILE}.entries.${name}.checks: "${key}" is not a result of this entry; its results are ${[...keys].join(', ')}`);
    }
  }
}

/** The HTML report of a template: the same recordings as its Markdown report, read for the signer, with the AI's notes beside them. */
export function renderHtml(inputs: ReportInputs, notes: Notes, title: ReportTitle, fixtures: readonly FixtureRun[]): string {
  const { subject, registry } = inputs;
  if (subject.kind !== 'template') throw new Error('an HTML report is of a template');
  const { template } = subject;
  const groups = fieldGroups(template, registry);
  const cards = entryCards(subject, inputs, groups);
  checkLinesKnown(cards, notes);
  const fixtureChecks = fixtures.map(fixtureCheck);
  const actions = actionsOf(cards, fixtureChecks);
  reviewsKnown(actions, notes);
  const signing = signingChecks(template, registry);
  const tested = [
    ...fixtureChecks.map((check) => checkItem(check, undefined)),
    ...inputs.pastTxs.map(pastTxsLine),
    ...notes.tests.map((n) => noteItem(n, INFO)),
  ];
  const rawPast = inputs.pastTxs.map((p) => h`<details><summary>過去交易搜尋的原始輸出：${p.file}</summary><pre>${p.text.trimEnd()}</pre></details>`);
  const page = h`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
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
<h1>${notes.title}</h1>
<p class="lede">${notes.summary}${AI}</p>
<p class="note">標「程式」的是程式檢查的結果，可以重跑；標「AI 研究」的是 AI 寫的，程式沒有驗證。這頁由 ${c(title.command)} 產生，不要手動修改；合併前用 ${c(`pnpm report ${template.id} --compare`)} 重新即時讀一次。</p>
</header>

<section>
<h2>你在 card 上填的</h2>
${cardSection(template, registry)}
<details><summary>交易的每一步${AI}</summary><ol class="steps">${notes.steps.map((step) => h`<li>${step}</li>`)}</ol></details>
</section>

<section>
<h2>需要你做的事</h2>
${actionSection(actions, notes)}
</section>

<section>
<h2>硬體錢包上會看到什麼</h2>
<div class="wallet">${walletSection(template, groups, inputs)}</div>
</section>

<section>
<h2>每個地址確認了什麼</h2>
<div class="legend">
<span>${MARKS.ok}確認了</span>
<span>${MARKS.act}需要你看</span>
<span>${MARKS.na}沒東西可比，或沒做</span>
</div>
${cards.map((card) => entryArticle(card, notes))}
</section>

<section>
<h2>拿真實交易測過</h2>
${tested.length === 0 ? h`<p>沒有記錄。${PROGRAM}</p>` : h`<ul class="checks">${tested}</ul>`}
${rawPast}
</section>

<section>
<h2>細節</h2>
<div class="panel"><h3>協議概況</h3>${overviewSection(entriesOf(subject, registry), inputs, notes)}</div>
<details><summary>每次簽名前，程式會自動檢查的 ${signing.length} 件事</summary><ul class="checks">${signing.map((text) => checkItem(pass('signing', text), undefined))}</ul></details>
<details><summary>交易裡每個欄位必須是什麼</summary>${fieldTable(groups, notes)}</details>
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
