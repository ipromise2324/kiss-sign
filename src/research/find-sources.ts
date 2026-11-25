import type { HttpAnswer } from '../chain/https.ts';
import { transientStatus } from '../chain/https.ts';
import { parseEtherscan } from '../contracts/etherscan.ts';
import type { EtherscanGet } from '../contracts/etherscan.ts';
import { COINGECKO_KINDS, pageUrlsOf } from '../registry.ts';
import type { Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import type { Creations } from './deployer.ts';
import { COINGECKO_COINS, DEFILLAMA_PARENTS, DEFILLAMA_PROTOCOLS, IMMUNEFI_PROGRAMS, coinPage, parseCoinGeckoCoins, parseDefiLlamaProtocols } from './listings.ts';
import type { CoinGeckoCoin, DefiLlamaProtocol, ListingTarget } from './listings.ts';
import { DEFILLAMA_HACKS } from './protocol-facts.ts';
import { registrableDomain } from './public-suffix.ts';
import type { PublicSuffixList } from './public-suffix.ts';
import { githubOrg, parseCoinLinks, parseImmunefiPrograms } from './site-listings.ts';
import type { ImmunefiProgram } from './site-listings.ts';
import { findOnPage, githubRef, isGitHubPage, pageBlocks, pageUrlOf, sourceHoldsAddress } from './source-page.ts';
import type { HttpGet, PageBlock } from './source-page.ts';

/** How much one run reads beyond the lists and the pages it is given; what a bound cuts off is said. */
export const BOUNDS = { protocols: 5, sites: 4, linksPerSite: 12, orgs: 2, reposPerOrg: 4, filesPerRepo: 60, blocksPerPage: 2, pagesPerAddress: 8, readMs: 15_000 } as const;

export type Reads = {
  readonly list: (target: ListingTarget) => Promise<unknown>;
  readonly get: HttpGet;
  /** Undefined without an Etherscan key. */
  readonly source: EtherscanGet | undefined;
  /** The creations proved through both providers, or the key that is missing. */
  readonly creations: (addresses: readonly Address[]) => Promise<Creations | { readonly missing: string }>;
};

export type Request = { readonly addresses: readonly Address[]; readonly slug: string | undefined; readonly pages: readonly string[] };

/** Where a page shows an address: the block's text, and the label and heading the registry's rule accepts, when one is found. */
type Spot = { readonly text: string; readonly label: string | undefined; readonly heading: string | undefined };

type ReadPage =
  | { readonly kind: 'read'; readonly url: string; readonly raw: string; readonly blocks: readonly PageBlock[] }
  | { readonly kind: 'failed'; readonly why: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const records = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** Text from a page or an API, as one quoted line with no control or bidirectional character, so it reads as data. */
export const quoted = (value: unknown, max = 160): string =>
  JSON.stringify(String(value ?? '').replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max));

const header = (answer: HttpAnswer, name: string): string => String(answer.headers?.[name] ?? '');

/** The page at `url`, following at most two redirects that stay on its registrable domain; the URL read is the one to record. */
async function readPage(url: string, get: HttpGet, domainOf: (host: string) => string | undefined): Promise<ReadPage> {
  let at = pageUrlOf(url);
  for (let hops = 0; ; hops++) {
    let answer: HttpAnswer;
    try {
      answer = await get(at);
    } catch {
      return { kind: 'failed', why: `${new URL(at).hostname} unreachable` };
    }
    const location = header(answer, 'location');
    if (answer.status >= 300 && answer.status < 400 && hops < 2 && URL.canParse(location, at)) {
      const next = new URL(location, at);
      const [from, to] = [domainOf(new URL(at).hostname), domainOf(next.hostname)];
      if (next.protocol === 'https:' && to !== undefined && to === from) {
        at = next.href;
        continue;
      }
    }
    if (answer.status !== 200) return { kind: 'failed', why: transientStatus(answer) ?? `HTTP ${answer.status}${location === '' ? '' : `, redirecting to ${quoted(location, 120)}`}` };
    return { kind: 'read', url: at === pageUrlOf(url) ? url : at, raw: answer.text, blocks: pageBlocks(at, header(answer, 'content-type'), answer.text) };
  }
}

const ADDRESS = /0x[0-9a-fA-F]{40}/g;
const trimmed = (text: string): string => text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();

/** Texts around the address that could be its label: the contract's verified name, then those like it, then the nearest. */
function labelsAround(blocks: readonly PageBlock[], i: number, start: number, name: string | undefined): string[] {
  const { text } = blocks[i] as PageBlock;
  const before = text.slice(0, start).split(ADDRESS).at(-1) ?? '';
  const after = text.slice(start + 42).split(ADDRESS)[0] ?? '';
  const words = before.split(/[|:,;=(){}[\]"'`]+/).map(trimmed).filter((w) => w !== '');
  const previous = trimmed(blocks[i - 1]?.text ?? '');
  const candidates = [words.at(-1), words.at(-1)?.split(' ').at(-1), words.at(-2), trimmed(before), previous, trimmed(after.split(/[|:,;=(){}[\]"'`]+/).find((w) => trimmed(w) !== '') ?? '')];
  const fit = candidates.filter((c): c is string => c !== undefined && c.length > 0 && c.length <= 60 && !c.includes('0x'));
  return [...new Set([...(name === undefined ? [] : [name, ...fit.filter((c) => sameName(c, name))]), ...fit])];
}

/** A chain other than Ethereum mainnet named in a path, a heading or beside an address; kiss-sign covers mainnet only. */
const OTHER_CHAIN = /(?<![a-z])(?:arbitrum|arbiscan|arb|avalanche|avax|base|basescan|bnb|bsc|bscscan|celo|celoscan|gnosis|gnosisscan|ink|linea|mantle|matic|optimism|op|plasma|polygon|polygonscan|scroll|sepolia|holesky|hoodi|goerli|testnet|sonic|unichain|uniscan|worldchain|zksync)(?![a-z])/i;
const MAINNET = /(?<![a-z])(?:ethereum|mainnet|etherscan)(?![a-z])/i;
const otherChain = (text: string): boolean => OTHER_CHAIN.test(text) && !MAINNET.test(text);

const plain = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Whether two names share one whole, such as `LendingFactory` and `FluidLendingFactory`. */
const sameName = (a: string, b: string): boolean => a.length > 4 && b.length > 4 && (plain(a).includes(plain(b)) || plain(b).includes(plain(a)));

const inOrder = (a: readonly number[], b: readonly number[]): number => a.reduce((order, n, k) => order || n - (b[k] ?? n), 0);

/**
 * The blocks of the page that show the address: first those not about another chain, then those under or beside the
 * contract's verified name, then those with the fewest addresses, since a block of many is more often a list that uses
 * the contract than the one that names it. `shown` of them carry a label and heading `check-sources` would accept
 * beside the address, judged by its own rule.
 */
export function spotsOf(blocks: readonly PageBlock[], address: Address, shown: number, name?: string): { readonly spots: readonly Spot[]; readonly more: number; readonly best: readonly number[] } {
  const found = blocks.flatMap((block, i) => {
    const start = block.text.toLowerCase().indexOf(address);
    if (start === -1) return [];
    const before = blocks[i - 1]?.text ?? '';
    const about = `${block.heading ?? ''} ${before.length <= 40 ? before : ''} ${block.text.slice(Math.max(0, start - 60), start + 120)}`;
    const named = name !== undefined && [block.heading ?? '', ...block.text.slice(Math.max(0, start - 60), start).split(/[^A-Za-z0-9_]+/)].some((word) => sameName(word, name));
    return [{ i, start, rank: [otherChain(about) ? 2 : MAINNET.test(about) ? 0 : 1, named ? 0 : 1, block.text.match(ADDRESS)?.length ?? 0, block.text.length] }];
  });
  found.sort((a, b) => inOrder(a.rank, b.rank));
  const spots = found.slice(0, shown).map(({ i, start }): Spot => {
    const { text, heading } = blocks[i] as PageBlock;
    const near = blocks.slice(Math.max(0, i - 1), i + 1);
    const label = labelsAround(blocks, i, start, name).find((l) => findOnPage(near, address, l, heading).kind === 'next-to');
    return { text: text.slice(Math.max(0, start - 80), start + 42 + 40), label, heading };
  });
  return { spots, more: found.length - spots.length, best: found[0]?.rank ?? [] };
}

/** Absolute https links of a page that stay on its registrable domain and whose path reads like a list of contracts. */
export function contractLinks(page: { readonly url: string; readonly raw: string }, domainOf: (host: string) => string | undefined): string[] {
  const own = domainOf(new URL(page.url).hostname);
  const written = [...page.raw.matchAll(/(?:href|src)=["']([^"'<>\s]+)["']|(https:\/\/[^\s"'<>()[\]\\]+)/g)].map((m) => (m[1] ?? m[2]) as string);
  const links = written.flatMap((link) => {
    if (!URL.canParse(link, page.url)) return [];
    const url = new URL(link.replaceAll('&amp;', '&'), page.url);
    url.hash = '';
    const asset = /\.(?:js|css|png|jpe?g|svg|gif|webp|woff2?|ico|pdf|zip|mp4)$/i.test(url.pathname);
    return url.protocol === 'https:' && !asset && own !== undefined && domainOf(url.hostname) === own && /address|deploy|contract/i.test(url.pathname) ? [url.href] : [];
  });
  const rank = (url: string): number => (/address|deploy/i.test(new URL(url).pathname) ? 0 : 1);
  return [...new Set(links)].sort((a, b) => rank(a) - rank(b) || a.length - b.length);
}

/** The GitHub organizations a page links, the most linked first. */
export function linkedOrgs(raw: string): string[] {
  const counts = new Map<string, number>();
  for (const [, org] of raw.matchAll(/https:\/\/github\.com\/([A-Za-z0-9-]+)(?=[/"'\s<>)\\])/g)) counts.set((org as string).toLowerCase(), (counts.get((org as string).toLowerCase()) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([org]) => org);
}

/** Paths of a repository that read like a list of deployed contracts. */
export const isDeploymentPath = (path: string): boolean => /address|deploy|mainnet|constants|registry|networks?\.|(?:^|\/)readme\.md$|contracts\.(?:json|ts|md)/i.test(path) && /\.(?:json|ts|js|py|sol|md|mdx|ya?ml|toml|txt)$/i.test(path) && !/(?:^|\/)(?:node_modules|test|tests|lib)\//i.test(path) && !otherChain(path);

/** A file that lists many contracts first, then one named as a contract asked for, then mainnet's. */
function fileRank(path: string, names: readonly string[]): number {
  const base = (path.split('/').at(-1) as string).replace(/\.[a-z]+$/i, '');
  if (/^(?:deployments?|addresses|networks?|constants|contracts?)$/i.test(base)) return 0;
  if (names.some((name) => sameName(base, name))) return /mainnet|ethereum/i.test(path) ? 1 : 2;
  return /mainnet|ethereum/i.test(path) ? 3 : 4;
}

async function githubJson(path: string, get: HttpGet): Promise<unknown> {
  const answer = await get(`https://api.github.com/${path}`);
  if (answer.status !== 200) throw new Error(`api.github.com answered ${transientStatus(answer, true) ?? `HTTP ${answer.status}`}`);
  return JSON.parse(answer.text) as unknown;
}

/** `read`, refused after `BOUNDS.readMs`: one slow site must not hold a list of leads. */
function timed<T>(read: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${BOUNDS.readMs / 1000} seconds`)), BOUNDS.readMs)));
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/** `run` on each item, at most eight at a time, in order. */
async function eachOf<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await run(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
  return out;
}

/** Files of an organization's most recently pushed repositories that hold an address, each as its page at the commit read. */
async function githubFiles(org: string, addresses: readonly Address[], names: readonly string[], get: HttpGet, say: (line: string) => void): Promise<string[]> {
  const repos = records(await githubJson(`orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=pushed`, get)).filter((r) => r.fork !== true && typeof r.name === 'string');
  const rank = (repo: string): number => (names.some((name) => sameName(repo, name)) ? 0 : /deploy|address|contract|sdk|registry/i.test(repo) ? 1 : 2);
  const chosen = [...repos].sort((a, b) => rank(String(a.name)) - rank(String(b.name))).slice(0, BOUNDS.reposPerOrg);
  const found: string[] = [];
  const read: string[] = [];
  const inRepo = async (repo: Record<string, unknown>): Promise<void> => {
    const name = String(repo.name);
    const at = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(String(repo.full_name)) ? String(repo.full_name) : `${org}/${encodeURIComponent(name)}`;
    const tree = await githubJson(`repos/${at}/git/trees/HEAD?recursive=1`, get);
    const paths = records(isRecord(tree) ? tree.tree : undefined).map((item) => String(item.path)).filter((path) => isDeploymentPath(`${name}/${path}`)).sort((a, b) => fileRank(a, names) - fileRank(b, names) || a.length - b.length);
    const files = paths.slice(0, BOUNDS.filesPerRepo);
    read.push(`${name} ${files.length} of ${paths.length} files`);
    const raw = (path: string, ref: string) => `https://raw.githubusercontent.com/${at}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const hits = await eachOf(files, async (path) => {
      const text = await get(raw(path, 'HEAD')).then((a) => (a.status === 200 ? a.text.toLowerCase() : ''), () => '');
      return addresses.some((address) => text.includes(address)) ? [path] : [];
    });
    if (hits.flat().length === 0) return;
    const commits = await githubJson(`repos/${at}/commits?per_page=1`, get);
    const sha = String(records(commits)[0]?.sha ?? '');
    if (/^[0-9a-f]{40}$/.test(sha)) found.push(...hits.flat().map((path) => `https://github.com/${at}/blob/${sha}/${path}`));
  };
  await eachOf(chosen, (repo) => inRepo(repo).catch((error: unknown) => void read.push(`${String(repo.name)} not read (${error instanceof Error ? error.message : String(error)})`)));
  say(`github.com/${org}: ${repos.length} repositories listed, read ${read.join('; ')}`);
  return found;
}

/** The protocols that could own the addresses, each with why; the slug given is the only one when there is one. */
function candidates(request: Request, coins: ReadonlyMap<Address, readonly CoinGeckoCoin[]>, raw: unknown, protocols: ReadonlyMap<string, readonly DefiLlamaProtocol[]>, programs: ReadonlyMap<string, ImmunefiProgram>, registry: Registry, domainOf: (host: string) => string | undefined): Map<string, string[]> {
  const why = new Map<string, string[]>();
  const add = (slug: string, reason: string) => {
    if (protocols.has(slug)) why.set(slug, [...new Set([...(why.get(slug) ?? []), reason])]);
  };
  if (request.slug !== undefined) {
    add(request.slug, 'given by --protocol');
    return why;
  }
  const held = new Map(records(raw).map((item) => [String(item.slug), String(item.address ?? '').toLowerCase().replace(/^ethereum:/, '')]));
  const sites = new Map([...programs.values()].flatMap((p) => (p.website === undefined ? [] : [[p.slug, domainOf(p.website.hostname)] as const])));
  for (const address of request.addresses) {
    const slug = registry.byAddress.get(address)?.defillama;
    if (slug !== undefined) add(slug, `registry entry ${registry.byAddress.get(address)?.name}`);
    const ids = new Set((coins.get(address) ?? []).map((coin) => coin.id));
    const listing = [...programs.values()].filter((p) => p.addresses.has(address));
    for (const [name, [protocol]] of protocols) {
      if (protocol === undefined) continue;
      if (held.get(name) === address) add(name, 'DefiLlama lists the address as its token');
      const gecko = protocol.gecko ?? protocol.parent?.gecko;
      if (gecko !== undefined && ids.has(gecko)) add(name, `DefiLlama names the coin ${gecko}`);
      const own = [protocol.url, protocol.parent?.url].flatMap((url) => (url === undefined ? [] : [domainOf(url.hostname)]));
      for (const program of listing) if (sites.get(program.slug) !== undefined && own.includes(sites.get(program.slug))) add(name, `the site of Immunefi program ${program.slug}`);
    }
  }
  return why;
}

const creationText = (address: Address, creations: Creations, registry: Registry): string[] => {
  const creation = creations.get(address);
  if (creation === undefined) return [];
  if (creation.kind !== 'proven') return [`creation ${creation.kind}: ${creation.why}`];
  const maker = creation.via.kind === 'create' ? creation.via.factory : undefined;
  const factory = maker === undefined ? undefined : registry.byAddress.get(maker);
  return [
    `creation transaction ${creation.tx}, block ${creation.block}, sender ${checksumAddress(creation.sender)}${maker === undefined ? '' : `, made by contract ${checksumAddress(maker)}`}`,
    ...(factory?.kind === 'factory' ? [`  field attributes.factory ${JSON.stringify(factory.name)}`] : []),
  ];
};

/**
 * Candidate places each address is published, as lines: a proposal for the AI to check, each with the registry field it
 * would fill. Nothing here counts as a place; `check-sources` reads each recorded place itself.
 */
export async function findSources(request: Request, registry: Registry, suffixes: PublicSuffixList | undefined, reads: Reads): Promise<string[]> {
  const get: HttpGet = (url) => timed(reads.get(url));
  const lines: string[] = [];
  const unread: string[] = [];
  const domainOf = (host: string): string | undefined => (suffixes === undefined ? host : registrableDomain(host, suffixes));
  const tried = async <T>(what: string, read: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      unread.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      return empty;
    }
  };
  const [raw, parents, coins, programs, hacks, creations, sources] = await Promise.all([
    tried('DefiLlama protocols', () => reads.list(DEFILLAMA_PROTOCOLS), [] as unknown),
    tried('DefiLlama parents', () => reads.list(DEFILLAMA_PARENTS), {} as unknown),
    tried('CoinGecko coins', async () => parseCoinGeckoCoins(await reads.list(COINGECKO_COINS)), new Map<Address, CoinGeckoCoin[]>()),
    tried('Immunefi programs', async () => parseImmunefiPrograms(await reads.list(IMMUNEFI_PROGRAMS)), new Map<string, ImmunefiProgram>()),
    tried('DefiLlama hacks', () => reads.list(DEFILLAMA_HACKS), [] as unknown),
    tried('creations', () => reads.creations(request.addresses), { missing: 'no answer' } as Creations | { readonly missing: string }),
    (async () => {
      const read = new Map<Address, { readonly text: string; readonly name?: string }>();
      if (reads.source === undefined) return read;
      for (const address of request.addresses) {
        const found = await tried(`Etherscan source of ${address}`, async () => parseEtherscan(await (reads.source as EtherscanGet)(address)), undefined);
        if (found !== undefined) read.set(address, found.kind === 'found' ? { text: `verified as ${quoted(found.source.contractName)}, compiler ${found.source.compilerVersion}`, name: found.source.contractName } : { text: found.kind === 'unreadable' ? `unreadable: ${found.why}` : found.kind });
      }
      return read;
    })(),
  ]);
  const protocols = await tried('DefiLlama protocols', async () => parseDefiLlamaProtocols(raw, parents), new Map<string, DefiLlamaProtocol[]>());

  const why = candidates(request, coins, raw, protocols, programs, registry, domainOf);
  if (request.slug !== undefined && !why.has(request.slug)) lines.push(`DefiLlama lists no protocol ${quoted(request.slug)}`);
  const chosen = [...why].slice(0, BOUNDS.protocols);
  const domains = new Set<string>();
  const orgs = new Set<string>();
  const homes: URL[] = [];
  const site = (url: URL | undefined) => {
    const domain = url === undefined ? undefined : domainOf(url.hostname);
    const org = url === undefined ? undefined : githubOrg(url);
    if (org !== undefined) orgs.add(org);
    else if (domain !== undefined && url !== undefined) {
      if (!domains.has(domain)) homes.push(url);
      domains.add(domain);
    }
  };
  const ids = new Set<string>(request.addresses.flatMap((a) => (coins.get(a) ?? []).map((coin) => coin.id)));
  lines.push(`PROTOCOLS${why.size > chosen.length ? ` (${chosen.length} of ${why.size}; name one with --protocol)` : ''}`);
  if (chosen.length === 0) lines.push('  none found; name one with --protocol');
  for (const [slug, reasons] of chosen) {
    const protocol = (protocols.get(slug) as readonly DefiLlamaProtocol[])[0] as DefiLlamaProtocol;
    const item = records(raw).find((r) => r.slug === slug) ?? {};
    lines.push(`  field defillama ${JSON.stringify(slug)}  ${quoted(protocol.name)}, ${reasons.join('; ')}`);
    for (const [label, of] of [['protocol', protocol], ['parent', protocol.parent]] as const) {
      if (of === undefined) continue;
      lines.push(`    ${label} ${quoted(of.name)} site ${of.url?.href ?? 'none'} github ${of.github.join(', ') || 'none'} coin ${of.gecko ?? 'none'}`);
      site(of.url);
      for (const org of of.github) orgs.add(org.toLowerCase());
    }
    const audits = Array.isArray(item.audit_links) ? item.audit_links : [];
    if (audits.length > 0) lines.push(`    audit links ${audits.slice(0, 5).map((link) => quoted(link)).join(' ')}`);
    const filed = records(hacks).filter((h) => h.defillamaId === item.id || (item.parentProtocol !== undefined && h.defillamaId === item.parentProtocol)).sort((a, b) => Number(a.date) - Number(b.date));
    lines.push(`    hacks ${filed.length}${filed.length === 0 ? '' : ', oldest first'}`);
    for (const h of filed) lines.push(`      ${Number.isFinite(h.date) ? new Date(Number(h.date) * 1000).toISOString().slice(0, 10) : 'no date'} ${quoted(h.name, 60)} ${quoted(h.technique, 80)} ${h.amount ?? '?'} USD ${quoted(h.source)}`);
  }
  for (const program of programs.values()) {
    if (!request.addresses.some((address) => program.addresses.has(address))) continue;
    site(program.website);
    site(program.github);
  }
  if (domains.size === 0) {
    for (const id of [...ids].slice(0, 2)) {
      const links = await tried(`CoinGecko coin ${id}`, async () => parseCoinLinks(await reads.list(coinPage(id))), undefined);
      for (const url of [...(links?.homepages ?? []), ...(links?.github ?? [])]) site(url);
    }
  }

  const slugs = new Set(chosen.map(([slug]) => slug));
  const known = [...registry.entries.values()].filter((e: RegistryEntry) => (e.defillama !== undefined && slugs.has(e.defillama)) || request.addresses.includes(e.address)).flatMap(pageUrlsOf);
  const linked: string[] = [];
  const searched: string[] = [];
  for (const home of homes.slice(0, BOUNDS.sites)) {
    const domain = domainOf(home.hostname) as string;
    const starts = [...new Set([home.href, ...[`https://${domain}`, `https://docs.${domain}`, `https://developers.${domain}`].flatMap((at) => [`${at}/`, `${at}/llms.txt`, `${at}/sitemap.xml`])])];
    const read = await eachOf(starts, (url) => readPage(url, get, domainOf));
    const links = [...new Set(read.flatMap((page) => (page.kind === 'read' ? contractLinks(page, domainOf) : [])))];
    searched.push(`${domain}: ${read.filter((p) => p.kind === 'read').length} of ${starts.length} start pages answered, ${links.length} links that read like contract lists${links.length > BOUNDS.linksPerSite ? `, first ${BOUNDS.linksPerSite} read` : ''}`);
    const named = linkedOrgs(read.map((page) => (page.kind === 'read' ? page.raw : '')).join('\n'))[0];
    if (named !== undefined && orgs.size < BOUNDS.orgs && !orgs.has(named)) {
      orgs.add(named);
      searched.push(`github.com/${named}: the organization ${domain}'s pages link most; no listing names it`);
    }
    linked.push(...links.slice(0, BOUNDS.linksPerSite));
  }
  const names = [...sources.values()].flatMap((source) => source.name ?? []);
  const files = (
    await Promise.all([...orgs].slice(0, BOUNDS.orgs).map((org) => tried(`GitHub organization ${org}`, () => githubFiles(org, request.addresses, names, get, (line) => void searched.push(line)), [] as string[])))
  ).flat();

  const urls = [...new Set([...request.pages, ...known, ...files, ...linked])];
  const pages = await eachOf(urls, async (url) => [url, await readPage(url, get, domainOf)] as const);
  for (const [url, page] of pages) if (page.kind === 'failed' && request.pages.includes(url)) lines.push(`  --page ${url}: ${page.why}`);

  for (const address of request.addresses) {
    const entry = registry.byAddress.get(address);
    lines.push('', `${checksumAddress(address)}${entry === undefined ? '' : ` (registry ${entry.name})`}`);
    lines.push(`  Etherscan: ${sources.get(address)?.text ?? 'not read'}`);
    if (!('missing' in creations)) lines.push(...creationText(address, creations, registry).map((line) => `  ${line}`));
    for (const coin of coins.get(address) ?? []) lines.push(`  field coingecko ${JSON.stringify(coin.id)}  ${quoted(coin.name)} ${quoted(coin.symbol)}${entry === undefined || COINGECKO_KINDS.includes(entry.kind) ? '' : ' (for a token or vault entry only)'}`);
    for (const program of programs.values()) if (program.addresses.has(address)) lines.push(`  field immunefi ${JSON.stringify(program.slug)}  its scope lists the address; site ${program.website?.href ?? 'none'}`);
    const found = pages.flatMap(([asked, page]) => {
      if (page.kind === 'failed') return [];
      const url = isGitHubPage(new URL(page.url)) && githubRef(new URL(page.url)).kind === 'unpinned' ? `${page.url} (not pinned to a commit)` : page.url;
      const at = spotsOf(page.blocks, address, BOUNDS.blocksPerPage, sources.get(address)?.name);
      if (at.spots.length > 0 && !sourceHoldsAddress(page.url, address)) return [{ url, ...at }];
      if (at.spots.length > 0) lines.push(`  lead ${url}: its URL holds the address, so no source`);
      else if (page.raw.toLowerCase().includes(address)) lines.push(`  lead ${url}: in the page's code, not in its text as served, so no source`);
      else if (request.pages.includes(asked)) lines.push(`  ${url}: does not show the address`);
      return [];
    });
    found.sort((a, b) => inOrder(a.best, b.best));
    for (const { url, spots, more } of found.slice(0, BOUNDS.pagesPerAddress)) {
      for (const spot of spots) {
        const field = spot.label === undefined ? 'no label found beside it; choose one' : `label ${quoted(spot.label, 60)}${spot.heading === undefined ? '' : ` heading ${quoted(spot.heading, 80)}`}`;
        lines.push(`  page ${url}`, `    ${field}`, `    text ${quoted(spot.text, 200)}`);
      }
      if (more > 0) lines.push(`    and ${more} more on this page`);
    }
    if (found.length > BOUNDS.pagesPerAddress) lines.push(`  and ${found.length - BOUNDS.pagesPerAddress} more pages show it`);
  }
  lines.push('', 'READ', ...searched.map((line) => `  ${line}`), `  pages read: ${pages.filter(([, p]) => p.kind === 'read').length} of ${urls.length}`);
  for (const org of [...orgs].slice(BOUNDS.orgs)) lines.push(`  not read: github.com/${org}`);
  for (const home of homes.slice(BOUNDS.sites)) lines.push(`  not read: ${home.href}`);
  if ('missing' in creations) lines.push(`  creations not read: ${creations.missing}`);
  if (reads.source === undefined) lines.push('  Etherscan source not read: ETHERSCAN_API_KEY is not set');
  lines.push('  never read: protocol APIs (apiSource), npm packages (sdk), the app, pages scripts render', ...unread.map((what) => `  no answer: ${what}`));
  return lines;
}
