import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Exchange } from '../src/chain/recording.ts';

const ROOT = join(import.meta.dirname, '..');
const HOOK = pathToFileURL(join(import.meta.dirname, 'offline-network.ts')).href;

/** The past-txs summaries only tests read, kept out of testdata/research so no report prints them. */
export const SUMMARY_FIXTURES = join(import.meta.dirname, 'fixtures', 'past-txs-summaries');

export type Http = Record<string, { status: number; text: string }>;
export type Network = { readonly exchanges: readonly Exchange[]; readonly http?: Http };
export type Run = { status: number | null; stdout: string; stderr: string; written: string[] };

/**
 * Runs `script` from a copy of the program whose `testdata/<output>` holds only the `seed` files, every other folder of
 * `testdata/` the repository's own, with every network answer taken from `network` and `$KISS_SIGN_HOME/config.json`
 * holding `config` when given, and lists what it wrote there. Each seed file is copied from `seedFrom`, by default the
 * repository's own `testdata/<output>`.
 */
export function runOffline(script: string, args: readonly string[], output: string, network: Network, seed: readonly string[] = [], config?: object, seedFrom = join(ROOT, 'testdata', output)): Run {
  const sandbox = mkdtempSync(join(tmpdir(), 'kiss-sign-offline-'));
  try {
    if (config !== undefined) {
      mkdirSync(join(sandbox, 'home'));
      writeFileSync(join(sandbox, 'home', 'config.json'), JSON.stringify(config));
    }
    const copied = ['src', 'scripts', 'registry'];
    for (const name of readdirSync(ROOT)) if (!['.git', '.cache', 'testdata', ...copied].includes(name)) symlinkSync(join(ROOT, name), join(sandbox, name));
    for (const name of copied) cpSync(join(ROOT, name), join(sandbox, name), { recursive: true });
    mkdirSync(join(sandbox, 'testdata'));
    for (const name of readdirSync(join(ROOT, 'testdata'))) if (name !== output) symlinkSync(join(ROOT, 'testdata', name), join(sandbox, 'testdata', name));
    const out = join(sandbox, 'testdata', output);
    mkdirSync(out);
    for (const file of seed) cpSync(join(seedFrom, file), join(out, file));
    const answers = join(sandbox, 'answers.json');
    writeFileSync(answers, JSON.stringify({ exchanges: network.exchanges, http: network.http ?? {} }));
    const run = spawnSync(process.execPath, ['--import', HOOK, join(sandbox, 'scripts', script), ...args], {
      env: { PATH: process.env.PATH, KISS_SIGN_HOME: join(sandbox, 'home'), ALCHEMY_API_KEY: 'offline', DRPC_API_KEY: 'offline-drpc', ETHERSCAN_API_KEY: 'offline', OFFLINE_ANSWERS: answers },
      cwd: sandbox,
      encoding: 'utf8',
      timeout: 300_000,
    });
    const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    const written = files.map((entry) => relative(out, join(entry.parentPath, entry.name))).filter((file) => !seed.includes(file));
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, written };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
