import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HTML_LANG, LANGUAGES } from '../language.ts';
import type { Language } from '../language.ts';
import { firstRecordedTx } from '../template/perturb.ts';
import type { State } from './ledger.ts';
import { NOTES_FILE, codeSpans, notesLanguages, readNotes } from './notes.ts';
import { buildPage } from './report-page.ts';
import type { AddressRow, AiText, ArgRow, Arrow, Body, CallBlock, Chip, DocLine, Flow, Inline, NewestResult, Page, ProtocolBlock, RailCount, Section, Sequence, SiteResult, SourceLine, VaultBlock, WalletRows } from './report-page.ts';
import { CSS, Html, SYMBOLS, escape, h, icon } from '../html.ts';
import { WORDS } from './report-words.ts';
import type { Words } from './report-words.ts';
import { reportDir } from './report.ts';
import type { ReportInputs, ReportTitle, TemplateTarget } from './report.ts';

/** Each language's HTML report beside report.generated.md; the name says the language, so no file changes language under an old name. */
export const generatedHtmlFile = (language: Language): string => `report.generated.${language}.html`;
export const generatedHtmlPath = (repoRoot: string, target: TemplateTarget, language: Language): string => join(reportDir(repoRoot, target), generatedHtmlFile(language));
/** The one-language report the program wrote before it wrote one per language; none may remain. */
export const OLD_HTML_FILE = 'report.generated.html';

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

/** Words around one code span: `[before, after]` with the code between them. */
const around = ([before, after]: readonly [string, string], code: string): Html => h`${before}<code>${code}</code>${after}`;

/** AI text's parts: plain text, and each code span the parser let through as one identifier. */
const aiParts = (text: string): { readonly text: string; readonly code: boolean }[] => (codeSpans(text) ?? [text]).map((part, i) => ({ text: part, code: i % 2 === 1 }));

const aiProse = (text: string): Html => h`${aiParts(text).map((part) => (part.code ? h`<code>${part.text}</code>` : part.text))}`;

/** The renderer's state for one page: its words and its language. */
type R = { readonly w: Words; readonly language: Language };

/** The only way AI text reaches the page: escaped, with its sources linked and its dashed tag. */
function ai(note: AiText, r: R): Html {
  const sources = note.sources.map((url, i) => h` <a class="aisrc" href="${url}">${r.w.sourceLink(note.sources.length > 1 ? i + 1 : undefined)}</a>`);
  const tag = h`<span class="byai">${r.w.tag[note.tag]}</span>`;
  return note.tag === 'ai' ? h`<span class="aiw" data-ai>${tag}<span>${aiProse(note.ai)}${sources}</span></span>` : h`<span class="aiw" data-ai><span>${aiProse(note.ai)}${sources}</span>${tag}</span>`;
}

let tips = 0;
const tip = (label: string, body: string): Html => {
  tips += 1;
  return h`<span class="tip" tabindex="0" aria-label="${label}" aria-describedby="t${tips}">${decor('info')}<span class="bub" id="t${tips}" role="tooltip">${body}</span></span>`;
};

const stateCounts = (count: Extract<RailCount, { kind: 'states' }>, r: R): Html =>
  h`${count.counts.map((c) => h` <span class="cnt" data-state="${c.state}">${icon(c.state, r.language)}${c.grade === undefined ? '' : `${r.w.grade[c.grade]} `}${c.n}</span>`)}`;

const railCount = (count: RailCount | undefined, r: R): Html => (count === undefined ? h`` : count.kind === 'text' ? h` <span class="cnt">${count.text}</span>` : stateCounts(count, r));

const contents = (sections: readonly Section[], r: R): Html => h`<ol>${sections.map((s) => h`<li><a href="#${s.anchor}">${s.label}${railCount(s.count, r)}</a></li>`)}</ol>`;

