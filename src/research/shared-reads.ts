import type { Read, Reader } from '../chain/reader.ts';

/**
 * `reader`, asking for a transaction, a receipt, or anything at a block named by its number or hash once: every later
 * or concurrent request for it shares the answer both providers agreed on. A read they did not agree on is asked again
 * the next time, and the latest block always is.
 */
export function sharedReads(reader: Reader): Reader {
  const kept = new Map<string, Promise<Read<unknown>>>();
  const once = <T>(key: string, read: () => Promise<Read<T>>): Promise<Read<T>> => {
    const known = kept.get(key);
    if (known !== undefined) return known as Promise<Read<T>>;
    const asked = read();
    kept.set(key, asked);
    const forget = () => void kept.delete(key);
    asked.then((answer) => (answer.kind === 'unverifiable' ? forget() : undefined), forget);
    return asked;
  };
  return {
    ...reader,
    block: (tag) => (tag === 'latest' ? reader.block(tag) : once(`block ${tag}`, () => reader.block(tag))),
    header: (at) => once(`header ${at.hash}`, () => reader.header(at)),
    getCode: (address, at) => once(`code ${address} ${at.hash}`, () => reader.getCode(address, at)),
    getStorageAt: (address, slot, at) => once(`storage ${address} ${slot} ${at.hash}`, () => reader.getStorageAt(address, slot, at)),
    getTransactionReceipt: (hash) => once(`receipt ${hash}`, () => reader.getTransactionReceipt(hash)),
    getTransaction: (hash) => once(`transaction ${hash}`, () => reader.getTransaction(hash)),
  };
}
