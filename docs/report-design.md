---
name: kiss-sign report
description: The signer's report for one Safe operation template; program facts first, AI research labelled and second.
colors:
  ground: "#0b0c0e"
  sunk: "#08090a"
  hover: "#121317"
  pop: "#1a1c20"
  hairline: "#212328"
  hairline-strong: "#30333a"
  ink: "#eceef0"
  ink-2: "#b0b4ba"
  ink-3: "#8a8f97"
  state-ok: "#4cb782"
  state-warn: "#eda152"
  state-bad: "#ec6a5e"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "30px"
    fontWeight: 590
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 590
    lineHeight: 1.4
    letterSpacing: "-0.012em"
  subtitle:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 590
    lineHeight: 1.65
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  body-row:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "20px"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
    letterSpacing: "0.01em"
rounded:
  focus: "2px"
  r: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  section-top: "28px"
  block: "36px"
  section-gap: "72px"
  page-bottom: "120px"
  rail: "184px"
  rail-gap: "56px"
components:
  tag-ai:
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.r}"
    padding: "0 6px"
  property-row:
    textColor: "{colors.ink}"
    typography: "{typography.body-row}"
    padding: "11px 0"
  argument-row:
    textColor: "{colors.ink}"
    padding: "16px 0"
  who-chip:
    textColor: "{colors.ink-3}"
    fontSize: "13px"
    lineHeight: "22px"
    rounded: "{rounded.r}"
    padding: "0 8px"
  review-row:
    textColor: "{colors.ink}"
    padding: "16px 8px 16px 0"
  review-row-hover:
    backgroundColor: "{colors.hover}"
  address-row:
    textColor: "{colors.ink}"
    padding: "16px 8px 16px 0"
  address:
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
  tooltip:
    backgroundColor: "{colors.pop}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.r}"
    padding: "9px 12px"
  diagram-frame:
    backgroundColor: "{colors.sunk}"
    rounded: "{rounded.r}"
  inline-code:
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.r}"
    padding: "1px 6px"
---

# Design System: kiss-sign report

## Overview

**Creative North Star: "The Inspection Ledger"**

The report is a security tool's ledger at Linear's level of restraint: one left-aligned reading column beside a sticky contents rail on a near-black graphite ground, every fact on its own hairline row, and nothing lit up unless it carries state. The signer must know within seconds whether anything needs attention, so the page is quiet by default and the few coloured marks are the findings.

Everything is expressible as one inline stylesheet plus a block of inline SVG `<symbol>`s: no JavaScript, no external font, image or stylesheet, system fonts only, dark only. Interaction is limited to what HTML and CSS give for free: a hover/focus tooltip, `<details>` folds, link underlines.

Two voices share the page and never blur: what the program read and checked (plain text, untagged), and what the AI researched (marked by a dashed outline). The program's facts always come first.

The page is written in each language its `notes.json` holds, English, Traditional Chinese or both, the same layout in each (a per-instance report in each language both the template's and the instance's notes hold); every word below is given in Traditional Chinese, and the English page uses the same word in English (你填 is "you type", 待確認 is "To review"). A page whose notes hold its language alone says so in one Ink 3 14px line under the summary (這份報告只有繁體中文版。, "This report exists only in English.").

**Key Characteristics:**
- Near-black ground, three ink greys, three state colours, no brand accent.
- Rows divided by 1px hairlines; no cards, no tiles, no lamps.
- 16px SVG status icons whose shape, not only colour, carries state.
- Full, unshortened addresses in monospace wherever a signer compares them.
- AI text is marked by a dashed outline, never by a colour.

## Colors

A graphite neutral ramp with three state hues and nothing else; there is no decorative accent.

### Primary
None. There is no brand accent. Ink is the strongest non-state colour.

