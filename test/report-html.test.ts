import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { loadRegistry, pageUrlsOf } from '../src/registry.ts';
import { STANDARDS } from '../src/research/standards.ts';
import { NOTES_FILE, notesLanguages, notesPath, readNotes } from '../src/research/notes.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { LANGUAGES, isLanguage } from '../src/language.ts';
import type { Language } from '../src/language.ts';
import { OLD_HTML_FILE, generatedHtml, generatedHtmlFile, generatedHtmlPath, htmlDifference, renderPage, writeHtmlPages } from '../src/research/report-html.ts';
import { buildPage } from '../src/research/report-page.ts';
import { loadReport, readDocs, replayInputs, reportDir, templateTargets } from '../src/research/report.ts';
import type { PastTxsSection, ReportInputs, ReportTitle } from '../src/research/report.ts';
import type { YearSearch } from '../src/research/past-txs.ts';
import { firstRecordedTx, judgeFixtures } from '../src/template/perturb.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { NOT_YET_REBUILT, reportedInstances } from '../src/template/vault-reports.ts';
import { PREDATE_REPORT } from './predate-report.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const templates = readdirSync(join(ROOT, TEMPLATES_DIR)).flatMap((protocol) => readdirSync(join(ROOT, TEMPLATES_DIR, protocol)).map((operation) => `${protocol}/${operation}`));
const has = (id: string, file: string) => existsSync(join(ROOT, TEMPLATES_DIR, id, file));
const FIXTURES = repoWithTestFixtures();
const MARKET: ReturnType<typeof templateTargets>[number] = { template: 'morpho/market-supply' };
/** Each report with notes.json, by its folder: every template's in the repository, and the test fixtures' market-supply. */
const withNotes = new Map([
  ...templateTargets(ROOT, registry)
    .filter((t) => has(t.template, NOTES_FILE))
    .map((target) => [reportDir(ROOT, target), { target, root: ROOT, registry }] as const),
  [reportDir(FIXTURES, MARKET), { target: MARKET, root: FIXTURES, registry: loadRegistry(FIXTURES) }] as const,
]);
const reportOf = (path: string) => withNotes.get(path) ?? assert.fail(path);
const notesOf = (path: string): unknown => {
  const { target, root, registry } = reportOf(path);
  return readNotes(root, target.template, target.instance === undefined ? undefined : registry.entries.get(target.instance));
};

/** Each report's page in each language, by its folder. */
const pages = new Map<string, { readonly inputs: ReportInputs; readonly title: ReportTitle; readonly html: ReadonlyMap<Language, string> }>();
/** Every page of every report, by the path it is committed at. */
const replayed = new Map<string, { readonly dir: string; readonly language: Language; readonly html: string }>();

before(async () => {
  const compilers = await warmCompilers([...withNotes.values()].flatMap(({ target, root, registry }) => reportCases(root, registry, [target])));
  for (const [dir, { target, root, registry }] of withNotes) {
    const { inputs, title } = await replayInputs(root, registry, target, compilers, loadPublicSuffixList());
    const html = (await generatedHtml(root, inputs, title)) ?? assert.fail(`${dir}: notes but no HTML`);
    pages.set(dir, { inputs, title, html });
    for (const [language, page] of html) replayed.set(generatedHtmlPath(root, target, language), { dir, language, html: page });
  }
});

test('a report commits a page in exactly the languages its notes hold, none without notes.json, no old one-language page, and none has report.md', () => {
  for (const target of templateTargets(ROOT, registry)) {
    const raw = readNotes(ROOT, target.template, target.instance === undefined ? undefined : registry.entries.get(target.instance));
    const held = raw === undefined ? [] : notesLanguages(raw);
    for (const language of LANGUAGES) {
      const path = generatedHtmlPath(ROOT, target, language);
      assert.equal(existsSync(join(ROOT, path)), held.includes(language), `${path}: committed in a language the notes do not hold, or missing in one they hold`);
    }
  }
  for (const id of templates) assert.ok(!has(id, 'report.md'), `${id} has report.md, which notes.json replaced`);
  const old = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? old(join(dir, entry.name)) : entry.name === OLD_HTML_FILE ? [join(dir, entry.name)] : []));
  assert.deepEqual(old(join(ROOT, TEMPLATES_DIR)), [], `${OLD_HTML_FILE} remains beside the pages in each language that replace it`);
});

