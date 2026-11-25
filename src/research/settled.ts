import type { Read, Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';

/** How far behind the head a long run reads: a block this deep is not replaced while the run reads it by its hash. */
export const SETTLED_DEPTH = 8n;

/** The block `SETTLED_DEPTH` behind the head both providers are at. */
export async function settledBlock(reader: Reader): Promise<Read<BlockRef>> {
  const head = await reader.blockNumber();
  return head.kind === 'unverifiable' ? head : reader.block(head.value - SETTLED_DEPTH);
}
