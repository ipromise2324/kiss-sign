/** Control, format, bidirectional and line-separator characters, which could steer or reorder what a terminal shows. */
const UNSHOWN = /[\p{C}\p{Zl}\p{Zp}]/gu;

/** Text from the chain, a page or an API with each character that could steer the terminal written as its code point; other text is unchanged. */
export const plain = (text: string): string => text.replace(UNSHOWN, (c) => `[U+${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}]`);

/** Text from the chain, a page or an API, as one quoted line with no control or bidirectional character, so it reads as data. */
export const quoted = (value: unknown, max = 160): string =>
  JSON.stringify(String(value ?? '').replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max));
