import { request } from 'node:https';
import { fallbackLookup } from '../chain/dns.ts';
import { requestText } from '../chain/https.ts';
import type { HttpAnswer } from '../chain/https.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';

/** One unit of a page's text: a table row, a list item, a paragraph, a line, or one JSON leaf with its key path. */
export type PageBlock = { readonly text: string; readonly heading?: string };

export type Page = { readonly kind: 'served'; readonly blocks: readonly PageBlock[] } | { readonly kind: 'failed'; readonly why: string };

/** Whether a pinned commit is on its repository's default branch, as GitHub's compare API answered. */
export type CommitCheck =
  | { readonly kind: 'on-default'; readonly branch: string; readonly status: 'behind' | 'identical' }
  | { readonly kind: 'off-default'; readonly branch: string; readonly status: string }
  | { readonly kind: 'unknown'; readonly why: string };

export type SourcePages = { readonly pages: ReadonlyMap<string, Page>; readonly commits: ReadonlyMap<string, CommitCheck> };

export type GitHubSourceRef =
  | { readonly kind: 'pinned'; readonly owner: string; readonly repo: string; readonly commit: string; readonly path: string }
  | { readonly kind: 'unpinned' };

export type HttpGet = (url: string) => Promise<HttpAnswer>;

/** Characters allowed between the label and the address inside one block. */
export const MAX_GAP = 100;

export function isGitHubPage(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'github.com' || host === 'www.github.com';
}

/** `github.com/<owner>/<repo>/blob/<40-hex commit>/<path>` is pinned; any other GitHub page is not. */
export function githubRef(url: URL): GitHubSourceRef {
  const [owner, repo, blob, commit, ...path] = url.pathname.split('/').filter((s) => s !== '');
  if (owner === undefined || repo === undefined || blob !== 'blob' || commit === undefined || !/^[0-9a-f]{40}$/.test(commit) || path.length === 0) {
    return { kind: 'unpinned' };
  }
  return { kind: 'pinned', owner, repo, commit, path: path.join('/') };
}

export const commitKey = (ref: Extract<GitHubSourceRef, { kind: 'pinned' }>): string => `${ref.owner}/${ref.repo}@${ref.commit}`.toLowerCase();

/** The URL whose text is checked: a GitHub file is read raw at the commit it names, since github.com renders it with JavaScript. */
export function pageUrlOf(source: string): string {
  const url = new URL(source);
  if (!isGitHubPage(url)) return url.href;
  const [owner, repo, blob, ref, ...path] = url.pathname.split('/').filter((s) => s !== '');
  if (owner === undefined || repo === undefined || blob !== 'blob' || ref === undefined || path.length === 0) return url.href;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.join('/')}`;
}

export const sourceHoldsAddress = (source: string, address: Address): boolean => source.toLowerCase().includes(address.slice(2));

const BLOCK_TAGS = new Set(
  'address article aside blockquote body br caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html li main nav ol p pre section summary table tbody tfoot thead title tr ul'.split(' '),
);
const CELL_TAGS = new Set(['td', 'th']);
const HIDDEN = /<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The text a browser shows without running scripts, cut into blocks at every block-level tag. Table cells stay in their
 * row, and each line of a `pre` is its own block. Every block carries the nearest heading above it.
 */
export function htmlBlocks(html: string): PageBlock[] {
  const blocks: PageBlock[] = [];
  let heading: string | undefined;
  let current = '';
  let inHeading = false;
  let preDepth = 0;
  const flush = () => {
    const text = squash(decodeEntities(current));
    current = '';
    if (text === '') return;
    blocks.push(heading === undefined ? { text } : { text, heading });
    if (inHeading) heading = text;
  };
  const addText = (text: string) => {
    if (preDepth === 0) {
      current += text;
      return;
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (i > 0) flush();
      current += line;
    });
  };
  const visible = html.replace(HIDDEN, ' ');
  let at = 0;
  for (const match of visible.matchAll(TAG)) {
    addText(visible.slice(at, match.index));
    at = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = (match[2] as string).toLowerCase();
    if (CELL_TAGS.has(name)) current += ' ';
    if (!BLOCK_TAGS.has(name)) continue;
    flush();
    if (/^h[1-6]$/.test(name)) inHeading = !closing;
    if (name === 'pre') preDepth = Math.max(0, preDepth + (closing ? -1 : 1));
  }
  addText(visible.slice(at));
  flush();
  return blocks;
}

/** Each line is a block; a Markdown `#` line is a heading. */
export function lineBlocks(text: string): PageBlock[] {
  const blocks: PageBlock[] = [];
  let heading: string | undefined;
  for (const raw of text.split('\n')) {
    const line = squash(raw);
    if (line === '') continue;
    blocks.push(heading === undefined ? { text: line } : { text: line, heading });
    const title = /^#{1,6}\s+(.*)$/.exec(line);
    if (title !== null) heading = (title[1] as string).trim();
  }
  return blocks;
}

