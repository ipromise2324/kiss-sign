/**
 * Replays each item on its own: one that throws is kept with its message, so a test over every report fails only for
 * the reports that refuse, such as those reading one stale past-txs summary, and the rest are still checked.
 */
export async function replayEach<K, V>(items: Iterable<K>, replay: (item: K) => Promise<V>): Promise<{ readonly done: Map<K, V>; readonly refused: Map<K, string> }> {
  const done = new Map<K, V>();
  const refused = new Map<K, string>();
  for (const item of items) {
    try {
      done.set(item, await replay(item));
    } catch (error) {
      refused.set(item, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  }
  return { done, refused };
}
