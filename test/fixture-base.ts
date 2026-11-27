import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
