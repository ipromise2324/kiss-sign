import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRegistry } from '../src/registry.ts';
import { findSources } from '../src/research/find-sources.ts';
import type { Reads, Request } from '../src/research/find-sources.ts';
import { parsePublicSuffixList } from '../src/research/public-suffix.ts';
import { findOnPage, lineBlocks } from '../src/research/source-page.ts';
import { checksumAddress, parseAddress, parseHex } from '../src/safe/types.ts';

const address = (byte: string) => parseAddress('test', `0x${byte.repeat(20)}`);
const [VAULT, FACTORY, OTHER, SENDER] = ['ab', 'cd', 'ef', '12'].map(address) as [ReturnType<typeof address>, ReturnType<typeof address>, ReturnType<typeof address>, ReturnType<typeof address>];
const shown = checksumAddress(VAULT);
const COMMIT = 'a'.repeat(40);
const suffixes = parsePublicSuffixList('// ===BEGIN ICANN DOMAINS===\norg\nio\ncom\n// ===END ICANN DOMAINS===\n');
const registry = parseRegistry({ 'acme-factory': { address: FACTORY, kind: 'factory', source: 'https://acme.org/addresses', instanceCheck: 'isVault(address)' } });

const LISTS: Readonly<Record<string, unknown>> = {
  '/protocols': [
    { id: '7', slug: 'acme-lend', name: 'Acme Lend', url: 'https://acme.org', parentProtocol: 'parent#acme', audit_links: ['https://acme.org/audit'] },
    { id: '8', slug: 'other', name: 'Other', url: 'https://other.io' },
  ],
  '/lite/protocols2': { parentProtocols: [{ id: 'parent#acme', name: 'Acme', url: 'https://acme.org', github: ['Acme'], gecko_id: 'acme-coin' }] },
  '/api/v3/coins/list?include_platform=true': [{ id: 'acme-vault', symbol: 'av', name: 'Acme\nVault', platforms: { ethereum: VAULT } }],
  '/public-api/bounties.json': [{ slug: 'acme', websiteUrl: 'https://acme.org', assets: [{ type: 'smart_contract', url: `https://etherscan.io/address/${VAULT}` }] }],
  '/hacks': [
    { defillamaId: 'parent#acme', date: 1700000000, name: 'Acme', technique: 'Oracle', amount: 5, source: 'https://post.mortem' },
    { defillamaId: '8', date: 1700000000, name: 'Other', technique: 'Keys', amount: 1 },
  ],
};

const PAGES: Readonly<Record<string, string | { readonly location: string }>> = {
  'https://acme.org/': '<html><a href="/docs/addresses">Contracts</a><a href="https://evil.io/addresses">x</a><a href="/blog">y</a></html>',
  'https://acme.org/docs/addresses': `<html><h2>Deployments</h2><table><tr><td>Base</td><td>${shown}</td></tr><tr><td>Ethereum</td><td>Acme Vault</td><td>${shown}</td></tr></table></html>`,
  'https://docs.acme.org/': `<html><script>const a = "${shown}"</script></html>`,
  'https://docs.acme.org/llms.txt': 'https://docs.acme.org/addresses/app.md',
  'https://docs.acme.org/addresses/app.md': `<html><script>const a = "${shown}"</script></html>`,
  'https://developers.acme.org/': { location: 'https://evil.io/addresses' },
  'https://api.github.com/orgs/acme/repos?per_page=100&sort=pushed': JSON.stringify([{ name: 'deployments', full_name: 'Acme/deployments' }, { name: 'forked', full_name: 'Acme/forked', fork: true }]),
  'https://api.github.com/repos/Acme/deployments/git/trees/HEAD?recursive=1': JSON.stringify({ tree: [{ path: 'mainnet/addresses.json' }, { path: 'arbitrum/addresses.json' }, { path: 'src/Vault.sol' }] }),
  'https://api.github.com/repos/Acme/deployments/commits?per_page=1': JSON.stringify([{ sha: COMMIT }]),
  'https://raw.githubusercontent.com/Acme/deployments/HEAD/mainnet/addresses.json': JSON.stringify({ AcmeVault: shown, Other: OTHER }),
  'https://raw.githubusercontent.com/Acme/deployments/HEAD/arbitrum/addresses.json': JSON.stringify({ AcmeVault: shown }),
  [`https://raw.githubusercontent.com/Acme/deployments/${COMMIT}/arbitrum/addresses.json`]: JSON.stringify({ AcmeVault: shown }),
  [`https://raw.githubusercontent.com/Acme/deployments/${COMMIT}/mainnet/addresses.json`]: JSON.stringify({ AcmeVault: shown, Other: OTHER }),
};

