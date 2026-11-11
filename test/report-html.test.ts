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
import { GENERATED_HTML_FILE, loadNotes, notesKeys, renderHtml } from '../src/research/report-html.ts';
import { checkSpans, entriesOf, loadSubject, replayInputs, reportRecordingPath } from '../src/research/report.ts';
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
    erc7730: 'not read',
  };
}

const render = async (notes: unknown): Promise<string> => renderHtml(await quickInputs(), parseNotes(notes, keys), { command: 'test', sources: [] });

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
    const html = renderHtml(inputs, loadNotes(ROOT, inputs.subject, registry)!, title);
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

test('notes.json is refused for an entry the report does not cover, an unknown field or key, a control character, or a URL outside RFC 3986', () => {
  const refuse = (change: Record<string, unknown>, message: RegExp) => assert.throws(() => parseNotes({ ...committedNotes, ...change }, keys), (e: unknown) => e instanceof NotesError && message.test(e.message));
  refuse({ entries: { bundler3: { role: 'x' } } }, /"bundler3" is not a registry entry this report covers/);
  refuse({ fields: { '3.to': 'x' } }, /"3\.to" is not a key of the report's field table/);
  refuse({ verdict: 'MATCH' }, /unknown key "verdict"/);
  refuse({ summary: 'a‮b' }, /summary: holds a control or bidirectional character/);
  refuse({ judgments: [{ text: 'x', sources: ['https://example.com/<a>'] }] }, /judgments\[0\]\.sources\[0\]: not an https URL/);
  refuse({ judgments: [{ text: 'x', sources: ['javascript:alert(1)'] }] }, /not an https URL/);
});

test('AI text is escaped and always carries the AI tag; the page holds no script', async () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const html = await render({ ...committedNotes, title: hostile, judgments: [{ title: hostile, text: hostile }], fields: { '2.to': hostile } });
  assert.ok(!/<script|<img|onerror=/i.test(html.replace(/&lt;script|&lt;img|onerror=alert/g, '')), 'no tag or handler from the notes reaches the page');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the text shows escaped');
  assert.match(html, /<h1>&lt;script&gt;.*?<span class="by ai">AI 研究<\/span><\/h1>/, 'the title carries the AI tag');
  const judged = section(html, '需要你自己判斷的事');
  assert.match(judged, /<li><span class="mark warn">!<\/span><div><b>&lt;script&gt;[^]*?<span class="by ai">AI 研究<\/span><\/div><\/li>/, 'an AI judgment carries the AI tag');
  assert.match(html, /<td>&lt;script&gt;[^<]*&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;<span class="by ai">AI 研究<\/span><\/td>/, 'a field meaning carries the AI tag');
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

test('each FINDING, REFUSED or UNVERIFIABLE of the program is listed for the signer to judge, with its entry', async () => {
  const committed = section(readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8'), '需要你自己判斷的事');
  assert.match(committed, /FINDING<\/span><b><a href="#entry-morpho-oracle-cbbtc-usdc-86">morpho-oracle-cbbtc-usdc-86<\/a>：<\/b>登記的來源頁面上沒找到這個地址/);
  assert.match(committed, /FINDING<\/span><b><a href="#entry-cbbtc">cbbtc<\/a>：<\/b>沒辦法確認來源的 GitHub 組織屬於這個協議/);
  assert.match(committed, /FINDING<\/span><b><a href="#entry-usdc">usdc<\/a>：<\/b><code>approve<\/code> 的文件頁面網站沒能跟 DefiLlama 上登記的對上/);
  assert.match(committed, /REFUSED<\/span><b><a href="#entry-usdc">usdc<\/a>：<\/b>沒有用原始碼重新編譯來比對/);
  const inputs = await quickInputs();
  const blue = registry.entries.get('morpho-blue')!;
  const irm = registry.entries.get('adaptive-curve-irm')!;
  const spans = new Map([...inputs.spans, [blue.address, ['FINDING: block 18883124 runs `0x00`']], [irm.address, ['UNVERIFIABLE at block 18883123']]]);
  const judged = section(renderHtml({ ...inputs, spans }, parseNotes(committedNotes, keys), { command: 'test', sources: [] }), '需要你自己判斷的事');
  assert.match(judged, /FINDING<\/span><b><a href="#entry-morpho-blue">morpho-blue<\/a>：<\/b>區塊 <span class="num">18883124<\/span> 前後的程式碼跟記錄的不符/);
  assert.match(judged, /UNVERIFIABLE<\/span><b><a href="#entry-adaptive-curve-irm">adaptive-curve-irm<\/a>：<\/b>區塊 <span class="num">18883124<\/span> 前後的程式碼讀不到/);
});
