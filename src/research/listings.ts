import { request } from 'node:https';
import { fallbackLookup } from '../chain/dns.ts';
import { requestText } from '../chain/https.ts';
import { COINGECKO_KINDS } from '../registry.ts';
import type { RegistryEntry } from '../registry.ts';
import { SafeTxParseError, checksumAddress, parseAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import { registrableDomain } from './public-suffix.ts';
import type { PublicSuffixList, SuffixListUnavailable } from './public-suffix.ts';
import { MAX_GAP, commitKey, findOnPage, githubRef, isGitHubPage, pageUrlOf, sourceHoldsAddress } from './source-page.ts';
import type { CommitCheck, Page, PageBlock, SourcePages } from './source-page.ts';

export type DefiLlamaProtocol = { readonly slug: string; readonly name: string; readonly url: URL | undefined; readonly github: readonly string[] };

export type CoinGeckoCoin = { readonly id: string; readonly symbol: string; readonly name: string; readonly ethereum: Address };

export type Listings = {
  readonly protocols: ReadonlyMap<string, readonly DefiLlamaProtocol[]>;
  readonly coinsByAddress: ReadonlyMap<Address, readonly CoinGeckoCoin[]>;
  readonly suffixes: PublicSuffixList | SuffixListUnavailable;
};

/** What `check-sources` saw for one entry. A `finding` is for the signer to judge; `agrees` is evidence for the report. */
export type Line = { readonly kind: 'agrees' | 'finding'; readonly check: 'defillama' | 'coingecko' | 'url' | 'github' | 'page'; readonly text: string };
/** `site` is where the source lives: its registrable domain, or `github.com/<org>`. */
export type EntryResult = { readonly entry: RegistryEntry; readonly site: string; readonly lines: readonly Line[] };

export class ListingError extends Error {
  override name = 'ListingError';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function httpsUrl(raw: unknown): URL | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** A protocol without a slug is skipped. */
export function parseDefiLlamaProtocols(raw: unknown): Map<string, DefiLlamaProtocol[]> {
  if (!Array.isArray(raw)) throw new ListingError('DefiLlama sent no protocol list');
  const protocols = new Map<string, DefiLlamaProtocol[]>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item.slug !== 'string' || item.slug === '') continue;
    const github = Array.isArray(item.github) ? item.github.filter((g): g is string => typeof g === 'string' && g !== '') : [];
    const protocol = { slug: item.slug, name: typeof item.name === 'string' ? item.name : item.slug, url: httpsUrl(item.url), github };
    protocols.set(item.slug, [...(protocols.get(item.slug) ?? []), protocol]);
  }
  if (protocols.size === 0) throw new ListingError('DefiLlama sent an empty protocol list');
  return protocols;
}

/** Parses CoinGecko's `/coins/list?include_platform=true` answer, keeping coins with a well-formed Ethereum address. */
export function parseCoinGeckoCoins(raw: unknown): Map<Address, CoinGeckoCoin[]> {
  if (!Array.isArray(raw)) throw new ListingError('CoinGecko sent no coin list');
  const byAddress = new Map<Address, CoinGeckoCoin[]>();
  for (const item of raw) {
    if (!isRecord(item) || !isRecord(item.platforms) || typeof item.id !== 'string') continue;
    let ethereum: Address;
    try {
      ethereum = parseAddress('ethereum', item.platforms.ethereum);
    } catch (error) {
      if (error instanceof SafeTxParseError) continue;
      throw error;
    }
    const coin = { id: item.id, symbol: String(item.symbol ?? ''), name: String(item.name ?? ''), ethereum };
    byAddress.set(ethereum, [...(byAddress.get(ethereum) ?? []), coin]);
  }
  if (byAddress.size === 0) throw new ListingError('CoinGecko sent no Ethereum coins');
  return byAddress;
}

type GitHubSource = { readonly kind: 'org'; readonly org: string } | { readonly kind: 'no-org'; readonly why: string } | { readonly kind: 'not-github' };