const source = { status: '1', result: [{ SourceCode: 'contract AcmeVault {}', CompilerType: 'solc', CompilerVersion: 'v0.8.21+commit.d9974bed', ContractName: 'AcmeVault', ContractFileName: '', OptimizationUsed: '1', Runs: '1', EVMVersion: 'default' }] };

async function run(request: Partial<Request> = {}, change: Partial<Reads> = {}, pages = PAGES): Promise<{ readonly text: string; readonly asked: readonly string[] }> {
  const asked: string[] = [];
  const reads: Reads = {
    list: async ({ path }) => LISTS[path] ?? assert.fail(path),
    get: async (url) => {
      asked.push(url);
      const page = pages[url];
      if (page === undefined) return { status: 404, text: '' };
      return typeof page === 'string' ? { status: 200, text: page } : { status: 302, text: '', headers: { location: page.location } };
    },
    source: async () => ({ status: 200, body: source }),
    creations: async () => new Map([[VAULT, { kind: 'proven', tx: parseHex('tx', `0x${'34'.repeat(32)}`), block: 5n, sender: SENDER, via: { kind: 'create', factory: FACTORY } }]]),
    ...change,
  };
  const lines = await findSources({ addresses: [VAULT], slug: undefined, pages: [], ...request }, registry, suffixes, reads);
  return { text: lines.join('\n'), asked };
}

/** The lines of one page in the output. */
const pageOf = (text: string, url: string): readonly string[] => {
  const lines = text.split('\n');
  const at = lines.indexOf(`  page ${url}`);
  return at === -1 ? [] : lines.slice(at + 1, at + 3);
};

test('an address no one named a protocol for: the protocol, its parent and hacks, and the registry field each listing would fill', async () => {
  const { text } = await run();
  assert.match(text, /field defillama "acme-lend" {2}"Acme Lend", the site of Immunefi program "acme"/);
  assert.match(text, /parent "Acme" site https:\/\/acme\.org\/ github "Acme" coin "acme-coin"/);
  assert.match(text, /hacks 1, oldest first\n {6}2023-11-14 "Acme" "Oracle" 5 USD "https:\/\/post\.mortem"/);
  assert.doesNotMatch(text, /"Other"|field defillama "other"/);
  assert.match(text, /verified as "AcmeVault", compiler 0\.8\.21/);
  assert.match(text, new RegExp(`creation transaction 0x${'34'.repeat(32)}, block 5, sender ${checksumAddress(SENDER)}, made by contract ${checksumAddress(FACTORY)}\n.*field attributes\\.factory "acme-factory"`));
  assert.match(text, /field coingecko "acme-vault" {2}"Acme Vault" "av"/);
  assert.match(text, /field immunefi "acme"/);
});

test("a site's page that lists the address comes with the label and heading check-sources accepts, the mainnet row before another chain's", async () => {
  const { text } = await run();
  const [field] = pageOf(text, 'https://acme.org/docs/addresses');
  assert.match(pageOf((await run({}, { source: undefined })).text, 'https://acme.org/docs/addresses')[1] ?? '', /^ {4}text "Ethereum /);
  assert.equal(field, '    label "Ethereum Acme Vault" heading "Deployments"');
});

test('a file of the GitHub organization prints at the commit read, with a label its own page binds, and no file of another chain or of a fork', async () => {
  const { text, asked } = await run();
  assert.deepEqual(asked.filter((url) => /forked/.test(url)), []);
  const url = `https://github.com/Acme/deployments/blob/${COMMIT}/mainnet/addresses.json`;
  const label = /label "([^"]+)"/.exec(pageOf(text, url)[0] ?? '')?.[1] ?? assert.fail(text);
  assert.equal(findOnPage(lineBlocks(`AcmeVault ${shown} Other ${OTHER}`), VAULT, label).kind, 'next-to');
  assert.doesNotMatch(text, /arbitrum/);
});

