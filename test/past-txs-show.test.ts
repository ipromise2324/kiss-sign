import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { loadRegistry } from '../src/registry.ts';
import { readRecording } from '../src/chain/bytecode.ts';
import { safeExecutions, showSummary } from '../src/research/past-txs-show.ts';
import { SUMMARIES_DIR, parseSummary, studyRecording } from '../src/research/past-txs-summary.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { loadTemplate } from '../src/template/template.ts';
import { repoWithBundler3Deposit } from './bundler3-deposit.ts';

const ROOT = join(import.meta.dirname, '..');
const BUNDLER3 = repoWithBundler3Deposit();
const show = (...args: readonly string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'past-txs.ts'), '--show', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', KISS_SIGN_HOME: '/nonexistent' } });

for (const name of ['safe-add-owner', 'cow-swap-presign', 'fluid-vault-deposit-fusdt', 'uniswap-swap-usdt-sell']) {
  const file = join(SUMMARIES_DIR, `${name}.json`);
  const summary = parseSummary(file, readFileSync(join(ROOT, file), 'utf8'));
  test(`past-txs --show ${name} lists each transaction that fits or misfits once, exact ones of Safes first, with no key and no network`, () => {
    const run = show(name);
    assert.equal(run.status, 0, run.stderr);
    const listed = run.stdout.split('\n').flatMap((line) => (line.startsWith('0x') ? [line.slice(0, 66)] : []));
    const judged = summary.studies.filter((s) => s.kind === 'fit' || s.kind === 'misfit' || s.kind === 'unreadable');
    assert.deepEqual([...listed].sort(), judged.map((s) => s.hash).sort());
    const exact = summary.studies.filter((s) => s.kind === 'fit' && s.sender.kind === 'safe' && s.outside.length === 0);
    assert.deepEqual(new Set(listed.slice(0, exact.length)), new Set(exact.map((s) => s.hash)));
    if (exact.length > 0) assert.match(run.stdout, new RegExp(`^${exact.length} exact from a Safe$`, 'm'));
  });
  test(`past-txs --show ${name} --tx prints that transaction alone with every value the study read`, () => {
    const fit = summary.studies.find((s) => s.kind === 'fit' && s.outside.length === 0) ?? assert.fail(name);
    if (fit.kind !== 'fit') return;
    const run = show(name, '--tx', fit.hash.slice(0, 20).toUpperCase().replace('0X', '0x'));
    assert.equal(run.status, 0, run.stderr);
    fit.paths.forEach((path, i) => assert.ok(run.stdout.includes(`  ${path} = ${JSON.stringify(fit.values[i])}\n`), path));
    assert.deepEqual(run.stdout.split('\n').filter((line) => line.startsWith('0x')).map((line) => line.slice(0, 66)), [fit.hash]);
    assert.match(run.stdout, /^ {2}trace \{|^ {2}no trace/m);
  });
}

test('past-txs --show refuses a name with no summary and a hash the summary did not study', () => {
  assert.equal(show('no-such-run').status, 64);
  assert.equal(show('../../package').status, 64);
  assert.match(show('safe-add-owner', '--tx', '0xffffffffffffffffffff').stderr, /studied no such transaction/);
});

test('past-txs --show prints no control or bidirectional character a recorded value holds, so none reaches the terminal', () => {
  const name = 'cow-swap-presign';
  const file = join(SUMMARIES_DIR, `${name}.json`);
  const summary = parseSummary(file, readFileSync(join(ROOT, file), 'utf8'));
  const steer = '\u001b[2J\u202egot\u0007';
  const studies = summary.studies.map((study) => {
    if (study.kind === 'misfit' && study.reason.kind === 'field') return { ...study, reason: { ...study.reason, actual: steer }, free: study.free.map((value) => ({ ...value, value: steer })) };
    if (study.kind === 'fit') return { ...study, values: study.values.map(() => steer) };
    if (study.kind === 'unreadable') return { ...study, reason: steer };
    return study;
  });
  const registry = loadRegistry(ROOT);
  const template = loadTemplate(ROOT, summary.query.template, registry);
  const changed = { ...summary, studies };
  const misfit = studies.find((study) => study.kind === 'misfit' && study.reason.kind === 'field') ?? assert.fail('a field misfit');
  const fit = studies.find((study) => study.kind === 'fit') ?? assert.fail('a fit');
  const texts = [showSummary(changed, template, registry), showSummary(changed, template, registry, misfit.hash), showSummary(changed, template, registry, fit.hash)];
  for (const text of texts) assert.doesNotMatch(text, /[\p{C}\p{Zl}\p{Zp}](?<!\n)/u);
  assert.match(texts[0] as string, /expected .*, got \[U\+001B\]\[2J\[U\+202E\]got\[U\+0007\]/);
  assert.match(texts[1] as string, /free field \d+ = "\[2J got"/);
});

test("past-txs --show --tx prints a Safe transaction's nonce and safeTxHash, read offline from its recording", async () => {
  const recording = readRecording<PastTxsRecording>(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit.json'));
  const registry = loadRegistry(BUNDLER3);
  const summary = await studyRecording(BUNDLER3, recording, registry);
  const template = loadTemplate(BUNDLER3, summary.query.template, registry);
  const fit = summary.studies.find((s) => s.kind === 'fit' && s.sender.kind === 'safe') ?? assert.fail('a Safe that fits');
  const executions = await safeExecutions(recording.exchanges, [fit.hash]);
  const text = showSummary(summary, template, registry, fit.hash, executions);
  assert.match(text, /^ {2}Safe nonce \d+, safeTxHash 0x[0-9a-f]{64}$/m);
  assert.doesNotMatch(showSummary(summary, template, registry, fit.hash), /Safe nonce/);
});