### Neutral
- **Graphite Ground** (ground): page background.
- **Sunk Graphite** (sunk): inset well behind the sequence diagram, the only recessed surface.
- **Row Hover** (hover): hover fill for review and address rows; also the fill of diagram nodes.
- **Popover Graphite** (pop): tooltip surface, the only raised surface.
- **Hairline** (hairline): row dividers and the check strip's rules.
- **Strong Hairline** (hairline-strong): section top rules, tag and code outlines, diagram lifelines and node strokes, link underlines at rest, text selection.
- **Ink** (ink): primary text, values, addresses, solid call arrows.
- **Ink 2** (ink-2): row labels, secondary prose, AI tag text.
- **Ink 3** (ink-3): sources, counts beside titles, lead lines, captions, info icons at rest, the AI judgment icon, internal-call arrows not yet checked, the 固定 chip.

### State
- **Pass Green** (state-ok): filled check icons, the "what the Safe receives" arrow and caption in the diagram, a positive change in after-transaction rows.
- **Attention Amber** (state-warn): ring-with-! icons, the 不限 chip of an argument the program leaves unbound but tested, and the 有上限 chip of an argument the template bounds by time.
- **Fail Red** (state-bad): filled cross icons.

### Named Rules
**The State-Only Colour Rule.** Hue appears only to carry a result: pass, attention, fail, or the asset the Safe gains. Headings, links, tags, buttons and structure stay in the grey ramp.

**The No-Accent Rule.** There is no brand colour. A new surface that needs emphasis uses weight 590 or Ink, never a new hue.

## Typography

**Body Font:** the system UI stack (SF Pro Text on macOS, PingFang TC / Noto Sans TC for Traditional Chinese), a product constraint: the report loads nothing.
**Mono Font:** ui-monospace / SF Mono, only for addresses, hashes, parameter names, function names, call numbers and inline code.

**Character:** One sans family carries everything at two weights, 400 and 590; hierarchy comes from size steps of 30 / 22 / 16 / 15 / 14 / 12 and from the three ink greys. Body text is 16px with a 1.65 line height, since Traditional Chinese at smaller sizes on a dark ground was hard to read.

### Hierarchy
- **Headline** (590, 30px, 1.25, -0.02em): the operation title, with the template id on its own line under it in 13px mono Ink 3.
- **Title** (590, 22px, -0.012em): section names, one or two words, followed by a 14px Ink 3 count or qualifier on the same baseline.
- **Subtitle** (590, 16px): sub-blocks such as "交易後", review row titles, address names. A call heading is the function in 16px 590 mono, its contract prefix in Ink 2 400.
- **Body** (400, 16px, 1.65): the summary under the title (17px, Ink 2, capped at 60ch) and running text.
- **Body Row** (400, 15px): property, review and address row content, and an argument's plain-words line.
- **Caption** (400, 14px): sources, leads, rules, tooltips, the contents rail, an argument's AI line; footnote prose capped at 70ch.
- **Label** (400, 12–13px, 20–22px line): the AI tag (12px, 20px line) and who-decides chips (13px, 22px line).
- **Mono** (400, 14px, 0.01em): addresses and code; a tuple part's value and a market id drop to 13–14px. Amounts use tabular figures instead of mono.

### Named Rules
**The Mono Is Evidence Rule.** Monospace marks something the signer may compare character by character. Prose, labels and amounts never take it.

**The Full Address Rule.** Addresses and ids are printed whole and allowed to break anywhere (`overflow-wrap: anywhere`); they are never truncated or ellipsised.

## Layout

A two-column page, max 1180px, with 20px side padding (respecting safe-area insets), 32px top and 120px bottom: a 184px sticky contents rail, a 56px gap, and one reading column of at most 880px. At 1040px and below the rail hides and the contents fold under the verdict. Sections stack with a 72px gap; each opens with a Strong Hairline top rule and 28px of padding, an 8px gap under the title, and a 14px Ink 3 lead with 20px under it when present. Sub-blocks inside a section start 36px down.

Property rows are a three-column grid: label (min 140px, 24%), value (fluid), source (auto, right-aligned). Argument rows are a two-column grid: name and who-decides chip (200px), value (fluid); at 720px and below the chip sits beside the name above the value. At 600px and below the label moves to its own line above value and source. The check strip wraps inline with 10px / 28px gaps and becomes a single column at 600px. The wallet section is one property table, one row per call, which follows the property rows' 600px rule. The diagram keeps a 660px minimum width and scrolls horizontally inside its frame, with a "scroll" hint shown at 700px and below.

