import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { replayAbiCase } from '../src/contracts/abi-case.ts';
import type { AbiCase } from '../src/contracts/abi-case.ts';
import { cachedCompilers, pinnedCompilers } from '../src/contracts/solc.ts';
import type { Compilers } from '../src/contracts/solc.ts';

type Job = { readonly version: string; readonly input: string };

const keyOf = ({ version, input }: Job): string => `${version}\n${input}`;

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

/**
 * The pinned compilers, with each distinct standard-JSON input the replay of these cases compiles run first on worker
 * threads at once. A worker loads the pinned solc by its sha256 as the main thread does, and only that exact input is
 * answered from its output; every proof, with its comparison against the code on chain, still runs on the main thread.
 */
export async function warmCompilers(cases: readonly AbiCase[]): Promise<Compilers> {
  const queue = (await inputsOf(cases)).sort((a, b) => b.input.length - a.input.length);
  const outputs = new Map<string, string>();
  const run = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const output = await compileInWorker(job);
      if (output !== undefined) outputs.set(keyOf(job), output);
    }
  };
  await Promise.all(Array.from({ length: Math.min(queue.length, availableParallelism()) }, run));
  const cached = cachedCompilers();
  return (version) => {
    const load = cached(version);
    if (load.kind !== 'loaded') return load;
    return { kind: 'loaded', solc: { version, compile: (input) => outputs.get(keyOf({ version, input })) ?? load.solc.compile(input) } };
  };
}

if (!isMainThread && parentPort !== null) {
  const { version, input } = workerData as Job;
  const load = pinnedCompilers()(version);
  parentPort.postMessage(load.kind === 'loaded' ? load.solc.compile(input) : undefined);
}
