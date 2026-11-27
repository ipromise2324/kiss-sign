/**
 * Writes test/fixtures/base/, the templates and registry the test fixtures' repository starts from: `registry/` and each
 * template's `template.json` and `docs.json`, its instances' included, as this checkout commits them, and `reported.json`,
 * each instance with a report, and refuses while `templates/` or `registry/` holds a change not committed. The tests
 * that check the program read this copy, so a template or registry entry a user adds or changes moves none of them.
 *
 *   node test/freeze-fixture-base.ts
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { GENERATED_FILE, INSTANCE_FOLDER } from '../src/template/vault-reports.ts';
import { BASE_DIR, REPORTED_FILE } from './fixture-base.ts';

const REPO = join(import.meta.dirname, '..');
const KEPT = new Set(['template.json', 'docs.json']);

if (process.argv.length > 2) {
  console.error('usage: node test/freeze-fixture-base.ts');
  process.exit(64);
}

const uncommitted = execFileSync('git', ['status', '--porcelain', '--', TEMPLATES_DIR, 'registry'], { cwd: REPO, encoding: 'utf8' });
if (uncommitted !== '') {
  console.error(`REFUSED  templates/ or registry/ holds changes not committed; commit or remove them first:\n${uncommitted}`);
  process.exit(1);
}

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

rmSync(BASE_DIR, { recursive: true, force: true });
cpSync(join(REPO, 'registry'), join(BASE_DIR, 'registry'), { recursive: true });
const all = files(join(REPO, TEMPLATES_DIR));
for (const file of all.filter((path) => KEPT.has(basename(path)))) {
  const to = join(BASE_DIR, relative(REPO, file));
  mkdirSync(dirname(to), { recursive: true });
  cpSync(file, to);
}
const reported = all.filter((path) => basename(path) === GENERATED_FILE && basename(dirname(dirname(path))) === INSTANCE_FOLDER);
writeFileSync(REPORTED_FILE, `${JSON.stringify(reported.map((path) => relative(join(REPO, TEMPLATES_DIR), dirname(path))).sort(), null, 2)}\n`);
console.log(`froze registry/ and ${TEMPLATES_DIR}/ into ${relative(REPO, BASE_DIR)}`);
