import { request } from 'node:https';
import { fallbackLookup, publicHost } from '../chain/dns.ts';
import { requestText, retried, transientError, transientStatus } from '../chain/https.ts';
import type { HttpAnswer, NoteUnread, RequestFn } from '../chain/https.ts';
import type { ApiAnswers } from './api-source.ts';
import type { Creations } from './deployer.ts';
import { githubAuthorization, noteTokenRejected } from './github-token.ts';
import type { GithubToken } from './github-token.ts';
import type { PackageReads } from './npm-package.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';

/** One unit of a page's text: a table row, a list item, a paragraph, a line, or one JSON leaf with its key path. */
export type PageBlock = { readonly text: string; readonly heading?: string };

/** `failed` is an answer that is not the page, such as a 404 or a redirect; `unread` is no answer at all, which no check may read as a disagreement. */
export type Page =
  | { readonly kind: 'served'; readonly blocks: readonly PageBlock[] }
  | { readonly kind: 'failed'; readonly why: string }
  | { readonly kind: 'unread'; readonly why: string };

export type CommitCheck =
  | { readonly kind: 'on-default'; readonly branch: string; readonly status: 'behind' | 'identical' }
  | { readonly kind: 'off-default'; readonly branch: string; readonly status: string }
  | { readonly kind: 'unknown'; readonly why: string }
  | { readonly kind: 'unread'; readonly why: string };

/** What each page, commit and entry's API answered. An entry whose API request has no answer here was not read. */
export type SourcePages = {
  readonly pages: ReadonlyMap<string, Page>;
  readonly commits: ReadonlyMap<string, CommitCheck>;
  readonly apis?: ApiAnswers;
  /** Each SDK package version an entry names, by `<package>@<version>`. */
  readonly packages?: PackageReads;
  /** Each entry's creation, by address. */
  readonly creations?: Creations;
};

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

const percentDecoded = (text: string): string => text.replace(/%([0-9a-fA-F]{2})/g, (_, byte: string) => String.fromCharCode(parseInt(byte, 16)));

/** Whether the URL holds the address in any letter case, plain or percent-encoded, as a server that echoes it would decode it. */
export const sourceHoldsAddress = (source: string, address: Address): boolean => percentDecoded(source).toLowerCase().includes(address.slice(2));

/**
 * The page a URL names, as one key for two spellings of it: the URL `pageUrlOf` reads, with no fragment and its path
 * percent-decoded, and a GitHub owner and repository in lowercase, since GitHub ignores their case.
 */
export function samePageKey(source: string): string {
  const url = new URL(pageUrlOf(source));
  const path = percentDecoded(url.pathname);
  const key = url.hostname === 'raw.githubusercontent.com' ? path.replace(/^\/[^/]*\/[^/]*/, (repo) => repo.toLowerCase()) : path;
  return `${url.hostname}${key}${url.search}`;
}

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
  let seen = false;
  let seenWellCased = false;
  let best: Extract<PageMatch, { kind: 'next-to' }> | undefined;
  blocks.forEach((block, i) => {
    const text = blockText(blocks, i, label);
    const found = spotsIn(text);
    const ours = found.filter((f) => f.text.toLowerCase() === address);
    if (ours.length === 0) return;
    seen = true;
    const usable = ours.filter((f) => wellCased(f.text));
    if (usable.length === 0) return;
    seenWellCased = true;
    if (!underHeading(block, heading)) return;
    for (const spot of usable) {
      const near = nearestLabel(text, found, spot, label);
      if (near !== undefined && (best === undefined || near.gap < best.gap)) best = { kind: 'next-to', ...near };
    }
  });
  if (best !== undefined) return best;
  if (!seen) return { kind: 'absent' };
  return seenWellCased ? { kind: 'apart' } : { kind: 'miscased' };
}

