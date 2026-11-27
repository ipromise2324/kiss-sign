import { hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import { canonicalType, namedSignatureOfAbiEntry, paramName, parseFunctionSignature } from '../decode/abi.ts';
import type { AbiParam } from '../decode/abi.ts';
import { decodeValues } from '../decode/codec.ts';
import type { AbiValue } from '../decode/codec.ts';
import type { AbiEntry } from '../contracts/prove.ts';
import { SafeTxParseError, parseAddress, parseHex } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { valueLines } from './decode-tx.ts';
import { inPool } from './pool.ts';
import { PAGE, RANGE_PAGES, ResearchError, anchorEvent, markedEvent } from './sources.ts';
import type { Ask, EventTopic } from './sources.ts';

/** An event: its parameters in order, which of them are indexed, its canonical signature and topic, and where the shape came from. */
export type EventShape = {
  readonly name: string;
  readonly params: readonly AbiParam[];
  readonly indexed: readonly boolean[];
  readonly signature: string;
  readonly topic: Hex;
  readonly from: string;
  /** Set when the shape came from the signature as written, which must then mark each indexed argument. */
  readonly asGiven?: true;
};

/** The event a signature such as `Upgraded(address indexed implementation)` names, its indexed arguments as it marks them. */
export function shapeOfSignature(text: string): EventShape {
  const { name, params } = parseFunctionSignature(text.replace(/\s+indexed\b/g, ''));
  const { signature, topic } = anchorEvent(text);
  // markedEvent writes canonical types with no names, so a parameter it names `indexed` is one marked indexed.
  const indexed = parseFunctionSignature(markedEvent(text)).params.map((p) => p.name === 'indexed');
  return { name, params, indexed, signature, topic, from: 'the signature as given', asGiven: true };
}

/**
 * The proven ABI's event of `signature`'s canonical form, with its parameter names and indexed arguments; undefined when
 * it has none. An anonymous event is refused: its logs carry no signature topic, so no search by the event finds them.
 */
export function shapeOfAbi(abi: readonly AbiEntry[], signature: string, from: string): EventShape | undefined {
  const wanted = anchorEvent(signature).signature;
  const matches = abi.filter((entry) => entry.type === 'event' && anchorEvent(namedSignatureOfAbiEntry(entry)).signature === wanted);
  const entry = matches.find((e) => e.anonymous !== true);
  if (entry === undefined) {
    if (matches.length > 0) throw new ResearchError(`${wanted} is anonymous in the proven ABI: its logs carry no signature topic, so no search by the event finds them`);
    return undefined;
  }
  const { asGiven: _, ...shape } = shapeOfSignature(namedSignatureOfAbiEntry(entry));
  const inputs = entry.inputs as readonly { readonly indexed?: unknown }[];
  return { ...shape, indexed: inputs.map((input) => input.indexed === true), from };
}

/** `shape` written with `indexed` after each indexed argument, as `--event-arg` reads it. */
export const markedSignature = (shape: EventShape): string =>
  `${shape.name}(${shape.params.map((p, i) => `${canonicalType(p.type)}${shape.indexed[i] === true ? ' indexed' : ''}`).join(',')})`;

export type EventsQuery = {
  readonly address: Address;
  readonly shape: EventShape;
  /** At most one per topic index. */
  readonly topics: readonly EventTopic[];
  readonly range: { readonly fromBlock: bigint; readonly toBlock: bigint };
  readonly maxPages: number;
  readonly maxLogs: number;
};

/** A log as Etherscan lists it. */
export type ListedLog = {
  readonly emitter: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly block: bigint;
  readonly blockHash: Hex | undefined;
  readonly logIndex: bigint | undefined;
  readonly hash: Hex;
  readonly removed: boolean;
};

/** A log shown: confirmed by the receipt both providers agree on, whose block it then prints, or why not. */
export type ShownLog = ListedLog & ({ readonly kind: 'confirmed'; readonly receiptBlock: bigint } | { readonly kind: 'unconfirmed'; readonly why: string });

/**
 * What the search read: every log of blocks `readFrom` to the range's last, or none when `readFrom` is undefined, and
 * `stopped` says why it did not reach the range's first block.
 */
export type EventsSearch = { readonly readFrom: bigint | undefined; readonly pages: number; readonly stopped: string | undefined; readonly listed: number; readonly strays: number };

/** The search, the newest logs it found, oldest first and cut only between blocks, and how many older ones are not shown. */
export type EventsRun = { readonly query: EventsQuery; readonly search: EventsSearch; readonly logs: readonly ShownLog[]; readonly older: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Etherscan writes a zero quantity as `0x`. */
const quantity = (field: string, raw: unknown): bigint => {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]*$/.test(raw)) throw new SafeTxParseError(field, 'not a hex quantity');
  return raw === '0x' ? 0n : BigInt(raw);
};

