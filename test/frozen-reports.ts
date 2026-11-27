import { mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { REPORT_RECORDINGS_DIR } from '../src/research/report.ts';
import { RECORDINGS_DIR, SUMMARIES_DIR } from '../src/research/past-txs-summary.ts';
import { USAGE_DIR } from '../src/research/usage.ts';
import { PERTURB_DIR } from '../src/template/perturb.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { tempDir } from './fixture-base.ts';

const ROOT = join(import.meta.dirname, '..');

/**
 * Copies of committed reports' inputs as they were when frozen, for the tests that pin what a page says: re-recording
 * one of these reports rewrites its files in the repository, never the copy. `node test/freeze-reports.ts` writes them.
 */
export const FROZEN_DIR = join(import.meta.dirname, 'fixtures', 'frozen');
export const FROZEN_REPORTS = [
  { template: 'morpho/vault-deposit', instance: 'hyperithm-usdc-apex-v2-9e2f' },
  { template: 'morpho/vault-v2-revoke', instance: 'acuto-usdc-v2-4a57' },
] as const;

/** Where each full past-txs recording a frozen summary was studied from stays, on the computer that froze it. */
export const FROZEN_RECORDINGS_DIR = join(RECORDINGS_DIR, 'frozen');

/** The folders the frozen copy holds in place of the repository's. */
const FROZEN_PARTS = [TEMPLATES_DIR, 'registry', REPORT_RECORDINGS_DIR, SUMMARIES_DIR, PERTURB_DIR];

/** A repository whose templates, registry, report recordings, past-txs summaries and perturbation recordings are the frozen ones, which holds no usage file, and whose other test data is this checkout's. */
export function repoWithFrozenReports(): string {
  const root = tempDir('kiss-sign-frozen-');
  mkdirSync(join(root, 'testdata'));
  for (const part of FROZEN_PARTS) symlinkSync(join(FROZEN_DIR, part), join(root, part));
  for (const name of readdirSync(join(ROOT, 'testdata'))) {
    const part = join('testdata', name);
    if (part !== USAGE_DIR && !FROZEN_PARTS.includes(part)) symlinkSync(join(ROOT, part), join(root, part));
  }
  return root;
}
