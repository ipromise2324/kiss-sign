import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { loadRegistry } from '../src/registry.ts';
import { NOTES_FILE, notesChanges, readNotes } from '../src/research/notes.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { GENERATED_HTML_FILE, generatedHtml, generatedHtmlPath, htmlDifference, renderPage } from '../src/research/report-html.ts';
import { buildPage } from '../src/research/report-page.ts';
import { DOCS_FILE, loadSubject, replayInputs } from '../src/research/report.ts';
import type { ReportInputs, ReportTitle } from '../src/research/report.ts';
import { firstRecordedTx, judgeFixtures } from '../src/template/perturb.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const templates = readdirSync(join(ROOT, TEMPLATES_DIR)).flatMap((protocol) => readdirSync(join(ROOT, TEMPLATES_DIR, protocol)).map((operation) => `${protocol}/${operation}`));
const has = (id: string, file: string) => existsSync(join(ROOT, TEMPLATES_DIR, id, file));
const withNotes = templates.filter((id) => has(id, NOTES_FILE));
const NOT_YET_REBUILT: ReadonlySet<string> = new Set([
  'cctp/receive',
  'erc20/transfer',
  'eth/transfer',
  'fluid/rewards-claim',
  'fluid/vault-deposit',
  'fluid/vault-redeem',
  'fluid/vault-withdraw',
  'merkl/claim',
  'morpho/urd-claim',
  'morpho/vault-bundles-deposit',
  'morpho/vault-migrate-all',
  'morpho/vault-withdraw',
  'morpho/vault-withdraw-all',
  'safe/cancel',
]);

const replayed = new Map<string, { readonly inputs: ReportInputs; readonly title: ReportTitle; readonly html: string }>();

before(async () => {
  const compilers = await warmCompilers(reportCases(ROOT, registry, withNotes.map((template) => ({ template }))));
  for (const id of withNotes) {
    const { inputs, title } = await replayInputs(ROOT, registry, { template: id }, compilers, loadPublicSuffixList());
    replayed.set(id, { inputs, title, html: (await generatedHtml(ROOT, inputs, title)) ?? assert.fail(`${id} has notes but no HTML`) });
  }
});

test('a template commits report.generated.html exactly when it has notes.json, and none has report.md', () => {
  for (const id of templates) {
    assert.equal(has(id, GENERATED_HTML_FILE), has(id, NOTES_FILE), `${id}: ${GENERATED_HTML_FILE} without ${NOTES_FILE}, or the reverse`);
    assert.ok(!has(id, 'report.md'), `${id} has report.md, which notes.json replaced`);
  }
});

test('only a template not yet rebuilt may lack notes.json', () => {
  for (const id of templates) assert.ok(has(id, NOTES_FILE) || NOT_YET_REBUILT.has(id), `${id} has no ${NOTES_FILE} and is not in the list of templates not yet rebuilt`);
  for (const id of NOT_YET_REBUILT) assert.ok(templates.includes(id) && !has(id, NOTES_FILE), `${id} is listed as not yet rebuilt but has ${NOTES_FILE} or no folder`);
});

test('a template without notes.json gets no HTML report', async () => {
  const id = [...NOT_YET_REBUILT][0] ?? assert.fail('every template has notes');
  const subject = loadSubject(ROOT, registry, { template: id });
  assert.equal(await generatedHtml(ROOT, { subject, registry } as ReportInputs, { command: '', sources: [] }), undefined);
});

test('the committed HTML report is what the program writes from the recordings and notes.json, byte for byte', () => {
  assert.ok(withNotes.length > 0);
  for (const [id, { html }] of replayed) assert.equal(htmlDifference(readFileSync(join(ROOT, generatedHtmlPath(id)), 'utf8'), html), undefined, id);
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
    const notes = readNotes(ROOT, id);
    const docs = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, id, DOCS_FILE), 'utf8')) as Record<string, { url: string }>;
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
    for (const text of noteTexts(readNotes(ROOT, id))) assert.ok(!unescape(rest).includes(text), `${id}: ${text} outside an AI element`);
  }
});

test('AI text is HTML-escaped', async () => {
  const id = withNotes[0] as string;
  const { inputs, title } = replayed.get(id) ?? assert.fail(id);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail(id);
  const raw = readNotes(ROOT, id) as Record<string, unknown>;
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
