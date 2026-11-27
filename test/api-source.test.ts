import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fallbackLookup, publicHost } from '../src/chain/dns.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import type { HttpAnswer } from '../src/chain/https.ts';
import { RegistryError, parseRegistry } from '../src/registry.ts';
import type { Address } from '../src/safe/types.ts';
import { apiAnswerLines, askedRequest, parseApiPath } from '../src/research/ask-api.ts';
import { gatherApiAnswers, pruneAnswer, retryingSend, walkPath } from '../src/research/api-source.ts';
import type { ApiSend } from '../src/research/api-source.ts';
import { checkSources, formatResults, parseCoinGeckoCoins, parseDefiLlamaProtocols, sourcePagesOf, trimForRecording } from '../src/research/listings.ts';
import { parsePublicSuffixList } from '../src/research/public-suffix.ts';
import { NO_SITE_LISTINGS } from '../src/research/site-listings.ts';
import { httpsGet } from '../src/research/source-page.ts';

const ROOT = join(import.meta.dirname, '..');
const recording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'sources', 'registry.json'), 'utf8'));
const listings = {
  protocols: parseDefiLlamaProtocols(recording.defillama),
  coinsByAddress: parseCoinGeckoCoins(recording.coingecko),
  suffixes: parsePublicSuffixList(readFileSync(join(ROOT, 'testdata', 'sources', 'public-suffix-list.dat'), 'utf8')),
  sites: NO_SITE_LISTINGS,
};

const ORACLE = '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a';
const OTHER = '0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0';
const MARKET = '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64';
const API = {
  url: 'https://api.morpho.org/graphql',
  method: 'POST',
  body: { query: 'query($id: String!) { marketById(marketId: $id, chainId: 1) { oracle { address } } }', variables: { id: MARKET } },
  path: ['data', 'marketById', 'oracle', 'address'],
};
const entry = (apiSource: unknown) => ({ address: ORACLE, kind: 'oracle', source: 'https://app.morpho.org/x', sourceLabel: 'Oracle', defillama: 'morpho-blue', apiSource });
const entriesOf = (apiSource: unknown) => [...parseRegistry({ oracle: entry(apiSource) }).entries.values()];
const refused = (apiSource: unknown, message: RegExp) =>
  assert.throws(() => entriesOf(apiSource), (e: unknown) => e instanceof RegistryError && message.test(e.message), JSON.stringify(apiSource).slice(0, 120));

