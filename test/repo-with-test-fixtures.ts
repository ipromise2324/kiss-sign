import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKETS_PATH, REGISTRY_PATH } from '../src/registry.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(import.meta.dirname, 'fixtures');

const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));

function merged(path: string): Record<string, unknown> {
  const own = json(join(ROOT, path));
  const added = json(join(FIXTURES, path));
  for (const name of Object.keys(added)) if (name in own) throw new Error(`test/fixtures/${path}: ${name} is in ${path} too`);
  return { ...own, ...added };
}

export function repoWithTestFixtures(): string {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-fixtures-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  cpSync(join(ROOT, TEMPLATES_DIR), join(root, TEMPLATES_DIR), { recursive: true });
  cpSync(join(FIXTURES, TEMPLATES_DIR), join(root, TEMPLATES_DIR), { recursive: true, errorOnExist: true, force: false });
  cpSync(join(ROOT, 'registry'), join(root, 'registry'), { recursive: true });
  for (const path of [REGISTRY_PATH, MARKETS_PATH]) writeFileSync(join(root, path), `${JSON.stringify(merged(path), null, 2)}\n`);
  symlinkSync(join(ROOT, 'testdata'), join(root, 'testdata'));
  return root;
}
