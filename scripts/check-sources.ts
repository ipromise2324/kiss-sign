import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadRegistry } from '../src/registry.ts';
import {
  COINGECKO_COINS,
  DEFILLAMA_PROTOCOLS,
  checkSources,
  fetchListing,
  formatResults,
  parseCoinGeckoCoins,
  parseDefiLlamaProtocols,
  trimForRecording,
} from '../src/research/listings.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { gatherSourcePages, httpsGet } from '../src/research/source-page.ts';

const USAGE = `usage: node scripts/check-sources.ts [<registry name>...] [--record <name>]

Compares each registry entry's source domain (by the Public Suffix List in vendor/publicsuffix/) with its DefiLlama
protocol's website, or its GitHub org with the protocol's orgs, and checks that CoinGecko lists each token's or vault
share's own coin id at its address. It reads each source page as served, without running its scripts, and looks for
the address next to the entry's sourceLabel. A GitHub source must name a commit on the repository's default branch, and
a source URL must not hold the address. It then lists the sites each protocol's sources use. With no names it checks
every entry. Every disagreement prints as FINDING.`;

const { values: flags, positionals: names } = parseArgs({ options: { record: { type: 'string' } }, allowPositionals: true });
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new Error('--record takes a name of lowercase letters, digits and -');

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
const unknown = names.filter((name) => !registry.entries.has(name));
if (unknown.length > 0) {
  console.error(`not in the registry: ${unknown.join(', ')}\n\n${USAGE}`);
  process.exit(2);
}
const entries = names.length === 0 ? [...registry.entries.values()] : names.map((name) => registry.entries.get(name)!);

const [defillama, coingecko] = await Promise.all([fetchListing(DEFILLAMA_PROTOCOLS), fetchListing(COINGECKO_COINS)]);
const listings = { protocols: parseDefiLlamaProtocols(defillama), coinsByAddress: parseCoinGeckoCoins(coingecko), suffixes: loadPublicSuffixList() };
const pages = await gatherSourcePages(entries.map((e) => e.source), httpsGet);
console.log(formatResults(checkSources(entries, listings, pages)));

if (flags.record !== undefined) {
  const dir = join(root, 'testdata', 'sources');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${flags.record}.json`);
  writeFileSync(path, `${JSON.stringify(trimForRecording(entries, listings, pages, new Date()), null, 2)}\n`);
  console.log(`recorded ${path}`);
}
