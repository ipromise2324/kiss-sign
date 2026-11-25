import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { loadRegistry, pageUrlsOf } from '../src/registry.ts';
import type { Registry } from '../src/registry.ts';
import { STANDARDS } from '../src/research/standards.ts';
import { NOTES_FILE, NotesError, notesLanguages, notesPath, readNotes } from '../src/research/notes.ts';
import { notesNeeded } from '../src/research/notes-needed.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { h } from '../src/html.ts';
import { LANGUAGES, isLanguage } from '../src/language.ts';
import type { Language } from '../src/language.ts';
import { OLD_HTML_FILE, generatedHtml, generatedHtmlFile, generatedHtmlPath, htmlDifference, renderPage, writeHtmlPages } from '../src/research/report-html.ts';
import { buildPage } from '../src/research/report-page.ts';
import type { Body, HtmlInputs, Page } from '../src/research/report-page.ts';
import { WORDS } from '../src/research/report-words.ts';
import { loadReport, readDocs, replayInputs, reportDir, templateTargets } from '../src/research/report.ts';
import type { PastTxsSection, ReportInputs, ReportTitle } from '../src/research/report.ts';
import type { Coverage, SearchRun, YearSearch } from '../src/research/past-txs.ts';
import { USAGE_DIR, modelName, parseUsage, readUsage, usagePath } from '../src/research/usage.ts';
import { judgeFixtures } from '../src/template/perturb.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { NOT_YET_REBUILT, reportedInstances } from '../src/template/vault-reports.ts';
import { FROZEN_REPORTS, repoWithFrozenReports } from './frozen-reports.ts';
import { PREDATE_REPORT } from './predate-report.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const templates = readdirSync(join(ROOT, TEMPLATES_DIR)).flatMap((protocol) => readdirSync(join(ROOT, TEMPLATES_DIR, protocol)).map((operation) => `${protocol}/${operation}`));
const has = (id: string, file: string) => existsSync(join(ROOT, TEMPLATES_DIR, id, file));
const FIXTURES = repoWithTestFixtures();
const FROZEN = repoWithFrozenReports();
const MARKET: ReturnType<typeof templateTargets>[number] = { template: 'morpho/market-supply' };
const HYPERITHM = FROZEN_REPORTS[0];
const reportAt = (target: ReturnType<typeof templateTargets>[number], root: string, registry: Registry) => [join(root, reportDir(root, target)), { target, root, registry }] as const;
/** Each report with notes.json, by its folder: every template's in the repository, the test fixtures' market-supply, and the frozen Hyperithm deposit. */
const withNotes = new Map([
  ...templateTargets(ROOT, registry)
    .filter((t) => has(t.template, NOTES_FILE))
    .map((target) => reportAt(target, ROOT, registry)),
  reportAt(MARKET, FIXTURES, loadRegistry(FIXTURES)),
  reportAt(HYPERITHM, FROZEN, loadRegistry(FROZEN)),
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
    for (const [language, page] of html) replayed.set(join(root, generatedHtmlPath(root, target, language)), { dir, language, html: page });
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
    if (reportOf(dir).root === ROOT) assert.equal(htmlDifference(generatedHtmlFile(language), readFileSync(path, 'utf8'), html), undefined, path);
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
/** The first test fixture's report whose notes hold both languages, which a test that edits a text in each language needs; a committed report's notes may be rewritten in one. */
const bilingual = (where: (dir: string) => boolean = () => true): string =>
  [...withNotes.keys()].find((dir) => reportOf(dir).root !== ROOT && notesLanguages(notesOf(dir)).length === LANGUAGES.length && where(dir)) ?? assert.fail('a report whose notes hold both languages');

/** A report's inputs with its recorded test transactions judged, as `pnpm report --render` reads them. */
async function withFixtures(dir: string, inputs: ReportInputs): Promise<HtmlInputs> {
  const { root, registry } = reportOf(dir);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail(dir);
  return { ...inputs, fixtures: await judgeFixtures(root, template, registry) };
}

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
    // A flow line the call traces confirmed carries its mark in place of the tag; the legend under the diagram says the AI read its source.
    for (const element of cut) assert.match(element, /class="(byai|mark ok)"/, `${id}: AI text without its tag: ${element.slice(0, 120)}`);
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
  const raw = notesOf(id) as Record<string, unknown>;
  const html = renderPage(
    buildPage(
      await withFixtures(id, inputs),
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

test('a bidirectional, control or invisible character in text the page prints shows as its code point, and tab and newline stay', () => {
  const shown = h`<td>${'USDC\u202e\u2066evil\u200b\u0007\tok\n'}</td>`.text;
  assert.equal(shown, '<td>USDC[U+202E][U+2066]evil[U+200B][U+0007]\tok\n</td>');
});

test('a code span in AI text prints as <code> in prose and as a boxed monospace span in the diagram, escaped', async () => {
  const id = bilingual((path) => ((notesOf(path) as { flow?: unknown[] }).flow ?? []).length > 0);
  const { inputs, title } = pages.get(id) ?? assert.fail(id);
  const raw = notesOf(id) as { flow: { text: unknown }[] } & Record<string, unknown>;
  const flow = raw.flow.map((line, i) => (i === 0 ? { ...line, text: { en: 'Calls `erc20TransferFrom`, then `erc4626Deposit`', 'zh-TW': '依序呼叫 `erc20TransferFrom` 和 `erc4626Deposit`' } } : line));
  const html = renderPage(
    buildPage(
      await withFixtures(id, inputs),
      { ...raw, summary: { en: 'Calls `multicall` first, <b>not</b> `approve()`', 'zh-TW': '先呼叫 `multicall`，<b>不是</b> `approve()`' }, flow },
      title,
      'zh-TW',
    ),
  );
  assert.ok(html.includes('先呼叫 <code>multicall</code>，&#60;b&#62;不是&#60;/b&#62; <code>approve()</code>'));
  assert.ok(!html.includes('`'), 'no backtick reaches the page');
  const caption = /<div class="cap" data-ai>.*?<\/div><\/foreignObject>/s.exec(html.slice(html.indexOf('<svg viewBox')))?.[0] ?? assert.fail('a flow caption');
  assert.deepEqual([...caption.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => m[1]), ['erc20TransferFrom', 'erc4626Deposit']);
});

/** The AI's sources' summary line and each source's judgment, worst last, in each language. */
const AI_SOURCE: Readonly<Record<Language, { readonly summary: (n: number) => string; readonly judgments: readonly [string, string, string] }>> = {
  en: { summary: (n) => `AI also checked ${n} ${n === 1 ? 'place' : 'places'} · `, judgments: ['AI judgment: no problem', 'AI judgment: needs attention', 'AI judgment: problem'] },
  'zh-TW': { summary: (n) => `AI 補查 ${n} 處 · `, judgments: ['AI 判斷：沒問題', 'AI 判斷：要注意', 'AI 判斷：有問題'] },
};

test('an AI source sits under its label with its result in words, never with a state icon among the program sources', () => {
  const seen = new Set<boolean>();
  for (const [id, { language, html }] of replayed) {
    for (const [srcs] of html.matchAll(/<div class="srcs">.*?<\/div>\n/gs)) assert.ok(!srcs.includes('data-ai'), `${id}: AI text among the program sources`);
    for (const [, open, summary = '', body = ''] of html.matchAll(/<details class="aisrcs"( open)?><summary>(.*?)<\/summary>(.*?)<\/details>/gs)) {
      const { judgments } = AI_SOURCE[language];
      const each = [...body.matchAll(/<span class="aires">([^<]*)<\/span>/g)].map(([, words]) => judgments.indexOf(words ?? ''));
      assert.ok(each.length > 0 && each.every((rank) => rank >= 0), `${id}: an AI source without its judgment in words`);
      const worst = Math.max(...each);
      assert.equal(summary.replace(/<svg[^>]*>.*?<\/svg>/, ''), `${AI_SOURCE[language].summary(each.length)}${judgments[worst]}`, id);
      assert.equal(open !== undefined, worst > 0, `${id}: the fold is open exactly when a judgment is not a pass`);
      assert.ok(!body.includes('<svg') && !body.includes('data-state'), `${id}: an AI source with a state mark`);
      seen.add(open !== undefined);
    }
  }
  assert.deepEqual([...seen].sort(), [false, true], 'replayed reports hold a closed and an open AI fold');
});

test('an address whose program results all pass stays open when an AI source needs attention', async () => {
  const id = bilingual();
  const { inputs, title } = pages.get(id) ?? assert.fail(id);
  const raw = notesOf(id) as { entries?: Record<string, { sources?: unknown[] }> } & Record<string, unknown>;
  const folded = (html: string): string => /<details class="fold">\s*<summary>.*?<\/summary>(.*?)\n {4}<\/details>/s.exec(html)?.[1] ?? '';
  const before = renderPage(buildPage(await withFixtures(id, inputs), raw, title, 'en'));
  const name = /<div class="ad" id="a-([^"]+)"/.exec(folded(before))?.[1] ?? assert.fail(`${id}: no folded address`);
  const attention = { text: both('The protocol site lists another address'), url: 'https://example.org/', result: 'attention' };
  const entries = { ...raw.entries, [name]: { ...raw.entries?.[name], sources: [...(raw.entries?.[name]?.sources ?? []), attention] } };
  const html = renderPage(buildPage(await withFixtures(id, inputs), { ...raw, entries }, title, 'en'));
  assert.ok(html.includes(`id="a-${name}"`), `${id}: ${name} has its row`);
  assert.ok(!folded(html).includes(`id="a-${name}"`), `${id}: ${name} sits inside the folded addresses`);
});

test('an after-the-transaction row shows its AI reason in a block of its own under the row, not in its right-aligned note', async () => {
  const id = bilingual();
  const { inputs, title } = pages.get(id) ?? assert.fail(id);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail(id);
  const [gives, ...rest] = template.effects.gives;
  assert.ok(gives !== undefined, `${id}: the Safe gives a token`);
  const why = 'Rounding can leave the balance one unit off';
  const subject = { ...inputs.subject, template: { ...template, effects: { ...template.effects, gives: [{ ...gives, tolerance: { less: 1n, more: 0n, why: both(why) } }, ...rest] } } };
  const html = renderPage(buildPage(await withFixtures(id, { ...inputs, subject }), notesOf(id), title, 'en'));
  const after = html.slice(html.indexOf('<dl class="props">'));
  const row = after.slice(0, after.indexOf('</dl>')).split('<div><dt>').find((r) => r.includes(why)) ?? assert.fail(`${id}: no row holds the reason`);
  const note = /<dd class="src">.*?<\/dd>/s.exec(row)?.[0] ?? assert.fail(`${id}: a row without its note`);
  assert.ok(!note.includes('data-ai'), `${id}: AI text inside the right-aligned note`);
  assert.ok(row.trimEnd().endsWith(`</dd><div class="ai"><span class="aiw" data-ai><span class="byai">AI</span><span>${why}</span></span></div></div>`), row);
});

test('every source line and documentation line starts with its result icon, the source and any phrase after it', () => {
  let lines = 0;
  for (const [id, { html }] of replayed) {
    for (const [, line = ''] of html.matchAll(/<(?:span class="srcrow"|span class="site"|div class="doc") data-state="[^"]+">(.*?)<\/span><\/(?:span|div)>/gs)) {
      lines += 1;
      assert.match(line, /^<svg class="i [a-z]+" role="img" aria-label="[^"]+"><use href="#[a-z]+"\/><\/svg><span>/, `${id}: ${line.slice(0, 120)}`);
      assert.equal(line.split('<svg').length - 1, 1, `${id}: one icon on the line`);
    }
  }
  assert.ok(lines > 0, 'a replayed report has source lines');
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

test('every report ends with the AI usage that made it, or says it was not measured', async () => {
  const id = hyperithm();
  const { inputs, title } = pages.get(id) ?? assert.fail(id);
  const judged = await withFixtures(id, inputs);
  const usage = { kind: 'full', models: ['claude-opus-5-5'], calls: 71, minutes: 74, input: 10_000, cacheWrite: 180_000, cacheRead: 5_400_000, output: 30_000 } as const;
  const usageOf = (of: HtmlInputs, language: Language) => {
    const html = renderPage(buildPage(of, notesOf(id), title, language));
    assert.match(html, /<\/section>\s*<section id="usage">[^]*<\/section>\s*<footer/);
    return [...(/<section id="usage">(.*?)<\/section>/s.exec(html)?.[1] ?? '').matchAll(/<(?:h2|p|th|td)(?: [^>]*)?>(.*?)<\/(?:h2|p|th|td)>/g)].map((m) => m[1]);
  };
  const full = usageOf({ ...judged, usage }, 'zh-TW');
  assert.deepEqual(full, [
    'AI 用量',
    'Opus 5.5 用 71 次呼叫、74 分鐘做出這份報告。',
    ...['項目', 'token', '重複讀取（cache 讀取）', '5.4M', '新讀入（input 與 cache 寫入）', '0.19M', 'output', '0.03M', '總共', '5.6M'],
    '來源：Claude Code 對話紀錄裡 API 回報的用量，不含協調者。這些數字程式不檢查。',
  ]);
  assert.deepEqual(usageOf({ ...judged, usage: { ...usage, kind: 'past-txs-rerun' } }, 'zh-TW'), [...full.slice(0, -1), '這次只重跑過去交易的搜尋，用量只算這部分。', full.at(-1)]);
  assert.deepEqual(usageOf({ ...judged, usage: undefined }, 'zh-TW'), ['AI 用量', '這份報告的 AI 用量未量測。']);
  assert.deepEqual(usageOf({ ...judged, usage }, 'en').slice(2, -1), ['Item', 'Tokens', 'Re-read (cache reads)', '5.4M', 'Newly read (input and cache writes)', '0.19M', 'Output', '0.03M', 'Total', '5.6M']);
});

test('a usage file is one report\'s counts, and one with a missing, negative or unknown value is refused', () => {
  const raw = { kind: 'full', models: ['claude-opus-5-5'], calls: 1, minutes: 1, input: 1, cacheWrite: 1, cacheRead: 1, output: 1 };
  assert.deepEqual(parseUsage(raw), raw);
  for (const [bad, message] of [
    [{ ...raw, output: -1 }, /usage\.output/],
    [{ ...raw, calls: undefined }, /usage\.calls/],
    [{ ...raw, kind: 'rough' }, /usage\.kind/],
    [{ ...raw, models: ['<b>'] }, /usage\.models/],
    [{ ...raw, models: ['this-report-is-safe'] }, /usage\.models/],
    [{ ...raw, cost: 3 }, /unknown key "cost"/],
  ] as const)
    assert.throws(() => parseUsage(bad), message);
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-usage-'));
  assert.equal(readUsage(root, { template: 'a/b' }), undefined);
  mkdirSync(join(root, 'testdata', 'usage', 'a-b'), { recursive: true });
  writeFileSync(join(root, 'testdata', 'usage', 'a-b', 'v.json'), JSON.stringify(raw));
  assert.deepEqual(readUsage(root, { template: 'a/b', instance: 'v' }), raw);
  writeFileSync(join(root, 'testdata', 'usage', 'a-b.json'), '{');
  assert.throws(() => readUsage(root, { template: 'a/b' }), /^UsageError: testdata\/usage\/a-b\.json: /);
});

test('a report with a usage file prints it, names the file in the footer and says no program checks the numbers', () => {
  const measured = [...withNotes].filter(([, { target, root }]) => existsSync(join(root, usagePath(target))));
  const files = readdirSync(join(ROOT, USAGE_DIR), { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.json'));
  assert.deepEqual(measured.map(([, { target }]) => usagePath(target)).sort(), files.map((file) => join(USAGE_DIR, file)).sort(), 'each usage file belongs to a report');
  for (const [dir, { target, root }] of measured) {
    const usage = readUsage(root, target) ?? assert.fail(dir);
    for (const [language, html] of pages.get(dir)?.html ?? assert.fail(dir)) {
      assert.ok(html.includes(WORDS[language].usageCalls(usage.models.map(modelName).join(' + '), usage.calls, usage.minutes)), dir);
      assert.ok(html.includes(`<code>${usagePath(target)}</code>`), dir);
      assert.match(html, language === 'en' ? /or the usage numbers\./ : /用量的數字程式也不檢查。/);
    }
  }
});

test('下一步 ends every signer report, each command alone in its own block with no punctuation inside it', () => {
  for (const [id, { dir, html }] of replayed) {
    const { target } = reportOf(dir);
    const { inputs } = pages.get(dir) ?? assert.fail(dir);
    const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail(id);
    const recipient = [...template.card.values()].some((field) => field.kind === 'recipient' || field.kind === 'owner');
    const section = nextSteps(html);
    assert.match(html.slice(html.indexOf('<section id="next">')), /^<section id="next">[^]*?<\/section>\s*<section id="usage">/, `${id}: only AI 用量 follows 下一步`);
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
  const [id, { html }] = [...replayed].find(([, page]) => page.language === 'zh-TW' && reportOf(page.dir).root === FROZEN && reportOf(page.dir).target.instance === HYPERITHM.instance) ?? assert.fail('the Hyperithm report');
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
  const judged = await withFixtures(id, inputs);
  for (const language of LANGUAGES) {
    const raw = onlyIn(notesOf(id), language);
    assert.deepEqual(notesLanguages(raw), [language]);
    const page = renderPage(buildPage(judged, raw, title, language));
    assert.ok(page.includes(`<p class="srcline">${ONLY_IN[language]}</p>`), `${language}: the page says it exists only in ${language}`);
    const other = LANGUAGES.find((l) => l !== language) as Language;
    assert.throws(() => buildPage(judged, raw, title, other), new RegExp(`holds no ${other} text`));
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
  const [first, ...rest] = inputs.pastTxs as [PastTxsSection, ...PastTxsSection[]];
  const judged = await withFixtures(id, inputs);
  const covered = (safesFirst: Extract<YearSearch, { kind: 'covered' }>['safesFirst']): YearSearch => ({ kind: 'covered', range: { fromBlock: 1n, toBlock: 2n }, pages: new Map([['alchemy', 2], ['etherscan', 3]]), safesFirst });
  const checked = { kind: 'checked', noun: 'the address minted to', block: 2n, parties: 30, safes: 20, unreadable: 0 } as const;
  const searchLine = (language: Language, year: YearSearch | undefined): string => {
    const page = renderPage(buildPage({ ...judged, pastTxs: [{ ...first, run: { ...first.run, search: { kind: 'windows', year, windows: [], perWindow: 0 } } }, ...rest] }, notesOf(id), title, language));
    return /<h3>((?:Search of|搜尋)[^<]*)<\/h3>/.exec(page)?.[1] ?? assert.fail(`${language}: a search line`);
  };
  const expected: Readonly<Record<Language, readonly [all: string, some: string, none: string]>> = {
    en: [', all 17 with a proven Safe party', ', 9 of 20 with a proven Safe party', ', none with a proven Safe party'],
    'zh-TW': ['，含證實為 Safe 的參與方的 17 筆全數研究', '，含證實為 Safe 的參與方的 20 筆中研究 9 筆', '，沒有證實為 Safe 的參與方'],
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

test("a newest-first search's lead says which blocks it read whole and their dates, and when the cap stopped it, that the year's older transactions were not searched", async () => {
  const id = bilingual((dir) => (pages.get(dir)?.inputs.pastTxs.length ?? 0) > 0);
  const { inputs, title } = pages.get(id) ?? assert.fail(id);
  const [first, ...rest] = inputs.pastTxs as [PastTxsSection, ...PastTxsSection[]];
  const judged = await withFixtures(id, inputs);
  const safesFirst = { check: { kind: 'not-checked', why: '--from and --to fix both sides of the transfer' }, selection: { safes: 0, safesChosen: 0, rest: 40, restChosen: 12 } } as const;
  const lead = (language: Language, coverage: Coverage | undefined): string => {
    const search: SearchRun = coverage === undefined ? { kind: 'windows', year: undefined, windows: [], perWindow: 0 } : { kind: 'newest-first', coverage, safesFirst };
    const page = renderPage(buildPage({ ...judged, pastTxs: [{ ...first, run: { ...first.run, search } }, ...rest] }, notesOf(id), title, language));
    return /<h3>(?:Search of|搜尋)[^<]*<\/h3>\s*<p class="cap">([^\n]*)<\/p>/.exec(page)?.[1] ?? assert.fail(`${language}: a search lead`);
  };
  const time = { from: 1_789_280_000n, to: 1_790_000_000n };
  const recent: Coverage = { kind: 'recent', range: { fromBlock: 26378401n, toBlock: 26438400n }, pages: 50, time };
  const year: Coverage = { kind: 'year', range: { fromBlock: 23810401n, toBlock: 26438400n }, pages: 12, time: { from: 1_758_464_000n, to: 1_790_000_000n } };
  const expected: Readonly<Record<Language, readonly [recent: string, year: string, timeless: string]>> = {
    en: [
      'Every transaction from block 26378401 (2026-09-13) to block 26438400 (2026-09-21) was searched, newest first, 60000 blocks, about 8 days 8 hours, with no gap; the search stops at its cap of 50 pages of 1,000, so the year&#39;s older transactions were not searched.',
      'Every transaction of the last year was searched, from block 23810401 (2025-09-21) to block 26438400 (2026-09-21), with no gap.',
      'Every transaction from block 26378401 to block 26438400 was searched, newest first, 60000 blocks, with no gap;',
    ],
    'zh-TW': [
      '從最新的區塊往回，搜尋了區塊 26378401（2026-09-13）到區塊 26438400（2026-09-21）的每一筆交易，共 60000 個區塊，約 8 天 8 小時，沒有遺漏；搜尋到 50 頁（每頁 1,000 筆）的上限就停止，所以最近一年裡更早的交易沒有搜尋。',
      '搜尋了最近一年的每一筆交易，從區塊 23810401（2025-09-21）到區塊 26438400（2026-09-21），沒有遺漏。',
      '從最新的區塊往回，搜尋了區塊 26378401到區塊 26438400的每一筆交易，共 60000 個區塊，沒有遺漏；',
    ],
  };
  for (const language of LANGUAGES) {
    const [withCap, whole, timeless] = expected[language];
    const older = lead(language, undefined);
    assert.ok(lead(language, recent).includes(withCap), `${language}: ${lead(language, recent)}`);
    assert.ok(lead(language, year).includes(whole), `${language}: ${lead(language, year)}`);
    assert.ok(lead(language, { ...recent, time: undefined }).includes(timeless), `${language}: ${lead(language, { ...recent, time: undefined })}`);
    assert.equal(lead(language, recent).replace(withCap, '').replace(/\s+/g, ' ').trim(), older.replace(/\s+/g, ' '), 'the sentence is all a newest-first search adds');
    assert.doesNotMatch(older, /newest first|往回/, 'an older recording of the windows says nothing of its range');
  }
});

test('the Flow section opens its calls with one sentence and prints no example value', () => {
  for (const [id, { language, html }] of replayed) {
    const page = unescape(html);
    assert.equal(page.split(`<p class="lead keylead">${WORDS[language].callsLead}</p>`).length, 2, `${id}: the one sentence over the calls`);
    assert.doesNotMatch(page, /class="ex"|first test transaction|第一筆測試交易|marked "example"|標「例」|例：別的 Safe/, id);
  }
});

/** The flow diagram's SVG. */
const diagramOf = (html: string): string => {
  const start = html.indexOf('<svg viewBox');
  return html.slice(start, html.indexOf('</svg>', start));
};

const hyperithm = (): string => join(FROZEN, reportDir(FROZEN, HYPERITHM));

/** The frozen Hyperithm page with its flow lines marked as the traces would mark them: the first seen in all 8 transactions, the second in 3. */
async function tracedPage(language: Language): Promise<string> {
  const { inputs, title } = pages.get(hyperithm()) ?? assert.fail('the frozen Hyperithm report');
  const page = buildPage(await withFixtures(hyperithm(), inputs), notesOf(hyperithm()), title, language);
  let n = 0;
  const sections = page.sections.map((section) => {
    if (section.body.kind !== 'flow') return section;
    const { flow } = section.body;
    const arrows = flow.diagram.arrows.map((arrow) => (arrow.kind === 'inside' ? { ...arrow, seen: n++ === 0 ? { seen: 8, of: 8, state: 'confirmed' as const, tokens: [], fields: [] } : { seen: 3, of: 8, state: 'partial' as const, tokens: [], fields: [] } } : arrow));
    return { ...section, body: { kind: 'flow', flow: { ...flow, diagram: { ...flow.diagram, arrows, traced: true } } } satisfies Body };
  });
  assert.equal(n, 2, 'the Hyperithm diagram draws two flow lines');
  return renderPage({ ...page, sections } satisfies Page);
}

test('a traced flow line carries a short mark in the diagram, and one legend under it explains the marks with their counts', async () => {
  const expected: Readonly<Record<Language, readonly [confirmed: RegExp, partial: RegExp]>> = {
    en: [/^Confirmed two ways: .*\(<a href="https:[^"]+">①<\/a> 8 of 8\), and the AI read the contract's source; the words beside each line are the AI's\.$/, /^Seen in the call traces of only some past transactions \(② 3 of 8\), so not confirmed\.$/],
    'zh-TW': [/^兩邊都確認：.*（<a href="https:[^"]+">①<\/a> 8 筆中 8 筆），AI 也讀過合約原始碼；每條線旁的說明是 AI 寫的。$/, /^程式只在部分過去交易的呼叫追蹤裡看到這條線（② 8 筆中 3 筆），所以還不算確認。$/],
  };
  for (const language of LANGUAGES) {
    const html = unescape(await tracedPage(language));
    const svg = diagramOf(html);
    const captions = [...svg.matchAll(/<div class="cap" data-ai>(.*?)<\/div><\/foreignObject>/g)].map((m) => m[1] as string);
    assert.equal(captions.length, 2, language);
    assert.match(captions[0] ?? '', /^<span class="mark ok">①<\/span><span>/, `${language}: a confirmed line has its mark and no AI tag`);
    assert.match(captions[1] ?? '', /^<span class="mark bad">②<\/span><span class="byai">/, `${language}: a line seen in only some keeps its AI tag`);
    assert.doesNotMatch(svg, /8 of 8|3 of 8|8 筆中/, `${language}: no count inside the diagram`);
    const legend = /<\/svg>\s*<\/div>\s*<div class="scrollhint">[^<]*<\/div>\s*<ul class="legend">(.*?)<\/ul>/s.exec(html)?.[1] ?? assert.fail(`${language}: a legend right under the diagram`);
    const lines = [...legend.matchAll(/<li data-state="(\w+)">(.*?)<\/li>/g)].map((m) => [m[1], m[2]] as const);
    assert.deepEqual(lines.map(([state]) => state), ['ok', 'bad']);
    expected[language].forEach((pattern, i) => assert.match(lines[i]?.[1] ?? '', pattern, language));
  }
  const untraced = unescape(pages.get(hyperithm())?.html.get('en') ?? assert.fail('the committed page'));
  assert.ok(!untraced.includes('class="legend"') && !untraced.includes('class="mark'), 'no mark and no legend when no line was compared');
});

test('every arrow in the diagram ends in the one arrowhead, drawn in the foreground colour', () => {
  for (const [id, { html }] of replayed) {
    const svg = diagramOf(html);
    const ends = [...svg.matchAll(/marker-end="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(ends.length > 0 && ends.every((end) => end === 'url(#head)'), `${id}: ${[...new Set(ends)].join(' ')}`);
    assert.deepEqual([...svg.matchAll(/<marker [^>]*>(.*?)<\/marker>/g)].map((m) => m[1]), ['<path class="ah" d="M0 0L10 5L0 10z"/>'], id);
    assert.ok(html.includes('svg .ah{fill:var(--fg)}'), `${id}: the arrowhead takes the foreground colour`);
  }
});

test('each To review item shows its state, grade, plain title and one-line conclusion open, and folds the rest', () => {
  for (const [id, { language, html }] of replayed) {
    const review = /<section id="review">(.*?)<\/section>/s.exec(html)?.[1] ?? assert.fail(id);
    for (const [row] of review.matchAll(/<div class="row" data-state="\w+" data-grade="\w+" data-result="[^"]+">.*?<\/details><\/div>\n    <\/div>/gs)) {
      const [open, folded] = row.split('<details class="more">') as [string, string];
      assert.match(open, /<svg class="i \w+"/, `${id}: the state icon stays open`);
      assert.match(open, new RegExp(`<div class="t"><span class="grade"><span class="vh">${WORDS[language].gradeName}</span>(${Object.values(WORDS[language].grade).join('|')})</span>[^<]+</div>`), `${id}: grade, named for a screen reader, and a plain title stay open`);
      if (!row.includes('data-result="trace.')) assert.doesNotMatch(/<div class="t">.*?<\/div>/.exec(open)?.[0] ?? '', /<code>|0x[0-9a-fA-F]{40}/, `${id}: no address or code in the title`);
      assert.match(open, /<div class="rec"><span class="lbl">[^<]+<\/span><span class="aiw" data-ai>/, `${id}: the conclusion stays open`);
      assert.match(folded, /<div class="meta">/, `${id}: the details are folded`);
      const title = /<div class="t"><span class="grade"><span class="vh">[^<]*<\/span>[^<]*<\/span>([^<]+)<\/div>/.exec(open)?.[1] ?? assert.fail(id);
      const sentence = /<div class="rec">.*?<span class="aiw" data-ai><span>(.*?)<\/span><span class="byai">/s.exec(open)?.[1] ?? assert.fail(id);
      assert.ok(!folded.includes(title.split(' · ')[0] as string) && !folded.includes(sentence), `${id}: the details repeat nothing shown open`);
    }
  }
  const frozen = unescape(pages.get(hyperithm())?.html.get('en') ?? assert.fail('the frozen page'));
  const row = /<div class="row" data-state="warn" data-grade="key"[^>]*>(.*?)<details/s.exec(frozen)?.[1] ?? assert.fail('the key row');
  assert.match(row, /Address confirmed in too few places · hyperithm-usdc-apex-v2-9e2f<\/div>/, 'the title names the entry');
  assert.match(row, /AI has concerns<\/span>.*The program's only check is the factory: VaultV2Factory answers <code>isVaultV2<\/code> = true\.<\/span>/s);
  assert.doesNotMatch(row, /AI opened the vault's page/, 'the rest of the review is folded');
  const details = /<div class="row" data-state="warn" data-grade="key"[^>]*>.*?(<details.*?<\/details>)/s.exec(frozen)?.[1] ?? assert.fail('the key row');
  assert.match(details, /<div class="meta">Found only in factory: <span class="addr">0x[0-9a-fA-F]{40}<\/span>; at least 2 places are needed\.<a href="#a-/, 'the details name only where it was found, with the address');
  assert.match(details, /<div class="rec"><span class="aiw" data-ai><span>AI opened the vault's page/, 'the folded review starts after its open sentence');
});

test('Next steps first asks the signer to open the sources the report lists for each address', () => {
  for (const [id, { language, html }] of replayed) {
    if (!html.includes('<section id="addresses">')) continue;
    const first = /<ol class="steps">\s*<li><div>(.*?)<\/div><\/li>/s.exec(html)?.[1] ?? assert.fail(id);
    assert.ok(unescape(first).startsWith(language === 'en' ? 'Before you approve, open each address\'s sources in <a href="#addresses">' : '核准前，到「<a href="#addresses">'), `${id}: ${first.slice(0, 80)}`);
  }
});

/** The page's 過去交易 section, from its opening tag to its close. */
const pastOf = (html: string): string => /<section id="past">.*?<\/section>/s.exec(html)?.[0] ?? assert.fail('a 過去交易 section');
const textOf = (html: string): string => unescape(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

test("過去交易 leads with the transactions exactly like the signer's, keeps each FINDING open, and folds the rest under the one line that counts them", async () => {
  const { inputs, title } = pages.get(hyperithm()) ?? assert.fail('the frozen Hyperithm report');
  const page = buildPage(await withFixtures(hyperithm(), inputs), notesOf(hyperithm()), title, 'en');
  const finding = { effect: 'gives amount', tolerance: 'exact', tokens: [], outside: undefined, finding: 'beyond the tolerance', unmeasured: undefined };
  const sections = page.sections.map((s) => (s.body.kind === 'past' && s.body.past !== undefined ? { ...s, body: { kind: 'past', past: { ...s.body.past, amounts: [finding] } } satisfies Body } : s));
  const past = pastOf(renderPage({ ...page, sections } satisfies Page));
  assert.match(textOf(past), /^Past transactions 1\. Has this template's transaction worked before\? Yes, 6 times, by 2 Safes\. EOA: 26 times, from 17 addresses, each sending one of the template's calls\. /);
  const open = past.replace(/<details class="fold">.*?<\/details>/gs, '');
  assert.ok(open.includes('FINDING: beyond the tolerance'), 'a FINDING is in no fold');
  assert.match(textOf(open), /336 transactions did something this template refuses\./);
  const conclusion = (notesOf(hyperithm()) as { pastTxsConclusion: { en: string } }).pastTxsConclusion.en.split('`')[0] as string;
  assert.ok(unescape(open).includes(conclusion), "the AI's word on the other shapes is open under how they differed");
});

test("an instance's context notes show in its section under their titles, each with the AI tag and its sources", async () => {
  const { inputs, title } = pages.get(hyperithm()) ?? assert.fail('the frozen Hyperithm report');
  const raw = notesOf(hyperithm()) as Record<string, unknown>;
  const held = notesLanguages(raw);
  const say = (text: string) => Object.fromEntries(held.map((language) => [language, text]));
  const context = [{ title: say('Where deposits go'), text: say('The vault lends each deposit on to the markets it allocates to.'), sources: ['https://example.org/vault'] }];
  const language = held[0] as Language;
  const html = renderPage(buildPage(await withFixtures(hyperithm(), inputs), { ...raw, context }, title, language));
  const section = /<section id="vault-[^"]+">.*?<\/section>/s.exec(html)?.[0] ?? assert.fail('an instance section');
  assert.match(section, /<div data-ai>\s*<h3><span class="aiw" data-ai><span>Where deposits go<\/span><span class="byai">[^<]+<\/span><\/span><\/h3>/);
  assert.match(section, /<p class="intro"><span class="aiw" data-ai><span>The vault lends each deposit on to the markets it allocates to\. <a class="aisrc" href="https:\/\/example\.org\/vault">[^<]+<\/a><\/span><\/span><\/p>/);
  assert.equal(section.split('class="byai"').length - 1, 1, 'one AI tag for the note, on its title');
  assert.match(section, /<\/p>\s*<\/div>/, 'the note ends inside the block its title tags');
  const without = /<section id="vault-[^"]+">.*?<\/section>/s.exec(pages.get(hyperithm())?.html.get(language) ?? '')?.[0] ?? assert.fail('the committed instance section');
  assert.ok(!without.includes('<h3><span class="aiw"'), 'no context heading without context notes');
});

test('in the call ledger, each group keeps the rows the signer decides open and folds its fixed rows under one line that counts them', () => {
  for (const language of LANGUAGES) {
    const html = unescape(pages.get(hyperithm())?.html.get(language) ?? assert.fail('the frozen page'));
    const flow = /<section id="flow">(.*?)<\/section>/s.exec(html)?.[1] ?? assert.fail(language);
    const before = (field: string, fold: string): boolean => {
      const at = flow.indexOf(`data-field="${field}"`);
      const folded = flow.lastIndexOf('<details class="fixed">', at);
      return folded !== -1 && flow.indexOf('</details>', folded) > at && flow.slice(folded, at).includes(fold);
    };
    const words = WORDS[language];
    assert.ok(before('1.approve.spender', words.fixedFold(1)), `${language}: the approval's fixed spender folds`);
    assert.ok(!flow.slice(0, flow.indexOf('data-field="1.approve.value"')).includes('<details class="fixed">'), `${language}: the amount the signer types stays open`);
    const summaries = [...flow.matchAll(/<details class="fixed"><summary>.*?<\/svg>([^<]+)<\/summary>/g)].map((m) => m[1]);
    assert.deepEqual(summaries, [words.fixedFold(1), words.fixedFold(1), words.fixedFold(4), words.fixedFold(1), words.fixedFold(4)], language);
    for (const field of ['token', 'amount', 'vault', 'assets', 'maxSharePriceE27']) {
      const row = new RegExp(`<div class="part"><div class="pn">${field}<`).exec(flow) ?? assert.fail(`${language}: ${field}`);
      const shut = flow.lastIndexOf('<details class="fixed">', row.index);
      assert.ok(shut === -1 || flow.lastIndexOf('</details>', row.index) > shut, `${language}: ${field} stays open`);
    }
  }
});

/** A repository that holds only the report's notes files, each as `files` gives it. */
function repoWithNotes(files: Readonly<Record<string, unknown>>): string {
  const repo = mkdtempSync(join(tmpdir(), 'kiss-sign-notes-'));
  for (const [file, notes] of Object.entries(files)) {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), JSON.stringify(notes));
  }
  return repo;
}

/** A skeleton with every empty text written. */
function written(value: unknown, path: readonly string[] = []): unknown {
  if (value === '') return path.at(-1) === 'url' ? 'https://example.com/' : path.at(-1) === 'result' ? 'pass' : path.at(-1) !== 'status' ? 'x' : path[0] === 'verdict' ? 'safe' : 'confirmed';
  if (Array.isArray(value)) return value.map((item) => written(item, path));
  return Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, written(item, [...path, key])]));
}

test('notes-needed asks, of a report with no notes, for exactly the texts the page needs, in the file each belongs in', () => {
  for (const [dir, { inputs, title }] of pages) {
    const { template, vault } = inputs.subject;
    const shared = notesPath('', template.id);
    const both: Record<string, Record<string, unknown>> = { [shared]: {}, ...(vault === undefined ? {} : { [notesPath('', template.id, vault.name)]: {} }) };
    const needed = notesNeeded(repoWithNotes(both), inputs, ['zh-TW']);
    const files: Record<string, Record<string, unknown>> = { ...both, ...(Object.fromEntries(Object.entries(needed.skeleton).map(([file, tree]) => [file, written(tree)])) as Record<string, Record<string, unknown>>) };
    const pageOf = (notes: Readonly<Record<string, unknown>>) => generatedHtml(repoWithNotes(notes), inputs, title);
    assert.deepEqual([...(pageOf(files) ?? assert.fail(dir)).keys()], ['zh-TW'], dir);
    for (const [file, tree] of Object.entries(files)) {
      for (const [key, value] of Object.entries(tree)) {
        const { [key]: _, ...rest } = tree;
        assert.throws(() => pageOf({ ...files, [file]: rest }), NotesError, `${dir}: the page is written without ${key}`);
        if (!['reviews', 'fields', 'protocols'].includes(key)) continue;
        const [first, ...others] = Object.entries(value as object);
        if (first === undefined) continue;
        assert.throws(() => pageOf({ ...files, [file]: { ...tree, [key]: Object.fromEntries(others) } }), NotesError, `${dir}: the page is written without ${key} ${first[0]}`);
      }
    }
    for (const row of Object.keys(needed.toReview)) assert.ok(needed.about[`reviews ${row}`] !== undefined, `${dir}: ${row} is to review but not asked for`);
  }
});

test('notes-needed asks nothing of a committed report, and names a text left empty, a language left out and a key the page refuses', () => {
  for (const [dir, { inputs }] of pages) {
    const { root } = reportOf(dir);
    const needed = notesNeeded(root, inputs, ['zh-TW']);
    assert.deepEqual([needed.skeleton, needed.remove], [{}, []], dir);
  }
  const { inputs } = pages.get(join(ROOT, TEMPLATES_DIR, 'safe/add-owner')) ?? assert.fail('safe/add-owner');
  const path = notesPath('', 'safe/add-owner');
  const notes = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
  const [field] = Object.keys(notes.fields) as [string];
  notes.fields[field].en = ' ';
  delete notes.summary['zh-TW'];
  notes.reviews['usdc/source.page'] = { status: 'confirmed', text: { en: 'x', 'zh-TW': 'x' }, recommendation: { en: 'x', 'zh-TW': 'x' } };
  assert.throws(() => notesNeeded(repoWithNotes({ [path]: notes }), inputs, ['en']), /holds texts in/);
  notes.summary['zh-TW'] = '';
  const needed = notesNeeded(repoWithNotes({ [path]: notes }), inputs, ['en']);
  assert.deepEqual(needed.skeleton, { [path]: { summary: { 'zh-TW': '' }, fields: { [field]: { en: '' } } } });
  assert.deepEqual(needed.remove, [`${path} reviews usdc/source.page`]);
  assert.match(needed.about.summary ?? '', /\[en 750, zh-TW 250\]/);
});
