/**
 * One request at a time, each starting when the one before has ended and at least `pauseMs` after it started: every
 * caller of one service in a run shares one, so the service's rate limit sees a single paced stream.
 */
export function turns(pauseMs: number): <T>(ask: () => Promise<T>) => Promise<T> {
  let free: Promise<unknown> = Promise.resolve();
  return <T>(ask: () => Promise<T>): Promise<T> => {
    const started = free.then(() => ({ asked: Promise.resolve().then(ask), paced: new Promise((resolve) => setTimeout(resolve, pauseMs)) }));
    free = started.then(({ asked, paced }) => Promise.all([asked.catch(() => {}), paced]));
    return started.then(({ asked }) => asked);
  };
}