/** Every address `label` binds on the page, by the rule `findOnPage` states, whatever address the entry holds; lowercase, in page order. */
export function labelBindings(blocks: readonly PageBlock[], label: string, heading?: string): Address[] {
  const bound = new Set<Address>();
  blocks.forEach((block, i) => {
    if (!underHeading(block, heading)) return;
    const text = blockText(blocks, i, label);
    const found = spotsIn(text);
    for (const spot of found) if (wellCased(spot.text) && nearestLabel(text, found, spot, label) !== undefined) bound.add(spot.text.toLowerCase() as Address);
  });
  return [...bound];
}

type Spot = Span & { readonly text: string };

/** A block's text, after the block before it when that one holds the label alone. */
function blockText(blocks: readonly PageBlock[], i: number, label: string): string {
  const previous = blocks[i - 1]?.text;
  const text = (blocks[i] as PageBlock).text;
  return previous !== undefined && standsAlone(previous, label) ? `${previous} ${text}` : text;
}

const spotsIn = (text: string): Spot[] => [...text.matchAll(ADDRESS_TEXT)].map((m) => ({ text: m[0], start: m.index, end: m.index + 42 }));

const wellCased = (text: string): boolean => text === text.toLowerCase() || text === checksumAddress(text.toLowerCase() as Address);

const underHeading = (block: PageBlock, heading: string | undefined): boolean => heading === undefined || wordSpans(block.heading ?? '', heading).length > 0;

/** The closest `label` in `text` that binds to the address at `spot`, with no other address between them. */
function nearestLabel(text: string, found: readonly Spot[], spot: Spot, label: string): { gap: number; labelFirst: boolean } | undefined {
  const others = found.filter((f) => f.text.toLowerCase() !== spot.text.toLowerCase());
  const opensWithText = /[\p{L}\p{N}]/u.test(text.slice(0, (found[0] as Spot).start));
  let best: { gap: number; labelFirst: boolean } | undefined;
  for (const name of wordSpans(text, label)) {
    const labelFirst = name.end <= spot.start;
    if (others.length > 0 && labelFirst !== opensWithText) continue;
    const [from, to] = labelFirst ? [name.end, spot.start] : [spot.end, name.start];
    if (to < from || to - from > MAX_LABEL_ADDRESS_GAP) continue;
    if (others.some((o) => o.start < to && o.end > from)) continue;
    if (best === undefined || to - from < best.gap) best = { gap: to - from, labelFirst };
  }
  return best;
}

const header = (answer: HttpAnswer, name: string): string => {
  const value = answer.headers?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
};

