import { request } from 'node:https';
import { fallbackLookup } from '../chain/dns.ts';
import { requestText, retried, transientError, transientStatus } from '../chain/https.ts';
import type { NoteUnread } from '../chain/https.ts';
import { COINGECKO_KINDS, pageUrlsOf } from '../registry.ts';
import type { RegistryEntry, SdkPackage, SourcePage } from '../registry.ts';
import { latestOf, packageKey } from './npm-package.ts';
import { sharedDeployer } from './deployer.ts';
import type { Creation, CreationVia, Creations } from './deployer.ts';
import type { PackageRead } from './npm-package.ts';
import { SafeTxParseError, checksumAddress, parseAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import { apiKey, pathText, pruneAnswers, walkPath } from './api-source.ts';
import type { ApiAnswer } from './api-source.ts';
import { registrableDomain } from './public-suffix.ts';
import { IMMUNEFI_WEBSITE_ASSET, SiteListingError, githubOrg, httpsUrl, parseCoinLinks, parseImmunefiPrograms, verifiedDomains } from './site-listings.ts';
import type { CoinLinks, ImmunefiProgram, OrgDomains, SiteListings, SiteUnread } from './site-listings.ts';
import type { PublicSuffixList, SuffixListUnavailable } from './public-suffix.ts';
import type { GithubToken } from './github-token.ts';
import { MAX_LABEL_ADDRESS_GAP, commitKey, fetchPage, findOnPage, githubRef, httpsGet, isGitHubPage, labelBindings, pageUrlOf, retryingGet, sourceHoldsAddress, tipUrlOf } from './source-page.ts';
import type { CommitCheck, HttpGet, Page, PageBlock, SourcePages } from './source-page.ts';

/** A protocol DefiLlama lists, with the CoinGecko coin it names (`gecko_id`) and the parent protocol it belongs to, such as Fluid for `fluid-lending`. */
export type DefiLlamaProtocol = {
  readonly slug: string;
  readonly name: string;
  readonly url: URL | undefined;
  readonly github: readonly string[];
  readonly gecko: string | undefined;
  readonly parent: DefiLlamaParent | undefined;
};
export type DefiLlamaParent = { readonly id: string; readonly name: string; readonly url: URL | undefined; readonly github: readonly string[]; readonly gecko: string | undefined };

export type CoinGeckoCoin = { readonly id: string; readonly symbol: string; readonly name: string; readonly ethereum: Address };

export type Listings = {
  readonly protocols: ReadonlyMap<string, readonly DefiLlamaProtocol[]>;
  readonly coinsByAddress: ReadonlyMap<Address, readonly CoinGeckoCoin[]>;
  readonly suffixes: PublicSuffixList | SuffixListUnavailable;
  readonly sites: SiteListings;
};

/** A place that lists one of a protocol's sites: DefiLlama by protocol slug, CoinGecko by coin id, Immunefi by program, GitHub by the organization it verified. */
export type SitePlace = { readonly kind: 'defillama' | 'coingecko' | 'immunefi' | 'github'; readonly id: string };

/**
 * Why a check did not agree: `differs` for a real disagreement (another domain, GitHub org or coin, or an API answer
 * that is not the entry's address), `unexplained` for anything else the program cannot excuse, such as a slug DefiLlama
 * does not list or an address away from its label, `other-address` when a pinned page or SDK file binds the label
 * only to other addresses, `unlisted` when the listing holds nothing to compare with,
 * `not-served` when the page as served does not show the address, `not-fetched` when the page's or API's server
 * answered with something other than the page or JSON, such as a 404 or a redirect, `unattested` when npm holds no
 * provenance for an SDK's version.
 */
export type FindingCause = 'differs' | 'other-address' | 'unexplained' | 'unlisted' | 'not-served' | 'not-fetched' | 'unattested';
/**
 * `api` is the address the entry's `apiSource` answers; `api-site` its URL's site against the DefiLlama protocol, as
 * `defillama` compares the source's. `tip` and `sdk-latest` are the addresses the newest version of a pinned GitHub page
 * or SDK binds to the same label.
 */
type CheckName = 'defillama' | 'coingecko' | 'url' | 'github' | 'tip' | 'page' | 'api' | 'api-site' | 'bounty' | 'sdk' | 'sdk-site' | 'sdk-latest' | 'deployer';

/** Who deployed an entry, and the other entries of its protocol the run checks that the same sender deployed. */
export type DeployerShare = { readonly deployer: Address; readonly siblings: readonly string[] };
/**
 * What `check-sources` saw for one entry. A `finding` is for the signer to judge; `agrees` is evidence for the report;
 * `unverifiable` means a read got no answer, which is no disagreement and is read again; `absent` that a place the
 * program reads does not list the address, which is neither evidence nor a disagreement. `more` numbers, from 1, the
 * entry's `moreSources` page a `page`, `defillama` or `github` line is about; absent, the line is about `source`.
 */
export type Line = (
  | { readonly kind: 'agrees'; readonly check: CheckName; readonly text: string }
  | { readonly kind: 'unverifiable'; readonly check: CheckName; readonly text: string }
  | { readonly kind: 'absent'; readonly check: CheckName; readonly text: string }
  | { readonly kind: 'finding'; readonly check: CheckName; readonly text: string; readonly cause: FindingCause }
) & {
  readonly more?: number;
  readonly places?: readonly SitePlace[];
  readonly shared?: DeployerShare;
  /** The Immunefi program a bounty line names. */
  readonly program?: string;
  /** The addresses a pinned page, SDK file or newest version binds the label to instead of the entry's. */
  readonly others?: readonly Address[];
};
/** `sites` holds the site of each page that lists the address, the `source` first. */
export type EntryResult = { readonly entry: RegistryEntry; readonly sites: readonly string[]; readonly lines: readonly Line[] };

export class ListingError extends Error {
  override name = 'ListingError';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);


const githubOrgs = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string' && g !== '') : []);
const geckoId = (raw: unknown): string | undefined => (typeof raw === 'string' && COINGECKO_COIN_ID.test(raw) ? raw : undefined);

/** DefiLlama's `lite/protocols2` answer, by parent protocol id, such as `parent#fluid`. */
function parseDefiLlamaParents(raw: unknown): Map<string, DefiLlamaParent> {
  const list = isRecord(raw) && Array.isArray(raw.parentProtocols) ? raw.parentProtocols : [];
  const parents = new Map<string, DefiLlamaParent>();
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    parents.set(item.id, { id: item.id, name: typeof item.name === 'string' ? item.name : item.id, url: httpsUrl(item.url), github: githubOrgs(item.github), gecko: geckoId(item.gecko_id) });
  }
  return parents;
}

/** A protocol without a slug is skipped. `parentsRaw` is DefiLlama's `lite/protocols2` answer, which names each parent protocol. */
export function parseDefiLlamaProtocols(raw: unknown, parentsRaw: unknown = {}): Map<string, DefiLlamaProtocol[]> {
  if (!Array.isArray(raw)) throw new ListingError('DefiLlama sent no protocol list');
  const parents = parseDefiLlamaParents(parentsRaw);
  const protocols = new Map<string, DefiLlamaProtocol[]>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item.slug !== 'string' || item.slug === '') continue;
    const parent = typeof item.parentProtocol === 'string' ? parents.get(item.parentProtocol) : undefined;
    const protocol = { slug: item.slug, name: typeof item.name === 'string' ? item.name : item.slug, url: httpsUrl(item.url), github: githubOrgs(item.github), gecko: geckoId(item.gecko_id), parent };
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

