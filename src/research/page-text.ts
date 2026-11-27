const BLOCK = /<\/?(?:h[1-6]|p|div|section|header|footer|nav|ul|ol|li|table|thead|tbody|tr|details|summary|pre|blockquote|figure|figcaption|dl|dt|dd)\b[^>]*>|<br\s*\/?>/gi;

const unescape = (text: string): string => text.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));

/**
 * What a generated report page shows, as plain text: its head, styles, scripts and the contents rail beside the column
 * (the folded contents in the column stay) left out, each status icon as its label in brackets, such as `[fail]`, each
 * block on a line of its own, each label apart from the next, and each https link's address after its text. The page
 * escapes text only as `&#N;`, which is all it decodes.
 */
export function pageText(html: string): string {
  const body = html
    .replace(/<head>[\s\S]*?<\/head>/i, '')
    .replace(/<(style|script|nav)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<svg\b[^>]*\saria-label="([^"]*)"[^>]*>[\s\S]*?<\/svg>/gi, (_, label: string) => ` [${label}] `)
    .replace(/<svg\b[^>]*\saria-hidden="true"[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<a\b[^>]*\shref="(https:[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => `${text} (${href})`)
    .replace(BLOCK, '\n')
    .replace(/<\/?(?:b|i|em|strong|code|a|abbr|sub|sup)\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, ' ');
  return `${unescape(body)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')}\n`;
}
