import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { loadRegistry } from '../src/registry.ts';
import { NOTES_FILE, notesChanges, notesPath, readNotes } from '../src/research/notes.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { GENERATED_HTML_FILE, generatedHtml, generatedHtmlPath, htmlDifference, renderPage } from '../src/research/report-html.ts';
import { buildPage } from '../src/research/report-page.ts';
import { DOCS_FILE, loadReport, replayInputs, templateTargets } from '../src/research/report.ts';
import type { ReportInputs, ReportTitle } from '../src/research/report.ts';
import { firstRecordedTx, judgeFixtures } from '../src/template/perturb.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { NOT_YET_REBUILT } from '../src/template/vault-reports.ts';
import { PREDATE_REPORT } from './predate-report.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const templates = readdirSync(join(ROOT, TEMPLATES_DIR)).flatMap((protocol) => readdirSync(join(ROOT, TEMPLATES_DIR, protocol)).map((operation) => `${protocol}/${operation}`));
const has = (id: string, file: string) => existsSync(join(ROOT, TEMPLATES_DIR, id, file));
/** Each report of a template with notes.json, by its HTML path: one per template, or one per reported vault. */
const withNotes = new Map(templateTargets(ROOT, registry).filter((t) => has(t.template, NOTES_FILE)).map((t) => [generatedHtmlPath(t), t]));
const notesOf = (path: string): unknown => {
  const target = withNotes.get(path) ?? assert.fail(path);
  return readNotes(ROOT, target.template, target.cardVault === undefined ? undefined : registry.entries.get(target.cardVault));
};

const replayed = new Map<string, { readonly inputs: ReportInputs; readonly title: ReportTitle; readonly html: string }>();

before(async () => {
  const compilers = await warmCompilers(reportCases(ROOT, registry, [...withNotes.values()]));
  for (const [path, target] of withNotes) {
    const { inputs, title } = await replayInputs(ROOT, registry, target, compilers, loadPublicSuffixList());
    replayed.set(path, { inputs, title, html: (await generatedHtml(ROOT, inputs, title)) ?? assert.fail(`${path}: notes but no HTML`) });
  }
});

test('a report commits report.generated.html exactly when its template has notes.json, and none has report.md', () => {
  for (const target of templateTargets(ROOT, registry)) {
    assert.equal(existsSync(join(ROOT, generatedHtmlPath(target))), has(target.template, NOTES_FILE), `${generatedHtmlPath(target)}: ${GENERATED_HTML_FILE} without ${NOTES_FILE}, or the reverse`);
  }
  for (const id of templates) assert.ok(!has(id, 'report.md'), `${id} has report.md, which notes.json replaced`);
});

test('a template reported per vault keeps no report of its own, and each vault report has its notes.json', () => {
  const perVault = templates.filter((id) => templateTargets(ROOT, registry).some((t) => t.template === id && t.cardVault !== undefined));
  assert.ok(perVault.includes('morpho/vault-deposit'));
  for (const id of perVault) {
    for (const file of [GENERATED_HTML_FILE, 'report.generated.md']) assert.ok(!has(id, file), `${id} is reported per vault but has ${file}`);
    for (const target of templateTargets(ROOT, registry).filter((t) => t.template === id)) assert.ok(existsSync(join(ROOT, notesPath(id, target.cardVault))), `${target.cardVault} has no ${NOTES_FILE}`);
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
  const id = [...NOT_YET_REBUILT][0] ?? assert.fail('every template has notes');
  const { subject } = loadReport(ROOT, registry, { template: id });
  assert.equal(await generatedHtml(ROOT, { subject, registry } as ReportInputs, { command: '', sources: [] }), undefined);
});

test('the committed HTML report is what the program writes from the recordings and notes.json, byte for byte', () => {
  assert.ok(withNotes.size > 0);
  for (const [path, { html }] of replayed) assert.equal(htmlDifference(readFileSync(join(ROOT, path), 'utf8'), html), undefined, path);
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

/** Every piece of text in notes.json the page prints: all strings but URLs and the enum values. */
function noteTexts(raw: unknown): string[] {
  if (typeof raw === 'string') return /^https:\/\//.test(raw) || ['safe', 'caution', 'confirmed', 'concern', 'pass', 'attention', 'fail'].includes(raw) ? [] : [raw];
  if (Array.isArray(raw)) return raw.flatMap(noteTexts);
  if (typeof raw === 'object' && raw !== null) return Object.entries(raw).flatMap(([key, value]) => (key === 'from' || key === 'to' ? [] : noteTexts(value)));
  return [];
}

test('the HTML report holds no script and loads nothing', () => {
  for (const [id, { html }] of replayed) {
    for (const banned of [/<script/i, /<link/i, /@import/i, /src=/i, /<img/i, /<iframe/i]) assert.doesNotMatch(html, banned, id);
    for (const [, target] of html.matchAll(/url\(([^)]*)\)/g)) assert.match(target as string, /^#[a-z-]+$/, `${id}: url(${target})`);
  }
});

test('every link is a URL the registry, docs.json or notes.json holds, one of the three the program builds, or an id on the page', () => {
  for (const [id, { html }] of replayed) {
    const notes = notesOf(id);
    const docs = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, withNotes.get(id)?.template ?? '', DOCS_FILE), 'utf8')) as Record<string, { url: string }>;
    const allowed = new Set<string>([
      'https://defillama.com/hacks',
      ...[...registry.entries.values()].flatMap((e) => [
        e.source,
        ...(e.apiSource === undefined ? [] : [e.apiSource.url]),
        ...(e.coingecko === undefined ? [] : [`https://www.coingecko.com/en/coins/${e.coingecko}`]),
        ...(e.defillama === undefined ? [] : [`https://defillama.com/protocol/${e.defillama}`]),
      ]),
      ...Object.values(docs).map((d) => d.url),
      ...JSON.stringify(notes).match(/https:\/\/[^"]+/g)!,
    ]);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => unescape(m[1] as string)));
    for (const [, raw] of html.matchAll(/\shref="([^"]*)"/g)) {
      const href = unescape(raw as string);
      if (href.startsWith('#')) assert.ok(ids.has(href.slice(1)), `${id}: ${href} names no id on the page`);
      else assert.ok(allowed.has(href), `${id}: ${href} is not a URL the report may link`);
    }
  }
});