function listedLog(raw: unknown): ListedLog {
  try {
    if (!isRecord(raw) || !Array.isArray(raw.topics)) throw new SafeTxParseError('log', 'not a log');
    return {
      emitter: parseAddress('address', raw.address),
      topics: raw.topics.map((topic) => parseHex('topic', topic)),
      data: parseHex('data', raw.data),
      block: quantity('blockNumber', raw.blockNumber),
      blockHash: raw.blockHash === undefined ? undefined : parseHex('blockHash', raw.blockHash),
      logIndex: raw.logIndex === undefined ? undefined : quantity('logIndex', raw.logIndex),
      hash: parseHex('transactionHash', raw.transactionHash),
      removed: raw.removed === true,
    };
  } catch (error) {
    if (error instanceof SafeTxParseError) throw new ResearchError(`etherscan sent a malformed log (${error.message})`);
    throw error;
  }
}

/**
 * One block range's logs, ascending: `complete` at an empty page; `overflow` when `RANGE_PAGES` pages, all Etherscan
 * lists of one range, held logs, with the last block listed; `cap` when `allowed` pages ran out first.
 */
type Listing = { readonly kind: 'complete'; readonly logs: ListedLog[]; readonly pages: number } | { readonly kind: 'overflow' | 'cap'; readonly reached: bigint | undefined; readonly pages: number };

async function listRange(filter: Readonly<Record<string, string>>, fromBlock: bigint, toBlock: bigint, allowed: number, ask: Ask): Promise<Listing> {
  const logs: ListedLog[] = [];
  const pages = Math.min(RANGE_PAGES, allowed);
  for (let page = 1; page <= pages; page++) {
    const answer = await ask({ source: 'etherscan', query: { chainid: '1', module: 'logs', action: 'getLogs', ...filter, fromBlock: String(fromBlock), toBlock: String(toBlock), offset: String(PAGE), page: String(page) } }, 'empty');
    if (!isRecord(answer)) throw new ResearchError('etherscan sent no answer');
    if (answer.status === '0' && answer.message === 'No records found') return { kind: 'complete', logs, pages: page };
    if (answer.status === '0' && /time-?out/i.test(`${String(answer.message)} ${String(answer.result)}`)) return { kind: 'overflow', reached: logs.at(-1)?.block, pages: page };
    if (answer.status !== '1' || !Array.isArray(answer.result)) throw new ResearchError(`etherscan refused: ${String(answer.message).slice(0, 80)} ${typeof answer.result === 'string' ? answer.result.slice(0, 120) : ''}`.trim());
    if (answer.result.length === 0) return { kind: 'complete', logs, pages: page };
    logs.push(...answer.result.map(listedLog));
  }
  return { kind: pages === RANGE_PAGES ? 'overflow' : 'cap', reached: logs.at(-1)?.block, pages };
}

/**
 * Every log of the filter, newest block range first, each range listed to its empty last page. A range that holds more
 * than Etherscan lists is asked again as two, the newer one sized from how far the listing reached; the search stops at
 * one block that holds more, or when `maxPages` pages are taken.
 */
async function searchLogs(filter: Readonly<Record<string, string>>, range: EventsQuery['range'], maxPages: number, ask: Ask): Promise<{ readonly logs: ListedLog[]; readonly pages: number; readonly readFrom: bigint | undefined; readonly stopped: string | undefined }> {
  const logs: ListedLog[] = [];
  const pending = [range];
  let pages = 0;
  let readFrom: bigint | undefined;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (pages >= maxPages) return { logs, pages, readFrom, stopped: `the cap of ${maxPages} pages` };
    const listed = await listRange(filter, next.fromBlock, next.toBlock, maxPages - pages, ask);
    pages += listed.pages;
    if (listed.kind === 'complete') {
      logs.push(...listed.logs);
      readFrom = next.fromBlock;
      continue;
    }
    if (listed.kind === 'cap') return { logs, pages, readFrom, stopped: `the cap of ${maxPages} pages` };
    if (next.fromBlock === next.toBlock) return { logs, pages, readFrom, stopped: `block ${next.fromBlock}, which holds more logs than Etherscan lists for one range (${RANGE_PAGES} pages of ${PAGE})` };
    const blocks = next.toBlock - next.fromBlock + 1n;
    const reached = listed.reached === undefined ? blocks / 2n : listed.reached - next.fromBlock + 1n;
    const span = reached < 2n ? 1n : reached / 2n < blocks ? reached / 2n : blocks / 2n;
    pending.push({ fromBlock: next.fromBlock, toBlock: next.toBlock - span }, { fromBlock: next.toBlock - span + 1n, toBlock: next.toBlock });
  }
  return { logs, pages, readFrom, stopped: undefined };
}