function githubSource(url: URL): GitHubSource {
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && !host.endsWith('.github.com')) return { kind: 'not-github' };
  if (host !== 'github.com' && host !== 'www.github.com') return { kind: 'no-org', why: `source host ${host} is not a GitHub repository page` };
  const segments = url.pathname.split('/').filter((s) => s !== '');
  const org = segments[0] === 'orgs' ? segments[1] : segments[0];
  return org === undefined ? { kind: 'no-org', why: `source ${url.href} names no GitHub org` } : { kind: 'org', org: org.toLowerCase() };
}

function websiteLine(source: URL, protocol: DefiLlamaProtocol, label: string, suffixes: Listings['suffixes']): Line {
  const finding = (text: string): Line => ({ kind: 'finding', check: 'defillama', text });
  if ('unavailable' in suffixes) return finding(`Public Suffix List unavailable (${suffixes.unavailable}); source domain not compared`);
  if (protocol.url === undefined) return finding(`DefiLlama has no website for ${label}; source host ${source.hostname} not compared`);
  const ours = registrableDomain(source.hostname, suffixes);
  if (ours === undefined) return finding(`source host ${source.hostname} has no registrable domain under the Public Suffix List; not compared`);
  const theirs = registrableDomain(protocol.url.hostname, suffixes);
  if (theirs === undefined) return finding(`${label}'s website ${protocol.url.hostname} has no registrable domain under the Public Suffix List; not compared`);
  if (ours === theirs) return { kind: 'agrees', check: 'defillama', text: `source domain ${ours} equals ${label}'s website ${protocol.url.hostname} (${theirs})` };
  return finding(`source domain ${ours} differs from ${label}'s website ${protocol.url.hostname} (${theirs})`);
}

function defillamaLine(entry: RegistryEntry, listings: Listings): Line {
  const finding = (text: string): Line => ({ kind: 'finding', check: 'defillama', text });
  if (entry.defillama === undefined) return finding('the entry names no DefiLlama protocol; source not compared');
  const listed = listings.protocols.get(entry.defillama) ?? [];
  const [protocol] = listed;
  if (protocol === undefined) return finding(`DefiLlama lists no protocol "${entry.defillama}"`);
  if (listed.length > 1) return finding(`DefiLlama lists ${listed.length} protocols with slug "${entry.defillama}": ${listed.map((p) => p.name).join(', ')}; not compared`);
  const source = new URL(entry.source);
  const label = `${protocol.slug} (${protocol.name})`;
  const github = githubSource(source);
  if (github.kind === 'not-github') return websiteLine(source, protocol, label, listings.suffixes);
  if (github.kind === 'no-org') return finding(`${github.why}; not compared`);
  if (protocol.github.length === 0) return finding(`source is GitHub org ${github.org}; DefiLlama names no GitHub org for ${label}, so it is not compared`);
  const orgs = protocol.github.map((g) => g.toLowerCase());
  if (orgs.includes(github.org)) return { kind: 'agrees', check: 'defillama', text: `GitHub org ${github.org} is one ${label} names: ${orgs.join(', ')}` };
  return finding(`source is GitHub org ${github.org}; ${label} names ${orgs.join(', ')}`);
}

const coinLabel = (c: CoinGeckoCoin) => `${c.id} (${c.symbol.toUpperCase()}, "${c.name}")`;

function coingeckoLine(entry: RegistryEntry, coinsByAddress: Listings['coinsByAddress']): Line {
  const finding = (text: string): Line => ({ kind: 'finding', check: 'coingecko', text });
  const coins = coinsByAddress.get(entry.address) ?? [];
  const [coin] = coins;
  const names = entry.coingecko === undefined ? 'the entry names no CoinGecko coin' : `the entry names coin ${entry.coingecko}`;
  if (coin === undefined) return finding(`no CoinGecko listing at this address on ethereum (${names})`);
  if (coins.length > 1) return finding(`CoinGecko lists more than one coin at this address: ${coins.map(coinLabel).join(', ')}`);
  if (coin.id !== entry.coingecko) return finding(`${names}; CoinGecko lists ${coinLabel(coin)} at this address`);
  return { kind: 'agrees', check: 'coingecko', text: `CoinGecko lists ${coinLabel(coin)} at this address, the coin the entry names` };
}

