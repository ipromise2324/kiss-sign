/** Layout for what kiss-sign prints at a terminal: 100 columns, aligned rows, one box per summary. */

export const WIDTH = 100;

/** The roles colour marks. Each is plain text when colour is off, so output piped or tested stays byte-stable. */
export type Paint = {
  readonly heading: (text: string) => string;
  /** What the signer picked or typed. */
  readonly picked: (text: string) => string;
  /** What the program computed or read from the chain. */
  readonly computed: (text: string) => string;
  /** Provenance and explanations: blocks, providers, sources, reasons. */
  readonly dim: (text: string) => string;
  readonly ok: (text: string) => string;
  readonly bad: (text: string) => string;
  readonly warn: (text: string) => string;
};

const sgr =
  (open: string, close: string) =>
  (text: string): string =>
    text === '' ? '' : `\x1b[${open}m${text}\x1b[${close}m`;
const plain = (text: string): string => text;

export function paint(color: boolean): Paint {
  if (!color) return { heading: plain, picked: plain, computed: plain, dim: plain, ok: plain, bad: plain, warn: plain };
  return {
    heading: sgr('1', '22'),
    picked: sgr('36', '39'),
    computed: sgr('33', '39'),
    dim: sgr('2', '22'),
    ok: sgr('1;32', '22;39'),
    bad: sgr('1;31', '22;39'),
    warn: sgr('1;33', '22;39'),
  };
}

/** Colour at a terminal only, and never when NO_COLOR is set to anything or TERM is dumb. */
export function colorWanted(isTTY: boolean | undefined, env: Readonly<Record<string, string | undefined>>): boolean {
  return isTTY === true && (env.NO_COLOR ?? '') === '' && env.TERM !== 'dumb';
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** East Asian Wide and Fullwidth characters, such as Chinese characters and their punctuation, take two terminal columns. */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;

/** The columns a text takes at a terminal, colour codes taking none. */
export function visible(text: string): number {
  let width = 0;
  for (const char of text.replace(ANSI, '')) width += WIDE.test(char) ? 2 : 1;
  return width;
}

export const padTo = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - visible(text)));

/** Punctuation that never starts a line, and punctuation that never ends one. */
const CLOSING = /^[、。，：；！？）」』】〉》]$/u;
const OPENING = /^[（「『【〈《]$/u;

/**
 * The pieces a line may break between, each with the spaces before it: a run of characters without a space or a wide
 * character, or one wide character, closing punctuation joined to the piece before it and opening punctuation to the
 * one after. An address, hash or URL is one piece.
 */
function pieces(text: string): { gap: string; word: string }[] {
  const out: { gap: string; word: string }[] = [];
  let gap = '';
  for (const char of text) {
    if (char === ' ') {
      gap += char;
      continue;
    }
    const last = out.at(-1);
    const wide = WIDE.test(char);
    const lastChar = last === undefined ? '' : [...last.word].at(-1) ?? '';
    const joins = last !== undefined && gap === '' && (OPENING.test(lastChar) || CLOSING.test(char) || (!wide && !WIDE.test(lastChar)));
    if (joins) last.word += char;
    else out.push({ gap, word: char });
    gap = '';
  }
  if (gap !== '') out.push({ gap, word: '' });
  return out;
}

/** Breaks at spaces and between wide characters only, so an address, hash or URL is never split; a piece longer than the width keeps a line of its own. */
export function wrap(text: string, width: number): string[] {
  const indent = /^ */.exec(text)?.[0] ?? '';
  if (indent !== '') return wrap(text.slice(indent.length), Math.max(1, width - indent.length)).map((line) => `${indent}${line}`);
  const lines: string[] = [];
  let line = '';
  for (const { gap, word } of pieces(text)) {
    if (line !== '' && visible(line) + gap.length + visible(word) > width) {
      lines.push(`${line}${gap.slice(1)}`);
      line = word;
    } else {
      line = line === '' ? word : `${line}${gap}${word}`;
    }
  }
  return [...lines, line];
}

/** A key and its value lines; `style` colours every value line. */
export type Row = readonly [key: string, value: string | readonly string[], style?: ((text: string) => string) | undefined];

/** Keys in one column, values aligned after them and wrapped at spaces within `width`. */
export function rows(entries: readonly Row[], indent = 2, width = WIDTH): string[] {
  const keyWidth = Math.max(0, ...entries.map(([key]) => visible(key))) + 2;
  const at = indent + keyWidth;
  return entries.flatMap(([key, value, style = plain]) => {
    const lines = (typeof value === 'string' ? [value] : value).flatMap((line) => wrap(line, Math.max(20, width - at)));
    return lines.map((line, i) => `${' '.repeat(indent)}${padTo(i === 0 ? key : '', keyWidth)}${style(line)}`.trimEnd());
  });
}

/**
 * Cells aligned in columns. A row wider than `width` moves its last cell, such as a full address, to a line of its own
 * under the second column, so the terminal never breaks it.
 */
export function table(cells: readonly (readonly string[])[], indent = 2, width = WIDTH): string[] {
  const columns = Math.max(0, ...cells.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, c) => Math.max(0, ...cells.filter((row) => c < row.length - 1).map((row) => visible(row[c] ?? ''))));
  const start = (c: number): number => indent + widths.slice(0, c).reduce((sum, w) => sum + w + 2, 0);
  return cells.flatMap((row) => {
    const head = row.slice(0, -1).map((cell, c) => padTo(cell, widths[c] ?? 0));
    const last = row.at(-1) ?? '';
    const line = `${' '.repeat(indent)}${[...head, last].join('  ')}`.trimEnd();
    if (visible(line) <= width || row.length < 2) return [line];
    return [`${' '.repeat(indent)}${head.join('  ')}`.trimEnd(), `${' '.repeat(start(1))}${last}`];
  });
}

/** A blank line, then a bold title and a dim hint after it. */
export function section(p: Paint, title: string, hint?: string): string[] {
  return ['', hint === undefined ? p.heading(title) : `${p.heading(title)}  ${p.dim(hint)}`];
}

/** A titled box open on the right, so a long line never breaks its frame. Its body is laid out for WIDTH - 2. */
export function box(title: string, body: readonly string[], frame: (text: string) => string = plain): string[] {
  const top = `┌─ ${title} `;
  return [
    frame(`${top}${'─'.repeat(Math.max(3, WIDTH - visible(top)))}`),
    ...body.map((line) => `${frame('│')} ${line}`.trimEnd()),
    frame(`└${'─'.repeat(WIDTH - 1)}`),
  ];
}

export const BOX_WIDTH = WIDTH - 2;

export const text = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join('');

const MARKED: Readonly<Record<string, keyof Paint>> = { FINDING: 'bad', DIFFERS: 'bad', 'PROGRAM CHANGE': 'bad', UNVERIFIABLE: 'warn', 'AI TEXT': 'warn', NOTE: 'dim', PASS: 'ok' };

/** Colours the verdict words a research script prints, such as FINDING and PASS, leaving the text itself unchanged. */
export function markWords(text: string, p: Paint): string {
  return text.replace(/\b(FINDING|DIFFERS|PROGRAM CHANGE|UNVERIFIABLE|AI TEXT|NOTE|PASS)\b/g, (word) => p[MARKED[word] ?? 'heading'](word));
}
