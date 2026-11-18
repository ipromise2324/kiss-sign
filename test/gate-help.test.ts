import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const SEALED_OFF = pathToFileURL(join(import.meta.dirname, 'sealed-off.ts')).href;
const tracked = (): string => execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });

for (const script of ['check-push', 'program-gate', 'report']) {
  for (const flag of ['--help', '-h']) {
    test(`scripts/${script}.ts ${flag} prints its usage and exits 0 without a home, a key, git or the network`, () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'kiss-sign-help-'));
      const home = join(sandbox, 'home');
      try {
        const before = tracked();
        const run = spawnSync(process.execPath, ['--import', SEALED_OFF, join(ROOT, 'scripts', `${script}.ts`), flag], {
          cwd: sandbox,
          env: { PATH: process.env.PATH, HOME: sandbox, KISS_SIGN_HOME: home, SEALED_PATHS: [home, join(sandbox, '.kiss-sign'), join(ROOT, 'vendor')].join(':') },
          encoding: 'utf8',
        });
        assert.equal(run.stderr, '');
        assert.equal(run.status, 0);
        assert.match(run.stdout, new RegExp(`^usage: pnpm ${script} `));
        assert.equal(existsSync(home), false);
        assert.equal(tracked(), before);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  }
}
