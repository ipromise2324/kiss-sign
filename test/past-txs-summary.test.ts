import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { after, test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import { loadRegistry } from '../src/registry.ts';
import type { ContractKind, RegistryEntry } from '../src/registry.ts';
import type { Difference } from '../src/research/amounts.ts';
import { foundBy } from '../src/research/past-txs.ts';
import { renderPastTxs } from '../src/research/past-txs-render.ts';
import { STUDY_FILES, SUMMARIES_DIR, parseSummary, runOf, staleParts, studyRecording, summaryFile, summaryText } from '../src/research/past-txs-summary.ts';
import type { PastTxsSummary } from '../src/research/past-txs-summary.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { replayPastTxs } from '../src/research/recording.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { TraceCall } from '../src/research/trace.ts';
import { pastTxsRegistry, summarizePastTxs } from '../src/research/report.ts';
import { studyRegistry } from '../src/research/study-registry.ts';
import { appFills, shapesOf } from '../src/research/study.ts';
import type { FreeValue } from '../src/research/study.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { loadTemplate } from '../src/template/template.ts';
import { repoWithBundler3Deposit } from './bundler3-deposit.ts';
import { FROZEN_DIR, repoWithFrozenReports } from './frozen-reports.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = join(import.meta.dirname, '..');
const BUNDLER3 = repoWithBundler3Deposit();
const FIXTURES = repoWithTestFixtures();
const registry = loadRegistry(BUNDLER3);
const deposit = readRecording<PastTxsRecording>(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit.json'));
const FIT = '0x88a65493c62cfc17be33cbc587fca29edf71d0984b6ba2295873dfb1a9a38c4c';

/** A token entry of no other field, so whatever else the registry's own tokens carry, such as a price, it loads beside them. */
const aToken = (address: string): Record<string, unknown> => ({ address, kind: 'token', source: 'https://example.com/tokens' });

/** A copy of the test fixtures' templates and registry, the deposit template the Bundler3 one, for a test that changes one. */
function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-summary-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['templates', 'registry']) cpSync(join(BUNDLER3, dir), join(root, dir), { recursive: true });
  return root;
}

test('a summary written and read back is the same summary, and prints the report the recording it came from prints', async () => {
  const summary = await studyRecording(BUNDLER3, deposit, registry);
  const text = summaryText(summary);
  const parsed = parseSummary('testdata/research/morpho-vault-deposit.json', text);
  assert.deepEqual(parsed, summary);
  assert.equal(summaryText(parsed), text);
  const template = loadTemplate(BUNDLER3, deposit.query.template, registry);
  assert.equal(renderPastTxs(runOf(parsed, template), registry), renderPastTxs(await replayPastTxs(deposit, template, registry), registry));
});

