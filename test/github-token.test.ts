import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { RequestFn } from '../src/chain/https.ts';
import { nodePinSolcIo } from '../src/contracts/pin-solc.ts';
import { githubAuthorization } from '../src/research/github-token.ts';
import type { GithubToken } from '../src/research/github-token.ts';
import { gatherSourcePages, httpsGet } from '../src/research/source-page.ts';

const ROOT = join(import.meta.dirname, '..');
const TOKEN = 'github_pat_planted0for0the0transport0test' as GithubToken;
const COMMIT = 'ae65e89408f387ffb47d220879925c4ab384dfc2';
const SOURCE = `https://github.com/acme/contracts/blob/${COMMIT}/README.md`;

type Sent = { readonly host: string; readonly path: string; readonly headers: OutgoingHttpHeaders };
type Canned = { readonly status: number; readonly body: string; readonly headers?: Record<string, string> };

/** A `RequestFn` that answers from `answers` by host and path, and keeps every request it was asked to send. */
function fakeSend(answers: Readonly<Record<string, Canned>>, sent: Sent[]): RequestFn {
  return (options, onResponse) => {
    const host = String(options.hostname);
    const path = String(options.path);
    sent.push({ host, path, headers: { ...(options.headers as OutgoingHttpHeaders) } });
    const canned = answers[`${host}${path}`] ?? { status: 404, body: 'not found' };
    const request = new EventEmitter() as ClientRequest;
    request.end = (() => {
      const response = Object.assign(Readable.from([Buffer.from(canned.body)]), { statusCode: canned.status, headers: canned.headers ?? {} });
      onResponse(response as unknown as IncomingMessage);
      return request;
    }) as ClientRequest['end'];
    request.destroy = (() => request) as ClientRequest['destroy'];
    return request;
  };
}

const GITHUB_ANSWERS: Record<string, Canned> = {
  'api.github.com/repos/acme/contracts': { status: 200, body: JSON.stringify({ default_branch: 'main' }) },
  [`api.github.com/repos/acme/contracts/compare/main...${COMMIT}?per_page=1`]: { status: 200, body: JSON.stringify({ status: 'behind' }) },
  [`raw.githubusercontent.com/acme/contracts/${COMMIT}/README.md`]: { status: 200, body: 'Vault 0x0000000000000000000000000000000000000001\n' },
};

const asJson = (pages: Awaited<ReturnType<typeof gatherSourcePages>>): string => JSON.stringify({ pages: [...pages.pages], commits: [...pages.commits] });

test('the GitHub token goes to api.github.com only, and the answers are the same with it or without it', async () => {
  const withToken: Sent[] = [];
  const without: Sent[] = [];
  const read = await gatherSourcePages([SOURCE], httpsGet(TOKEN, fakeSend(GITHUB_ANSWERS, withToken)));
  const readWithout = await gatherSourcePages([SOURCE], httpsGet(undefined, fakeSend(GITHUB_ANSWERS, without)));

  assert.deepEqual(read.commits.get(`acme/contracts@${COMMIT}`), { kind: 'on-default', branch: 'main', status: 'behind' });
  assert.equal(asJson(read), asJson(readWithout));
  assert.ok(!asJson(read).includes(TOKEN));
  assert.deepEqual(
    withToken.map(({ host, headers }) => [host, headers.authorization]),
    [
      ['api.github.com', `Bearer ${TOKEN}`],
      ['api.github.com', `Bearer ${TOKEN}`],
      ['raw.githubusercontent.com', undefined],
    ],
  );
  assert.ok(without.every(({ headers }) => headers.authorization === undefined));
});

test('a redirect from api.github.com is an answer, so the token never follows it to another host', async () => {
  const sent: Sent[] = [];
  const answers = { 'api.github.com/repos/acme/contracts': { status: 302, body: '', headers: { location: 'https://collector.example/steal' } } };
  const read = await gatherSourcePages([SOURCE], httpsGet(TOKEN, fakeSend(answers, sent)));
  assert.equal(read.commits.get(`acme/contracts@${COMMIT}`)?.kind, 'unknown');
  assert.deepEqual([...new Set(sent.map(({ host }) => host))], ['api.github.com', 'raw.githubusercontent.com']);
  assert.ok(!asJson(read).includes(TOKEN));
});