/**
 * DefiLlama lists a protocol's website and GitHub organizations as the protocol's own, so a site it does not list differs.
 * CoinGecko and Immunefi list a homepage or some repositories, never all of a protocol's sites, so they only add sites.
 */
type ProtocolSites = {
  /** Each registrable domain a place lists as the protocol's website. */
  readonly domains: ReadonlyMap<string, readonly SitePlace[]>;
  /** Each GitHub organization, in lowercase, a place lists. */
  readonly orgs: ReadonlyMap<string, readonly SitePlace[]>;
  /** The places that got no answer, each in words. */
  readonly unread: readonly string[];
};

function siteSet(): { add: (key: string | undefined, place: SitePlace) => void; map: Map<string, SitePlace[]> } {
  const map = new Map<string, SitePlace[]>();
  const add = (key: string | undefined, place: SitePlace) => {
    if (key === undefined) return;
    const places = map.get(key) ?? [];
    if (!places.some((p) => p.kind === place.kind && p.id === place.id)) map.set(key, [...places, place]);
  };
  return { add, map };
}

/**
 * The protocol's sites as the places that list them name them: DefiLlama, for the protocol and its parent; the coin
 * DefiLlama names, on CoinGecko; and the Immunefi program the entry names. A GitHub organization's verified domain is
 * read per page, since it only ties that organization to a site one of these lists.
 */
function protocolSites(entry: SiteOwner, protocol: DefiLlamaProtocol, listings: Listings, suffixes: PublicSuffixList): ProtocolSites {
  const domains = siteSet();
  const orgs = siteSet();
  const unread: string[] = [];
  const domainOf = (url: URL | undefined) => (url === undefined ? undefined : registrableDomain(url.hostname, suffixes));
  const llama: SitePlace = { kind: 'defillama', id: protocol.slug };
  for (const listed of [protocol, protocol.parent]) {
    if (listed === undefined) continue;
    domains.add(domainOf(listed.url), llama);
    for (const org of listed.github) orgs.add(org.toLowerCase(), llama);
  }
  const gecko = protocol.gecko ?? protocol.parent?.gecko;
  if (gecko !== undefined) {
    const coin = listings.sites.coins.get(gecko);
    const place: SitePlace = { kind: 'coingecko', id: gecko };
    if (coin?.kind === 'unread') unread.push(`CoinGecko coin ${gecko} (${coin.why})`);
    else if (coin !== undefined) {
      for (const url of coin.homepages) domains.add(domainOf(url), place);
      for (const url of coin.github) orgs.add(githubOrg(url), place);
    }
  }
  const program = entry.immunefi === undefined ? undefined : programTie(entry.immunefi, listings.sites.programs, domains.map, orgs.map, domainOf);
  if (program?.kind === 'unread') unread.push(`Immunefi's program list (${program.why})`);
  if (program?.kind === 'tied' && program.by === 'site') {
    const place: SitePlace = { kind: 'immunefi', id: program.program.slug };
    domains.add(domainOf(program.program.website), place);
    if (program.program.github !== undefined) orgs.add(githubOrg(program.program.github), place);
  }
  return { domains: domains.map, orgs: orgs.map, unread };
}

type ProgramTie =
  | { readonly kind: 'tied'; readonly by: 'site' | 'scope'; readonly program: ImmunefiProgram }
  | { readonly kind: 'untied'; readonly program: ImmunefiProgram }
  | { readonly kind: 'unlisted' }
  | SiteUnread;

/**
 * The entry names its Immunefi program, so the program is the protocol's only when its website, its GitHub organization
 * or a website its scope lists is already a site DefiLlama or the protocol coin lists; otherwise an entry could name
 * another protocol's program. A scope lists sites the program pays to have attacked, not sites it owns, so a program
 * tied only by its scope lends the protocol none of its own sites.
 */
function programTie(
  slug: string,
  programs: SiteListings['programs'],
  domains: ReadonlyMap<string, readonly SitePlace[]>,
  orgs: ReadonlyMap<string, readonly SitePlace[]>,
  domainOf: (url: URL | undefined) => string | undefined,
): ProgramTie {
  if ('kind' in programs) return programs;
  const program = programs.get(slug);
  if (program === undefined) return { kind: 'unlisted' };
  const listed = (url: URL | undefined) => domains.has(domainOf(url) ?? '');
  const org = program.github === undefined ? undefined : githubOrg(program.github);
  if (listed(program.website) || (org !== undefined && orgs.has(org))) return { kind: 'tied', by: 'site', program };
  return program.scopeSites.some(listed) ? { kind: 'tied', by: 'scope', program } : { kind: 'untied', program };
}

const PLACE_WORDS: Readonly<Record<SitePlace['kind'], string>> = { defillama: 'DefiLlama', coingecko: 'CoinGecko coin', immunefi: 'Immunefi program', github: 'GitHub verified domain of' };
const placesText = (places: readonly SitePlace[]) => places.map((p) => `${PLACE_WORDS[p.kind]} ${p.id}`).join(', ');
const listedText = (sites: ReadonlyMap<string, readonly SitePlace[]>) => [...sites].map(([site, places]) => `${site} (${placesText(places)})`).join('; ');
const allPlaces = (sites: ReadonlyMap<string, readonly SitePlace[]>): SitePlace[] => [...new Map([...sites.values()].flat().map((p) => [`${p.kind}:${p.id}`, p])).values()];

/** What an entry's sites are compared with: its DefiLlama protocol and its Immunefi program. */
export type SiteOwner = Pick<RegistryEntry, 'defillama' | 'immunefi'>;

/**
 * Compares the registrable domain, or GitHub organization, of `source` with the sites the places that list the
 * protocol `owner.defillama` name; `what` names the URL in the text. A site no place lists differs when DefiLlama lists
 * a site of that kind; when it lists none there is nothing to compare.
 */
