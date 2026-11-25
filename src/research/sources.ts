import { request } from 'node:https';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { parseFunctionSignature } from '../decode/abi.ts';
import { fallbackLookup } from '../chain/dns.ts';
import { requestText, retried, transientStatus } from '../chain/https.ts';
import type { NoteUnread } from '../chain/https.ts';
import { MissingKeyError, mainnetEndpoints } from '../chain/providers.ts';
import { httpsTransport } from '../chain/rpc.ts';
import type { Transport } from '../chain/rpc.ts';
import { findKey, keySpec } from '../keys.ts';
import type { Env, KeySpec } from '../keys.ts';
import { TRANSFER } from '../simulate/events.ts';
import { SafeTxParseError, parseAddress, parseHex } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';

/**
 * Which log of `token` marks a transaction of the operation: an ERC-20 `Transfer`, `mint` (from the zero address, such
 * as vault shares on a deposit), `burn` (to the zero address, such as shares on a withdrawal) or `any` (a plain
 * transfer), or with `event` another event the contract `token` names logs, such as CoW's `PreSignature`, or any
 * contract logs when `token` is absent, such as a Safe's own `AddedOwner`.
 */
export type AnchorKind = 'mint' | 'burn' | 'any' | 'event';
export const ANCHOR_KINDS: readonly AnchorKind[] = ['mint', 'burn', 'any', 'event'];

/** An event by its canonical signature, such as `PreSignature(address,bytes,bool)`, and the topic it logs under. */
export type AnchorEvent = { readonly signature: string; readonly topic: Hex };

/**
 * With `any`, `from` keeps only transfers out of that address, such as a rewards distributor paying a claim, and `to`
 * only transfers into one, such as Morpho Blue receiving a market's loan token on a supply.
 */
export type Anchor = {
  /** Absent only with `event`, for an event each Safe logs about itself. */
  readonly token?: Address;
  readonly kind: AnchorKind;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly from?: Address;
  readonly to?: Address;
  /** Present exactly when `kind` is `event`. */
  readonly event?: AnchorEvent;
};

export const SOURCES = ['alchemy', 'etherscan'] as const;
export type SourceName = (typeof SOURCES)[number];

/** The event a signature such as `PreSignature(address indexed owner, bytes orderUid, bool signed)` names; throws on one that does not parse. */
export function anchorEvent(signature: string): AnchorEvent {
  const canonical = parseFunctionSignature(signature.replace(/\s+indexed\b/g, '')).signature;
  return { signature: canonical, topic: `0x${bytesToHex(keccak_256(utf8ToBytes(canonical)))}` as Hex };
}

/**
 * The sources that search an anchor. Only Etherscan searches an event: Alchemy's Transfers API lists only transfers,
 * and its `eth_getLogs` reads at most 10 blocks at a time on the free plan.
 */
export const searchedBy = (anchor: Pick<Anchor, 'kind'>): readonly SourceName[] => (anchor.kind === 'event' ? ['etherscan'] : SOURCES);

/** A request to a search source. It never holds a key, so a recording holds none. */
export type SourceRequest =
  | { readonly source: 'alchemy'; readonly params: Readonly<Record<string, unknown>> }
  | { readonly source: 'etherscan'; readonly query: Readonly<Record<string, string>> };

/** `end`, which the search passes with every Etherscan page, is how it ends that listing; it never changes the answer. */
export type Ask = (request: SourceRequest, end?: EtherscanEnd) => Promise<unknown>;

/**
 * One anchor transfer or log a source reported. `block` is absent in a recording made before it was kept; `emitter`, the
 * contract that logged it, only an Etherscan search of an event by its topic alone keeps.
 */
export type Hit = { readonly hash: Hex; readonly from: Address; readonly to: Address; readonly block?: bigint; readonly emitter?: Address };

export type Hits = Readonly<Record<SourceName, readonly Hit[]>>;

export const PAGE = 1000;

/** The most pages of `PAGE` one range is paged through: Etherscan refuses a page beyond its first 10,000 results. */
export const RANGE_PAGES = 10;

export class ResearchError extends Error {
  override name = 'ResearchError';
}

const ZERO = `0x${'00'.repeat(20)}` as Address;
const ZERO_WORD = `0x${'00'.repeat(32)}`;