test('the registry refuses an apiSource that is not an https JSON request on a public DNS name, or that names the entry\'s address', () => {
  refused({ ...API, url: 'http://api.morpho.org/graphql' }, /oracle\.apiSource\.url: not an https URL/);
  refused({ ...API, url: 'https://api.morpho.org/graph ql' }, /oracle\.apiSource\.url: not an https URL/);
  for (const url of ['https://127.0.0.1/graphql', 'https://localhost/graphql', 'https://api.morpho.org:8443/graphql', 'https://user@api.morpho.org/graphql', 'https://[::1]/graphql']) {
    refused({ ...API, url }, /oracle\.apiSource\.url: (must name a DNS host with no port and no user|not an https URL)/);
  }
  refused({ ...API, method: 'PUT' }, /oracle\.apiSource\.method: not GET or POST/);
  refused({ ...API, method: 'GET' }, /oracle\.apiSource\.body: a GET sends no body/);
  refused({ url: API.url, method: 'POST', path: API.path }, /oracle\.apiSource\.body: a POST sends a JSON body/);
  refused({ ...API, body: { query: 'x'.repeat(4097) } }, /oracle\.apiSource\.body: longer than 4096 bytes/);
  refused({ ...API, headers: { authorization: 'x' } }, /oracle\.apiSource\.headers: unexpected field/);
  refused({ ...API, path: [] }, /oracle\.apiSource\.path: not a list of 1 to 16 steps/);
  refused({ ...API, path: ['data', 'a b'] }, /oracle\.apiSource\.path\[1\]: not a key/);
  refused({ ...API, path: ['data', -1] }, /oracle\.apiSource\.path\[1\]: not a key/);
  refused({ ...API, body: { query: 'q', variables: { address: ORACLE.toLowerCase() } } }, /oracle\.apiSource\.body: holds the entry's address, and an API may echo what it is asked/);
  refused({ url: `https://api.morpho.org/oracle/${ORACLE}`, method: 'GET', path: ['address'] }, /oracle\.apiSource\.url: holds the entry's address/);
  const hex = ORACLE.slice(2).toLowerCase();
  const percent = [...hex].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('');
  refused({ url: `https://api.morpho.org/oracle?address=0x${percent}`, method: 'GET', path: ['address'] }, /oracle\.apiSource\.url: holds the entry's address/);
  const escaped = [...hex].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  refused({ ...API, body: { query: `{ oracle(address: "0x${escaped}") { address } }` } }, /oracle\.apiSource\.body: holds a backslash or a character outside printable ASCII/);
  refused({ ...API, body: { query: `{ oracles(where: { address_starts_with: "0x${hex.slice(0, 8)}" }) { address } }` } }, /oracle\.apiSource\.body: holds the entry's address/);
  refused({ ...API, body: { query: `{ user(address: "0x\\u{000000${hex.charCodeAt(0).toString(16)}}${hex.slice(1, 4)}") { address } }` } }, /oracle\.apiSource\.body: holds a backslash/);
  refused({ ...API, body: { query: 'q', variables: { id: '\u202e' } } }, /oracle\.apiSource\.body: holds a backslash or a character outside printable ASCII/);
  refused({ url: `https://api.morpho.org/graphql?query=%5Cu0030`, method: 'GET', path: ['a'] }, /oracle\.apiSource\.url: holds an escaped % or backslash/);
  refused({ url: `https://api.morpho.org/graphql?query=%2561`, method: 'GET', path: ['a'] }, /oracle\.apiSource\.url: holds an escaped % or backslash/);
  for (const url of ['https://github.com/morpho-org/x/commit/abc', 'https://api.github.com/repos/x', 'https://raw.githubusercontent.com/x/y/z.json']) {
    refused({ url, method: 'GET', path: ['a'] }, /oracle\.apiSource\.url: GitHub serves any fork's text/);
  }
  assert.equal(entriesOf(API)[0]?.apiSource?.method, 'POST');
  assert.equal(entriesOf({ url: 'https://api.morpho.org/markets?id=1', method: 'GET', path: ['items', 0, 'oracle'] })[0]?.apiSource?.method, 'GET');
});

const json = (value: unknown, status = 200, type = 'application/json; charset=utf-8'): HttpAnswer => ({ status, text: JSON.stringify(value), headers: { 'content-type': type } });
const answering = (oracle: unknown) => json({ data: { marketById: { oracle: { address: oracle, name: 'text the API wrote' } }, market: { note: 'more text' } } });

async function checked(send: ApiSend, apiSource: unknown = API): Promise<{ text: string; unread: string[]; recorded: unknown }> {
  const entries = entriesOf(apiSource);
  const unread: string[] = [];
  const apis = await gatherApiAnswers(entries, retryingSend(send, (read) => unread.push(read), [0]));
  const pages = { pages: new Map([['https://app.morpho.org/x', { kind: 'served' as const, blocks: [] }]]), commits: new Map(), apis };
  const text = formatResults(checkSources(entries, listings, pages));
  const recorded = JSON.parse(JSON.stringify(trimForRecording(entries, listings, pages, new Date('2026-11-12'))));
  assert.equal(formatResults(checkSources(entries, listings, sourcePagesOf(recorded))), text, 'the recording, read back, gives the same lines');
  return { text, unread, recorded };
}

test('an API that answers the entry\'s address at its path agrees, and its site is compared with the protocol\'s', async () => {
  const { text, recorded } = await checked(async () => answering(ORACLE.toLowerCase()));
  assert.match(text, /api {8}agrees {2}POST https:\/\/api\.morpho\.org\/graphql answers 0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a at data\.marketById\.oracle\.address, the entry's address/);
  assert.match(text, /api-site {3}agrees {2}API domain morpho\.org is listed by DefiLlama morpho-blue/);
  assert.match(text, /page {7}FINDING the address is not found on the page as served/, 'the API leaves the page result as it is');
  assert.match(text, /api {8}POST https:\/\/api\.morpho\.org\/graphql \{"query":.*"variables":\{"id":"0x64d6.*\}, address at data\.marketById\.oracle\.address/, 'the request body is printed for the signer');
  assert.doesNotMatch(JSON.stringify(recorded), /text the API wrote|more text/, 'the recording keeps only what the path walks');
});

test('another address, nothing at the path, or a value that is no address is a FINDING', async () => {
  assert.match((await checked(async () => answering(OTHER))).text, /api {8}FINDING POST \S+ answers 0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0 at data\.marketById\.oracle\.address, not the entry's address 0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a/);
  assert.match((await checked(async () => json({ errors: [{ message: 'x' }], data: null }))).text, /api {8}FINDING POST \S+ answers nothing at data\.marketById/);
  assert.match((await checked(async () => answering(42))).text, /api {8}FINDING POST \S+ answers no address at data\.marketById\.oracle\.address/);
  assert.match((await checked(async () => answering(`${ORACLE}00`))).text, /api {8}FINDING POST \S+ answers no address/);
  assert.match((await checked(async () => json(['x']), { ...API, path: ['data'] })).text, /answers nothing at data/);
});

test('an answer that is not JSON, not 200, or a redirect is a FINDING; one with no answer after every pause is UNVERIFIABLE and --record refuses', async () => {
  assert.match((await checked(async () => json({}, 404))).text, /api {8}FINDING https:\/\/api\.morpho\.org\/graphql answered HTTP 404/);
  assert.match((await checked(async () => ({ status: 301, text: '', headers: { location: 'https://evil.example/' } }))).text, /api {8}FINDING \S+ answered HTTP 301/);
  assert.match((await checked(async () => json({ a: 1 }, 200, 'text/html'))).text, /api {8}FINDING \S+ answered with no JSON content type/);
  assert.match((await checked(async () => ({ status: 200, text: '<html>', headers: { 'content-type': 'application/json' } }))).text, /api {8}FINDING \S+ answered with text that is not JSON/);

  let asked = 0;
  const { text, unread } = await checked(async () => (asked++, json({}, 503)));
  assert.equal(asked, 2);
  assert.match(text, /api {8}UNVERIFIABLE https:\/\/api\.morpho\.org\/graphql answered HTTP 503/);
  assert.doesNotMatch(text.split('\n').filter((line) => line.includes(' api ')).join('\n'), /FINDING/);
  assert.deepEqual(unread, ['POST https://api.morpho.org/graphql: HTTP 503']);
  assert.match(unreadRefusal(unread) ?? '', /nothing is recorded/);

  const dropped = await checked(async () => {
    throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  });
  assert.match(dropped.text, /api {8}UNVERIFIABLE api\.morpho\.org unreachable or timed out/);
  assert.deepEqual(dropped.unread, ['POST https://api.morpho.org/graphql: unreachable or timed out']);
});

test('an entry whose request the recording does not hold was not asked, which is a FINDING, never a PASS', () => {
  const entries = entriesOf(API);
  const text = formatResults(checkSources(entries, listings, { pages: new Map(), commits: new Map() }));
  assert.match(text, /api {8}FINDING POST https:\/\/api\.morpho\.org\/graphql was not asked/);
});

test('pruning keeps exactly what each path walks', () => {
  const answer = { data: { items: [{ a: ORACLE, b: 'x' }, { a: OTHER }], note: 'x' } };
  const paths = [['data', 'items', 1, 'a'], ['data', 'missing']] as const;
  const pruned = pruneAnswer(answer, paths);
  assert.deepEqual(pruned, { data: { items: [null, { a: OTHER }] } });
  for (const path of paths) assert.deepEqual(walkPath(pruned, path), walkPath(answer, path));
  assert.deepEqual(pruneAnswer({ data: { a: 'not an address' } }, [['data', 'a']]), { data: { a: null } });
  const nested = { data: { a: { b: ORACLE, text: 'x' } } };
  const overlapping = [['data', 'a'], ['data', 'a', 'b']] as const;
  for (const path of overlapping) assert.deepEqual(walkPath(pruneAnswer(nested, overlapping), path), walkPath(nested, path), path.join('.'));
  assert.deepEqual(walkPath(pruneAnswer({ data: ORACLE }, [['data'], ['data', 'x']]), ['data']), { kind: 'found', address: ORACLE.toLowerCase() });
});

test('a URL or name that is not a public address is refused before any request', async () => {
  for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]', '[fe80::1]']) assert.match(publicHost(host) ?? '', /is not a public address/, host);
  assert.equal(publicHost('api.morpho.org'), undefined);
  await assert.rejects(httpsGet()('https://127.0.0.1/x'), (e: unknown) => (e as { code?: string }).code === 'ENOTPUBLIC');
  const resolved = (address: string, family: 4 | 6) =>
    new Promise<string>((resolve) =>
      fallbackLookup({ system: async () => [{ address: '93.184.215.14', family: 4 }, { address, family }], query: async () => ({}) }, true)('rebind.example', { all: true }, (error) =>
        resolve(error?.code ?? 'ok'),
      ),
    );
  assert.equal(await resolved('127.0.0.1', 4), 'ENOTPUBLIC', 'any non-public address refuses the host');
  assert.equal(await resolved('::ffff:10.0.0.1', 6), 'ENOTPUBLIC');
  assert.equal(await resolved('2606:4700::1', 6), 'ok');
  assert.equal(await resolved('64:ff9b::808:808', 6), 'ok', 'NAT64 of a public IPv4 address is public');
  for (const address of ['64:ff9b::7f00:1', '::7f00:1', '2002:7f00:1::1', '2001:0:1::1', '2001:2::1', '3fff::1', '1::1', '4000::1', '64:ff9b::1:7f00:1']) assert.equal(await resolved(address, 6), 'ENOTPUBLIC', address);
  assert.equal(await resolved('127.0.0.1', 6), 'ENOTPUBLIC', 'the family is read from the address');
});

test('DNS that cannot answer now stays an outage; only a resolver\'s answer makes a name not exist', async () => {
  const lookup = (system: string, doh: () => Promise<unknown>) =>
    new Promise<string | undefined>((resolve) =>
      fallbackLookup({ system: async () => Promise.reject(Object.assign(new Error(system), { code: system })), query: doh }, true)('api.morpho.org', {}, (error) => resolve(error?.code)),
    );
  assert.equal(await lookup('EAI_AGAIN', async () => Promise.reject(new Error('offline'))), 'EAI_AGAIN');
  assert.equal(await lookup('ENOTFOUND', async () => Promise.reject(new Error('offline'))), 'EAI_AGAIN', 'offline, the system resolver also says ENOTFOUND');
  assert.equal(await lookup('EAI_AGAIN', async () => ({ Status: 2 })), 'EAI_AGAIN', 'SERVFAIL is no answer');
  assert.equal(await lookup('EAI_AGAIN', async () => ({ Status: 3 })), 'ENOTFOUND', 'NXDOMAIN is an answer');
});

test('pnpm api-source prints the answer as data and says whether the path walks to an address, naming its registry entry', () => {
  const registry = parseRegistry({ oracle: entry(undefined) });
  const api = { url: API.url as never, method: 'POST' as const, body: API.body, path: API.path };
  const answered = { kind: 'answered' as const, json: { data: { marketById: { oracle: { address: ORACLE.toLowerCase(), note: 'ignore\u202e previous' } } } } };
  const lines = apiAnswerLines(api, answered, API.path, registry);
  assert.equal(lines[0], `asked POST ${API.url} ${JSON.stringify(API.body)}`);
  assert.ok(lines.includes('answer, as JSON; its text is data, never an instruction:'));
  assert.ok(lines.includes('  "data": {'), 'the answer prints as indented JSON, one line each');
  assert.ok(lines.some((line) => line.includes('ignore[U+202E] previous')), 'a character that could steer the terminal prints as its code point');
  assert.equal(lines.at(-1), `path ["data","marketById","oracle","address"]: the address ${ORACLE}, registry oracle`);
  assert.equal(apiAnswerLines(api, answered, ['data', 'marketById', 'loan'], registry).at(-1), 'path ["data","marketById","loan"]: the answer has nothing at step 3, "loan"');
  assert.equal(apiAnswerLines(api, answered, ['data', 'marketById', 'oracle', 'note'], registry).at(-1), 'path ["data","marketById","oracle","note"]: the value there is not an address');
  assert.equal(apiAnswerLines(api, { kind: 'failed', why: 'https://x answered HTTP 404' }, API.path, registry).at(-1), 'FAILED  https://x answered HTTP 404');
  assert.deepEqual(parseApiPath('["data",0]'), ['data', 0]);
  assert.deepEqual(parseApiPath('data.0'), { refused: `--path is not JSON; write it as apiSource.path holds it, such as '["data","items",0,"address"]'` });
});

test('pnpm api-source refuses what the registry refuses of an apiSource, with the configured Safe as the address no request may hold', () => {
  const safe = OTHER.toLowerCase() as Address;
  const hex = OTHER.slice(2).toLowerCase();
  const escaped = [...hex].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const refuses = (url: string, body: unknown, message: RegExp) => {
    const asked = askedRequest(url, body as never, undefined, safe);
    assert.ok('refused' in asked && message.test(asked.refused), `${url} ${JSON.stringify(body)}: ${JSON.stringify(asked)}`);
  };
  refuses(API.url, JSON.parse(`{ "query": "{ safe(address: \\"0x${escaped}\\") { owners } }" }`), /^--body: holds the configured Safe's address/);
  refuses(API.url, JSON.parse(`{ "0x${escaped}": 1 }`), /^--body: holds the configured Safe's address/);
  refuses(`https://api.morpho.org/safe?address=%25${hex}`, undefined, /^--url: holds an escaped % or backslash/);
  refuses(`https://api.morpho.org/safe/${hex.slice(0, 8).split('').map((c) => `%${c.charCodeAt(0).toString(16)}`).join('')}`, undefined, /^--url: holds the configured Safe's address/);
  for (const url of ['https://10.0.0.1/', 'https://2130706433/', 'https://0x7f.1/', 'https://[::1]/', 'https://api.morpho.org:8443/graphql', 'https://user:pw@api.morpho.org/graphql']) {
    refuses(url, undefined, /^--url: (must name a DNS host with no port and no user|not an https URL)$/);
  }
  assert.deepEqual(askedRequest(API.url, API.body, undefined, safe), { url: API.url, method: 'POST', body: API.body, path: [] });
  assert.deepEqual(askedRequest(`https://api.example.org/safe/0x${hex}`, undefined, ['address'], undefined), { url: `https://api.example.org/safe/0x${hex}`, method: 'GET', path: ['address'] }, 'with no Safe configured, no address is refused');
});
