import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Canary } from './verdict-core.ts';

const READS_HOOK = join(import.meta.dirname, 'canary-reads.ts');

/** What one canary run gave: its test counts, its output, and each path under testdata/ or test/ it read that its `reads` lines do not name. */
export type CanaryRun = { readonly canary: Canary; readonly ok: boolean; readonly passed: number; readonly failed: number; readonly output: string; readonly unlisted: readonly string[] };

/** A path a canary may read only when its `reads` lines name it: anything under testdata/ or test/ but the canaries themselves and the modules Node loads, which the import walk already counts. */
export const isFixturePath = (path: string): boolean => path.startsWith('testdata/') || path.startsWith('test/');

/** Runs a command to its end with both outputs joined, outside any parent test run, so a test file reports in its own TAP. */
export function runProcess(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, NODE_TEST_CONTEXT: undefined, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => void (output += chunk));
    child.stderr.on('data', (chunk) => void (output += chunk));
    child.on('error', fail);
    child.on('close', (code) => done({ code, output }));
  });
}

const covers = (listed: string, path: string): boolean => (listed.endsWith('/') ? `${path}/`.startsWith(listed) : path === listed);

/** Runs one canary file of the clone at `root` in a process of its own, recording what it reads with the hook beside this file, not the clone's. */
export async function runCanary(root: string, canary: Canary): Promise<CanaryRun> {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-canary-'));
  const log = join(dir, 'reads');
  try {
    const { code, output } = await runProcess(process.execPath, ['--import', pathToFileURL(READS_HOOK).href, '--test-reporter=tap', join(root, canary.file)], root, { KISS_SIGN_CANARY_READS: log });
    const count = (label: string) => Number(new RegExp(`^# ${label} (\\d+)$`, 'm').exec(output)?.[1] ?? 0);
    const read = (() => {
      try {
        return readFileSync(log, 'utf8');
      } catch {
        return '';
      }
    })();
    const base = realpathSync(root);
    const fixtures = [...new Set(read.split('\n').filter((path) => path !== ''))]
      .map((path) => relative(base, path).split(sep).join('/'))
      .filter((path) => isFixturePath(path) && !path.startsWith('test/canaries/') && !path.endsWith('.ts'));
    const unlisted = fixtures.filter((path) => !canary.reads.some((listed) => covers(listed, path))).sort();
    const passed = count('pass');
    const failed = count('fail');
    return { canary, ok: code === 0 && failed === 0 && passed > 0, passed, failed, output, unlisted };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