const hex = (n: bigint): string => `0x${n.toString(16)}`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function hitOf(source: SourceName, hash: unknown, from: unknown, to: unknown, block: unknown, emitter: unknown): Hit {
  try {
    if (block !== undefined && (typeof block !== 'string' || !/^0x[0-9a-fA-F]+$/.test(block))) throw new SafeTxParseError('block', 'not a hex number');
    return {
      hash: parseHex('hash', hash),
      from: parseAddress('from', from),
      to: parseAddress('to', to),
      ...(block === undefined ? {} : { block: BigInt(block) }),
      ...(emitter === undefined ? {} : { emitter: parseAddress('address', emitter) }),
    };
  } catch (error) {
    if (error instanceof SafeTxParseError) throw new ResearchError(`${source} sent a malformed transfer (${error.message})`);
    throw error;
  }
}

/** `reached`: the block of the last entry the source listed before it stopped, in ascending block order. */
type SourceSearch = { readonly kind: 'complete'; readonly hits: readonly Hit[]; readonly pages: number } | { readonly kind: 'overflow'; readonly reached: bigint | undefined };

const blockOf = (entry: unknown, key: 'blockNum' | 'blockNumber'): bigint | undefined => {
  const raw = isRecord(entry) ? entry[key] : undefined;
  return typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw) ? BigInt(raw) : undefined;
};

async function searchAlchemy(anchor: Anchor, ask: Ask, pages: number): Promise<SourceSearch> {
  if (anchor.token === undefined) throw new ResearchError('alchemy searches the transfers of one token only');
  const base = {
    fromBlock: hex(anchor.fromBlock),
    toBlock: hex(anchor.toBlock),
    contractAddresses: [anchor.token],
    category: ['erc20'],
    excludeZeroValue: false,
    withMetadata: false,
    order: 'asc',
    maxCount: hex(BigInt(PAGE)),
    ...(anchor.kind === 'mint' ? { fromAddress: ZERO } : {}),
    ...(anchor.kind === 'burn' ? { toAddress: ZERO } : {}),
    ...(anchor.from !== undefined ? { fromAddress: anchor.from } : {}),
    ...(anchor.to !== undefined ? { toAddress: anchor.to } : {}),
  };
  const transfers: unknown[] = [];
  let pageKey: string | undefined;
  for (let page = 1; page <= pages; page++) {
    const answer = await ask({ source: 'alchemy', params: pageKey === undefined ? base : { ...base, pageKey } });
    if (!isRecord(answer) || !Array.isArray(answer.transfers)) throw new ResearchError('alchemy sent no transfer list');
    transfers.push(...(answer.transfers as unknown[]));
    if (typeof answer.pageKey === 'string') {
      pageKey = answer.pageKey;
      continue;
    }
    const hits = transfers.map((t) => {
      if (!isRecord(t)) throw new ResearchError('alchemy sent a malformed transfer');
      return hitOf('alchemy', t.hash, t.from, t.to, t.blockNum, undefined);
    });
    return { kind: 'complete', hits, pages: page };
  }
  return { kind: 'overflow', reached: blockOf(transfers.at(-1), 'blockNum') };
}

/**
 * When Etherscan has finished a range: `empty`, at the first page that lists nothing, since a page in the middle of a
 * listing can hold fewer than `PAGE`; `short`, legacy until every summary is recorded again, at the first page holding
 * fewer than `PAGE`, as the recordings made before the newest-first search were.
 */
export type EtherscanEnd = 'empty' | 'short';