test('a template reported per vault keeps no report of its own, and each vault report has its notes.json', () => {
  const perVault = templates.filter((id) => templateTargets(ROOT, registry).some((t) => t.template === id && t.instance !== undefined));
  assert.ok(perVault.includes('morpho/vault-deposit'));
  for (const id of perVault) {
    for (const file of [...LANGUAGES.map(generatedHtmlFile), 'report.generated.md']) assert.ok(!has(id, file), `${id} is reported per vault but has ${file}`);
    for (const target of templateTargets(ROOT, registry).filter((t) => t.template === id)) assert.ok(existsSync(join(ROOT, notesPath(ROOT, id, target.instance))), `${target.instance} has no ${NOTES_FILE}`);
  }
});

test('only a template not yet rebuilt may lack notes.json', () => {
  for (const id of templates) assert.ok(has(id, NOTES_FILE) || NOT_YET_REBUILT.has(id), `${id} has no ${NOTES_FILE} and is not in the list of templates not yet rebuilt`);
  for (const id of NOT_YET_REBUILT) assert.ok(templates.includes(id) && !has(id, NOTES_FILE), `${id} is listed as not yet rebuilt but has ${NOTES_FILE} or no folder`);
});

test('the list of templates not yet rebuilt only shrinks: each one predates the generated report', () => {
  for (const id of NOT_YET_REBUILT) assert.ok(PREDATE_REPORT.has(id), `${id} is listed as not yet rebuilt, but only a template older than the generated report may be`);
});

test('a template without notes.json gets no HTML report', async () => {
  const { subject } = loadReport(ROOT, registry, { template: 'eth/transfer' });
  const withoutNotes = mkdtempSync(join(tmpdir(), 'kiss-sign-no-notes-'));
  assert.equal(await generatedHtml(withoutNotes, { subject, registry, fixtures: [] } as unknown as ReportInputs, { command: '', sources: [] }), undefined);
});

test('each committed HTML report is what the program writes from the recordings and notes.json, byte for byte, in each language', () => {
  assert.ok([...withNotes.values()].some((report) => report.root === ROOT));
  for (const [path, { dir, language, html }] of replayed) {
    if (reportOf(dir).root === ROOT) assert.equal(htmlDifference(generatedHtmlFile(language), readFileSync(join(ROOT, path), 'utf8'), html), undefined, path);
  }
});

test("each page is in its language: its lang attribute, and the Chinese page's words never on the English page", () => {
  for (const [path, { language, html }] of replayed) {
    assert.ok(html.includes(`<html lang="${language === 'en' ? 'en' : 'zh-Hant'}">`), path);
    if (language === 'en') {
      const { rest } = withoutAi(html);
      const han = /[\u4e00-\u9fff]/.exec(rest.replace(/<style>[\s\S]*?<\/style>/, ''));
      assert.equal(han, null, `${path}: Chinese outside the AI text: ${han?.input.slice(Math.max(0, han.index - 60), han.index + 20)}`);
    }
  }
});

const unescape = (text: string): string => text.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));

