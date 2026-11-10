import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RegistryError, loadRegistry, parseRegistry } from '../src/registry.ts';
import type { RegistryEntry } from '../src/registry.ts';
import { checkSources, formatResults, parseCoinGeckoCoins, parseDefiLlamaProtocols, trimForRecording } from '../src/research/listings.ts';
import type { Listings } from '../src/research/listings.ts';
import { parsePublicSuffixList } from '../src/research/public-suffix.ts';

const ROOT = join(import.meta.dirname, '..');
const recording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'sources', 'registry.json'), 'utf8'));
const suffixes = parsePublicSuffixList(readFileSync(join(ROOT, 'testdata', 'sources', 'public-suffix-list.dat'), 'utf8'));
const listingsOf = (defillama: unknown, coingecko: unknown): Listings => ({
  protocols: parseDefiLlamaProtocols(defillama),
  coinsByAddress: parseCoinGeckoCoins(coingecko),
  suffixes,
});
const listings = listingsOf(recording.defillama, recording.coingecko);

const report = (entries: readonly RegistryEntry[], using: Listings = listings) => formatResults(checkSources(entries, using));
const entriesOf = (raw: Record<string, unknown>) => [...parseRegistry(raw).entries.values()];
const FAKE = `0x${'11'.repeat(20)}`;
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