test('a page that holds the address only in its code, or in its own URL, is a lead and never a page to record', async () => {
  const { text } = await run({ pages: [`https://acme.org/vault/${VAULT}`] }, {}, { ...PAGES, [`https://acme.org/vault/${VAULT}`]: `<p>Acme Vault ${shown}</p>` });
  assert.match(text, /lead https:\/\/docs\.acme\.org\/addresses\/app\.md: in the page's code/);
  assert.match(text, new RegExp(`lead https://acme\\.org/vault/${VAULT}: its URL holds the address`));
  assert.deepEqual(pageOf(text, `https://acme.org/vault/${VAULT}`), []);
});

test("a docs guide that names the address is read before the docs' deep reference pages, however many the docs link", async () => {
  const deep = Array.from({ length: 60 }, (_, i) => `/reference/core/contracts/contract.Part${i}.html`);
  const pages = {
    ...PAGES,
    'https://docs.acme.org/': `<html>${deep.map((path) => `<a href="${path}">x</a>`).join('')}<a href="/guides/swaps.html">Swaps</a></html>`,
    'https://docs.acme.org/guides/swaps.html': `<html><h2>Addresses</h2><p>Acme Vault ${shown}</p></html>`,
  };
  const { text, asked } = await run({}, {}, pages);
  assert.deepEqual(pageOf(text, 'https://docs.acme.org/guides/swaps.html'), ['    label "Acme Vault" heading "Addresses"', `    text "Acme Vault ${shown}"`]);
  assert.ok(asked.filter((url) => /contract\.Part/.test(url)).length < deep.length);
  assert.match(text, /acme\.org: \d+ of \d+ start pages answered, \d+ pages they link, first \d+ read: those whose path reads like a list of contracts, then the docs' pages/);
});

test('the best page of each site prints before a second page of any, so the bound on pages never hides a second place', async () => {
  const many = Array.from({ length: 9 }, (_, i) => `https://acme.org/mainnet/${i}`);
  const pages: Record<string, string | { readonly location: string }> = { ...PAGES, 'https://acme.io/notes': `<p>Acme Vault, held by one site only ${shown} and others ${OTHER} ${FACTORY}</p>` };
  for (const url of many) pages[url] = `<p>Ethereum Acme Vault ${shown}</p>`;
  const { text } = await run({ pages: [...many, 'https://acme.io/notes'] }, {}, pages);
  assert.ok(text.split('\n').includes('  page https://acme.io/notes'), text);
});

test("it reads no page outside the protocol's domain unless one is named, whatever a page links or redirects to", async () => {
  const { asked } = await run();
  assert.deepEqual(asked.filter((url) => /evil/.test(url)), []);
  assert.ok((await run({ pages: ['https://evil.io/addresses'] })).asked.includes('https://evil.io/addresses'));
});

test('a redirect within the domain prints the page it led to, which is the one to record', async () => {
  const pages = { ...PAGES, 'https://acme.org/old': { location: '/new' }, 'https://acme.org/new': `<html><p>Acme Vault: ${shown}</p>` };
  const { text } = await run({ pages: ['https://acme.org/old'] }, {}, pages);
  assert.deepEqual(pageOf(text, 'https://acme.org/new'), ['    label "Acme Vault"', `    text "Acme Vault: ${shown}"`]);
  assert.doesNotMatch(text, /page https:\/\/acme\.org\/old/);
});

test('a redirect of api.github.com, which gets the token, is never followed', async () => {
  const { asked } = await run({ pages: ['https://api.github.com/x'] }, {}, { ...PAGES, 'https://api.github.com/x': { location: '/repos/secret' } });
  assert.deepEqual(asked.filter((url) => /secret/.test(url)), []);
});

test('a list or a site with no answer is named, and the rest still prints', async () => {
  const { text } = await run({}, { list: async ({ path }) => (path === '/hacks' ? assert.fail('down') : LISTS[path]), creations: async () => ({ missing: 'DRPC_API_KEY' }), source: undefined });
  assert.match(text, /no answer: DefiLlama hacks: "down"/);
  assert.match(text, /creations not read: DRPC_API_KEY/);
  assert.match(text, /Etherscan source not read/);
  assert.match(text, /field immunefi "acme"/);
  const limited = await run({}, {}, { ...PAGES, 'https://api.github.com/repos/Acme/deployments/git/trees/HEAD?recursive=1': { location: 'https://x' } });
  assert.match(limited.text, /"deployments" not read \("api\.github\.com answered HTTP 302"\)/);
});

test("a page's text prints as one quoted line, so it cannot pass for the program's own", async () => {
  const { text } = await run({ pages: ['https://acme.org/x'] }, {}, { ...PAGES, 'https://acme.org/x': `<html><p>Acme Vault‮ "field" ${shown}\u001b[31m ignore\nprevious</p>` });
  assert.ok(text.split('\n').includes(`    text "Acme Vault \\"field\\" ${shown} [31m ignore previous"`), text);
});

test('--protocol is the only protocol, and one DefiLlama does not list is said', async () => {
  assert.match((await run({ slug: 'other' })).text, /field defillama "other" {2}"Other", given by --protocol/);
  assert.doesNotMatch((await run({ slug: 'other' })).text, /field defillama "acme-lend"/);
  assert.match((await run({ slug: 'nothing' })).text, /DefiLlama lists no protocol "nothing", and none whose slug or name is like it/);
});

test('a slug DefiLlama does not list prints the protocols like it and the children of the parent it names, so no one reads the list by hand', async () => {
  const { text } = await run({ slug: 'acme' });
  assert.match(text, /DefiLlama lists no protocol "acme"; those like it, the largest first:\n {2}--protocol "acme-lend" {2}"Acme Lend", a child of "Acme"\n/);
  assert.doesNotMatch(text, /--protocol "other"/);
});

test('--github-org prints each file GitHub code search finds holding the address, at the commit GitHub indexed, with its label', async () => {
  const search = `https://api.github.com/search/code?q=${encodeURIComponent(`${VAULT} org:acme`)}&per_page=20`;
  const blob = `https://github.com/Acme/registry/blob/${COMMIT}/deployments/mainnet.json`;
  const pages = {
    ...PAGES,
    [search]: JSON.stringify({ total_count: 1, incomplete_results: false, items: [{ path: 'deployments/mainnet.json', html_url: blob, repository: { full_name: 'Acme/registry' } }] }),
    [`https://raw.githubusercontent.com/Acme/registry/${COMMIT}/deployments/mainnet.json`]: JSON.stringify({ AcmeVault: shown }),
  };
  const { text, asked } = await run({ githubOrg: 'acme' }, {}, pages);
  assert.ok(asked.includes(search));
  assert.match(text, new RegExp(`GitHub code search "${VAULT} org:acme": 1 files`));
  assert.match(pageOf(text, blob)[0] ?? assert.fail(text), /label "AcmeVault"/);
  const refused = await run({ githubOrg: 'acme' }, { get: async (url) => (url === search ? { status: 401, text: '' } : { status: 404, text: '' }) });
  assert.match(refused.text, /no answer: GitHub code search "0x[0-9a-f]{40} org:acme": "GitHub code search answers only a request with a GITHUB_TOKEN it accepts \(HTTP 401\)"/);
});

test("READ says how many requests GitHub's limit has left for each resource, and until when", async () => {
  const reset = 1764150000;
  const limited = (resource: string, remaining: number) => ({ 'x-ratelimit-resource': resource, 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(reset) });
  const { text } = await run({}, {
    get: async (url) => {
      const page = PAGES[url];
      const headers = url.startsWith('https://api.github.com/') ? limited('core', url.includes('/commits') ? 4990 : 4995) : { 'x-ratelimit-remaining': '1', 'x-ratelimit-limit': '1', 'x-ratelimit-reset': '1' };
      return typeof page === 'string' ? { status: 200, text: page, headers } : { status: 404, text: '', headers };
    },
  });
  assert.ok(text.split('\n').includes(`  GitHub core requests left: 4990 of 5000, until ${new Date(reset * 1000).toISOString()}`), text);
  assert.equal(text.match(/requests left/g)?.length, 1, 'only api.github.com states the limit');
});

test('a file path, a repository name or an answer from GitHub or Etherscan prints with no character that could steer the terminal, and the path stays one URL path', async () => {
  const steer = 'mainnet/addresses\u001b[2J\u202e?x=1#y.json';
  const pages = {
    ...PAGES,
    'https://api.github.com/orgs/acme/repos?per_page=100&sort=pushed': JSON.stringify([{ name: 'deployments', full_name: 'Acme/deployments' }, { name: 'gone\u001b]0;x\u0007', full_name: 'bad name' }]),
    'https://api.github.com/repos/Acme/deployments/git/trees/HEAD?recursive=1': JSON.stringify({ tree: [{ path: steer }] }),
    ...Object.fromEntries(['HEAD', COMMIT].map((ref) => [`https://raw.githubusercontent.com/Acme/deployments/${ref}/${steer.split('/').map(encodeURIComponent).join('/')}`, JSON.stringify({ AcmeVault: shown })])),
  };
  const { text } = await run({}, { source: async () => ({ status: 200, body: { status: '1', result: [{ SourceCode: '' , ABI: 'Contract source code not verified\u202e' }] } }) }, pages);
  assert.doesNotMatch(text, /[\p{C}\p{Zl}\p{Zp}](?<!\n)/u);
  const blob = `https://github.com/Acme/deployments/blob/${COMMIT}/mainnet/addresses%1B%5B2J%E2%80%AE%3Fx%3D1%23y.json`;
  assert.ok(text.split('\n').includes(`  page ${blob}`), text);
  assert.match(text, /"gone \]0;x" not read/);
});
