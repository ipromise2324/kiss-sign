import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CORE_ENTRY, CORE_LIST, PACKAGE_FILES, coreListText, coreOnDisk } from '../src/verdict-core.ts';

const ROOT = join(import.meta.dirname, '..');

test('docs/verdict-core.txt lists exactly the files bin/kiss-sign can run; pnpm verdict-core writes it again', () => {
  assert.equal(readFileSync(join(ROOT, CORE_LIST), 'utf8'), coreListText(coreOnDisk(ROOT)));
});

test('the verdict core is every repository file Node loads to run bin/kiss-sign, and the packages it imports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-core-'));
  const hook = join(dir, 'record.mjs');
  writeFileSync(hook, "import { registerHooks } from 'node:module';\nimport { writeSync } from 'node:fs';\nregisterHooks({ load(url, context, next) { writeSync(3, url + '\\n'); return next(url, context); } });\n");
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, join(ROOT, CORE_ENTRY)], {
    env: { ...process.env, KISS_SIGN_HOME: join(dir, 'home') },
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  const prefix = pathToFileURL(ROOT).href + '/';
  const loaded = String(run.output[3]).split('\n').filter((url) => url.startsWith(prefix) && !url.includes('/node_modules/')).map((url) => url.slice(prefix.length));
  assert.ok(loaded.includes('src/verify/verdict.ts'));
  assert.deepEqual(loaded.sort(), coreOnDisk(ROOT).filter((path) => !PACKAGE_FILES.includes(path)));
});

test('the verdict core holds the checks and the self-check, and no report or research tool', () => {
  const core = coreOnDisk(ROOT);
  for (const path of ['bin/kiss-sign', 'src/verify/verdict.ts', 'src/verify/self-check.ts', 'src/template/check.ts', 'src/floor/floor.ts', 'src/safe/hash.ts', 'package.json']) assert.ok(core.includes(path), path);
  for (const path of ['src/research/report.ts', 'src/research/past-txs.ts', 'src/research/vault-evidence.ts', 'scripts/report.ts']) assert.ok(!core.includes(path), path);
});
