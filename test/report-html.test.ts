import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { replayReader } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseCoinGeckoCoins, parseDefiLlamaProtocols, sourcePagesOf, sourceSiteLine } from '../src/research/listings.ts';
import { NOTES_FILE, NotesError, notesChanges, parseNotes } from '../src/research/notes.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { GENERATED_HTML_FILE, confidenceOf, htmlDifference, loadNotes, notesKeys, renderHtml, templateFixtures } from '../src/research/report-html.ts';
import { checkSpans, entriesOf, loadSubject, renderReport, replayInputs, reportRecordingPath } from '../src/research/report.ts';
import type { ReportInputs, ReportRecording } from '../src/research/report.ts';
import { pageUrlOf, sourceHoldsAddress } from '../src/research/source-page.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';

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

type Shown = { readonly mark: string; readonly flag: string | undefined };

/** Each program result of the address cards by its id, `<registry name>/<check key>`: its mark and its flag word. */
function cardResults(html: string): Map<string, Shown> {
  const results = new Map<string, Shown>();
  for (const card of cards(html).values()) {
    for (const m of card.matchAll(/<li data-result="([^"]+)"><span class="mark (\w+)">[^<]*<\/span><div>(?:<span class="flag">([A-Z]+)<\/span>)?/g)) {
      results.set(m[1] as string, { mark: m[2] as string, flag: m[3] });
    }
  }
  return results;
}

/** The rows of the first table under a Markdown heading, each a map from its column header to its cell. */
function tableRows(markdown: string, heading: string): Map<string, string>[] {
  const start = markdown.indexOf(`${heading}\n`);
  assert.ok(start !== -1, `the Markdown report has ${heading}`);
  const end = markdown.indexOf('\n## ', start + 1);
  const cells = (line: string) => line.split('|').slice(1, -1).map((cell) => cell.trim());
  const [header, , ...rows] = markdown.slice(start, end === -1 ? undefined : end).split('\n').filter((line) => line.startsWith('|'));
  const names = cells(header as string);
  return rows.map((row) => new Map(cells(row).map((cell, i) => [names[i] as string, cell])));
}

const VOUCHES = /\/(?:source\.coingecko|source\.site|doc\.0x[0-9a-f]{8}\.site)$/;

/**
 * Every result the Markdown report prints for an entry, a page, a code pin span or an ABI proof, against the same result
 * in the address cards: a PASS is ✓; a FINDING, REFUSED or UNVERIFIABLE keeps its word and is ! unless it had nothing to
 * compare (a site DefiLlama lists nothing for, while another result of the entry vouches; a compiler not pinned). Every !
 * is in the action list under its own id.
 */