const hasCoin = (entry: RegistryEntry) => COINGECKO_KINDS.includes(entry.kind);

function githubLine(source: URL, commits: SourcePages['commits']): Line {
  const finding = (text: string): Line => ({ kind: 'finding', check: 'github', text });
  const ref = githubRef(source);
  if (ref.kind === 'unpinned') return finding('not pinned to a commit: name the file as github.com/<org>/<repo>/blob/<40-hex commit>/<path>');
  const check: CommitCheck = commits.get(commitKey(ref)) ?? { kind: 'unknown', why: 'the commit was not checked' };
  const at = `commit ${ref.commit.slice(0, 12)} of ${ref.owner}/${ref.repo}`;
  if (check.kind === 'unknown') return finding(`${at}: ${check.why}`);
  if (check.kind === 'off-default') return finding(`${at} is not on the default branch ${check.branch} (GitHub compare: ${check.status})`);
  return { kind: 'agrees', check: 'github', text: `${at} is on the default branch ${check.branch} (GitHub compare: ${check.status})` };
}

function pageLine(entry: RegistryEntry, pages: SourcePages['pages']): Line {
  const finding = (text: string): Line => ({ kind: 'finding', check: 'page', text });
  const url = pageUrlOf(entry.source);
  const page: Page = pages.get(url) ?? { kind: 'failed', why: `${url} was not fetched` };
  if (page.kind === 'failed') return finding(page.why);
  if (entry.sourceLabel === undefined) return finding('the entry names no sourceLabel, so where the address stands on the page is not checked');
  const label = `"${entry.sourceLabel}"`;
  const under = entry.sourceHeading === undefined ? '' : ` under a heading naming "${entry.sourceHeading}"`;
  const match = findOnPage(page.blocks, entry.address, entry.sourceLabel, entry.sourceHeading);
  switch (match.kind) {
    case 'absent':
      return finding(`the address is not found on the page as served (${url}); a page that shows it only by running JavaScript is not read`);
    case 'miscased':
      return finding('the address is on the page only in a letter case that is neither lowercase nor its EIP-55 checksum');
    case 'apart':
      return finding(`the address is on the page, but not within ${MAX_GAP} characters of ${label}${under} in one block with no other address between`);
    case 'next-to':
      return { kind: 'agrees', check: 'page', text: `the page has the address ${match.gap} characters ${match.labelFirst ? 'after' : 'before'} ${label}${under}` };
  }
}

function siteOf(source: URL, suffixes: Listings['suffixes']): string {
  if (isGitHubPage(source)) return `github.com/${source.pathname.split('/').filter((s) => s !== '')[0]?.toLowerCase() ?? ''}`;
  return ('unavailable' in suffixes ? undefined : registrableDomain(source.hostname, suffixes)) ?? source.hostname;
}

export function checkSources(entries: readonly RegistryEntry[], listings: Listings, pages: SourcePages): EntryResult[] {
  return entries.map((entry) => {
    const source = new URL(entry.source);
    const echoes = sourceHoldsAddress(entry.source, entry.address);
    return {
      entry,
      site: siteOf(source, listings.suffixes),
      lines: [
        defillamaLine(entry, listings),
        ...(hasCoin(entry) ? [coingeckoLine(entry, listings.coinsByAddress)] : []),
        ...(isGitHubPage(source) ? [githubLine(source, pages.commits)] : []),
        echoes
          ? { kind: 'finding', check: 'url', text: 'the source URL holds the address, and a page echoes its own URL; the page is not read' }
          : pageLine(entry, pages.pages),
      ],
    };
  });
}

