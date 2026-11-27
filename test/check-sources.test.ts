import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RegistryError, loadRegistry, pageUrlsOf, parseRegistry } from '../src/registry.ts';
import type { RegistryEntry } from '../src/registry.ts';
import { askedOnce, checkSources, formatResults, listingsFor, mergedRecording, parseCoinGeckoCoins, parseDefiLlamaProtocols, recordedListingReads, sourcePagesOf, trimForRecording, trimPage } from '../src/research/listings.ts';
import type { Listings } from '../src/research/listings.ts';
import { parsePublicSuffixList } from '../src/research/public-suffix.ts';
import { parseImmunefiPrograms } from '../src/research/site-listings.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { findOnPage, gatherSourcePages, retryingGet } from '../src/research/source-page.ts';
import type { HttpGet, Page, SourcePages } from '../src/research/source-page.ts';
import type { Address } from '../src/safe/types.ts';
import { trimReportRecording } from '../src/research/report.ts';
import type { Template } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const recording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'sources', 'registry.json'), 'utf8'));
const suffixes = parsePublicSuffixList(readFileSync(join(ROOT, 'testdata', 'sources', 'public-suffix-list.dat'), 'utf8'));
const listings = await listingsFor([...loadRegistry(ROOT).entries.values()], suffixes, recordedListingReads(recording));
const listingsOf = (defillama: unknown, coingecko: unknown): Listings => ({ ...listings, protocols: parseDefiLlamaProtocols(defillama, recording.defillamaParents), coinsByAddress: parseCoinGeckoCoins(coingecko) });

const recordedPages = sourcePagesOf(recording);
const report = (entries: readonly RegistryEntry[], using: Listings = listings, pages: SourcePages = recordedPages) => formatResults(checkSources(entries, using, pages));
const entriesOf = (raw: Record<string, unknown>) => [...parseRegistry(raw).entries.values()];
const FAKE = `0x${'11'.repeat(20)}`;
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

