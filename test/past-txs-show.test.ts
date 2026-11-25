import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { SUMMARIES_DIR, parseSummary } from '../src/research/past-txs-summary.ts';

const ROOT = join(import.meta.dirname, '..');
const show = (...args: readonly string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'past-txs.ts'), '--show', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', KISS_SIGN_HOME: '/nonexistent' } });

for (const name of ['safe-add-owner', 'cow-swap-presign', 'fluid-vault-deposit-fusdt', 'uniswap-swap-usdt-v4']) {
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
    fit.paths.forEach((path, i) => assert.ok(run.stdout.includes(`  ${path} = ${fit.values[i]}\n`), path));
    assert.deepEqual(run.stdout.split('\n').filter((line) => line.startsWith('0x')).map((line) => line.slice(0, 66)), [fit.hash]);
    assert.match(run.stdout, /^ {2}trace \{|^ {2}no trace/m);
  });
}

test('past-txs --show refuses a name with no summary and a hash the summary did not study', () => {
  assert.equal(show('no-such-run').status, 64);
  assert.equal(show('../../package').status, 64);
  assert.match(show('safe-add-owner', '--tx', '0xffffffffffffffffffff').stderr, /studied no such transaction/);
});