function header(page: Page, r: R): Html {
  const { header: head, sections } = page;
  return h`<header>
  <h1>${ai(head.title, r)}</h1>
  <span class="opid">${page.id}</span>
  <p class="sub">${ai(head.summary, r)}</p>${head.onlyIn === undefined ? '' : h`
  <p class="srcline">${head.onlyIn}</p>`}
  <ul class="checks">${head.strip.map(
    (item) => h`
    <li data-state="${item.state}" data-line="${item.line}">${icon(item.state, r.language)}${item.name}${item.count === undefined ? '' : h` <span class="n num">${item.count}</span>`}
      ${tip(r.w.explain, item.explain)}</li>`,
  )}
  </ul>
  <div class="verdict" data-state="${head.verdict.state}"><span class="lbl">${r.w.advice}</span>${icon(head.verdict.state, r.language)}${ai(head.verdict.text, r)}</div>
  <details class="tocfold"><summary>${decor('chev')}${r.w.contents}</summary>
    ${contents(sections, r)}
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

function diagram(sequence: Sequence, r: R): Html {
  const x = (i: number) => FIRST_X + i * SPACING;
  // The tag's box fits its word: 12px text is narrower than textWidth's 14px estimate, which leaves the margin.
  const tagWidth = (tag: string) => Math.max(AI_TAG_WIDTH, Math.ceil(textWidth(tag)));
  const captionWidth = (arrow: Extract<Arrow, { kind: 'inside' }>) => tagWidth(r.w.tag[arrow.text.tag]) + 8 + caption(arrow.text.ai, 0, 0).width;
  const seenText = (seen: NonNullable<Extract<Arrow, { kind: 'inside' }>['seen']>) => (seen.confirmed ? r.w.seenLabel(seen.seen, seen.of) : r.w.seenCount(seen.seen, seen.of));
  const seenWidth = (arrow: Extract<Arrow, { kind: 'inside' }>) => (arrow.seen === undefined ? 0 : textWidth(seenText(arrow.seen)) * 0.9);
  const widest = Math.max(0, ...sequence.arrows.map((arrow) => (arrow.kind === 'inside' ? x(0) + 12 + Math.max(captionWidth(arrow), seenWidth(arrow)) + 8 : 0)));
  const width = Math.max(660, x(sequence.lifelines.length - 1) + FIRST_X, Math.ceil(widest));
  const rows: Html[] = [];
  let y = NODE_TOP + NODE_HEIGHT + 32;
  for (const arrow of sequence.arrows) {
    if (arrow.kind === 'call' && arrow.to === 0) {
      rows.push(h`
    <text class="no" x="${x(0) + 12}" y="${y}">${arrow.n}</text><text class="fn" x="${x(0) + 30}" y="${y}">${arrow.fn}</text>
    <path class="call" d="M${x(0)} ${y + 14}h${SELF_LOOP}v${SELF_LOOP / 4}h${3 - SELF_LOOP}" marker-end="url(#head)"/>`);
      y += 52 + SELF_LOOP / 4;
    } else if (arrow.kind === 'call') {
      rows.push(h`
    <text class="no" x="${x(0) + 12}" y="${y}">${arrow.n}</text><text class="fn" x="${x(0) + 30}" y="${y}">${arrow.fn}</text>
    <line class="call" x1="${x(0)}" y1="${y + 14}" x2="${x(arrow.to) - 3}" y2="${y + 14}" marker-end="url(#head)"/>`);
      y += 52;
    } else if (arrow.kind === 'nested') {
      const [from, to] = [x(arrow.from), arrow.to === arrow.from ? x(arrow.from) + 60 : x(arrow.to)];
      rows.push(h`
    <text class="fn" x="${Math.min(from, to) + 12}" y="${y}">${arrow.fn}</text>
    <line class="nested" x1="${from}" y1="${y + 10}" x2="${to + (to > from ? -3 : 3)}" y2="${y + 10}" marker-end="url(#head)"/>`);
      y += 36;
    } else if (arrow.kind === 'inside') {
      const tag = r.w.tag[arrow.text.tag];
      const tagged = tagWidth(tag);
      const [from, to] = [x(arrow.from), arrow.to === arrow.from ? x(arrow.from) + 60 : x(arrow.to)];
      const left = Math.max(x(0) + 12, Math.min(Math.min(from, to) + 12, width - 8 - captionWidth(arrow)));
      const cap = caption(arrow.text.ai, left + tagged + 8, y);
      const seen = arrow.seen === undefined ? undefined : seenText(arrow.seen);
      const source = arrow.seen?.confirmed === true ? arrow.text.sources[0] : undefined;
      rows.push(h`
    <g data-ai><rect class="tagbox" x="${left}" y="${y - 14}" width="${tagged}" height="20" rx="6"/><text class="tagt" x="${left + tagged / 2}" y="${y}" text-anchor="middle">${tag}</text>${cap.boxes}${cap.text}</g>
    <line class="${arrow.seen?.confirmed === true ? 'inner seen' : 'inner'}" x1="${from}" y1="${y + 10}" x2="${to + (to > from ? -3 : 3)}" y2="${y + 10}" marker-end="url(#head)"/>${
      seen === undefined
        ? ''
        : h`
    <text class="seenl" x="${left}" y="${y + 30}">${source === undefined ? seen : h`<a href="${source}">${seen}</a>`}</text>`
    }`);
      y += seen === undefined ? 36 : 56;
    } else {
      rows.push(h`
    <text class="capg" x="${x(0) + 14}" y="${y}">${arrow.text}</text>
    <line class="gain" x1="${x(arrow.from)}" y1="${y + 10}" x2="${x(0) + 3}" y2="${y + 10}" marker-end="url(#head)"/>`);
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
  return h`<div class="diagram">
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="dt dd">
    <title id="dt">${r.w.diagramTitle}</title>
    <desc id="dd">${sequence.narration}</desc>
    <defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path class="ah" d="M0 0L10 5L0 10z"/></marker></defs>${nodes}${rows}
  </svg>
  </div>
  <div class="scrollhint">${r.w.scrollHint}</div>`;
}

const CHIP_CLASS: Readonly<Record<Chip['who'], string>> = { 'you-type': 'who you', 'you-pick': 'who you', computed: 'who', fixed: 'who', free: 'who app', bounded: 'who app' };
const chip = (c: Chip): Html => h`<span class="${CHIP_CLASS[c.who]}">${c.label}</span>`;

const docLine = (doc: DocLine, r: R): Html =>
  h`<div class="doc" data-state="${doc.state}"><span class="f3">${r.w.docs}</span><a href="${doc.href}">${doc.label}</a><span class="res">${icon(doc.state, r.language)}${doc.phrase === undefined ? '' : r.w.phrase[doc.phrase]}</span>${
    doc.note === undefined ? '' : h` <span class="f3">${doc.note}</span>`
  }</div>`;

function valueLines(row: ArgRow, r: R): Html {
  return h`${row.value === undefined ? '' : h`<div class="raw">${row.value.cast}${row.value.example === undefined ? '' : h`<span class="ex">${r.w.example[row.value.example]}</span>`}</div>`}<div class="is">${text(row.words)}${
    row.qualifier === undefined ? '' : h` <span class="f3">${text(row.qualifier)}</span>`
  }</div>${row.doc === undefined ? '' : docLine(row.doc, r)}${row.id === undefined ? '' : h`<div class="mid">${text(row.id)}</div>`}${row.ai === undefined ? '' : h`
        <div class="ai">${ai(row.ai, r)}</div>`}`;
}

function partsOf(row: ArgRow, r: R): Html {
  return h`${row.parts.map(
    (group) => h`
      <div class="parts">${group.label === undefined ? '' : h`<div class="plabel">${text(group.label)}</div>`}${group.rows.map(
        (p) => h`
        <div class="part"><div class="pn">${p.name}${p.chips.length === 0 ? '' : h`<div class="pchips">${p.chips.map(chip)}</div>`}</div><div>${valueLines(p, r)}</div>${partsOf(p, r)}</div>`,
      )}
      </div>`,
  )}`;
}

function argRow(row: ArgRow, r: R): Html {
  return h`
    <div class="arg" data-field="${row.key}">
      <div class="nm"><span class="pn">${row.name}</span>${row.chips.map(chip)}</div>
      <div class="val">${valueLines(row, r)}</div>${partsOf(row, r)}
    </div>`;
}

function callHead(call: CallBlock): Html {
  const { head } = call;
  return head.kind === 'fn'
    ? h`<span class="fnn"><span class="ct">${head.contract}.</span>${head.fn}</span><span class="sel">${head.selector}</span>`
    : h`<span class="what">${head.text}</span>`;
}

function flowBody(flow: Flow, r: R): Html {
  const lead = [flow.decoded ? around(r.w.decodedLead, 'cast decode-calldata') : undefined, flow.example === undefined ? undefined : text(flow.example)].filter((part) => part !== undefined);
  return h`
  <p class="lead">${r.w.flowLead}</p>
  ${diagram(flow.diagram, r)}${flow.diagram.traced ? h`
  <p class="lead">${r.w.traceNote}</p>` : ''}${
    flow.key.length === 0
      ? ''
      : h`
  <div class="key">
    <span class="k0">${r.w.whoDecides}</span>${flow.key.map((item) => h`
    <span>${chip(item)}${item.means}</span>`)}
  </div>`
  }${lead.length === 0 ? '' : h`
  <p class="lead keylead">${lead.flatMap((part, i) => (i === 0 ? [part] : [r.w.sentenceGap, part]))}</p>`}${
    flow.safeTx.length === 0
      ? ''
      : h`
  <div class="cb">
    <div class="callh"><span class="what">${r.w.safeTx}</span></div>${flow.safeTx.map((row) => argRow(row, r))}
  </div>`
  }
  ${flow.calls.map(
    (call) => h`
  <div class="cb">
    <div class="callh"><span class="no">${call.n}</span>${callHead(call)}</div>${call.head.kind === 'fn' ? h`<div class="cdoc">${docLine(call.head.doc, r)}</div>` : ''}${
      call.sends === undefined ? '' : h`<div class="sends">${text(call.sends)}</div>`
    }${call.args.map((row) => argRow(row, r))}
  </div>`,
  )}
  <h3>${r.w.afterTx}</h3>${
    flow.after.length === 0
      ? h`
  <p class="lead">${r.w.noAssets}</p>`
      : h`
  <dl class="props">${flow.after.map((row) => h`
    <div><dt>${text(row.label)}</dt><dd class="${row.gains ? 'pos' : ''}">${text(row.value)}</dd><dd class="src">${text(row.note)}${row.ai === undefined ? '' : h` ${ai(row.ai, r)}`}</dd></div>`)}
  </dl>`
  }`;
}

function protocolBody(block: ProtocolBlock, r: R): Html {
  return h`
  <p class="intro">${ai(block.intro, r)}</p>
  <dl class="props two">${block.rows.map(
    (row) => h`
    <div><dt>${row.label}</dt><dd>${row.value.length === 0 ? '' : h`<span>${text(row.value)}</span>`}${row.ai === undefined ? '' : ai(row.ai, r)}${row.sub === undefined ? '' : h`<span class="sub2">${text(row.sub)}</span>`}${
      row.nested.length === 0
        ? ''
        : h`
      <dl class="nest">${row.nested.map((n) => h`
        <div><dt>${text(n.label)}</dt><dd>${text(n.value)}${n.ai === undefined ? '' : h`<span class="sub2">${ai(n.ai, r)}</span>`}</dd></div>`)}
      </dl>`
    }</dd></div>`,
  )}
  </dl>
  <p class="srcline">${r.w.readSources(block.read)}${block.sources.map((s, i) => h`${r.w.sourcesJoin(i, block.sources.length)}${s.href === undefined ? s.label : h`<a href="${s.href}">${s.label}</a>`}`)}${r.w.sourcesEnd}</p>`;
}

const CHART_WIDTH = 660;
const CHART_TOP = 34;
const CHART_BASE = 150;
const CHART_SIDE = 16;

/** The monthly `totalAssets()` readings as bars, oldest first: each titled with its date and amount, a month with no amount a dashed stub. */
function chart(block: VaultBlock, r: R): Html {
  const step = (CHART_WIDTH - 2 * CHART_SIDE) / Math.max(1, block.bars.length);
  const bars = block.bars.map((bar, i) => {
    const x = CHART_SIDE + i * step + step * 0.2;
    const w = step * 0.6;
    const height = bar.share === undefined ? 0 : Math.max(1, Math.round(bar.share * (CHART_BASE - CHART_TOP)));
    const title = r.w.barTitle(bar.date, bar.words);
    const mark =
      bar.share === undefined
        ? h`<rect class="barna" x="${x.toFixed(1)}" y="${CHART_BASE - 12}" width="${w.toFixed(1)}" height="12"><title>${title}</title></rect>`
        : h`<rect class="bar${i === block.bars.length - 1 ? ' last' : ''}" x="${x.toFixed(1)}" y="${CHART_BASE - height}" width="${w.toFixed(1)}" height="${height}"><title>${title}</title></rect>`;
    const [year, month] = bar.date.split('-');
    const first = i === 0 || month === '01';
    return h`
    ${mark}<text class="tick" x="${(x + w / 2).toFixed(1)}" y="${CHART_BASE + 18}" text-anchor="middle">${month === undefined ? '?' : r.w.month(Number(month))}</text>${
      first && year !== undefined && month !== undefined ? h`<text class="tick" x="${(x + w / 2).toFixed(1)}" y="${CHART_BASE + 34}" text-anchor="middle">${year}</text>` : ''
    }`;
  });
  const span = block.bars.length === 0 ? '' : r.w.chartSpan(`${block.bars[0]?.date}`, `${block.bars.at(-1)?.date}`);
  const most = block.most ?? r.w.notRead;
  return h`<div class="diagram">
  <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_BASE + 44}" role="img" aria-labelledby="vt vd">
    <title id="vt">${r.w.monthly}</title>
    <desc id="vd">${r.w.chartDesc(block.bars.length, span, most)}</desc>
    <text class="tick" x="${CHART_SIDE}" y="18">${r.w.highest(most)}</text>
    <line class="axis" x1="${CHART_SIDE}" y1="${CHART_BASE}" x2="${CHART_WIDTH - CHART_SIDE}" y2="${CHART_BASE}"/>${bars}
  </svg>
  </div>
  <div class="scrollhint">${r.w.scrollHint}</div>`;
}

function vaultBody(block: VaultBlock, r: R): Html {
  return h`
  <p class="lead">${text(block.lead)}</p>${
    block.rows.length === 0
      ? ''
      : h`
  <dl class="props">${block.rows.map((row) => h`
    <div><dt>${row.label}</dt><dd>${text(row.value)}</dd><dd class="src">${text(row.note)}</dd></div>`)}
  </dl>
  <h3>${r.w.monthly}</h3>
  ${chart(block, r)}
  <details class="fold">
    <summary>${decor('chev')}${r.w.monthsFigures(block.bars.length)}</summary>
    <dl class="props">${block.bars.map((bar) => h`
      <div><dt class="num">${bar.date}</dt><dd class="num">${bar.words}</dd></div>`)}
    </dl>
  </details>`
  }`;
}

function reviewBody(body: Extract<Body, { kind: 'review' }>, r: R): Html {
  const empty = body.rows.length === 0 && body.judgments.length === 0;
  return h`
  <p class="lead">${empty ? r.w.nothingToReview : r.w.reviewLead}</p>
  <div class="rows">${body.rows.map(
    (row) => h`
    <div class="row" data-state="${row.state}" data-grade="${row.grade}" data-result="${row.id}">
      ${icon(row.state, r.language)}
      <div><div class="t"><span class="lbl">${r.w.grade[row.grade]}</span> ${text(row.title)}</div>
        <div class="meta">${text(row.why)}${row.entry === undefined ? '' : h`<a href="#${row.entry}">${r.w.seeSource}</a>`}</div>
        <div class="rec"><span class="lbl">${r.w.reviewed[row.review.status]}</span>${ai(row.review.text, r)}</div>
        <div class="rec"><span class="lbl">${r.w.advice}</span>${ai(row.review.recommendation, r)}</div></div>
    </div>`,
  )}${body.judgments.map(
    (j) => h`
    <div class="row">
      ${icon('ask', r.language)}
      <div><div class="t">${ai(j.text, r)}</div>
        <div class="rec"><span class="lbl">${r.w.advice}</span>${ai(j.recommendation, r)}</div></div>
    </div>`,
  )}
  </div>`;
}

function walletBody({ view }: Extract<Body, { kind: 'wallet' }>, r: R): Html {
  const row = (title: Html, rows: WalletRows) => h`
    <div><dt>${title}</dt>${
      rows === 'no-descriptor'
        ? h`<dd class="f3">${r.w.noDescriptor}</dd>`
        : h`<dd>
      <dl class="nest flat">${rows.map((one) => h`
        <div><dt>${text(one.label)}</dt><dd>${text(one.value)}</dd></div>`)}
      </dl></dd>`
    }</div>`;
  const calls = view.kind === 'calls' ? view.calls : [];
  const described = [view.safeTx, ...calls.map((call) => call.rows)].some((rows) => rows !== 'no-descriptor');
  const lead =
    view.kind === 'multisend'
      ? h`${around(r.w.multisendLead(view.calls), 'verify')}`
      : view.kind === 'no-data'
        ? h`${r.w.noDataLead}`
        : h`${r.w.walletLead}${described ? r.w.walletRules : ''}`;
  return h`
  <p class="lead">${lead}</p>
  <dl class="props two">${row(h`${r.w.safeTxTitle}`, view.safeTx)}${calls.map((call) => row(text(call.title), call.rows))}
  </dl>${view.lines.map((line) => h`
  <div class="warnline">${decor('info')}<span>${text(line)}</span></div>`)}`;
}

function siteLine(site: SiteResult, r: R): Html {
  const places = site.places.map((place, i) => h`${i === 0 ? '' : r.w.sep}${place.href === undefined ? place.word : h`<a href="${place.href}">${place.word}</a>`}`);
  const [open, close] = r.w.compared;
  return h`<span class="site" data-state="${site.state}">${icon(site.state, r.language)}<span>${
    site.state === 'ok' ? r.w.siteOk(site.slug) : r.w.siteNot(site.phrase === undefined ? '' : r.w.phrase[site.phrase])
  }${open}${places}${close}</span></span>`;
}

function newestLine(newest: NewestResult, r: R): Html {
  return h`<span class="site" data-state="${newest.state}">${icon(newest.state, r.language)}<span>${
    newest.state === 'ok'
      ? r.w.newestOk(newest.where)
      : newest.others.length > 0
        ? r.w.newestOther(newest.where, newest.others)
        : r.w.newestNot(newest.where, newest.phrase === undefined ? '' : r.w.phrase[newest.phrase])
  }</span></span>`;
}

function sourceLine(line: SourceLine, r: R): Html {
  return h`<div class="src"><span data-state="${line.state}">${line.href === undefined ? line.label : h`<a href="${line.href}">${line.label}</a>`}<span class="res">${icon(line.state, r.language)}${
    line.others.length > 0 ? r.w.labelOther(line.others) : line.phrase === undefined ? '' : r.w.phrase[line.phrase]
  }</span></span>${line.site === undefined ? '' : siteLine(line.site, r)}${line.newest === undefined ? '' : newestLine(line.newest, r)}</div>`;
}

function addressRow(row: AddressRow, r: R): Html {
  return h`
    <div class="ad" id="${row.anchor}" data-state="${row.state}">
      ${icon(row.state, r.language)}
      <div><span class="nm">${row.name}</span><span class="role">${row.role === undefined ? '' : ai(row.role, r)}<span class="conf">${r.w.confidence[row.confidence]}</span>${
        row.reviewed === undefined ? '' : h`<span class="reviewed">${r.w.reviewed[row.reviewed]}</span>`
      }</span></div>
      <div class="body"><span class="addr">${row.address}</span>
        <div class="srcs">${row.sources.map((line) => sourceLine(line, r))}</div>
        <div class="confirmed">${row.confirmed}</div>${row.codeLines.map((line) => h`
        <div class="confirmed">${text(line)}</div>`)}${
          row.aiSources.length === 0
            ? ''
            : h`
        <div class="aisrcs"><span class="lbl">${r.w.aiChecked}</span>${row.aiSources.map((s) => h`<span>${ai(s.text, r)}<span class="aires">${r.w.aiResult[s.result]}</span></span>`)}</div>`
        }</div>
    </div>`;
}

function addressBody(body: Extract<Body, { kind: 'addresses' }>, r: R): Html {
  const worst = body.folded.some((row) => row.state === 'ok') ? 'ok' : 'na';
  return h`
  <div class="rows">${body.open.map((row) => addressRow(row, r))}${
    body.folded.length === 0
      ? ''
      : h`
    <details class="fold">
      <summary>${decor('chev')}${icon(worst, r.language)}${r.w.foldedAddresses(body.folded.length)}</summary>${body.folded.map((row) => addressRow(row, r))}
    </details>`
  }
  </div>`;
}

function pastBody(body: Extract<Body, { kind: 'past' }>, r: R): Html {
  if (body.recordings.length === 0) return h`<p class="lead">${r.w.noPast}</p>`;
  return h`
  <p class="lead">${text(body.same)}</p>${body.conclusion === undefined ? '' : h`
  <p class="intro">${ai(body.conclusion, r)}</p>`}${body.amounts.length === 0 ? '' : h`
  <p class="lead">${r.w.amountsLead}</p>`}${body.amounts.map(
    (a) => h`
  <div class="pblock">
    <div class="ph"><span class="pt"><code>${a.effect}</code></span><span>${a.tolerance}</span></div>${a.tokens.map(
      (t) => h`
    <div class="pg"><span class="pc num">${r.w.txCount(t.count)}</span><div><div>${t.lead}</div>${t.rows.map((row) => h`
      <div class="pex">${row.party}${row.cells.map((c, i) => h`${i === 0 ? '' : r.w.sep}<span class="num">${c.by}</span> ${c.n}`)}</div>`)}</div></div>`,
    )}${a.finding === undefined ? '' : h`
    <div class="warnline">${icon('bad', r.language)}<span>FINDING: ${a.finding}</span></div>`}${a.unmeasured === undefined ? '' : h`
    <div class="warnline">${decor('info')}<span>${a.unmeasured}</span></div>`}
  </div>`,
  )}${body.spreads.length === 0 ? '' : h`
  <p class="lead">${r.w.spreadLead}</p>`}${body.spreads.map(
    (sp) => h`
  <div class="pblock">
    <div class="ph"><span class="pt"><code>${sp.field}</code></span><span>${sp.who}: ${sp.lead}</span></div>
    <div class="pg"><span class="pc num">${r.w.txCount(sp.count)}</span><div><div class="pex">${sp.cells.map((c, i) => h`${i === 0 ? '' : r.w.sep}${c.label} <span class="num">${c.value}</span>`)}</div></div></div>${sp.unrecorded === undefined ? '' : h`
    <div class="warnline">${decor('info')}<span>${sp.unrecorded}</span></div>`}
  </div>`,
  )}
  <details class="fold">
  <summary>${decor('chev')}${r.w.otherWays}</summary>
  <p class="lead">${r.w.otherWaysLead}</p>${body.recordings.map(
    (rec) => h`
  <h3>${rec.count}</h3>
  <p class="lead">${around(r.w.recordedIn, rec.file)}${text(rec.search)}</p>${rec.blocks.map(
    (block) => h`
  <div class="pblock">
    <div class="ph"><span class="pt">${block.title}</span><span>${text(block.lead)}</span></div>${block.groups.map(
      (g) => h`
    <div class="pg"><span class="pc num">${r.w.txCount(g.count)}</span><div>${g.calls === undefined ? '' : h`<div class="pcalls">${text(g.calls)}</div>`}<div>${text(g.reason)}<span class="f3">${r.w.fromSenders(g.senders)}</span></div>
      <div class="pex">${r.w.examples}${g.examples.map((e, i) => h`${i === 0 ? '' : r.w.sep}${text([e])}`)}</div></div></div>`,
    )}
  </div>`,
  )}${rec.others.map((line) => h`
  <div class="warnline">${decor('info')}<span>${text(line)}</span></div>`)}`,
  )}
  </details>`;
}

/** A command alone in its block, so a copy takes nothing of the sentence around it. */
const command = (line: string): Html => h`<pre class="cmd"><code>${line}</code></pre>`;

function nextBody(body: Extract<Body, { kind: 'next' }>, r: R): Html {
  return h`
  <ol class="steps">${body.steps.map(
    (step) => h`
    <li><div>${text(step.say)}${step.command === undefined ? '' : command(step.command)}${step.then.map((line) => h`
      <p class="then">${text(line)}</p>`)}${step.hashes ? h`
      <div class="hash"><span>${r.w.compare}</span><span class="f2">${r.w.compareHashesWhat}</span></div>` : ''}</div></li>`,
  )}
  </ol>
  <div class="auto"><h3>${r.w.automatic}</h3>
    <ul>${body.automatic.map((line) => h`
      <li>${decor('info')}<span>${text(line)}</span></li>`)}
    </ul>
  </div>`;
}

function section(s: Section, r: R): Html {
  const count =
    s.body.kind === 'wallet'
      ? r.w.descriptors
      : s.count === undefined
        ? undefined
        : s.count.kind === 'states'
          ? stateCounts(s.count, r)
          : s.body.kind === 'addresses'
            ? r.w.addressCount(s.count.text)
            : s.count.text;
  const body = (() => {
    switch (s.body.kind) {
      case 'flow':
        return flowBody(s.body.flow, r);
      case 'protocol':
        return protocolBody(s.body.block, r);
      case 'vault':
        return vaultBody(s.body.vault, r);
      case 'review':
        return reviewBody(s.body, r);
      case 'wallet':
        return walletBody(s.body, r);
      case 'addresses':
        return addressBody(s.body, r);
      case 'past':
        return pastBody(s.body, r);
      case 'next':
        return nextBody(s.body, r);
    }
  })();
  return h`