test('the registry: Circle, Tether, Safe and Morpho sources agree with DefiLlama, and every token is the coin CoinGecko lists', () => {
  const registry = loadRegistry(ROOT);
  const text = report([...registry.entries.values()]);
  assert.match(text, /usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \(token\)\n.*\n {2}defillama {2}agrees {2}source domain circle\.com equals circle-usdc/);
  assert.match(text, /coingecko {2}agrees {2}CoinGecko lists usd-coin \(USDC, "USDC"\) at this address, the coin the entry names/);
  assert.match(text, /multisend-call-only-1\.4\.1 .*\n.*\n {2}defillama {2}agrees {2}GitHub org safe-global is one safe \(Safe\) names: safe-global/);
  assert.match(text, /bundler3 .*\n.*\n {2}defillama {2}agrees {2}source domain morpho\.org equals morpho-blue/);
  assert.match(text, /steakhouse-prime-usdc .*\n.*\n.*\n {2}coingecko {2}agrees {2}CoinGecko lists steakhouse-usdc \(STEAKUSDC/);
  for (const [name, entry] of registry.entries) {
    if (entry.kind === 'token') assert.match(text, new RegExp(`${name} .*\\n.*\\n.*\\n {2}coingecko {2}agrees`), name);
  }
});

test('a token entry holding another coin\'s address is a finding that names the coin found', () => {
  const text = report(entriesOf({ usdc: { address: USDT, kind: 'token', source: 'https://tether.to/x', defillama: 'tether', coingecko: 'usd-coin' } }));
  assert.match(text, /coingecko {2}FINDING the entry names coin usd-coin; CoinGecko lists tether \(USDT, "Tether"\) at this address/);
  const bare = report(entriesOf({ usdt: { address: USDT, kind: 'token', source: 'https://tether.to/x', defillama: 'tether' } }));
  assert.match(bare, /coingecko {2}FINDING the entry names no CoinGecko coin; CoinGecko lists tether \(USDT, "Tether"\) at this address/);
});

test('a vault share CoinGecko does not list is a finding that says so plainly', () => {
  const text = report([loadRegistry(ROOT).entries.get('fluid-fusdc')!]);
  assert.match(text, /coingecko {2}FINDING no CoinGecko listing at this address on ethereum/);
});

test('a GitHub source whose DefiLlama protocol names no GitHub org is a finding, not a pass', () => {
  const text = report([loadRegistry(ROOT).entries.get('fluid-rewards-distributor')!]);
  assert.match(text, /defillama {2}FINDING source is GitHub org instadapp; DefiLlama names no GitHub org for fluid-lending \(Fluid Lending\), so it is not compared/);
  assert.match(text, /1 entries, 1 findings \(fluid-rewards-distributor\)/);
});

test('a source on another domain than the DefiLlama website is a finding that names both', () => {
  const text = report(entriesOf({ lookalike: { address: FAKE, kind: 'router', source: 'https://docs.morpho-labs.xyz/addresses', defillama: 'morpho-blue' } }));
  assert.match(text, /FINDING source domain morpho-labs\.xyz differs from morpho-blue \(Morpho Blue\)'s website app\.morpho\.org \(morpho\.org\)/);
});

test('two sites on one shared host are different domains', () => {
  const site = (url: string) => [{ slug: 'p', name: 'P', url }];
  const entries = entriesOf({ r: { address: FAKE, kind: 'router', source: 'https://attacker.gitlab.io/addresses', defillama: 'p' } });
  assert.match(report(entries, listingsOf(site('https://real.gitlab.io'), recording.coingecko)), /FINDING source domain attacker\.gitlab\.io differs from p \(P\)'s website real\.gitlab\.io \(real\.gitlab\.io\)/);
  const limo = entriesOf({ r: { address: FAKE, kind: 'router', source: 'https://attacker.eth.limo/', defillama: 'p' } });
  assert.match(report(limo, listingsOf(site('https://real.eth.limo'), recording.coingecko)), /FINDING source host attacker\.eth\.limo has no registrable domain/);
});

test('without the Public Suffix List no domain is compared, and every website line says why', () => {
  const missing = { ...listings, suffixes: { unavailable: 'vendor/publicsuffix/public_suffix_list.dat missing; run pnpm fetch-psl' } };
  const text = report([loadRegistry(ROOT).entries.get('bundler3')!], missing);
  assert.match(text, /defillama {2}FINDING Public Suffix List unavailable \(vendor\/publicsuffix\/public_suffix_list\.dat missing; run pnpm fetch-psl\); source domain not compared/);
});

test('GitHub: www is github.com, /orgs/<org> names the org, and gist or another subdomain is no org', () => {
  const at = (source: string) => report(entriesOf({ m: { address: FAKE, kind: 'multisend', source, defillama: 'safe' } }));
  assert.match(at('https://www.github.com/safe-global/safe-deployments'), /agrees {2}GitHub org safe-global is one safe/);
  assert.match(at('https://github.com/orgs/safe-global/repositories'), /agrees {2}GitHub org safe-global is one safe/);
  assert.match(at('https://github.com/orgs/safe-globa1/repositories'), /FINDING source is GitHub org safe-globa1; safe \(Safe\) names safe-global/);
  assert.match(at('https://gist.github.com/safe-global/abc'), /FINDING source host gist\.github\.com is not a GitHub repository page; not compared/);
  assert.match(at('https://github.com/'), /FINDING source https:\/\/github\.com\/ names no GitHub org; not compared/);
});

test('a GitHub org the DefiLlama protocol does not name is a finding', () => {
  const text = report(entriesOf({ fork: { address: FAKE, kind: 'multisend', source: 'https://github.com/safe-globa1/safe-deployments', defillama: 'safe' } }));
  assert.match(text, /FINDING source is GitHub org safe-globa1; safe \(Safe\) names safe-global/);
});

test('a slug DefiLlama lists twice is a finding naming both protocols', () => {
  const twice = [...recording.defillama, { slug: 'morpho-blue', name: 'Morpho Impostor', url: 'https://morpho-blue.example' }];
  const text = report([loadRegistry(ROOT).entries.get('bundler3')!], listingsOf(twice, recording.coingecko));
  assert.match(text, /defillama {2}FINDING DefiLlama lists 2 protocols with slug "morpho-blue": Morpho Blue, Morpho Impostor; not compared/);
});

test('a token CoinGecko does not list, an unknown slug, and an entry with no slug are each a finding', () => {
  const text = report(
    entriesOf({
      unlisted: { address: FAKE, kind: 'token', source: 'https://tether.to/x', defillama: 'tether' },
      renamed: { address: `0x${'22'.repeat(20)}`, kind: 'router', source: 'https://app.morpho.org/v', defillama: 'morpho-v9' },
      bare: { address: `0x${'33'.repeat(20)}`, kind: 'router', source: 'https://example.org/r' },
    }),
  );
  assert.match(text, /coingecko {2}FINDING no CoinGecko listing at this address on ethereum/);
  assert.match(text, /defillama {2}FINDING DefiLlama lists no protocol "morpho-v9"/);
  assert.match(text, /defillama {2}FINDING the entry names no DefiLlama protocol; source not compared/);
  assert.match(text, /3 entries, 3 findings \(unlisted, renamed, bare\)/);
});

test('a recording, read back, gives the same report as the listings it was trimmed from', () => {
  const entries = [...loadRegistry(ROOT).entries.values()];
  const twice = [...recording.defillama, { slug: 'safe', name: 'Safe Twin', url: 'https://safe.example' }];
  const full = listingsOf(twice, recording.coingecko);
  const trimmed = JSON.parse(JSON.stringify(trimForRecording(entries, full, new Date('2026-11-11'))));
  assert.equal(trimmed.fetched, '2026-11-11');
  assert.equal(report(entries, listingsOf(trimmed.defillama, trimmed.coingecko)), report(entries, full));
});

test('the registry refuses a defillama or coingecko value that is not a slug, and a coingecko id on a contract that is no ERC-20', () => {
  assert.throws(
    () => entriesOf({ usdc: { address: FAKE, kind: 'token', source: 'https://example.org/u', defillama: 'Circle USDC' } }),
    (e: unknown) => e instanceof RegistryError && /usdc\.defillama: not a DefiLlama protocol slug/.test(e.message),
  );
  assert.throws(
    () => entriesOf({ usdc: { address: FAKE, kind: 'token', source: 'https://example.org/u', coingecko: 'USD Coin' } }),
    (e: unknown) => e instanceof RegistryError && /usdc\.coingecko: not a CoinGecko coin id/.test(e.message),
  );
  assert.throws(
    () => entriesOf({ r: { address: FAKE, kind: 'router', source: 'https://example.org/u', coingecko: 'usd-coin' } }),
    (e: unknown) => e instanceof RegistryError && /r\.coingecko: a router has no coingecko/.test(e.message),
  );
});
