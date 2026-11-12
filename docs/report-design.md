---
name: kiss-sign report
description: The signer's report for one Safe operation template; program facts first, AI research labelled and second.
colors:
  ground: "#0b0c0e"
  sunk: "#08090a"
  hover: "#111215"
  pop: "#1a1c20"
  hairline: "#202227"
  hairline-strong: "#2e3137"
  ink: "#eceef0"
  ink-2: "#a3a7ae"
  ink-3: "#80858d"
  state-ok: "#4cb782"
  state-warn: "#eda152"
  state-bad: "#ec6a5e"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "26px"
    fontWeight: 590
    lineHeight: 1.25
    letterSpacing: "-0.018em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 590
    lineHeight: 1.55
    letterSpacing: "-0.01em"
  subtitle:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 590
    lineHeight: 1.55
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  body-row:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang TC, Noto Sans TC, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
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
  section-top: "22px"
  block: "28px"
  section-gap: "56px"
  page-bottom: "96px"
components:
  tag-program:
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    rounded: "{rounded.r}"
    padding: "0 5px"
  tag-ai:
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.r}"
    padding: "0 5px"
  property-row:
    textColor: "{colors.ink}"
    typography: "{typography.body-row}"
    padding: "8px 0"
  review-row:
    textColor: "{colors.ink}"
    padding: "12px 8px 12px 0"
  review-row-hover:
    backgroundColor: "{colors.hover}"
  address-row:
    textColor: "{colors.ink}"
    padding: "12px 8px 12px 0"
  address:
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
  tooltip:
    backgroundColor: "{colors.pop}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.r}"
    padding: "8px 10px"
  diagram-frame:
    backgroundColor: "{colors.sunk}"
    rounded: "{rounded.r}"
  inline-code:
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.r}"
    padding: "0 5px"
---

# Design System: kiss-sign report

## Overview

**Creative North Star: "The Inspection Ledger"**

The report is a security tool's ledger at Linear's level of restraint: one left-aligned reading column on a near-black graphite ground, every fact on its own hairline row, and nothing lit up unless it carries state. The signer must know within seconds whether anything needs attention, so the page is quiet by default and the few coloured marks are the findings.

Everything is expressible as one inline stylesheet plus a block of inline SVG `<symbol>`s: no JavaScript, no external font, image or stylesheet, system fonts only, dark only. Interaction is limited to what HTML and CSS give for free: a hover/focus tooltip, `<details>` folds, link underlines.

Two voices share the page and never blur: what the program read and checked (plain text, solid tags), and what the AI researched (marked by a dashed outline). The program's facts always come first.

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
- **Ink 3** (ink-3): sources, counts beside titles, lead lines, captions, info icons at rest, the AI judgment icon, internal-call arrows.

### State
- **Pass Green** (state-ok): filled check icons, the "what the Safe receives" arrow and caption in the diagram, a positive change in after-transaction rows.
- **Attention Amber** (state-warn): ring-with-! icons, and the source label of a field the program leaves unbound but tested.
- **Fail Red** (state-bad): filled cross icons.

### Named Rules
**The State-Only Colour Rule.** Hue appears only to carry a result: pass, attention, fail, or the asset the Safe gains. Headings, links, tags, buttons and structure stay in the grey ramp.

**The No-Accent Rule.** There is no brand colour. A new surface that needs emphasis uses weight 590 or Ink, never a new hue.

## Typography

**Body Font:** the system UI stack (SF Pro Text on macOS, PingFang TC / Noto Sans TC for Traditional Chinese), a product constraint: the report loads nothing.
**Mono Font:** ui-monospace / SF Mono, only for addresses, hashes, parameter names, function names, call numbers and inline code.

**Character:** One sans family carries everything at two weights, 400 and 590; hierarchy comes from size steps of 26 / 18 / 15 / 14 / 13 / 12 and from the three ink greys.

### Hierarchy
- **Headline** (590, 26px, 1.25, -0.018em): the operation title, with the template id beside it in 13px mono Ink 3.
- **Title** (590, 18px, -0.01em): section names, one or two words, followed by a 13px Ink 3 count or qualifier on the same baseline.
- **Subtitle** (590, 14px): call headings, sub-blocks such as "交易後", review row titles, address names.
- **Body** (400, 15px, 1.55): the one-line summary under the title, capped at 62ch.
- **Body Row** (400, 14px): property, review and address row content.
- **Caption** (400, 13px): sources, leads, legends, rules, tooltips; footnote prose capped at 70ch.
- **Label** (400, 12px, 18px line): program / AI tags.
- **Mono** (400, 13px, 0.01em): addresses and code; amounts use tabular figures instead of mono.