export function sourceSiteLine(source: string, owner: SiteOwner, listings: Listings, what = 'source'): Line {
  const finding = (text: string, cause: FindingCause = 'unexplained', places?: readonly SitePlace[]): Line => ({ kind: 'finding', check: 'defillama', text, cause, ...(places === undefined ? {} : { places }) });
  const slug = owner.defillama;
  if (slug === undefined) return finding(`the entry names no DefiLlama protocol; ${what} not compared`);
  const listed = listings.protocols.get(slug) ?? [];
  const [protocol] = listed;
  if (protocol === undefined) return finding(`DefiLlama lists no protocol "${slug}"`);
  if (listed.length > 1) return finding(`DefiLlama lists ${listed.length} protocols with slug "${slug}": ${listed.map((p) => p.name).join(', ')}; not compared`);
  const { suffixes } = listings;
  if ('unavailable' in suffixes) return finding(`Public Suffix List unavailable (${suffixes.unavailable}); ${what} site not compared`);
  const url = new URL(source);
  const sites = protocolSites(owner, protocol, listings, suffixes);
  const host = url.hostname.toLowerCase();
  const isGitHub = host === 'github.com' || host.endsWith('.github.com');
  if (isGitHub && host !== 'github.com' && host !== 'www.github.com') return finding(`${what} host ${host} is not a GitHub repository page; not compared`);
  let ours: string | undefined;
  let compared: ReadonlyMap<string, readonly SitePlace[]>;
  let places: readonly SitePlace[];
  const unread = [...sites.unread];
  if (isGitHub) {
    ours = githubOrg(url);
    if (ours === undefined) return finding(`${what} ${url.href} names no GitHub org; not compared`);
    compared = sites.orgs;
    const verified = listings.sites.orgs.get(ours);
    if (verified?.kind === 'unread') unread.push(`GitHub's page for ${ours} (${verified.why})`);
    const tied = verified?.kind === 'domains' && verified.domains.some((domain) => sites.domains.has(registrableDomain(domain, suffixes) ?? ''));
    places = [...(sites.orgs.get(ours) ?? []), ...(tied ? [{ kind: 'github', id: ours } as const] : [])];
  } else {
    ours = registrableDomain(host, suffixes);
    if (ours === undefined) return finding(`${what} host ${host} has no registrable domain under the Public Suffix List, or is a shared host; not compared`);
    compared = sites.domains;
    places = sites.domains.get(ours) ?? [];
  }
  const kind = isGitHub ? 'GitHub org' : 'domain';
  if (places.length > 0) return { kind: 'agrees', check: 'defillama', text: `${what} ${kind} ${ours} is listed by ${placesText(places)}`, places };
  const missing = unread.length === 0 ? '' : `; no answer from ${unread.join(', ')}`;
  if (unread.length > 0) return { kind: 'unverifiable', check: 'defillama', text: `${what} ${kind} ${ours} is not among the protocol's sites read${missing}`, places: allPlaces(compared) };
  const byDefiLlama = [...compared].filter(([, from]) => from.some((p) => p.kind === 'defillama'));
  if (byDefiLlama.length === 0) {
    const others = compared.size === 0 ? '' : `; the other places list only ${listedText(compared)}`;
    return finding(`${what} is ${kind} ${ours}; DefiLlama lists no ${isGitHub ? 'GitHub org' : 'website'} for ${slug}${others}, so it is not compared`, 'unlisted', allPlaces(compared));
  }
  return finding(`${what} ${kind} ${ours} is not one the protocol's places list: ${listedText(compared)}`, 'differs', allPlaces(compared));
}

const coinLabel = (c: CoinGeckoCoin) => `${c.id} (${c.symbol.toUpperCase()}, "${c.name}")`;

function coingeckoLine(entry: RegistryEntry, coinsByAddress: Listings['coinsByAddress']): Line {
  const finding = (text: string, cause: FindingCause): Line => ({ kind: 'finding', check: 'coingecko', text, cause });
  const coins = coinsByAddress.get(entry.address) ?? [];
  const [coin] = coins;
  const names = entry.coingecko === undefined ? 'the entry names no CoinGecko coin' : `the entry names coin ${entry.coingecko}`;
  if (coin === undefined) return finding(`no CoinGecko listing at this address on ethereum (${names})`, 'unlisted');
  if (coins.length > 1) return finding(`CoinGecko lists more than one coin at this address: ${coins.map(coinLabel).join(', ')}`, 'differs');
  if (coin.id !== entry.coingecko) return finding(`${names}; CoinGecko lists ${coinLabel(coin)} at this address`, entry.coingecko === undefined ? 'unexplained' : 'differs');
  return { kind: 'agrees', check: 'coingecko', text: `CoinGecko lists ${coinLabel(coin)} at this address, the coin the entry names` };
}

const hasCoin = (entry: RegistryEntry) => COINGECKO_KINDS.includes(entry.kind);

export function githubLine(source: URL, commits: SourcePages['commits']): Line {
  const finding = (text: string): Line => ({ kind: 'finding', check: 'github', text, cause: 'unexplained' });
  const ref = githubRef(source);
  if (ref.kind === 'unpinned') return finding('not pinned to a commit: name the file as github.com/<org>/<repo>/blob/<40-hex commit>/<path>');
  const check: CommitCheck = commits.get(commitKey(ref)) ?? { kind: 'unknown', why: 'the commit was not checked' };
  const at = `commit ${ref.commit.slice(0, 12)} of ${ref.owner}/${ref.repo}`;
  if (check.kind === 'unread') return { kind: 'unverifiable', check: 'github', text: `${at}: ${check.why}` };
  if (check.kind === 'unknown') return finding(`${at}: ${check.why}`);
  if (check.kind === 'off-default') return finding(`${at} is not on the default branch ${check.branch} (GitHub compare: ${check.status})`);
  return { kind: 'agrees', check: 'github', text: `${at} is on the default branch ${check.branch} (GitHub compare: ${check.status})` };
}

function pageLine(source: Omit<SourcePage, 'label'> & { readonly label: string | undefined }, address: Address, pages: SourcePages['pages']): Line {
  const url = pageUrlOf(source.url);
  return labelLine('page', pages.get(url) ?? { kind: 'failed', why: `${url} was not fetched` }, url, source, address);
}

/**
 * Where the address stands on `page` against the label: next to it, the label next to other addresses only, apart, or
 * not there; `url` names where the page came from.
 */
function labelLine(check: 'page' | 'sdk', page: Page, url: string, source: { readonly label: string | undefined; readonly heading?: string }, address: Address): Line {
  const finding = (text: string, cause: FindingCause = 'unexplained'): Line => ({ kind: 'finding', check, text, cause });
  if (page.kind === 'unread') return { kind: 'unverifiable', check, text: page.why };
  if (page.kind === 'failed') return finding(page.why, 'not-fetched');
  if (source.label === undefined) return finding('the entry names no sourceLabel, so where the address stands on the page is not checked');
  const label = `"${source.label}"`;
  const under = source.heading === undefined ? '' : ` under a heading naming "${source.heading}"`;
  const match = findOnPage(page.blocks, address, source.label, source.heading);
  const bound = match.kind === 'next-to' ? [] : labelBindings(page.blocks, source.label, source.heading);
  if (bound.length > 0) {
    const text = `the ${check === 'page' ? 'page' : 'file'} binds ${label}${under} to ${bound.map(checksumAddress).join(', ')}, not the entry's address ${checksumAddress(address)}`;
    return { kind: 'finding', check, text, cause: 'other-address', others: bound };
  }
  switch (match.kind) {
    case 'absent':
      return finding(`the address is not found on the page as served (${url}); a page that shows it only by running JavaScript is not read`, 'not-served');
    case 'miscased':
      return finding('the address is on the page only in a letter case that is neither lowercase nor its EIP-55 checksum');
    case 'apart':
      return finding(`the address is on the page, but not within ${MAX_LABEL_ADDRESS_GAP} characters of ${label}${under} in one block with no other address between`);
    case 'next-to':
      return { kind: 'agrees', check, text: `the ${check === 'page' ? 'page' : 'file'} has the address ${match.gap} characters ${match.labelFirst ? 'after' : 'before'} ${label}${under}` };
  }
}

