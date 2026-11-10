import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RegistryError, loadRegistry, parseRegistry } from '../src/registry.ts';
import type { RegistryEntry } from '../src/registry.ts';
import { checkSources, formatResults, parseCoinGeckoCoins, parseDefiLlamaProtocols, registrableDomain } from '../src/research/listings.ts';

const ROOT = join(import.meta.dirname, '..');
const recording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'sources', 'registry.json'), 'utf8'));
const listings = { protocols: parseDefiLlamaProtocols(recording.defillama), coinsByAddress: parseCoinGeckoCoins(recording.coingecko) };

const report = (entries: readonly RegistryEntry[]) => formatResults(checkSources(entries, listings));
const entriesOf = (raw: Record<string, unknown>) => [...parseRegistry(raw).entries.values()];
const FAKE = `0x${'11'.repeat(20)}`;

test('the registry: Circle, Tether, Safe and Morpho sources agree with DefiLlama, and every token is on CoinGecko', () => {
  const registry = loadRegistry(ROOT);
  const text = report([...registry.entries.values()]);
  assert.match(text, /usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \(token\)\n.*\n {2}defillama {2}agrees {2}source domain circle\.com equals circle-usdc/);
  assert.match(text, /coingecko {2}agrees {2}CoinGecko lists usd-coin \(USDC, "USDC"\) at this address on ethereum/);
  assert.match(text, /multisend-call-only-1\.4\.1 .*\n.*\n {2}defillama {2}agrees {2}GitHub org safe-global is one safe \(Safe\) names/);
  assert.match(text, /bundler3 .*\n.*\n {2}defillama {2}agrees {2}source domain morpho\.org equals morpho-blue/);
  assert.doesNotMatch(text, /coingecko {2}FINDING/);
});

test('a GitHub source whose DefiLlama protocol names no GitHub org is a finding, not a pass', () => {
  const text = report([loadRegistry(ROOT).entries.get('fluid-fusdc')!]);
  assert.match(text, /defillama {2}FINDING source is GitHub org instadapp; DefiLlama names no GitHub org for fluid-lending \(Fluid Lending\), so it is not compared/);
  assert.match(text, /1 entries, 1 findings \(fluid-fusdc\)/);
});

test('a source on another domain than the DefiLlama website is a finding that names both', () => {
  const text = report(entriesOf({ lookalike: { address: FAKE, kind: 'router', source: 'https://docs.morpho-labs.xyz/addresses', defillama: 'morpho-blue' } }));
  assert.match(text, /FINDING source domain morpho-labs\.xyz differs from morpho-blue \(Morpho Blue\)'s website app\.morpho\.org \(morpho\.org\)/);
});

test('a GitHub org the DefiLlama protocol does not name is a finding', () => {
  const text = report(entriesOf({ fork: { address: FAKE, kind: 'multisend', source: 'https://github.com/safe-globa1/safe-deployments', defillama: 'safe' } }));
  assert.match(text, /FINDING source is GitHub org safe-globa1; safe \(Safe\) names safe-global/);
});

test('a token CoinGecko does not list, an unknown slug, and an entry with no slug are each a finding', () => {
  const text = report(
    entriesOf({
      unlisted: { address: FAKE, kind: 'token', source: 'https://tether.to/x', defillama: 'tether' },
      renamed: { address: `0x${'22'.repeat(20)}`, kind: 'vault', source: 'https://app.morpho.org/v', defillama: 'morpho-v9' },
      bare: { address: `0x${'33'.repeat(20)}`, kind: 'router', source: 'https://example.org/r' },
    }),
  );
  assert.match(text, /coingecko {2}FINDING CoinGecko lists no coin at this address on ethereum/);
  assert.match(text, /defillama {2}FINDING DefiLlama lists no protocol "morpho-v9"/);
  assert.match(text, /defillama {2}FINDING the entry names no DefiLlama protocol; source not compared/);
  assert.match(text, /3 entries, 3 findings \(unlisted, renamed, bare\)/);
});

test('the registrable domain keeps one more label under shared and second-level suffixes', () => {
  assert.equal(registrableDomain('docs.morpho.org'), 'morpho.org');
  assert.equal(registrableDomain('morpho.github.io'), 'morpho.github.io');
  assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
});

test('the registry refuses a defillama value that is not a slug', () => {
  assert.throws(
    () => entriesOf({ usdc: { address: FAKE, kind: 'token', source: 'https://example.org/u', defillama: 'Circle USDC' } }),
    (e: unknown) => e instanceof RegistryError && /usdc\.defillama: not a DefiLlama protocol slug/.test(e.message),
  );
});
