import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { replayAbiCase } from '../src/contracts/abi-case.ts';
import type { AbiCase } from '../src/contracts/abi-case.ts';
import { cachedCompilers, pinnedCompilers } from '../src/contracts/solc.ts';
import type { Compilers } from '../src/contracts/solc.ts';

type Compiled = readonly (readonly [key: string, output: string])[];

const keyOf = (version: string, input: string): string => `${version}\n${input}`;

const sourceSize = (fixture: AbiCase): number => JSON.stringify(fixture.sourcify).length;

function compileInWorker(fixture: AbiCase): Promise<Compiled> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { fixture } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`the solc worker for ${fixture.address} exited with ${code}`)));
  });
}

/**
 * The pinned compilers, with every compile the replay of these cases makes run first on worker threads at once. Each
 * worker loads the pinned solc by its sha256 as the main thread does; only the exact standard-JSON input a worker
 * compiled is answered from its output, and every proof, with its comparison against the code on chain, still runs
 * on the main thread.
 */
export async function warmCompilers(cases: readonly AbiCase[]): Promise<Compilers> {
  const queue = [...new Set(cases)].sort((a, b) => sourceSize(b) - sourceSize(a));
  const outputs = new Map<string, string>();
  const run = async (): Promise<void> => {
    for (let fixture = queue.shift(); fixture !== undefined; fixture = queue.shift()) {
      for (const [key, output] of await compileInWorker(fixture)) outputs.set(key, output);
    }
  };
  await Promise.all(Array.from({ length: Math.min(queue.length, availableParallelism()) }, run));
  const cached = cachedCompilers();
  return (version) => {
    const load = cached(version);
    if (load.kind !== 'loaded') return load;
    return { kind: 'loaded', solc: { version, compile: (input) => outputs.get(keyOf(version, input)) ?? load.solc.compile(input) } };
  };
}

if (!isMainThread && parentPort !== null) {
  const compiled: [string, string][] = [];
  const pinned = pinnedCompilers();
  const recording: Compilers = (version) => {
    const load = pinned(version);
    if (load.kind !== 'loaded') return load;
    const compile = (input: string): string => {
      const output = load.solc.compile(input);
      compiled.push([keyOf(version, input), output]);
      return output;
    };
    return { kind: 'loaded', solc: { version, compile } };
  };
  await replayAbiCase((workerData as { fixture: AbiCase }).fixture, recording);
  parentPort.postMessage(compiled);
}
