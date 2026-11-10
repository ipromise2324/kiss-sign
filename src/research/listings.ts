import { request } from 'node:https';
import { fallbackLookup } from '../chain/dns.ts';
import { requestText } from '../chain/https.ts';
import type { RegistryEntry } from '../registry.ts';
import { SafeTxParseError, checksumAddress, parseAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';

/** One protocol from DefiLlama's `/protocols` list: its home page and the GitHub organizations it names. */
export type DefiLlamaProtocol = { readonly slug: string; readonly name: string; readonly url: URL | undefined; readonly github: readonly string[] };

/** One CoinGecko coin that has an Ethereum mainnet contract. */
export type CoinGeckoCoin = { readonly id: string; readonly symbol: string; readonly name: string; readonly ethereum: Address };

export type Listings = {
  readonly protocols: ReadonlyMap<string, DefiLlamaProtocol>;
  readonly coinsByAddress: ReadonlyMap<Address, readonly CoinGeckoCoin[]>;
};

/** What `check-sources` saw for one entry. A `finding` is for the signer to judge; `agrees` is evidence for the report. */
export type Line = { readonly kind: 'agrees' | 'finding'; readonly check: 'defillama' | 'coingecko'; readonly text: string };
export type EntryResult = { readonly entry: RegistryEntry; readonly lines: readonly Line[] };

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

/** Parses DefiLlama's `https://api.llama.fi/protocols` answer. A protocol without a slug is skipped. */
export function parseDefiLlamaProtocols(raw: unknown): Map<string, DefiLlamaProtocol> {
  if (!Array.isArray(raw)) throw new ListingError('DefiLlama sent no protocol list');
  const protocols = new Map<string, DefiLlamaProtocol>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item.slug !== 'string' || item.slug === '') continue;
    const github = Array.isArray(item.github) ? item.github.filter((g): g is string => typeof g === 'string' && g !== '') : [];
    protocols.set(item.slug, { slug: item.slug, name: typeof item.name === 'string' ? item.name : item.slug, url: httpsUrl(item.url), github });
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
 * Suffixes under which unrelated parties each get their own name, so the registrable domain takes one more label.
 * A short list, not the Public Suffix List: the report prints every domain it compared so the signer can see it.
 */
const SHARED_SUFFIXES = ['github.io', 'gitbook.io', 'vercel.app', 'netlify.app', 'pages.dev', 'web.app', 'notion.site', 'medium.com', 'mirror.xyz'];
const SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|or|ne|go)$/;

/** The registrable domain (eTLD+1) of a host, such as `morpho.org` for `docs.morpho.org`. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  let take = 2;
  const lastTwo = labels.slice(-2).join('.');
  if (SHARED_SUFFIXES.includes(lastTwo)) take = 3;
  else if (labels.length >= 3 && labels.at(-1)?.length === 2 && SECOND_LEVEL.test(labels.at(-2) ?? '')) take = 3;
  return labels.slice(-take).join('.');
}

/** The organization of a `github.com/<org>/...` URL, lowercased; undefined for any other host. */
export function githubOrg(url: URL): string | undefined {
  if (url.hostname.toLowerCase() !== 'github.com') return undefined;
  const org = url.pathname.split('/')[1];
  return org === undefined || org === '' ? undefined : org.toLowerCase();
}

function defillamaLine(entry: RegistryEntry, protocols: ReadonlyMap<string, DefiLlamaProtocol>): Line {
  const finding = (text: string): Line => ({ kind: 'finding', check: 'defillama', text });
  if (entry.defillama === undefined) return finding('the entry names no DefiLlama protocol; source not compared');
  const protocol = protocols.get(entry.defillama);
  if (protocol === undefined) return finding(`DefiLlama lists no protocol "${entry.defillama}"`);
  const source = new URL(entry.source);
  const label = `${protocol.slug} (${protocol.name})`;
  const org = githubOrg(source);
  if (org !== undefined) {
    if (protocol.github.length === 0) return finding(`source is GitHub org ${org}; DefiLlama names no GitHub org for ${label}, so it is not compared`);
    const listed = protocol.github.map((g) => g.toLowerCase());
    if (listed.includes(org)) return { kind: 'agrees', check: 'defillama', text: `GitHub org ${org} is one ${label} names` };
    return finding(`source is GitHub org ${org}; ${label} names ${listed.join(', ')}`);
  }
  if (protocol.url === undefined) return finding(`DefiLlama has no website for ${label}; source domain ${registrableDomain(source.hostname)} not compared`);
  const ours = registrableDomain(source.hostname);
  const theirs = registrableDomain(protocol.url.hostname);
  if (ours === theirs) return { kind: 'agrees', check: 'defillama', text: `source domain ${ours} equals ${label}'s website ${protocol.url.hostname}` };
  return finding(`source domain ${ours} differs from ${label}'s website ${protocol.url.hostname} (${theirs})`);
}