/** The page with every element that carries `data-ai` cut out, and each cut element's markup. */
function withoutAi(html: string): { readonly rest: string; readonly cut: readonly string[] } {
  const cut: string[] = [];
  let rest = html;
  for (let open = /<(\w+)[^>]*\sdata-ai[\s>]/.exec(rest); open !== null; open = /<(\w+)[^>]*\sdata-ai[\s>]/.exec(rest)) {
    const tag = open[1] as string;
    const tags = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g');
    tags.lastIndex = open.index + 1;
    let depth = 1;
    let end = rest.length;
    for (let m = tags.exec(rest); m !== null; m = tags.exec(rest)) {
      depth += m[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    cut.push(rest.slice(open.index, end));
    rest = rest.slice(0, open.index) + rest.slice(end);
  }
  return { rest, cut };
}

/** Whether a notes.json value is one AI text: an object keyed by languages alone. */
const isText = (raw: object): boolean => Object.keys(raw).length > 0 && Object.keys(raw).every(isLanguage);
/** The first report whose notes hold both languages, which a test that edits a text in each language needs. */
const bilingual = (where: (dir: string) => boolean = () => true): string =>
  [...withNotes.keys()].find((dir) => notesLanguages(notesOf(dir)).length === LANGUAGES.length && where(dir)) ?? assert.fail('a report whose notes hold both languages');

/** Every piece of text in notes.json a page in `language` prints: its language's text, never a URL or an enum value. */
function noteTexts(raw: unknown, language: Language): string[] {
  if (Array.isArray(raw)) return raw.flatMap((item) => noteTexts(item, language));
  if (typeof raw !== 'object' || raw === null) return [];
  const text = (raw as Record<string, unknown>)[language];
  if (typeof text === 'string' && isText(raw)) return [text];
  return Object.entries(raw).flatMap(([key, value]) => (key === 'from' || key === 'to' ? [] : noteTexts(value, language)));
}

test('the HTML report holds no script and loads nothing', () => {
  for (const [id, { html }] of replayed) {
    for (const banned of [/<script/i, /<link/i, /@import/i, /src=/i, /<img/i, /<iframe/i]) assert.doesNotMatch(html, banned, id);
    for (const [, target] of html.matchAll(/url\(([^)]*)\)/g)) assert.match(target as string, /^#[a-z-]+$/, `${id}: url(${target})`);
  }
});

test('every link is a URL the registry, docs.json, notes.json or a computed card field holds, a standard\'s page, one the program builds from an id a parser checked, or an id on the page', () => {
  for (const [id, { dir, html }] of replayed) {
    const notes = notesOf(dir);
    const { target, root, registry } = reportOf(dir);
    const folder = join(root, TEMPLATES_DIR, target.template);
    const docs = readDocs(root, target.template, target.instance) as Record<string, { url: string }>;
    const card = (JSON.parse(readFileSync(join(folder, 'template.json'), 'utf8')) as { card: Record<string, { computed?: { default: { source: string } } }> }).card;
    const allowed = new Set<string>([
      'https://defillama.com/hacks',
      ...[...registry.entries.values()].flatMap((e) => [
        ...pageUrlsOf(e),
        ...(e.apiSource === undefined ? [] : [e.apiSource.url]),
        ...(e.coingecko === undefined ? [] : [`https://www.coingecko.com/en/coins/${e.coingecko}`]),
        ...(e.defillama === undefined ? [] : [`https://defillama.com/protocol/${e.defillama}`]),
        ...(e.immunefi === undefined ? [] : [`https://immunefi.com/bug-bounty/${e.immunefi}/`]),
        ...(e.sdk === undefined ? [] : [`https://www.npmjs.com/package/${e.sdk.package}/v/${e.sdk.version}`]),
      ]),
      ...Object.values(docs).map((d) => d.url),
      ...[...STANDARDS.values()].map((standard) => standard.page),
      ...Object.values(card).flatMap((field) => (field.computed === undefined ? [] : [field.computed.default.source])),
      ...(JSON.stringify(notes).match(/https:\/\/[^"]+/g) ?? []),
    ]);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => unescape(m[1] as string)));
    for (const [, raw] of html.matchAll(/\shref="([^"]*)"/g)) {
      const href = unescape(raw as string);
      if (href.startsWith('#')) assert.ok(ids.has(href.slice(1)), `${id}: ${href} names no id on the page`);
      else {
        const built = /^https:\/\/(etherscan\.io\/(tx\/0x[0-9a-f]{64}|address\/0x[0-9a-fA-F]{40})|www\.coingecko\.com\/en\/coins\/[a-z0-9._-]+|immunefi\.com\/bug-bounty\/[a-z0-9-]+\/|github\.com\/[a-z0-9-]+)$/;
        assert.ok(allowed.has(href) || built.test(href), `${id}: ${href} is not a URL the report may link`);
      }
    }
  }
});

/** How long a piece of AI text must be before the page printing it elsewhere counts as a leak, not a common phrase: English takes about three times the characters. */
const SHORTEST_LEAK: Readonly<Record<Language, number>> = { 'zh-TW': 6, en: 18 };

test('every text the AI wrote is inside an element with its dashed AI tag, and nowhere else', () => {
  for (const [id, { dir, language, html }] of replayed) {
    const { rest, cut } = withoutAi(html);
    assert.ok(cut.length > 0, id);
    for (const element of cut) assert.match(element, /class="(byai|tagt)"/, `${id}: AI text without its tag: ${element.slice(0, 120)}`);
    const plain = noteTexts(notesOf(dir), language).flatMap((text) => text.split('`').filter((part, i) => i % 2 === 0 && part.length >= SHORTEST_LEAK[language]));
    assert.ok(plain.length > 0, `${id}: no text of notes.json in ${language}`);
    for (const text of plain) assert.ok(!unescape(rest).includes(text), `${id}: ${text} outside an AI element`);
  }
});

/** One AI text, the same in both languages. */
const both = (text: string) => ({ en: text, 'zh-TW': text });

test('AI text is HTML-escaped', async () => {
  const id = bilingual();
  const { inputs, title } = pages.get(id) ?? assert.fail(id);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail(id);
  const raw = notesOf(id) as Record<string, unknown>;
  const html = renderPage(
    buildPage(
      { ...inputs, fixtures: await judgeFixtures(ROOT, template, registry), example: firstRecordedTx(ROOT, template, registry) },
      { ...raw, title: both('<b>&"x</b>'), summary: both("<script>alert('x')</script>") },
      title,
      'en',
    ),
  );
  assert.ok(!html.includes('<b>&"x</b>') && !html.includes('<script>'));
  const { cut } = withoutAi(html);
  assert.ok(cut.some((element) => element.includes('&#60;b&#62;&#38;&#34;x&#60;/b&#62;')));
  assert.ok(cut.some((element) => element.includes('&#60;script&#62;alert(&#39;x&#39;)&#60;/script&#62;')));
});

test('a code span in AI text prints as <code> in prose and as a boxed monospace span in the diagram, escaped', async () => {
  const id = bilingual((path) => ((notesOf(path) as { flow?: unknown[] }).flow ?? []).length > 0);
  const { inputs, title } = pages.get(id) ?? assert.fail(id);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail(id);
  const raw = notesOf(id) as { flow: { text: unknown }[] } & Record<string, unknown>;
  const flow = raw.flow.map((line, i) => (i === 0 ? { ...line, text: { en: 'Calls `erc20TransferFrom`, then `erc4626Deposit`', 'zh-TW': '依序呼叫 `erc20TransferFrom` 和 `erc4626Deposit`' } } : line));
  const html = renderPage(
    buildPage(
      { ...inputs, fixtures: await judgeFixtures(ROOT, template, registry), example: firstRecordedTx(ROOT, template, registry) },
      { ...raw, summary: { en: 'Calls `multicall` first, <b>not</b> `approve()`', 'zh-TW': '先呼叫 `multicall`，<b>不是</b> `approve()`' }, flow },
      title,
      'zh-TW',
    ),
  );
  assert.ok(html.includes('先呼叫 <code>multicall</code>，&#60;b&#62;不是&#60;/b&#62; <code>approve()</code>'));
  assert.ok(!html.includes('`'), 'no backtick reaches the page');
  const caption = /<g data-ai>.*?<\/g>/s.exec(html.slice(html.indexOf('<svg viewBox')))?.[0] ?? assert.fail('a flow caption');
  assert.equal([...caption.matchAll(/<rect class="codebox"/g)].length, 2);
  assert.deepEqual([...caption.matchAll(/<tspan class="capc"[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]), ['erc20TransferFrom', 'erc4626Deposit']);
});

const AI_SOURCE: Readonly<Record<Language, { readonly label: string; readonly result: RegExp }>> = {
  en: { label: 'AI also checked', result: /<span class="aires">AI judgment: (no problem|needs attention|problem)<\/span>/ },
  'zh-TW': { label: 'AI 補查', result: /<span class="aires">AI 判斷：(沒問題|要注意|有問題)<\/span>/ },
};

test('an AI source sits under its label with its result in words, never with a state icon among the program sources', () => {
  let groups = 0;
  for (const [id, { language, html }] of replayed) {
    for (const [srcs] of html.matchAll(/<div class="srcs">.*?<\/div>\n/gs)) assert.ok(!srcs.includes('data-ai'), `${id}: AI text among the program sources`);
    for (const [group] of html.matchAll(/<div class="aisrcs">.*?<\/div>/gs)) {
      groups += 1;
      assert.ok(group.startsWith(`<div class="aisrcs"><span class="lbl">${AI_SOURCE[language].label}</span>`), id);
      assert.ok(!group.includes('<svg') && !group.includes('data-state'), `${id}: an AI source with a state mark`);
      assert.match(group, AI_SOURCE[language].result, id);
    }
  }
  assert.ok(groups > 0, 'a replayed report has AI sources');
});

const STATE_NAMES: Readonly<Record<Language, readonly string[]>> = { en: ['pass', 'attention', 'fail', 'nothing to compare', 'AI judgment'], 'zh-TW': ['通過', '注意', '不通過', '沒資料可比', 'AI 判斷'] };

test("every state icon is an image named in the page's language, and the rest are hidden from screen readers", () => {
  for (const [id, { language, html }] of replayed) {
    for (const [svg] of html.matchAll(/<svg class="i[^"]*"[^>]*>/g)) {
      const label = /role="img" aria-label="([^"]*)"/.exec(svg)?.[1];
      assert.ok(label === undefined ? svg.includes('aria-hidden="true"') : STATE_NAMES[language].includes(label), `${id}: ${svg}`);
    }
    for (const [, state] of html.matchAll(/data-state="([^"]+)"/g)) assert.ok(['ok', 'warn', 'bad', 'na', 'ask'].includes(state as string), id);
  }
});

test('a committed HTML report that differs is named with its first differing line', () => {
  const file = generatedHtmlFile('en');
  assert.equal(htmlDifference(file, 'a\nb', 'a\nb'), undefined);
  assert.equal(htmlDifference(file, 'a\nb ok', 'a\nb FINDING'), 'report.generated.en.html line 2: committed "b ok", the program writes "b FINDING"');
  assert.match(htmlDifference(file, undefined, 'a') ?? '', /no committed report\.generated\.en\.html/);
  assert.match(htmlDifference(generatedHtmlFile('zh-TW'), 'a', undefined) ?? '', /^report\.generated\.zh-TW\.html is committed but no notes\.json holds text in its language/);
});

const folder = (files: Readonly<Record<string, string>>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-pages-'));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
};

test('--render writes a page only in the languages the notes hold and removes one in a language they no longer hold', () => {
  const dir = folder({ 'report.generated.en.html': 'old en', 'report.generated.zh-TW.html': 'old zh', [OLD_HTML_FILE]: 'older' });
  assert.deepEqual(writeHtmlPages(dir, new Map([['zh-TW', 'zh']])), ['report.generated.en.html', OLD_HTML_FILE]);
  assert.deepEqual(readdirSync(dir), ['report.generated.zh-TW.html']);
  assert.equal(readFileSync(join(dir, 'report.generated.zh-TW.html'), 'utf8'), 'zh');
  assert.deepEqual(writeHtmlPages(dir, new Map([['en', 'en'], ['zh-TW', 'zh']])), []);
  assert.deepEqual(readdirSync(dir).sort(), ['report.generated.en.html', 'report.generated.zh-TW.html']);
});

const nextSteps = (html: string): string => {
  const start = html.indexOf('id="next"');
  assert.ok(start !== -1, 'the page has a 下一步 section');
  return html.slice(start, html.indexOf('class="auto"', start));
};
const commands = (section: string): string[] => [...section.matchAll(/<pre class="cmd"><code>([^<]*)<\/code><\/pre>/g)].map((m) => unescape(m[1] as string));

test('下一步 ends every signer report, each command alone in its own block with no punctuation inside it', () => {
  for (const [id, { dir, html }] of replayed) {
    const { target } = reportOf(dir);
    const { inputs } = pages.get(dir) ?? assert.fail(dir);
    const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail(id);
    const recipient = [...template.card.values()].some((field) => field.kind === 'recipient' || field.kind === 'owner');
    const section = nextSteps(html);
    assert.ok(html.lastIndexOf('<section') < html.indexOf('id="next"'), `${id}: 下一步 is the last section`);
    assert.deepEqual(commands(section), [
      `pnpm kiss-sign template approve ${target.template}`,
      ...(recipient ? ['pnpm kiss-sign book add <name> <address>'] : []),
      `pnpm kiss-sign card new ${target.template}`,
      'pnpm kiss-sign verify --card <card hash> --safe-tx-hash <safeTxHash>',
      './check.sh <nonce>',
    ]);
    for (const command of commands(section)) assert.doesNotMatch(command, /[^\x20-\x7e]/, `${id}: ${command}`);
    assert.doesNotMatch(section, /[\u3000-\u303f\uff00-\uffef]<pre|<\/pre>[\u3000-\u303f\uff00-\uffef]/, `${id}: full-width punctuation touches a command block`);
    assert.doesNotMatch(section, /git pull<\/code>[\u3000-\u303f\uff00-\uffef]/, id);
  }
});

test('下一步 of a per-vault report names the vault in full, says to pick it by name, and shows the computed field it will not ask', () => {
  const [id, { html }] = [...replayed].find(([, page]) => page.language === 'zh-TW' && withNotes.get(page.dir)?.target.instance === 'hyperithm-usdc-apex-v2-9e2f') ?? assert.fail('the Hyperithm report');
  const section = unescape(nextSteps(html).replace(/<[^>]+>/g, ''));
  assert.ok(section.includes('選 hyperithm-usdc-apex-v2-9e2f，地址是 0x093272C07700d3cA5301C3Bf9B3A392624179E2F'), id);
  assert.ok(section.includes('照名字選'), id);
  assert.ok(section.includes('打 usdc 的數量，用整顆幣'), id);
  assert.ok(section.includes('1,000,611.448606'), id);
  assert.ok(section.includes('最少收到的數量（min-shares）：不用填'), id);
  assert.ok(section.includes('再少 0.10%（協議預設的 0.03%，再加 0.07% 餘裕）'), id);
  const at = ['金庫（vault）：', '金額（amount）：', '（min-shares）：'].map((prompt) => section.indexOf(prompt));
  assert.ok(at[0] !== -1 && at.every((i, n) => n === 0 || i > (at[n - 1] as number)), `${id}: the prompts in the order card new asks them`);
  assert.ok(section.includes('MISMATCH 或 UNVERIFIABLE：不要簽'), id);
});

/** Notes with every text in `language` alone, as an AI writes them for a signer who reads only that language. */
const onlyIn = (raw: unknown, language: Language): unknown =>
  Array.isArray(raw)
    ? raw.map((item) => onlyIn(item, language))
    : typeof raw === 'object' && raw !== null
      ? isText(raw)
        ? { [language]: (raw as Record<string, unknown>)[language] }
        : Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, onlyIn(value, language)]))
      : raw;