/** The address the entry's API answers at its path must be the entry's own. */
function apiLine(entry: RegistryEntry, api: NonNullable<RegistryEntry['apiSource']>, apis: SourcePages['apis']): Line {
  const finding = (text: string, cause: FindingCause = 'unexplained'): Line => ({ kind: 'finding', check: 'api', text, cause });
  const asked = `${api.method} ${api.url}`;
  const answer: ApiAnswer = apis?.get(apiKey(api)) ?? { kind: 'failed', why: `${asked} was not asked` };
  if (answer.kind === 'unread') return { kind: 'unverifiable', check: 'api', text: answer.why };
  if (answer.kind === 'failed') return finding(answer.why, 'not-fetched');
  const at = pathText(api.path);
  const walked = walkPath(answer.json, api.path);
  switch (walked.kind) {
    case 'missing':
      return finding(`${asked} answers nothing at ${pathText(api.path.slice(0, walked.at + 1))}`, 'differs');
    case 'not-address':
      return finding(`${asked} answers no address at ${at}`, 'differs');
    case 'found':
      return walked.address === entry.address
        ? { kind: 'agrees', check: 'api', text: `${asked} answers ${checksumAddress(walked.address)} at ${at}, the entry's address` }
        : finding(`${asked} answers ${checksumAddress(walked.address)} at ${at}, not the entry's address ${checksumAddress(entry.address)}`, 'differs');
  }
}

/** The entry's protocol on DefiLlama with its sites, or why they are not known. */
function protocolOf(entry: RegistryEntry, listings: Listings): { readonly protocol: DefiLlamaProtocol; readonly suffixes: PublicSuffixList } | undefined {
  const listed = (entry.defillama === undefined ? undefined : listings.protocols.get(entry.defillama)) ?? [];
  const [protocol] = listed;
  const { suffixes } = listings;
  return protocol === undefined || listed.length > 1 || 'unavailable' in suffixes ? undefined : { protocol, suffixes };
}

/** The Immunefi programs tied to the entry's protocol, as `programTie` ties one, and the programs not tied to it that hold its address. */
function bountyPrograms(entry: RegistryEntry, listings: Listings, programs: ReadonlyMap<string, ImmunefiProgram>): { readonly tied: ImmunefiProgram[]; readonly others: ImmunefiProgram[] } {
  const known = protocolOf(entry, listings);
  if (known === undefined) return { tied: [], others: [...programs.values()].filter((p) => p.addresses.has(entry.address)) };
  const { protocol, suffixes } = known;
  const domainOf = (url: URL | undefined) => (url === undefined ? undefined : registrableDomain(url.hostname, suffixes));
  const sites = protocolSites({ defillama: protocol.slug }, protocol, listings, suffixes);
  const tied = [...programs.keys()].filter((slug) => programTie(slug, programs, sites.domains, sites.orgs, domainOf).kind === 'tied');
  return { tied: tied.map((slug) => programs.get(slug) as ImmunefiProgram), others: [...programs.values()].filter((p) => !tied.includes(p.slug) && p.addresses.has(entry.address)) };
}

const slugs = (programs: readonly ImmunefiProgram[]) => programs.map((p) => p.slug).join(', ');

/**
 * Every Immunefi program tied to the entry's protocol, the one it names among them, must be read for its address in
 * scope; the program finds them, so the entry cannot leave one out. A program not tied to the protocol confirms nothing.
 */
function bountyLine(entry: RegistryEntry, listings: Listings): Line {
  const notListed = (text: string): Line => ({ kind: 'absent', check: 'bounty', text });
  const { programs } = listings.sites;
  if ('kind' in programs) return { kind: 'unverifiable', check: 'bounty', text: `Immunefi's program list: ${programs.why}` };
  const named = entry.immunefi;
  if (protocolOf(entry, listings) === undefined) {
    if (named !== undefined) return { kind: 'finding', check: 'bounty', text: `the protocol's sites are not known, so Immunefi program ${named} is not tied to it`, cause: 'unexplained' };
    const { others } = bountyPrograms(entry, listings, programs);
    return notListed(`the protocol's sites are not known, so no Immunefi program is tied to it${others.length === 0 ? '' : `; programs that hold the address: ${slugs(others)}`}`);
  }
  if (named !== undefined && !programs.has(named)) return { kind: 'finding', check: 'bounty', text: `Immunefi lists no program ${named}`, cause: 'not-fetched' };
  const { tied, others } = bountyPrograms(entry, listings, programs);
  if (named !== undefined && !tied.some((p) => p.slug === named)) {
    return { kind: 'finding', check: 'bounty', text: `Immunefi program ${named} lists neither a website, a website in scope nor a GitHub org DefiLlama or the protocol coin lists for ${entry.defillama}`, cause: 'differs' };
  }
  const holding = tied.filter((p) => p.addresses.has(entry.address));
  const untied = others.length === 0 ? '' : `; programs not tied to the protocol that hold it: ${slugs(others)}`;
  if (holding.length > 0) {
    const [first] = holding as [ImmunefiProgram, ...ImmunefiProgram[]];
    return { kind: 'agrees', check: 'bounty', text: `Immunefi program ${slugs(holding)} of the protocol has ${checksumAddress(entry.address)} in scope as an etherscan.io address${untied}`, program: first.slug };
  }
  const [first] = tied;
  if (first === undefined) return notListed(`no Immunefi program lists a website, a website in scope or a GitHub org of ${entry.defillama ?? 'the protocol'}${untied}`);
  const count = tied.reduce((n, p) => n + p.addresses.size, 0);
  return { ...notListed(`Immunefi program ${slugs(tied)} of the protocol does not have the address in scope (${count} Ethereum addresses there)${untied}`), program: first.slug };
}

/** The addresses the newest version binds to the label, against the entry's: `where` names that version. */
function newestLine(check: 'tip' | 'sdk-latest', page: Page, where: string, source: { readonly label: string; readonly heading?: string | undefined }, address: Address): Line {
  if (page.kind === 'unread') return { kind: 'unverifiable', check, text: page.why };
  if (page.kind === 'failed') return { kind: 'absent', check, text: `${where}: ${page.why}; the newest version lists nothing` };
  const named = `"${source.label}"${source.heading === undefined ? '' : ` under a heading naming "${source.heading}"`}`;
  const bound = labelBindings(page.blocks, source.label, source.heading);
  if (bound.includes(address)) return { kind: 'agrees', check, text: `${where} binds ${named} to the address too` };
  if (bound.length === 0) return { kind: 'absent', check, text: `${where} binds ${named} to no address` };
  return { kind: 'finding', check, text: `${where} binds ${named} to ${bound.map(checksumAddress).join(', ')}, not the entry's address ${checksumAddress(address)}`, cause: 'differs', others: bound };
}

/** A pinned GitHub page's file at the tip of its default branch; none for a page not pinned to a commit on that branch. */
function tipLine(source: { readonly url: string; readonly label: string | undefined; readonly heading?: string | undefined }, address: Address, pages: SourcePages): Line[] {
  const tip = tipUrlOf(source.url, pages.commits);
  if (tip === undefined || source.label === undefined) return [];
  const page = pages.pages.get(tip.url) ?? { kind: 'unread', why: `${tip.url} was not read` };
  return [newestLine('tip', page, `the file at the tip of ${tip.branch} (${tip.url})`, { label: source.label, heading: source.heading }, address)];
}

