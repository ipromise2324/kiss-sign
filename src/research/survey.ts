import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Read, Reader } from '../chain/reader.ts';
import type { BlockRef, Transaction } from '../chain/types.ts';
import { parseFunctionSignature } from '../decode/abi.ts';
import { decodeCall, regionBytes, wholeRegion } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import { EXECUTION_SUCCESS, TRANSFER, addressOf, wordOf } from '../simulate/events.ts';
import { SafeTxParseError, parseAddress, parseHex } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { YEAR, searchTop } from './past-txs.ts';
import { inPool } from './pool.ts';
import { proveParties } from './safe-parties.ts';
import { sharedReads } from './shared-reads.ts';
import { PAGE, RANGE_PAGES, ResearchError } from './sources.ts';
import type { AnchorEvent, Ask } from './sources.ts';

/** One kind of log the survey searches: `filter` is the `getLogs` filter, `label` says what it finds. */
export type LogQuery = { readonly label: string; readonly filter: Readonly<Record<string, string>>; readonly firstSpan: bigint };

export type SurveyTarget =
  /** Calls reaching a contract, found by its own logs (one query per event when its events are known) and by logs that name it in a topic. */
  | { readonly kind: 'contracts'; readonly contracts: readonly { readonly address: Address; readonly events: readonly AnchorEvent[] }[] }
  /** An event each of `contracts` logs; with none, one the Safe logs itself. */
  | { readonly kind: 'event'; readonly event: AnchorEvent; readonly contracts: readonly Address[] }
  /** Transfers of each of `tokens`, one search each, kept where the Safe's call names one of `contracts`; with none, all. */
  | { readonly kind: 'transfers'; readonly tokens: readonly Address[]; readonly from?: Address; readonly to?: Address; readonly contracts: readonly Address[] };

/** What a query read: complete from `fromBlock` to the search's last block, or nothing when `fromBlock` is undefined. `stopped` says why it ends there, absent when it reached the first block asked. */
export type QueryRun = { readonly label: string; readonly fromBlock: bigint | undefined; readonly pages: number; readonly logs: number; readonly stopped?: string };

export type SafeCall = { readonly operation: 0 | 1; readonly to: Address; readonly value: bigint; readonly data: Hex };

/** The calls an executed Safe transaction made: `batch` through an official MultiSend, `raw` when they could not be unwrapped, so the outer call stands alone. */
export type SafeTxCalls = { readonly hash: Hex; readonly block: bigint; readonly safe: Address; readonly wrapped: 'direct' | 'batch' | 'raw'; readonly calls: readonly SafeCall[]; readonly foundBy: ReadonlySet<string> };

export type Survey = {
  readonly target: SurveyTarget;
  readonly range: { readonly fromBlock: bigint; readonly toBlock: bigint };
  readonly queries: readonly QueryRun[];
  /** The search of every Safe's own ExecutionSuccess, which finds a Safe transaction none of whose logs' addresses is a Safe. */
  readonly executions: QueryRun;
  readonly found: number;
  readonly parties: { readonly checked: number; readonly safes: number; readonly unreadable: number };
  /** Transactions a Safe party or an ExecutionSuccess marked, how many of them were read, and the cap on reading. */
  readonly marked: number;
  readonly read: number;
  readonly txs: readonly SafeTxCalls[];
  /** Transactions read that are not studied, by why. */
  readonly leftOut: ReadonlyMap<string, readonly Hex[]>;
};

export type SurveyDeps = {
  readonly ask: Ask;
  readonly reader: Reader;
  readonly batches?: Reader;
  readonly exclude: Address | undefined;
  readonly maxPages: number;
  readonly maxTxs: number;
  readonly blocks: bigint;
  /** Replaces the chain's head block, for a run on recorded answers. */
  readonly head?: bigint;
  /** Told, once the searches are done and before any Safe is checked, of `shortSearch`'s warning when there is one. */
  readonly warn?: (warning: string) => void;
};

/** About one day of blocks, 12 seconds each. */
const DAY_BLOCKS = 7200n;

/**
 * A warning when a search stopped before the blocks it was asked, or read fewer than a day of them: a busy token's
 * transfers alone fill the page cap within minutes, so the Safes found are few and the addresses checked many.
 */
