import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard, resolveValue } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { createReader } from '../src/chain/reader.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { loadReport } from '../src/research/report.ts';
import { warmReport } from '../src/research/report-warm.ts';
import type { ReportSources } from '../src/research/report-warm.ts';
import { TEMPLATES_DIR, TemplateError, loadTemplate, parseTemplate } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = repoWithTestFixtures();
const registry = loadRegistry(FIXTURES);
const raw = (id: string, root = FIXTURES) => JSON.parse(readFileSync(join(root, TEMPLATES_DIR, id, 'template.json'), 'utf8'));
const SAFE = '0x1111111111111111111111111111111111111111' as Address;
const tokensOf = (of: typeof registry): string[] => [...of.entries.values()].filter((entry) => entry.kind === 'token').map((entry) => entry.name);
const TOKENS = tokensOf(registry);
/** The tokens a template's token fields list, read from its file. */
const listedBy = (id: string, root = FIXTURES): string[] =>
  Object.values(raw(id, root).card as Record<string, { registryKind?: string; names?: string[] }>).flatMap((field) => (field.registryKind === 'token' ? (field.names ?? []) : []));
const unlistedBy = (id: string, tokens = TOKENS, root = FIXTURES): string[] => tokens.filter((token) => !listedBy(id, root).includes(token));
const templateIds = (root: string): string[] =>
  readdirSync(join(root, TEMPLATES_DIR)).flatMap((protocol) => readdirSync(join(root, TEMPLATES_DIR, protocol)).map((operation) => `${protocol}/${operation}`));

function refusedAt(template: unknown, path: string, message: RegExp): void {
  assert.throws(
    () => parseTemplate(template, registry, 'committed'),
    (e: unknown) => e instanceof TemplateError && e.path === path && message.test(e.message),
    `${path} ${message}`,
  );
}

test('template load refuses a token field that does not list the tokens it accepts', () => {
  const swap = raw('uniswap/swap');
  const { names: _, ...unlisted } = swap.card['sell-token'];
  refusedAt({ ...swap, card: { ...swap.card, 'sell-token': unlisted } }, 'card.sell-token.names', /: missing; a token field lists the registry names it accepts/);
});

test('template load refuses a list that is empty, repeats a name, or names what the field cannot take', () => {
  const swap = raw('uniswap/swap');
  const listing = (names: unknown) => ({ ...swap, card: { ...swap.card, 'sell-token': { ...swap.card['sell-token'], names } } });
  refusedAt(listing([]), 'card.sell-token.names', /: empty;/);
  refusedAt(listing(['usdc', 'usdc']), 'card.sell-token.names[1]', /: usdc is listed twice$/);
  refusedAt(listing(['usdc', 'not-a-registry-name']), 'card.sell-token.names[1]', /: "not-a-registry-name" is not in the contract registry$/);
  refusedAt(listing(['permit2']), 'card.sell-token.names[0]', /: permit2 is a allowance, not a token$/);
});

test("a field of the template's instance kind lists no names: its reports bound it", () => {
  const deposit = raw('fluid/vault-deposit');
  refusedAt({ ...deposit, card: { ...deposit.card, vault: { ...deposit.card.vault, names: ['fluid-fusdc'] } } }, 'card.vault.names', /instance kind vault lists no names/);
});

test('each token field accepts only the tokens its template lists', () => {
  const ids = templateIds(FIXTURES).filter((id) => listedBy(id).length > 0);
  assert.ok(ids.length > 1, 'templates with a token field');
  const refusals = new Set<string>();
  for (const id of ids) {
    const template = loadTemplate(FIXTURES, id, registry);
    const fields = [...template.card].filter(([, field]) => field.kind === 'contract' && field.scope.registryKind === 'token').map(([name]) => name);
    assert.ok(fields.length > 0, id);
    for (const field of fields) {
      const listed: readonly string[] = raw(id).card[field].names;
      for (const token of TOKENS) {
        const resolved = resolveValue(template.card.get(field)!, token, { registry, addressBook: new Map(), safe: SAFE });
        const refusal = 'reason' in resolved ? resolved.reason : undefined;
        assert.equal(refusal, listed.includes(token) ? undefined : 'not-listed', `${id} ${field} ${token}`);
        if (refusal !== undefined) refusals.add(token);
      }
    }
  }
  assert.ok(refusals.size > 0, 'some registry token is refused by a field that does not list it');
});