function assertFlagsKept(markdown: string, html: string, inputs: ReportInputs): void {
  if (inputs.subject.kind !== 'template') throw new Error('unreachable');
  const expected = new Map<string, string>();
  const selectors = new Map(inputs.subject.docs.map((doc) => [doc.fn.signature, doc.fn.selector]));
  const pageOf = new Map<string, { readonly url: string; readonly slug: string | undefined }>([
    ...[...inputs.registry.entries.values()].map((e) => [`${e.name}/source.site`, { url: e.source, slug: e.defillama }] as const),
    ...inputs.subject.docs.map((d) => [`${d.contract.name}/doc.${d.fn.selector}.site`, { url: d.url, slug: d.contract.defillama }] as const),
  ]);
  const unlisted = (id: string) => {
    const page = pageOf.get(id);
    const line = page === undefined ? undefined : sourceSiteLine(page.url, page.slug, inputs.listings);
    return line?.kind === 'finding' && line.cause === 'unlisted';
  };
  const name = (cell: string) => /^`([a-z0-9.-]+)`$/.exec(cell)?.[1] as string;
  for (const row of tableRows(markdown, '## Official documentation')) {
    const id = `${name(row.get('Contract') as string)}/doc.${selectors.get(name(row.get('Function') as string) ?? (row.get('Function') as string).slice(1, -1))}`;
    expected.set(`${id}.site`, row.get('Site') as string);
    expected.set(`${id}.commit`, row.get('GitHub commit') as string);
    expected.set(`${id}.page`, row.get('Function name appears on page') as string);
  }
  for (const row of tableRows(markdown, '## Registry entries')) {
    const entry = name(row.get('Entry') as string);
    expected.set(`${entry}/source.site`, row.get('DefiLlama site') as string);
    expected.set(`${entry}/source.coingecko`, row.get('CoinGecko coin') as string);
    expected.set(`${entry}/source.commit`, row.get('GitHub commit') as string);
    const { source, address } = inputs.registry.entries.get(entry)!;
    expected.set(`${entry}/${sourceHoldsAddress(source, address) ? 'source.url' : 'source.page'}`, row.get('Address on page') as string);
  }
  const spans = new Map<string, number>();
  for (const row of tableRows(markdown, '## Code pins')) {
    const entry = name(row.get('Entry') as string);
    spans.set(entry, (spans.get(entry) ?? 0) + 1);
    expected.set(`${entry}/code.${spans.get(entry)}`, row.get('Chain') as string);
  }
  for (const row of tableRows(markdown, '## ABI proofs')) {
    const result = row.get('Result') as string;
    expected.set(`${name(row.get('Entry') as string)}/abi`, result.startsWith('PROVEN') ? (row.get('Equals pin') as string) : result);
  }
  const shown = cardResults(html);
  for (const [id, cell] of expected) {
    if (cell === 'n/a') {
      assert.ok(!shown.has(id), `${id} is n/a in the Markdown report and has no result in its card`);
      continue;
    }
    const result = shown.get(id);
    assert.ok(result !== undefined, `${id} (${cell}) has a result in its card`);
    const flag = /^(FINDING|REFUSED|UNVERIFIABLE)\b/.exec(cell)?.[1];
    if (cell === 'PASS') assert.deepEqual(result, { mark: 'ok', flag: undefined }, `${id} passed`);
    else if (flag === undefined) assert.deepEqual(result, { mark: 'na', flag: undefined }, `${id} (${cell}) was not read`);
    else {
      assert.equal(result.flag, flag, `${id} keeps its word ${flag}`);
      const entry = id.split('/')[0] as string;
      const vouched = [...shown].some(([other, r]) => other.startsWith(`${entry}/`) && VOUCHES.test(other) && r.mark === 'ok');
      const nothingToCompare = (/\.site$/.test(id) && vouched && unlisted(id)) || /compiler-not-pinned/.test(cell);
      assert.equal(result.mark, nothingToCompare ? 'na' : 'warn', `${id} (${cell}) is for the signer unless it had nothing to compare`);
    }
  }
  const acts = [...shown].filter(([, r]) => r.mark === 'warn').map(([id]) => id).sort();
  const listed = [...section(html, '需要你做的事').matchAll(/<li data-result="([^"]+)">/g)].map((m) => m[1] as string).filter((id) => id.includes('/')).sort();
  assert.deepEqual(listed, acts, 'every result an address card marks ! is in the action list under its id');
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
  const compilers = await warmCompilers(reportCases(ROOT, registry, withNotes.map((template) => ({ template }))));
  for (const id of withNotes) {
    const { inputs, title } = await replayInputs(ROOT, registry, { template: id }, compilers, suffixes);
    if (inputs.subject.kind !== 'template') throw new Error('unreachable');
    const html = renderHtml(inputs, loadNotes(ROOT, inputs.subject, registry)!, title, templateFixtures(ROOT, inputs.subject.template, registry));
    assertFlagsKept(renderReport(inputs, title), html, inputs);
    const committed = readFileSync(join(ROOT, TEMPLATES_DIR, id, GENERATED_HTML_FILE), 'utf8');
    assert.equal(htmlDifference(committed, html), undefined, `${TEMPLATES_DIR}/${id}/${GENERATED_HTML_FILE} differs from what the program writes; run \`pnpm report ${id} --render\` and never edit it by hand`);
    if (id !== ID) continue;
    const edited = committed.replace('<span class="mark warn">!</span><div><span class="flag">FINDING</span>', '<span class="mark ok">✓</span><div>');
    assert.notEqual(edited, committed);
    assert.match(htmlDifference(edited, html) ?? '', /^line \d+: committed ".*✓.*", the program writes ".*FINDING.*"$/, 'a hand-edited report fails --compare, which prints the line');
    assert.match(htmlDifference(undefined, html) ?? '', /no committed report\.generated\.html/);
    assert.match(htmlDifference(committed, undefined) ?? '', /no notes\.json/);
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
  refuse({ result: 'MATCH' }, /unknown key "result"/);
  refuse({ summary: 'a‮b' }, /summary: holds a control or bidirectional character/);
  refuse({ judgments: [{ text: 'x', recommendation: 'y', sources: ['https://example.com/<a>'] }] }, /judgments\[0\]\.sources\[0\]: not an https URL/);
  refuse({ judgments: [{ text: 'x', recommendation: 'y', sources: ['javascript:alert(1)'] }] }, /not an https URL/);
  refuse({ judgments: [{ text: 'x'.repeat(201), recommendation: 'y' }] }, /judgments\[0\]\.text: longer than 200 characters/);
  refuse({ judgments: [{ text: 'x' }] }, /judgments\[0\]: recommendation is missing/);
  refuse({ judgments: Array.from({ length: 5 }, () => ({ text: 'x', recommendation: 'y' })) }, /judgments: more than 4 items/);
  refuse({ reviews: { 'usdc/abi': { status: 'ok', text: 'x', recommendation: 'y' } } }, /reviews\.usdc\/abi\.status: not "confirmed" or "concern"/);
  refuse({ reviews: { 'usdc/abi': { status: 'confirmed', text: 'x' } } }, /reviews\.usdc\/abi: recommendation is missing/);
  refuse({ overview: [{ text: 'x' }] }, /overview\[0\]: title is missing/);
  refuse({ overview: Array.from({ length: 7 }, () => ({ title: 't', text: 'x' })) }, /overview: more than 6 items/);
  refuse({ tests: Array.from({ length: 3 }, () => ({ text: 'x' })) }, /tests: more than 2 items/);
  refuse({ entries: { usdc: { checks: { abi: 'x'.repeat(201) } } } }, /entries\.usdc\.checks\.abi: longer than 200 characters/);
  refuse({ flow: [{ after: 3, text: 'x' }] }, /flow\[0\]\.after: not the number of one of the template's 2 calls/);
  refuse({ flow: [{ after: 0, text: 'x' }] }, /flow\[0\]\.after: not the number/);
  refuse({ flow: Array.from({ length: 5 }, () => ({ after: 1, text: 'x' })) }, /flow: more than 4 items/);
  refuse({ flow: [{ after: 1, text: 'x'.repeat(101) }] }, /flow\[0\]\.text: longer than 100 characters/);
  refuse({ pastTxsConclusion: { status: 'confirmed', text: 'x' } }, /pastTxsConclusion\.status: not "safe" or "caution"/);
  refuse({ verdict: { status: 'safe', text: 'x' } }, /verdict: recommendation is missing/);
  refuse({ verdict: { status: 'safe', text: 'x', recommendation: 'x'.repeat(101) } }, /verdict\.recommendation: longer than 100 characters/);
  refuse({ title: 'x'.repeat(101) }, /title: longer than 100 characters/);
  await assert.rejects(render({ ...committedNotes, entries: { usdc: { checks: { 'source.page.hidden': 'x' } } } }), (e: unknown) => e instanceof NotesError && /"source\.page\.hidden" is not a result of this entry/.test(e.message));
});

test('every result the signer must look at needs the AI review, and a review of any other result is refused', async () => {
  const reviews = committedNotes.reviews as Record<string, unknown>;
  const refused = (notes: unknown, message: RegExp) => assert.rejects(render(notes), (e: unknown) => e instanceof NotesError && message.test(e.message));
  await refused({ ...committedNotes, reviews: {} }, /"morpho-oracle-cbbtc-usdc-86\/source\.page" is a result the signer must look at and has no review/);
  const extra = { status: 'confirmed', text: 'x', recommendation: 'y' };
  await refused({ ...committedNotes, reviews: { ...reviews, 'usdc/abi': extra } }, /"usdc\/abi" is not a result the signer must look at/);
  await refused({ ...committedNotes, reviews: { ...reviews, 'morpho-blue/code.1': extra } }, /"morpho-blue\/code\.1" is not a result the signer must look at/);
});

test('AI text is escaped and always carries the AI tag; the page holds no script', async () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const reviews = { 'morpho-oracle-cbbtc-usdc-86/source.page': { status: 'concern', text: hostile, recommendation: hostile } };
  const html = await render({
    ...committedNotes,
    title: hostile,
    judgments: [{ title: hostile, text: hostile, recommendation: hostile }],
    reviews,
    overview: [{ title: hostile, text: hostile }],
    fields: { '2.to': hostile },
    entries: { usdc: { checks: { abi: hostile } } },
    flow: [{ after: 1, text: hostile }],
    pastTxsConclusion: { status: 'safe', text: hostile },
    verdict: { status: 'safe', text: hostile, recommendation: hostile },
  });
  assert.ok(!/<script|<img|onerror=/i.test(html.replace(/&lt;script|&lt;img|onerror=alert/g, '')), 'no tag or handler from the notes reaches the page');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the text shows escaped');
  assert.match(html, /<p class="lede">[^]*?<span class="by ai">AI 研究<\/span><\/p>/, 'the summary carries the AI tag');
  assert.match(html, /<h1>&lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span><\/h1>/, 'the title carries the AI tag');
  const judged = section(html, '需要你做的事');
  assert.match(judged, /<li><span class="mark ai">\?<\/span><div><b>&lt;script&gt;[^<]*<\/b> &lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span><div class="rec"><b>建議：<\/b>&lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span><\/div><\/div><\/li>/, 'an AI judgment and its recommendation carry the AI tag');
  assert.match(
    judged,
    /讀到的來源頁面上沒有這個地址<span class="by prog">程式<\/span><\/div><div class="review concern"><div><b>AI 有疑慮：<\/b>&lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span><\/div><div class="rec"><b>建議：<\/b>&lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span><\/div><\/div>/,
    'the AI review sits under the program line, which keeps its program tag',
  );
  assert.match(section(html, '整體安全嗎'), /<span class="label">&lt;script&gt;[^<]*<\/span><div>&lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span><\/div>/, 'an overview line carries the AI tag');
  assert.match(section(html, '這筆交易怎麼走'), /<li class="ai"><span class="n">↳<\/span><div>&lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span><\/div><\/li>/, 'an AI flow line carries the AI tag');
  assert.match(section(html, '研究了哪些過去的交易，結論是什麼'), /AI 結論：沒看到問題<\/b> &lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span>/, 'the AI conclusion carries the AI tag');
  assert.match(section(html, '整體安全嗎'), /AI 判斷：沒看到問題<\/b> &lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span>[^]*<b>建議：<\/b>&lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span>/, 'the AI verdict and its recommendation carry the AI tag');
  assert.match(html, /<td>&lt;script&gt;[^<]*&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;<span class="by ai">AI 研究<\/span><\/td>/, 'a field meaning carries the AI tag');
  assert.match(cards(html).get('usdc') ?? '', /沒有用原始碼重新編譯來比對<span class="by prog">程式<\/span>[^]*?<div class="why">&lt;script&gt;[^<]*<span class="by ai">AI 研究<\/span><\/div>/, 'a line under a program result carries the AI tag and keeps the result');
});

