/**
 * Writes a test-only past-txs summary, such as the one a test-only template's report prints: for each name, studies
 * testdata/past-txs/<name>.json, or the full recording in .cache/past-txs/ when no test reads one, in the test fixtures'
 * repository, with the registry its report reads, and writes test/fixtures/testdata/research/<name>.json. A summary in
 * testdata/research/ is studied again by `pnpm past-txs --restudy`.
 *
 *   node test/fixture-summaries.ts <name>...
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecording } from '../src/chain/bytecode.ts';
import { loadRegistry } from '../src/registry.ts';
import { RECORDINGS_DIR, studyRecording, summaryFile } from '../src/research/past-txs-summary.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { pastTxsRegistry } from '../src/research/report.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const REPO = join(import.meta.dirname, '..');
const FIXTURES = join(import.meta.dirname, 'fixtures');
const names = process.argv.slice(2);
if (names.length === 0 || names.some((name) => !/^[a-z0-9-]+$/.test(name))) {
  console.error('usage: node test/fixture-summaries.ts <name>...');
  process.exit(64);
}

const root = repoWithTestFixtures();
const registry = loadRegistry(root);
for (const name of names) {
  const trimmed = join(REPO, 'testdata', 'past-txs', `${name}.json`);
  const recording = readRecording<PastTxsRecording>(existsSync(trimmed) ? trimmed : join(REPO, RECORDINGS_DIR, `${name}.json`));
  const summary = await studyRecording(root, recording, pastTxsRegistry(root, registry, recording.query));
  const file = summaryFile(name, summary, undefined);
  writeFileSync(join(FIXTURES, file.path), file.text);
  console.log(`wrote ${join('test', 'fixtures', file.path)}`);
}
