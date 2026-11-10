import { request } from 'node:https';
import { fallbackLookup } from '../chain/dns.ts';
import { requestText } from '../chain/https.ts';
import type { HttpAnswer } from '../chain/https.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';

/** One unit of a page's text: a table row, a list item, a paragraph, a line, or one JSON leaf with its key path. */
export type PageBlock = { readonly text: string; readonly heading?: string };

export type Page = { readonly kind: 'served'; readonly blocks: readonly PageBlock[] } | { readonly kind: 'failed'; readonly why: string };

export type CommitCheck =
  | { readonly kind: 'on-default'; readonly branch: string; readonly status: 'behind' | 'identical' }
  | { readonly kind: 'off-default'; readonly branch: string; readonly status: string }
  | { readonly kind: 'unknown'; readonly why: string };

export type SourcePages = { readonly pages: ReadonlyMap<string, Page>; readonly commits: ReadonlyMap<string, CommitCheck> };

export type GitHubSourceRef =
  | { readonly kind: 'pinned'; readonly owner: string; readonly repo: string; readonly commit: string; readonly path: string }
  | { readonly kind: 'unpinned' };

export type HttpGet = (url: string) => Promise<HttpAnswer>;

export const MAX_LABEL_ADDRESS_GAP = 100;

export function isGitHubPage(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'github.com' || host === 'www.github.com';
}

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
  'address article aside blockquote body br caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr html li main nav ol p pre section summary table tbody tfoot thead tr ul'.split(' '),
);
const CELL_TAGS = new Set(['td', 'th']);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
const UNSHOWN_TAGS = new Set(['svg', 'template']);
const VOID_TAGS = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));
/** A browser ends a tag at the first `>` outside a quoted attribute value, and an unclosed comment, quote or tag runs to the end. */
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<[!?][^>]*(?:>|$)|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^'">])*)(?:>|$)/g;
const ATTRIBUTE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s"'=<>`]+)))?/g;
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

function hidesItself(attributes: string): boolean {
  for (const [, name, ...values] of attributes.matchAll(ATTRIBUTE)) {
    const key = (name as string).toLowerCase();
    const value = (values.find((v) => v !== undefined) ?? '').toLowerCase();
    if (key === 'hidden') return true;
    if (key === 'aria-hidden' && value.trim() === 'true') return true;
    if (key === 'style' && /display\s*:\s*none|visibility\s*:\s*hidden/.test(value)) return true;
  }
  return false;
}

/**
 * The text a browser shows without running scripts or reading stylesheets, cut into blocks at every block-level tag.
 * Scripts, styles, the title, text areas, SVG, templates, and every element hidden by its own attributes are left out
 * with all they hold. Table cells stay in their row, and each line of a `pre` is its own block. Every block carries the
 * nearest heading above it.
 */
