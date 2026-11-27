import type { Exchange } from '../src/chain/recording.ts';

type Tx = { readonly blockNumber?: string | null; readonly blockHash?: string | null };

/** A recording's exchanges with the block of each transaction it holds, which recordings made before the study read every block's time lack. */
export function withBlockTimes(exchanges: readonly Exchange[]): Exchange[] {
  const held = new Set(exchanges.map((e) => `${e.method} ${JSON.stringify(e.params)}`));
  const blocks = new Map(
    exchanges.flatMap((e) => (e.method === 'eth_getTransactionByHash' ? (Object.values(e.answers) as (Tx | null)[]) : [])).flatMap((tx) => (tx?.blockNumber && tx.blockHash ? [[tx.blockNumber, tx.blockHash] as const] : [])),
  );
  const added = [...blocks].flatMap(([number, hash]): Exchange[] => {
    const block = { number, hash, timestamp: '0x65000000', gasLimit: '0x1c9c380', mixHash: `0x${'00'.repeat(32)}` };
    const answers = { alchemy: block, drpc: block };
    return [
      { method: 'eth_getBlockByNumber', params: [number, false], answers },
      { method: 'eth_getBlockByHash', params: [hash, false], answers },
    ];
  });
  return [...exchanges, ...added.filter((e) => !held.has(`${e.method} ${JSON.stringify(e.params)}`))];
}
