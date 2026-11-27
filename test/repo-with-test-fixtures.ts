import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTRIBUTES_PATH, MARKETS_PATH, REGISTRY_PATH } from '../src/registry.ts';
import { SUMMARIES_DIR } from '../src/research/past-txs-summary.ts';
import { REPORT_RECORDINGS_DIR } from '../src/research/report.ts';
import { USAGE_DIR } from '../src/research/usage.ts';
import { PERTURB_DIR } from '../src/template/perturb.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { GENERATED_FILE } from '../src/template/vault-reports.ts';

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(import.meta.dirname, 'fixtures');

/** The templates and registry the fixtures' repository starts from, frozen by `node test/freeze-fixture-base.ts`, never the repository's own. */
export const BASE_DIR = join(FIXTURES, 'base');

/** Each instance of the base that has a report, as `<template>/instances/<instance>`. */
export const REPORTED_FILE = join(BASE_DIR, 'reported.json');

/**
 * This checkout, its templates, registry and test data as the branch holds them: what a test of one template reads, a
 * template added since the freeze included. baseRepo and repoWithTestFixtures never hold such a template.
 */
export const liveRepo = (): string => ROOT;

const removed: string[] = [];
process.on('exit', () => {
  for (const dir of removed) rmSync(dir, { recursive: true, force: true });
});

/** A new temporary folder, removed when the process exits. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  removed.push(dir);
  return dir;
}

let base: string | undefined;

/**
 * A repository of the frozen base alone: its registry and templates, and an empty report.generated.md for each instance
 * that has a report, which is all card new and card seal read of one. Built once per process; a test copies it to change it.
 */
export function baseRepo(): string {
  if (base !== undefined) return base;
  const root = tempDir('kiss-sign-base-');
  for (const part of ['registry', TEMPLATES_DIR]) cpSync(join(BASE_DIR, part), join(root, part), { recursive: true });
  for (const instance of JSON.parse(readFileSync(REPORTED_FILE, 'utf8')) as string[]) {
    mkdirSync(join(root, TEMPLATES_DIR, instance), { recursive: true });
    writeFileSync(join(root, TEMPLATES_DIR, instance, GENERATED_FILE), '');
  }
  base = root;
  return root;
}

/**
 * The test data folders a user's command writes for a template and the tests' replays read: a past-txs summary, a report
 * recording, a perturbation recording, a check-sources recording and a report's AI usage. The fixtures' repository holds
 * the tests' own, from test/fixtures/testdata/, and none of the repository's.
 */
export const FIXTURE_TESTDATA = [SUMMARIES_DIR, REPORT_RECORDINGS_DIR, PERTURB_DIR, join('testdata', 'sources'), USAGE_DIR] as const;

const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));

/** The base's `path` with each fixture registry's entries added, a fixture without the file adding none; a name in two of them is refused. */
function merged(path: string, registries: readonly string[]): Record<string, unknown> {
  const own = json(join(BASE_DIR, path));
  for (const dir of registries) {
    if (!existsSync(join(dir, path))) continue;
    const added = json(join(dir, path));
    for (const name of Object.keys(added)) if (name in own) throw new Error(`${join(dir, path)}: ${name} is in another registry too`);
    Object.assign(own, added);
  }
  return own;
}

/**
 * A repository of the tests' own: the frozen base's templates and registry with the test-only templates and registry
 * entries added, the test data folders of FIXTURE_TESTDATA, and the rest of this checkout's test data.
 * `extra` names more fixture folders, each holding `registry/contracts.json` and, when it adds any, `registry/markets.json`
 * and `registry/attributes.json`, such as the Vault V2 vaults only one test file names, which would otherwise change what
 * every test-only template's card can name.
 */
export function repoWithTestFixtures(...extra: readonly string[]): string {
  const root = tempDir('kiss-sign-fixtures-');
  cpSync(join(baseRepo(), TEMPLATES_DIR), join(root, TEMPLATES_DIR), { recursive: true });
  cpSync(join(FIXTURES, TEMPLATES_DIR), join(root, TEMPLATES_DIR), { recursive: true, errorOnExist: true, force: false });
  mkdirSync(join(root, 'registry'));
  const registries = [FIXTURES, ...extra.map((name) => join(FIXTURES, name))];
  for (const path of [REGISTRY_PATH, MARKETS_PATH, ATTRIBUTES_PATH]) writeFileSync(join(root, path), `${JSON.stringify(merged(path, registries), null, 2)}\n`);
  mkdirSync(join(root, 'testdata'));
  for (const part of FIXTURE_TESTDATA) symlinkSync(join(FIXTURES, part), join(root, part));
  for (const name of readdirSync(join(ROOT, 'testdata'))) {
    const part = join('testdata', name);
    if (!(FIXTURE_TESTDATA as readonly string[]).includes(part)) symlinkSync(join(ROOT, part), join(root, part));
  }
  return root;
}