/** The version npm's `latest` tag names, when its provenance ties it to the protocol as the pinned version's must. */
function sdkLatestLine(entry: RegistryEntry, sdk: SdkPackage, read: PackageRead | undefined, listings: Listings): Line {
  const key = packageKey(latestOf(sdk));
  if (read === undefined) return { kind: 'unverifiable', check: 'sdk-latest', text: `${key} was not read` };
  if (read.kind === 'unread') return { kind: 'unverifiable', check: 'sdk-latest', text: read.why };
  if (read.kind === 'failed') return { kind: 'finding', check: 'sdk-latest', text: read.why, cause: 'not-fetched' };
  const at = `${sdk.package}@${read.version}, npm's latest`;
  const unattested = (why: string): Line => ({ kind: 'finding', check: 'sdk-latest', text: `${why}, so ${at} is not compared`, cause: 'unattested' });
  if (!read.integrity) return { kind: 'finding', check: 'sdk-latest', text: `the tarball of ${at} does not match the sha512 npm gives as its integrity`, cause: 'unexplained' };
  const { provenance } = read;
  if (provenance.kind === 'none') return unattested(`npm holds no provenance for ${at}`);
  if (!provenance.sameTarball) return unattested(`npm's provenance for ${at} names another tarball`);
  const site = sourceSiteLine(provenance.repository, entry, listings, `SDK build ${provenance.repository}`);
  if (site.kind === 'unverifiable') return { ...site, check: 'sdk-latest' };
  if (site.kind !== 'agrees') return unattested(site.text);
  return newestLine('sdk-latest', read.file, `${at}, file ${sdk.file}`, { label: sdk.label }, entry.address);
}

/**
 * The SDK's two results: the address next to its label in the pinned tarball's file, and its publisher, the GitHub
 * repository npm's provenance names for that tarball, compared with the protocol's sites as a page's is.
 */
function sdkLines(entry: RegistryEntry, sdk: SdkPackage, read: PackageRead | undefined, listings: Listings): Line[] {
  const key = packageKey(sdk);
  if (read === undefined) return [{ kind: 'finding', check: 'sdk', text: `${key} was not read`, cause: 'not-fetched' }];
  if (read.kind === 'unread') return [{ kind: 'unverifiable', check: 'sdk', text: read.why }];
  if (read.kind === 'failed') return [{ kind: 'finding', check: 'sdk', text: read.why, cause: 'not-fetched' }];
  const differs = (text: string): Line => ({ kind: 'finding', check: 'sdk', text, cause: 'differs' });
  const address =
    read.sha256 !== sdk.sha256
      ? differs(`the tarball of ${key} has sha256 ${read.sha256}, not the pinned ${sdk.sha256}`)
      : !read.integrity
        ? differs(`the tarball of ${key} does not match the sha512 npm gives as its integrity`)
        : labelLine('sdk', read.file, `${key}/${sdk.file}`, { label: sdk.label }, entry.address);
  const { provenance } = read;
  const site: Line =
    provenance.kind === 'none'
      ? { kind: 'finding', check: 'sdk-site', text: `npm holds no provenance for ${key}, so nothing ties its publisher to the protocol`, cause: 'unattested' }
      : !provenance.sameTarball
        ? { kind: 'finding', check: 'sdk-site', text: `npm's provenance for ${key} names another tarball`, cause: 'differs' }
        : { ...sourceSiteLine(provenance.repository, entry, listings, `SDK build ${provenance.repository}`), check: 'sdk-site' };
  return [address, site];
}

const VIA_WORDS = (via: CreationVia): string =>
  via.kind === 'transaction' ? 'directly' : via.kind === 'create2' ? `through the public CREATE2 deployer ${checksumAddress(via.deployer)}` : `through ${checksumAddress(via.factory)} by CREATE`;

/** Who sent the transaction that created the entry, and the other entries of its protocol in this run the same sender created. */
function deployerLine(entry: RegistryEntry, entries: readonly RegistryEntry[], creations: Creations): Line {
  const creation = creations.get(entry.address) ?? { kind: 'unread', why: 'its creation was not read' };
  if (creation.kind === 'unread') return { kind: 'unverifiable', check: 'deployer', text: creation.why };
  if (creation.kind === 'unproven') return { kind: 'finding', check: 'deployer', text: creation.why, cause: 'not-served' };
  const { siblings = [] } = sharedDeployer(entry, entries, creations) ?? {};
  const shared = { deployer: creation.sender, siblings };
  const made = `deployed by ${checksumAddress(creation.sender)} in transaction ${creation.tx} at block ${creation.block}, ${VIA_WORDS(creation.via)}`;
  if (siblings.length > 0) return { kind: 'agrees', check: 'deployer', text: `${made}; the same sender deployed ${siblings.join(', ')}`, shared };
  return { kind: 'finding', check: 'deployer', text: `${made}; no other entry of ${entry.defillama ?? 'its protocol'} checked here has that deployer`, cause: 'unlisted', shared };
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
      sites: [...new Set(pageUrlsOf(entry).map((url) => siteOf(new URL(url), listings.suffixes)))],
      lines: [
        sourceSiteLine(entry.source, entry, listings),
        ...(hasCoin(entry) ? [coingeckoLine(entry, listings.coinsByAddress)] : []),
        ...(isGitHubPage(source) ? [githubLine(source, pages.commits), ...tipLine({ url: entry.source, label: entry.sourceLabel, heading: entry.sourceHeading }, entry.address, pages)] : []),
        echoes
          ? { kind: 'finding', check: 'url', text: 'the source URL holds the address, and a page echoes its own URL; the page is not read', cause: 'unexplained' }
          : pageLine({ url: entry.source, label: entry.sourceLabel, ...(entry.sourceHeading === undefined ? {} : { heading: entry.sourceHeading }) }, entry.address, pages.pages),
        ...(entry.apiSource === undefined
          ? []
          : [apiLine(entry, entry.apiSource, pages.apis), { ...sourceSiteLine(entry.apiSource.url, entry, listings, 'API'), check: 'api-site' as const }]),
        bountyLine(entry, listings),
        ...(entry.sdk === undefined
          ? []
          : [...sdkLines(entry, entry.sdk, pages.packages?.get(packageKey(entry.sdk)), listings), sdkLatestLine(entry, entry.sdk, pages.packages?.get(packageKey(latestOf(entry.sdk))), listings)]),
        ...(pages.creations === undefined ? [] : [deployerLine(entry, entries, pages.creations)]),
        ...(entry.moreSources ?? []).flatMap((page, i): Line[] => {
          const url = new URL(page.url);
          return [
            sourceSiteLine(page.url, entry, listings, `source ${i + 1}`),
            ...(isGitHubPage(url) ? [githubLine(url, pages.commits), ...tipLine(page, entry.address, pages)] : []),
            pageLine(page, entry.address, pages.pages),
          ].map((line) => ({ ...line, more: i + 1 }));
        }),
      ],
    };
  });
}

const LINE_WORDS: Readonly<Record<Line['kind'], string>> = { agrees: 'agrees  ', absent: 'not listed ', finding: 'FINDING ', unverifiable: 'UNVERIFIABLE ' };

