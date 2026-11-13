import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { loadAbiCases, replayAbiCase } from '../src/contracts/abi-case.ts';
import type { AbiCase } from '../src/contracts/abi-case.ts';
import { SOLC_PINS } from '../src/contracts/solc-pins.ts';
import { cachedCompilers, pinnedCompilers } from '../src/contracts/solc.ts';
import type { Compilers } from '../src/contracts/solc.ts';
import type { Registry } from '../src/registry.ts';
import { entriesOf, loadReport } from '../src/research/report.ts';
import type { Target } from '../src/research/report.ts';

/** Test-only: no command under src/, scripts/ or bin/ reads it, which test/solc-pool.test.ts checks. */
export const SOLC_TEST_CACHE_DIR = join(import.meta.dirname, '..', '.cache', 'solc-test');

/** CI sets it; without it every test run compiles everything. */
const cacheDirFromEnv = (): string | undefined => (process.env.SOLC_TEST_CACHE === '1' ? SOLC_TEST_CACHE_DIR : undefined);

type Job = { readonly version: string; readonly input: string };

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const keyOf = ({ version, input }: Job): string => `${version}\n${input}`;

/** Keyed by the pinned build's sha256 and the exact input, so another build or one changed byte of input misses. */
function entryPath(dir: string, { version, input }: Job): string | undefined {
  const pin = SOLC_PINS[version];
  return pin === undefined ? undefined : join(dir, `${sha256(`${pin.sha256}\n${input}`)}.json`);
}

function readEntry(dir: string, job: Job): string | undefined {
  const path = entryPath(dir, job);
  if (path === undefined) return undefined;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as { outputSha256?: unknown; output?: unknown };
    return typeof entry.output === 'string' && entry.outputSha256 === sha256(entry.output) ? entry.output : undefined;
  } catch {
    return undefined;
  }
}

function writeEntry(dir: string, job: Job, output: string): void {
  const path = entryPath(dir, job);
  if (path === undefined) return;
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify({ outputSha256: sha256(output), output }));
  renameSync(temp, path);
}

async function inputsOf(cases: readonly AbiCase[]): Promise<Job[]> {
  const jobs = new Map<string, Job>();
  const capture: Compilers = (version) => ({
    kind: 'loaded',
    solc: {
      version,
      compile: (input) => {
        jobs.set(keyOf({ version, input }), { version, input });
        throw new Error('captured');
      },
    },
  });
  await Promise.all(cases.map((fixture) => replayAbiCase(fixture, capture)));
  return [...jobs.values()];
}

function compileInWorker(job: Job): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: job });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`the solc ${job.version} worker exited with ${code}`)));
  });
}

/** The recorded ABI cases a replay of these reports proves again, as `replayReport` picks them. */
export function reportCases(root: string, registry: Registry, targets: readonly Target[]): AbiCase[] {
  const cases = loadAbiCases(root);
  const entries = new Set(
    targets.flatMap((target) => {
      const report = loadReport(root, registry, target);
      return entriesOf(report.subject, report.registry);
    }),
  );
  return [...entries].flatMap((entry) => cases.get(entry.address) ?? []);
}

/**
 * The pinned compilers, with each distinct standard-JSON input the replay of these cases compiles run first on worker
 * threads at once, or taken from the cache directory when one is given. A worker loads the pinned solc by its sha256 as
 * the main thread does, and only that exact input is answered from its output; every proof, with its comparison
 * against the code on chain, still runs on the main thread.
 */
export async function warmCompilers(cases: readonly AbiCase[], cacheDir: string | undefined = cacheDirFromEnv()): Promise<Compilers> {
  const outputs = new Map<string, string>();
  const queue: Job[] = [];
  for (const job of await inputsOf(cases)) {
    const cached = cacheDir === undefined ? undefined : readEntry(cacheDir, job);
    if (cached === undefined) queue.push(job);
    else outputs.set(keyOf(job), cached);
  }
  queue.sort((a, b) => b.input.length - a.input.length);
  const run = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const output = await compileInWorker(job);
      if (output === undefined) continue;
      outputs.set(keyOf(job), output);
      if (cacheDir !== undefined) writeEntry(cacheDir, job, output);
    }
  };
  await Promise.all(Array.from({ length: Math.min(queue.length, availableParallelism(), 4) }, run));
  const pinned = cachedCompilers();
  return (version) => {
    const load = pinned(version);
    if (load.kind !== 'loaded') return load;
    const compile = (input: string): string => {
      const job = { version, input };
      const known = outputs.get(keyOf(job)) ?? (cacheDir === undefined ? undefined : readEntry(cacheDir, job));
      if (known !== undefined) return known;
      const output = load.solc.compile(input);
      if (cacheDir !== undefined) writeEntry(cacheDir, job, output);
      return output;
    };
    return { kind: 'loaded', solc: { version, compile } };
  };
}

if (!isMainThread && parentPort !== null) {
  const { version, input } = workerData as Job;
  const load = pinnedCompilers()(version);
  parentPort.postMessage(load.kind === 'loaded' ? load.solc.compile(input) : undefined);
}