test('the registry: Circle, Tether, Safe and Morpho sources agree with DefiLlama, and every token is the coin CoinGecko lists', () => {
  const registry = loadRegistry(ROOT);
  const text = report([...registry.entries.values()]);
  assert.match(text, /usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \(token\)\n.*\n {2}defillama {2}agrees {2}source domain circle\.com is listed by DefiLlama circle-usdc/);
  assert.match(text, /coingecko {2}agrees {2}CoinGecko lists usd-coin \(USDC, "USDC"\) at this address, the coin the entry names/);
  assert.match(text, /multisend-call-only-1\.4\.1 .*\n.*\n {2}defillama {2}agrees {2}source GitHub org safe-global is listed by DefiLlama safe/);
  assert.match(text, /bundler3 .*\n(?: {2}.*\n)*? {2}defillama {2}agrees {2}source domain morpho\.org is listed by DefiLlama morpho-blue/);
  assert.match(text, /steakhouse-prime-usdc-v2-0f51 .*\n.*\n.*\n {2}coingecko {2}agrees {2}CoinGecko lists steakhouse-usdc \(STEAKUSDC/);
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

test('a GitHub source on an org no place lists, when DefiLlama names none, is a finding, not a pass', () => {
  const text = report(entriesOf({ r: { address: FAKE, kind: 'router', source: `https://github.com/nobody/x/blob/${'a'.repeat(40)}/f.md`, defillama: 'fluid-lending' } }));
  assert.match(text, /defillama {2}FINDING source is GitHub org nobody; DefiLlama lists no GitHub org for fluid-lending; the other places list only instadapp \(CoinGecko coin instadapp\), so it is not compared/);
});

test("Fluid's GitHub sources, on an org DefiLlama does not name, are the protocol's through its coin on CoinGecko and GitHub's verified domain", () => {
  const text = report([loadRegistry(ROOT).entries.get('fluid-rewards-distributor')!]);
  assert.match(text, /defillama {2}agrees {2}source GitHub org instadapp is listed by CoinGecko coin instadapp, GitHub verified domain of instadapp/);
});

test('a source on another domain than the DefiLlama website is a finding that names both', () => {
  const text = report(entriesOf({ lookalike: { address: FAKE, kind: 'router', source: 'https://docs.morpho-labs.xyz/addresses', defillama: 'morpho-blue' } }));
  assert.match(text, /FINDING source domain morpho-labs\.xyz is not one the protocol's places list: morpho\.org \(DefiLlama morpho-blue/);
});

test('two sites on one shared host are different domains', () => {
  const site = (url: string) => [{ slug: 'p', name: 'P', url }];
  const entries = entriesOf({ r: { address: FAKE, kind: 'router', source: 'https://attacker.gitlab.io/addresses', defillama: 'p' } });
  assert.match(report(entries, listingsOf(site('https://real.gitlab.io'), recording.coingecko)), /FINDING source domain attacker\.gitlab\.io is not one the protocol's places list: real\.gitlab\.io \(DefiLlama p\)/);
  const limo = entriesOf({ r: { address: FAKE, kind: 'router', source: 'https://attacker.eth.limo/', defillama: 'p' } });
  assert.match(report(limo, listingsOf(site('https://real.eth.limo'), recording.coingecko)), /FINDING source host attacker\.eth\.limo has no registrable domain/);
});

test('without the Public Suffix List no domain is compared, and every website line says why', () => {
  const missing = { ...listings, suffixes: { unavailable: 'vendor/publicsuffix/public_suffix_list.dat missing; run pnpm fetch-psl' } };
  const text = report([loadRegistry(ROOT).entries.get('bundler3')!], missing);
  assert.match(text, /defillama {2}FINDING Public Suffix List unavailable \(vendor\/publicsuffix\/public_suffix_list\.dat missing; run pnpm fetch-psl\); source site not compared/);
});

test('GitHub: www is github.com, /orgs/<org> names the org, and gist or another subdomain is no org', () => {
  const at = (source: string) => report(entriesOf({ m: { address: FAKE, kind: 'multisend', source, defillama: 'safe' } }));
  assert.match(at('https://www.github.com/safe-global/safe-deployments'), /agrees {2}source GitHub org safe-global is listed by DefiLlama safe/);
  assert.match(at('https://github.com/orgs/safe-global/repositories'), /agrees {2}source GitHub org safe-global is listed by DefiLlama safe/);
  assert.match(at('https://github.com/orgs/safe-globa1/repositories'), /FINDING source GitHub org safe-globa1 is not one the protocol's places list: safe-global \(DefiLlama safe/);
  assert.match(at('https://gist.github.com/safe-global/abc'), /FINDING source host gist\.github\.com is not a GitHub repository page; not compared/);
  assert.match(at('https://github.com/'), /FINDING source https:\/\/github\.com\/ names no GitHub org; not compared/);
});

test('a GitHub org the DefiLlama protocol does not name is a finding', () => {
  const text = report(entriesOf({ fork: { address: FAKE, kind: 'multisend', source: 'https://github.com/safe-globa1/safe-deployments', defillama: 'safe' } }));
  assert.match(text, /FINDING source GitHub org safe-globa1 is not one the protocol's places list: safe-global \(DefiLlama safe/);
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
  assert.match(text, /3 entries, 6 findings \(unlisted, renamed, bare\)/);
});

test('a recording, read back, gives the same report as the listings it was trimmed from', () => {
  const entries = [...loadRegistry(ROOT).entries.values()];
  const twice = [...recording.defillama, { slug: 'safe', name: 'Safe Twin', url: 'https://safe.example' }];
  const full = listingsOf(twice, recording.coingecko);
  const trimmed = JSON.parse(JSON.stringify(trimForRecording(entries, full, recordedPages, new Date('2026-11-11'))));
  assert.equal(trimmed.fetched, '2026-11-11');
  assert.equal(report(entries, listingsOf(trimmed.defillama, trimmed.coingecko), sourcePagesOf(trimmed)), report(entries, full));
});

test('a recorded page keeps only the blocks its checks read, however often it names the address', () => {
  const address = `0x${'52'.repeat(20)}` as Address;
  const blocks = Array.from({ length: 40 }, (_, i) => [{ text: `Deployment ${i}`, heading: 'Vault' }, { text: `uses ${address} as Liquidity`, heading: 'Vault' }]).flat();
  const page: Page = { kind: 'served', blocks: [...blocks, { text: 'mainnet', heading: 'Liquidity' }, { text: address, heading: 'Liquidity' }, ...blocks] };
  const read = { address, label: 'mainnet', heading: 'Liquidity' };
  const trimmed = trimPage(page, [read]);
  assert.deepEqual(trimmed, { kind: 'served', blocks: [{ text: 'mainnet', heading: 'Liquidity' }, { text: address, heading: 'Liquidity' }] });
  assert.deepEqual(findOnPage(trimmed.kind === 'served' ? trimmed.blocks : [], address, read.label, read.heading), findOnPage(page.blocks, address, read.label, read.heading));
});

test('a recorded page keeps every block where the label binds another address, so the recording names the same other address', async () => {
  const entries = entriesOf({ r: { address: ADDR, kind: 'router', defillama: 'morpho-blue', source: DOCS, sourceLabel: 'Bundler3' } });
  const filler = Array.from({ length: 20 }, (_, i) => `<p>Section ${i}</p>`).join('');
  const pages = await gatherSourcePages(entries.flatMap(pageUrlsOf), getFrom({ [DOCS]: html(`<p>Router ${ADDR}</p>${filler}<p>Bundler3 ${OTHER}</p>`) }));
  const recorded = sourcePagesOf(JSON.parse(JSON.stringify(trimForRecording(entries, listings, pages, new Date('2026-11-18')))));
  assert.match(report(entries, listings, recorded), boundTo('Bundler3'));
  assert.equal(report(entries, listings, recorded), report(entries, listings, pages));
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

const ADDR = '0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245';
const OTHER = '0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0';
const COMMIT = 'ca9cb0d2d5f5175fc8e41d579f356748d2bc1c62';

type Served = { status: number; text: string; headers?: Record<string, string> };
const getFrom = (served: Record<string, Served>): HttpGet => async (url) => {
  const answer = served[url];
  if (answer === undefined) throw new Error(`unexpected GET ${url}`);
  return answer;
};
const html = (body: string): Served => ({ status: 200, text: `<!doctype html><html><body>${body}</body></html>`, headers: { 'content-type': 'text/html' } });

async function pageReport(fields: Record<string, unknown>, served: Record<string, Served>): Promise<string> {
  const entries = entriesOf({ r: { address: ADDR, kind: 'router', defillama: 'morpho-blue', ...fields } });
  return report(entries, listings, await gatherSourcePages(entries.flatMap(pageUrlsOf), getFrom(served)));
}

const DOCS = 'https://docs.morpho.org/addresses';
const onDocs = (body: string, fields: Record<string, unknown> = {}) =>
  pageReport({ source: DOCS, sourceLabel: 'Bundler3', ...fields }, { [DOCS]: html(body) });

test('the registry: every labelled source page has its address next to its label, and every GitHub source is pinned to a default-branch commit', () => {
  const text = report([...loadRegistry(ROOT).entries.values()]);
  // No page served without scripts lists these oracles; Morpho's API, asked for each market, answers its address.
  const SHOWN_ONLY_BY_SCRIPT = new Set(['morpho-oracle-cbbtc-usdc-86', 'morpho-oracle-usp-usdc', 'morpho-oracle-weeth-usdc-86']);
  for (const entry of loadRegistry(ROOT).entries.values()) {
    if (SHOWN_ONLY_BY_SCRIPT.has(entry.name)) {
      assert.match(text, new RegExp(`${entry.name} [^\\n]*\\n(?: {2}.*\\n)*? {2}page {7}FINDING the address is not found on the page as served`), entry.name);
      assert.match(text, new RegExp(`${entry.name} [^\\n]*\\n(?: {2}.*\\n)*? {2}api {8}agrees {2}POST https://api\\.morpho\\.org/graphql answers 0x${entry.address.slice(2)} at data\\.marketById\\.oracle\\.address, the entry's address`, 'i'), entry.name);
      assert.match(text, new RegExp(`${entry.name} [^\\n]*\\n(?: {2}.*\\n)*? {2}api-site {3}agrees {2}API domain morpho\\.org is listed by DefiLlama morpho-blue`), entry.name);
    } else if (entry.sourceLabel !== undefined) assert.match(text, new RegExp(`${entry.name} [^\\n]*\\n(?: {2}.*\\n)*? {2}page {7}agrees {2}the page has the address \\d+ characters`), entry.name);
  }
  assert.match(text, /bundler3 .*\n(?: {2}.*\n)*? {2}page {7}agrees {2}the page has the address 5 characters after "Bundler3"/);
  assert.match(text, /cctp-message-transmitter .*\n(?: {2}.*\n)*? {2}page {7}agrees {2}the page has the address \d+ characters after "Ethereum" under a heading naming "MessageTransmitter"/);
  assert.match(text, /multisend-1\.3\.0-eip155 .*\n(?: {2}.*\n)*? {2}github {5}agrees {2}commit ca9cb0d2d5f5 of safe-global\/safe-deployments is on the default branch main/);
  assert.match(text, /hyperithm-usdc-apex-v2-9e2f .*\n(?: {2}.*\n)*? {2}url {8}FINDING the source URL holds the address/);
});

const apartFrom = (label: string) => new RegExp(`page {7}FINDING the address is on the page, but not within 100 characters of "${label}"`);
/** The finding for a label the page binds to OTHER only, which names OTHER in full. */
const boundTo = (label: string, under = '') => new RegExp(`page {7}FINDING the page binds "${label}"${under} to ${OTHER}, not the entry's address ${ADDR}`);

test('an address in the label\'s own table row agrees; too far away it is a finding, and a label next to another address is that finding', async () => {
  assert.match(await onDocs(`<table><tr><td>Bundler3</td><td><a href="x">${ADDR}</a></td></tr></table>`), /page {7}agrees {2}the page has the address 1 characters after "Bundler3"/);
  const apart = /page {7}FINDING the address is on the page, but not within 100 characters of "Bundler3" in one block with no other address between/;
  assert.match(await onDocs(`<p>Bundler3 ${'word '.repeat(30)}${ADDR}</p>`), apart);
  assert.match(await onDocs(`<p>Bundler3s ${ADDR}</p>`), apart);
  assert.match(await onDocs(`<table><tr><td>Bundler3</td><td>${OTHER}</td></tr><tr><td>Adapter</td><td>${ADDR}</td></tr></table>`), boundTo('Bundler3'));
  assert.match(await onDocs(`<p>Bundler3 ${OTHER} ${ADDR}</p>`), boundTo('Bundler3'));
});

test('a label standing alone in the paragraph just before the address agrees; one inside other text or beside an address does not', async () => {
  assert.match(await onDocs(`<p>Bundler3:</p><p><a>${ADDR}</a></p>`), /page {7}agrees {2}the page has the address 2 characters after "Bundler3"/);
  assert.match(await onDocs(`<p>See the Bundler3 guide</p><p>${ADDR}</p>`), apartFrom('Bundler3'));
  assert.match(await onDocs(`<p>${OTHER} is not Bundler3</p><p>${ADDR}</p>`), boundTo('Bundler3'));
});

test('in a list of names and addresses, each address binds to its own name, whichever side the names stand on', async () => {
  const nameFirst = `<p>Bundler3: ${ADDR} GeneralAdapter1: ${OTHER}</p>`;
  assert.match(await onDocs(nameFirst), /page {7}agrees {2}the page has the address 2 characters after "Bundler3"/);
  assert.match(await onDocs(nameFirst, { sourceLabel: 'GeneralAdapter1' }), boundTo('GeneralAdapter1'));
  const nameAfter = `<p>${OTHER} (Bundler3), ${ADDR} (GeneralAdapter1)</p>`;
  assert.match(await onDocs(nameAfter, { sourceLabel: 'GeneralAdapter1' }), /page {7}agrees {2}the page has the address 2 characters before "GeneralAdapter1"/);
  assert.match(await onDocs(nameAfter), boundTo('Bundler3'));
  assert.match(await onDocs(`<p>${ADDR} is Bundler3</p>`), /page {7}agrees {2}the page has the address 4 characters before "Bundler3"/);
});

const JSON_PAGE = 'https://docs.morpho.org/addresses.json';
const onJson = (value: unknown, sourceLabel: string) =>
  pageReport({ source: JSON_PAGE, sourceLabel }, { [JSON_PAGE]: { status: 200, text: JSON.stringify(value), headers: { 'content-type': 'application/json' } } });

test('in JSON, a name binds to an address only within its own object', async () => {
  const list = [{ address: OTHER, name: 'Bundler3' }, { address: ADDR, name: 'GeneralAdapter1' }];
  assert.match(await onJson(list, 'GeneralAdapter1'), /page {7}agrees {2}the page has the address 6 characters before "GeneralAdapter1"/);
  assert.match(await onJson(list, 'Bundler3'), boundTo('Bundler3'));
  assert.match(await onJson([{ name: 'Bundler3' }, { address: ADDR }], 'Bundler3'), apartFrom('Bundler3'));
});

test('a markdown deployments file binds each address to the row label under its own heading', async () => {
  const md = 'https://docs.morpho.org/deployments.md';
  const text = [
    '## fToken_fUSDC',
    '| network | address | etherscan | args |',
    '|---|---|---|---|',
    `| mainnet | ${ADDR} | [Link](https://etherscan.io/address/${ADDR}#code) | "${OTHER}" |`,
    '## fToken_fUSDT',
    '|---|---|---|---|',
    `| mainnet | ${OTHER} | [Link](https://etherscan.io/address/${OTHER}#code) | "${ADDR}" |`,
  ].join('\n');
  const at = (sourceHeading: string) => pageReport({ source: md, sourceLabel: 'mainnet', sourceHeading }, { [md]: { status: 200, text, headers: { 'content-type': 'text/plain' } } });
  assert.match(await at('fToken_fUSDC'), /page {7}agrees {2}the page has the address 3 characters after "mainnet" under a heading naming "fToken_fUSDC"/);
  assert.match(await at('fToken_fUSDT'), boundTo('mainnet', ' under a heading naming "fToken_fUSDT"'));
});

test('an address only a script, an attribute, or a comment holds is not on the page as served', async () => {
  const absent = /page {7}FINDING the address is not found on the page as served \(https:\/\/docs\.morpho\.org\/addresses\)/;
  assert.match(await onDocs(`<div id="root"></div><script>render({ name: "Bundler3", address: "${ADDR}" })</script>`), absent);
  assert.match(await onDocs(`<p>Bundler3 <a href="https://etherscan.io/address/${ADDR}">here</a></p>`), absent);
  assert.match(await onDocs(`<p>Bundler3 <!-- ${ADDR} --></p>`), absent);
});

test('text a browser hides is not on the page: hidden elements, the title, text areas, SVG, an unclosed script, and inside an attribute', async () => {
  const absent = /page {7}FINDING the address is not found on the page as served/;
  const shown = `Bundler3 ${ADDR}`;
  for (const body of [
    `<p style="display:none">${shown}</p>`,
    `<p style="color: red; visibility : hidden">${shown}</p>`,
    `<div hidden><div>x</div><p>${shown}</p></div>`,
    `<span aria-hidden="true">${shown}</span>`,
    `<title>${shown}</title>`,
    `<textarea>${shown}</textarea>`,
    `<svg><text>${shown}</text></svg>`,
    `<template><p>${shown}</p></template>`,
    `<p>x</p><script>${shown}`,
    `<p>x</p><style>${shown}`,
    `<img alt="x>${shown}">`,
    `<img alt='x>${shown}'>`,
    `<img alt="x>${shown}`,
    `<p>x</p><!-- ${shown}`,
  ]) {
    assert.match(await onDocs(body), absent, body);
  }
});

test('text after a hidden element, an attribute holding ">", or an element not hidden still shows', async () => {
  const agrees = /page {7}agrees {2}the page has the address 1 characters after "Bundler3"/;
  for (const body of [
    `<div hidden><div>x</div></div><p>Bundler3 ${ADDR}</p>`,
    `<img alt="a > b" hidden><p>Bundler3 ${ADDR}</p>`,
    `<svg/><p>Bundler3 ${ADDR}</p>`,
    `<p aria-hidden="false" style="display:block">Bundler3 ${ADDR}</p>`,
    `<p title="hidden">Bundler3 ${ADDR}</p>`,
  ]) {
    assert.match(await onDocs(body), agrees, body);
  }
});

test('an address in a broken letter case is a finding; lowercase and checksummed both count', async () => {
  assert.match(await onDocs(`<p>Bundler3 ${ADDR.toLowerCase()}</p>`), /page {7}agrees/);
  assert.match(await onDocs(`<p>Bundler3 0x${ADDR.slice(2).toUpperCase()}</p>`), /page {7}FINDING the address is on the page only in a letter case that is neither lowercase nor its EIP-55 checksum/);
});

test('a sourceHeading must be the nearest heading above the address', async () => {
  const body = `<h3>TokenMessenger</h3><table><tr><td>Ethereum</td><td>${ADDR}</td></tr></table><h3>MessageTransmitter</h3><table><tr><td>Ethereum</td><td>${OTHER}</td></tr></table>`;
  assert.match(await onDocs(body, { sourceLabel: 'Ethereum', sourceHeading: 'TokenMessenger' }), /agrees {2}the page has the address 1 characters after "Ethereum" under a heading naming "TokenMessenger"/);
  assert.match(await onDocs(body, { sourceLabel: 'Ethereum', sourceHeading: 'MessageTransmitter' }), boundTo('Ethereum', ' under a heading naming "MessageTransmitter"'));
  assert.match(await onDocs(body, { sourceLabel: 'Ethereum', sourceHeading: 'Bridge' }), /FINDING the address is on the page, but not within 100 characters of "Ethereum" under a heading naming "Bridge"/);
});

test('an entry with no sourceLabel and a redirecting page are findings', async () => {
  assert.match(await pageReport({ source: DOCS }, { [DOCS]: html(`<p>Bundler3 ${ADDR}</p>`) }), /page {7}FINDING the entry names no sourceLabel/);
  const moved = await pageReport({ source: DOCS, sourceLabel: 'Bundler3' }, { [DOCS]: { status: 308, text: '', headers: { location: '/developers/addresses' } } });
  assert.match(moved, /page {7}FINDING https:\/\/docs\.morpho\.org\/addresses answered HTTP 308, redirecting to https:\/\/docs\.morpho\.org\/developers\/addresses; name the page itself as the source/);
});

test('a source URL that holds the address is a finding, and its page is not read', async () => {
  const source = `https://app.morpho.org/ethereum/vault/${ADDR.toLowerCase()}/bundler`;
  const text = await pageReport({ source, sourceLabel: 'Bundler3' }, {});
  assert.match(text, /url {8}FINDING the source URL holds the address, and a page echoes its own URL; the page is not read/);
  assert.doesNotMatch(text, /page {7}agrees/);
});

const REPO_API = 'https://api.github.com/repos/safe-global/safe-deployments';
const PINNED = `https://github.com/safe-global/safe-deployments/blob/${COMMIT}/src/assets/v1.3.0/multi_send.json`;
const RAW = `https://raw.githubusercontent.com/safe-global/safe-deployments/${COMMIT}/src/assets/v1.3.0/multi_send.json`;
const deployments = { status: 200, text: JSON.stringify({ contractName: 'MultiSend', deployments: { canonical: { address: ADDR }, eip155: { address: OTHER } } }) };
const compareUrl = `${REPO_API}/compare/main...${COMMIT}?per_page=1`;
const github = (compare: Served, repo: Served = { status: 200, text: JSON.stringify({ default_branch: 'main' }) }) =>
  pageReport({ source: PINNED, sourceLabel: 'canonical', defillama: 'safe' }, { [REPO_API]: repo, [compareUrl]: compare, [RAW]: deployments });

test('a pinned GitHub file is read raw at its commit, and a commit behind or equal to the default branch agrees', async () => {
  const text = await github({ status: 200, text: JSON.stringify({ status: 'behind' }) });
  assert.match(text, /github {5}agrees {2}commit ca9cb0d2d5f5 of safe-global\/safe-deployments is on the default branch main \(GitHub compare: behind\)/);
  assert.match(text, /page {7}agrees {2}the page has the address 9 characters after "canonical"/);
  assert.match(await github({ status: 200, text: JSON.stringify({ status: 'identical' }) }), /github {5}agrees .*\(GitHub compare: identical\)/);
});

const TIP = 'https://raw.githubusercontent.com/safe-global/safe-deployments/refs/heads/main/src/assets/v1.3.0/multi_send.json';
async function tipReport(tip: Served): Promise<string> {
  const entries = entriesOf({ r: { address: ADDR, kind: 'router', defillama: 'safe', source: PINNED, sourceLabel: 'canonical' } });
  const get = getFrom({ [REPO_API]: { status: 200, text: JSON.stringify({ default_branch: 'main' }) }, [compareUrl]: { status: 200, text: JSON.stringify({ status: 'behind' }) }, [RAW]: deployments, [TIP]: tip });
  const pages = await gatherSourcePages(entries.flatMap(pageUrlsOf), get);
  const recorded = sourcePagesOf(JSON.parse(JSON.stringify(trimForRecording(entries, listings, pages, new Date('2026-11-17')))));
  assert.equal(report(entries, listings, recorded), report(entries, listings, pages), 'the recording, read back, gives the same lines');
  const forReport = trimReportRecording({ kind: 'template', template: {} as Template, docs: [], vault: undefined, shared: new Set(), dir: '' }, entries, listings, pages, new Date('2026-11-17'), new Map(), {} as never, [], undefined, undefined);
  assert.equal(report(entries, listings, sourcePagesOf(JSON.parse(JSON.stringify(forReport)))), report(entries, listings, pages), "the report's recording, read back, gives the same lines");
  return report(entries, listings, pages);
}

test('the file a pinned GitHub source names is read again at the tip of its default branch, and another address under its label there is a finding naming both', async () => {
  const at = `the file at the tip of main (${TIP})`;
  assert.ok((await tipReport(deployments)).includes(`  tip        agrees  ${at} binds "canonical" to the address too`));
  const moved = { status: 200, text: JSON.stringify({ contractName: 'MultiSend', deployments: { canonical: { address: OTHER }, eip155: { address: ADDR } } }) };
  assert.ok((await tipReport(moved)).includes(`  tip        FINDING ${at} binds "canonical" to ${OTHER}, not the entry's address ${ADDR}`));
  assert.ok((await tipReport({ status: 404, text: '404: Not Found' })).includes(`  tip        not listed ${at}: ${TIP} answered HTTP 404; the newest version lists nothing`));
  assert.ok((await tipReport({ status: 200, text: JSON.stringify({ contractName: 'MultiSend', deployments: {} }) })).includes(`  tip        not listed ${at} binds "canonical" to no address`));
});

test('every Immunefi program tied to the protocol is read, whether or not the entry names one; one not tied confirms nothing', () => {
  const entries = entriesOf({ r: { address: ADDR, kind: 'router', defillama: 'safe', source: DOCS, sourceLabel: 'Bundler3' } });
  const programs = (website: string | null, addresses: readonly string[], scope: readonly string[] = []) => ({
    ...listings,
    sites: {
      ...listings.sites,
      programs: parseImmunefiPrograms([
        { slug: 'p', websiteUrl: website, assets: scope.map((url) => ({ type: 'websites_and_applications', url })), assetsBodyV2: addresses.map((a) => `https://etherscan.io/address/${a}`).join('\n') },
      ]),
    },
  });
  const bounty = (using: Listings) => report(entries, using, { pages: new Map(), commits: new Map() }).split('\n').find((line) => line.trimStart().startsWith('bounty'));
  assert.equal(bounty(programs('https://safe.global', [ADDR])), `  bounty     agrees  Immunefi program p of the protocol has ${ADDR} in scope as an etherscan.io address`);
  assert.equal(bounty(programs('https://safe.global', [OTHER])), '  bounty     not listed Immunefi program p of the protocol does not have the address in scope (1 Ethereum addresses there)');
  assert.equal(bounty(programs('https://compound.finance', [ADDR])), '  bounty     not listed no Immunefi program lists a website, a website in scope or a GitHub org of safe; programs not tied to the protocol that hold it: p');
  assert.equal(bounty(programs(null, [ADDR], ['https://app.safe.global/'])), `  bounty     agrees  Immunefi program p of the protocol has ${ADDR} in scope as an etherscan.io address`, 'a website in scope ties it');
});

test('a program tied only by a website in its scope reads the same from a recording, and lends the protocol none of its own sites', async () => {
  const source = `https://github.com/stranger/x/blob/${'a'.repeat(40)}/f.md`;
  const entries = entriesOf({ r: { address: ADDR, kind: 'router', defillama: 'safe', immunefi: 'p', source, sourceLabel: 'Bundler3' } });
  const programs = parseImmunefiPrograms([
    { slug: 'p', websiteUrl: null, githubUrl: 'https://github.com/stranger', assets: [{ type: 'websites_and_applications', url: 'https://app.safe.global/' }], assetsBodyV2: `https://etherscan.io/address/${ADDR}` },
  ]);
  const live = { ...listings, sites: { ...listings.sites, programs } };
  const pages = { pages: new Map(), commits: new Map() };
  const text = report(entries, live, pages);
  assert.match(text, /bounty {5}agrees {2}Immunefi program p of the protocol has/);
  assert.match(text, /defillama {2}FINDING source GitHub org stranger is not one the protocol's places list/);
  const recorded = JSON.parse(JSON.stringify(trimForRecording(entries, live, pages, new Date('2026-11-17'))));
  const replayed = await listingsFor(entries, suffixes, recordedListingReads(recorded), []);
  assert.equal(report(entries, replayed, pages), text, 'the recording, read back, gives the same lines');
});

test('a protocol whose only listed site is on a shared host, such as linktr.ee, has no Immunefi program tied to it through that host', () => {
  const onShared = listingsOf([{ slug: 'p', name: 'P', url: 'https://linktr.ee/p' }], recording.coingecko);
  const entries = entriesOf({ r: { address: ADDR, kind: 'router', defillama: 'p', source: DOCS, sourceLabel: 'Bundler3' } });
  const bounty = (website: string, scope: readonly string[]) => {
    const programs = parseImmunefiPrograms([{ slug: 'other', websiteUrl: website, assets: scope.map((url) => ({ type: 'websites_and_applications', url })), assetsBodyV2: `https://etherscan.io/address/${ADDR}` }]);
    return report(entries, { ...onShared, sites: { ...onShared.sites, programs } }, { pages: new Map(), commits: new Map() }).split('\n').find((line) => line.trimStart().startsWith('bounty'));
  };
  const untied = '  bounty     not listed no Immunefi program lists a website, a website in scope or a GitHub org of p; programs not tied to the protocol that hold it: other';
  assert.equal(bounty('https://linktr.ee/other', []), untied);
  assert.equal(bounty('https://other.org', ['https://linktr.ee/other']), untied);
});

test('a commit off the default branch, such as one only a fork holds, is a finding', async () => {
  assert.match(await github({ status: 200, text: JSON.stringify({ status: 'diverged' }) }), /github {5}FINDING commit ca9cb0d2d5f5 of safe-global\/safe-deployments is not on the default branch main \(GitHub compare: diverged\)/);
  assert.match(await github({ status: 200, text: JSON.stringify({ status: 'ahead' }) }), /github {5}FINDING .* is not on the default branch main \(GitHub compare: ahead\)/);
  assert.match(await github({ status: 404, text: '{"message":"Not Found"}' }), /github {5}FINDING .* is not on the default branch main \(GitHub compare: no such commit in the repository\)/);
});

test('two files pinned in one repository ask GitHub for its default branch once', async () => {
  const OTHER_COMMIT = 'b'.repeat(40);
  const second = `https://github.com/safe-global/safe-deployments/blob/${OTHER_COMMIT}/src/assets/v1.4.1/multi_send.json`;
  const served: Record<string, Served> = {
    [REPO_API]: { status: 200, text: JSON.stringify({ default_branch: 'main' }) },
    [compareUrl]: { status: 200, text: JSON.stringify({ status: 'behind' }) },
    [`${REPO_API}/compare/main...${OTHER_COMMIT}?per_page=1`]: { status: 200, text: JSON.stringify({ status: 'identical' }) },
    [RAW]: deployments,
    [`https://raw.githubusercontent.com/safe-global/safe-deployments/${OTHER_COMMIT}/src/assets/v1.4.1/multi_send.json`]: deployments,
  };
  const asked: string[] = [];
  const pages = await gatherSourcePages([PINNED, second], (url) => {
    asked.push(url);
    return getFrom(served)(url);
  });
  assert.equal(asked.filter((url) => url === REPO_API).length, 1);
  assert.deepEqual([...pages.commits.values()].map((c) => c.kind), ['on-default', 'on-default']);
});

test('a GitHub rate limit or a GitHub server error is UNVERIFIABLE, never a FINDING: no answer is no disagreement', async () => {
  const limited = { status: 403, text: '{"message":"API rate limit exceeded for 1.2.3.4."}', headers: { 'x-ratelimit-remaining': '0' } };
  const unchecked = /github {5}UNVERIFIABLE commit ca9cb0d2d5f5 of safe-global\/safe-deployments: api\.github\.com answered rate limited \(HTTP 403\), the GitHub API rate limit \(60 requests an hour without GITHUB_TOKEN, 5,000 with it\); the commit is not checked, run again later/;
  for (const text of [await github(limited, limited), await github(limited)]) {
    assert.match(text, unchecked);
    assert.doesNotMatch(text, /github {5}FINDING/);
  }
  assert.match(await github({ status: 429, text: '' }), /github {5}UNVERIFIABLE .*: api\.github\.com answered rate limited \(HTTP 429\)/);
  assert.match(await github({ status: 503, text: '' }), /github {5}UNVERIFIABLE .*: api\.github\.com answered HTTP 503; the commit is not checked, run again later/);
  assert.match(await github({ status: 200, text: JSON.stringify({ status: 'behind' }) }, { status: 404, text: '{"message":"Not Found"}' }), /github {5}FINDING .*: GitHub has no repository safe-global\/safe-deployments/);
});

test('a source page whose server fails is UNVERIFIABLE, while a page it answers is missing stays a FINDING', async () => {
  const failing = await pageReport({ source: DOCS, sourceLabel: 'Bundler3' }, { [DOCS]: { status: 502, text: '' } });
  assert.match(failing, /page {7}UNVERIFIABLE https:\/\/docs\.morpho\.org\/addresses answered HTTP 502/);
  assert.match(failing, /1 entries, 0 findings, 1 unverifiable \(r\)/);
  assert.match(await pageReport({ source: DOCS, sourceLabel: 'Bundler3' }, { [DOCS]: { status: 404, text: '' } }), /page {7}FINDING https:\/\/docs\.morpho\.org\/addresses answered HTTP 404/);
});

const PINNED_ENTRY = { r: { address: ADDR, kind: 'router', defillama: 'safe', source: PINNED, sourceLabel: 'canonical' } };

/** The report and the reads noted as unanswered when the compare API answers `compares` in turn, each read asked again twice. */
async function retriedCompare(compares: Served[]): Promise<{ text: string; asked: number; unread: string[] }> {
  const served: Record<string, Served> = { [REPO_API]: { status: 200, text: JSON.stringify({ default_branch: 'main' }) }, [RAW]: deployments };
  const unread: string[] = [];
  let asked = 0;
  const get = retryingGet(
    async (url) => {
      if (url !== compareUrl) return getFrom(served)(url);
      asked++;
      return compares.shift() ?? assert.fail('asked more often than the pauses allow');
    },
    (read) => unread.push(read),
    [0, 0],
  );
  const entries = entriesOf(PINNED_ENTRY);
  return { text: report(entries, listings, await gatherSourcePages(entries.map((e) => e.source), get)), asked, unread };
}

const SERVER_ERROR: Served = { status: 503, text: '' };
const RATE_LIMITED: Served = { status: 403, text: '{"message":"API rate limit exceeded"}', headers: { 'x-ratelimit-remaining': '0' } };

test('a read that gets no answer is asked again after each pause, and the answer that ends it is the result', async () => {
  const { text, asked, unread } = await retriedCompare([SERVER_ERROR, RATE_LIMITED, { status: 200, text: JSON.stringify({ status: 'behind' }) }]);
  assert.equal(asked, 3);
  assert.match(text, /github {5}agrees {2}commit ca9cb0d2d5f5 .*\(GitHub compare: behind\)/);
  assert.deepEqual(unread, []);
  assert.equal(unreadRefusal(unread), undefined, '--record writes');
});

test('an answer is final: a 404 is not asked again and stays a FINDING', async () => {
  const { text, asked, unread } = await retriedCompare([{ status: 404, text: '{"message":"Not Found"}' }]);
  assert.equal(asked, 1);
  assert.match(text, /github {5}FINDING .*no such commit in the repository/);
  assert.deepEqual(unread, []);
});

test('a read with no answer after every pause is UNVERIFIABLE, never a FINDING, and --record refuses to write', async () => {
  const { text, asked, unread } = await retriedCompare([RATE_LIMITED, RATE_LIMITED, RATE_LIMITED]);
  assert.equal(asked, 3);
  assert.match(text, /github {5}UNVERIFIABLE .*rate limited \(HTTP 403\)/);
  assert.doesNotMatch(text, /FINDING/);
  assert.deepEqual(unread, [`${compareUrl}: rate limited (HTTP 403)`]);
  assert.equal(
    unreadRefusal(unread),
    `1 read(s) got no answer after every retry, so nothing is recorded; run the command again later:\n  ${compareUrl}: rate limited (HTTP 403)`,
  );

});

const failing = (code: string): HttpGet => async () => {
  throw Object.assign(new Error(code), { code });
};

test('a dropped connection is asked again and is UNVERIFIABLE; a name DNS says does not exist is an answer and a FINDING', async () => {
  const dropped: string[] = [];
  let asked = 0;
  const reset = failing('ECONNRESET');
  const pages = await gatherSourcePages([DOCS], retryingGet(async (url) => (asked++, reset(url)), (read) => dropped.push(read), [0]));
  assert.equal(asked, 2);
  assert.deepEqual(pages.pages.get(DOCS), { kind: 'unread', why: 'docs.morpho.org unreachable' });
  assert.deepEqual(dropped, [`${DOCS}: unreachable or timed out`]);

  const gone: string[] = [];
  let tried = 0;
  const missing = failing('ENOTFOUND');
  const entries = entriesOf({ r: { address: ADDR, kind: 'router', defillama: 'morpho-blue', source: DOCS, sourceLabel: 'Bundler3' } });
  const text = report(entries, listings, await gatherSourcePages([DOCS], retryingGet(async (url) => (tried++, missing(url)), (read) => gone.push(read), [0])));
  assert.equal(tried, 1);
  assert.match(text, /page {7}FINDING docs\.morpho\.org unreachable/);
  assert.deepEqual(gone, []);
});

test('a 403 whose page mentions rate limits is a FINDING on a source page, and a rate limit only from GitHub\'s API', async () => {
  const forbidden: Served = { status: 403, text: '<p>See our rate limits</p>' };
  assert.match(await pageReport({ source: DOCS, sourceLabel: 'Bundler3' }, { [DOCS]: forbidden }), /page {7}FINDING https:\/\/docs\.morpho\.org\/addresses answered HTTP 403/);
  assert.match(await github({ status: 403, text: '{"message":"You have exceeded a secondary rate limit"}' }), /github {5}UNVERIFIABLE .*rate limited \(HTTP 403\)/);
});

test('a GitHub source on a branch name, a tree, or the repository root is not pinned', async () => {
  for (const source of ['https://github.com/safe-global/safe-deployments/blob/main/src/assets/v1.3.0/multi_send.json', `https://github.com/safe-global/safe-deployments/tree/${COMMIT}/src`, 'https://github.com/safe-global/safe-deployments']) {
    const text = report(entriesOf({ m: { address: ADDR, kind: 'multisend', source, defillama: 'safe' } }));
    assert.match(text, /github {5}FINDING not pinned to a commit: name the file as github\.com\/<org>\/<repo>\/blob\/<40-hex commit>\/<path>/, source);
  }
});

test('the report lists the sites each protocol\'s sources use', () => {
  const text = report([...loadRegistry(ROOT).entries.values()]);
  assert.match(text, /sites per protocol, for the signer to check each is the protocol's own:\n/);
  assert.match(text, /\n {2}safe\n {4}github\.com\/safe-global: multisend-1\.3\.0, multisend-1\.3\.0-eip155,/);
  assert.match(text, /\n {2}morpho-blue\n {4}morpho\.org: bundler3,.*\n {4}github\.com\/morpho-org: bundler3, vault-v2-factory, vault-bundles-v1, general-adapter-1, morpho-blue, adaptive-curve-irm, morpho-market-v1-adapter-v2-factory, blue-bundles-v1\n {2}steakhouse-financial\n/);
  assert.match(text, /\n {2}steakhouse-financial\n {4}steakhouse\.financial: steakhouse-prime-usdc-v2-0f51, steakhouse-high-yield-usdc-v2-a757, steakhouse-usdt-v1-cfba, smokehouse-usdc-v1-f5bc\n/);
});

test('each of moreSources is read and checked as the source is: its label, its site and its commit', async () => {
  const SECOND = 'https://docs.morpho.org/sdk';
  const text = await pageReport(
    { source: DOCS, sourceLabel: 'Bundler3', moreSources: [{ url: SECOND, label: 'bundler3' }, { url: PINNED, label: 'canonical' }] },
    {
      [DOCS]: html(`<p>Bundler3 ${ADDR}</p>`),
      [SECOND]: html(`<p>bundler3: ${OTHER}</p>`),
      [REPO_API]: { status: 200, text: JSON.stringify({ default_branch: 'main' }) },
      [compareUrl]: { status: 200, text: JSON.stringify({ status: 'diverged' }) },
      [RAW]: deployments,
    },
  );
  assert.match(text, /\n {2}source 1 {3}https:\/\/docs\.morpho\.org\/sdk\n {2}source 2 {3}https:\/\/github\.com\/safe-global/);
  assert.match(text, /\n {2}defillama 1 agrees {2}source 1 domain morpho\.org is listed by DefiLlama morpho-blue/);
  assert.match(text, new RegExp(`\\n {2}page 1 {5}FINDING the page binds "bundler3" to ${OTHER}, not the entry's address ${ADDR}`));
  assert.match(text, /\n {2}defillama 2 FINDING source 2 GitHub org safe-global is not one the protocol's places list: morpho-org \(DefiLlama morpho-blue/);
  assert.match(text, /\n {2}github 2 {3}FINDING commit ca9cb0d2d5f5 of safe-global\/safe-deployments is not on the default branch main/);
  assert.match(text, /\n {2}page 2 {5}agrees {2}the page has the address 9 characters after "canonical"/);
});

test('the registry refuses a moreSources page that is malformed, repeats a page, or whose URL holds the address', () => {
  const refused = (moreSources: unknown, problem: RegExp) =>
    assert.throws(
      () => entriesOf({ r: { address: ADDR, kind: 'router', source: DOCS, sourceLabel: 'Bundler3', moreSources } }),
      (e: unknown) => e instanceof RegistryError && problem.test(e.message),
    );
  refused([], /r\.moreSources: not a non-empty list of pages/);
  refused({ url: DOCS, label: 'x' }, /r\.moreSources: not a non-empty list of pages/);
  refused([{ url: 'http://docs.morpho.org/sdk', label: 'x' }], /r\.moreSources\[0\]\.url: not an https URL/);
  refused([{ url: `https://app.morpho.org/vault/${ADDR.toLowerCase()}`, label: 'x' }], /r\.moreSources\[0\]\.url: holds the entry's address, and a page may echo its own URL/);
  refused([{ url: `https://app.morpho.org/vault/${ADDR}`, label: 'x' }], /r\.moreSources\[0\]\.url: holds the entry's address/);
  refused([{ url: DOCS, label: 'x' }], /r\.moreSources\[0\]\.url: names a page the entry already names/);
  refused([{ url: `https://app.morpho.org/vault/0x6566194141%65efa99${ADDR.slice(18)}`, label: 'x' }], /r\.moreSources\[0\]\.url: holds the entry's address/);
  for (const again of ['https://DOCS.morpho.org/addresses#bundler3', 'https://docs.morpho.org/%61ddresses']) {
    refused([{ url: again, label: 'x' }], /r\.moreSources\[0\]\.url: names a page the entry already names/);
  }
  refused([{ url: 'https://docs.morpho.org/sdk', label: 'x' }, { url: 'https://docs.morpho.org/sdk#top', label: 'y' }], /r\.moreSources\[1\]\.url: names a page the entry already names/);
  refused([{ url: 'https://docs.morpho.org/sdk', label: ' x' }], /r\.moreSources\[0\]\.label: not page text of 1 to 120 characters/);
  refused([{ url: 'https://docs.morpho.org/sdk' }], /r\.moreSources\[0\]\.label: not page text/);
  refused([{ url: 'https://docs.morpho.org/sdk', label: 'x', note: 'y' }], /r\.moreSources\[0\]\.note: unexpected field/);
});

test('the registry refuses a github.com file and its raw.githubusercontent.com copy as two pages of one entry', () => {
  const entry = (source: string, url: string) => entriesOf({ r: { address: ADDR, kind: 'router', source, sourceLabel: 'canonical', moreSources: [{ url, label: 'canonical' }] } });
  const same = (e: unknown) => e instanceof RegistryError && /r\.moreSources\[0\]\.url: names a page the entry already names/.test(e.message);
  assert.throws(() => entry(PINNED, RAW), same);
  assert.throws(() => entry(RAW, PINNED), same);
  assert.throws(() => entry(PINNED, RAW.replace('safe-global/safe-deployments', 'Safe-Global/Safe-Deployments')), same);
  assert.doesNotThrow(() => entry(PINNED, RAW.replace('v1.3.0', 'v1.4.1')));
});

test('a source URL that holds the address percent-encoded is a finding, and its page is not read', async () => {
  const source = `https://app.morpho.org/ethereum/vault/0x6566194141%65efa99${ADDR.slice(18).toUpperCase()}/bundler`;
  const text = await pageReport({ source, sourceLabel: 'Bundler3' }, {});
  assert.match(text, /url {8}FINDING the source URL holds the address, and a page echoes its own URL; the page is not read/);
});

test('the registry refuses a sourceLabel that is empty, padded, or too long', () => {
  for (const sourceLabel of ['', ' Bundler3', 'x'.repeat(121), 7]) {
    assert.throws(
      () => entriesOf({ r: { address: FAKE, kind: 'router', source: 'https://example.org/u', sourceLabel } }),
      (e: unknown) => e instanceof RegistryError && /r\.sourceLabel: not page text of 1 to 120 characters/.test(e.message),
    );
  }
});

test('a report that names no registry entry reads no listing, so its recording may hold both lists empty', async () => {
  const read = async (): Promise<unknown> => assert.fail('no listing should be read');
  const none = await listingsFor([], suffixes, { list: read, org: read as never });
  assert.deepEqual([none.protocols.size, none.coinsByAddress.size], [0, 0]);
  const multisend = loadRegistry(ROOT).entries.get('multisend-1.4.1') as RegistryEntry;
  const recordedFor = trimForRecording([multisend], listings, recordedPages, new Date());
  assert.deepEqual(recordedFor.coingecko, []);
  const replayed = await listingsFor([multisend], suffixes, recordedListingReads(recordedFor));
  assert.equal(replayed.coinsByAddress.size, 0);
  assert.match(report([multisend], replayed), /defillama {2}agrees {2}source GitHub org safe-global is listed by DefiLlama safe/);
});

test('an empty listing an entry needs is refused, since it would hide every comparison', async () => {
  const usdc = loadRegistry(ROOT).entries.get('usdc') as RegistryEntry;
  const reads = recordedListingReads(recording);
  await assert.rejects(listingsFor([usdc], suffixes, { ...reads, list: async (target) => (target.path === '/protocols' ? [] : reads.list(target)) }), /DefiLlama sent an empty protocol list/);
  await assert.rejects(listingsFor([usdc], suffixes, { ...reads, list: async (target) => (target.hostname === 'api.coingecko.com' ? [] : reads.list(target)) }), /CoinGecko sent no Ethereum coins/);
});

const merge = async (named: readonly RegistryEntry[], fresh: typeof recording, old: typeof recording = recording, all: readonly RegistryEntry[] = [...loadRegistry(ROOT).entries.values()], pages?: SourcePages) => {
  const reads = askedOnce(recordedListingReads(fresh));
  await listingsFor(named, suffixes, reads);
  return mergedRecording(all, old, reads, pages ?? sourcePagesOf(fresh), suffixes, new Date('2026-12-01'));
};
const recorded = (merged: Awaited<ReturnType<typeof merge>>) => {
  assert.ok(!('refused' in merged), 'refused' in merged ? merged.refused : '');
  return JSON.parse(JSON.stringify(merged)) as typeof recording;
};
const reportOf = async (entries: readonly RegistryEntry[], r: typeof recording) => report(entries, await listingsFor(entries, suffixes, recordedListingReads(r)), sourcePagesOf(r));
const named = (name: string) => [loadRegistry(ROOT).entries.get(name)!];

test('re-recording named entries into the registry recording keeps every other entry\'s checks, a page they share included', async () => {
  const all = [...loadRegistry(ROOT).entries.values()];
  const merged = recorded(await merge(named('bundler3'), recording));
  assert.equal(merged.fetched, '2026-12-01');
  assert.equal(await reportOf(all, merged), await reportOf(all, recording));
});

test('a re-recorded shared list replaces what the old recording held, a coin or a program it no longer lists included', async () => {
  const usdc = named('usdc');
  const delisted = { ...recording, coingecko: recording.coingecko.filter((c: { id: string }) => c.id !== 'usd-coin') };
  assert.match(await reportOf(usdc, recorded(await merge(usdc, delisted))), /coingecko {2}FINDING no CoinGecko listing at this address on ethereum/);
  const moved = { ...recording, coingecko: recording.coingecko.map((c: { id: string }) => (c.id === 'usd-coin' ? { ...c, id: 'usd-coin-2' } : c)) };
  assert.match(await reportOf(usdc, recorded(await merge(usdc, moved))), /coingecko {2}FINDING the entry names coin usd-coin; CoinGecko lists usd-coin-2/, 'the new coin replaces the old, not beside it');
  const closed = { ...recording, immunefi: recording.immunefi.filter((p: { slug: string }) => p.slug !== 'instadapp') };
  const slugs = recorded(await merge(named('fluid-fusdc'), closed)).immunefi.map((p: { slug: string }) => p.slug);
  assert.ok(!slugs.includes('instadapp') && slugs.includes('cowprotocol'), slugs.join(', '));
});

test('a slug DefiLlama lists twice in a re-recorded list stays two protocols, not compared', async () => {
  const usdc = named('usdc');
  const circle = recording.defillama.find((p: { slug: string }) => p.slug === 'circle-usdc');
  const twice = { ...recording, defillama: [...recording.defillama, { ...circle, name: 'Circle Lookalike' }] };
  assert.match(await reportOf(usdc, recorded(await merge(usdc, twice))), /DefiLlama lists 2 protocols with slug "circle-usdc"/);
});

test('a merged recording is refused when a shared Immunefi, coin or organization read got no answer, naming the read', async () => {
  const failed = { ...recording, immunefi: { unread: 'immunefi.com answered HTTP 403' } };
  const merged = await merge(named('fluid-fusdc'), failed);
  assert.ok('refused' in merged && merged.refused.startsWith("no answer from Immunefi's program list (immunefi.com answered HTTP 403)"), JSON.stringify(merged).slice(0, 200));
  const coin = await merge(named('fluid-fusdc'), { ...recording, coinLinks: { ...recording.coinLinks, instadapp: { unread: 'api.coingecko.com answered HTTP 404' } } });
  assert.ok('refused' in coin && coin.refused.includes('CoinGecko coin instadapp (api.coingecko.com answered HTTP 404)'));
});

test('a merged recording drops a page, API answer or creation no registry entry reads any more', async () => {
  const stale = { ...recording, pages: { ...recording.pages, 'https://gone.example/x': { kind: 'served', blocks: [] } }, creations: { ...recording.creations, [FAKE]: { kind: 'unread', why: 'x' } } };
  const merged = recorded(await merge(named('bundler3'), recording, stale));
  assert.ok(!('https://gone.example/x' in merged.pages));
  assert.ok(!(FAKE in merged.creations));
  assert.deepEqual(Object.keys(merged.pages).sort(), Object.keys(recording.pages).sort());
});

test('two entries pinning two commits of one file share its tip page, and re-recording one keeps what the other reads there', async () => {
  const SECOND = 'b'.repeat(40);
  const second = `https://github.com/safe-global/safe-deployments/blob/${SECOND}/src/assets/v1.3.0/multi_send.json`;
  const tip = 'https://raw.githubusercontent.com/safe-global/safe-deployments/refs/heads/main/src/assets/v1.3.0/multi_send.json';
  const both = entriesOf({
    a: { address: ADDR, kind: 'router', defillama: 'safe', source: PINNED, sourceLabel: 'canonical' },
    b: { address: OTHER, kind: 'router', defillama: 'safe', source: second, sourceLabel: 'eip155' },
  });
  const served = getFrom({
    [REPO_API]: { status: 200, text: JSON.stringify({ default_branch: 'main' }) },
    [compareUrl]: { status: 200, text: JSON.stringify({ status: 'behind' }) },
    [`${REPO_API}/compare/main...${SECOND}?per_page=1`]: { status: 200, text: JSON.stringify({ status: 'identical' }) },
    [RAW]: deployments,
    [`https://raw.githubusercontent.com/safe-global/safe-deployments/${SECOND}/src/assets/v1.3.0/multi_send.json`]: deployments,
    [tip]: { status: 200, text: JSON.stringify({ deployments: { canonical: { address: ADDR }, x: { address: FAKE }, y: { address: USDT }, eip155: { address: OTHER } } }) },
  });
  const old = JSON.parse(JSON.stringify(trimForRecording(both, listings, await gatherSourcePages(both.flatMap(pageUrlsOf), served), new Date('2026-11-17'))));
  const fresh = await gatherSourcePages(pageUrlsOf(both[1]!), served);
  const merged = recorded(await merge([both[1]!], recording, old, both, fresh));
  assert.equal(report(both, listings, sourcePagesOf(merged)), report(both, listings, sourcePagesOf(old)));
  assert.match(report(both, listings, sourcePagesOf(merged)), /tip {8}agrees .* binds "canonical" to the address too/);
});
