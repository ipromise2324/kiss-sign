import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { replayReader } from '../src/chain/recording.ts';
import { cachedCompilers } from '../src/contracts/solc.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseCoinGeckoCoins, parseDefiLlamaProtocols, sourcePagesOf } from '../src/research/listings.ts';
import { NOTES_FILE, NotesError, parseNotes } from '../src/research/notes.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { GENERATED_HTML_FILE, loadNotes, notesKeys, renderHtml, templateFixtures } from '../src/research/report-html.ts';
import { checkSpans, entriesOf, loadSubject, renderReport, replayInputs, reportRecordingPath } from '../src/research/report.ts';
import type { ReportInputs, ReportRecording } from '../src/research/report.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const suffixes = loadPublicSuffixList();
const ID = 'morpho/market-supply';
const subject = loadSubject(ROOT, registry, { template: ID });
if (subject.kind !== 'template') throw new Error('unreachable');
const keys = notesKeys(subject, registry);
const committedNotes = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, ID, NOTES_FILE), 'utf8')) as Record<string, unknown>;

const templates = readdirSync(join(ROOT, TEMPLATES_DIR)).flatMap((protocol) => readdirSync(join(ROOT, TEMPLATES_DIR, protocol)).map((operation) => `${protocol}/${operation}`));
const has = (id: string, file: string) => existsSync(join(ROOT, TEMPLATES_DIR, id, file));

/** The inputs without ABI proofs or past transactions, which only the replay test compiles and studies. */
async function quickInputs(): Promise<ReportInputs> {
  const recording = JSON.parse(readFileSync(join(ROOT, reportRecordingPath({ template: ID })), 'utf8')) as ReportRecording;
  return {
    subject,
    registry,
    listings: { protocols: parseDefiLlamaProtocols(recording.defillama), coinsByAddress: parseCoinGeckoCoins(recording.coingecko), suffixes },
    pages: sourcePagesOf(recording),
    fetched: recording.fetched,
    abi: new Map(),
    vaults: new Map(),
    pastTxs: [],
    spans: await checkSpans(replayReader(recording.code), entriesOf(subject, registry)),
    erc7730: { text: 'not read', reports: [] },
  };
}

const TITLE = { command: 'test', sources: [] };
const render = async (notes: unknown): Promise<string> => renderHtml(await quickInputs(), parseNotes(notes, keys), TITLE, []);

/** Each address card of the page, by registry name. */
function cards(html: string): Map<string, string> {
  return new Map([...html.matchAll(/<article class="addr" id="entry-([a-z0-9.-]+)">([^]*?)<\/article>/g)].map((m) => [m[1] as string, m[2] as string]));
}

const FLAG = /\b(?:FINDING|REFUSED|UNVERIFIABLE)\b/g;

