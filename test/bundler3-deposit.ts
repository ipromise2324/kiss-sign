import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

/** The fixture copy of morpho/vault-deposit as it was when the app deposited through Bundler3; only its id differs. */
export const BUNDLER3_DEPOSIT = 'morpho/vault-deposit-bundler3';

/** The test fixtures' repository with the Bundler3 template under the id the recordings of that route name, morpho/vault-deposit. */
export function repoWithBundler3Deposit(): string {
  const root = repoWithTestFixtures();
  const old = readFileSync(join(root, TEMPLATES_DIR, BUNDLER3_DEPOSIT, 'template.json'), 'utf8');
  writeFileSync(join(root, TEMPLATES_DIR, 'morpho/vault-deposit', 'template.json'), old.replace(BUNDLER3_DEPOSIT, 'morpho/vault-deposit'));
  return root;
}