/** Whether a log Etherscan listed is one the filter asks for: the contract, a block in the range, the event's topic and each indexed value. */
const fits = (log: ListedLog, query: EventsQuery): boolean =>
  log.emitter === query.address.toLowerCase() &&
  log.block >= query.range.fromBlock &&
  log.block <= query.range.toBlock &&
  log.topics.every((topic) => topic.length === 66) &&
  log.topics[0] === query.shape.topic.toLowerCase() &&
  query.topics.every((t) => log.topics[t.index] === t.word.toLowerCase());

const order = (a: ListedLog, b: ListedLog): number =>
  a.block !== b.block ? (a.block < b.block ? -1 : 1) : (a.logIndex ?? 0n) === (b.logIndex ?? 0n) ? 0 : (a.logIndex ?? 0n) < (b.logIndex ?? 0n) ? -1 : 1;

/** The newest `max` logs of ascending `logs`, and every other log of the oldest block among them, so no block is cut. */
function newestWholeBlocks(logs: readonly ListedLog[], max: number): ListedLog[] {
  if (logs.length <= max) return [...logs];
  const oldest = (logs[logs.length - max] as ListedLog).block;
  return logs.filter((log) => log.block >= oldest);
}

/** Whether the receipt both providers agree on holds the log: the same transaction, block, log index, contract, topics and data. */
async function confirm(log: ListedLog, reader: Reader): Promise<ShownLog> {
  const unconfirmed = (why: string): ShownLog => ({ ...log, kind: 'unconfirmed', why });
  if (log.removed) return unconfirmed('Etherscan marks it removed');
  if (log.logIndex === undefined) return unconfirmed('Etherscan gave no log index to find it by');
  const read = await reader.getTransactionReceipt(log.hash);
  if (read.kind === 'unverifiable') return unconfirmed(`the providers gave no agreed receipt: ${read.reason}`);
  const receipt = read.value;
  if (receipt === null) return unconfirmed('the providers know no such transaction');
  if (receipt.transactionHash.toLowerCase() !== log.hash || receipt.blockNumber !== log.block) return unconfirmed(`the agreed receipt is of block ${receipt.blockNumber}`);
  if (log.blockHash !== undefined && receipt.blockHash.toLowerCase() !== log.blockHash) return unconfirmed(`the agreed receipt's block hash is ${receipt.blockHash}`);
  const held = receipt.logs.find((l) => l.logIndex === log.logIndex);
  const same =
    held !== undefined &&
    held.address.toLowerCase() === log.emitter &&
    held.data.toLowerCase() === log.data &&
    held.topics.length === log.topics.length &&
    held.topics.every((topic, i) => topic.toLowerCase() === log.topics[i]);
  return same ? { ...log, kind: 'confirmed', receiptBlock: receipt.blockNumber } : unconfirmed(`the agreed receipt holds no such log at index ${log.logIndex}`);
}

/**
 * The event's logs by `address` in the range, listed from Etherscan's logs newest range first; each log shown is then
 * looked for in its transaction's receipt, which Alchemy and drpc must agree on.
 */