const ONLY_IN: Readonly<Record<Language, string>> = { en: 'This report exists only in English.', 'zh-TW': '這份報告只有繁體中文版。' };

test('notes in one language give a page in that language alone, which says, in that language, that no other exists', async () => {
  const id = bilingual();
  const { inputs, title, html } = pages.get(id) ?? assert.fail(id);
  for (const page of html.values()) assert.ok(!Object.values(ONLY_IN).some((line) => page.includes(line)), `${id}: a report in both languages says it exists in one`);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail(id);
  const withFixtures = { ...inputs, fixtures: await judgeFixtures(ROOT, template, registry), example: firstRecordedTx(ROOT, template, registry) };
  for (const language of LANGUAGES) {
    const raw = onlyIn(notesOf(id), language);
    assert.deepEqual(notesLanguages(raw), [language]);
    const page = renderPage(buildPage(withFixtures, raw, title, language));
    assert.ok(page.includes(`<p class="srcline">${ONLY_IN[language]}</p>`), `${language}: the page says it exists only in ${language}`);
    const other = LANGUAGES.find((l) => l !== language) as Language;
    assert.throws(() => buildPage(withFixtures, raw, title, other), new RegExp(`holds no ${other} text`));
  }
});

test('a vault whose report is in one language only still has a report, so card new, card seal and verify accept it', () => {
  const dir = 'templates/morpho/vault-deposit/instances';
  for (const language of LANGUAGES)
    assert.deepEqual([...reportedInstances('morpho/vault-deposit', [`${dir}/v/notes.json`, `${dir}/v/report.generated.md`, `${dir}/v/${generatedHtmlFile(language)}`]).keys()], ['v']);
});