async function searchEtherscan(anchor: Anchor, ask: Ask, pages: number, end: EtherscanEnd): Promise<SourceSearch> {
  const base: Record<string, string> = {
    chainid: '1',
    module: 'logs',
    action: 'getLogs',
    ...(anchor.token === undefined ? {} : { address: anchor.token }),
    fromBlock: anchor.fromBlock.toString(),
    toBlock: anchor.toBlock.toString(),
    topic0: anchor.event?.topic ?? TRANSFER,
    ...(anchor.kind === 'mint' ? { topic0_1_opr: 'and', topic1: ZERO_WORD } : {}),
    ...(anchor.kind === 'burn' ? { topic0_2_opr: 'and', topic2: ZERO_WORD } : {}),
    ...(anchor.from !== undefined ? { topic0_1_opr: 'and', topic1: `0x${'00'.repeat(12)}${anchor.from.slice(2)}` } : {}),
    ...(anchor.to !== undefined ? { topic0_2_opr: 'and', topic2: `0x${'00'.repeat(12)}${anchor.to.slice(2)}` } : {}),
    ...(anchor.from !== undefined && anchor.to !== undefined ? { topic1_2_opr: 'and' } : {}),
    offset: String(PAGE),
  };
  const logs: unknown[] = [];
  const complete = (pages: number): SourceSearch => {
    const hits = logs.map((log) => {
      if (!isRecord(log) || !Array.isArray(log.topics)) throw new ResearchError('etherscan sent a malformed log');
      const [, from, to] = log.topics as unknown[];
      const address = (word: unknown) => (typeof word === 'string' ? `0x${word.slice(-40)}` : word === undefined ? ZERO : word);
      return hitOf('etherscan', log.transactionHash, address(from), address(to), log.blockNumber, anchor.token === undefined ? log.address : undefined);
    });
    return { kind: 'complete', hits, pages };
  };
  for (let page = 1; page <= pages; page++) {
    const answer = await ask({ source: 'etherscan', query: { ...base, page: String(page) } }, end);
    if (!isRecord(answer)) throw new ResearchError('etherscan sent no answer');
    if (answer.status === '0' && answer.message === 'No records found') return complete(page);
    if (answer.status !== '1' || !Array.isArray(answer.result)) {
      throw new ResearchError(`etherscan refused: ${String(answer.message).slice(0, 80)} ${typeof answer.result === 'string' ? answer.result.slice(0, 120) : ''}`.trim());
    }
    logs.push(...(answer.result as unknown[]));
    if (end === 'empty' ? answer.result.length === 0 : answer.result.length < PAGE) return complete(page);
  }
  return { kind: 'overflow', reached: blockOf(logs.at(-1), 'blockNumber') };
}

/**
 * Every source that searches the anchor, each paged on its own up to `pages` pages: `covered` when each finished within
 * them, with the pages each asked; otherwise the sources that did not, and the lowest block one of them listed last.
 * Either source failing stops the search, since one source is no cross-check, unless the other overflowed: the range is
 * then not read at all.
 */
export type Search =
  | { readonly kind: 'covered'; readonly hits: Hits; readonly pages: ReadonlyMap<SourceName, number> }
  | { readonly kind: 'overflow'; readonly sources: readonly SourceName[]; readonly reached: bigint | undefined };

export async function search(anchor: Anchor, ask: Ask, pages: number, end: EtherscanEnd): Promise<Search> {
  const sources = searchedBy(anchor);
  const settled = await Promise.allSettled(sources.map((source) => (source === 'alchemy' ? searchAlchemy(anchor, ask, pages) : searchEtherscan(anchor, ask, pages, end))));
  const overflowed = settled.flatMap((one, i) => (one.status === 'fulfilled' && one.value.kind === 'overflow' ? [{ source: sources[i] as SourceName, reached: one.value.reached }] : []));
  if (overflowed.length > 0) {
    const reached = overflowed.map((o) => o.reached).reduce((low, b) => (low === undefined || b === undefined ? undefined : b < low ? b : low));
    return { kind: 'overflow', sources: overflowed.map((o) => o.source), reached };
  }
  const searches = settled.map((one) => {
    if (one.status === 'rejected') throw one.reason;
    return one.value;
  });
  const complete = (source: SourceName) => {
    const found = searches[sources.indexOf(source)];
    return found?.kind === 'complete' ? found : undefined;
  };
  return {
    kind: 'covered',
    hits: { alchemy: complete('alchemy')?.hits ?? [], etherscan: complete('etherscan')?.hits ?? [] },
    pages: new Map(sources.map((source) => [source, complete(source)?.pages ?? 0])),
  };
}

export type SourceExchange = { readonly request: SourceRequest; readonly answer: unknown };

function readFields(request: SourceRequest, answer: unknown): unknown {
  if (!isRecord(answer)) return answer;
  if (request.source === 'alchemy') {
    if (!Array.isArray(answer.transfers)) return answer;
    const { transfers, pageKey } = answer;
    return {
      transfers: transfers.map((t: unknown) => (isRecord(t) ? { hash: t.hash, from: t.from, to: t.to, blockNum: t.blockNum } : t)),
      ...(typeof pageKey === 'string' ? { pageKey } : {}),
    };
  }
  if (answer.status !== '1' || !Array.isArray(answer.result)) return answer;
  const { status, message, result } = answer;
  const emitter = request.query.address === undefined;
  return {
    status,
    message,
    result: result.map((log: unknown) =>
      isRecord(log) ? { transactionHash: log.transactionHash, topics: log.topics, blockNumber: log.blockNumber, ...(emitter ? { address: log.address } : {}) } : log,
    ),
  };
}

