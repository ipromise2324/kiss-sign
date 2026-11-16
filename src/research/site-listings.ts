import { parseAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import type { Page, PageBlock } from './source-page.ts';

/** A read that got no answer: no listing, and no disagreement. */
export type SiteUnread = { readonly kind: 'unread'; readonly why: string };

/** The homepages and GitHub repositories CoinGecko lists for a coin. */
export type CoinLinks = { readonly kind: 'links'; readonly homepages: readonly URL[]; readonly github: readonly URL[] };

/** One Immunefi program: its website, its GitHub organization's URL, and each Ethereum address an `etherscan.io/address/` link in its scope names. */
export type ImmunefiProgram = { readonly slug: string; readonly website: URL | undefined; readonly github: URL | undefined; readonly addresses: ReadonlySet<Address> };

/** The domains GitHub's page for an organization says GitHub verified it controls; empty for an organization GitHub has not verified. */
export type OrgDomains = { readonly kind: 'domains'; readonly domains: readonly string[] } | { readonly kind: 'failed'; readonly why: string } | SiteUnread;

export type SiteListings = {
  /** Each protocol coin by CoinGecko id. */
  readonly coins: ReadonlyMap<string, CoinLinks | SiteUnread>;
  /** Every Immunefi program by slug, or no answer for the list. */
  readonly programs: ReadonlyMap<string, ImmunefiProgram> | SiteUnread;
  /** Each GitHub organization a page is on, in lowercase. */
  readonly orgs: ReadonlyMap<string, OrgDomains>;
};

export const NO_SITE_LISTINGS: SiteListings = { coins: new Map(), programs: new Map(), orgs: new Map() };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function httpsUrl(raw: unknown): URL | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    const url = new URL(raw.includes('://') ? raw.trim() : `https://${raw.trim()}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

const urls = (raw: unknown): URL[] => (Array.isArray(raw) ? raw.map(httpsUrl).filter((url) => url !== undefined) : []);

/** CoinGecko's `/coins/<id>` answer, keeping only `links.homepage` and `links.repos_url.github`. */
export function parseCoinLinks(raw: unknown): CoinLinks {
  const links = isRecord(raw) && isRecord(raw.links) ? raw.links : {};
  return { kind: 'links', homepages: urls(links.homepage), github: urls(isRecord(links.repos_url) ? links.repos_url.github : undefined) };
}

/** Only the fields `parseCoinLinks` reads, for a recording. */
export const trimCoinLinks = (raw: unknown): unknown => {
  const links = isRecord(raw) && isRecord(raw.links) ? raw.links : {};
  return { links: { homepage: links.homepage ?? [], repos_url: { github: isRecord(links.repos_url) ? (links.repos_url.github ?? []) : [] } } };
};

const ETHERSCAN_ADDRESS = /https?:\/\/(?:www\.)?etherscan\.io\/address\/(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/g;

/** Each address an `etherscan.io/address/` link in `text` names, lowercased. */
const etherscanAddresses = (text: string): Address[] => [...text.matchAll(ETHERSCAN_ADDRESS)].map((m) => parseAddress('scope', (m[1] as string).toLowerCase()));

/** The scope text a program's addresses are read from: each asset's URL, then the program's text on its assets. */
function scopeText(program: Record<string, unknown>): string {
  const assets = Array.isArray(program.assets) ? program.assets.filter(isRecord).map((asset) => String(asset.url ?? '')) : [];
  return [...assets, typeof program.assetsBodyV2 === 'string' ? program.assetsBodyV2 : ''].join('\n');
}

/** Immunefi's `public-api/bounties.json`, by program slug. */
export function parseImmunefiPrograms(raw: unknown): Map<string, ImmunefiProgram> {
  if (!Array.isArray(raw)) throw new Error('Immunefi sent no program list');
  const programs = new Map<string, ImmunefiProgram>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item.slug !== 'string' || item.slug === '') continue;
    programs.set(item.slug, { slug: item.slug, website: httpsUrl(item.websiteUrl), github: httpsUrl(item.githubUrl), addresses: new Set(etherscanAddresses(scopeText(item))) });
  }
  return programs;
}

/** The programs `slugs` name, cut to what `parseImmunefiPrograms` reads, with the scope kept only as its etherscan.io address links. */
export function trimImmunefiPrograms(raw: unknown, slugs: ReadonlySet<string>): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.slug === 'string' && slugs.has(item.slug))
    .map((item) => ({
      slug: item.slug,
      websiteUrl: item.websiteUrl ?? null,
      githubUrl: item.githubUrl ?? null,
      assetsBodyV2: [...new Set(etherscanAddresses(scopeText(item)))].map((address) => `https://etherscan.io/address/${address}`).join('\n'),
    }));
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const VERIFIED_END = 'Learn more about verified organizations';

/**
 * The domains on GitHub's page for `org`, as served: the badge `Verified`, the sentence that GitHub verified the
 * organization controls the domain, one block per domain, then GitHub's link on verified organizations. The whole run
 * must stand in that order, so text the organization wrote, a description or a location, cannot make one up.
 */
export function verifiedDomains(page: Page, org: string): OrgDomains {
  if (page.kind !== 'served') return page;
  const { blocks } = page;
  const sentence = new RegExp(`^We(?:'|’)ve verified that the organization (\\S+) controls the domains?:$`);
  for (let i = 1; i < blocks.length; i++) {
    const said = sentence.exec((blocks[i] as PageBlock).text);
    if (said === null || (blocks[i - 1] as PageBlock).text !== 'Verified' || (said[1] as string).toLowerCase() !== org.toLowerCase()) continue;
    const domains: string[] = [];
    let at = i + 1;
    while (at < blocks.length && DOMAIN.test((blocks[at] as PageBlock).text)) domains.push((blocks[at++] as PageBlock).text.toLowerCase());
    if (domains.length > 0 && blocks[at]?.text === VERIFIED_END) return { kind: 'domains', domains };
  }
  return { kind: 'domains', domains: [] };
}

/** A page that gives `found` again to `verifiedDomains`, for a recording: only the verified run, or no blocks for none. */
export const orgPageOf = (found: OrgDomains, org: string): Page =>
  found.kind !== 'domains'
    ? found
    : {
        kind: 'served',
        blocks:
          found.domains.length === 0
            ? []
            : [{ text: 'Verified' }, { text: `We've verified that the organization ${org} controls the domain:` }, ...found.domains.map((text) => ({ text })), { text: VERIFIED_END }],
      };

/** The organization a github.com URL names, in lowercase; undefined for any other URL. */
export function githubOrg(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return undefined;
  const [first, second] = url.pathname.split('/').filter((s) => s !== '');
  const org = first === 'orgs' ? second : first;
  return org === undefined ? undefined : org.toLowerCase();
}