export function formatResults(results: readonly EntryResult[]): string {
  const out: string[] = [];
  for (const { entry, lines } of results) {
    out.push(`${entry.name} ${checksumAddress(entry.address)} (${entry.kind})`, `  source     ${entry.source}`);
    const api = entry.apiSource;
    if (api !== undefined) out.push(`  api        ${api.method} ${api.url}${api.method === 'POST' ? ` ${JSON.stringify(api.body)}` : ''}, address at ${pathText(api.path)}`);
    (entry.moreSources ?? []).forEach((page, i) => out.push(`  source ${i + 1}   ${page.url}`));
    for (const line of lines) out.push(`  ${(line.more === undefined ? line.check : `${line.check} ${line.more}`).padEnd(10)} ${LINE_WORDS[line.kind]}${line.text}`);
  }
  const bySlug = new Map<string, Map<string, string[]>>();
  for (const { entry, sites: entrySites } of results) {
    const sites = bySlug.get(entry.defillama ?? '(no defillama slug)') ?? new Map<string, string[]>();
    for (const site of entrySites) sites.set(site, [...(sites.get(site) ?? []), entry.name]);
    bySlug.set(entry.defillama ?? '(no defillama slug)', sites);
  }
  out.push('', 'sites per protocol, for the signer to check each is the protocol\'s own:');
  for (const [slug, sites] of bySlug) {
    out.push(`  ${slug}`);
    for (const [site, names] of sites) out.push(`    ${site}: ${names.join(', ')}`);
  }
  const named = (kind: Line['kind']) => results.flatMap((r) => r.lines.filter((l) => l.kind === kind).map(() => r.entry.name));
  const count = (names: readonly string[], what: string) => `${names.length} ${what}${names.length > 0 ? ` (${[...new Set(names)].join(', ')})` : ''}`;
  const unverifiable = named('unverifiable');
  out.push('', `${results.length} entries, ${count(named('finding'), 'findings')}${unverifiable.length > 0 ? `, ${count(unverifiable, 'unverifiable')}` : ''}`);
  return out.join('\n');
}

export const DEFILLAMA_PROTOCOLS = { hostname: 'api.llama.fi', path: '/protocols' } as const;
export const COINGECKO_COINS = { hostname: 'api.coingecko.com', path: '/api/v3/coins/list?include_platform=true' } as const;
export const DEFILLAMA_PARENTS = { hostname: 'api.llama.fi', path: '/lite/protocols2' } as const;
export const IMMUNEFI_PROGRAMS = { hostname: 'immunefi.com', path: '/public-api/bounties.json' } as const;
const COINGECKO_COIN_ID = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const COIN_PATH = /^\/api\/v3\/coins\/([a-z0-9._-]+)\?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false$/;
export const coinPage = (id: string) => ({ hostname: 'api.coingecko.com', path: `/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false` }) as const;

export type ListingTarget = { readonly hostname: string; readonly path: string };

/** How listings are read: a JSON list by target, which throws when it has no answer, and GitHub's page for an organization. */
export type ListingReads = { readonly list: (target: ListingTarget) => Promise<unknown>; readonly org: (org: string) => Promise<OrgDomains> };

/** CoinGecko's public API answers a few requests a minute and then 429s for about a minute. */
const COINGECKO_PAUSES_MS: readonly number[] = [20_000, 60_000, 90_000];