test('every link is a registry source, a docs.json page, a notes.json source or an in-page anchor; the page loads nothing', async () => {
  const html = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8');
  const notes = loadNotes(ROOT, subject, registry)!;
  const allowed = new Set<string>([
    ...entriesOf(subject, registry).map((e) => e.source),
    ...subject.docs.map((d) => d.url),
    ...[...notes.judgments, ...notes.overview, ...notes.tests, ...[...notes.entries.values()].flatMap((e) => e.notes), ...notes.details.flatMap((d) => d.notes)].flatMap((n) => n.sources),
  ]);
  const links = [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => (m[1] as string).replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
  assert.ok(links.length > 0);
  for (const url of links) {
    assert.ok(allowed.has(url) || /^#entry-[a-z0-9.-]+$/.test(url), `${url} is not a link the report may hold`);
  }
  assert.doesNotMatch(html, /<link\b|<script\b|@import|url\(/i, 'no stylesheet, script or font is loaded from anywhere');
});

test('a real disagreement or a page the program cannot read is for the signer to do; nothing to compare folds into its card', async () => {
  const html = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8');
  const todo = section(html, '需要你做的事');
  assert.match(
    todo,
    /FINDING<\/span><b><a href="#entry-morpho-oracle-cbbtc-usdc-86">morpho-oracle-cbbtc-usdc-86<\/a>：<\/b>程式不跑 JavaScript，讀到的來源頁面上沒有這個地址<span class="by prog">程式<\/span><\/div><div class="review confirmed"><div><b>AI 已確認：<\/b>/,
  );
  assert.match(
    cards(html).get('morpho-oracle-cbbtc-usdc-86') ?? '',
    /讀到的來源頁面上沒有這個地址<span class="by prog">程式<\/span><div class="why">來源頁面 <a href="https:\/\/app\.morpho\.org\/[^"]+">[^<]+<\/a>；要找的 oracle 地址是 <span class="mono">0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a<\/span>。/,
  );
  assert.doesNotMatch(todo, /entry-(?:cbbtc|usdc)"/, 'nothing to compare is not a thing to do');
  const [cbbtcOpen, cbbtcFolded] = (cards(html).get('cbbtc') ?? '').split('<details>');
  assert.doesNotMatch(cbbtcOpen ?? '', /class="flag"/);
  assert.match(cbbtcFolded ?? '', /<span class="mark na">–<\/span><div><span class="flag">FINDING<\/span>沒比對來源的 GitHub 組織/);
  assert.match(cards(html).get('usdc') ?? '', /<details>[^]*<span class="mark na">–<\/span><div><span class="flag">FINDING<\/span>沒比對<code>approve<\/code> 的文件頁面的 GitHub 組織/);
  assert.match(cards(html).get('usdc') ?? '', /<details>[^]*<span class="mark ok">✓<\/span><div>Sourcify 上的原始碼用固定版本的編譯器重新編譯後，跟鏈上的程式碼一樣（代理合約，比對的是背後的實作 <span class="mono">0x43506849D7C04F9138D1A2050bbF3A0c054402dd<\/span>）（<code>FiatTokenV2_2<\/code>，solc 0\.6\.12\+commit\.27d51765），也就是 registry 記錄的現在指紋/);

  const inputs = await quickInputs();
  const blue = registry.entries.get('morpho-blue')!;
  const irm = registry.entries.get('adaptive-curve-irm')!;
  const spans = new Map([
    ...inputs.spans,
    [blue.address, [{ kind: 'finding', text: 'FINDING: block 18883124 runs `0x00`' }]],
    [irm.address, [{ kind: 'unverifiable', text: 'UNVERIFIABLE at block 18883123' }]],
  ] as const);
  const changed = { ...inputs, spans };
  const review = { status: 'concern', text: 'x', recommendation: 'y' };
  const reviews = { ...(committedNotes.reviews as Record<string, unknown>), 'morpho-blue/code.1': review, 'adaptive-curve-irm/code.1': review };
  const rendered = renderHtml(changed, parseNotes({ ...committedNotes, reviews }, keys), TITLE, []);
  assertFlagsKept(renderReport(changed, TITLE), rendered, changed);
  const injected = section(rendered, '需要你做的事');
  assert.match(injected, /FINDING<\/span><b><a href="#entry-morpho-blue">morpho-blue<\/a>：<\/b>區塊 <span class="num">18883124<\/span> 前後的程式碼跟記錄的不符/);
  assert.match(injected, /UNVERIFIABLE<\/span><b><a href="#entry-adaptive-curve-irm">adaptive-curve-irm<\/a>：<\/b>區塊 <span class="num">18883124<\/span> 前後的程式碼讀不到/);
  const signing = section(rendered, '每次簽名，程式會自動檢查');
  assert.match(signing, /<li><span class="mark warn">!<\/span><div>每個合約現在的程式碼都要是 registry 記錄的指紋<span class="by prog">程式<\/span><div class="why">這份報告有 2 段程式碼指紋紀錄在鏈上沒能確認；見「需要你做的事」。/, 'a span not confirmed does not look confirmed at the top');
  assert.match(section(rendered, '整體安全嗎'), /<code>morpho-blue<\/code>：<span class="sym warn">!<\/span> 程式碼從哪個區塊開始沒能確認（FINDING）/);
  assert.match(section(rendered, '整體安全嗎'), /程式還有 3 項要你看，見「需要你做的事」。<span class="by prog">程式<\/span>/, 'the program\'s open count sits beside the AI verdict');

  const unread = renderHtml({ ...inputs, spans: new Map([...inputs.spans].filter(([address]) => address !== blue.address)) }, parseNotes({ ...committedNotes, reviews: { ...(committedNotes.reviews as Record<string, unknown>), 'morpho-blue/code.1': review } }, keys), TITLE, []);
  assert.match(section(unread, '需要你做的事'), /morpho-blue<\/a>：<\/b>程式沒有區塊 <span class="num">18883124<\/span> 這段程式碼的鏈上檢查結果/, 'a span with no result is for the signer, not –');
  assert.match(section(unread, '整體安全嗎'), /<code>morpho-blue<\/code>：<span class="sym warn">!<\/span> 程式碼從哪個區塊開始沒能確認（沒有檢查結果）/);
});

test('a site DefiLlama lists nothing for is – only while another result vouches for the source; alone it is for the signer', async () => {
  const inputs = await quickInputs();
  const slug = registry.entries.get('morpho-blue')!.defillama!;
  const protocols = new Map([...inputs.listings.protocols].map(([key, listed]) => [key, key === slug ? listed.map((p) => ({ ...p, url: undefined, github: [] })) : listed]));
  const changed = { ...inputs, listings: { ...inputs.listings, protocols } };
  const [bundles] = subject.docs.filter((doc) => doc.contract.name === 'blue-bundles-v1');
  const alone = ['morpho-blue/source.site', 'blue-bundles-v1/source.site', `blue-bundles-v1/doc.${bundles!.fn.selector}.site`, 'adaptive-curve-irm/source.site', 'morpho-oracle-cbbtc-usdc-86/source.site'];
  const review = { status: 'concern', text: 'x', recommendation: 'y' };
  const reviews = { ...(committedNotes.reviews as Record<string, unknown>), ...Object.fromEntries(alone.map((id) => [id, review])) };
  const html = renderHtml(changed, parseNotes({ ...committedNotes, reviews }, keys), TITLE, []);
  assertFlagsKept(renderReport(changed, TITLE), html, changed);
  const todo = section(html, '需要你做的事');
  for (const id of alone) {
    assert.match(todo, new RegExp(`<li data-result="${id.replace(/\./g, '\\.')}"><span class="mark warn">!</span><div><div class="result"><span class="flag">FINDING</span><b><a [^>]+>[^<]+</a>：</b>沒有第二個來源能證明這個來源屬於這個協議<span class="by prog">程式</span>`), id);
  }
  for (const name of ['morpho-blue', 'blue-bundles-v1', 'adaptive-curve-irm']) assert.match(cards(html).get(name) ?? '', /<span class="level low">低信心<\/span>/, name);
  const shown = cardResults(html);
  assert.equal(shown.get('cbbtc/source.site')?.mark, 'na', 'cbBTC\'s unlisted site stays –: CoinGecko lists it at its address');
  assert.equal(shown.get('cbbtc/source.coingecko')?.mark, 'ok');
  assert.equal(shown.get(`usdc/doc.${subject.docs.find((doc) => doc.contract.name === 'usdc')!.fn.selector}.site`)?.mark, 'na', 'USDC\'s unlisted docs org stays –: its source site and CoinGecko agree');
});

test('a documentation page is keyed by selector, and one the program could not fetch says so', async () => {
  const inputs = await quickInputs();
  const [doc] = subject.docs.filter((d) => d.contract.name === 'blue-bundles-v1');
  const pages = new Map(inputs.pages.pages);
  pages.set(pageUrlOf(doc!.url), { kind: 'failed', why: 'timeout' });
  const id = `blue-bundles-v1/doc.${doc!.fn.selector}.page`;
  const reviews = { ...(committedNotes.reviews as Record<string, unknown>), [id]: { status: 'concern', text: 'x', recommendation: 'y' } };
  const html = renderHtml({ ...inputs, pages: { ...inputs.pages, pages } }, parseNotes({ ...committedNotes, reviews }, keys), TITLE, []);
  assert.match(section(html, '需要你做的事'), new RegExp(`<li data-result="${id.replace(/\./g, '\\.')}">[^]*?程式沒讀到 <code>blueBundlesV1Supply</code> 的文件頁面`));
  assert.doesNotMatch(section(html, '需要你做的事'), /程式不跑 JavaScript，讀到的文件頁面/);
});

test('--compare names every notes.json a branch changes, as text the AI wrote', () => {
  assert.deepEqual(notesChanges(['src/x.ts', 'templates/morpho/market-supply/notes.json', 'templates/morpho/market-supply/report.generated.html', 'templates/notes.json']), ['templates/morpho/market-supply/notes.json']);
});

test('the wallet section mocks each call\'s screen from the program\'s labels and the template\'s rules, and names what it hides', () => {
  const html = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8');
  const wallet = section(html, 'ERC-7730 描述檔會怎麼顯示這筆交易');
  const afterActions = html.slice(html.indexOf('<h2>需要你做的事</h2>') + 1);
  assert.ok(afterActions.slice(afterActions.indexOf('<h2>')).startsWith('<h2>ERC-7730 描述檔會怎麼顯示這筆交易</h2>'), 'the wallet section follows the action list');
  assert.match(wallet, /<h3>呼叫 1：<code>approve<\/code>，對象 <code>usdc<\/code><\/h3><div class="screen raw"><div class="line">原始資料（看不懂的十六進位）<\/div><\/div>/);
  assert.match(wallet, /<div class="line"><span class="label">金額<\/span>你在 card 填的數量（usdc）<\/div>/);
  assert.match(wallet, /<div class="line"><span class="label">抵押品<\/span>cbbtc<\/div>/);
  assert.match(wallet, /<div class="line"><span class="label">LLTV<\/span>86%<\/div>/);
  assert.match(wallet, /<div class="line"><span class="label">截止時間<\/span>任意<\/div>/);
  assert.match(wallet, /<div class="line"><span class="label">推薦費收款人<\/span>無（零地址）<\/div>/);
  assert.doesNotMatch(wallet, /0x0{40}/);
  assert.match(wallet, /<b>錢包不會顯示：<\/b>借出代幣、oracle、利率模型、拉代幣方式。只看錢包分不出是哪個 market。<span class="by prog">程式<\/span>/);
  assert.doesNotMatch(html, /descriptorHash/, 'the raw ERC-7730 output stays in the Markdown report');
});

test('every line of a result list starts with its mark', () => {
  const html = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8');
  const lists = [...html.matchAll(/<ul class="checks">([^]*?)<\/ul>/g)].map((m) => m[1] as string);
  assert.ok(lists.length > 0);
  for (const list of lists) {
    for (const item of list.split(/<li(?: data-result="[^"]+")?>/).slice(1)) assert.match(item, /^<span class="mark (?:ok|warn|na|info|dot|ai)">/, `a result line without a mark: ${item.slice(0, 80)}`);
  }
  const past = section(html, '研究了哪些過去的交易，結論是什麼').match(/<li>/g)?.length ?? 0;
  assert.ok(past <= 4, `the past transactions section has ${past} lines`);
});

test('the page reads top to bottom in the signer\'s order, the signing checks open', () => {
  const html = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8');
  const headings = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(headings, ['每次簽名，程式會自動檢查', '這筆交易怎麼走', '研究了哪些過去的交易，結論是什麼', '整體安全嗎', '需要你做的事', 'ERC-7730 描述檔會怎麼顯示這筆交易', '每個地址確認了什麼', '細節']);
  const checks = section(html, '每次簽名，程式會自動檢查');
  assert.doesNotMatch(checks, /<details/, 'the signing checks are not folded');
  assert.match(checks, /Safe 只付出你填的 usdc，沒有多付<span class="by prog">程式<\/span>/);
  assert.doesNotMatch(checks, /class="mark ok"/, 'a check to come is not marked as confirmed');
  assert.equal(checks.match(/<li><span class="mark dot">•<\/span>/g)?.length, checks.match(/<li>/g)?.length, 'each check to come carries a bullet');
  assert.match(checks, /每個被綁住的欄位都對得上你的 card 或固定值/);
  assert.match(checks, /Safe 的 ETH 和代幣餘額只有上面這個變化（NFT 等不在檢查範圍）/);
  assert.match(checks, /交易後 Safe 的每個授權都不比交易前高/);
  assert.doesNotMatch(checks, /沒有留下沒用完的授權|每個數字都對得上/);
  assert.match(checks, /交易前後在 morpho-blue 讀一次你的 Safe 的部位：supplyShares 要增加，其他不變<span class="by prog">程式<\/span>/);
});

test('the flow lists each call from the template, the AI lines after the call they belong to, then each read', () => {
  const flow = section(readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8'), '這筆交易怎麼走');
  const steps = [...flow.matchAll(/<li class="(prog|ai)"><span class="n">([^<]+)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(steps, ['prog 1', 'prog 2', 'ai ↳', 'ai ↳', 'prog 3'], 'only the program\'s steps are numbered');
  assert.match(flow, /Safe → <a href="#entry-usdc">usdc<\/a>：授權 <a href="#entry-blue-bundles-v1">blue-bundles-v1<\/a> 拉走你在 card 填的數量（usdc）<span class="by prog">程式<\/span>/);
  assert.match(flow, /Safe → <a href="#entry-blue-bundles-v1">blue-bundles-v1<\/a>：呼叫 <code>blueBundlesV1Supply<\/code><span class="by prog">程式<\/span>/);
  assert.match(flow, /<a href="#entry-morpho-blue">morpho-blue<\/a>：程式在交易前後各讀一次 Safe 的 <code>position<\/code>/);
});

test('the past transactions and safety sections state the program\'s counts, and the protocol overview is visible', () => {
  const html = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8');
  const past = section(html, '研究了哪些過去的交易，結論是什麼');
  assert.match(past, /抽查過去一年 40 筆相關交易（共找到 528 筆）：2 筆來自 Safe、8 筆來自一般錢包，8 筆和這個模板同形狀。<span class="by prog">程式<\/span>/);
  assert.match(past, /<span class="mark ok">✓<\/span><div>拿 1 筆別的 Safe 真實執行過的交易測過：都 MATCH；欄位一個一個改掉 15 次，每次都被擋下。<span class="by prog">程式<\/span>/);
  const safety = section(html, '整體安全嗎');
  assert.match(safety, /AI 判斷：要小心<\/b>[^]*?<span class="by ai">AI 研究<\/span><\/div><\/li><li><span class="mark warn">!<\/span><div>程式還有 1 項要你看，見「需要你做的事」。<span class="by prog">程式<\/span>/, 'the program\'s open count follows the AI verdict');
  assert.doesNotMatch(section(html, '需要你做的事'), /<li><span class="mark warn">/, 'an AI judgment does not carry the program\'s !');
  assert.match(safety, /6 個地址：3 個高信心、2 個中信心、1 個低信心<span class="by prog">程式<\/span>（低信心的 AI 已確認<span class="by ai">AI 研究<\/span>）/);
  assert.match(safety, /<code>morpho-blue<\/code>：程式碼自區塊 <span class="num">18883124<\/span> 起沒變過/);
  assert.match(safety, /<span class="label">程式碼多久沒變<\/span>[^]*<span class="by prog">程式<\/span><\/div><\/li><\/ul>/);
});

test('an address card\'s confidence comes from the program\'s results alone', async () => {
  const ok = (key: string) => ({ key, status: 'ok' as const });
  const na = (key: string) => ({ key, status: 'na' as const });
  const act = (key: string) => ({ key, status: 'act' as const });
  const cases = [
    { checks: [ok('source.page'), ok('source.site'), ok('abi'), ok('code.1')], level: 'high' },
    { checks: [ok('source.page'), ok('code.1'), ok('code.2')], level: 'high' },
    { checks: [ok('source.page'), na('source.site'), ok('code.1')], level: 'medium' },
    { checks: [ok('source.page'), ok('abi'), na('code.1')], level: 'medium' },
    { checks: [ok('source.site'), ok('abi'), ok('code.1')], level: 'medium' },
    { checks: [ok('source.page'), ok('abi')], level: 'medium' },
    { checks: [act('source.page'), ok('abi'), ok('code.1')], level: 'low' },
    { checks: [ok('source.page'), na('abi'), act('code.1')], level: 'low' },
  ] as const;
  for (const { checks, level } of cases) assert.equal(confidenceOf(checks), level, checks.map((c) => `${c.key}:${c.status}`).join(' '));

  const html = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_HTML_FILE), 'utf8');
  const levels = new Map([...cards(html)].map(([name, card]) => [name, card.match(/<span class="level (\w+)">([^<]*)/)?.slice(1).join(' ')]));
  assert.deepEqual(Object.fromEntries(levels), {
    usdc: 'medium 中信心',
    'morpho-blue': 'high 高信心',
    'blue-bundles-v1': 'high 高信心',
    'adaptive-curve-irm': 'high 高信心',
    'morpho-oracle-cbbtc-usdc-86': 'low 低信心',
    cbbtc: 'medium 中信心',
  });

  const reviews = Object.fromEntries(Object.entries(committedNotes.reviews as Record<string, unknown>).map(([id, review]) => [id, { ...(review as object), status: 'concern' }]));
  const doubted = await render({ ...committedNotes, reviews });
  assert.match(cards(html).get('morpho-oracle-cbbtc-usdc-86') ?? '', /<span class="level low">低信心<\/span><span class="reviewed confirmed">AI 已確認<span class="by ai">AI 研究<\/span><\/span>/, 'the review status sits beside the level, apart from it');
  assert.match(cards(doubted).get('morpho-oracle-cbbtc-usdc-86') ?? '', /<span class="level low">低信心<\/span><span class="reviewed concern">AI 有疑慮/, 'a review changes only the words beside the level');
});
