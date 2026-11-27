/**
 * Writes test/fixtures/frozen/, the copy of each report in FROZEN_REPORTS that the page tests read.
 *
 *   node test/freeze-reports.ts            copies each report's template folder (its own instance only, no generated report),
 *                                           the registry, its report recording, its template's perturbation recordings and its past-txs summaries as committed,
 *                                           and each full recording a summary was studied from, from .cache/past-txs/
 *                                           to .cache/past-txs/frozen/; refused unless studying that recording again
 *                                           gives the committed summary
 *   node test/freeze-reports.ts --restudy  studies each frozen recording again and rewrites its frozen summary, after
 *                                           the study code changed
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readRecording } from '../src/chain/bytecode.ts';
import { loadRegistry } from '../src/registry.ts';
import { RECORDINGS_DIR, SUMMARIES_DIR, studyRecording, summaryFile } from '../src/research/past-txs-summary.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { loadReport, pastTxsRecordings, pastTxsRegistry, reportRecordingPath } from '../src/research/report.ts';
import { PERTURB_DIR } from '../src/template/perturb.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { INSTANCE_FOLDER } from '../src/template/vault-reports.ts';
import { FROZEN_DIR, FROZEN_RECORDINGS_DIR, FROZEN_REPORTS, repoWithFrozenReports } from './frozen-reports.ts';

const REPO = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (!(args.length === 0 || (args.length === 1 && args[0] === '--restudy'))) {
  console.error('usage: node test/freeze-reports.ts [--restudy]');
  process.exit(64);
}
const restudy = args.length === 1;

const copy = (from: string, to: string) => {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
};

if (!restudy) {
  const registry = loadRegistry(REPO);
  rmSync(FROZEN_DIR, { recursive: true, force: true });
  cpSync(join(REPO, 'registry'), join(FROZEN_DIR, 'registry'), { recursive: true });
  mkdirSync(join(FROZEN_DIR, SUMMARIES_DIR), { recursive: true });
  for (const target of FROZEN_REPORTS) {
    const instances = join(REPO, TEMPLATES_DIR, target.template, INSTANCE_FOLDER);
    cpSync(join(REPO, TEMPLATES_DIR, target.template), join(FROZEN_DIR, TEMPLATES_DIR, target.template), {
      recursive: true,
      filter: (path) => !basename(path).startsWith('report.generated') && (dirname(path) !== instances || basename(path) === target.instance),
    });
    copy(join(REPO, reportRecordingPath(target)), join(FROZEN_DIR, reportRecordingPath(target)));
    for (const name of readdirSync(join(REPO, PERTURB_DIR))) {
      const file = join(PERTURB_DIR, name);
      const recorded = readRecording<{ card: { operations: { template: string }[] }; template?: unknown }>(join(REPO, file));
      if (recorded.template === undefined && recorded.card.operations.every((op) => op.template === target.template)) copy(join(REPO, file), join(FROZEN_DIR, file));
    }
    for (const { file } of pastTxsRecordings(REPO, loadReport(REPO, registry, target).subject)) {
      copy(join(REPO, file), join(FROZEN_DIR, file));
      copy(join(REPO, RECORDINGS_DIR, basename(file)), join(REPO, FROZEN_RECORDINGS_DIR, basename(file)));
    }
  }
}

const root = repoWithFrozenReports();
const registry = loadRegistry(root);
for (const file of readdirSync(join(FROZEN_DIR, SUMMARIES_DIR))) {
  const recording = readRecording<PastTxsRecording>(join(REPO, FROZEN_RECORDINGS_DIR, file));
  const summary = await studyRecording(root, recording, pastTxsRegistry(root, registry, recording.query));
  const { path, text } = summaryFile(basename(file, '.json'), summary, undefined);
  if (restudy) {
    writeFileSync(join(FROZEN_DIR, path), text);
    console.log(`wrote ${join('test', 'fixtures', 'frozen', path)}`);
  } else if (text !== readFileSync(join(FROZEN_DIR, path), 'utf8')) {
    console.error(`${join(FROZEN_DIR, path)}: studying ${join(FROZEN_RECORDINGS_DIR, file)} again does not give the committed summary; that recording is not the one it was studied from`);
    process.exit(1);
  }
}
if (!restudy) console.log(`froze ${FROZEN_REPORTS.map((t) => `${t.template} ${t.instance}`).join(', ')}`);
