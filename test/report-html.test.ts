import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadRegistry } from '../src/registry.ts';
import { NOTES_FILE, notesChanges } from '../src/research/notes.ts';
import { GENERATED_HTML_FILE, generatedHtml, htmlDifference } from '../src/research/report-html.ts';
import { loadSubject } from '../src/research/report.ts';
import type { ReportInputs } from '../src/research/report.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const templates = readdirSync(join(ROOT, TEMPLATES_DIR)).flatMap((protocol) => readdirSync(join(ROOT, TEMPLATES_DIR, protocol)).map((operation) => `${protocol}/${operation}`));
const has = (id: string, file: string) => existsSync(join(ROOT, TEMPLATES_DIR, id, file));

test('a template commits report.generated.html exactly when it has notes.json, and none has report.md', () => {
  for (const id of templates) {
    assert.equal(has(id, GENERATED_HTML_FILE), has(id, NOTES_FILE), `${id}: ${GENERATED_HTML_FILE} without ${NOTES_FILE}, or the reverse`);
    assert.ok(!has(id, 'report.md'), `${id} has report.md, which notes.json replaced`);
  }
});

test('a template without notes.json gets no HTML report', () => {
  const registry = loadRegistry(ROOT);
  const subject = loadSubject(ROOT, registry, { template: 'morpho/market-supply' });
  assert.equal(generatedHtml(ROOT, { subject, registry } as ReportInputs), undefined);
});

test('--compare prints the first line where the committed HTML report differs', () => {
  assert.equal(htmlDifference('a\nb', 'a\nb'), undefined);
  assert.equal(htmlDifference('a\nb ok', 'a\nb FINDING'), 'line 2: committed "b ok", the program writes "b FINDING"');
  assert.match(htmlDifference(undefined, 'a') ?? '', /no committed report\.generated\.html/);
  assert.match(htmlDifference('a', undefined) ?? '', /no notes\.json/);
});

test('--compare names every notes.json a branch changes, as text the AI wrote', () => {
  assert.deepEqual(notesChanges(['src/x.ts', 'templates/morpho/market-supply/notes.json', 'templates/morpho/market-supply/report.generated.html', 'templates/notes.json']), ['templates/morpho/market-supply/notes.json']);
});