test('every text the AI wrote is inside an element with its dashed AI tag, and nowhere else', () => {
  for (const [id, { html }] of replayed) {
    const { rest, cut } = withoutAi(html);
    assert.ok(cut.length > 0, id);
    for (const element of cut) assert.match(element, /class="(byai|tagt)"/, `${id}: AI text without its tag: ${element.slice(0, 120)}`);
    const plain = noteTexts(notesOf(id)).flatMap((text) => text.split('`').filter((part, i) => i % 2 === 0 && part.length >= 6));
    for (const text of plain) assert.ok(!unescape(rest).includes(text), `${id}: ${text} outside an AI element`);
  }
});

test('AI text is HTML-escaped', async () => {
  const id = [...withNotes.keys()][0] as string;
  const { inputs, title } = replayed.get(id) ?? assert.fail(id);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail(id);
  const raw = notesOf(id) as Record<string, unknown>;
  const html = renderPage(
    buildPage(
      { ...inputs, fixtures: await judgeFixtures(ROOT, template, registry), example: firstRecordedTx(ROOT, template, registry) },
      { ...raw, title: '<b>&"x</b>', summary: "<script>alert('x')</script>" },
      title,
    ),
  );
  assert.ok(!html.includes('<b>&"x</b>') && !html.includes('<script>'));
  const { cut } = withoutAi(html);
  assert.ok(cut.some((element) => element.includes('&#60;b&#62;&#38;&#34;x&#60;/b&#62;')));
  assert.ok(cut.some((element) => element.includes('&#60;script&#62;alert(&#39;x&#39;)&#60;/script&#62;')));
});

test('a code span in AI text prints as <code> in prose and as a boxed monospace span in the diagram, escaped', async () => {
  const id = [...withNotes.keys()][0] as string;
  const { inputs, title } = replayed.get(id) ?? assert.fail(id);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail(id);
  const raw = notesOf(id) as { flow: { text: string }[] } & Record<string, unknown>;
  const flow = raw.flow.map((line, i) => (i === 0 ? { ...line, text: '依序呼叫 `erc20TransferFrom` 和 `erc4626Deposit`' } : line));
  const html = renderPage(
    buildPage(
      { ...inputs, fixtures: await judgeFixtures(ROOT, template, registry), example: firstRecordedTx(ROOT, template, registry) },
      { ...raw, summary: '先呼叫 `multicall`，<b>不是</b> `approve()`', flow },
      title,
    ),
  );
  assert.ok(html.includes('先呼叫 <code>multicall</code>，&#60;b&#62;不是&#60;/b&#62; <code>approve()</code>'));
  assert.ok(!html.includes('`'), 'no backtick reaches the page');
  const caption = /<g data-ai>.*?<\/g>/s.exec(html.slice(html.indexOf('<svg viewBox')))?.[0] ?? assert.fail('a flow caption');
  assert.equal([...caption.matchAll(/<rect class="codebox"/g)].length, 2);
  assert.deepEqual([...caption.matchAll(/<tspan class="capc"[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]), ['erc20TransferFrom', 'erc4626Deposit']);
});

test('every state icon is an image with a Chinese name, and the rest are hidden from screen readers', () => {
  for (const [id, { html }] of replayed) {
    for (const [svg] of html.matchAll(/<svg class="i[^"]*"[^>]*>/g)) assert.match(svg, /role="img" aria-label="[^"]*[\u4e00-\u9fff][^"]*"|aria-hidden="true"/, `${id}: ${svg}`);
    for (const [, state] of html.matchAll(/data-state="([^"]+)"/g)) assert.ok(['ok', 'warn', 'bad', 'na', 'ask'].includes(state as string), id);
  }
});

test('--compare prints the first line where the committed HTML report differs', () => {
  assert.equal(htmlDifference('a\nb', 'a\nb'), undefined);
  assert.equal(htmlDifference('a\nb ok', 'a\nb FINDING'), 'line 2: committed "b ok", the program writes "b FINDING"');
  assert.match(htmlDifference(undefined, 'a') ?? '', /no committed report\.generated\.html/);
  assert.match(htmlDifference('a', undefined) ?? '', /no notes\.json/);
});

test('--compare names every notes.json a branch changes, as text the AI wrote', () => {
  assert.deepEqual(notesChanges(['src/x.ts', 'templates/morpho/market-supply/notes.json', 'templates/morpho/market-supply/report.generated.html', 'templates/notes.json']), ['templates/morpho/market-supply/notes.json']);
});
