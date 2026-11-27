import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { after, test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Difference } from '../src/research/amounts.ts';
import { foundBy } from '../src/research/past-txs.ts';
import { renderPastTxs } from '../src/research/past-txs-render.ts';
import { STUDY_FILES, SUMMARIES_DIR, parseSummary, runOf, staleParts, studyRecording, summaryFile, summaryText } from '../src/research/past-txs-summary.ts';
import type { PastTxsSummary } from '../src/research/past-txs-summary.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { replayPastTxs } from '../src/research/recording.ts';
import { pastTxsRegistry, summarizePastTxs } from '../src/research/report.ts';
import { appFills, shapesOf } from '../src/research/study.ts';
import type { FreeValue } from '../src/research/study.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { loadTemplate } from '../src/template/template.ts';
import { repoWithBundler3Deposit } from './bundler3-deposit.ts';
import { FROZEN_DIR, repoWithFrozenReports } from './frozen-reports.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = join(import.meta.dirname, '..');
const BUNDLER3 = repoWithBundler3Deposit();
const registry = loadRegistry(ROOT);
const deposit = readRecording<PastTxsRecording>(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit.json'));
const FIT = '0x88a65493c62cfc17be33cbc587fca29edf71d0984b6ba2295873dfb1a9a38c4c';

/** A copy of the repository's templates and registry, the deposit template the Bundler3 one, for a test that changes one. */
function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-summary-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['templates', 'registry']) cpSync(join(ROOT, dir), join(root, dir), { recursive: true });
  const deposit = join('templates', 'morpho', 'vault-deposit', 'template.json');
  cpSync(join(BUNDLER3, deposit), join(root, deposit));
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
  const usdc = raw.usdc as Record<string, unknown>;
  writeFileSync(contracts, JSON.stringify({ ...raw, 'unrelated-token': { ...usdc, address: `0x${'7e'.repeat(20)}` } }, null, 2));
  assert.deepEqual(staleParts(root, loadRegistry(root), summary), [], 'an entry whose address no studied transaction holds keeps the summary');
  const sender = summary.studies.find((s) => s.kind === 'fit')?.sender.address as string;
  writeFileSync(contracts, JSON.stringify({ ...raw, 'a-studied-sender': { ...usdc, address: sender } }, null, 2));
  assert.throws(() => summarizePastTxs(root, loadRegistry(root), file, summary), refused('registry entries it reads'));
  writeFileSync(contracts, JSON.stringify(raw, null, 2));

  const otherCode = { ...summary, studiedWith: { ...summary.studiedWith, study: `0x${'00'.repeat(32)}` as Hex } };
  assert.throws(() => summarizePastTxs(root, loadRegistry(root), file, otherCode), refused('study code'));
});

test('a summary keeps when the attribute table gains an attribute no entry it reads carries, and is refused when a row it reads changes', async () => {
  const root = scratchRepo();
  const before = loadRegistry(root);
  const summary = await studyRecording(root, deposit, before);
  const attributes = join(root, 'registry', 'attributes.json');
  const table = JSON.parse(readFileSync(attributes, 'utf8')) as Record<string, string>;
  writeFileSync(attributes, JSON.stringify({ ...table, unusedtoken: 'token' }, null, 2));
  assert.deepEqual(staleParts(root, loadRegistry(root), summary), []);
  writeFileSync(attributes, JSON.stringify({ ...table, asset: 'factory' }, null, 2));
  assert.deepEqual(staleParts(root, before, summary), ['registry entries it reads']);
});

test('a summary is refused when an entry joins the scope of a card field its template names, though no studied transaction holds its address', () => {
  const root = scratchRepo();
  const file = join(SUMMARIES_DIR, 'erc20-transfer-usdc.json');
  const summary = parseSummary(file, readFileSync(join(ROOT, file), 'utf8'));
  const stale = () => staleParts(root, pastTxsRegistry(root, loadRegistry(root), summary.query), summary);
  assert.deepEqual(stale(), []);
  const contracts = join(root, 'registry', 'contracts.json');
  const raw = JSON.parse(readFileSync(contracts, 'utf8')) as Record<string, Record<string, unknown>>;
  writeFileSync(contracts, JSON.stringify({ ...raw, 'unrelated-token': { ...(raw.usdc as Record<string, unknown>), address: `0x${'7e'.repeat(20)}` } }, null, 2));
  assert.deepEqual(stale(), ['registry entries it reads'], 'the token field of erc20/transfer can now name the new token');
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
  const committed = (name: string) => readFileSync(join(ROOT, SUMMARIES_DIR, `${name}.json`), 'utf8');
  const refused = (edited: unknown, why: RegExp) => assert.throws(() => parseSummary('testdata/research/edited.json', JSON.stringify(edited)), why);
  const transfer = JSON.parse(committed('erc20-transfer-usdc')) as Raw;
  const owner = JSON.parse(committed('safe-add-owner')) as Raw;
  const unfit = (raw: Raw) => raw.studies.find((s) => s.kind !== 'fit')?.hash;
  assert.ok(transfer.measurements.length > 0 && owner.traces.length > 0);
  refused({ ...transfer, measurements: [{ ...transfer.measurements[0], hash: unfit(transfer) }] }, /measurements\[0\]\.hash: not a transaction that fit/);
  refused({ ...owner, traces: [{ ...owner.traces[0], hash: unfit(owner) }] }, /traces\[0\]\.hash: not a transaction that fit/);
  refused({ ...transfer, search: { ...transfer.search, found: { ...transfer.search.found, total: 0, only: { ...transfer.search.found.only, alchemy: [FIT] } } } }, /search\.found\.only: more hashes than the search found/);

  const summary = parseSummary('testdata/research/erc20-transfer-usdc.json', committed('erc20-transfer-usdc'));
  const [hash, measured] = [...summary.measurements].find(([, m]) => m.kind === 'measured' && m.differences.length > 0) ?? [];
  assert.ok(hash !== undefined && measured?.kind === 'measured');
  const beyond = { ...summary, measurements: new Map([[hash, { ...measured, differences: [{ ...(measured.differences[0] as Difference), effect: 9 }] }]]) };
  assert.throws(() => runOf(beyond, loadTemplate(ROOT, summary.query.template, registry)), /names effect 9, and the template states 1$/);
});

test('a summary whose misfit holds a value at a place the template binds or lacks is refused, and one at a place the app fills is kept', () => {
  const name = 'cow-swap-presign';
  const text = readFileSync(join(ROOT, SUMMARIES_DIR, `${name}.json`), 'utf8');
  const summary = parseSummary(`testdata/research/${name}.json`, text);
  const template = loadTemplate(ROOT, summary.query.template, registry);
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
  const fixtures = repoWithTestFixtures();
  const problems = readdirSync(join(ROOT, SUMMARIES_DIR)).flatMap((f) => {
    const file = join(SUMMARIES_DIR, f);
    const summary = parseSummary(file, readFileSync(join(ROOT, file), 'utf8'));
    const root = [ROOT, fixtures].find((r) => existsSync(join(r, 'templates', summary.query.template, 'template.json')));
    if (root === undefined) return [`${file}: names no template in templates/ or test/fixtures/templates/`];
    const parts = staleParts(root, pastTxsRegistry(root, loadRegistry(root), summary.query), summary);
    return parts.length === 0 ? [] : [`${file}: the ${parts.join(' and the ')} changed since it was studied`];
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
