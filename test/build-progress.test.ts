import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

/** Runs pnpm progress against the checkout at `root`, with a home that holds only `language` when given. */
function progress(root: string, args: readonly string[], language?: string) {
  const home = mkdtempSync(join(tmpdir(), 'kiss-sign-progress-home-'));
  if (language !== undefined) writeFileSync(join(home, 'config.json'), JSON.stringify({ language }));
  try {
    return spawnSync(process.execPath, [join(root, 'scripts', 'progress.ts'), ...args], { cwd: root, env: { PATH: process.env.PATH, HOME: home, KISS_SIGN_HOME: home }, encoding: 'utf8' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** A checkout with the program, the registry and an empty test/ and testdata/, plus `files` copied from this one. */
function checkout(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-progress-'));
  for (const dir of ['src', 'scripts', 'registry', 'node_modules', 'package.json']) cpSync(join(ROOT, dir), join(root, dir), { recursive: true, dereference: false });
  for (const dir of ['test', join('testdata', 'abi'), join('testdata', 'research'), join('testdata', 'report'), join('testdata', 'perturb'), 'templates']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of files) cpSync(join(ROOT, file), join(root, file), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

const lines = (stdout: string): string[] => stdout.trimEnd().split('\n');

test('an operation with nothing built yet is at step 0 of 11, every step not started, and step 1 next with its usual minutes', () => {
  const root = checkout([]);
  try {
    const run = progress(root, ['acme/deposit']);
    assert.equal(run.status, 0, run.stderr);
    const out = lines(run.stdout);
    assert.equal(out[0], 'acme/deposit: 0 / 11 steps done');
    assert.equal(out.slice(1, 12).filter((line) => line.includes(': not started')).length, 11);
    assert.equal(out[12], 'Next: 1. State the intent (usually 1-2 min)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a complete committed template reads done for every step through the tests, in the configured language', () => {
  const run = progress(ROOT, ['fluid/vault-deposit', '--instance', 'fluid-fusdc']);
  assert.equal(run.status, 0, run.stderr);
  const out = lines(run.stdout);
  assert.match(out[0] as string, /^fluid\/vault-deposit \(fluid-fusdc\): \d+ \/ 11 steps done$/);
  assert.deepEqual(out.slice(1, 10), [
    ' 1. State the intent: done',
    ' 2. Research the addresses: done',
    ' 3. Establish the ABI: done',
    ' 4. Draft the template: done',
    ' 5. Study past transactions: done',
    " 6. Check the protocol's health: done",
    ' 7. Generate the report: done',
    ' 8. Write the notes and reviews: done',
    ' 9. Add the tests: done',
  ]);
  const zh = lines(progress(ROOT, ['erc20/transfer'], 'zh-TW').stdout);
  assert.match(zh[0] as string, /^erc20\/transfer: \d+ \/ 11 步完成$/);
  assert.equal(zh[1], ' 1. 說明意圖: 完成');
});

test('a half-built instance shows what is done, what waits on the report, what is missing, and the report as next', () => {
  const root = checkout([
    'templates/fluid/vault-deposit/template.json',
    'templates/fluid/vault-deposit/notes.json',
    'templates/fluid/vault-deposit/instances/fluid-fusdc/notes.json',
    'testdata/research/fluid-vault-deposit-fusdc.json',
  ]);
  try {
    const run = progress(root, ['fluid/vault-deposit', '--instance', 'fluid-fusdc']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(lines(run.stdout), [
      'fluid/vault-deposit (fluid-fusdc): 5 / 11 steps done',
      ' 1. State the intent: done',
      ' 2. Research the addresses: done',
      ' 3. Establish the ABI: written by step 7 (missing: usdc, fluid-fusdc, fluid-lending-factory, fluid-liquidity)',
      ' 4. Draft the template: done',
      ' 5. Study past transactions: done',
      " 6. Check the protocol's health: done",
      ' 7. Generate the report: not started (missing: templates/fluid/vault-deposit/docs.json, testdata/report/fluid-vault-deposit/fluid-fusdc.json, templates/fluid/vault-deposit/instances/fluid-fusdc/report.generated.md)',
      ' 8. Write the notes and reviews: partly done (missing: templates/fluid/vault-deposit/instances/fluid-fusdc/report.generated.en.html)',
      ' 9. Add the tests: not started (missing: test/*.test.ts)',
      '10. Check and commit: not started (missing: 1-9)',
      '11. Push and tell the signer: not started (missing: git push)',
      'Next: 7. Generate the report (usually 3-5 min)',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a build new since origin/main counts only a test it changed, not an older one naming the operation', () => {
  const root = checkout(['templates/fluid/vault-deposit/template.json']);
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });
  const step9 = () => lines(progress(root, ['fluid/vault-deposit', '--instance', 'fluid-fusdc']).stdout)[9];
  try {
    writeFileSync(join(root, 'test', 'older.test.ts'), "'fluid/vault-deposit' 'fluid-fusdc'\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(step9(), ' 9. Add the tests: not started (missing: test/*.test.ts changed on this branch)');
    cpSync(join(ROOT, 'templates/fluid/vault-deposit/instances/fluid-fusdc/notes.json'), join(root, 'templates/fluid/vault-deposit/instances/fluid-fusdc/notes.json'));
    assert.equal(step9(), ' 9. Add the tests: not started (missing: test/*.test.ts changed on this branch)');
    writeFileSync(join(root, 'test', 'fusdt.test.ts'), "'fluid/vault-deposit' 'fluid-fusdt'\n");
    assert.equal(step9(), ' 9. Add the tests: not started (missing: test/*.test.ts changed on this branch)');
    writeFileSync(join(root, 'test', 'fusdc.test.ts'), '"fluid/vault-deposit" "fluid-fusdc"\n');
    assert.equal(step9(), ' 9. Add the tests: done');
    git('add', '-A');
    git('commit', '-q', '-m', 'build');
    assert.equal(step9(), ' 9. Add the tests: done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a template that names no registry entry has no address to research, so step 2 is done once it parses', () => {
  const root = checkout(['templates/eth/transfer/template.json']);
  const step2 = () => lines(progress(root, ['eth/transfer']).stdout)[2];
  try {
    assert.equal(step2(), ' 2. Research the addresses: done');
    writeFileSync(join(root, 'templates', 'eth', 'transfer', 'template.json'), '{');
    assert.equal(step2(), ' 2. Research the addresses: not started (missing: registry entries)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a template reported per instance is refused without --instance', () => {
  const run = progress(ROOT, ['fluid/vault-deposit']);
  assert.equal(run.status, 2);
  assert.equal(run.stderr, 'REFUSED  fluid/vault-deposit is reported per instance; name one with --instance <registry name>\n');
});

test("a template whose calls reach only tokens has no protocol to note, so step 6 is done; one that calls a protocol needs its notes, and one DefiLlama does not list a judgment", () => {
  const root = checkout(['templates/erc20/transfer/template.json', 'templates/fluid/vault-deposit/template.json', 'templates/cow/swap/template.json']);
  const step6 = (args: string[]) => lines(progress(root, args).stdout)[6];
  try {
    for (const template of ['erc20/transfer', 'fluid/vault-deposit']) writeFileSync(join(root, 'templates', template, 'notes.json'), JSON.stringify({ title: { en: 'x' } }));
    assert.equal(step6(['erc20/transfer']), " 6. Check the protocol's health: done");
    assert.equal(step6(['fluid/vault-deposit', '--instance', 'fluid-fusdc']), " 6. Check the protocol's health: not started (missing: notes.json: protocols.fluid-lending)");
    const contracts = JSON.parse(readFileSync(join(root, 'registry', 'contracts.json'), 'utf8'));
    delete contracts['gpv2-settlement'].defillama;
    writeFileSync(join(root, 'registry', 'contracts.json'), JSON.stringify(contracts));
    writeFileSync(join(root, 'templates', 'cow/swap', 'notes.json'), JSON.stringify({ title: { en: 'x' } }));
    assert.equal(step6(['cow/swap']), " 6. Check the protocol's health: not started (missing: notes.json: judgments (the health of gpv2-settlement, which DefiLlama does not list))");
    writeFileSync(join(root, 'templates', 'cow/swap', 'notes.json'), JSON.stringify({ title: { en: 'x' }, judgments: [{ text: { en: 'x' } }] }));
    assert.equal(step6(['cow/swap']), " 6. Check the protocol's health: done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