/** Each leaf is a block of its key path and value, such as `deployments canonical address 0xA238...`. */
export function jsonBlocks(value: unknown, path: readonly string[] = []): PageBlock[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => jsonBlocks(item, [...path, String(i)]));
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([key, item]) => jsonBlocks(item, [...path, key]));
  return [{ text: squash([...path, String(value)].join(' ')) }];
}

export function pageBlocks(url: string, contentType: string, body: string): PageBlock[] {
  if (/html/i.test(contentType) || /^\s*<(!doctype html|html)\b/i.test(body)) return htmlBlocks(body);
  if (/json/i.test(contentType) || new URL(url).pathname.toLowerCase().endsWith('.json')) {
    try {
      return jsonBlocks(JSON.parse(body));
    } catch {
      return lineBlocks(body);
    }
  }
  return lineBlocks(body);
}

export type PageMatch =
  | { readonly kind: 'next-to'; readonly gap: number; readonly labelFirst: boolean }
  | { readonly kind: 'absent' }
  | { readonly kind: 'miscased' }
  | { readonly kind: 'apart' };

type Span = { readonly start: number; readonly end: number };

function wordSpans(text: string, word: string): Span[] {
  const hay = text.toLowerCase();
  const needle = squash(word).toLowerCase();
  const spans: Span[] = [];
  if (needle === '') return spans;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = hay[i - 1];
    const after = hay[i + needle.length];
    if ((before === undefined || !/[a-z0-9]/.test(before)) && (after === undefined || !/[a-z0-9]/.test(after))) spans.push({ start: i, end: i + needle.length });
  }
  return spans;
}

const ADDRESS_TEXT = /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z])/g;
const HAS_ADDRESS = new RegExp(ADDRESS_TEXT.source);

/**
 * Where `address` stands on the page relative to `label`. They must share one block, or the label must be in the block
 * just before when that block holds no address, as in `<p>Name:</p><p>0x…</p>`. They must be at most `MAX_GAP`
 * characters apart, with no other address between them. With `heading`, the block's nearest heading must name it too. The
 * address counts only written in lowercase or in its EIP-55 checksum.
 */
export function findOnPage(blocks: readonly PageBlock[], address: Address, label: string, heading?: string): PageMatch {
  const wellCased = new Set([address, checksumAddress(address)]);
  let seen = false;
  let seenWellCased = false;
  let best: Extract<PageMatch, { kind: 'next-to' }> | undefined;
  blocks.forEach((block, i) => {
    const previous = blocks[i - 1]?.text ?? '';
    const text = HAS_ADDRESS.test(previous) ? block.text : `${previous} ${block.text}`;
    const found = [...text.matchAll(ADDRESS_TEXT)].map((m) => ({ text: m[0], start: m.index, end: m.index + 42 }));
    const ours = found.filter((f) => f.text.toLowerCase() === address);
    if (ours.length === 0) return;
    seen = true;
    const usable = ours.filter((f) => wellCased.has(f.text as Address));
    if (usable.length === 0) return;
    seenWellCased = true;
    if (heading !== undefined && wordSpans(block.heading ?? '', heading).length === 0) return;
    const others = found.filter((f) => f.text.toLowerCase() !== address);
    for (const spot of usable) {
      for (const name of wordSpans(text, label)) {
        const labelFirst = name.end <= spot.start;
        const [from, to] = labelFirst ? [name.end, spot.start] : [spot.end, name.start];
        if (to < from || to - from > MAX_GAP) continue;
        if (others.some((o) => o.start < to && o.end > from)) continue;
        if (best === undefined || to - from < best.gap) best = { kind: 'next-to', gap: to - from, labelFirst };
      }
    }
  });
  if (best !== undefined) return best;
  if (!seen) return { kind: 'absent' };
  return seenWellCased ? { kind: 'apart' } : { kind: 'miscased' };
}

const header = (answer: HttpAnswer, name: string): string => {
  const value = answer.headers?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
};

