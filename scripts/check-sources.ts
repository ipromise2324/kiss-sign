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

const USAGE = `usage: node scripts/check-sources.ts [<registry name>...] [--record <name>]

Compares each registry entry's source domain with its DefiLlama protocol's website or GitHub org, and each token's
address with CoinGecko's Ethereum contract. With no names it checks every entry. Every disagreement prints as FINDING.`;

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
const listings = { protocols: parseDefiLlamaProtocols(defillama), coinsByAddress: parseCoinGeckoCoins(coingecko) };
console.log(formatResults(checkSources(entries, listings)));

if (flags.record !== undefined) {
  const dir = join(root, 'testdata', 'sources');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${flags.record}.json`);
  writeFileSync(path, `${JSON.stringify(trimForRecording(entries, defillama, coingecko, new Date()), null, 2)}\n`);
  console.log(`recorded ${path}`);
}