export async function readEvents(query: EventsQuery, deps: { readonly ask: Ask; readonly reader: Reader }): Promise<EventsRun> {
  const indices = query.topics.map((t) => t.index);
  if (new Set(indices).size !== indices.length) throw new ResearchError('two filters on one indexed argument');
  const filter: Record<string, string> = { address: query.address, topic0: query.shape.topic };
  for (const { index, word } of query.topics) Object.assign(filter, { [`topic0_${index}_opr`]: 'and', [`topic${index}`]: word });
  for (const i of indices) for (const j of indices) if (i < j) filter[`topic${i}_${j}_opr`] = 'and';
  const found = await searchLogs(filter, query.range, query.maxPages, deps.ask);
  const kept = found.logs.filter((log) => fits(log, query)).toSorted(order);
  const shown = newestWholeBlocks(kept, query.maxLogs);
  return {
    query,
    search: { readFrom: found.readFrom, pages: found.pages, stopped: found.stopped, listed: found.logs.length, strays: found.logs.length - kept.length },
    logs: await inPool(shown, 8, (log) => confirm(log, deps.reader)),
    older: kept.length - shown.length,
  };
}

const VALUE_KINDS = new Set(['address', 'uint', 'int', 'bool', 'fixed-bytes']);

function logLines(shape: EventShape, log: ListedLog, names: (address: Address) => string | undefined, full: boolean): string[] {
  const raw = [`  topics: ${log.topics.join(' ')}`, `  data: ${log.data}`];
  const indexed = shape.params.filter((_, i) => shape.indexed[i] === true);
  const hint = shape.asGiven === true ? '; mark each indexed argument in --event' : '';
  if (log.topics.length - 1 !== indexed.length) return [`  does not decode: ${log.topics.length - 1} topics after the event's, for ${indexed.length} indexed arguments${hint}`, ...raw];
  const rest = shape.params.filter((_, i) => shape.indexed[i] !== true);
  const data = decodeValues(rest.map((p) => p.type), hexToBytes(log.data.slice(2)));
  if (data === undefined) return [`  its data does not decode as (${rest.map((p) => canonicalType(p.type)).join(',')})${hint}`, ...raw];
  let topic = 1;
  let word = 0;
  return shape.params.flatMap((param, i) => {
    const label = paramName(param, i);
    if (shape.indexed[i] !== true) return valueLines(1, label, param.type, data[word++] as AbiValue, names, full);
    const hash = log.topics[topic++] as Hex;
    const type = canonicalType(param.type);
    if (!VALUE_KINDS.has(param.type.kind)) return [`  ${label}: ${hash} (an indexed ${type} logs only the keccak256 of its value)`];
    const value = decodeValues([param.type], hexToBytes(hash.slice(2)))?.[0];
    return value === undefined ? [`  ${label}: ${hash}, which does not decode as ${type}`] : valueLines(1, label, param.type, value, names, full);
  });
}

export const NO_PROOF_OF_ABSENCE = 'ORIENTATION ONLY: logs as Etherscan lists them; a log it left out is not shown, so no log here proves none happened.';

/** What `pnpm events` prints: the search, each log shown with its block, transaction and decoded arguments, and the orientation footer. */
export function renderEvents(run: EventsRun, names: (address: Address) => string | undefined, full: boolean): string {
  const { query, search } = run;
  const name = names(query.address);
  const out = [
    `${markedSignature(query.shape)} logged by ${query.address}${name === undefined ? '' : ` (registry: ${name})`}`,
    `event shape: ${query.shape.from}`,
    ...query.topics.map((t) => `only logs whose topic ${t.index} is ${t.word}`),
    `searched Etherscan's logs from block ${query.range.fromBlock} to ${query.range.toBlock}: ${search.listed} logs in ${search.pages} pages`,
  ];
  if (search.stopped !== undefined) {
    const reached = search.readFrom === undefined ? 'no block was read whole' : `only blocks ${search.readFrom} to ${query.range.toBlock} were read`;
    out.push(`STOPPED at ${search.stopped}: ${reached}; narrow it with --from-block and --to-block`);
  }
  if (search.strays > 0) out.push(`${search.strays} logs Etherscan listed are not of this contract, range, event or filter; left out`);
  const oldest = run.logs[0];
  if (run.older > 0 && oldest !== undefined) out.push(`showing the newest ${run.logs.length}, oldest first, whole blocks; ${run.older} older not shown: raise --max-logs, or pass --to-block ${oldest.block - 1n}`);
  for (const log of run.logs) {
    out.push(log.kind === 'confirmed' ? `block ${log.receiptBlock}  tx ${log.hash}` : `block ${log.block} (as Etherscan lists it)  tx ${log.hash}  NOT CONFIRMED: ${log.why}`);
    out.push(...logLines(query.shape, log, names, full));
  }
  out.push(NO_PROOF_OF_ABSENCE);
  return `${out.join('\n')}\n`;
}
