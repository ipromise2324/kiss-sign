import { request } from 'node:https';
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
 * Which ERC-20 `Transfer` of `token` marks a transaction of the operation: `mint` (from the zero address, such as vault
 * shares on a deposit), `burn` (to the zero address, such as shares on a withdrawal), or `any` (a plain transfer).
 */
export type AnchorKind = 'mint' | 'burn' | 'any';
export const ANCHOR_KINDS: readonly AnchorKind[] = ['mint', 'burn', 'any'];

/**
 * With `any`, `from` keeps only transfers out of that address, such as a rewards distributor paying a claim, and `to`
 * only transfers into one, such as Morpho Blue receiving a market's loan token on a supply.
 */
export type Anchor = {
  readonly token: Address;
  readonly kind: AnchorKind;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly from?: Address;
  readonly to?: Address;
};

export const SOURCES = ['alchemy', 'etherscan'] as const;
export type SourceName = (typeof SOURCES)[number];

/** A request to a search source. It never holds a key, so a recording holds none. */
export type SourceRequest =
  | { readonly source: 'alchemy'; readonly params: Readonly<Record<string, unknown>> }
  | { readonly source: 'etherscan'; readonly query: Readonly<Record<string, string>> };

export type Ask = (request: SourceRequest) => Promise<unknown>;

/** One anchor transfer a source reported. */
export type Hit = { readonly hash: Hex; readonly from: Address; readonly to: Address };

export type Hits = Readonly<Record<SourceName, readonly Hit[]>>;

const PAGE = 1000;

export class ResearchError extends Error {
  override name = 'ResearchError';
}

export class TooManyTransfers extends ResearchError {
  override name = 'TooManyTransfers';

  constructor(source: SourceName) {
    super(`${source} lists more than ${PAGE - 1} transfers in the range`);
  }
}

const ZERO = `0x${'00'.repeat(20)}` as Address;
const ZERO_WORD = `0x${'00'.repeat(32)}`;

const hex = (n: bigint): string => `0x${n.toString(16)}`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function hitOf(source: SourceName, hash: unknown, from: unknown, to: unknown): Hit {
  try {
    return { hash: parseHex('hash', hash), from: parseAddress('from', from), to: parseAddress('to', to) };
  } catch (error) {
    if (error instanceof SafeTxParseError) throw new ResearchError(`${source} sent a malformed transfer (${error.message})`);
    throw error;
  }
}

async function searchAlchemy(anchor: Anchor, ask: Ask): Promise<Hit[]> {
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
  const answer = await ask({ source: 'alchemy', params: base });
  if (!isRecord(answer) || !Array.isArray(answer.transfers)) throw new ResearchError('alchemy sent no transfer list');
  if (typeof answer.pageKey === 'string') throw new TooManyTransfers('alchemy');
  return (answer.transfers as unknown[]).map((t) => {
    if (!isRecord(t)) throw new ResearchError('alchemy sent a malformed transfer');
    return hitOf('alchemy', t.hash, t.from, t.to);
  });
}

async function searchEtherscan(anchor: Anchor, ask: Ask): Promise<Hit[]> {
  const base: Record<string, string> = {
    chainid: '1',
    module: 'logs',
    action: 'getLogs',
    address: anchor.token,
    fromBlock: anchor.fromBlock.toString(),
    toBlock: anchor.toBlock.toString(),
    topic0: TRANSFER,
    ...(anchor.kind === 'mint' ? { topic0_1_opr: 'and', topic1: ZERO_WORD } : {}),
    ...(anchor.kind === 'burn' ? { topic0_2_opr: 'and', topic2: ZERO_WORD } : {}),
    ...(anchor.from !== undefined ? { topic0_1_opr: 'and', topic1: `0x${'00'.repeat(12)}${anchor.from.slice(2)}` } : {}),
    ...(anchor.to !== undefined ? { topic0_2_opr: 'and', topic2: `0x${'00'.repeat(12)}${anchor.to.slice(2)}` } : {}),
    ...(anchor.from !== undefined && anchor.to !== undefined ? { topic1_2_opr: 'and' } : {}),
    offset: String(PAGE),
  };
  const answer = await ask({ source: 'etherscan', query: { ...base, page: '1' } });
  if (!isRecord(answer)) throw new ResearchError('etherscan sent no answer');
  if (answer.status === '0' && answer.message === 'No records found') return [];
  if (answer.status !== '1' || !Array.isArray(answer.result)) {
    throw new ResearchError(`etherscan refused: ${String(answer.message).slice(0, 80)} ${typeof answer.result === 'string' ? answer.result.slice(0, 120) : ''}`.trim());
  }
  if (answer.result.length >= PAGE) throw new TooManyTransfers('etherscan');
  return (answer.result as unknown[]).map((log) => {
    if (!isRecord(log) || !Array.isArray(log.topics)) throw new ResearchError('etherscan sent a malformed log');
    const [, from, to] = log.topics as unknown[];
    const address = (word: unknown) => (typeof word === 'string' ? `0x${word.slice(-40)}` : word);
    return hitOf('etherscan', log.transactionHash, address(from), address(to));
  });
}