### Named Rules
**The Mono Is Evidence Rule.** Monospace marks something the signer may compare character by character. Prose, labels and amounts never take it.

**The Full Address Rule.** Addresses and ids are printed whole and allowed to break anywhere (`overflow-wrap: anywhere`); they are never truncated or ellipsised.

## Layout

One column, max 900px, left-aligned, with 16px side padding (respecting safe-area insets), 28px top and 96px bottom. Sections stack with a 56px gap; each opens with a Strong Hairline top rule and 22px of padding, a 14px gap under the title, and a 13px Ink 3 lead pulled 8px closer when present. Sub-blocks inside a section start 28px down.

Property rows are a three-column grid: label (min 140px, 26%), value (fluid), source (auto, right-aligned). At 560px and below the label moves to its own line above value and source. The check strip wraps inline with 8px / 24px gaps and becomes a single column at 560px. The two wallet screens sit side by side with a 32px gutter and stack at 640px. The diagram keeps a 660px minimum width and scrolls horizontally inside its frame, with a "scroll" hint shown at 700px and below.

Order inside the page follows the signer: title, check strip and verdict; flow and its parameters; protocol; items to review; wallet display; addresses; past transactions; signing steps.

## Elevation & Depth

Flat. Depth exists in exactly two places: the diagram is recessed into Sunk Graphite, and the tooltip floats on Popover Graphite with the system's single shadow. Everything else is the ground plus hairlines.

### Shadow Vocabulary
- **Popover** (`box-shadow: 0 6px 14px rgb(4 5 8 / .55)`): tooltip bubble only.

### Named Rules
**The Rows Not Cards Rule.** Content groups are separated by hairline rules, never by filled or shadowed boxes. The diagram frame is the only bordered container.

## Shapes

One radius, a gentle 6px, on everything that has a corner: tags, inline code, tooltip, diagram frame and its nodes. Focus rings use 2px. Borders are 1px; inline code carries a 2px bottom border so it reads as a typed token. The AI tag is the one dashed outline in the UI; dashes elsewhere mean "inside the contract" (diagram internal calls, lifelines) or "judgment" (the dashed-ring icon).

## Components

### Status Icons
16px inline SVG symbols, aligned at -3px; 14px when nested inside a source result or the auto-check list. Shape carries state so the page survives greyscale:
- **Pass:** filled disc in Pass Green with a ground-coloured check.
- **Attention:** 1.5px ring in Attention Amber with a "!" stroke and dot.
- **Fail:** filled disc in Fail Red with a ground-coloured cross.
- **AI judgment:** dashed 1.5px ring with a centre dot, in Ink 3 (no hue: a judgment is not a result).
- **Info:** thin 1.3px ring with an "i", Ink 3, the tooltip trigger.
- **Chevron:** 1.5px stroke, Ink 3, rotates 90deg over 150ms when its fold opens.
Every state icon carries `role="img"` and a Chinese `aria-label`; info and chevron are `aria-hidden`.

### Check Strip
The first-viewport summary: one row of short named results between two hairlines, each an icon, a name, an optional Ink 2 count in tabular figures, and an info tooltip. The verdict line below pairs an Ink 3 "建議" label, a state icon, one sentence and the AI tag.

### Tooltip (CSS only)
A focusable `span` (tabindex 0) holding the info icon and a `role="tooltip"` bubble tied with `aria-describedby`. Bubble: Popover Graphite, Strong Hairline border, 6px radius, 8px 10px padding, 13px Ink, max 300px. Hover reveals after a 250ms delay with a 120ms fade; keyboard focus reveals instantly. The last two triggers in a row anchor right; on narrow screens the bubble anchors to the row's left edge.

### Property Row
A definition list of hairline rows: label (Ink 2, or 13px mono Ink 3 when it is a parameter name), value (Ink), source (13px, right-aligned). The source column states provenance: Ink 3 for fixed or program-read, Ink for a value the signer chooses on the card, Attention Amber for a field left unbound. A 13px Ink 3 sub-line may sit under a value. For a call argument the value is what `cast decode-calldata` prints, in mono, and the sub-line says in words what it is. A legend under the parameter list explains the source words.