<section id="${s.anchor}">
  <h2>${s.label}${count === undefined ? '' : h` <span class="c">${count}</span>`}${s.body.kind === 'addresses' ? tip(r.w.addressRuleLabel, r.w.addressRule) : ''}</h2>${body}
</section>
`;
}

/** The whole document, in the page's language. Deterministic: the same Page always gives the same bytes. */
export function renderPage(page: Page): string {
  tips = 0;
  const r: R = { w: WORDS[page.language], language: page.language };
  return `<!doctype html>
<html lang="${HTML_LANG[page.language]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escape(r.w.pageTitle(page.id))}</title>
<style>
${CSS}
</style>
</head>
<body>
${SYMBOLS}
<div class="wrap">
<div class="page">

<nav class="rail" aria-label="${escape(r.w.contents)}">
  <h2>${escape(r.w.contents)}</h2>
  ${contents(page.sections, r).text}
</nav>

<div class="main">

${header(page, r).text}
${page.sections.map((s) => section(s, r).text).join('')}
<footer class="foot">${text(page.footer).text}</footer>

</div>
</div>
</div>
</body>
</html>
`;
}

/**
 * The template's HTML report in every language from the recordings and `notes.json`, or undefined when it has none. It
 * takes the template's first recorded test transaction as the example. Throws NotesError for notes the program refuses.
 */
export async function generatedHtml(repoRoot: string, inputs: ReportInputs, title: ReportTitle): Promise<ReadonlyMap<Language, string> | undefined> {
  const { subject, registry } = inputs;
  const raw = readNotes(repoRoot, subject.template.id, subject.vault);
  if (raw === undefined) return undefined;
  // The example must name the report's own vault.
  const html = { ...inputs, example: firstRecordedTx(repoRoot, subject.template, registry) };
  return new Map(notesLanguages(raw).map((language) => [language, renderPage(buildPage(html, raw, title, language))]));
}

/** Up to 160 characters of a line from where it first differs, quoted so no control character reaches the terminal. */
const quoted = (line: string | undefined, at: number): string => {
  if (line === undefined) return 'nothing';
  const start = Math.max(0, at - 60);
  return JSON.stringify(`${start > 0 ? '…' : ''}${line.slice(start, start + 160)}${start + 160 < line.length ? '…' : ''}`);
};

/**
 * Writes each page into the report's folder `dir` and removes every page the program wrote there that `pages` does not
 * hold: one in a language the notes no longer hold, and the old one-language page. Returns the files removed.
 */
export function writeHtmlPages(dir: string, pages: ReadonlyMap<Language, string>): string[] {
  for (const [language, page] of pages) writeFileSync(join(dir, generatedHtmlFile(language)), page);
  const stale = [...LANGUAGES.filter((language) => !pages.has(language)).map(generatedHtmlFile), OLD_HTML_FILE].filter((file) => existsSync(join(dir, file)));
  for (const file of stale) rmSync(join(dir, file));
  return stale;
}

/** Where the committed `file` differs from what the program writes, byte for byte, or undefined when it does not. */
export function htmlDifference(file: string, committed: string | undefined, written: string | undefined): string | undefined {
  if (committed === written) return undefined;
  if (committed === undefined) return `${NOTES_FILE} holds text in its language but there is no committed ${file}`;
  if (written === undefined) return `${file} is committed but no ${NOTES_FILE} holds text in its language to write it from`;
  const [was, now] = [committed.split('\n'), written.split('\n')];
  const at = was.findIndex((line, i) => line !== now[i]);
  const line = at === -1 ? was.length : at;
  const [a, b] = [was[line] ?? '', now[line] ?? ''];
  let column = 0;
  while (column < a.length && a[column] === b[column]) column++;
  return `${file} line ${line + 1}: committed ${quoted(was[line], column)}, the program writes ${quoted(now[line], column)}`;
}