/** A redirect is not followed: the registry should name the page the text is on. */
export async function fetchPage(url: string, get: HttpGet): Promise<Page> {
  let answer: HttpAnswer;
  try {
    answer = await get(url);
  } catch {
    return { kind: 'failed', why: `${new URL(url).hostname} unreachable` };
  }
  if (answer.status >= 300 && answer.status < 400) {
    const location = header(answer, 'location');
    const target = URL.canParse(location, url) ? new URL(location, url).href : 'nowhere readable';
    return { kind: 'failed', why: `${url} answered HTTP ${answer.status}, redirecting to ${target}; name the page itself as the source` };
  }
  if (answer.status !== 200) return { kind: 'failed', why: `${url} answered HTTP ${answer.status}` };
  return { kind: 'served', blocks: pageBlocks(url, header(answer, 'content-type'), answer.text) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function rateLimited(answer: HttpAnswer): boolean {
  return answer.status === 429 || (answer.status === 403 && (header(answer, 'x-ratelimit-remaining') === '0' || /rate limit/i.test(answer.text)));
}

const RATE_LIMITED: CommitCheck = {
  kind: 'unknown',
  why: 'the GitHub API rate limit is reached (60 requests an hour without a token); the commit is not checked, run again later',
};

async function githubJson(url: string, get: HttpGet): Promise<{ kind: 'json'; status: number; body: unknown } | CommitCheck> {
  let answer: HttpAnswer;
  try {
    answer = await get(url);
  } catch {
    return { kind: 'unknown', why: 'api.github.com unreachable; the commit is not checked' };
  }
  if (rateLimited(answer)) return RATE_LIMITED;
  try {
    return { kind: 'json', status: answer.status, body: JSON.parse(answer.text) };
  } catch {
    return { kind: 'unknown', why: `api.github.com answered HTTP ${answer.status} without JSON; the commit is not checked` };
  }
}

/**
 * Asks GitHub for the default branch, then compares it with the commit. `behind` or `identical` means the commit is in
 * the branch's history. A commit that exists only in a fork is still served under the parent's path, so the path alone
 * proves nothing.
 */
export async function checkCommit(ref: Extract<GitHubSourceRef, { kind: 'pinned' }>, get: HttpGet): Promise<CommitCheck> {
  const api = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const repo = await githubJson(api, get);
  if (repo.kind !== 'json') return repo;
  if (repo.status === 404) return { kind: 'unknown', why: `GitHub has no repository ${ref.owner}/${ref.repo}` };
  if (repo.status !== 200 || !isRecord(repo.body) || typeof repo.body.default_branch !== 'string') {
    return { kind: 'unknown', why: `GitHub answered HTTP ${repo.status} for ${ref.owner}/${ref.repo} with no default branch` };
  }
  const branch = repo.body.default_branch;
  const compare = await githubJson(`${api}/compare/${encodeURIComponent(branch)}...${ref.commit}?per_page=1`, get);
  if (compare.kind !== 'json') return compare;
  if (compare.status === 404) return { kind: 'off-default', branch, status: 'no such commit in the repository' };
  const status = isRecord(compare.body) ? compare.body.status : undefined;
  if (compare.status !== 200 || typeof status !== 'string') return { kind: 'unknown', why: `GitHub answered HTTP ${compare.status} to the compare with no status` };
  return status === 'behind' || status === 'identical' ? { kind: 'on-default', branch, status } : { kind: 'off-default', branch, status };
}

export async function gatherSourcePages(sources: readonly string[], get: HttpGet): Promise<SourcePages> {
  const pages = new Map<string, Page>();
  const commits = new Map<string, CommitCheck>();
  for (const source of new Set(sources)) {
    const url = new URL(source);
    if (isGitHubPage(url)) {
      const ref = githubRef(url);
      if (ref.kind === 'pinned' && !commits.has(commitKey(ref))) commits.set(commitKey(ref), await checkCommit(ref, get));
    }
    const pageUrl = pageUrlOf(source);
    if (!pages.has(pageUrl)) pages.set(pageUrl, await fetchPage(pageUrl, get));
  }
  return { pages, commits };
}

/** A public GET with no key. GitHub's API asks for a user agent. */
export const httpsGet: HttpGet = (url) => {
  const target = new URL(url);
  if (target.protocol !== 'https:') return Promise.reject(new Error('not https'));
  return requestText(
    request,
    {
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers: { 'user-agent': 'kiss-sign', accept: target.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'text/html, application/json, text/plain' },
      servername: target.hostname,
      rejectUnauthorized: true,
      lookup: fallbackLookup(),
      signal: AbortSignal.timeout(60_000),
    },
    undefined,
    32 * 1024 * 1024,
  );
};
