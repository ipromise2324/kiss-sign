import { join } from 'node:path';
import { loadRegistry } from '../registry.ts';
import { firstRecordedTx, judgeFixtures } from '../template/perturb.ts';
import type { State } from './ledger.ts';
import { NOTES_FILE, codeSpans, readNotes } from './notes.ts';
import { buildPage } from './report-page.ts';
import type { AddressRow, AiText, ArgRow, Body, CallBlock, Chip, Flow, Inline, Page, ProtocolBlock, RailCount, Section, Sequence, SiteResult, SourceLine, VaultBlock } from './report-page.ts';
import { reportDir } from './report.ts';
import type { ReportInputs, ReportTitle } from './report.ts';

export const GENERATED_HTML_FILE = 'report.generated.html';
export const generatedHtmlPath = (target: { readonly template: string; readonly cardVault?: string }): string => join(reportDir(target), GENERATED_HTML_FILE);

/** Markup the renderer made. Every other value is escaped on its way into it. */
export class Html {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

type Part = Html | string | number | undefined | false | readonly Part[];

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const part = (value: Part): string => (value instanceof Html ? value.text : Array.isArray(value) ? value.map(part).join('') : value === undefined || value === false ? '' : escape(String(value)));

/** The one way markup is built: every interpolated value is escaped unless the renderer made it. */
export function h(strings: TemplateStringsArray, ...parts: readonly Part[]): Html {
  return new Html(strings.reduce((out, s, i) => out + s + (i < parts.length ? part(parts[i] as Part) : ''), ''));
}

const ICONS: Readonly<Record<State | 'ask', { readonly symbol: string; readonly tone: string; readonly label: string }>> = {
  ok: { symbol: 'ok', tone: 'ok', label: '通過' },
  warn: { symbol: 'warn', tone: 'warn', label: '注意' },
  bad: { symbol: 'bad', tone: 'bad', label: '不通過' },
  na: { symbol: 'na', tone: 'mute', label: '沒資料可比' },
  ask: { symbol: 'ask', tone: 'mute', label: 'AI 判斷' },
};

export const icon = (state: State | 'ask'): Html => h`<svg class="i ${ICONS[state].tone}" role="img" aria-label="${ICONS[state].label}"><use href="#${ICONS[state].symbol}"/></svg>`;
const decor = (symbol: 'info' | 'chev'): Html => h`<svg class="i${symbol === 'chev' ? ' chev' : ''}" aria-hidden="true"><use href="#${symbol}"/></svg>`;

function text(spans: Inline): Html {
  return h`${spans.map((span) => {
    if (typeof span === 'string') return span;
    if ('code' in span) return h`<code>${span.code}</code>`;
    if ('mono' in span) return h`<span class="addr">${span.mono}</span>`;
    if ('num' in span) return h`<span class="num">${span.num}</span>`;
    return h`<a href="${span.href.startsWith('https://') ? span.href : `#${span.href}`}">${span.label}</a>`;
  })}`;
}

/** AI text's parts: plain text, and each code span the parser let through as one identifier. */
const aiParts = (text: string): { readonly text: string; readonly code: boolean }[] => (codeSpans(text) ?? [text]).map((part, i) => ({ text: part, code: i % 2 === 1 }));

const aiProse = (text: string): Html => h`${aiParts(text).map((part) => (part.code ? h`<code>${part.text}</code>` : part.text))}`;

/** The only way AI text reaches the page: escaped, with its sources linked and its dashed tag. */
function ai(note: AiText): Html {
  const sources = note.sources.map((url, i) => h` <a class="aisrc" href="${url}">來源${note.sources.length > 1 ? ` ${i + 1}` : ''}</a>`);
  const tag = h`<span class="byai">${note.tag}</span>`;
  return note.tag === 'AI' ? h`<span class="aiw" data-ai>${tag}<span>${aiProse(note.ai)}${sources}</span></span>` : h`<span class="aiw" data-ai><span>${aiProse(note.ai)}${sources}</span>${tag}</span>`;
}

let tips = 0;
const tip = (label: string, body: string): Html => {
  tips += 1;
  return h`<span class="tip" tabindex="0" aria-label="${label}" aria-describedby="t${tips}">${decor('info')}<span class="bub" id="t${tips}" role="tooltip">${body}</span></span>`;
};

const stateCounts = (count: Extract<RailCount, { kind: 'states' }>): Html => h`${count.counts.map((c) => h` <span class="cnt" data-state="${c.state}">${icon(c.state)}${c.n}</span>`)}`;

const railCount = (count: RailCount | undefined): Html => (count === undefined ? h`` : count.kind === 'text' ? h` <span class="cnt">${count.text}</span>` : stateCounts(count));

const contents = (sections: readonly Section[]): Html => h`<ol>${sections.map((s) => h`<li><a href="#${s.anchor}">${s.label}${railCount(s.count)}</a></li>`)}</ol>`;

function header(page: Page): Html {
  const { header: head, sections } = page;
  return h`<header>
  <h1>${ai(head.title)}</h1>
  <span class="opid">${page.id}</span>
  <p class="sub">${ai(head.summary)}</p>
  <ul class="checks">${head.strip.map(
    (item) => h`
    <li data-state="${item.state}" data-line="${item.line}">${icon(item.state)}${item.name}${item.count === undefined ? '' : h` <span class="n num">${item.count}</span>`}
      ${tip('說明', item.explain)}</li>`,
  )}
  </ul>
  <div class="verdict" data-state="${head.verdict.state}"><span class="lbl">建議</span>${icon(head.verdict.state)}${ai(head.verdict.text)}</div>
  <details class="tocfold"><summary>${decor('chev')}目錄</summary>
    ${contents(sections)}
  </details>
</header>`;
}

const SPACING = 190;
const FIRST_X = 90;
const NODE_TOP = 14;
const NODE_HEIGHT = 44;
const AI_TAG_WIDTH = 56;
/** How far a call from the Safe to itself loops out to the right. */
const SELF_LOOP = 64;

const CJK_FIRST = 0x2e80;
/** About how wide 14px text draws: a CJK character a full em, anything else about half. */
const textWidth = (text: string): number => [...text].reduce((w, c) => w + ((c.codePointAt(0) ?? 0) >= CJK_FIRST ? 14 : 7.6), 0);
/** A code span in a caption: 13px monospace, 0.6em a character, inside a box with this much room on each side. */
const CODE_CHAR = 7.8;
const CODE_PAD = 4;
const CODE_GAP = 3;

/**
 * An AI caption in the diagram, starting at `x` on baseline `y`: each code span in monospace on its own box, every part
 * placed at its own x, so an estimate that is off moves only the text after it. Returns the markup and its width.
 */
function caption(text: string, x: number, y: number): { readonly boxes: Html; readonly text: Html; readonly width: number } {
  let at = x;
  const boxes: Html[] = [];
  const spans = aiParts(text).map((part) => {
    if (!part.code) {
      const span = h`<tspan x="${at}">${part.text}</tspan>`;
      at += textWidth(part.text);
      return span;
    }
    const width = part.text.length * CODE_CHAR;
    boxes.push(h`<rect class="codebox" x="${at + CODE_GAP}" y="${y - 14}" width="${width + 2 * CODE_PAD}" height="19" rx="6"/>`);
    const span = h`<tspan class="capc" x="${at + CODE_GAP + CODE_PAD}">${part.text}</tspan>`;
    at += width + 2 * (CODE_PAD + CODE_GAP);
    return span;
  });
  return { boxes: h`${boxes}`, text: h`<text class="cap" y="${y}">${spans}</text>`, width: at - x };
}

function diagram(sequence: Sequence): Html {
  const x = (i: number) => FIRST_X + i * SPACING;
  const width = Math.max(660, x(sequence.lifelines.length - 1) + FIRST_X);
  const rows: Html[] = [];
  let y = NODE_TOP + NODE_HEIGHT + 32;
  for (const arrow of sequence.arrows) {
    if (arrow.kind === 'call' && arrow.to === 0) {
      rows.push(h`
    <text class="no" x="${x(0) + 12}" y="${y}">${arrow.n}</text><text class="fn" x="${x(0) + 30}" y="${y}">${arrow.fn}</text>
    <path class="call" d="M${x(0)} ${y + 14}h${SELF_LOOP}v${SELF_LOOP / 4}h${3 - SELF_LOOP}" marker-end="url(#m-call)"/>`);
      y += 52 + SELF_LOOP / 4;
    } else if (arrow.kind === 'call') {
      rows.push(h`
    <text class="no" x="${x(0) + 12}" y="${y}">${arrow.n}</text><text class="fn" x="${x(0) + 30}" y="${y}">${arrow.fn}</text>
    <line class="call" x1="${x(0)}" y1="${y + 14}" x2="${x(arrow.to) - 3}" y2="${y + 14}" marker-end="url(#m-call)"/>`);
      y += 52;
    } else if (arrow.kind === 'inside') {
      const [from, to] = [x(arrow.from), arrow.to === arrow.from ? x(arrow.from) + 60 : x(arrow.to)];
      const wide = AI_TAG_WIDTH + 8 + caption(arrow.text.ai, 0, y).width;
      const left = Math.max(x(0) + 12, Math.min(Math.min(from, to) + 12, width - 8 - wide));
      const cap = caption(arrow.text.ai, left + AI_TAG_WIDTH + 8, y);
      rows.push(h`
    <g data-ai><rect class="tagbox" x="${left}" y="${y - 14}" width="${AI_TAG_WIDTH}" height="20" rx="6"/><text class="tagt" x="${left + AI_TAG_WIDTH / 2}" y="${y}" text-anchor="middle">${arrow.text.tag}</text>${cap.boxes}${cap.text}</g>
    <line class="inner" x1="${from}" y1="${y + 10}" x2="${to + (to > from ? -3 : 3)}" y2="${y + 10}" marker-end="url(#m-inside)"/>`);
      y += 36;
    } else {
      rows.push(h`
    <text class="capg" x="${x(0) + 14}" y="${y}">${arrow.text}</text>
    <line class="gain" x1="${x(arrow.from)}" y1="${y + 10}" x2="${x(0) + 3}" y2="${y + 10}" marker-end="url(#m-gets)"/>`);
      y += 40;
    }
  }
  const height = y - 6;
  const nodes = sequence.lifelines.map((line, i) => {
    const w = Math.min(SPACING - 16, Math.max(132, Math.ceil(line.name.length * 8.4) + 28));
    return h`
    <line class="life" x1="${x(i)}" y1="${NODE_TOP + NODE_HEIGHT}" x2="${x(i)}" y2="${height - 8}"/>
    <rect class="node" x="${x(i) - w / 2}" y="${NODE_TOP}" width="${w}" height="${NODE_HEIGHT}" rx="6"/><text class="nodet" x="${x(i)}" y="${NODE_TOP + 20}" text-anchor="middle">${line.name}</text><text class="nodes" x="${x(i)}" y="${NODE_TOP + 36}" text-anchor="middle">${line.role}</text>`;
  });
  const marker = (id: string, cls: string) => h`<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="${cls}" d="M0 0L10 5L0 10z"/></marker>`;
  return h`<div class="diagram">
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="dt dd">
    <title id="dt">交易流程</title>
    <desc id="dd">${sequence.narration}</desc>
    <defs>${marker('m-call', 'ah')}${marker('m-inside', 'ahi')}${marker('m-gets', 'ahg')}</defs>${nodes}${rows}
  </svg>
  </div>
  <div class="scrollhint">圖可以左右滑動</div>`;
}

const CHIP_CLASS: Readonly<Record<Chip['who'], string>> = { 'you-type': 'who you', 'you-pick': 'who you', fixed: 'who', free: 'who app' };
const chip = (c: Chip): Html => h`<span class="${CHIP_CLASS[c.who]}">${c.label}</span>`;

function valueLines(row: ArgRow): Html {
  return h`${row.value === undefined ? '' : h`<div class="raw">${row.value.cast}${row.value.example === undefined ? '' : h`<span class="ex">${row.value.example}</span>`}</div>`}<div class="is">${text(row.words)}${
    row.qualifier === undefined ? '' : h` <span class="f3">${text(row.qualifier)}</span>`
  }</div>${row.id === undefined ? '' : h`<div class="mid">${text(row.id)}</div>`}${row.ai === undefined ? '' : h`
        <div class="ai">${ai(row.ai)}</div>`}`;
}

function partsOf(row: ArgRow): Html {
  return h`${row.parts.map(
    (group) => h`
      <div class="parts">${group.label === undefined ? '' : h`<div class="plabel">${text(group.label)}</div>`}${group.rows.map(
        (p) => h`
        <div class="part"><div class="pn">${p.name}${p.chips.length === 0 ? '' : h`<div class="pchips">${p.chips.map(chip)}</div>`}</div><div>${valueLines(p)}</div>${partsOf(p)}</div>`,
      )}
      </div>`,
  )}`;
}

function argRow(row: ArgRow): Html {
  return h`
    <div class="arg" data-field="${row.key}">
      <div class="nm"><span class="pn">${row.name}</span>${row.chips.map(chip)}</div>
      <div class="val">${valueLines(row)}</div>${partsOf(row)}
    </div>`;
}

function callHead(call: CallBlock): Html {
  const { head } = call;
  return head.kind === 'fn'
    ? h`<span class="fnn"><span class="ct">${head.contract}.</span>${head.fn}</span><span class="sel">${head.selector}</span>`
    : h`<span class="what">${head.text}</span>`;
}

function flowBody(flow: Flow): Html {
  const lead = [
    flow.decoded ? h`每個單一值參數的第一行是 <code>cast decode-calldata</code> 會印出的值；陣列、tuple 和巢狀呼叫的第一行是摘要，內容列在下面。` : '',
    flow.example === undefined ? '' : text(flow.example),
  ];
  return h`
  <p class="lead">實線是 Safe 發出的呼叫，虛線是合約內部做的事，綠線是你得到的。</p>
  ${diagram(flow.diagram)}${
    flow.key.length === 0
      ? ''
      : h`
  <div class="key">
    <span class="k0">誰決定</span>${flow.key.map((item) => h`
    <span>${chip(item)}${item.means}</span>`)}
  </div>`
  }${lead.every((part) => part === '') ? '' : h`
  <p class="lead keylead">${lead}</p>`}${
    flow.safeTx.length === 0
      ? ''
      : h`
  <div class="cb">
    <div class="callh"><span class="what">Safe 交易</span></div>${flow.safeTx.map(argRow)}
  </div>`
  }
  ${flow.calls.map(
    (call) => h`
  <div class="cb">
    <div class="callh"><span class="no">${call.n}</span>${callHead(call)}</div>${
      call.sends === undefined ? '' : h`<div class="sends">${text(call.sends)}</div>`
    }${call.args.map(argRow)}
  </div>`,
  )}
  <h3>交易後</h3>${
    flow.after.length === 0
      ? h`
  <p class="lead">Safe 不給出、也不收到任何資產：模擬後 Safe 的餘額有任何變化，都是 MISMATCH。</p>`
      : h`
  <dl class="props">${flow.after.map((row) => h`
    <div><dt>${text(row.label)}</dt><dd class="${row.gains ? 'pos' : ''}">${text(row.value)}</dd><dd class="src">${text(row.note)}</dd></div>`)}
  </dl>`
  }`;
}

function protocolBody(block: ProtocolBlock): Html {
  return h`
  <p class="intro">${ai(block.intro)}</p>
  <dl class="props two">${block.rows.map(
    (row) => h`
    <div><dt>${row.label}</dt><dd>${row.value.length === 0 ? '' : h`<span>${text(row.value)}</span>`}${row.ai === undefined ? '' : ai(row.ai)}${row.sub === undefined ? '' : h`<span class="sub2">${text(row.sub)}</span>`}${
      row.nested.length === 0
        ? ''
        : h`
      <dl class="nest">${row.nested.map((n) => h`
        <div><dt>${text(n.label)}</dt><dd>${text(n.value)}${n.ai === undefined ? '' : h`<span class="sub2">${ai(n.ai)}</span>`}</dd></div>`)}
      </dl>`
    }</dd></div>`,
  )}
  </dl>
  <p class="srcline">程式在 ${block.read} 讀 ${block.sources.map((s, i) => h`${i === 0 ? '' : i === block.sources.length - 1 ? '和' : '、'}${s.href === undefined ? s.label : h`<a href="${s.href}">${s.label}</a>`}`)}。標 AI 研究的是 AI 查的。</p>`;
}

const CHART_WIDTH = 660;
const CHART_TOP = 34;
const CHART_BASE = 150;
const CHART_SIDE = 16;

/** The monthly `totalAssets()` readings as bars, oldest first: each titled with its date and amount, a month with no amount a dashed stub. */
function chart(block: VaultBlock): Html {
  const step = (CHART_WIDTH - 2 * CHART_SIDE) / Math.max(1, block.bars.length);
  const bars = block.bars.map((bar, i) => {
    const x = CHART_SIDE + i * step + step * 0.2;
    const w = step * 0.6;
    const height = bar.share === undefined ? 0 : Math.max(1, Math.round(bar.share * (CHART_BASE - CHART_TOP)));
    const mark =
      bar.share === undefined
        ? h`<rect class="barna" x="${x.toFixed(1)}" y="${CHART_BASE - 12}" width="${w.toFixed(1)}" height="12"><title>${bar.date}：${bar.words}</title></rect>`
        : h`<rect class="bar${i === block.bars.length - 1 ? ' last' : ''}" x="${x.toFixed(1)}" y="${CHART_BASE - height}" width="${w.toFixed(1)}" height="${height}"><title>${bar.date}：${bar.words}</title></rect>`;
    const [year, month] = bar.date.split('-');
    const first = i === 0 || month === '01';
    return h`
    ${mark}<text class="tick" x="${(x + w / 2).toFixed(1)}" y="${CHART_BASE + 18}" text-anchor="middle">${month === undefined ? '?' : `${Number(month)}月`}</text>${
      first && year !== undefined && month !== undefined ? h`<text class="tick" x="${(x + w / 2).toFixed(1)}" y="${CHART_BASE + 34}" text-anchor="middle">${year}</text>` : ''
    }`;
  });
  const span = block.bars.length === 0 ? '' : `${block.bars[0]?.date} 到 ${block.bars.at(-1)?.date}`;
  return h`<div class="diagram">
  <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_BASE + 44}" role="img" aria-labelledby="vt vd">
    <title id="vt">每月的 totalAssets</title>
    <desc id="vd">${block.bars.length} 個月，${span}，最高 ${block.most ?? '讀不到'}</desc>
    <text class="tick" x="${CHART_SIDE}" y="18">最高 ${block.most ?? '讀不到'}</text>
    <line class="axis" x1="${CHART_SIDE}" y1="${CHART_BASE}" x2="${CHART_WIDTH - CHART_SIDE}" y2="${CHART_BASE}"/>${bars}
  </svg>
  </div>
  <div class="scrollhint">圖可以左右滑動</div>`;
}

function vaultBody(block: VaultBlock): Html {
  return h`
  <p class="lead">${text(block.lead)}</p>${
    block.rows.length === 0
      ? ''
      : h`
  <dl class="props">${block.rows.map((row) => h`
    <div><dt>${row.label}</dt><dd>${text(row.value)}</dd><dd class="src">${text(row.note)}</dd></div>`)}
  </dl>
  <h3>每月的 totalAssets</h3>
  ${chart(block)}
  <details class="fold">
    <summary>${decor('chev')}${block.bars.length} 個月的數字</summary>
    <dl class="props">${block.bars.map((bar) => h`
      <div><dt class="num">${bar.date}</dt><dd class="num">${bar.words}</dd></div>`)}
    </dl>
  </details>`
  }`;
}

function reviewBody(body: Extract<Body, { kind: 'review' }>): Html {
  const empty = body.rows.length === 0 && body.judgments.length === 0;
  return h`
  <p class="lead">${empty ? '沒有要你看的結果。' : '每一項 AI 都先查過，附上建議。'}</p>
  <div class="rows">${body.rows.map(
    (row) => h`
    <div class="row" data-state="${row.state}" data-result="${row.id}">
      ${icon(row.state)}
      <div><div class="t">${text(row.title)}</div>
        <div class="meta">${text(row.why)}${row.entry === undefined ? '' : h`<a href="#${row.entry}">看來源</a>`}</div>
        <div class="rec"><span class="lbl">${row.review.status === 'confirmed' ? 'AI 已確認' : 'AI 有疑慮'}</span>${ai(row.review.text)}</div>
        <div class="rec"><span class="lbl">建議</span>${ai(row.review.recommendation)}</div></div>
    </div>`,
  )}${body.judgments.map(
    (j) => h`
    <div class="row">
      ${icon('ask')}
      <div><div class="t">${ai(j.text)}</div>
        <div class="rec"><span class="lbl">建議</span>${ai(j.recommendation)}</div></div>
    </div>`,
  )}
  </div>`;
}

function walletBody({ view }: Extract<Body, { kind: 'wallet' }>): Html {
  if (view.kind === 'multisend') {
    return h`
  <p class="lead">這筆 Safe 交易用 MultiSend 打包 ${view.calls} 個呼叫，硬體錢包解不開 Safe 的 MultiSend，所以請比對裝置上的 hash 和 <code>verify</code> 印的 safeTxHash。</p>`;
  }
  if (view.kind === 'no-data') {
    return h`
  <p class="lead">這筆交易的呼叫沒有資料，沒有函式可以用 ERC-7730 描述檔解讀。</p>`;
  }
  const described = view.calls.some((call) => call.rows !== 'no-descriptor');
  return h`
  <p class="lead">硬體錢包用 ERC-7730 描述檔顯示每個呼叫。${described ? '右邊是模板的規則，不是描述檔的文字。' : ''}</p>
  <dl class="props two">${view.calls.map(
    (call) => h`
    <div><dt>${text(call.title)}</dt>${
      call.rows === 'no-descriptor'
        ? h`<dd class="f3">沒有描述檔，只顯示原始資料</dd>`
        : h`<dd>
      <dl class="nest flat">${call.rows.map((r) => h`
        <div><dt>${text(r.label)}</dt><dd>${text(r.value)}</dd></div>`)}
      </dl></dd>`
    }</div>`,
  )}
  </dl>${view.lines.map((line) => h`
  <div class="warnline">${decor('info')}<span>${text(line)}</span></div>`)}`;
}

function siteLine(site: SiteResult): Html {
  const llama = site.href === undefined ? 'DefiLlama' : h`<a href="${site.href}">DefiLlama</a>`;
  return h`<span class="site" data-state="${site.state}">${icon(site.state)}<span>${site.state === 'ok' ? h`網站屬於 ${site.slug}` : h`網站：${site.phrase}`}（${llama} 對照）</span></span>`;
}

function sourceLine(line: SourceLine): Html {
  return h`<div class="src"><span data-state="${line.state}">${line.href === undefined ? line.label : h`<a href="${line.href}">${line.label}</a>`}<span class="res">${icon(line.state)}${line.phrase ?? ''}</span></span>${
    line.site === undefined ? '' : siteLine(line.site)
  }</div>`;
}

const CONFIDENCE: Readonly<Record<AddressRow['confidence'], string>> = { high: '高信心', medium: '中信心', low: '低信心' };

function addressRow(row: AddressRow): Html {
  return h`
    <div class="ad" id="${row.anchor}" data-state="${row.state}">
      ${icon(row.state)}
      <div><span class="nm">${row.name}</span><span class="role">${row.role === undefined ? '' : ai(row.role)}<span class="conf">${CONFIDENCE[row.confidence]}</span>${
        row.reviewed === undefined ? '' : h`<span class="reviewed">${row.reviewed}</span>`
      }</span></div>
      <div class="body"><span class="addr">${row.address}</span>
        <div class="srcs">${row.sources.map(sourceLine)}</div>
        <div class="confirmed">${row.confirmed}</div>${
          row.aiSources.length === 0
            ? ''
            : h`
        <div class="aisrcs"><span class="lbl">AI 補查</span>${row.aiSources.map((s) => h`<span>${ai(s.text)}<span class="aires">${s.result}</span></span>`)}</div>`
        }</div>
    </div>`;
}

function addressBody(body: Extract<Body, { kind: 'addresses' }>): Html {
  const worst = body.folded.some((r) => r.state === 'ok') ? 'ok' : 'na';
  return h`
  <div class="rows">${body.open.map(addressRow)}${
    body.folded.length === 0
      ? ''
      : h`
    <details class="fold">
      <summary>${decor('chev')}${icon(worst)}${body.folded.length === 1 ? '另外 1 個地址沒有要你看的結果' : `另外 ${body.folded.length} 個地址都沒有要你看的結果`}</summary>${body.folded.map(addressRow)}
    </details>`
  }
  </div>`;
}

function pastBody(body: Extract<Body, { kind: 'past' }>): Html {
  if (body.recordings.length === 0) return h`<p class="lead">這個操作沒有研究過去交易。</p>`;
  return h`
  <p class="lead">${text(body.same)}</p>${body.conclusion === undefined ? '' : h`
  <p class="intro">${ai(body.conclusion)}</p>`}
  <details class="fold">
  <summary>${decor('chev')}其他做法</summary>
  <p class="lead">只算用了這個操作的呼叫的交易。跟模板一模一樣，指交易的呼叫和參數位置跟模板相同，從交易本身看得出來的參數規定（例如該填送出者的地方、固定值）都成立，模板綁定 registry 合約的地方也是模板允許的合約。形狀一樣、但用的是 registry 外的市場、代幣、金庫或地址，指呼叫、參數位置和這些參數規定都一樣，但有地址或市場不在 registry 裡；種類照記錄看得出的寫，看不出就只說地址。其他的依原因分組，各附最多 3 筆例子。</p>${body.recordings.map(
    (r) => h`
  <h3>${r.count}</h3>
  <p class="lead">記錄在 <code>${r.file}</code>。${text(r.search)}</p>${r.blocks.map(
    (block) => h`
  <div class="pblock">
    <div class="ph"><span class="pt">${block.title}</span><span>${text(block.lead)}</span></div>${block.groups.map(
      (g) => h`
    <div class="pg"><span class="pc num">${g.count} 筆</span><div>${g.calls === undefined ? '' : h`<div class="pcalls">${text(g.calls)}</div>`}<div>${text(g.reason)}<span class="f3">，來自 ${g.senders} 個地址</span></div>
      <div class="pex">例：${g.examples.map((e, i) => h`${i === 0 ? '' : '、'}${text([e])}`)}</div></div></div>`,
    )}
  </div>`,
  )}${r.others.map((line) => h`
  <div class="warnline">${decor('info')}<span>${text(line)}</span></div>`)}`,
  )}
  </details>`;
}

/** A command alone in its block, so a copy takes nothing of the sentence around it. */
const command = (line: string): Html => h`<pre class="cmd"><code>${line}</code></pre>`;

function nextBody(body: Extract<Body, { kind: 'next' }>): Html {
  return h`
  <ol class="steps">${body.steps.map(
    (step) => h`
    <li><div>${text(step.say)}${step.command === undefined ? '' : command(step.command)}${step.then.map((line) => h`
      <p class="then">${text(line)}</p>`)}${step.hashes ? h`
      <div class="hash"><span>比對</span><span class="f2">domain hash 和 message hash，都是 0x 開頭 64 個字元</span></div>` : ''}</div></li>`,
  )}
  </ol>
  <div class="auto"><h3>程式每次簽名自動做的事</h3>
    <ul>${body.automatic.map((line) => h`
      <li>${decor('info')}<span>${text(line)}</span></li>`)}
    </ul>
  </div>`;
}

const ADDRESS_RULE =
  '每個地址至少要在兩個地方確認：官方頁、協議 API、CoinGecko，或金庫的登記工廠列出同一個地址。高信心：沒有要你看的結果，確認的地方有官方頁，code pin 也在鏈上確認過。中信心：沒有要你看的結果，但確認的地方沒有官方頁，或少了 code pin 的確認。低信心：有結果要你看。標「–」的是那個來源沒資料，只是不算確認，不是問題；來源下面的「網站」行標「–」，不影響那個來源算不算確認。AI 補查不改變信心等級。';

function section(s: Section): Html {
  const count =
    s.body.kind === 'wallet' ? (s.body.view.kind === 'calls' ? 'ERC-7730 描述檔' : undefined) : s.count === undefined ? undefined : s.count.kind === 'states' ? stateCounts(s.count) : `${s.count.text}${s.body.kind === 'addresses' ? ' 個' : ''}`;
  const body = (() => {
    switch (s.body.kind) {
      case 'flow':
        return flowBody(s.body.flow);
      case 'protocol':
        return protocolBody(s.body.block);
      case 'vault':
        return vaultBody(s.body.vault);
      case 'review':
        return reviewBody(s.body);
      case 'wallet':
        return walletBody(s.body);
      case 'addresses':
        return addressBody(s.body);
      case 'past':
        return pastBody(s.body);
      case 'next':
        return nextBody(s.body);
    }
  })();
  return h`
<section id="${s.anchor}">
  <h2>${s.label}${count === undefined ? '' : h` <span class="c">${count}</span>`}${s.body.kind === 'addresses' ? tip('信心等級說明', ADDRESS_RULE) : ''}</h2>${body}
</section>
`;
}

/** The whole document. Deterministic: the same Page always gives the same bytes. */
export function renderPage(page: Page): string {
  tips = 0;
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escape(page.id)} 報告</title>
<style>
${CSS}
</style>
</head>
<body>
${SYMBOLS}
<div class="wrap">
<div class="page">

<nav class="rail" aria-label="目錄">
  <h2>目錄</h2>
  ${contents(page.sections).text}
</nav>

<div class="main">

${header(page).text}
${page.sections.map((s) => section(s).text).join('')}
<footer class="foot">${text(page.footer).text}</footer>

</div>
</div>
</div>
</body>
</html>
`;
}

/**
 * The template's HTML report from the recordings and `notes.json`, or undefined when it has none. It judges every
 * recorded test transaction of the template again and takes the first as the example. Throws NotesError for notes the
 * program refuses.
 */
export async function generatedHtml(repoRoot: string, inputs: ReportInputs, title: ReportTitle): Promise<string | undefined> {
  const { subject, registry } = inputs;
  if (subject.kind !== 'template') return undefined;
  const raw = readNotes(repoRoot, subject.template.id, subject.vault);
  if (raw === undefined) return undefined;
  const { template } = subject;
  // The test transactions check the template, whichever vault they name; the example must name the report's own vault.
  const html = { ...inputs, fixtures: await judgeFixtures(repoRoot, template, loadRegistry(repoRoot)), example: firstRecordedTx(repoRoot, template, registry) };
  return renderPage(buildPage(html, raw, title));
}

/** Up to 160 characters of a line from where it first differs, quoted so no control character reaches the terminal. */
const quoted = (line: string | undefined, at: number): string => {
  if (line === undefined) return 'nothing';
  const start = Math.max(0, at - 60);
  return JSON.stringify(`${start > 0 ? '…' : ''}${line.slice(start, start + 160)}${start + 160 < line.length ? '…' : ''}`);
};

/** Where the committed HTML report differs from what the program writes, byte for byte, or undefined when it does not. */
export function htmlDifference(committed: string | undefined, written: string | undefined): string | undefined {
  if (committed === written) return undefined;
  if (committed === undefined) return `there is ${NOTES_FILE} but no committed ${GENERATED_HTML_FILE}`;
  if (written === undefined) return `${GENERATED_HTML_FILE} is committed but there is no ${NOTES_FILE} to write it from`;
  const [was, now] = [committed.split('\n'), written.split('\n')];
  const at = was.findIndex((line, i) => line !== now[i]);
  const line = at === -1 ? was.length : at;
  const [a, b] = [was[line] ?? '', now[line] ?? ''];
  let column = 0;
  while (column < a.length && a[column] === b[column]) column++;
  return `line ${line + 1}: committed ${quoted(was[line], column)}, the program writes ${quoted(now[line], column)}`;
}

export const SYMBOLS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="ok" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"/><path style="stroke:var(--bg)" d="M5 8.2l2 2 4-4.4" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="warn" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.1" r=".95" fill="currentColor"/></symbol>
  <symbol id="bad" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"/><path style="stroke:var(--bg)" d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke-width="1.7" stroke-linecap="round"/></symbol>
  <symbol id="ask" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 1.9"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></symbol>
  <symbol id="info" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".9" fill="currentColor"/></symbol>
  <symbol id="na" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 8h5.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>
  <symbol id="chev" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</svg>`;

/** docs/report-design.md as one inline stylesheet: its tokens, dark only, system fonts, no @import and no url() but a fragment. */
export const CSS = `:root{
  --bg:#0b0c0e; --sunk:#08090a; --hover:#121317; --pop:#1a1c20; --line:#212328; --line2:#30333a;
  --fg:#eceef0; --fg2:#b0b4ba; --fg3:#8a8f97;
  --ok:#4cb782; --warn:#eda152; --bad:#ec6a5e;
  --shadow:rgb(4 5 8 / .55);
  --r:6px;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang TC","Noto Sans TC","Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --t-body:16px; --t-row:15px; --t-small:14px; --t-label:13px; --t-mono:14px;
  color-scheme:dark;
  scrollbar-color:var(--line2) transparent;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
html,body{overflow-x:clip}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:var(--t-body);line-height:1.65;letter-spacing:.005em;-webkit-font-smoothing:antialiased}
::selection{background:var(--line2)}
a{color:var(--fg);text-decoration:underline;text-decoration-color:var(--line2);text-underline-offset:4px;overflow-wrap:anywhere}
a:hover{text-decoration-color:var(--fg2)}
:focus-visible{outline:2px solid var(--fg);outline-offset:2px;border-radius:2px}
code{font-family:var(--mono);font-size:var(--t-mono);color:var(--fg);border:1px solid var(--line2);border-radius:var(--r);padding:1px 6px;overflow-wrap:anywhere}
.addr{font-family:var(--mono);font-size:var(--t-mono);letter-spacing:.01em;overflow-wrap:anywhere;color:var(--fg)}
.num{font-variant-numeric:tabular-nums}
.f2{color:var(--fg2)} .f3{color:var(--fg3)}
b,strong{font-weight:590}
.wrap{max-width:1180px;margin:0 auto;padding-block:32px 120px;padding-left:max(20px,env(safe-area-inset-left,0px));padding-right:max(20px,env(safe-area-inset-right,0px))}

.i{width:16px;height:16px;flex:none;display:inline-block;vertical-align:-3px}
.i.ok{color:var(--ok)} .i.warn{color:var(--warn)} .i.bad{color:var(--bad)} .i.mute{color:var(--fg3)}

.page{display:grid;grid-template-columns:184px minmax(0,1fr);gap:0 56px;align-items:start}
.main{display:flex;flex-direction:column;gap:72px;max-width:880px;min-width:0}
.rail{position:sticky;top:32px;font-size:var(--t-small)}
.rail h2{font-size:var(--t-label);font-weight:590;color:var(--fg3);margin:0 0 10px;letter-spacing:.02em}
.rail ol{list-style:none;margin:0;padding:0;border-left:1px solid var(--line)}
.rail a{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0 6px 14px;margin-left:-1px;border-left:1px solid transparent;color:var(--fg2);text-decoration:none;line-height:1.4;overflow-wrap:anywhere}
.rail a:hover{color:var(--fg);border-left-color:var(--fg2)}
.cnt{display:inline-flex;align-items:center;gap:5px;color:var(--fg3);font-variant-numeric:tabular-nums}
.cnt .i{width:14px;height:14px}
.tocfold{display:none}
@media (max-width:1040px){
  .page{grid-template-columns:minmax(0,1fr)}
  .rail{display:none}
  .main{max-width:none}
  .tocfold{display:block;margin-top:24px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
  .tocfold>summary{cursor:pointer;list-style:none;display:flex;gap:8px;align-items:center;padding:10px 0;color:var(--fg2);font-size:var(--t-small)}
  .tocfold>summary::-webkit-details-marker{display:none}
  .tocfold[open]>summary .chev{transform:rotate(90deg)}
  .tocfold ol{list-style:none;margin:0 0 10px;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:2px 16px}
  .tocfold a{display:flex;justify-content:space-between;gap:8px;padding:6px 0;color:var(--fg2);text-decoration:none;font-size:var(--t-small)}
}

h1{font-size:30px;line-height:1.25;font-weight:590;letter-spacing:-.02em;margin:0;overflow-wrap:break-word}
h1 .byai{vertical-align:6px;margin-left:12px}
.opid{display:block;font-family:var(--mono);font-size:var(--t-label);color:var(--fg3);margin-top:8px}
.sub{color:var(--fg2);margin:14px 0 0;max-width:60ch;font-size:17px}
.sub .byai,.intro .byai,.rec .byai,.verdict .byai,.row .t .byai,.role .byai,.props dd .byai{margin-left:8px}
.checks{list-style:none;margin:28px 0 0;padding:14px 0;display:flex;flex-wrap:wrap;gap:10px 28px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.checks li{display:inline-flex;align-items:center;gap:8px;font-size:var(--t-row);position:relative}
.checks .n{color:var(--fg2)}
@media (max-width:600px){.checks{flex-direction:column}}
.verdict{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-top:18px;font-size:var(--t-row)}
.verdict .lbl{color:var(--fg3);flex:none}
.verdict .i{align-self:center}
.verdict .aiw>span:first-child{flex:1 1 14em}
section{scroll-margin-top:24px}

.byai{display:inline-block;font-size:12px;color:var(--fg2);border:1px dashed var(--fg3);border-radius:var(--r);padding:0 6px;line-height:20px;white-space:nowrap;font-weight:400;letter-spacing:0}
.aiw{display:contents}
.aisrc{color:var(--fg2);font-size:var(--t-small)}

.tip{position:relative;display:inline-flex;cursor:help;color:var(--fg3)}
.tip:hover,.tip:focus-visible{color:var(--fg)}
.tip .bub{position:absolute;left:-8px;top:calc(100% + 8px);width:max-content;max-width:min(320px,calc(100vw - 48px));background:var(--pop);border:1px solid var(--line2);color:var(--fg);font-size:var(--t-small);line-height:1.55;padding:9px 12px;border-radius:var(--r);box-shadow:0 6px 14px var(--shadow);opacity:0;visibility:hidden;transition:opacity .12s ease-out,visibility 0s linear .12s;z-index:5;pointer-events:none;font-weight:400;letter-spacing:0}
.tip:hover .bub{opacity:1;visibility:visible;transition:opacity .12s ease-out .25s,visibility 0s linear .25s}
.tip:focus-visible .bub{opacity:1;visibility:visible;transition:none}
@media (min-width:601px){.checks li:nth-last-child(-n+2) .bub{left:auto;right:-8px}}
@media (max-width:600px){.tip{position:static}.tip .bub{left:0;max-width:calc(100vw - 40px)}}

section{border-top:1px solid var(--line2);padding-top:28px}
section>h2 .tip{align-self:center}
section>h2{font-size:22px;font-weight:590;letter-spacing:-.012em;margin:0 0 8px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
section>h2 .c{font-weight:400;font-size:var(--t-small);color:var(--fg3);letter-spacing:0}
.lead{color:var(--fg3);font-size:var(--t-small);margin:0 0 20px}
.lead.keylead{margin-top:12px}
.intro{color:var(--fg2);margin:0 0 20px;max-width:62ch}
h3{font-size:16px;font-weight:590;margin:36px 0 10px}

.props{margin:0;font-size:var(--t-row);border-top:1px solid var(--line)}
.props>div{display:grid;grid-template-columns:minmax(140px,24%) minmax(0,1fr) auto;gap:0 20px;padding:11px 0;border-bottom:1px solid var(--line);align-items:baseline}
.props dt,.props dd{margin:0}
.props dt{color:var(--fg2)}
.props dd.src{text-align:right;font-size:var(--t-small);color:var(--fg3)}
.props .sub2{display:block;font-size:var(--t-small);color:var(--fg3);margin-top:2px}
.props .pos{color:var(--ok)}
@media (max-width:600px){.props>div{grid-template-columns:minmax(0,1fr) auto}.props dt{grid-column:1/-1}}
.props.two>div{grid-template-columns:minmax(140px,24%) minmax(0,1fr)}
.nest{margin:10px 0 0;border-left:1px solid var(--line2);padding-left:16px}
.nest.flat{margin-top:0}
.nest{display:grid;grid-template-columns:minmax(96px,max-content) minmax(0,1fr);gap:0 16px}
.nest>div{display:contents}
.nest dt,.nest dd{padding:5px 0}
.nest dt{color:var(--fg2)}
.srcline{font-size:var(--t-small);color:var(--fg3);margin:12px 0 0}
.srcline a{color:var(--fg2)}
@media (max-width:600px){.props.two>div{grid-template-columns:minmax(0,1fr)}.nest{grid-template-columns:minmax(0,1fr)}.nest dd{padding-top:0}}

.diagram{overflow-x:auto;border:1px solid var(--line);border-radius:var(--r);background:var(--sunk)}
.diagram svg{display:block;width:100%;min-width:660px;height:auto}
svg .life{stroke:var(--line2);stroke-dasharray:2 4}
svg .node{fill:var(--hover);stroke:var(--line2)}
svg .nodet{fill:var(--fg);font:590 14px var(--sans)}
svg .nodes{fill:var(--fg3);font:12.5px var(--sans)}
svg .call{stroke:var(--fg);stroke-width:1.4;fill:none}
svg .inner{stroke:var(--fg3);stroke-width:1.2;stroke-dasharray:4 4;fill:none}
svg .gain{stroke:var(--ok);stroke-width:1.4;fill:none}
svg .ah{fill:var(--fg)} svg .ahi{fill:var(--fg3)} svg .ahg{fill:var(--ok)}
svg .fn{fill:var(--fg);font:400 14px var(--mono)}
svg .no{fill:var(--fg3);font:400 14px var(--mono)}
svg .cap{fill:var(--fg2);font:14px var(--sans)}
svg .capc{fill:var(--fg);font:13px var(--mono)}
svg .codebox{fill:var(--hover);stroke:var(--line2)}
svg .capg{fill:var(--ok);font:590 14px var(--sans)}
svg .tagbox{fill:none;stroke:var(--fg3);stroke-dasharray:3 2}
svg .tagt{fill:var(--fg2);font:12px var(--sans)}
svg .bar{fill:var(--line2)} svg .bar.last{fill:var(--fg2)}
svg .barna{fill:none;stroke:var(--fg3);stroke-dasharray:3 3}
svg .axis{stroke:var(--line2)}
svg .tick{fill:var(--fg3);font:12px var(--sans)}
.scrollhint{display:none;font-size:var(--t-label);color:var(--fg3);margin-top:6px}
@media (max-width:700px){.scrollhint{display:block}}

.key{display:flex;flex-wrap:wrap;gap:8px 22px;align-items:center;margin:36px 0 0;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:var(--t-small);color:var(--fg3)}
.key>span{display:inline-flex;gap:8px;align-items:center}
.key .k0{color:var(--fg3);font-weight:590}
.cb{margin-top:40px}
.callh{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--line2)}
.callh .no{font-family:var(--mono);color:var(--fg3);font-size:var(--t-row)}
.callh .fnn{font-family:var(--mono);font-size:16px;font-weight:590;overflow-wrap:anywhere}
.callh .fnn .ct{color:var(--fg2);font-weight:400}
.callh .sel{font-family:var(--mono);font-size:var(--t-label);color:var(--fg3)}
.callh .what{font-size:16px;font-weight:590}
.sends{font-size:var(--t-row);color:var(--fg2);padding:10px 0;border-bottom:1px solid var(--line)}
.arg{display:grid;grid-template-columns:200px minmax(0,1fr);gap:4px 24px;padding:16px 0;border-bottom:1px solid var(--line)}
.arg .nm{display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-width:0}
.arg .pn{font-family:var(--mono);font-size:var(--t-mono);color:var(--fg);overflow-wrap:anywhere}
.arg .val{min-width:0}
.arg .mid{margin-top:6px;font-size:var(--t-small);color:var(--fg3)}
.arg .mid .addr{font-size:13px;color:var(--fg2)}
.arg .raw{font-family:var(--mono);font-size:var(--t-mono);color:var(--fg);overflow-wrap:anywhere;line-height:1.5}
.arg .raw .ex{font-family:var(--sans);font-size:12px;color:var(--fg3);margin-left:8px}
.arg .is{color:var(--fg);font-size:var(--t-row);margin-top:4px}
.arg .is .f3{font-size:var(--t-small)}
.arg .ai{display:flex;gap:10px;align-items:baseline;margin-top:8px;font-size:var(--t-small);color:var(--fg2);line-height:1.6}
.arg .ai .byai{flex:none}
.who{display:inline-flex;align-items:center;font-size:var(--t-label);line-height:22px;padding:0 8px;border-radius:var(--r);border:1px solid var(--line2);color:var(--fg3);white-space:nowrap}
.who.you{color:var(--fg);border-color:var(--fg2);font-weight:590}
.who.app{color:var(--warn);border-color:rgb(237 161 82 / .45)}
.parts{grid-column:2;margin-top:12px;border-left:1px solid var(--line2);padding-left:16px}
.plabel{font-size:var(--t-small);color:var(--fg2);padding:2px 0 8px}
.part{display:grid;grid-template-columns:132px minmax(0,1fr);gap:2px 16px;padding:10px 0;border-top:1px solid var(--line)}
.part:first-child,.plabel+.part{border-top:0;padding-top:2px}
.part .pn{font-family:var(--mono);font-size:var(--t-small);color:var(--fg2);overflow-wrap:anywhere}
.part .pchips{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:6px;font-family:var(--sans)}
.part .pchips .who{max-width:100%;white-space:normal;overflow-wrap:anywhere}
.part .raw{font-size:var(--t-small)}
.part .is{font-size:var(--t-small)}
.part .ai{margin-top:4px}
.part>.parts{grid-column:1/-1}
@media (max-width:720px){
  .arg{grid-template-columns:minmax(0,1fr)}
  .arg .nm{flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap}
  .parts{grid-column:1}
  .part{grid-template-columns:minmax(0,1fr)}
}

.rows{border-top:1px solid var(--line)}
.row{display:grid;grid-template-columns:22px minmax(0,1fr);gap:12px;padding:16px 8px 16px 0;border-bottom:1px solid var(--line)}
.row:hover,.ad:hover{background:var(--hover)}
.row .i{margin-top:4px}
.row .t{font-weight:590;font-size:var(--t-body)}
.row .meta{font-size:var(--t-row);color:var(--fg2);margin-top:6px}
.row .meta a{margin-left:8px;color:var(--fg2)}
.row .rec{font-size:var(--t-row);margin-top:8px}
.row .rec .lbl{color:var(--fg3);margin-right:8px}

.ad{scroll-margin-top:24px;display:grid;grid-template-columns:22px minmax(0,1fr);gap:4px 12px;padding:16px 8px 16px 0;border-bottom:1px solid var(--line)}
.ad .i{margin-top:4px}
.ad .nm{font-weight:590}
.ad .role{color:var(--fg3);font-size:var(--t-small);margin-left:10px}
.ad .conf{margin-left:10px}
.ad .reviewed{margin-left:10px;color:var(--fg2)}
.ad .body{grid-column:2;display:flex;flex-direction:column;gap:8px}
.srcs{display:flex;flex-direction:column;gap:6px;font-size:var(--t-row)}
.src{display:flex;flex-direction:column;gap:4px}
.site{display:flex;gap:6px;align-items:flex-start;padding-left:16px;font-size:var(--t-small);color:var(--fg2)}
.ad .site .i{width:14px;height:14px;margin-top:3px;flex:none}
.aisrcs{display:flex;flex-direction:column;gap:6px;font-size:var(--t-row);padding-top:8px;border-top:1px solid var(--line)}
.aisrcs .lbl{font-size:var(--t-small);color:var(--fg3)}
.aisrcs .byai{margin-right:8px}
.aires{margin-left:8px;font-size:var(--t-small);color:var(--fg3)}
.res{display:inline-flex;gap:6px;align-items:center;margin-left:8px;color:var(--fg2)}
.res .i{width:14px;height:14px}
.confirmed{font-size:var(--t-small);color:var(--fg2)}
details.fold{border-bottom:1px solid var(--line)}
details.fold>summary{cursor:pointer;list-style:none;display:flex;gap:10px;align-items:center;padding:14px 0;color:var(--fg2);font-size:var(--t-row)}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary:hover{color:var(--fg)}
.chev{color:var(--fg3);transition:transform .15s ease-out}
details.fold[open]>summary .chev{transform:rotate(90deg)}
details.fold .ad:last-child{border-bottom:0}

.warnline{display:flex;gap:10px;font-size:var(--t-row);color:var(--fg2);margin-top:14px}
.pblock{border-top:1px solid var(--line);margin-top:16px}
.ph{display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;padding:12px 0;border-bottom:1px solid var(--line);font-size:var(--t-row)}
.ph .pt{font-weight:590;min-width:9em}
.pg{display:grid;grid-template-columns:72px minmax(0,1fr);gap:4px 12px;padding:12px 0 12px 16px;border-bottom:1px solid var(--line);font-size:var(--t-row);color:var(--fg2)}
.pg .pc{color:var(--fg)}
.pg .pcalls{margin-bottom:4px}
.pg .pex{font-size:var(--t-small);margin-top:4px}
.pg .pex a{color:var(--fg3);font-family:var(--mono)}
@media (max-width:600px){.pg{grid-template-columns:minmax(0,1fr);padding-left:0}}
.warnline .i{margin-top:4px;color:var(--fg3)}

ol.steps{list-style:none;margin:0;padding:0;counter-reset:s;border-top:1px solid var(--line)}
ol.steps>li{display:grid;grid-template-columns:32px minmax(0,1fr);padding:14px 0;border-bottom:1px solid var(--line);counter-increment:s}
ol.steps>li::before{content:counter(s) ".";font-family:var(--mono);color:var(--fg3);font-size:var(--t-row)}
.cmd{margin:10px 0 0;padding:10px 12px;background:var(--sunk);border:1px solid var(--line2);border-radius:var(--r);overflow-x:auto}
.cmd code{border:0;padding:0;white-space:pre}
.then{margin:8px 0 0;font-size:var(--t-row);color:var(--fg2)}
.hash{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 16px;font-size:var(--t-row);margin-top:10px}
.hash span:nth-child(odd){color:var(--fg3)}
.auto ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;font-size:var(--t-row);color:var(--fg2)}
.auto li{display:flex;gap:10px;align-items:baseline}
.auto li .i{width:14px;height:14px;color:var(--fg3);align-self:center}
.foot{font-size:var(--t-small);color:var(--fg3);max-width:70ch;border-top:1px solid var(--line);padding-top:16px}
.foot code{border:0;padding:0;font-size:13px;color:var(--fg2)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}html{scroll-behavior:auto}}`;