test('the report list verify reads at the trusted commit holds no report under vaults/, only under instances/', () => {
  const at = (folder: string) => [...reportedInstances('morpho/vault-deposit', [`templates/morpho/vault-deposit/${folder}/v/report.generated.md`]).keys()];
  assert.deepEqual(at('vaults'), []);
  assert.deepEqual(at('instances'), ['v']);
});

test("a paged year's search line says how many transactions with a proven Safe party were studied, and an older recording's says nothing more", async () => {
  const id = bilingual((dir) => (pages.get(dir)?.inputs.pastTxs.length ?? 0) > 0);
  const { inputs, title, html } = pages.get(id) ?? assert.fail(id);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail(id);
  const [first, ...rest] = inputs.pastTxs as [PastTxsSection, ...PastTxsSection[]];
  const withFixtures = { ...inputs, fixtures: await judgeFixtures(ROOT, template, registry), example: firstRecordedTx(ROOT, template, registry) };
  const covered = (safesFirst: Extract<YearSearch, { kind: 'covered' }>['safesFirst']): YearSearch => ({ kind: 'covered', range: { fromBlock: 1n, toBlock: 2n }, pages: new Map([['alchemy', 2], ['etherscan', 3]]), safesFirst });
  const checked = { kind: 'checked', noun: 'the address minted to', block: 2n, parties: 30, safes: 20, unreadable: 0 } as const;
  const searchLine = (language: Language, year: YearSearch | undefined): string => {
    const page = renderPage(buildPage({ ...withFixtures, pastTxs: [{ ...first, run: { ...first.run, year } }, ...rest] }, notesOf(id), title, language));
    return /<h3>((?:Search of|搜尋)[^<]*)<\/h3>/.exec(page)?.[1] ?? assert.fail(`${language}: a search line`);
  };
  const expected: Readonly<Record<Language, readonly [all: string, some: string, none: string]>> = {
    en: [', all 17 with a proven Safe party', ', 9 of 20 with a proven Safe party', ', none with a proven Safe party'],
    'zh-TW': ['，含 Safe 參與方的 17 筆全數研究', '，含 Safe 參與方 20 筆中研究 9 筆', '，沒有 Safe 參與方的交易'],
  };
  for (const language of LANGUAGES) {
    const committed = /<h3>((?:Search of|搜尋)[^<]*)<\/h3>/.exec(html.get(language) ?? assert.fail(language))?.[1] ?? assert.fail(`${language}: a committed search line`);
    const [all, some, none] = expected[language];
    assert.equal(searchLine(language, covered({ check: checked, selection: { safes: 17, safesChosen: 17, rest: 40, restChosen: 3 } })), `${committed}${all}`);
    assert.equal(searchLine(language, covered({ check: checked, selection: { safes: 20, safesChosen: 9, rest: 40, restChosen: 3 } })), `${committed}${some}`);
    assert.equal(searchLine(language, covered({ check: { ...checked, safes: 0 }, selection: { safes: 0, safesChosen: 0, rest: 40, restChosen: 12 } })), `${committed}${none}`);
    assert.equal(searchLine(language, covered({ check: { kind: 'not-checked', why: '--from and --to fix both sides of the transfer' }, selection: { safes: 0, safesChosen: 0, rest: 40, restChosen: 12 } })), committed, 'no party checked adds nothing');
    assert.equal(searchLine(language, covered(undefined)), committed, 'a year asked in one page adds nothing');
    assert.equal(searchLine(language, undefined), committed, 'a recording of the windows adds nothing');
  }
});