const rangeOf = (request: SourceRequest): string =>
  request.source === 'alchemy' ? `${BigInt(String(request.params.fromBlock))}:${BigInt(String(request.params.toBlock))}` : `${request.query.fromBlock}:${request.query.toBlock}`;

/** An exchange as the search asked it, with how it ended the Etherscan listing the page belongs to. */
type Asked = SourceExchange & { readonly end: EtherscanEnd | undefined };

const morePages = ({ answer, end }: Asked): boolean =>
  isRecord(answer) && (typeof answer.pageKey === 'string' || (Array.isArray(answer.result) && (end === 'empty' ? answer.result.length > 0 : answer.result.length >= PAGE)));

function unfinished(exchange: Asked, all: readonly SourceExchange[]): boolean {
  const { request, answer } = exchange;
  if (!morePages(exchange)) return false;
  const range = rangeOf(request);
  return !all.some(({ request: next }) => {
    if (next.source !== request.source || rangeOf(next) !== range) return false;
    if (next.source === 'alchemy') return next.params.pageKey === (answer as { pageKey?: unknown }).pageKey;
    return request.source === 'etherscan' && Number(next.query.page) === Number(request.query.page) + 1;
  });
}

function cutUncovered(exchanges: readonly Asked[]): SourceExchange[] {
  const over = exchanges.filter((e) => unfinished(e, exchanges)).map((e) => e.request);
  const uncovered = new Set(over.map(rangeOf));
  const overflowed = new Set(over.map((request) => `${request.source} ${rangeOf(request)}`));
  return exchanges.map(({ request, answer }) => {
    if (!uncovered.has(rangeOf(request)) || !isRecord(answer)) return { request, answer };
    const finished = !overflowed.has(`${request.source} ${rangeOf(request)}`);
    const { pageKey, status, message, result } = answer;
    if (request.source === 'alchemy') {
      if (!Array.isArray(answer.transfers)) return { request, answer };
      const last = finished || !isRecord(answer.transfers.at(-1)) ? [] : [{ blockNum: (answer.transfers.at(-1) as Record<string, unknown>).blockNum }];
      return { request, answer: { transfers: last, ...(!finished && typeof pageKey === 'string' ? { pageKey } : {}) } };
    }
    if (!Array.isArray(result)) return { request, answer };
    const kept = (log: unknown, i: number) => (i === result.length - 1 && isRecord(log) ? { blockNumber: log.blockNumber } : {});
    return { request, answer: { status, message, result: finished ? [] : result.map(kept) } };
  });
}

/** Passes every request through and keeps each answer, cut to what the search reads. */
export function recordingAsk(inner: Ask): { ask: Ask; exchanges: () => SourceExchange[] } {
  const exchanges: Asked[] = [];
  return {
    ask: async (req, end) => {
      const answer = await inner(req, end);
      exchanges.push({ request: req, answer: readFields(req, answer), end });
      return answer;
    },
    exchanges: () => cutUncovered(exchanges),
  };
}

export function replayAsk(exchanges: readonly SourceExchange[]): Ask {
  return async (req) => {
    const found = exchanges.find((e) => JSON.stringify(e.request) === JSON.stringify(req));
    if (found === undefined) throw new ResearchError(`${req.source}: request not recorded`);
    return found.answer;
  };
}

function requiredKey(name: 'alchemy' | 'etherscan', env: Env): string {
  const spec = keySpec(name) as KeySpec;
  const key = findKey(spec, env)?.value;
  if (key === undefined) throw new MissingKeyError(spec);
  return key;
}

/** How many pages of an Etherscan listing are asked past a full one before the search reaches them. */
const PAGES_AHEAD = 4;

type EtherscanQuery = Extract<SourceRequest, { source: 'etherscan' }>['query'];

/** An Etherscan request, spaced and asked again as `liveAsk` does, with the reads that never got an answer noted to `note`. */
type SendEtherscan = (query: EtherscanQuery, note: NoteUnread) => Promise<unknown>;

