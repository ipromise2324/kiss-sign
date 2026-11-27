import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Exchange } from '../src/chain/recording.ts';
import { tempDir } from './repo-with-test-fixtures.ts';

const ROOT = join(import.meta.dirname, '..');
const HOOK = pathToFileURL(join(import.meta.dirname, 'offline-network.ts')).href;

/** The past-txs summaries only tests read, kept out of testdata/research so no report prints them. */
export const SUMMARY_FIXTURES = join(import.meta.dirname, 'fixtures', 'past-txs-summaries');

export type Http = Record<string, { status: number; text: string }>;
export type Network = { readonly exchanges: readonly Exchange[]; readonly http?: Http; readonly otherwise?: { status: number; text: string } };
export type Run = { status: number | null; stdout: string; stderr: string; written: string[] };

/** The folders a script may write: a copy of each is in the sandbox, so a write lands there and is seen. */
const WRITABLE = ['templates', 'registry', 'testdata'];

/**
 * Fills `sandbox` with a copy of the program, its own `src/` and `scripts/` so a script finds its repository there, with
 * the registry, templates and test data of `repoFrom`, its test data this checkout's when it holds none, but
 * `testdata/<except>`.
 */
function programIn(sandbox: string, repoFrom: string, except?: string): void {
  for (const name of readdirSync(ROOT)) if (!['.git', '.cache', 'src', 'scripts', ...WRITABLE].includes(name)) symlinkSync(join(ROOT, name), join(sandbox, name));
  const clone = (from: string, to: string) => cpSync(from, to, { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
  for (const name of ['src', 'scripts']) clone(join(ROOT, name), join(sandbox, name));
  for (const name of ['templates', 'registry']) clone(join(repoFrom, name), join(sandbox, name));
  const testdata = existsSync(join(repoFrom, 'testdata')) ? join(repoFrom, 'testdata') : join(ROOT, 'testdata');
  mkdirSync(join(sandbox, 'testdata'));
  for (const name of readdirSync(testdata)) if (name !== except) clone(join(testdata, name), join(sandbox, 'testdata', name));
}

/** Each file under the writable folders of `sandbox` but `except`, with its size and time of change. */
function snapshot(sandbox: string, except: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const dir of WRITABLE) {
    for (const entry of readdirSync(join(sandbox, dir), { recursive: true, withFileTypes: true })) {
      const path = relative(sandbox, join(entry.parentPath, entry.name));
      if (!entry.isFile() || path.startsWith(`${except}/`)) continue;
      const { size, mtimeMs } = statSync(join(sandbox, path));
      files.set(path, `${size} ${mtimeMs}`);
    }
  }
  return files;
}

/** A copy of the program whose registry, templates and test data are those of `repoFrom`, such as the frozen test/fixtures/base/, removed when the process exits. */
export function programWith(repoFrom: string): string {
  const sandbox = tempDir('kiss-sign-program-');
  programIn(sandbox, repoFrom);
  return sandbox;
}

/**
 * Runs `script` from a copy of the program whose `testdata/<output>` holds only the `seed` files, with every network
 * answer taken from `network` and `$KISS_SIGN_HOME/config.json` holding `config` when given, and lists what it wrote
 * there; a write to any other file of the registry, the templates or the test data fails. Each seed file is copied from
 * `seedFrom`, by default this checkout's own `testdata/<output>`, and the registry, templates and other test data from
 * `repoFrom`, by default this checkout.
 */
export function runOffline(script: string, args: readonly string[], output: string, network: Network, seed: readonly string[] = [], config?: object, seedFrom = join(ROOT, 'testdata', output), repoFrom = ROOT): Run {
  const sandbox = mkdtempSync(join(tmpdir(), 'kiss-sign-offline-'));
  try {
    if (config !== undefined) {
      mkdirSync(join(sandbox, 'home'));
      writeFileSync(join(sandbox, 'home', 'config.json'), JSON.stringify(config));
    }
    programIn(sandbox, repoFrom, output);
    const out = join(sandbox, 'testdata', output);
    mkdirSync(out);
    for (const file of seed) cpSync(join(seedFrom, file), join(out, file));
    const answers = join(sandbox, 'answers.json');
    writeFileSync(answers, JSON.stringify({ exchanges: network.exchanges, http: network.http ?? {}, otherwise: network.otherwise }));
    const before = snapshot(sandbox, join('testdata', output));
    const run = spawnSync(process.execPath, ['--import', HOOK, join(sandbox, 'scripts', script), ...args], {
      env: { PATH: process.env.PATH, KISS_SIGN_HOME: join(sandbox, 'home'), ALCHEMY_API_KEY: 'offline-alchemy', DRPC_API_KEY: 'offline-drpc', ETHERSCAN_API_KEY: 'offline', OFFLINE_ANSWERS: answers },
      cwd: sandbox,
      encoding: 'utf8',
      timeout: 300_000,
    });
    const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    const written = files.map((entry) => relative(out, join(entry.parentPath, entry.name))).filter((file) => !seed.includes(file));
    const after = snapshot(sandbox, join('testdata', output));
    const elsewhere = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path));
    assert.deepEqual(elsewhere, [], `${script} wrote outside testdata/${output}`);
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, written };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