export async function fetchPage(url: string, get: HttpGet): Promise<Page> {
  let answer: HttpAnswer;
  try {
    answer = await get(url);
  } catch (error) {
    const refused = (error as { code?: unknown }).code === 'ENOTPUBLIC';
    return { kind: transientError(error) ? 'unread' : 'failed', why: refused ? (error as Error).message : `${new URL(url).hostname} unreachable` };
  }
  const transient = transientStatus(answer);
  if (transient !== undefined) return { kind: 'unread', why: `${url} answered ${transient}` };
  if (answer.status >= 300 && answer.status < 400) {
    const location = header(answer, 'location');
    const target = URL.canParse(location, url) ? new URL(location, url).href : 'nowhere readable';
    return { kind: 'failed', why: `${url} answered HTTP ${answer.status}, redirecting to ${target}; name the page itself as the source` };
  }
  if (answer.status !== 200) return { kind: 'failed', why: `${url} answered HTTP ${answer.status}` };
  return { kind: 'served', blocks: pageBlocks(url, header(answer, 'content-type'), answer.text) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Unchecked = Extract<CommitCheck, { kind: 'unknown' | 'unread' }>;

async function githubJson(url: string, get: HttpGet): Promise<{ kind: 'json'; status: number; body: unknown } | Unchecked> {
  let answer: HttpAnswer;
  try {
    answer = await get(url);
  } catch (error) {
    return { kind: transientError(error) ? 'unread' : 'unknown', why: 'api.github.com unreachable; the commit is not checked' };
  }
  const transient = transientStatus(answer, true);
  if (transient !== undefined) {
    const limit = transient.startsWith('rate limited') ? ', the GitHub API rate limit (60 requests an hour without GITHUB_TOKEN, 5,000 with it)' : '';
    return { kind: 'unread', why: `api.github.com answered ${transient}${limit}; the commit is not checked, run again later` };
  }
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
  if (repo.status !== 200 || !isRecord(repo.body) || typeof repo.body.default_branch !== 'string' || !/^[A-Za-z0-9._/-]{1,100}$/.test(repo.body.default_branch)) {
    return { kind: 'unknown', why: `GitHub answered HTTP ${repo.status} for ${ref.owner}/${ref.repo} with no default branch` };
  }
  return { kind: 'branch', name: repo.body.default_branch };
}

/**
 * Asks GitHub for the default branch, once per repository, then compares it with the commit. `behind` or `identical`
 * means the commit is in the branch's history. A commit that exists only in a fork is still served under the parent's
 * path, so the path alone proves nothing.
 */
export async function checkCommit(ref: Extract<GitHubSourceRef, { kind: 'pinned' }>, get: HttpGet, branches: Map<string, DefaultBranch>): Promise<CommitCheck> {
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

/** Each source page, each pinned github.com page's commit check, and, for a commit on the default branch, that file at the branch's tip. */
export async function gatherSourcePages(sources: readonly string[], get: HttpGet, apis?: ApiAnswers): Promise<SourcePages> {
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
    const tip = tipUrlOf(source, commits);
    if (tip !== undefined && !pages.has(tip.url)) pages.set(tip.url, await fetchPage(tip.url, get));
  }
  return { pages, commits, ...(apis === undefined ? {} : { apis }) };
}

/**
 * The raw URL of a pinned github.com page's file at the tip of its repository's default branch, when GitHub's compare
 * put the commit on that branch; the commit's own page is read as the source, this one as its newest version.
 */
export function tipUrlOf(source: string, commits: SourcePages['commits']): { readonly url: string; readonly branch: string } | undefined {
  const url = new URL(source);
  if (!isGitHubPage(url)) return undefined;
  const ref = githubRef(url);
  if (ref.kind !== 'pinned') return undefined;
  const check = commits.get(commitKey(ref));
  if (check?.kind !== 'on-default') return undefined;
  const branch = check.branch.split('/').map(encodeURIComponent).join('/');
  return { url: `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/refs/heads/${branch}/${ref.path}`, branch: check.branch };
}

/** `get`, asking again after each pause while it gets no answer, and noting each read that never got one. */
export const retryingGet =
  (get: HttpGet, note: NoteUnread, pausesMs?: readonly number[]): HttpGet =>
  (url) =>
    retried(url, () => get(url), (answer) => transientStatus(answer, new URL(url).hostname === 'api.github.com'), note, pausesMs);

/**
 * GitHub's API refuses a request without a user agent. A host that is not public is refused: the URLs come from the
 * registry. A redirect is an answer, never followed, so the GitHub token cannot reach another host.
 */
export function httpsGet(githubToken?: GithubToken, send: RequestFn = request): HttpGet {
  return (url) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') return Promise.reject(new Error('not https'));
    const refused = publicHost(target.hostname);
    if (refused !== undefined) return Promise.reject(Object.assign(new Error(refused), { code: 'ENOTPUBLIC' }));
    const read = (authorization: { readonly authorization?: string }) =>
      requestText(
        send,
        {
          hostname: target.hostname,
          path: target.pathname + target.search,
          headers: {
            'user-agent': 'kiss-sign',
            accept: target.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'text/html, application/json, text/plain',
            ...authorization,
          },
          servername: target.hostname,
          rejectUnauthorized: true,
          lookup: fallbackLookup(undefined, true),
          signal: AbortSignal.timeout(60_000),
        },
        undefined,
        32 * 1024 * 1024,
      );
    const authorization = githubAuthorization(url, githubToken);
    if (authorization.authorization === undefined) return read({});
    return read(authorization).then((answer) => (answer.status === 401 ? (noteTokenRejected(), read({})) : answer));
  };
}