test('a token api.github.com refuses is dropped, so the answers are those no token gives, and the refusal is said once', async (t) => {
  const said = t.mock.method(console, 'error', () => {});
  const sent: Sent[] = [];
  const refusing: RequestFn = (options, onResponse) => {
    const github = (options.headers as OutgoingHttpHeaders).authorization !== undefined;
    return fakeSend(github ? { [`${options.hostname}${options.path}`]: { status: 401, body: '{"message":"Bad credentials"}' } } : GITHUB_ANSWERS, sent)(options, onResponse);
  };
  const read = await gatherSourcePages([SOURCE], httpsGet(TOKEN, refusing));
  const readWithout = await gatherSourcePages([SOURCE], httpsGet(undefined, fakeSend(GITHUB_ANSWERS, [])));
  assert.equal(asJson(read), asJson(readWithout));
  assert.deepEqual(
    sent.map(({ host, headers }) => [host, headers.authorization]),
    [
      ['api.github.com', `Bearer ${TOKEN}`],
      ['api.github.com', undefined],
      ['api.github.com', `Bearer ${TOKEN}`],
      ['api.github.com', undefined],
      ['raw.githubusercontent.com', undefined],
    ],
  );
  const lines = said.mock.calls.map((call) => String(call.arguments[0]));
  assert.deepEqual(lines, ['NOTE  api.github.com refused GITHUB_TOKEN (HTTP 401), so GitHub is read without it; replace or remove the token']);
});

test('no URL but https://api.github.com gets the token', () => {
  assert.deepEqual(githubAuthorization('https://api.github.com/orgs/acme', TOKEN), { authorization: `Bearer ${TOKEN}` });
  for (const url of [
    'https://github.com/acme',
    'https://raw.githubusercontent.com/acme/contracts/main/README.md',
    'https://codeload.github.com/acme/contracts/tar.gz/main',
    'https://api.github.com.collector.example/orgs/acme',
    'http://api.github.com/orgs/acme',
    'https://api.github.com:8443/orgs/acme',
    'https://user@api.github.com/orgs/acme',
  ]) {
    assert.deepEqual(githubAuthorization(url, TOKEN), {}, url);
  }
  assert.deepEqual(githubAuthorization('https://api.github.com/orgs/acme', undefined), {});
});

test('pin-solc sends the token with its GitHub release read only, never with the soliditylang lists or the asset download', async (t) => {
  const sent: { url: string; authorization: string | null; redirect: RequestInit['redirect'] }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    return new Response('{}', { status: 200 });
  });
  const io = nodePinSolcIo(TOKEN);
  await io.json('https://binaries.soliditylang.org/bin/list.json');
  await io.json('https://api.github.com/repos/argotorg/solidity/releases/tags/v0.8.24');
  await io.bytes('https://github.com/argotorg/solidity/releases/download/v0.8.24/soljson.js');
  assert.deepEqual(sent, [
    { url: 'https://binaries.soliditylang.org/bin/list.json', authorization: null, redirect: 'error' },
    { url: 'https://api.github.com/repos/argotorg/solidity/releases/tags/v0.8.24', authorization: `Bearer ${TOKEN}`, redirect: 'error' },
    { url: 'https://github.com/argotorg/solidity/releases/download/v0.8.24/soljson.js', authorization: null, redirect: undefined },
  ]);
});

const sourceFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dir, name));

test('only the research scripts read the GitHub token, so no signing command can', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('scripts'), 'bin/kiss-sign'];
  const mentioning = (pattern: RegExp) => files.filter((file) => pattern.test(readFileSync(join(ROOT, file), 'utf8'))).map((file) => relative('.', file)).sort();
  assert.deepEqual(mentioning(/readGithubToken\b/), [
    'scripts/check-sources.ts',
    'scripts/erc7730.ts',
    'scripts/fetch-vendored.ts',
    'scripts/pin-solc.ts',
    'scripts/report.ts',
    'src/research/github-token.ts',
  ]);
  assert.deepEqual(mentioning(/keySpec\('github'\)/), ['src/research/github-token.ts']);
  assert.deepEqual(mentioning(/\.GITHUB_TOKEN\b|['"`]GITHUB_TOKEN['"`]/), ['src/keys.ts']);
});