function coingeckoLine(entry: RegistryEntry, coinsByAddress: ReadonlyMap<Address, readonly CoinGeckoCoin[]>): Line {
  const coins = coinsByAddress.get(entry.address) ?? [];
  if (coins.length === 0) return { kind: 'finding', check: 'coingecko', text: 'CoinGecko lists no coin at this address on ethereum' };
  const named = coins.map((c) => `${c.id} (${c.symbol.toUpperCase()}, "${c.name}")`).join(', ');
  if (coins.length > 1) return { kind: 'finding', check: 'coingecko', text: `CoinGecko lists more than one coin at this address: ${named}` };
  return { kind: 'agrees', check: 'coingecko', text: `CoinGecko lists ${named} at this address on ethereum` };
}

/** Compares each entry's source with its DefiLlama protocol, and each token's address with CoinGecko's. */
export function checkSources(entries: readonly RegistryEntry[], listings: Listings): EntryResult[] {
  return entries.map((entry) => ({
    entry,
    lines: [defillamaLine(entry, listings.protocols), ...(entry.kind === 'token' ? [coingeckoLine(entry, listings.coinsByAddress)] : [])],
  }));
}

export function formatResults(results: readonly EntryResult[]): string {
  const out: string[] = [];
  for (const { entry, lines } of results) {
    out.push(`${entry.name} ${checksumAddress(entry.address)} (${entry.kind})`, `  source     ${entry.source}`);
    for (const line of lines) out.push(`  ${line.check.padEnd(10)} ${line.kind === 'finding' ? 'FINDING ' : 'agrees  '}${line.text}`);
  }
  const findings = results.flatMap((r) => r.lines.filter((l) => l.kind === 'finding').map(() => r.entry.name));
  out.push('', `${results.length} entries, ${findings.length} findings${findings.length > 0 ? ` (${[...new Set(findings)].join(', ')})` : ''}`);
  return out.join('\n');
}

export const DEFILLAMA_PROTOCOLS = { hostname: 'api.llama.fi', path: '/protocols' } as const;
export const COINGECKO_COINS = { hostname: 'api.coingecko.com', path: '/api/v3/coins/list?include_platform=true' } as const;

/** GETs one listing and parses its JSON. Both answers are public and need no key. */
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

/** A `--record` fixture: each answer trimmed to what the given entries use. */
export type ListingsRecording = { readonly fetched: string; readonly defillama: readonly unknown[]; readonly coingecko: readonly unknown[] };

export function trimForRecording(entries: readonly RegistryEntry[], defillama: unknown, coingecko: unknown, fetched: Date): ListingsRecording {
  const slugs = new Set(entries.flatMap((e) => (e.defillama === undefined ? [] : [e.defillama])));
  const tokens = new Set(entries.filter((e) => e.kind === 'token').map((e) => e.address));
  const protocols = (defillama as unknown[])
    .filter((p) => isRecord(p) && typeof p.slug === 'string' && slugs.has(p.slug))
    .map((p) => {
      const { slug, name, url, github } = p as Record<string, unknown>;
      return { slug, name, url, ...(github === undefined ? {} : { github }) };
    });
  const coins = (coingecko as unknown[])
    .filter((c) => isRecord(c) && isRecord(c.platforms) && typeof c.platforms.ethereum === 'string' && tokens.has(c.platforms.ethereum.toLowerCase() as Address))
    .map((c) => {
      const { id, symbol, name, platforms } = c as Record<string, unknown> & { platforms: Record<string, unknown> };
      return { id, symbol, name, platforms: { ethereum: platforms.ethereum } };
    });
  return { fetched: fetched.toISOString().slice(0, 10), defillama: protocols, coingecko: coins };
}