/** Every FINDING, REFUSED and UNVERIFIABLE the Markdown report prints for an entry, a page or a code pin, against the flags the address cards show. */
function assertFlagsKept(markdown: string, html: string): void {
  const sections = ['## Official documentation', '## Registry entries', '## Code pins', '## ABI proofs'];
  const printed = sections.flatMap((heading) => {
    const start = markdown.indexOf(`${heading}\n`);
    assert.ok(start !== -1, `the Markdown report has ${heading}`);
    const end = markdown.indexOf('\n## ', start + 1);
    return markdown.slice(start, end === -1 ? undefined : end).split('\n').filter((line) => line.startsWith('|')).flatMap((line) => line.match(FLAG) ?? []);
  });
  const shown = [...cards(html).values()].flatMap((card) => [...card.matchAll(/<span class="flag">([A-Z]+)<\/span>/g)].map((m) => m[1]));
  assert.deepEqual(shown.sort(), printed.sort(), 'every flag of the Markdown report shows in an address card');
  const acts = [...cards(html).values()].flatMap((card) => card.split('<details>')[0]?.match(/class="mark warn"/g) ?? []).length;
  const listed = section(html, '需要你做的事').match(/<b><a href="#entry-/g)?.length ?? 0;
  assert.equal(listed, acts, 'every result an address card shows above its fold is in the action list');
}

/** The text of one section, from its heading to the next. */
function section(html: string, heading: string): string {
  const start = html.indexOf(`<h2>${heading}</h2>`);
  assert.ok(start !== -1, `the report has the section ${heading}`);
  const next = html.indexOf('<h2>', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

test('every committed report.generated.html is what the program writes from the recordings and notes.json', { timeout: 600_000 }, async () => {
  const withNotes = templates.filter((id) => has(id, NOTES_FILE));
  assert.ok(withNotes.includes(ID), `${ID} has ${NOTES_FILE}`);
  const compilers = cachedCompilers();
  for (const id of withNotes) {
    const { inputs, title } = await replayInputs(ROOT, registry, { template: id }, compilers, suffixes);
    if (inputs.subject.kind !== 'template') throw new Error('unreachable');
    const html = renderHtml(inputs, loadNotes(ROOT, inputs.subject, registry)!, title, templateFixtures(ROOT, inputs.subject.template, registry));
    assertFlagsKept(renderReport(inputs, title), html);
    const committed = readFileSync(join(ROOT, TEMPLATES_DIR, id, GENERATED_HTML_FILE), 'utf8');
    assert.ok(html === committed, `${TEMPLATES_DIR}/${id}/${GENERATED_HTML_FILE} differs from what the program writes; run \`pnpm report ${id} --render\` and never edit it by hand`);
  }
});

test('a template with notes.json has report.generated.html and no report.md, and an HTML report needs notes.json', () => {
  for (const id of templates) {
    if (has(id, NOTES_FILE)) {
      assert.ok(has(id, GENERATED_HTML_FILE), `${id} has ${NOTES_FILE} but no ${GENERATED_HTML_FILE}`);
      assert.ok(!has(id, 'report.md'), `${id} has ${NOTES_FILE}, which replaces report.md`);
    }
    if (has(id, GENERATED_HTML_FILE)) assert.ok(has(id, NOTES_FILE), `${id} has ${GENERATED_HTML_FILE} but no ${NOTES_FILE}`);
  }
});

test('notes.json is refused for an entry the report does not cover, an unknown field or key, a control character, a URL outside RFC 3986, or too much text', async () => {
  const refuse = (change: Record<string, unknown>, message: RegExp) => assert.throws(() => parseNotes({ ...committedNotes, ...change }, keys), (e: unknown) => e instanceof NotesError && message.test(e.message));
  refuse({ entries: { bundler3: { role: 'x' } } }, /"bundler3" is not a registry entry this report covers/);
  refuse({ fields: { '3.to': 'x' } }, /"3\.to" is not a key of the report's field table/);
  refuse({ verdict: 'MATCH' }, /unknown key "verdict"/);
  refuse({ summary: 'a‮b' }, /summary: holds a control or bidirectional character/);
  refuse({ judgments: [{ text: 'x', sources: ['https://example.com/<a>'] }] }, /judgments\[0\]\.sources\[0\]: not an https URL/);
  refuse({ judgments: [{ text: 'x', sources: ['javascript:alert(1)'] }] }, /not an https URL/);
  refuse({ judgments: [{ text: 'x'.repeat(201) }] }, /judgments\[0\]\.text: longer than 200 characters/);
  refuse({ judgments: Array.from({ length: 5 }, () => ({ text: 'x' })) }, /judgments: more than 4 items/);
  refuse({ tests: Array.from({ length: 3 }, () => ({ text: 'x' })) }, /tests: more than 2 items/);
  refuse({ entries: { usdc: { checks: { abi: 'x'.repeat(201) } } } }, /entries\.usdc\.checks\.abi: longer than 200 characters/);
  await assert.rejects(render({ ...committedNotes, entries: { usdc: { checks: { 'source.page.hidden': 'x' } } } }), (e: unknown) => e instanceof NotesError && /"source\.page\.hidden" is not a result of this entry/.test(e.message));
});

test('AI text is escaped and always carries the AI tag; the page holds no script', async () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const html = await render({ ...committedNotes, title: hostile, judgments: [{ title: hostile, text: hostile }], fields: { '2.to': hostile }, entries: { usdc: { checks: { abi: hostile } } } });
  assert.ok(!/<script|<img|onerror=/i.test(html.replace(/&lt;script|&lt;img|onerror=alert/g, '')), 'no tag or handler from the notes reaches the page');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the text shows escaped');
  assert.match(html, /<p class="lede">[^]*?<span class="by ai">AI 研究<\/span><\/p>/, 'the summary carries the AI tag');
  const judged = section(html, '需要你做的事');
  assert.match(judged, /<li><span class="mark warn">!<\/span><div><b>&lt;script&gt;[^]*?<span class="by ai">AI 研究<\/span><\/div><\/li>/, 'an AI judgment carries the AI tag');
  assert.match(html, /<td>&lt;script&gt;[^<]*&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;<span class="by ai">AI 研究<\/span><\/td>/, 'a field meaning carries the AI tag');
  assert.match(cards(html).get('usdc') ?? '', /沒有用原始碼重新編譯來比對<span class="by prog">程式<\/span>[^]*?<div class="why">&lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span><\/div>/, 'a line under a program result carries the AI tag and keeps the result');
});

test('every link is a registry source, a docs.json page, a notes.json source, an in-page anchor, or the font stylesheet', async () => {
  const html = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8');
  const notes = loadNotes(ROOT, subject, registry)!;
  const allowed = new Set<string>([
    ...entriesOf(subject, registry).map((e) => e.source),
    ...subject.docs.map((d) => d.url),
    ...[...notes.judgments, ...notes.tests, ...[...notes.entries.values()].flatMap((e) => e.notes), ...notes.details.flatMap((d) => d.notes)].flatMap((n) => n.sources),
  ]);
  const links = [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => (m[1] as string).replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
  assert.ok(links.length > 0);
  for (const url of links) {
    assert.ok(allowed.has(url) || /^#entry-[a-z0-9.-]+$/.test(url) || url.startsWith('https://fonts.googleapis.com/css2?'), `${url} is not a link the report may hold`);
  }
});

test('a real disagreement or a page the program cannot read is for the signer to do; nothing to compare folds into its card', async () => {
  const html = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8');
  const todo = section(html, '需要你做的事');
  assert.match(
    todo,
    /FINDING<\/span><b><a href="#entry-morpho-oracle-cbbtc-usdc-86">morpho-oracle-cbbtc-usdc-86<\/a>：<\/b>程式不跑 JavaScript，讀到的來源頁面上沒有這個地址。請在瀏覽器打開 <a href="https:\/\/app\.morpho\.org\/[^"]+">[^<]+<\/a>，確認頁面上的 oracle 地址是 <span class="mono">0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a<\/span>/,
  );
  assert.doesNotMatch(todo, /entry-(?:cbbtc|usdc)"/, 'nothing to compare is not a thing to do');
  const [cbbtcOpen, cbbtcFolded] = (cards(html).get('cbbtc') ?? '').split('<details>');
  assert.doesNotMatch(cbbtcOpen ?? '', /class="flag"/);
  assert.match(cbbtcFolded ?? '', /<span class="mark na">–<\/span><div><span class="flag">FINDING<\/span>沒比對來源的 GitHub 組織/);
  assert.match(cards(html).get('usdc') ?? '', /<details>[^]*<span class="mark na">–<\/span><div><span class="flag">FINDING<\/span>沒比對<code>approve<\/code> 的文件頁面的 GitHub 組織/);
  assert.match(cards(html).get('usdc') ?? '', /<details>[^]*<span class="mark na">–<\/span><div><span class="flag">REFUSED<\/span>沒有用原始碼重新編譯來比對/);

  const inputs = await quickInputs();
  const blue = registry.entries.get('morpho-blue')!;
  const irm = registry.entries.get('adaptive-curve-irm')!;
  const spans = new Map([...inputs.spans, [blue.address, ['FINDING: block 18883124 runs `0x00`']], [irm.address, ['UNVERIFIABLE at block 18883123']]]);
  const changed = { ...inputs, spans };
  const rendered = renderHtml(changed, parseNotes(committedNotes, keys), TITLE, []);
  assertFlagsKept(renderReport(changed, TITLE), rendered);
  const injected = section(rendered, '需要你做的事');
  assert.match(injected, /FINDING<\/span><b><a href="#entry-morpho-blue">morpho-blue<\/a>：<\/b>區塊 <span class="num">18883124<\/span> 前後的程式碼跟記錄的不符/);
  assert.match(injected, /UNVERIFIABLE<\/span><b><a href="#entry-adaptive-curve-irm">adaptive-curve-irm<\/a>：<\/b>區塊 <span class="num">18883124<\/span> 前後的程式碼讀不到/);
});

test('the wallet section shows, for each call, the fields an ERC-7730 wallet hides that the template binds', () => {
  const html = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8');
  assert.match(html, /<h3>呼叫 1：<code>approve<\/code>，對象 <code>usdc<\/code><\/h3><p>沒有描述檔，錢包會顯示原始資料。/);
  assert.match(html, /<span class="mark warn">!<\/span><div><code>marketParams\.oracle<\/code>：錢包不會顯示 <code>oracle<\/code>。模板綁住它/);
  assert.match(html, /<span class="mark ok">✓<\/span><div><code>assets<\/code>：錢包會顯示。模板綁住它：card 上的 <code>amount<\/code>/);
  assert.doesNotMatch(html, /descriptorHash/, 'the raw ERC-7730 output stays in the Markdown report');
});