test('card seal and verify refuse a swap of tokens the template does not list, naming the field and the list', () => {
  const template = loadTemplate(FIXTURES, 'uniswap/swap', registry);
  const [unlisted] = unlistedBy('uniswap/swap');
  const [sold, bought] = raw('uniswap/swap').card['sell-token'].names as string[];
  assert.ok(unlisted !== undefined && sold !== undefined && bought !== undefined, 'a registry token uniswap/swap does not list, and two it does');
  const refusal = (sell: string, buy: string) => {
    const values = { 'sell-token': sell, 'buy-token': buy, 'sell-amount': '100000000', 'min-buy': '1' };
    const result = resolveCard({ operations: [{ template: template.id, values }] }, { templates: new Map([[template.id, template]]), registry, addressBook: new Map(), safe: SAFE });
    return result.kind === 'refused' ? [result.reason, result.at, result.detail] : result.kind;
  };
  assert.deepEqual(refusal(unlisted, bought), ['not-listed', 'operations[0].values.sell-token', `${unlisted} is not a token this template lists (${raw('uniswap/swap').card['sell-token'].names.join(', ')})`]);
  assert.deepEqual(refusal(sold, unlisted), ['not-listed', 'operations[0].values.buy-token', `${unlisted} is not a token this template lists (${raw('uniswap/swap').card['buy-token'].names.join(', ')})`]);
});

test('a committed token report names no registry token its template does not list', () => {
  const tokens = tokensOf(loadRegistry(ROOT));
  const reports = templateIds(ROOT).filter((id) => listedBy(id, ROOT).length > 0 && existsSync(join(ROOT, TEMPLATES_DIR, id, 'report.generated.md')));
  const checked = reports.flatMap((id) => {
    const report = readFileSync(join(ROOT, TEMPLATES_DIR, id, 'report.generated.md'), 'utf8');
    const unlisted = unlistedBy(id, tokens, ROOT);
    for (const token of unlisted) assert.doesNotMatch(report, new RegExp(`(?<![\\w-])${token}(?![\\w-])`), `${id}'s committed report names ${token}, which its template does not list; record it again with pnpm report ${id} --record`);
    return unlisted;
  });
  assert.ok(checked.length > 0, 'some committed token report is checked against a registry token its template does not list');
});

test("report --record's reads for a template ask nothing of a token it does not list", async () => {
  const asked: string[] = [];
  const ask = (what: unknown) => {
    asked.push(JSON.stringify(what).toLowerCase());
    return Promise.reject(new Error('offline'));
  };
  const reader = createReader(mainnetEndpoints({ ALCHEMY_API_KEY: 'offline-alchemy', DRPC_API_KEY: 'offline-drpc' }), (url, body) => ask({ url, body }), { timeoutMs: 100, retryPausesMs: [], rateLimitPausesMs: [] });
  const sources: ReportSources = {
    reader,
    get: ask,
    send: ask,
    listings: { list: ask, org: ask },
    etherscan: ask,
    alchemy: (method, params) => ask({ method, params }),
    creations: () => ask('creations'),
  };
  const { subject, registry: seen } = loadReport(FIXTURES, registry, { template: 'uniswap/allow-router', instance: undefined });
  const block = { number: 1000n, hash: `0x${'11'.repeat(32)}` as Hex };
  await warmReport(sources, subject, seen, { unavailable: 'offline' }, { settled: block, head: block }, (prove) => prove(() => ({ kind: 'missing' }) as never).then(() => undefined));
  const holds = (name: string) => asked.some((text) => text.includes(registry.entries.get(name)!.address.slice(2)));
  assert.ok(listedBy('uniswap/allow-router').every(holds), 'the reads are seen');
  for (const token of unlistedBy('uniswap/allow-router')) assert.ok(!holds(token), `a read names ${token}`);
});