/** Both sources' anchor transfers. Either source failing stops the search, since one source is no cross-check. */
export async function searchBoth(anchor: Anchor, ask: Ask): Promise<Hits> {
  const [alchemy, etherscan] = await Promise.all([searchAlchemy(anchor, ask), searchEtherscan(anchor, ask)]);
  return { alchemy, etherscan };
}

export type SourceExchange = { readonly request: SourceRequest; readonly answer: unknown };

/**
 * The answer cut to the fields the search reads, so its replay finds the same transfers and the same overflow. An
 * answer over one page keeps only its length (Etherscan) or its page key (Alchemy): a halved window never reads its
 * transfers, and a busy token's windows halve many times.
 */
function readFields(source: SourceName, answer: unknown): unknown {
  if (!isRecord(answer)) return answer;
  if (source === 'alchemy') {
    if (!Array.isArray(answer.transfers)) return answer;
    const { transfers, pageKey } = answer;
    if (typeof pageKey === 'string') return { transfers: [], pageKey };
    return { transfers: transfers.map((t: unknown) => (isRecord(t) ? { hash: t.hash, from: t.from, to: t.to } : t)) };
  }
  if (answer.status !== '1' || !Array.isArray(answer.result)) return answer;
  const { status, message, result } = answer;
  if (result.length >= PAGE) return { status, message, result: result.map(() => ({})) };
  return { status, message, result: result.map((log: unknown) => (isRecord(log) ? { transactionHash: log.transactionHash, topics: log.topics } : log)) };
}

/** Passes every request through and keeps each answer, cut to what the search reads. */
export function recordingAsk(inner: Ask): { ask: Ask; exchanges: () => SourceExchange[] } {
  const exchanges: SourceExchange[] = [];
  return {
    ask: async (req) => {
      const answer = await inner(req);
      exchanges.push({ request: req, answer: readFields(req.source, answer) });
      return answer;
    },
    exchanges: () => [...exchanges],
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

/**
 * The live sources, with keys from the environment or `$KISS_SIGN_HOME/.env`. A request that fails on the way or gets a
 * busy answer is sent again a few times, then noted. A failure names the source only, never a URL, since both URLs
 * carry a key.
 */
export function liveAsk(env: Env, note: NoteUnread, transport: Transport = httpsTransport()): Ask {
  const alchemyUrl = mainnetEndpoints(env)[0].url;
  const etherscanKey = requiredKey('etherscan', env);
  const lookup = fallbackLookup();
  let lastEtherscan = 0;
  return async (req) => {
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
    // The free Etherscan plan allows a few requests a second.
    for (let tries = 0; ; tries++) {
      const wait = lastEtherscan + 400 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastEtherscan = Date.now();
      const path = `/v2/api?${new URLSearchParams({ ...req.query, apikey: etherscanKey })}`;
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
          note,
        );
      } catch {
        throw new ResearchError('etherscan unreachable');
      }
      if (answer.status !== 200) throw new ResearchError(`etherscan answered HTTP ${answer.status}`);
      const parsed = JSON.parse(answer.text) as Record<string, unknown>;
      if (parsed.status === '0' && /rate limit/i.test(String(parsed.result)) && tries < 3) continue;
      return parsed;
    }
  };
}