Order inside the page follows the signer: title, check strip and verdict; flow and its parameters; protocol; in a per-instance report, the instance (實例); items to review; wallet display; addresses; past transactions; signing steps.

## Elevation & Depth

Flat. Depth exists in exactly two places: the diagram is recessed into Sunk Graphite, and the tooltip floats on Popover Graphite with the system's single shadow. Everything else is the ground plus hairlines.

### Shadow Vocabulary
- **Popover** (`box-shadow: 0 6px 14px rgb(4 5 8 / .55)`): tooltip bubble only.

### Named Rules
**The Rows Not Cards Rule.** Content groups are separated by hairline rules, never by filled or shadowed boxes. The diagram frame is the only bordered container.

## Shapes

One radius, a gentle 6px, on everything that has a corner: tags, who-decides chips, inline code, tooltip, diagram frame and its nodes. Focus rings use 2px. Borders are 1px. The AI tag is the one dashed outline in the UI; dashes elsewhere mean "inside the contract, not checked" (diagram internal calls no call trace saw, lifelines) or "judgment" (the dashed-ring icon). An internal call the template binds, or one a call trace saw, is a solid Ink 2 line; a seen one carries a 12.5px Ink 3 line under its caption saying it was confirmed two ways, linked to the AI's first source.

## Components

### Status Icons
16px inline SVG symbols, aligned at -3px; 14px when nested inside a source result or the auto-check list. Shape carries state so the page survives greyscale:
- **Pass:** filled disc in Pass Green with a ground-coloured check.
- **Attention:** 1.5px ring in Attention Amber with a "!" stroke and dot.
- **Fail:** filled disc in Fail Red with a ground-coloured cross.
- **AI judgment:** dashed 1.5px ring with a centre dot, in Ink 3 (no hue: a judgment is not a result).
- **Not compared:** 1.5px ring in Ink 3 with a dash, for a result that is grey: nothing to compare, or not compared.
- **Info:** thin 1.3px ring with an "i", Ink 3, the tooltip trigger.
- **Chevron:** 1.5px stroke, Ink 3, rotates 90deg over 150ms when its fold opens.
Every state icon carries `role="img"` and an `aria-label` in the page's language; info and chevron are `aria-hidden`.

### Check Strip
The first-viewport summary: one row of short named results between two hairlines, each an icon, a name, an optional Ink 2 count in tabular figures, and an info tooltip. The verdict line below pairs an Ink 3 "建議" label, a state icon, one sentence and the AI tag.

### Tooltip (CSS only)
A focusable `span` (tabindex 0) holding the info icon and a `role="tooltip"` bubble tied with `aria-describedby`. Bubble: Popover Graphite, Strong Hairline border, 6px radius, 9px 12px padding, 14px Ink, max 320px. Hover reveals after a 250ms delay with a 120ms fade; keyboard focus reveals instantly. The last two triggers in a row anchor right; on narrow screens the bubble anchors to the row's left edge.

### Property Row
A definition list of hairline rows: label (Ink 2), value (Ink), and an optional 14px Ink 3 note, right-aligned, used by 交易後 and 過去交易 for the rule or count behind a value. A 14px Ink 3 sub-line may sit under a value. The protocol and wallet tables drop the note column; a row that groups others (a market, a call) nests them in its value behind a 1px Strong Hairline rule, 16px in, each a 96px Ink 2 label beside its value. Sources are never repeated per row: the protocol table names them once in a 14px Ink 3 line under it.

### Review Row
A 22px icon column and a content column: a 590 title naming the problem in plain words, an Ink 2 line saying why in one sentence and ending in a 看來源 link to the entry's address row, then a "建議" line whose sentence names the AI's evidence and ends in the AI tag. Sources and the address are not repeated here. Hover fills Row Hover. Exceptions are listed open; nothing here is folded.