export function formatResults(results: readonly EntryResult[]): string {
  const out: string[] = [];
  for (const { entry, lines } of results) {
    out.push(`${entry.name} ${checksumAddress(entry.address)} (${entry.kind})`, `  source     ${entry.source}`);
    for (const line of lines) out.push(`  ${line.check.padEnd(10)} ${line.kind === 'finding' ? 'FINDING ' : 'agrees  '}${line.text}`);
  }
  const bySlug = new Map<string, Map<string, string[]>>();
  for (const { entry, site } of results) {
    const sites = bySlug.get(entry.defillama ?? '(no defillama slug)') ?? new Map<string, string[]>();
    sites.set(site, [...(sites.get(site) ?? []), entry.name]);
    bySlug.set(entry.defillama ?? '(no defillama slug)', sites);
  }
  out.push('', 'sites per protocol, for the signer to check each is the protocol\'s own:');
  for (const [slug, sites] of bySlug) {
    out.push(`  ${slug}`);
    for (const [site, names] of sites) out.push(`    ${site}: ${names.join(', ')}`);
  }
  const findings = results.flatMap((r) => r.lines.filter((l) => l.kind === 'finding').map(() => r.entry.name));
  out.push('', `${results.length} entries, ${findings.length} findings${findings.length > 0 ? ` (${[...new Set(findings)].join(', ')})` : ''}`);
  return out.join('\n');
}

export const DEFILLAMA_PROTOCOLS = { hostname: 'api.llama.fi', path: '/protocols' } as const;
export const COINGECKO_COINS = { hostname: 'api.coingecko.com', path: '/api/v3/coins/list?include_platform=true' } as const;

/** Both answers are public and need no key. */
export async function fetchListing(target: { readonly hostname: string; readonly path: string }): Promise<unknown> {
  let answer;
  try {
    answer = await requestText(
      request,
      {
        hostname: target.hostname,
        path: target.path,
        headers: { accept: 'application/json', 'user-agent': 'kiss-sign' },
        rejectUnauthorized: true,
        lookup: fallbackLookup(),
        signal: AbortSignal.timeout(60_000),
      },
      undefined,
      64 * 1024 * 1024,
    );
  } catch {
    throw new ListingError(`${target.hostname} unreachable`);
  }
  if (answer.status !== 200) throw new ListingError(`${target.hostname} answered HTTP ${answer.status}`);
  try {
    return JSON.parse(answer.text);
  } catch {
    throw new ListingError(`${target.hostname} sent no JSON`);
  }
}

export type ListingsRecording = {
  readonly fetched: string;
  readonly defillama: readonly { slug: string; name: string; url?: string; github: readonly string[] }[];
  readonly coingecko: readonly { id: string; symbol: string; name: string; platforms: { ethereum: Address } }[];
  /** Each page's blocks that hold a registry address, each with its heading, so the page checks replay unchanged. */
  readonly pages: Readonly<Record<string, Page>>;
  readonly commits: Readonly<Record<string, CommitCheck>>;
};

export function sourcePagesOf(recording: Pick<ListingsRecording, 'pages' | 'commits'>): SourcePages {
  return { pages: new Map(Object.entries(recording.pages)), commits: new Map(Object.entries(recording.commits)) };
}

function trimPage(page: Page, addresses: readonly Address[]): Page {
  if (page.kind === 'failed') return page;
  const holds = (block: PageBlock | undefined) => block !== undefined && addresses.some((a) => block.text.toLowerCase().includes(a.slice(2)));
  return { kind: 'served', blocks: page.blocks.filter((block, i) => holds(block) || holds(page.blocks[i + 1])) };
}

export function trimForRecording(entries: readonly RegistryEntry[], listings: Listings, pages: SourcePages, fetched: Date): ListingsRecording {
  const slugs = new Set(entries.flatMap((e) => (e.defillama === undefined ? [] : [e.defillama])));
  const addresses = new Set(entries.filter(hasCoin).map((e) => e.address));
  return {
    fetched: fetched.toISOString().slice(0, 10),
    defillama: [...slugs]
      .flatMap((slug) => listings.protocols.get(slug) ?? [])
      .map(({ slug, name, url, github }) => ({ slug, name, ...(url === undefined ? {} : { url: url.href }), github })),
    coingecko: [...addresses]
      .flatMap((address) => listings.coinsByAddress.get(address) ?? [])
      .map(({ id, symbol, name, ethereum }) => ({ id, symbol, name, platforms: { ethereum } })),
    pages: Object.fromEntries(
      [...pages.pages].map(([url, page]) => [url, trimPage(page, entries.filter((e) => pageUrlOf(e.source) === url).map((e) => e.address))]),
    ),
    commits: Object.fromEntries(pages.commits),
  };
}
