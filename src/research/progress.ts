import type { Transport } from '../chain/rpc.ts';
import type { Ask } from './sources.ts';
import type { TraceSource } from './trace.ts';

const STEPS = { pages: 'search pages', reads: 'chain answers', traces: 'call traces' } as const;
type Step = keyof typeof STEPS;

/** Counts what a long run has read and is waiting for, and writes one line of it every `everyMs` until `stop`. */
export function progress(write: (line: string) => void, everyMs = 10_000) {
  const started = Date.now();
  const read: Record<Step, number> = { pages: 0, reads: 0, traces: 0 };
  let open = 0;
  const counted = async <T>(step: Step, run: () => Promise<T>): Promise<T> => {
    open++;
    try {
      const answer = await run();
      read[step]++;
      return answer;
    } finally {
      open--;
    }
  };
  const line = () => {
    const counts = (Object.keys(STEPS) as Step[]).map((step) => `${read[step]} ${STEPS[step]}`).join(', ');
    write(`${Math.round((Date.now() - started) / 1000)} s: ${counts}; ${open === 0 ? 'nothing open: pausing before a retry, or computing' : `${open} waiting for an answer`}\n`);
  };
  const timer = setInterval(line, everyMs);
  timer.unref();
  return {
    transport: (inner: Transport): Transport => (url, body, signal) => counted('reads', () => inner(url, body, signal)),
    ask: (inner: Ask): Ask => (request, end) => counted('pages', () => inner(request, end)),
    traces: (inner: TraceSource): TraceSource => (hash) => counted('traces', () => inner(hash)),
    stop: () => clearInterval(timer),
  };
}
