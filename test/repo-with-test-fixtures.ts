import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKETS_PATH, REGISTRY_PATH } from '../src/registry.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(import.meta.dirname, 'fixtures');

const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));

/** `path` of the repository with each fixture registry's entries added; a name in two of them is refused. */
function merged(path: string, registries: readonly string[]): Record<string, unknown> {
  const own = json(join(ROOT, path));
  for (const dir of registries) {
    const added = json(join(dir, path));
    for (const name of Object.keys(added)) if (name in own) throw new Error(`${join(dir, path)}: ${name} is in another registry too`);
    Object.assign(own, added);
  }
  return own;
}

/**
 * A copy of the repository with the test-only templates and registry entries added. `extra` names more fixture folders,
 * each holding `registry/contracts.json` and `registry/markets.json`, such as the Vault V2 vaults only one test file
 * names, which would otherwise change what every test-only template's card can name.
 */
export function repoWithTestFixtures(...extra: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-fixtures-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  cpSync(join(ROOT, TEMPLATES_DIR), join(root, TEMPLATES_DIR), { recursive: true });
  cpSync(join(FIXTURES, TEMPLATES_DIR), join(root, TEMPLATES_DIR), { recursive: true, errorOnExist: true, force: false });
  cpSync(join(ROOT, 'registry'), join(root, 'registry'), { recursive: true });
  const registries = [FIXTURES, ...extra.map((name) => join(FIXTURES, name))];
  for (const path of [REGISTRY_PATH, MARKETS_PATH]) writeFileSync(join(root, path), `${JSON.stringify(merged(path, registries), null, 2)}\n`);
  symlinkSync(join(ROOT, 'testdata'), join(root, 'testdata'));
  return root;
}