export function shortSearch(target: SurveyTarget, queries: readonly QueryRun[], range: Survey['range']): string | undefined {
  const asked = range.toBlock - range.fromBlock + 1n;
  const short = queries.filter((run) => run.stopped !== undefined || (run.fromBlock !== undefined && range.toBlock - run.fromBlock + 1n < smaller(asked, DAY_BLOCKS)));
  if (short.length === 0) return undefined;
  const reach = (run: QueryRun) => {
    const blocks = run.fromBlock === undefined ? 0n : range.toBlock - run.fromBlock + 1n;
    const minutes = Number((blocks * 12n) / 60n);
    return `${run.label} read ${blocks} of ${asked} blocks, about ${minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`}${run.stopped === undefined ? '' : `, stopped by ${run.stopped}`}`;
  };
  const narrow =
    target.kind === 'transfers' ? 'Narrow it with --to <the contract the token moves into>, such as --token usdc --to <the router or pool manager>, or --from <the contract paying out>, so every page holds the operation.'
    : target.kind === 'contracts' ? "Narrow it with --event '<the operation's event>' or --token <token> --to <the contract>, so every page holds the operation."
    : 'Raise --pages, or search the event of fewer contracts.';
  return `WARNING: the search is short. ${short.map(reach).join('; ')}. ${narrow}`;
}

type LogHit = { readonly hash: Hex; readonly block: bigint; readonly emitter: Address; readonly topics: readonly Hex[]; readonly data: Hex };

const READ_WIDTH = 8;
const QUERY_WIDTH = 4;
const TOPIC_ONLY_SPAN = 300n;
const FILL_PAGES = 5n;
const GROWTH = 8n;
const SAFE_EXEC = parseFunctionSignature('execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function logOf(raw: unknown): LogHit {
  if (!isRecord(raw) || !Array.isArray(raw.topics) || typeof raw.blockNumber !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw.blockNumber)) throw new ResearchError('etherscan sent a malformed log');
  return {
    hash: parseHex('transactionHash', raw.transactionHash),
    block: BigInt(raw.blockNumber),
    emitter: parseAddress('address', raw.address),
    topics: raw.topics.map((topic) => parseHex('topic', topic)),
    data: parseHex('data', raw.data),
  };
}

const smaller = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const larger = (a: bigint, b: bigint): bigint => (a > b ? a : b);

type Listed = { readonly kind: 'complete' | 'overflow' | 'timeout'; readonly logs: LogHit[]; readonly pages: number };

async function listRange(query: LogQuery, fromBlock: bigint, toBlock: bigint, allowed: number, ask: Ask): Promise<Listed> {
  const logs: LogHit[] = [];
  for (let page = 1; page <= allowed; page++) {
    const answer = await ask(
      { source: 'etherscan', query: { chainid: '1', module: 'logs', action: 'getLogs', ...query.filter, fromBlock: String(fromBlock), toBlock: String(toBlock), offset: String(PAGE), page: String(page) } },
      'empty',
    );
    if (!isRecord(answer)) throw new ResearchError('etherscan sent no answer');
    if (answer.status === '0' && answer.message === 'No records found') return { kind: 'complete', logs, pages: page };
    if (answer.status === '0' && /time-?out/i.test(`${String(answer.message)} ${String(answer.result)}`)) return { kind: 'timeout', logs, pages: page };
    if (answer.status !== '1' || !Array.isArray(answer.result)) throw new ResearchError(`etherscan refused: ${String(answer.message).slice(0, 80)} ${typeof answer.result === 'string' ? answer.result.slice(0, 120) : ''}`.trim());
    if (answer.result.length === 0) return { kind: 'complete', logs, pages: page };
    logs.push(...answer.result.map(logOf));
    const reached = (logs.at(-1) as LogHit).block - fromBlock + 1n;
    const needed = (toBlock - fromBlock + 1n) * BigInt(page);
    if (needed > larger(reached, 1n) * BigInt(allowed) && answer.result.length === PAGE) return { kind: 'overflow', logs, pages: page };
  }
  return { kind: 'overflow', logs, pages: allowed };
}

/**
 * Lists the query's logs newest first, one block range below the other, until `range` is read or `maxPages` pages were
 * taken. A range counts only when listed to its empty last page; one that holds too many is asked again shorter.
 */
async function pageBack(query: LogQuery, range: Survey['range'], maxPages: number, ask: Ask): Promise<{ run: QueryRun; logs: LogHit[] }> {
  const logs: LogHit[] = [];
  let pages = 0;
  let toBlock = range.toBlock;
  let span = query.firstSpan;
  let longest = range.toBlock - range.fromBlock + 1n;
  let stopped: string | undefined;
  while (toBlock >= range.fromBlock) {
    if (pages >= maxPages) {
      stopped = `its cap of ${maxPages} pages`;
      break;
    }
    const fromBlock = larger(range.fromBlock, toBlock - span + 1n);
    const asked = toBlock - fromBlock + 1n;
    try {
      const listed = await listRange(query, fromBlock, toBlock, Math.min(RANGE_PAGES, maxPages - pages), ask);
      pages += listed.pages;
      const count = BigInt(listed.logs.length);
      if (listed.kind !== 'complete') {
        if (listed.kind === 'timeout') longest = larger(1n, asked / 2n);
        const reached = count === 0n ? asked / GROWTH : (listed.logs.at(-1) as LogHit).block - fromBlock + 1n;
        span = larger(1n, smaller(asked / 2n, reached));
        if (asked === 1n) {
          stopped = `one block holding more than ${listed.pages} pages`;
          break;
        }
        continue;
      }
      logs.push(...listed.logs);
      span = smaller(longest, count === 0n ? asked * GROWTH : smaller(asked * GROWTH, larger(1n, (asked * FILL_PAGES * BigInt(PAGE)) / count)));
      toBlock = fromBlock - 1n;
    } catch (error) {
      if (!(error instanceof ResearchError || error instanceof SafeTxParseError || error instanceof SyntaxError)) throw error;
      stopped = error.message;
      break;
    }
  }
  return { run: { label: query.label, fromBlock: toBlock === range.toBlock ? undefined : toBlock + 1n, pages, logs: logs.length, ...(stopped === undefined ? {} : { stopped }) }, logs };
}

export function logQueries(target: SurveyTarget, blocks: bigint): LogQuery[] {
  switch (target.kind) {
    case 'contracts':
      return target.contracts.flatMap(({ address, events }) => [
        ...(events.length === 0 ? [{ label: `logs by ${address}`, filter: { address }, firstSpan: blocks }] : events.map((e) => ({ label: `${e.signature} logged by ${address}`, filter: { address, topic0: e.topic }, firstSpan: blocks }))),
        ...[1, 2, 3].map((n) => ({ label: `logs naming ${address} in topic ${n}`, filter: { [`topic${n}`]: wordOf(address) }, firstSpan: TOPIC_ONLY_SPAN })),
      ]);
    case 'event': {
      const { topic, signature } = target.event;
      return target.contracts.length === 0
        ? [{ label: `${signature} logged by any contract`, filter: { topic0: topic }, firstSpan: blocks }]
        : target.contracts.map((address) => ({ label: `${signature} logged by ${address}`, filter: { address, topic0: topic }, firstSpan: blocks }));
    }
    case 'transfers': {
      const { from, to } = target;
      return target.tokens.map((token) => ({
        label: `Transfer of ${token}${from === undefined ? '' : ` from ${from}`}${to === undefined ? '' : ` to ${to}`}`,
        filter: {
          address: token,
          topic0: TRANSFER,
          ...(from === undefined ? {} : { topic0_1_opr: 'and', topic1: wordOf(from) }),
          ...(to === undefined ? {} : { topic0_2_opr: 'and', topic2: wordOf(to) }),
          ...(from === undefined || to === undefined ? {} : { topic1_2_opr: 'and' }),
        },
        firstSpan: blocks,
      }));
    }
  }
}

/** Whether a word is an address as ABI encoding pads one. A number under 2^128 is padded alike, so it is not taken for one. */
export const addressLike = (word: string): boolean => /^0{24}[0-9a-f]{40}$/.test(word) && !/^0{32}/.test(word);

function partiesOf(log: LogHit): Address[] {
  const words = [...log.topics.slice(1).map((topic) => topic.slice(2)), ...(log.data.slice(2).match(/.{64}/g) ?? [])];
  return [log.emitter, ...words.filter(addressLike).map((word) => addressOf(`0x${word}` as Hex))];
}

const mentions = (hex: Hex, address: Address): boolean => hex.includes(address.slice(2));

function callsOf(tx: Transaction & { readonly to: Address }): Pick<SafeTxCalls, 'wrapped' | 'calls'> | undefined {
  const outer = decodeCall(SAFE_EXEC, wholeRegion(hexToBytes(tx.input.slice(2))));
  if (outer.kind !== 'decoded') return undefined;
  const [to, value, data, operation] = outer.args;
  if (to?.kind !== 'address' || value?.kind !== 'uint' || data?.kind !== 'bytes' || operation?.kind !== 'uint' || operation.value > 1n) return undefined;
  const call: SafeCall = { operation: operation.value === 0n ? 0 : 1, to: to.value, value: value.value, data: `0x${bytesToHex(data.value)}` as Hex };
  const unwrapped = unwrapSafeTx(call);
  if (unwrapped.kind !== 'multisend') return { wrapped: unwrapped.kind === 'direct' ? 'direct' : 'raw', calls: [call] };
  return { wrapped: 'batch', calls: unwrapped.calls.map((c) => ({ operation: c.operation, to: c.to, value: c.value, data: `0x${bytesToHex(regionBytes(c.data))}` as Hex })) };
}

const spaced = <T>(items: readonly T[], cap: number): T[] => (items.length <= cap ? [...items] : Array.from({ length: cap }, (_, i) => items[Math.floor((i * items.length) / cap)] as T));

const must = <T>(what: string, read: Read<T>): T => {
  if (read.kind === 'unverifiable') throw new ResearchError(`${what}: ${read.reason}`);
  return read.value;
};

type Marked = { readonly block: bigint; readonly foundBy: Set<string>; readonly emitters: Set<Address>; readonly parties: Set<Address> };
type Studied = { readonly kind: 'tx'; readonly tx: SafeTxCalls } | { readonly kind: 'out'; readonly why: string; readonly hash: Hex } | { readonly kind: 'excluded' };

/** Searches for executed Safe transactions that reach the target. Throws only when the chain's head or last block is unreadable. */
export async function survey(target: SurveyTarget, deps: SurveyDeps): Promise<Survey> {
  const reader = sharedReads(deps.reader);
  const toBlock = searchTop(deps.head ?? must('the head block', await reader.blockNumber()));
  const range = { fromBlock: larger(0n, toBlock - smaller(deps.blocks, YEAR) + 1n), toBlock };
  const at = must('the last block searched', await reader.block(toBlock));
  const executionQuery: LogQuery = { label: 'ExecutionSuccess of every Safe', filter: { topic0: EXECUTION_SUCCESS }, firstSpan: 1800n };
  const queries = logQueries(target, toBlock - range.fromBlock + 1n);
  const [executed, ...runs] = await inPool([executionQuery, ...queries], QUERY_WIDTH, (query) => pageBack(query, range, deps.maxPages, deps.ask));
  const warning = shortSearch(target, runs.map((r) => r.run), range);
  if (warning !== undefined) deps.warn?.(warning);

  const txs = new Map<Hex, Marked>();
  const excluded = new Set<Hex>();
  for (const { run, logs } of runs) {
    for (const log of logs) {
      const parties = partiesOf(log);
      if (deps.exclude !== undefined && parties.includes(deps.exclude)) excluded.add(log.hash);
      const tx = txs.get(log.hash) ?? { block: log.block, foundBy: new Set(), emitters: new Set(), parties: new Set() };
      tx.foundBy.add(run.label);
      tx.emitters.add(log.emitter);
      for (const party of parties) tx.parties.add(party);
      txs.set(log.hash, tx);
    }
  }
  for (const hash of excluded) txs.delete(hash);
  const executions = executed as NonNullable<typeof executed>;
  const executedHashes = new Set(executions.logs.map((log) => log.hash));
  const parties = [...new Set([...txs].filter(([hash]) => !executedHashes.has(hash)).flatMap(([, tx]) => [...tx.parties]))].sort();
  const proofs = await proveParties(reader, parties, at, deps.batches ?? reader);
  const safes = new Set(parties.filter((_, i) => proofs[i]?.kind === 'safe'));
  const marked = [...txs].filter(([hash, tx]) => executedHashes.has(hash) || [...tx.parties].some((party) => safes.has(party))).sort(([, a], [, b]) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
  const chosen = spaced(marked, deps.maxTxs);

  const isSafe = safeCheck(reader, deps.batches ?? reader, at);
  const reads = await inPool(chosen, READ_WIDTH, async ([hash, found]) => ({ hash, found, answer: await reader.getTransaction(hash) }));
  await isSafe.load(reads.flatMap(({ answer }) => (answer.kind === 'agreed' && answer.value?.to != null ? [answer.value.to] : [])));
  const studied = await inPool(reads, READ_WIDTH, async ({ hash, found, answer }): Promise<Studied> => {
    const out = (why: string): Studied => ({ kind: 'out', why, hash });
    if (answer.kind === 'unverifiable') return out(`not read: ${answer.reason}`);
    const tx = answer.value;
    if (tx === null) return out('not read: neither provider knows the transaction');
    if (deps.exclude !== undefined && (tx.to === deps.exclude || tx.from === deps.exclude || mentions(tx.input, deps.exclude))) return { kind: 'excluded' };
    const { to } = tx;
    if (to === null) return out('a contract creation');
    const proof = isSafe.of(to);
    if (proof !== 'safe') return out(proof === 'unreadable' ? 'not read: whether it was sent to a Safe' : `sent to a contract that is not a Safe, ${tx.input.slice(0, 10)}`);
    const calls = tx.input.startsWith(SAFE_EXEC.selector) ? callsOf({ ...tx, to }) : undefined;
    if (calls === undefined) return out(tx.input.startsWith(SAFE_EXEC.selector) ? 'execTransaction calldata that does not decode' : `sent to a Safe by a function other than execTransaction, ${tx.input.slice(0, 10)}`);
    const receipt = await reader.getTransactionReceipt(hash);
    if (receipt.kind === 'unverifiable') return out(`not read: ${receipt.reason}`);
    const logs = receipt.value?.logs ?? [];
    if (deps.exclude !== undefined && logs.some((log) => partiesOf({ ...log, hash, block: 0n, emitter: log.address }).includes(deps.exclude as Address))) return { kind: 'excluded' };
    if (!logs.some((log) => log.address === to && log.topics[0] === EXECUTION_SUCCESS)) return out('no ExecutionSuccess from the Safe');
    if (target.kind === 'event' && target.contracts.length === 0 && !found.emitters.has(to)) return out('the event logged by another contract than the Safe that executed');
    if (target.kind === 'transfers' && target.contracts.length > 0 && !calls.calls.some((call) => target.contracts.some((c) => call.to === c || mentions(call.data, c)))) return out('no call that names the contract');
    return { kind: 'tx', tx: { hash, block: found.block, safe: to, ...calls, foundBy: found.foundBy } };
  });
  const leftOut = new Map<string, Hex[]>();
  for (const one of studied) if (one.kind === 'out') leftOut.set(one.why, [...(leftOut.get(one.why) ?? []), one.hash]);
  const excludedRead = studied.filter((one) => one.kind === 'excluded').length;
  return {
    target,
    range,
    queries: runs.map((r) => r.run),
    executions: executions.run,
    found: txs.size - excludedRead,
    parties: { checked: parties.length, safes: safes.size, unreadable: proofs.filter((p) => p.kind === 'unreadable').length },
    marked: marked.length - excludedRead,
    read: chosen.length - excludedRead,
    txs: studied.flatMap((one) => (one.kind === 'tx' ? [one.tx] : [])),
    leftOut,
  };
}

function safeCheck(reader: Reader, batches: Reader, at: BlockRef) {
  const known = new Map<Address, 'safe' | 'not-safe' | 'unreadable'>();
  return {
    load: async (addresses: readonly Address[]) => {
      const distinct = [...new Set(addresses)].sort();
      (await proveParties(reader, distinct, at, batches)).forEach((proof, i) => known.set(distinct[i] as Address, proof.kind));
    },
    of: (address: Address) => known.get(address) ?? 'unreadable',
  };
}

/** `inner` with Etherscan requests started no closer than `gapMs`, so queries that run side by side keep its pace. */
export function pacedAsk(inner: Ask, gapMs = 420): Ask {
  let next = 0;
  return async (request, end) => {
    const start = Math.max(next, Date.now());
    next = start + gapMs;
    if (start > Date.now()) await new Promise((resolve) => setTimeout(resolve, start - Date.now()));
    return inner(request, end);
  };
}