### Review Row
A 20px icon column and a content column: a 590 title naming the problem in plain words, an optional Ink 2 line saying why in one sentence, the source list (as in the address row) with a result icon per source, the address in full, then a "建議" line ending in the AI tag. Hover fills Row Hover. Exceptions are listed open; nothing here is folded.

### Address Row
Icon, 590 name, a 13px Ink 3 role and confidence, the full address in mono, then a two-column source list: a program or AI tag, the source name as a link, and an inline 14px result icon. A passing source shows the icon alone; any other adds one of 讀不到, 是另一個地址 or 沒資料可比 (with a dash icon, grey). Addresses that passed at high confidence fold together under one `<details>` summary; a confidence rule sits below in caption type.

### AI Explanation Line
A 13px Ink 2 line under a value, indented 8px behind a 1px dashed Ink 3 left rule: the AI's account of what an argument or a tuple part does. The dashed rule is the AI mark here, so the line carries no tag; the parameter legend says once what the rule means. ### Argument Table
Each call's arguments are one real `<table>` with a header row (參數, 值, 誰決定 in 12.5px Ink 3 over a Strong Hairline), fixed layout: parameter 24%, value fluid, who-decides 160px right-aligned. A value cell holds the `cast decode-calldata` value in mono, a 13px Ink 3 line saying what it is, and the AI explanation line. A tuple's parts are child rows of the same table, indented 16px with a hairline corner mark, so every value column lines up. At 560px and below each row stacks name, value, then who decides, and the header hides.

### Program / AI Tags
12px label in a 1px 6px-radius outline. Program: solid Strong Hairline outline, Ink 3 text. AI: dashed Ink 3 outline, Ink 2 text, reading "AI 研究" plus the AI's own conclusion when given.

### Sequence Diagram
Inline SVG in a Sunk Graphite frame with a Hairline border. Participants are 42px-tall 6px-radius nodes (Row Hover fill, Strong Hairline stroke) with a 590 13px name and a 12px Ink 3 role, each dropping a dotted lifeline (2 4). Arrows: solid 1.4px Ink with a filled head for a call the Safe sends, numbered in mono Ink 3 with the function name in 13px mono; dashed 1.2px Ink 3 (4 4) for what a contract does internally, captioned in 13px Ink 2; one solid 1.4px Pass Green arrow back to the Safe with a 590 green caption for what the Safe receives. The SVG carries a `<title>` and a `<desc>` that narrates the calls in words.

### Table of Contents
One wrapping line of Ink 2 links under the verdict, one per section title; a link lightens to Ink with an underline on hover. Sections carry `scroll-margin-top` so a jump lands below the top edge.

### Folds
`<details>` with a hidden marker, a chevron and Ink 2 14px summary text that lightens to Ink on hover. Used only for things that passed or ran automatically.

### Signing Steps
An ordered list of hairline rows with a mono Ink 3 counter ("1."), inline code for commands and expected output, and a two-column hash grid (Ink 3 name, Ink 2 value).

## Do's and Don'ts

### Do:
- **Do** put the program's result, with its source, before any AI text, and mark every AI sentence with the dashed AI tag or, for an argument's explanation, the dashed left rule.
- **Do** let icon shape carry state (filled check, ring with !, filled cross, dashed ring) and keep colour to state alone.
- **Do** separate content with 1px hairline rows; use Strong Hairline only for section tops and outlines.
- **Do** print every address and hash whole, in 13px mono, breakable anywhere.
- **Do** keep check explanations behind an info tooltip and keep section titles to one or two words.
- **Do** list exceptions open and fold passes.
- **Do** keep the whole system to one inline stylesheet and inline SVG symbols.

### Don't:
- **Don't** wrap groups in rounded, filled or shadowed cards, or build KPI tiles and glowing status lamps.
- **Don't** mark AI text with a colour; the dashed outline is its only sign.
- **Don't** introduce a brand accent or use green, amber or red for anything that is not a result.
- **Don't** shorten an address with an ellipsis or set prose in monospace.
- **Don't** use a shadow anywhere except the tooltip.