### Address Row
Icon, 590 name, a 14px Ink 3 role and confidence, the full address in mono, then the program's source list, one per line: the source name as a link and an inline 14px result icon, with no tag. A page's or the API's site result nests under its source line, indented 16px in 14px Ink 2: its own icon, then 網站屬於 `<slug>` or 網站：`<phrase>`, then（DefiLlama 對照） with DefiLlama linked. A passing source line shows the icon alone; any other result adds one of 讀不到, 是另一個地址, 是另一個網站, 沒資料可比 or 網址含地址 beside its state icon. A grey dash on a site line moves nothing: the source above it still confirms the address or not by its own result. The confirmations line follows. For an entry whose ABI the program does not use, as `docs/design.md` defines it, or whose code pin holds routes, lines in the confirmations line's style follow it: one saying no call targets the entry, so it has no ABI proof, and, when it has a code pin, that each signing checks its code, with each entry that depends on it linked, or, when none does, that each signing whose card uses it checks its code, or, for an entry `verify` never reads at signing, that signing does not touch it and the report reads its code at its latest block; one counting the implementations its seeds reach; then one per implementation, its full address and its code hash in mono, and how many functions it serves; then one saying an implementation no seed reaches is not checked. Last, after a Hairline, an Ink 3 label AI 補查 heads the AI's sources, one per line: the dashed AI tag, the text with its source link, and its result in 14px Ink 3 words (AI 判斷：沒問題, 要注意 or 有問題), with no icon and no state colour. Addresses with no result for the signer fold together under one `<details>` summary. The confidence rule sits in an info tooltip beside the section title. Each row carries an id so a review row can link to it.

### Who-Decides Key
One line between two hairlines above the calls: an Ink 3 590 "誰決定", then each chip some argument uses with a few Ink 3 words on what it means. Under it, when a call has data, a lead line says the first line of each argument is what `cast decode-calldata` prints and names the example amount.

### Call Block
A heading row over a Strong Hairline: the call number in mono Ink 3, the function in 16px 590 mono with its contract prefix in Ink 2, and the selector in 13px mono Ink 3. Under it, over a Hairline, the documentation row, the function's page in 14px Ink 2: an Ink 3 文件：, the page as a link (a standard's page reads ERC-20 標準頁, followed by an Ink 3 note that the standard defines the function but does not show the contract follows it), and its result as an address row's source line shows one: a 14px state icon alone when it passes, else the icon and its phrase, 頁上沒有這個函式 for a page read that does not name the function. A nested call's argument row shows the same line under its plain-words line, with no hairline. A call with no data has no function: its heading says in 16px 590 sans what it does, such as 轉 ETH 給收款人, it has no documentation row, and its rows are `to`, `value` and `data`. Then one argument row per argument, each over a Hairline. The Safe transaction's own rule, such as a cancellation's nonce, is a block of the same shape headed Safe 交易, before the calls.