/**
 * Asks Etherscan for a listing's next pages as soon as a page comes back full, since a listing the search ends by its
 * first empty page is asked page by page. A page asked ahead and never reached is dropped, answered or not, so what the
 * search asked and what it noted are the same as one page after the other.
 */
function pagesAhead(send: SendEtherscan, note: NoteUnread): (query: EtherscanQuery, end: EtherscanEnd | undefined) => Promise<unknown> {
  type Asked = { readonly answer: Promise<unknown>; readonly unread: readonly string[] };
  const early = new Map<string, Asked>();
  const ask = (query: EtherscanQuery): Asked => {
    const unread: string[] = [];
    return { answer: send(query, (read) => void unread.push(read)), unread };
  };
  const askAhead = (query: EtherscanQuery) => {
    const last = Math.min(Number(query.page) + PAGES_AHEAD, RANGE_PAGES);
    for (let page = Number(query.page) + 1; page <= last; page++) {
      const next = { ...query, page: String(page) };
      if (early.has(JSON.stringify(next))) continue;
      const asked = ask(next);
      asked.answer.catch(() => undefined);
      early.set(JSON.stringify(next), asked);
    }
  };
  return async (query, end) => {
    const asked = early.get(JSON.stringify(query)) ?? ask(query);
    early.delete(JSON.stringify(query));
    try {
      const answer = await asked.answer;
      if (end === 'empty' && isRecord(answer) && Array.isArray(answer.result) && answer.result.length >= PAGE) askAhead(query);
      return answer;
    } finally {
      asked.unread.forEach(note);
    }
  };
}

/**
 * The live sources, with keys from the environment or `$KISS_SIGN_HOME/.env`. A failure names the source only, never a
 * URL, since both URLs carry a key.
 */
export function liveAsk(env: Env, note: NoteUnread, transport: Transport = httpsTransport()): Ask {
  const alchemyUrl = mainnetEndpoints(env)[0].url;
  const etherscanKey = requiredKey('etherscan', env);
  const lookup = fallbackLookup();
  let nextEtherscan = 0;
  const etherscan = pagesAhead(sendEtherscan, note);
  return async (req, end) => {
    if (req.source === 'alchemy') {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [req.params] });
      let answer;
      try {
        answer = await retried('alchemy alchemy_getAssetTransfers', () => transport(alchemyUrl, body, AbortSignal.timeout(30_000)), (a) => transientStatus(a), note);
      } catch {
        throw new ResearchError('alchemy unreachable');
      }
      if (answer.status !== 200) throw new ResearchError(`alchemy answered HTTP ${answer.status}`);
      const parsed = JSON.parse(answer.text) as { result?: unknown; error?: { message?: unknown } };
      if (parsed.error !== undefined) throw new ResearchError(`alchemy refused: ${String(parsed.error.message).slice(0, 120)}`);
      return parsed.result;
    }
    return etherscan(req.query, end);
  };

  async function sendEtherscan(query: EtherscanQuery, unread: NoteUnread): Promise<unknown> {
    // The free Etherscan plan allows a few requests a second.
    for (let tries = 0; ; tries++) {
      const at = Math.max(Date.now(), nextEtherscan);
      nextEtherscan = at + 400;
      if (at > Date.now()) await new Promise((resolve) => setTimeout(resolve, at - Date.now()));
      const path = `/v2/api?${new URLSearchParams({ ...query, apikey: etherscanKey })}`;
      let answer;
      try {
        answer = await retried(
          'etherscan getLogs',
          () =>
            requestText(
              request,
              { method: 'GET', hostname: 'api.etherscan.io', path, servername: 'api.etherscan.io', rejectUnauthorized: true, lookup, signal: AbortSignal.timeout(30_000) },
              undefined,
              16 * 1024 * 1024,
            ),
          (a) => transientStatus(a),
          unread,
        );
      } catch {
        throw new ResearchError('etherscan unreachable');
      }
      if (answer.status !== 200) throw new ResearchError(`etherscan answered HTTP ${answer.status}`);
      const parsed = JSON.parse(answer.text) as Record<string, unknown>;
      if (parsed.status === '0' && /rate limit/i.test(String(parsed.result)) && tries < 3) continue;
      return parsed;
    }
  }
}
