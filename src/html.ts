import type { Language } from './language.ts';
import type { State } from './research/ledger.ts';
import { WORDS } from './research/report-words.ts';

/** Markup the renderer made. Every other value is escaped on its way into it. */
export class Html {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

type Part = Html | string | number | undefined | false | readonly Part[];

/** Control, bidirectional and invisible characters other than tab and newline, which could hide or reorder what the page shows. */
const UNSEEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const codePoint = (c: string): string => `[U+${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}]`;
export const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(UNSEEN, codePoint);
const part = (value: Part): string => (value instanceof Html ? value.text : Array.isArray(value) ? value.map(part).join('') : value === undefined || value === false ? '' : escape(String(value)));

/** The one way markup is built: every interpolated value is escaped unless the renderer made it. */
export function h(strings: TemplateStringsArray, ...parts: readonly Part[]): Html {
  return new Html(strings.reduce((out, s, i) => out + s + (i < parts.length ? part(parts[i] as Part) : ''), ''));
}

const ICONS: Readonly<Record<State | 'ask', { readonly symbol: string; readonly tone: string }>> = {
  ok: { symbol: 'ok', tone: 'ok' },
  warn: { symbol: 'warn', tone: 'warn' },
  bad: { symbol: 'bad', tone: 'bad' },
  na: { symbol: 'na', tone: 'mute' },
  ask: { symbol: 'ask', tone: 'mute' },
};

/** A state's icon, named in `language` for a screen reader. */
export const icon = (state: State | 'ask', language: Language): Html =>
  h`<svg class="i ${ICONS[state].tone}" role="img" aria-label="${WORDS[language].state[state]}"><use href="#${ICONS[state].symbol}"/></svg>`;

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
.sub{color:var(--fg2);margin:14px 0 0;font-size:17px}
.sub .byai,h3 .byai,.intro .byai,.rec .byai,.verdict .byai,.row .t .byai,.role .byai,.props dd .byai{margin-left:8px}
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
.intro{color:var(--fg2);margin:0 0 20px}
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
svg .inner.seen{stroke:var(--fg2);stroke-dasharray:none}
svg .nested{stroke:var(--fg2);stroke-width:1.2;fill:none}
svg .gain{stroke:var(--ok);stroke-width:1.4;fill:none}
svg .ah{fill:var(--fg)}
svg .fn{fill:var(--fg);font:400 14px var(--mono)}
svg .no{fill:var(--fg3);font:400 14px var(--mono)}
svg .cap{display:flex;align-items:flex-start;gap:8px;padding-top:2px;color:var(--fg2);font:14px/20px var(--sans)}
svg .cap code{font-size:13px;padding:2px 6px;white-space:nowrap}
.mark{font-size:17px} .mark.ok{color:var(--ok)} .mark.bad{color:var(--bad)}
svg .capg{fill:var(--ok);font:590 14px var(--sans)}
svg .bar{fill:var(--line2)} svg .bar.last{fill:var(--fg2)}
svg .barna{fill:none;stroke:var(--fg3);stroke-dasharray:3 3}
svg .axis{stroke:var(--line2)}
svg .tick{fill:var(--fg3);font:12px var(--sans)}
.legend{list-style:none;margin:10px 0 14px;padding:0;display:flex;flex-direction:column;gap:4px;font-size:var(--t-small);color:var(--fg2)}
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
.doc{font-size:var(--t-small);color:var(--fg2);margin-top:4px}
.cdoc{padding:10px 0;border-bottom:1px solid var(--line)}
.cdoc .doc{margin-top:0}
.arg{display:grid;grid-template-columns:200px minmax(0,1fr);gap:4px 24px;padding:16px 0;border-bottom:1px solid var(--line)}
.arg .nm{display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-width:0}
.arg .pn{font-family:var(--mono);font-size:var(--t-mono);color:var(--fg);overflow-wrap:anywhere}
.arg .val{min-width:0}
.arg .mid{margin-top:6px;font-size:var(--t-small);color:var(--fg3)}
.arg .mid .addr{font-size:13px;color:var(--fg2)}
.arg .raw{font-family:var(--mono);font-size:var(--t-mono);color:var(--fg);overflow-wrap:anywhere;line-height:1.5}
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
details.more>summary{cursor:pointer;list-style:none;display:inline-flex;gap:6px;align-items:center;margin-top:6px;color:var(--fg3);font-size:var(--t-small)}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary:hover{color:var(--fg)}
details.more[open]>summary .chev{transform:rotate(90deg)}

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
.foot{font-size:var(--t-small);color:var(--fg3);border-top:1px solid var(--line);padding-top:16px}
.foot code{border:0;padding:0;font-size:13px;color:var(--fg2)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}html{scroll-behavior:auto}}`;