### Argument Row
Left: the parameter name in 14px mono Ink, and under it its who-decides chip (or two, for an argument whose parts differ, such as `kind 固定` and `data 不限`). Right, top to bottom: the value as `cast decode-calldata` prints it, in mono Ink; a 15px Ink line saying in words what it is (a registry name, 你填的金額, 不抽成, 無（零地址）), with an Ink 3 qualifier after it; and the AI line, a dashed `AI` tag followed by 14px Ink 2 text on what the argument does. A tuple shows its summary (such as the market's name and its id) in place of a value, and its parts nest under it: indented 16px behind a 1px Strong Hairline rule, each part a 132px mono Ink 2 name beside its value, plain-words line and AI line. The parts carry no chip of their own; the tuple's chip covers them.

### Who-Decides Chip
A 13px label in a 1px 6px-radius outline. The words, from the template's rule for the argument, include: 你填 (a card amount; Ink text, Ink 2 outline, 590), 你選 (a card choice such as a market or vault; same style), 程式算 (a value a computed card field bounds, which `card new` reads; same style as 固定), 固定 (a value the template fixes; Ink 3 on Strong Hairline), app 填，不限 (an argument left free and tested by perturbation; Attention Amber text and outline), and app 填，有上限 (a `withinSeconds` argument the app fills and the template bounds; the same amber style). A chip may name the card field after a colon, by its word (你填：金額, 你選：市場).

### AI Tag
12px label in a 1px dashed Ink 3 6px-radius outline, Ink 2 text, reading "AI 研究", "AI" on an argument's AI line, or "AI 研究：可以用" / "AI 研究：要小心" on the verdict line. The program's results carry no tag.

### Sequence Diagram
Inline SVG in a Sunk Graphite frame with a Hairline border. Participants are 44px-tall 6px-radius nodes (Row Hover fill, Strong Hairline stroke) with a 590 14px name and a 12.5px Ink 3 role, each dropping a dotted lifeline (2 4). Arrows: solid 1.4px Ink with a filled head for a call the Safe sends, numbered in mono Ink 3 with the function name in 14px mono; dashed 1.2px Ink 3 (4 4) for what a contract does internally that no call trace confirmed, solid Ink 2 for an internal call the template binds or a call trace saw (see Shapes), captioned in 14px Ink 2, where a function or argument name the AI wrote between backticks sits in 13px mono Ink on its own 6px-radius Row Hover box, like inline code in prose with a Strong Hairline stroke, each part placed at its own x so the caption ends inside the frame; one solid 1.4px Pass Green arrow back to the Safe with a 590 green caption for what the Safe receives. The SVG carries a `<title>` and a `<desc>` that narrates the calls in words.

### Bar Chart
Inline SVG in the Sequence Diagram's frame, 660 wide at least and scrolling inside the frame on a narrow screen. One bar per reading, oldest first, on a Strong Hairline baseline: Strong Hairline fill, the latest in Ink 2; a reading with no amount is a dashed Ink 3 stub. Month labels and the year at the first bar and each January sit under it in 12px Ink 3, and the largest reading in 12px Ink 3 at the top left. Colour marks no state here. Each bar carries a `<title>` with its date and amount, the SVG a `<title>` and a `<desc>`, and the readings follow as rows in a fold.

### Contents Rail
A `<nav>` in the left column, sticky 32px from the top: a 13px 590 Ink 3 "目錄", then an ordered list behind a 1px Hairline left rule, one 14px Ink 2 link per section, each 6px tall padding and 14px from the rule. A count sits right-aligned in Ink 3 (such as 2 個呼叫 or 6), and 待確認 shows its state icon with its count. Hover lightens the link to Ink and draws its piece of the rule in Ink 2. At 1040px and below the rail hides, and the same list folds under the verdict as a `<details>` named 目錄, laid out as a grid of 150px columns. Sections carry `scroll-margin-top` so a jump lands below the top edge.

### Folds
`<details>` with a hidden marker, a chevron and Ink 2 15px summary text that lightens to Ink on hover. Used only for things that passed or ran automatically, for the numbers a chart already draws, and for 過去交易's 其他做法, the past transactions of other shapes, which are context, not results.

### Signing Steps
An ordered list of hairline rows with a mono Ink 3 counter ("1."), each command in a copyable block of its own under the step's sentence, and a two-column hash grid (Ink 3 name, Ink 2 value).

## Do's and Don'ts

### Do:
- **Do** put the program's result, with its source, before any AI text, and mark every AI sentence with the dashed AI tag.
- **Do** let icon shape carry state (filled check, ring with !, filled cross, dashed ring) and keep colour to state alone.
- **Do** separate content with 1px hairline rows; use Strong Hairline only for section tops and outlines.
- **Do** print every address and hash whole, in 14px mono, breakable anywhere.
- **Do** say who decides each argument in the signer's words: 你填, 你選, 程式算, 固定, app 填，不限, app 填，有上限.
- **Do** keep check explanations behind an info tooltip and keep section titles to one or two words.
- **Do** list exceptions open and fold passes.
- **Do** keep the whole system to one inline stylesheet and inline SVG symbols.

### Don't:
- **Don't** wrap groups in rounded, filled or shadowed cards, or build KPI tiles and glowing status lamps.
- **Don't** mark AI text with a colour; the dashed outline is its only sign.
- **Don't** introduce a brand accent or use green, amber or red for anything that is not a result.
- **Don't** shorten an address with an ellipsis or set prose in monospace.
- **Don't** use a shadow anywhere except the tooltip.
- **Don't** set body text below 16px or row text below 15px.
