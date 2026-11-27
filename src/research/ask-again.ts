import { RETRY_PAUSES_MS } from '../chain/https.ts';
import type { Read, Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';

export class BlockReplacedError extends Error {
  override name = 'BlockReplacedError';
}

/**
 * Throws when a block the run reads at is no longer the chain's block at its number, so one run never holds two blocks.
 * A read that is not both providers naming the same hash confirms nothing: it is asked again after each pause, then refused.
 */
async function requireSameBlocks(reader: Pick<Reader, 'block'>, blocks: readonly BlockRef[], pausesMs: readonly number[]): Promise<void> {
  for (const block of blocks) {
    for (let tries = 0; ; tries++) {
      const now: Read<BlockRef> = await reader.block(block.number);
      if (now.kind === 'agreed' && now.value.hash === block.hash) break;
      if (now.kind === 'agreed') throw new BlockReplacedError(`block ${block.number} was replaced while the run read it; run the command again`);
      const pause = pausesMs[tries];
      if (pause === undefined) throw new BlockReplacedError(`block ${block.number} could not be confirmed as the one the run read (${now.reason}); run the command again`);
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}

/**
 * Runs `section` again after each pause while a read of it got no answer, forgetting what `unread` held of the run
 * before. `blocks` are the blocks the section reads at, and only those must still be the chain's. What was answered is kept by the caller (`kept`), so only the failed reads go out again. `reader` keeps nothing,
 * so the check that the blocks are still there asks the chain.
 */
export async function askAgain<T>(
  unread: string[],
  reader: Pick<Reader, 'block'>,
  blocks: readonly BlockRef[],
  section: () => Promise<T>,
  pausesMs: readonly number[] = RETRY_PAUSES_MS,
  say: (line: string) => void = console.error,
): Promise<T> {
  const before = unread.length;
  for (const pause of pausesMs) {
    try {
      const value = await section();
      if (unread.length === before) return value;
    } catch (error) {
      if (unread.length === before) throw error;
    }
    say(`${unread.length - before} read(s) got no answer; asking those again in ${pause / 1000} s`);
    unread.splice(before);
    await new Promise((resolve) => setTimeout(resolve, pause));
    await requireSameBlocks(reader, blocks, pausesMs);
  }
  return section();
}