/** Both answers are public and need no key. A list with no answer after every retry is noted, then refused. */
export async function fetchListing(target: { readonly hostname: string; readonly path: string }, note: NoteUnread): Promise<unknown> {
  let answer;
  try {
    const read = () =>
      requestText(
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
    const pauses = target.hostname === COINGECKO_COINS.hostname ? COINGECKO_PAUSES_MS : undefined;
    answer = await retried(`https://${target.hostname}${target.path}`, read, (a) => transientStatus(a), note, pauses);
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

type RecordedProtocol = { slug: string; name: string; url?: string; github: readonly string[]; gecko_id?: string; parentProtocol?: string };
type RecordedParent = { id: string; name: string; url?: string; github: readonly string[]; gecko_id?: string };

export type ListingsRecording = {
  readonly fetched: string;
  readonly defillama: readonly RecordedProtocol[];
  /** The parent protocols the entries' DefiLlama protocols name. Absent in a recording made before parents were read. */
  readonly defillamaParents?: { readonly parentProtocols: readonly RecordedParent[] };
  /** Each protocol coin's homepages and GitHub repositories, by CoinGecko id, as CoinGecko's answer holds them. */
  readonly coinLinks?: Readonly<Record<string, unknown>>;
  /** The Immunefi programs the entries name, those tied to their protocols and those holding their addresses, cut to their website, GitHub organization, scope's websites and etherscan.io links. */
  readonly immunefi?: unknown;
  /** The domains GitHub verified each organization a page is on controls. */
  readonly orgs?: Readonly<Record<string, OrgDomains>>;
  /** Each SDK package version's read, its file cut down as a page is. */
  readonly packages?: Readonly<Record<string, PackageRead>>;
  /** Each entry's creation by address, its block as a decimal string. Absent when the run read no creation. */
  readonly creations?: Readonly<Record<string, RecordedCreation>>;
  readonly coingecko: readonly { id: string; symbol: string; name: string; platforms: { ethereum: Address } }[];
  readonly pages: Readonly<Record<string, Page>>;
  readonly commits: Readonly<Record<string, CommitCheck>>;
  /** Each entry's API answer by request, cut to the path the entry walks. Absent in a recording made before entries named APIs. */
  readonly apis?: Readonly<Record<string, ApiAnswer>>;
};

type RecordedCreation = Exclude<Creation, { kind: 'proven' }> | (Omit<Extract<Creation, { kind: 'proven' }>, 'block'> & { readonly block: string });

export function sourcePagesOf(recording: Pick<ListingsRecording, 'pages' | 'commits' | 'apis' | 'packages' | 'creations'>): SourcePages {
  const creations = recording.creations;
  return {
    pages: new Map(Object.entries(recording.pages)),
    commits: new Map(Object.entries(recording.commits)),
    apis: new Map(Object.entries(recording.apis ?? {})),
    packages: new Map(Object.entries(recording.packages ?? {})),
    ...(creations === undefined
      ? {}
      : { creations: new Map(Object.entries(creations).map(([address, c]) => [address as Address, c.kind === 'proven' ? { ...c, block: BigInt(c.block) } : c])) }),
  };
}

/** What a check reads on a page: where `address` stands next to `label`, under `heading` when it names one. */
export type PageRead = { readonly address: Address; readonly label: string; readonly heading?: string };

/** Each page an entry's checks read, by the URL fetched: its `source` and each of `moreSources`, unless the source URL echoes the address. */
export function pageReadsOf(entry: RegistryEntry): [string, PageRead][] {
  const read = (page: { readonly label: string | undefined; readonly heading?: string | undefined }): PageRead[] =>
    page.label === undefined ? [] : [{ address: entry.address, label: page.label, ...(page.heading === undefined ? {} : { heading: page.heading }) }];
  const source = sourceHoldsAddress(entry.source, entry.address) ? [] : read({ label: entry.sourceLabel, heading: entry.sourceHeading });
  return [
    ...source.map((r): [string, PageRead] => [pageUrlOf(entry.source), r]),
    ...(entry.moreSources ?? []).flatMap((page) => read(page).map((r): [string, PageRead] => [pageUrlOf(page.url), r])),
  ];
}

/**
 * Keeps only the blocks the checks read: for each of `reads`, the first block, with the one before it, that gives the
 * same answer as the whole page, and every block where its label binds an address; for each of `words`, the first
 * block it matches. It returns the page whole unless every read gives the same answer on what it keeps.
 */
export function trimPage(page: Page, reads: readonly PageRead[], words: readonly RegExp[] = []): Page {
  if (page.kind !== 'served') return page;
  const { blocks } = page;
  const found = (on: readonly PageBlock[], read: PageRead) => JSON.stringify(findOnPage(on, read.address, read.label, read.heading));
  const answer = (on: readonly PageBlock[], read: PageRead) => JSON.stringify([found(on, read), labelBindings(on, read.label, read.heading)]);
  const kept = new Set<number>();
  for (const read of reads) {
    const whole = found(blocks, read);
    const at = blocks.findIndex((block, i) => block.text.toLowerCase().includes(read.address.slice(2)) && found(blocks.slice(Math.max(0, i - 1), i + 1), read) === whole);
    if (at > 0) kept.add(at - 1);
    if (at >= 0) kept.add(at);
    for (const i of bindingBlocks(blocks, read)) kept.add(i);
  }
  for (const word of words) {
    const at = blocks.findIndex((block) => word.test(block.text));
    if (at >= 0) kept.add(at);
  }
  const trimmed: Page = { kind: 'served', blocks: blocks.filter((_, i) => kept.has(i)) };
  return reads.every((read) => answer(trimmed.blocks, read) === answer(blocks, read)) ? trimmed : page;
}

/** What a label read binds on a page: the label, under `heading` when it names one. */
export type BindingRead = { readonly label: string; readonly heading?: string };

/**
 * Keeps only the blocks where some of `reads` binds an address, each with the block before it. It returns the page
 * whole unless every read binds the same addresses on what it keeps.
 */
export function trimBindings(page: Page, reads: readonly BindingRead[]): Page {
  if (page.kind !== 'served') return page;
  const { blocks } = page;
  const answer = (on: readonly PageBlock[], read: BindingRead) => JSON.stringify(labelBindings(on, read.label, read.heading));
  const kept = new Set(reads.flatMap((read) => bindingBlocks(blocks, read)));
  const trimmed: Page = { kind: 'served', blocks: blocks.filter((_, i) => kept.has(i)) };
  return reads.every((read) => answer(trimmed.blocks, read) === answer(blocks, read)) ? trimmed : page;
}

/** Each block where `read`'s label binds an address, with the block before it. */
const bindingBlocks = (blocks: readonly PageBlock[], read: BindingRead): number[] =>
  blocks.flatMap((_, i) => (labelBindings(blocks.slice(Math.max(0, i - 1), i + 1), read.label, read.heading).length === 0 ? [] : i > 0 ? [i - 1, i] : [i]));

/** What the newest-version checks of `entries` read on the tip page fetched from `url`. */
const tipReadsOn = (entries: readonly RegistryEntry[], commits: SourcePages['commits'], url: string): BindingRead[] =>
  entries.flatMap((entry) =>
    [{ url: entry.source, label: entry.sourceLabel, heading: entry.sourceHeading }, ...(entry.moreSources ?? [])].flatMap(({ url: page, label, heading }) =>
      label !== undefined && tipUrlOf(page, commits)?.url === url ? [{ label, ...(heading === undefined ? {} : { heading }) }] : [],
    ),
  );

/**
 * A page cut to what the checks of `entries` read on it: the label bindings on a pinned page's newest version, else
 * the address next to its label and, for each of `words`, the first block it matches.
 */
export function trimSourcePage(entries: readonly RegistryEntry[], commits: SourcePages['commits'], url: string, page: Page, words: readonly RegExp[] = []): Page {
  const tips = tipReadsOn(entries, commits, url);
  return tips.length > 0 ? trimBindings(page, tips) : trimPage(page, readsOn(entries, url), words);
}

/** What the checks of `entries` read on the page fetched from `url`. */
const readsOn = (entries: readonly RegistryEntry[], url: string): PageRead[] =>
  entries.flatMap((entry) => pageReadsOf(entry).filter(([at]) => at === url).map(([, read]) => read));

export function trimForRecording(entries: readonly RegistryEntry[], listings: Listings, pages: SourcePages, fetched: Date): ListingsRecording {
  const slugs = new Set(entries.flatMap((e) => (e.defillama === undefined ? [] : [e.defillama])));
  const addresses = new Set(entries.filter(hasCoin).map((e) => e.address));
  const protocols = [...slugs].flatMap((slug) => listings.protocols.get(slug) ?? []);
  const parents = [...new Map(protocols.flatMap((p) => (p.parent === undefined ? [] : [[p.parent.id, p.parent] as const]))).values()];
  const href = (url: URL | undefined) => (url === undefined ? {} : { url: url.href });
  const gecko = (id: string | undefined) => (id === undefined ? {} : { gecko_id: id });
  const { coins, programs, orgs } = listings.sites;
  const programNames = 'kind' in programs ? new Set<string>() : new Set(entries.flatMap((e) => [...(e.immunefi === undefined ? [] : [e.immunefi]), ...Object.values(bountyPrograms(e, listings, programs)).flat().map((p) => p.slug)]));
  return {
    fetched: fetched.toISOString().slice(0, 10),
    defillama: protocols.map(({ slug, name, url, github, gecko: id, parent }) => ({ slug, name, ...href(url), github, ...gecko(id), ...(parent === undefined ? {} : { parentProtocol: parent.id }) })),
    ...(parents.length === 0 ? {} : { defillamaParents: { parentProtocols: parents.map(({ id, name, url, github, gecko: coin }) => ({ id, name, ...href(url), github, ...gecko(coin) })) } }),
    ...(coins.size === 0
      ? {}
      : {
          coinLinks: Object.fromEntries(
            [...coins].map(([id, coin]) => [id, coin.kind === 'unread' ? { unread: coin.why } : { links: { homepage: coin.homepages.map((u) => u.href), repos_url: { github: coin.github.map((u) => u.href) } } }]),
          ),
        }),
    ...(entries.some((e) => e.defillama !== undefined || e.immunefi !== undefined) ? { immunefi: programsRecord(programs, programNames) } : {}),
    ...(orgs.size === 0 ? {} : { orgs: Object.fromEntries(orgs) }),
    coingecko: [...addresses]
      .flatMap((address) => listings.coinsByAddress.get(address) ?? [])
      .map(({ id, symbol, name, ethereum }) => ({ id, symbol, name, platforms: { ethereum } })),
    pages: Object.fromEntries(
      [...pages.pages].map(([url, page]) => [url, trimSourcePage(entries, pages.commits, url, page)]),
    ),
    commits: Object.fromEntries(pages.commits),
    ...(pages.apis === undefined || pages.apis.size === 0 ? {} : { apis: pruneAnswers(entries, pages.apis) }),
    ...(pages.packages === undefined || pages.packages.size === 0 ? {} : { packages: Object.fromEntries([...pages.packages].map(([key, read]) => [key, trimPackage(entries, key, read)])) }),
    ...(pages.creations === undefined
      ? {}
      : { creations: Object.fromEntries([...pages.creations].map(([address, c]) => [address, c.kind === 'proven' ? { ...c, block: c.block.toString() } : c])) }),
  };
}

/** The programs `names` names, as Immunefi's list holds them, cut to their sites, their scope's websites and its etherscan.io links. */
function programsRecord(programs: SiteListings['programs'], names: ReadonlySet<string>): unknown {
  if ('kind' in programs) return { unread: programs.why };
  return [...names].flatMap((name) => {
    const program = programs.get(name);
    if (program === undefined) return [];
    const links = [...program.addresses].map((address) => `https://etherscan.io/address/${address}`).join('\n');
    const assets = program.scopeSites.map((url) => ({ type: IMMUNEFI_WEBSITE_ASSET, url: url.href }));
    return [{ slug: program.slug, websiteUrl: program.website?.href ?? null, githubUrl: program.github?.href ?? null, ...(assets.length === 0 ? {} : { assets }), assetsBodyV2: links }];
  });
}

/** A package read with its file cut to the blocks the entries naming that version read. */
function trimPackage(entries: readonly RegistryEntry[], key: string, read: PackageRead): PackageRead {
  if (read.kind !== 'read') return read;
  const reads = entries.flatMap(({ sdk, address }) => (sdk !== undefined && packageKey(sdk) === key ? [{ address, label: sdk.label }] : []));
  const latest = entries.flatMap(({ sdk }) => (sdk !== undefined && packageKey(latestOf(sdk)) === key ? [{ label: sdk.label }] : []));
  return { ...read, file: latest.length > 0 ? trimBindings(read.file, latest) : trimPage(read.file, reads) };
}

/**
 * The listings `entries` are compared with, reading only a list some entry needs. A recording trimmed to the entries
 * holds a list none of them needs empty; an empty list an entry needs is refused, since it would hide every comparison.
 */
export async function listingsFor(
  entries: readonly RegistryEntry[],
  suffixes: Listings['suffixes'],
  reads: ListingReads,
  pageUrls: readonly string[] = entries.flatMap(pageUrlsOf),
): Promise<Listings> {
  const { list } = reads;
  const [protocols, coinsByAddress] = await Promise.all([
    entries.some((e) => e.defillama !== undefined)
      ? Promise.all([list(DEFILLAMA_PROTOCOLS), list(DEFILLAMA_PARENTS)]).then(([raw, parents]) => parseDefiLlamaProtocols(raw, parents))
      : new Map<string, DefiLlamaProtocol[]>(),
    entries.some(hasCoin) ? list(COINGECKO_COINS).then(parseCoinGeckoCoins) : new Map<Address, CoinGeckoCoin[]>(),
  ]);
  return { protocols, coinsByAddress, suffixes, sites: await siteListingsFor(entries, protocols, reads, pageUrls) };
}

/** The coin of each entry's DefiLlama protocol or its parent, the Immunefi programs, and each GitHub organization a page is on. */
async function siteListingsFor(entries: readonly RegistryEntry[], protocols: Listings['protocols'], reads: ListingReads, pageUrls: readonly string[]): Promise<SiteListings> {
  const unread = (error: unknown): SiteUnread => {
    if (error instanceof ListingError || error instanceof SiteListingError) return { kind: 'unread', why: error.message };
    throw error;
  };
  const ids = new Set(entries.flatMap((e) => (protocols.get(e.defillama ?? '') ?? []).flatMap((p) => p.gecko ?? p.parent?.gecko ?? [])));
  const coins = new Map<string, CoinLinks | SiteUnread>();
  for (const id of ids) coins.set(id, await reads.list(coinPage(id)).then(parseCoinLinks, unread));
  const programs = entries.some((e) => e.defillama !== undefined || e.immunefi !== undefined) ? await reads.list(IMMUNEFI_PROGRAMS).then(parseImmunefiPrograms, unread) : new Map<string, ImmunefiProgram>();
  const orgs = new Map<string, OrgDomains>();
  for (const url of pageUrls) {
    const org = githubOrg(new URL(url));
    if (org !== undefined && !orgs.has(org)) orgs.set(org, await reads.org(org));
  }
  return { coins, programs, orgs };
}

/** The live listings: each list from its service, and an organization's verified domains from GitHub, read with retries. */
export const liveListingReads = (note: NoteUnread, githubToken: GithubToken | undefined, list: ListingReads['list'] = (target) => fetchListing(target, note)): ListingReads => ({
  list,
  org: (org) => orgDomains(org, retryingGet(httpsGet(githubToken), note)),
});

/**
 * GitHub's page names the domains; its API says whether the organization is verified, asked only when the page shows a
 * badge's run, since the API allows 60 requests an hour without a token.
 */
async function orgDomains(org: string, get: HttpGet): Promise<OrgDomains> {
  const page = await fetchPage(`https://github.com/${encodeURIComponent(org)}`, get);
  const shown = verifiedDomains(page, org, true);
  if (shown.kind !== 'domains' || shown.domains.length === 0) return shown;
  const url = `https://api.github.com/orgs/${encodeURIComponent(org)}`;
  let answer;
  try {
    answer = await get(url);
  } catch (error) {
    return { kind: transientError(error) ? 'unread' : 'failed', why: 'api.github.com unreachable' };
  }
  const transient = transientStatus(answer, true);
  if (transient !== undefined) return { kind: 'unread', why: `${url} answered ${transient}` };
  if (answer.status !== 200) return { kind: 'failed', why: `${url} answered HTTP ${answer.status}` };
  let body: unknown;
  try {
    body = JSON.parse(answer.text);
  } catch {
    return { kind: 'failed', why: `${url} sent no JSON` };
  }
  return isRecord(body) && body.is_verified === true ? shown : { kind: 'domains', domains: [] };
}

/**
 * The listings a recording holds, read as `listingsFor` reads them live: a read recorded with no answer has none again.
 * A recording made before coins, programs or organizations were read lists no site from them; one made after that does
 * not hold a read the live run made has no answer for it.
 */
export function recordedListingReads(recording: ListingsRecording): ListingReads {
  const answered = (value: unknown, what: string): unknown => {
    if (value === undefined) throw new ListingError(`${what} is not in the recording`);
    if (isRecord(value) && typeof value.unread === 'string') throw new ListingError(value.unread);
    return value;
  };
  return {
    list: async (target) => {
      if (target.path === DEFILLAMA_PROTOCOLS.path) return recording.defillama;
      if (target.path === DEFILLAMA_PARENTS.path) return recording.defillamaParents ?? {};
      if (target.path === COINGECKO_COINS.path) return recording.coingecko;
      if (target.path === IMMUNEFI_PROGRAMS.path) return recording.immunefi === undefined ? [] : answered(recording.immunefi, "Immunefi's program list");
      const id = COIN_PATH.exec(target.path)?.[1];
      if (id === undefined) throw new ListingError(`${target.hostname}${target.path} is not a listing a recording holds`);
      return recording.coinLinks === undefined ? {} : answered(recording.coinLinks[id], `CoinGecko coin ${id}`);
    },
    org: async (org) => (recording.orgs === undefined ? { kind: 'domains', domains: [] } : (recording.orgs[org] ?? { kind: 'unread', why: `GitHub organization ${org} is not in the recording` })),
  };
}