test('a summary counts what each source found and keeps only the hashes one source alone found, not every transaction found', async () => {
  const windows = readRecording<PastTxsRecording>(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit-windows.json'));
  const whole = await studyRecording(BUNDLER3, windows, registry);
  const alone = whole.studies[0]?.hash as Hex;
  const sources = windows.sources.map(({ request, answer }) =>
    request.source === 'etherscan' && Array.isArray((answer as { result?: unknown }).result)
      ? { request, answer: { ...(answer as object), result: (answer as { result: { transactionHash: string }[] }).result.filter((log) => log.transactionHash !== alone) } }
      : { request, answer },
  );
  const summary = await studyRecording(BUNDLER3, { ...windows, sources }, registry);
  const { found } = summary.search;
  assert.deepEqual([found.total, foundBy(found, 'alchemy'), foundBy(found, 'etherscan')], [whole.search.found.total, whole.search.found.total, whole.search.found.total - 1]);
  assert.deepEqual(found.only, { alchemy: [alone], etherscan: [] });
  const studied = new Set<string>(summary.studies.map((s) => s.hash));
  const hits = windows.sources.flatMap(({ answer }) => [...((answer as { result?: unknown }).result as { transactionHash: string }[] | undefined ?? []), ...((answer as { transfers?: { hash: string }[] }).transfers ?? []).map((t) => ({ transactionHash: t.hash }))]);
  const unstudied = [...new Set(hits.map((hit) => hit.transactionHash))].filter((hash) => !studied.has(hash));
  assert.ok(unstudied.length > 100, `${unstudied.length} transactions the search found and the run did not study`);
  const text = summaryText(summary);
  assert.deepEqual(unstudied.filter((hash) => text.includes(hash)), []);
});

test('a hand-edited summary holding Markdown or HTML in a text it prints is refused when read', async () => {
  const summary = JSON.parse(summaryText(await studyRecording(BUNDLER3, deposit, registry))) as { studies: { kind: string; reason?: { kind: string; at?: string } }[] };
  const misfit = summary.studies.find((s) => s.kind === 'misfit' && s.reason?.kind === 'calls');
  assert.ok(misfit !== undefined);
  for (const markup of ['<img src=x onerror=alert(1)>', '`code`', '[link](https://example.com)', 'https://example.com', '| cell |', '**bold**']) {
    const edited = { ...summary, studies: [{ kind: 'unreadable', hash: FIT, reason: `eth_getTransactionByHash: ${markup}` }, ...summary.studies] };
    assert.throws(() => parseSummary('testdata/research/edited.json', JSON.stringify(edited)), /^SummaryError: testdata\/research\/edited\.json: studies\[0\]\.reason: not text of the characters the program writes$/, markup);
  }
  const field = { ...summary, studies: [{ kind: 'misfit', hash: FIT, sender: { kind: 'safe', address: `0x${'11'.repeat(20)}` }, reason: { kind: 'field', at: 'call.x', expected: '1', actual: '<b>2</b>' }, free: [] }] };
  assert.throws(() => parseSummary('testdata/research/edited.json', JSON.stringify(field)), /studies\[0\]\.reason\.actual: not text/);
});

test('a summary studied with another template, other registry entries it reads, or other study code is refused, naming --restudy', async () => {
  const root = scratchRepo();
  const summary = await studyRecording(root, deposit, loadRegistry(root));
  const file = 'testdata/research/morpho-vault-deposit.json';
  const refused = (what: string) => new RegExp(`^ReportError: ${file.replace(/[/.]/g, '\\$&')}: the ${what} changed since it was studied; run pnpm past-txs --restudy morpho-vault-deposit$`);
  assert.deepEqual(staleParts(root, loadRegistry(root), summary), []);

  const templatePath = join(root, 'templates', 'morpho', 'vault-deposit', 'template.json');
  const template = readFileSync(templatePath, 'utf8');
  writeFileSync(templatePath, `${template}\n`);
  assert.throws(() => summarizePastTxs(root, loadRegistry(root), file, summary), refused('template'));
  writeFileSync(templatePath, template);

  const contracts = join(root, 'registry', 'contracts.json');
  const raw = JSON.parse(readFileSync(contracts, 'utf8')) as Record<string, Record<string, unknown>>;
  writeFileSync(contracts, JSON.stringify({ ...raw, 'unrelated-token': aToken(`0x${'7e'.repeat(20)}`) }, null, 2));
  assert.deepEqual(staleParts(root, loadRegistry(root), summary), [], 'an entry whose address no studied transaction holds keeps the summary');
  const sender = summary.studies.find((s) => s.kind === 'fit')?.sender.address as string;
  writeFileSync(contracts, JSON.stringify({ ...raw, 'a-studied-sender': aToken(sender) }, null, 2));
  assert.throws(() => summarizePastTxs(root, loadRegistry(root), file, summary), refused('registry entries it reads'));
  writeFileSync(contracts, JSON.stringify(raw, null, 2));

  const otherCode = { ...summary, studiedWith: { ...summary.studiedWith, study: `0x${'00'.repeat(32)}` as Hex } };
  assert.throws(() => summarizePastTxs(root, loadRegistry(root), file, otherCode), refused('study code'));
});

test('a summary keeps when the attribute table gains an attribute no entry it reads carries, and is refused when a row it reads changes', async () => {
  const root = scratchRepo();
  const before = loadRegistry(root);
  const summary = await studyRecording(root, deposit, before);
  const row = (name: string, kind: ContractKind) => ({ ...before, attributes: new Map([...before.attributes, [name, kind]]) });
  assert.deepEqual(staleParts(root, row('unusedtoken', 'token'), summary), []);
  assert.deepEqual(staleParts(root, row('asset', 'factory'), summary), ['registry entries it reads']);
});

type RawEntries = Record<string, Record<string, unknown>>;

/** The test fixtures' summaries, of `names`, that an edit of their `registry/contracts.json` makes stale by the entries they read. */
function changedBy(edit: (contracts: RawEntries) => void, names = readdirSync(join(FIXTURES, SUMMARIES_DIR)).map((f) => f.replace(/\.json$/, ''))): string[] {
  const root = repoWithTestFixtures();
  const contracts = join(root, 'registry', 'contracts.json');
  const raw = JSON.parse(readFileSync(contracts, 'utf8')) as RawEntries;
  edit(raw);
  writeFileSync(contracts, JSON.stringify(raw, null, 2));
  const edited = loadRegistry(root);
  return names.filter((name) => {
    const file = join(SUMMARIES_DIR, `${name}.json`);
    const summary = parseSummary(file, readFileSync(join(FIXTURES, file), 'utf8'));
    assert.deepEqual(staleParts(FIXTURES, pastTxsRegistry(FIXTURES, loadRegistry(FIXTURES), summary.query), summary), [], `${name} is fresh before the edit`);
    return staleParts(root, pastTxsRegistry(root, edited, summary.query), summary).includes('registry entries it reads');
  });
}

const entryIn = (contracts: RawEntries, name: string): Record<string, unknown> => contracts[name] ?? assert.fail(`no ${name}`);

/** Another address next to `address`, so a pool naming its token keeps its two tokens in address order. */
const beside = (address: string): string => `${address.slice(0, -1).toLowerCase()}${(parseInt(address.slice(-1), 16) ^ 1).toString(16)}`;

test('an entry gaining a field no study reads keeps every committed summary', () => {
  const changed = changedBy((contracts) => {
    for (const [token, byte] of [['usdc', '7a'], ['usdt', '7b']] as const) {
      const feed = { description: `${token.toUpperCase()} / USD`, decimals: 8, heartbeat: 86400, deviationBps: 25, sourceClass: 'cex_price', quote: 'usd' };
      contracts[`a-feed-of-${token}`] = { address: `0x${byte.repeat(20)}`, kind: 'oracle', source: entryIn(contracts, token).source, code: entryIn(contracts, 'usdc').code, feed };
      entryIn(contracts, token).price = { feed: `a-feed-of-${token}` };
    }
    entryIn(contracts, 'usdc').dependsOn = ['permit2'];
    entryIn(contracts, 'usdc').sourceLabel = 'Another label';
    entryIn(contracts, 'usdc').coingecko = 'another-coin';
    entryIn(contracts, 'universal-router-2.1.2').ignoresTrailer = 'Another reason.';
    (entryIn(contracts, 'universal-router-2.1.2').standingAllowance as { why: string }).why = 'Another reason.';
  });
  assert.deepEqual(changed, []);
});

test('a change of a field a study reads makes stale the summaries that read it, and not one that reads none of it', () => {
  const stale = (read: string, unread: string, edit: (contracts: RawEntries) => void) => assert.deepEqual(changedBy(edit, [read, unread]), [read]);
  const transfer = ['erc20-transfer-steth', 'morpho-vault-v2-revoke-acuto-usdc-v2-4a57'] as const;
  stale(...transfer, (c) => (entryIn(c, 'usdt').address = beside(entryIn(c, 'usdt').address as string)));
  stale(...transfer, (c) => (entryIn(c, 'usdt').defillama = 'another-protocol'));
  stale(...transfer, (c) => (entryIn(c, 'usdt').standingAllowance = { via: 'erc20', why: 'A reason.' }));
  stale(...transfer, (c) => (entryIn(c, 'usdt').ignoresTrailer = 'A reason.'));
  const adapter = ['morpho-vault-v2-revoke-acuto-usdc-v2-4a57', 'erc20-transfer-steth'] as const;
  stale(...adapter, (c) => (entryIn(c, 'acuto-usdc-v2-4a57-market-adapter').attributes = { factory: 'vault-v2-factory' }));
  stale(...adapter, (c) => (entryIn(c, 'morpho-market-v1-adapter-v2-factory').defillama = 'another-protocol'));
  const readBy = (name: string, entry: string) => assert.ok(changedBy((c) => (entryIn(c, entry).defillama = 'another-protocol'), [name]).includes(name), `${name} reads ${entry}, which the test above gives fields no study reads`);
  readBy('morpho-market-supply', 'usdc');
  readBy('uniswap-allow-router-permit2', 'universal-router-2.1.2');
  readBy('uniswap-allow-router-permit2', 'permit2');
});

test('a study that reads a field its entries are not given is refused, and one that reads a field they are given sees the registry\'s', () => {
  const full = registry.entries.get('universal-router-2.1.2') as RegistryEntry;
  const studied = studyRegistry(registry);
  const entry = studied.entries.get('universal-router-2.1.2') as unknown as RegistryEntry;
  const given = ['name', 'address', 'kind', 'attributes', 'defillama'] as const;
  assert.deepEqual(given.map((field) => entry[field]), given.map((field) => full[field]));
  assert.equal(entry.standingAllowance?.via, full.standingAllowance?.via);
  assert.throws(() => entry.standingAllowance?.why, /^StudyFieldError: a study reads no standingAllowance field why: add it to StudyEntry/);
  const declared = new Set([...registry.entries.values()].flatMap((e) => Object.keys(e)));
  const unread = [...declared, 'price', 'feed', 'twap', 'numbers', 'dependsOn'].filter((field) => !given.includes(field as 'name') && field !== 'standingAllowance' && field !== 'ignoresTrailer');
  for (const field of unread) assert.throws(() => entry[field as 'price'], new RegExp(`^StudyFieldError: a study reads no entry field ${field}: add it to StudyEntry`));
  const usdc = studied.byAddress.get(registry.entries.get('usdc')?.address as Address) as unknown as RegistryEntry;
  assert.equal(usdc.ignoresTrailer, undefined);
  assert.throws(() => usdc.code, /StudyFieldError/);
});

test('a summary is refused when a token its traces logged and no call names joins the registry', async () => {
  const root = scratchRepo();
  const past = readRecording<PastTxsRecording>(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit.json'));
  const plain = await studyRecording(root, past, loadRegistry(root));
  const fit = plain.studies.find((s) => s.kind === 'fit' && (s.hash as string) === FIT && s.outside.length === 0) ?? assert.fail('a transaction exactly the template');
  const reader = replayReader(past.exchanges);
  const [tx, receipt] = [await reader.getTransaction(fit.hash), await reader.getTransactionReceipt(fit.hash)];
  if (tx.kind !== 'agreed' || tx.value === null || receipt.kind !== 'agreed' || receipt.value === null) return assert.fail('no transaction or receipt');
  const { from, to, input } = tx.value;
  const top: TraceCall = { depth: 0, type: 'CALL', from: from.toLowerCase() as Address, to: (to ?? assert.fail('a creation')).toLowerCase() as Address, selector: input.slice(0, 10).toLowerCase() as Hex };
  const TOKEN = `0x${'7e'.repeat(20)}`;
  const transferred = { address: TOKEN, topics: [`0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`, `0x${'00'.repeat(12)}${'11'.repeat(20)}`, `0x${'00'.repeat(12)}${'22'.repeat(20)}`], data: `0x${'01'.padStart(64, '0')}` };
  const exchanges = past.exchanges.map((e) =>
    e.method !== 'eth_getTransactionReceipt' || !JSON.stringify(e.params).includes(fit.hash)
      ? e
      : (JSON.parse(JSON.stringify(e), (key, value) => (key === 'logs' ? [...value, { ...value[0], ...transferred, logIndex: '0xffff' }] : value)) as typeof e),
  );
  const summary = await studyRecording(root, { ...past, exchanges, traces: [{ hash: fit.hash, calls: [top] }] }, loadRegistry(root));
  assert.equal(summary.traces.length, 1);
  assert.equal(summaryText(parseSummary('testdata/research/logged.json', summaryText(summary))), summaryText(summary));
  assert.deepEqual(staleParts(root, loadRegistry(root), summary), []);

  const contracts = join(root, 'registry', 'contracts.json');
  const raw = JSON.parse(readFileSync(contracts, 'utf8')) as RawEntries;
  const added = (address: string) => {
    writeFileSync(contracts, JSON.stringify({ ...raw, 'a-new-token': aToken(address) }, null, 2));
    return staleParts(root, loadRegistry(root), summary);
  };
  assert.deepEqual(added(TOKEN), ['registry entries it reads']);
  assert.deepEqual(added(`0x${'7d'.repeat(20)}`), [], 'a token no trace logged keeps the summary');
});

test('a token that joins the registry leaves a summary fresh until its template lists it, though no studied transaction holds its address', () => {
  const root = scratchRepo();
  const file = join(SUMMARIES_DIR, 'erc20-transfer-steth.json');
  const summary = parseSummary(file, readFileSync(join(FIXTURES, file), 'utf8'));
  const stale = () => staleParts(root, pastTxsRegistry(root, loadRegistry(root), summary.query), summary);
  assert.deepEqual(stale(), []);
  const contracts = join(root, 'registry', 'contracts.json');
  const raw = JSON.parse(readFileSync(contracts, 'utf8')) as Record<string, Record<string, unknown>>;
  writeFileSync(contracts, JSON.stringify({ ...raw, 'unrelated-token': aToken(`0x${'7e'.repeat(20)}`) }, null, 2));
  assert.deepEqual(stale(), [], 'no field of erc20/transfer lists the new token');
  const transfer = join(root, 'templates', 'erc20', 'transfer', 'template.json');
  const template = JSON.parse(readFileSync(transfer, 'utf8'));
  template.card.token.names.push('unrelated-token');
  writeFileSync(transfer, JSON.stringify(template, null, 2));
  assert.deepEqual(stale(), ['template', 'registry entries it reads'], 'the token field of erc20/transfer now lists the new token');
});

test('a summary holds a string decoded from the chain whatever its characters, and reads back as the same summary', async () => {
  const summary = await studyRecording(BUNDLER3, deposit, registry);
  const misfit = summary.studies.find((s) => s.kind === 'misfit');
  assert.ok(misfit !== undefined && misfit.kind === 'misfit');
  for (const actual of ['<b>2</b>', '`x` | [a](https://example.com)', 'line\nbreak', '名稱 ✓']) {
    const edited: PastTxsSummary = { ...summary, studies: [{ ...misfit, reason: { kind: 'field', at: 'call.x', expected: 'Wrapped Ether', actual } }, ...summary.studies] };
    const { text } = summaryFile('morpho-vault-deposit', edited, undefined);
    assert.deepEqual(parseSummary('testdata/research/morpho-vault-deposit.json', text), edited, actual);
  }
  const plain = JSON.parse(summaryText(summary)) as { studies: unknown[] };
  const encoded = { ...plain, studies: [{ kind: 'misfit', hash: FIT, sender: { kind: 'safe', address: `0x${'11'.repeat(20)}` }, reason: { kind: 'field', at: 'call.x', expected: '1', actual: { utf8: '0x32' } }, free: [] }, ...plain.studies] };
  assert.throws(() => parseSummary('testdata/research/edited.json', JSON.stringify(encoded)), /studies\[0\]\.reason\.actual\.utf8: text of the characters the program writes, kept as it is/);
});

test('a summary is refused before it is written when it would not read back, or holds the configured Safe', async () => {
  const summary = await studyRecording(BUNDLER3, deposit, registry);
  const odd: PastTxsSummary = { ...summary, studies: [{ kind: 'unreadable', hash: FIT as Hex, reason: 'eth_call: <b>no</b>' }, ...summary.studies] };
  assert.throws(() => summaryFile('morpho-vault-deposit', odd, undefined), /^SummaryError: testdata\/research\/morpho-vault-deposit\.json: studies\[0\]\.reason: not text of the characters the program writes; nothing written$/);
  const sender = summary.studies.find((s) => s.kind === 'fit')?.sender.address as Address;
  assert.throws(() => summaryFile('morpho-vault-deposit', summary, sender), /^SummaryError: testdata\/research\/morpho-vault-deposit\.json: holds the configured Safe's address; nothing written$/);
  assert.doesNotThrow(() => summaryFile('morpho-vault-deposit', summary, `0x${'7e'.repeat(20)}` as Address));
});

test('a summary whose amounts, traces or one-source hashes name transactions it does not hold is refused', () => {
  type Raw = { search: { found: { total: number; only: Record<string, string[]> } }; measurements: { hash: string }[]; traces: { hash: string }[]; studies: { kind: string; hash: string }[] };
  const committed = (name: string) => readFileSync(join(FIXTURES, SUMMARIES_DIR, `${name}.json`), 'utf8');
  const refused = (edited: unknown, why: RegExp) => assert.throws(() => parseSummary('testdata/research/edited.json', JSON.stringify(edited)), why);
  const transfer = JSON.parse(committed('erc20-transfer-steth')) as Raw;
  const owner = JSON.parse(committed('uniswap-allow-router-permit2')) as Raw;
  const unfit = (raw: Raw) => raw.studies.find((s) => s.kind !== 'fit')?.hash;
  assert.ok(transfer.measurements.length > 0 && owner.traces.length > 0);
  refused({ ...transfer, measurements: [{ ...transfer.measurements[0], hash: unfit(transfer) }] }, /measurements\[0\]\.hash: not a transaction that fit/);
  refused({ ...owner, traces: [{ ...owner.traces[0], hash: unfit(owner) }] }, /traces\[0\]\.hash: not a transaction that fit/);
  refused({ ...transfer, search: { ...transfer.search, found: { ...transfer.search.found, total: 0, only: { ...transfer.search.found.only, alchemy: [FIT] } } } }, /search\.found\.only: more hashes than the search found/);

  const summary = parseSummary('testdata/research/erc20-transfer-steth.json', committed('erc20-transfer-steth'));
  const [hash, measured] = [...summary.measurements].find(([, m]) => m.kind === 'measured' && m.differences.length > 0) ?? [];
  assert.ok(hash !== undefined && measured?.kind === 'measured');
  const beyond = { ...summary, measurements: new Map([[hash, { ...measured, differences: [{ ...(measured.differences[0] as Difference), effect: 9 }] }]]) };
  assert.throws(() => runOf(beyond, loadTemplate(FIXTURES, summary.query.template, loadRegistry(FIXTURES))), /names effect 9, and the template states 1$/);
});

test('a summary whose misfit holds a value at a place the template binds or lacks is refused, and one at a place the app fills is kept', () => {
  const name = 'cow-swap-presign';
  const text = readFileSync(join(ROOT, SUMMARIES_DIR, `${name}.json`), 'utf8');
  const summary = parseSummary(`testdata/research/${name}.json`, text);
  const template = loadTemplate(ROOT, summary.query.template, loadRegistry(ROOT));
  const held = summary.studies.find((s) => s.kind === 'misfit' && s.free.length > 0);
  assert.ok(held?.kind === 'misfit');
  assert.deepEqual(runOf(summary, template).studies.find((s) => s.kind === 'misfit' && s.hash === held.hash), held);
  const { rules } = shapesOf(template).whole.loosened;
  const bound = rules.findIndex((rule) => !appFills(rule));
  for (const field of [bound, rules.length]) {
    const edited = { ...summary, studies: [{ ...held, free: [{ ...(held.free[0] as FreeValue), field }] }] };
    assert.throws(() => runOf(edited, template), new RegExp(`^SummaryError: the misfit ${held.hash} holds a value at field ${field}, which the template does not leave to the app$`));
  }
});

test('every committed past-txs summary names a template and was studied with its template, registry entries and study code as this checkout holds them', () => {
  const problems = readdirSync(join(ROOT, SUMMARIES_DIR)).flatMap((f) => {
    const file = join(SUMMARIES_DIR, f);
    const summary = parseSummary(file, readFileSync(join(ROOT, file), 'utf8'));
    if (!existsSync(join(ROOT, 'templates', summary.query.template, 'template.json'))) return [`${file}: names no template in templates/`];
    const parts = staleParts(ROOT, pastTxsRegistry(ROOT, loadRegistry(ROOT), summary.query), summary);
    return parts.length === 0 ? [] : [`${file}: the ${parts.join(' and the ')} changed since it was studied; run pnpm past-txs --restudy ${f.replace(/\.json$/, '')}`];
  });
  assert.deepEqual(problems, []);
});

test("every test-only past-txs summary was studied with the test fixtures' templates and registry entries and this checkout's study code", () => {
  const problems = readdirSync(join(FIXTURES, SUMMARIES_DIR)).flatMap((f) => {
    const file = join(SUMMARIES_DIR, f);
    const summary = parseSummary(file, readFileSync(join(FIXTURES, file), 'utf8'));
    const parts = staleParts(FIXTURES, pastTxsRegistry(FIXTURES, loadRegistry(FIXTURES), summary.query), summary);
    return parts.length === 0 ? [] : [`${join('test', 'fixtures', file)}: the ${parts.join(' and the ')} changed since it was studied; run node test/fixture-summaries.ts ${f.replace(/\.json$/, '')}`];
  });
  assert.deepEqual(problems, []);
});

test("every frozen past-txs summary was studied with the frozen template and registry entries and this checkout's study code", () => {
  const frozen = repoWithFrozenReports();
  const problems = readdirSync(join(frozen, SUMMARIES_DIR)).flatMap((f) => {
    const file = join(SUMMARIES_DIR, f);
    const summary = parseSummary(file, readFileSync(join(frozen, file), 'utf8'));
    const parts = staleParts(frozen, pastTxsRegistry(frozen, loadRegistry(frozen), summary.query), summary);
    return parts.length === 0 ? [] : [`${join(FROZEN_DIR, file)}: the ${parts.join(' and the ')} changed since it was studied; run node test/freeze-reports.ts --restudy`];
  });
  assert.deepEqual(problems, []);
});

test('the study code hashed into each summary is every file a restudy runs, followed through its imports', () => {
  const typeOnly = /^\s*(?:import|export)\s+type\s[^;]*;/gm;
  const seen = new Set<string>();
  const queue = ['src/research/recording.ts'];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    const code = readFileSync(join(ROOT, path), 'utf8').replace(typeOnly, '');
    for (const [, relative] of code.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/gm)) queue.push(normalize(join(dirname(path), relative as string)));
  }
  assert.deepEqual([...STUDY_FILES].sort(), [...seen].sort());
});
