/**
 * Writes the past-txs summary of a test-only template, whose report a test renders: for each name, studies
 * testdata/past-txs/<name>.json in the test fixtures' repository, with the registry its report reads, and writes
 * testdata/research/<name>.json. A recording of a template in templates/ is studied by `pnpm past-txs --restudy`.
 *
 *   node test/fixture-summaries.ts <name>...
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecording } from '../src/chain/bytecode.ts';
import { loadRegistry } from '../src/registry.ts';
import { SUMMARIES_DIR, studyRecording, summaryText } from '../src/research/past-txs-summary.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { pastTxsRegistry } from '../src/research/report.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const REPO = join(import.meta.dirname, '..');
const names = process.argv.slice(2);
if (names.length === 0 || names.some((name) => !/^[a-z0-9-]+$/.test(name))) {
  console.error('usage: node test/fixture-summaries.ts <name>...');
  process.exit(64);
}

const root = repoWithTestFixtures();
const registry = loadRegistry(root);
for (const name of names) {
  const recording = readRecording<PastTxsRecording>(join(REPO, 'testdata', 'past-txs', `${name}.json`));
  const summary = await studyRecording(root, recording, pastTxsRegistry(root, registry, recording.query));
  writeFileSync(join(REPO, SUMMARIES_DIR, `${name}.json`), summaryText(summary));
  console.log(`wrote ${join(SUMMARIES_DIR, `${name}.json`)}`);
}