export function htmlBlocks(html: string): PageBlock[] {
  const blocks: PageBlock[] = [];
  let heading: string | undefined;
  let current = '';
  let inHeading = false;
  let preDepth = 0;
  let unshown: { name: string; depth: number } | undefined;
  const flush = () => {
    const text = squash(decodeEntities(current));
    current = '';
    if (text === '') return;
    blocks.push(heading === undefined ? { text } : { text, heading });
    if (inHeading) heading = text;
  };
  const addText = (text: string) => {
    if (unshown !== undefined) return;
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
  const token = new RegExp(TOKEN.source, 'g');
  let at = 0;
  for (let match = token.exec(html); match !== null; match = token.exec(html)) {
    addText(html.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[2] === undefined) continue;
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const attributes = match[3] ?? '';
    if (!closing && RAW_TEXT_TAGS.has(name)) {
      const end = new RegExp(`</${name}\\s*>`, 'ig');
      end.lastIndex = at;
      const found = end.exec(html);
      at = found === null ? html.length : found.index + found[0].length;
      token.lastIndex = at;
      continue;
    }
    if (unshown !== undefined) {
      if (name === unshown.name) unshown.depth += closing ? -1 : 1;
      if (unshown.depth === 0) unshown = undefined;
      continue;
    }
    if (!closing && (UNSHOWN_TAGS.has(name) || hidesItself(attributes))) {
      if (!VOID_TAGS.has(name) && !attributes.trimEnd().endsWith('/')) unshown = { name, depth: 1 };
      continue;
    }
    if (CELL_TAGS.has(name)) current += ' ';
    if (!BLOCK_TAGS.has(name)) continue;
    flush();
    if (/^h[1-6]$/.test(name)) inHeading = !closing;
    if (name === 'pre') preDepth = Math.max(0, preDepth + (closing ? -1 : 1));
  }
  addText(html.slice(at));
  flush();
  return blocks;
}

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

/** One block per JSON object or array: its path, then each of its own leaves as key and value, so a label binds only within its object. */
export function jsonBlocks(value: unknown, path: readonly string[] = []): PageBlock[] {
  if (typeof value !== 'object' || value === null) return [{ text: squash([...path, String(value)].join(' ')) }];
  const entries = Array.isArray(value) ? value.map((item, i) => [String(i), item] as const) : Object.entries(value);
  const leaves = entries.filter(([, item]) => typeof item !== 'object' || item === null);
  const own = leaves.length === 0 ? [] : [{ text: squash([...path, ...leaves.map(([key, item]) => `${key} ${String(item)}`)].join(' ')) }];
  return [...own, ...entries.filter(([, item]) => typeof item === 'object' && item !== null).flatMap(([key, item]) => jsonBlocks(item, [...path, key]))];
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

const standsAlone = (text: string, label: string): boolean => squash(text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).toLowerCase() === squash(label).toLowerCase();

/**
 * Where `address` stands on the page relative to `label`. They must share one block, or the label must stand alone in
 * the block just before, as in `<p>Name:</p><p>0x…</p>`. They must be at most `MAX_LABEL_ADDRESS_GAP` characters apart,
 * with no other address between them. In a block that holds other addresses, a label binds to the address after it when
 * the block opens with text, as in `Name: 0x…, Name: 0x…`, and to the address before it when the block opens with an
 * address, as in `0x… (Name), 0x… (Name)`. With `heading`, the block's nearest heading must name it too. The address
 * counts only written in lowercase or in its EIP-55 checksum.
 */
export function findOnPage(blocks: readonly PageBlock[], address: Address, label: string, heading?: string): PageMatch {
  const wellCased = new Set([address, checksumAddress(address)]);
  let seen = false;
  let seenWellCased = false;
  let best: Extract<PageMatch, { kind: 'next-to' }> | undefined;
  blocks.forEach((block, i) => {
    const previous = blocks[i - 1]?.text;
    const text = previous !== undefined && standsAlone(previous, label) ? `${previous} ${block.text}` : block.text;
    const found = [...text.matchAll(ADDRESS_TEXT)].map((m) => ({ text: m[0], start: m.index, end: m.index + 42 }));
    const ours = found.filter((f) => f.text.toLowerCase() === address);
    if (ours.length === 0) return;
    seen = true;
    const usable = ours.filter((f) => wellCased.has(f.text as Address));
    if (usable.length === 0) return;
    seenWellCased = true;
    if (heading !== undefined && wordSpans(block.heading ?? '', heading).length === 0) return;
    const others = found.filter((f) => f.text.toLowerCase() !== address);
    const opensWithText = /[\p{L}\p{N}]/u.test(text.slice(0, (found[0] as { start: number }).start));
    for (const spot of usable) {
      for (const name of wordSpans(text, label)) {
        const labelFirst = name.end <= spot.start;
        if (others.length > 0 && labelFirst !== opensWithText) continue;
        const [from, to] = labelFirst ? [name.end, spot.start] : [spot.end, name.start];
        if (to < from || to - from > MAX_LABEL_ADDRESS_GAP) continue;
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

type Unchecked = Extract<CommitCheck, { kind: 'unknown' }>;

const RATE_LIMITED: Unchecked = {
  kind: 'unknown',
  why: 'the GitHub API rate limit is reached (60 requests an hour without a token); the commit is not checked, run again later',
};

async function githubJson(url: string, get: HttpGet): Promise<{ kind: 'json'; status: number; body: unknown } | Unchecked> {
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

type DefaultBranch = { readonly kind: 'branch'; readonly name: string } | Unchecked;

async function defaultBranch(api: string, ref: Extract<GitHubSourceRef, { kind: 'pinned' }>, get: HttpGet): Promise<DefaultBranch> {
  const repo = await githubJson(api, get);
  if (repo.kind !== 'json') return repo;
  if (repo.status === 404) return { kind: 'unknown', why: `GitHub has no repository ${ref.owner}/${ref.repo}` };
  if (repo.status !== 200 || !isRecord(repo.body) || typeof repo.body.default_branch !== 'string') {
    return { kind: 'unknown', why: `GitHub answered HTTP ${repo.status} for ${ref.owner}/${ref.repo} with no default branch` };
  }
  return { kind: 'branch', name: repo.body.default_branch };
}

/**
 * Asks GitHub for the default branch, once per repository, then compares it with the commit. `behind` or `identical`
 * means the commit is in the branch's history. A commit that exists only in a fork is still served under the parent's
 * path, so the path alone proves nothing.
 */
async function checkCommit(ref: Extract<GitHubSourceRef, { kind: 'pinned' }>, get: HttpGet, branches: Map<string, DefaultBranch>): Promise<CommitCheck> {
  const api = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const key = `${ref.owner}/${ref.repo}`.toLowerCase();
  const found = branches.get(key) ?? (await defaultBranch(api, ref, get));
  branches.set(key, found);
  if (found.kind !== 'branch') return found;
  const branch = found.name;
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
  const branches = new Map<string, DefaultBranch>();
  for (const source of new Set(sources)) {
    const url = new URL(source);
    if (isGitHubPage(url)) {
      const ref = githubRef(url);
      if (ref.kind === 'pinned' && !commits.has(commitKey(ref))) commits.set(commitKey(ref), await checkCommit(ref, get, branches));
    }
    const pageUrl = pageUrlOf(source);
    if (!pages.has(pageUrl)) pages.set(pageUrl, await fetchPage(pageUrl, get));
  }
  return { pages, commits };
}

/** GitHub's API refuses a request without a user agent. */
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
