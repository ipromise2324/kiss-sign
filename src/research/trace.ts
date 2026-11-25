import { retried, transientStatus } from '../chain/https.ts';
import type { HttpAnswer, NoteUnread } from '../chain/https.ts';
import type { Endpoint } from '../chain/providers.ts';
import type { Reader } from '../chain/reader.ts';
import type { Transport } from '../chain/rpc.ts';
import type { Receipt, Transaction } from '../chain/types.ts';
import type { Registry } from '../registry.ts';
import type { Address, Hex } from '../safe/types.ts';
import { callSites, refNames, targetNames } from '../template/template.ts';
import type { Template } from '../template/template.ts';
import type { Sender } from './study.ts';

export const CALL_TYPES = ['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT'] as const;
export type CallType = (typeof CALL_TYPES)[number];

/**
 * One call of a `callTracer` trace, cut down to what the comparison reads, in the order the trace nests them. `args`
 * holds the address arguments of a `transfer`, `transferFrom` or `approve`: the recipient, the owner and recipient, or
 * the spender.
 */
export type TraceCall = {
  readonly depth: number;
  readonly type: CallType;
  readonly from: Address;
  /** Absent only for a `CREATE` or `CREATE2` that failed, which created nothing. */
  readonly to?: Address;
  readonly selector?: Hex;
  readonly value?: Hex;
  readonly reverted?: true;
  readonly args?: readonly Address[];
};

/** A transaction's trace as a `past-txs` recording keeps it: its calls, or why drpc's answer could not be read as a trace. */
export type RecordedTrace = { readonly hash: Hex; readonly calls: readonly TraceCall[] } | { readonly hash: Hex; readonly unreadable: string };

export const TOKEN_CALLS = { '0xa9059cbb': 'transfer', '0x23b872dd': 'transferFrom', '0x095ea7b3': 'approve' } as const;
export type TokenCall = (typeof TOKEN_CALLS)[keyof typeof TOKEN_CALLS];
const PERMIT = '0xd505accf';
/** How many leading address arguments a recorded call keeps: a token call's, and an ERC-2612 `permit`'s owner and spender, which set an allowance. */
const ADDRESS_ARGS: Readonly<Record<string, number>> = { '0xa9059cbb': 1, '0x23b872dd': 2, '0x095ea7b3': 1, [PERMIT]: 2 };
const tokenCall = (selector: Hex | undefined): TokenCall | undefined => (selector === undefined ? undefined : (TOKEN_CALLS as Readonly<Record<string, TokenCall>>)[selector]);

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const ZERO = `0x${'00'.repeat(20)}` as Address;

export class TraceError extends Error {
  override name = 'TraceError';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const address = (path: string, v: unknown): Address => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new TraceError(`${path}: not an address`);
  return v.toLowerCase() as Address;
};
const quantity = (path: string, v: unknown): Hex => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new TraceError(`${path}: not a hex quantity`);
  return `0x${BigInt(v).toString(16)}` as Hex;
};

/** The EVM's call depth limit: no real trace nests deeper, so a deeper answer is no trace. */
const MAX_DEPTH = 1024;

/** The calls of one `callTracer` frame and every frame under it, depth first, cut down to a `TraceCall` each. */
export function trimTrace(frame: unknown): TraceCall[] {
  const calls: TraceCall[] = [];
  const walk = (raw: unknown, depth: number, path: string): void => {
    if (depth > MAX_DEPTH) throw new TraceError(`trace: deeper than the ${MAX_DEPTH} nested calls the EVM allows`);
    if (!isRecord(raw)) throw new TraceError(`${path}: not a call frame`);
    const type = CALL_TYPES.find((t) => t === raw.type);
    if (type === undefined) throw new TraceError(`${path}.type: not a call type`);
    const input = typeof raw.input === 'string' ? raw.input.toLowerCase() : '0x';
    if (!/^0x([0-9a-f]{2})*$/.test(input)) throw new TraceError(`${path}.input: not hex data`);
    const selector = input.length >= 10 ? (input.slice(0, 10) as Hex) : undefined;
    const value = raw.value === undefined ? undefined : quantity(`${path}.value`, raw.value);
    const kept = selector === undefined ? undefined : ADDRESS_ARGS[selector];
    const words = input.slice(10);
    const args = kept === undefined || words.length < kept * 64 ? undefined : Array.from({ length: kept }, (_, i) => `0x${words.slice(i * 64 + 24, (i + 1) * 64)}` as Address);
    const created = (type === 'CREATE' || type === 'CREATE2') && raw.error !== undefined && raw.to === undefined;
    calls.push({
      depth,
      type,
      from: address(`${path}.from`, raw.from),
      ...(created ? {} : { to: address(`${path}.to`, raw.to) }),
      ...(selector === undefined ? {} : { selector }),
      ...(value === undefined || BigInt(value) === 0n ? {} : { value }),
      ...(raw.error === undefined ? {} : { reverted: true as const }),
      ...(args === undefined ? {} : { args }),
    });
    const inner = raw.calls ?? [];
    if (!Array.isArray(inner)) throw new TraceError(`${path}.calls: not a list`);
    inner.forEach((call, i) => walk(call, depth + 1, `${path}.calls[${i}]`));
  };
  walk(frame, 0, 'trace');
  return calls;
}

/** A recorded trace as the recording holds it, refused when any call is not one `trimTrace` writes. */
export function parseRecordedTrace(raw: unknown, path: string): RecordedTrace {
  if (!isRecord(raw) || typeof raw.hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(raw.hash)) throw new TraceError(`${path}: not a recorded trace`);
  if (typeof raw.unreadable === 'string' && raw.calls === undefined && Object.keys(raw).length === 2) return { hash: raw.hash as Hex, unreadable: raw.unreadable };
  if (!Array.isArray(raw.calls) || Object.keys(raw).length !== 2) throw new TraceError(`${path}: not a recorded trace`);
  const calls = raw.calls.map((call: unknown, i): TraceCall => {
    const at = `${path}.calls[${i}]`;
    if (!isRecord(call)) throw new TraceError(`${at}: not a call`);
    const extra = Object.keys(call).find((key) => !['depth', 'type', 'from', 'to', 'selector', 'value', 'reverted', 'args'].includes(key));
    if (extra !== undefined) throw new TraceError(`${at}: ${extra} is not a field of a recorded call`);
    const type = CALL_TYPES.find((t) => t === call.type);
    if ((call.depth as number) > MAX_DEPTH) throw new TraceError(`${at}.depth: deeper than the ${MAX_DEPTH} nested calls the EVM allows`);
    if (!Number.isSafeInteger(call.depth) || (call.depth as number) < 0 || type === undefined) throw new TraceError(`${at}: no depth or call type`);
    if (call.selector !== undefined && (typeof call.selector !== 'string' || !/^0x[0-9a-f]{8}$/.test(call.selector))) throw new TraceError(`${at}.selector: not a selector`);
    if (call.reverted !== undefined && call.reverted !== true) throw new TraceError(`${at}.reverted: not true`);
    if (call.args !== undefined && !Array.isArray(call.args)) throw new TraceError(`${at}.args: not a list`);
    const value = call.value === undefined ? undefined : quantity(`${at}.value`, call.value);
    if (value !== undefined && BigInt(value) === 0n) throw new TraceError(`${at}.value: zero, which a recording never writes`);
    const created = (type === 'CREATE' || type === 'CREATE2') && call.reverted === true && call.to === undefined;
    return {
      depth: call.depth as number,
      type,
      from: address(`${at}.from`, call.from),
      ...(created ? {} : { to: address(`${at}.to`, call.to) }),
      ...(call.selector === undefined ? {} : { selector: call.selector as Hex }),
      ...(value === undefined ? {} : { value }),
      ...(call.reverted === undefined ? {} : { reverted: true as const }),
      ...(call.args === undefined ? {} : { args: (call.args as unknown[]).map((a, j) => address(`${at}.args[${j}]`, a)) }),
    };
  });
  const depthsNest = calls.every((call, i) => (i === 0 ? call.depth === 0 : call.depth >= 1 && call.depth <= (calls[i - 1] as TraceCall).depth + 1));
  if (calls.length === 0 || !depthsNest) throw new TraceError(`${path}.calls: not one call tree in depth-first order`);
  return { hash: raw.hash as Hex, calls };
}

/** A transaction's trace: its calls, or why the answer is no trace the program can read. */
export type TraceAnswer = { readonly kind: 'calls'; readonly calls: readonly TraceCall[] } | { readonly kind: 'unreadable'; readonly why: string };

/** Each transaction's trace by hash, or undefined for one not traced. */
export type TraceSource = (hash: Hex) => Promise<TraceAnswer | undefined>;

const asAnswer = (trace: RecordedTrace): TraceAnswer => ('calls' in trace ? { kind: 'calls', calls: trace.calls } : { kind: 'unreadable', why: trace.unreadable });

/**
 * Traces from drpc alone, retried after a pause; a trace with no answer after every retry is noted, so `--record`
 * writes nothing, and read as not traced. `recorded` gives every trace read, in the order they were asked for.
 */
export function drpcTraces(endpoint: Endpoint, transport: Transport, note: NoteUnread): { readonly source: TraceSource; readonly recorded: () => RecordedTrace[] } {
  const traces = new Map<Hex, RecordedTrace | undefined>();
  const source = async (hash: Hex): Promise<TraceAnswer | undefined> => {
    traces.set(hash, undefined);
    const label = `${endpoint.provider} debug_traceTransaction ${hash}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer' }] });
    let answer: HttpAnswer;
    try {
      answer = await retried(label, () => transport(endpoint.url, body, AbortSignal.timeout(60_000)), (a) => transientStatus(a) ?? traceProblem(a.text), note);
    } catch (error) {
      note(`${label}: ${(error as Error).message}`);
      return undefined;
    }
    if (traceProblem(answer.text) !== undefined) return undefined;
    let trace: RecordedTrace;
    try {
      trace = { hash, calls: trimTrace((JSON.parse(answer.text) as { result: unknown }).result) };
    } catch (error) {
      if (!(error instanceof TraceError)) throw error;
      trace = { hash, unreadable: error.message };
    }
    traces.set(hash, trace);
    return asAnswer(trace);
  };
  return { source, recorded: () => [...traces.values()].filter((trace) => trace !== undefined) };
}

const traceProblem = (text: string): string | undefined => {
  try {
    const answer = JSON.parse(text) as unknown;
    if (isRecord(answer) && isRecord(answer.result)) return undefined;
    return isRecord(answer) && isRecord(answer.error) ? `error ${String(answer.error.message).slice(0, 80)}` : 'no trace in the answer';
  } catch {
    return 'not JSON';
  }
};

/** The traces a recording holds, by hash; a recording made before traces holds none. */
export function replayTraces(recorded: readonly unknown[] | undefined): TraceSource {
  const traces = new Map((recorded ?? []).map((raw, i) => {
    const trace = parseRecordedTrace(raw, `traces[${i}]`);
    return [trace.hash, asAnswer(trace)] as const;
  }));
  return async (hash) => traces.get(hash);
}

/** A traced transaction, its reverted calls left out, or why its trace does not count. */
export type TracedTx =
  | { readonly kind: 'traced'; readonly hash: Hex; readonly sender: Sender; readonly calls: readonly TraceCall[] }
  | { readonly kind: 'unverifiable'; readonly hash: Hex; readonly why: string };

const withoutReverted = (calls: readonly TraceCall[]): TraceCall[] => {
  const kept: TraceCall[] = [];
  let undone: number | undefined;
  for (const call of calls) {
    if (undone !== undefined && call.depth > undone) continue;
    undone = call.reverted ? call.depth : undefined;
    if (!call.reverted) kept.push(call);
  }
  return kept;
};

const sameTop = (top: TraceCall, tx: Transaction): boolean =>
  top.from === tx.from.toLowerCase() &&
  top.to === tx.to?.toLowerCase() &&
  top.selector === (tx.input.length >= 10 ? tx.input.slice(0, 10).toLowerCase() : undefined) &&
  BigInt(top.value ?? 0) === tx.value;

type Movement = { readonly event: 'Transfer' | 'Approval'; readonly token: Address; readonly from: Address; readonly to: Address };
const key = (m: Movement): string => `${m.event} ${m.token} ${m.from} ${m.to}`;
const topicAddress = (topic: Hex | undefined): Address | undefined => (topic === undefined || topic.length !== 66 ? undefined : (`0x${topic.slice(26)}` as Address));

function callMovement(call: TraceCall): Movement | undefined {
  const kind = tokenCall(call.selector);
  if (kind === undefined || call.type !== 'CALL' || call.args === undefined || call.to === undefined) return undefined;
  if (kind === 'transferFrom') return { event: 'Transfer', token: call.to, from: call.args[0] as Address, to: call.args[1] as Address };
  return { event: kind === 'transfer' ? 'Transfer' : 'Approval', token: call.to, from: call.from, to: call.args[0] as Address };
}

function logMovement(log: Receipt['logs'][number]): Movement | undefined {
  const [topic, from, to] = [log.topics[0]?.toLowerCase(), topicAddress(log.topics[1]?.toLowerCase() as Hex | undefined), topicAddress(log.topics[2]?.toLowerCase() as Hex | undefined)];
  if (log.topics.length !== 3 || from === undefined || to === undefined) return undefined;
  if (topic === TRANSFER) return { event: 'Transfer', token: log.address.toLowerCase() as Address, from, to };
  if (topic === APPROVAL) return { event: 'Approval', token: log.address.toLowerCase() as Address, from, to };
  return undefined;
}

/**
 * Why the token steps of a trace and the receipt disagree, or undefined when they agree: each `transfer`,
 * `transferFrom` or `approve` call has its log, each `Transfer` log of a registry token between two addresses other
 * than zero has its call, and each `Approval` log of a registry token has the `approve` that logged it, or else the
 * `transferFrom` that spent the allowance or the `permit` that set it, since many tokens log an `Approval` for those too.
 */
export function tokenStepsDisagree(calls: readonly TraceCall[], receipt: Receipt, registryTokens: ReadonlySet<Address>): string | undefined {
  const logged = new Map<string, number>();
  for (const m of receipt.logs.flatMap((log) => logMovement(log) ?? [])) logged.set(key(m), (logged.get(key(m)) ?? 0) + 1);
  const called = new Map<string, number>();
  for (const m of calls.flatMap((call) => callMovement(call) ?? [])) {
    called.set(key(m), (called.get(key(m)) ?? 0) + 1);
    const left = logged.get(key(m)) ?? 0;
    if (left === 0) return `the trace holds a ${m.event === 'Transfer' ? 'transfer' : 'approval'} of ${m.token} from ${m.from} to ${m.to} the receipt does not log`;
    logged.set(key(m), left - 1);
  }
  for (const log of receipt.logs) {
    const m = logMovement(log);
    if (m === undefined || m.event !== 'Transfer' || !registryTokens.has(m.token) || m.from === ZERO || m.to === ZERO) continue;
    const left = called.get(key(m)) ?? 0;
    if (left === 0) return `the receipt logs a transfer of ${m.token} from ${m.from} to ${m.to} with no call in the trace`;
    called.set(key(m), left - 1);
  }
  const spent = new Map<string, number>();
  const count = (k: string) => spent.set(k, (spent.get(k) ?? 0) + 1);
  for (const call of calls) {
    if (call.type !== 'CALL' || call.to === undefined || call.args === undefined) continue;
    if ((call.selector as string) === '0x23b872dd') count(`spend ${call.to} ${call.args[0]} ${call.from}`);
    if ((call.selector as string) === PERMIT) count(`permit ${call.to} ${call.args[0]} ${call.args[1]}`);
  }
  for (const log of receipt.logs) {
    const m = logMovement(log);
    if (m === undefined || m.event !== 'Approval' || !registryTokens.has(m.token)) continue;
    const by = [key(m), `spend ${m.token} ${m.from} ${m.to}`, `permit ${m.token} ${m.from} ${m.to}`].find((k) => ((k === key(m) ? called : spent).get(k) ?? 0) > 0);
    if (by === undefined) return `the receipt logs an approval of ${m.token} from ${m.from} to ${m.to} with no approve, transferFrom or permit in the trace`;
    const from = by === key(m) ? called : spent;
    from.set(by, (from.get(by) as number) - 1);
  }
  return undefined;
}

/**
 * A transaction's trace checked against the transaction and the receipt both providers agree on: its top call must be
 * the transaction, and its token steps must match the receipt's logs both ways.
 */
export async function checkTrace(hash: Hex, sender: Sender, answer: TraceAnswer, reader: Reader, registryTokens: ReadonlySet<Address>): Promise<TracedTx> {
  if (answer.kind === 'unreadable') return { kind: 'unverifiable', hash, why: `drpc's answer is no trace the program reads: ${answer.why}` };
  const { calls } = answer;
  const [tx, receipt] = await Promise.all([reader.getTransaction(hash), reader.getTransactionReceipt(hash)]);
  if (tx.kind !== 'agreed' || tx.value === null) return { kind: 'unverifiable', hash, why: 'the providers do not agree on the transaction' };
  if (receipt.kind !== 'agreed' || receipt.value === null) return { kind: 'unverifiable', hash, why: 'the providers do not agree on the receipt' };
  const top = calls[0];
  if (top === undefined || !sameTop(top, tx.value)) return { kind: 'unverifiable', hash, why: "the trace's top call is not the transaction" };
  const kept = withoutReverted(calls);
  const disagrees = tokenStepsDisagree(kept, receipt.value, registryTokens);
  return disagrees === undefined ? { kind: 'traced', hash, sender, calls: kept } : { kind: 'unverifiable', hash, why: disagrees };
}

/** A `flow` line's `from` or `to`: a registry entry, or the token a card field of that name holds in each transaction. */
export type FlowEnd = { readonly kind: 'entry'; readonly name: string } | { readonly kind: 'card'; readonly field: string };

/** A `flow` line as the comparison reads it: after which call (from 1), between which ends, by which selector. */
export type FlowLine = { readonly after: number; readonly from: FlowEnd; readonly to: FlowEnd; readonly selector: Hex | undefined };

export type MoneyKind = TokenCall | 'eth';

/**
 * The addresses whose money or allowance a money call of each kind can change, its caller among them. A money call is
 * compared only when the sender is one of them: `verify`'s effects check pins the sender's balances and allowances at
 * signing, so a call between two other addresses cannot move the sender's money.
 */
const MONEY_PARTIES: Readonly<Record<MoneyKind, (call: TraceCall) => readonly (Address | undefined)[]>> = {
  transfer: (call) => [call.from, call.args?.[0]],
  transferFrom: (call) => [call.from, call.args?.[0], call.args?.[1]],
  approve: (call) => [call.from],
  eth: (call) => [call.from, call.to],
};

/** Who a money call takes money from and gives it to, `safe` for the sender. */
export type Payment = { readonly from: Address | 'safe'; readonly to: Address | 'safe' };

/** What a money call is to the sender: one it pays or approves, one that pays it, one between two others, or one whose addresses the trace did not keep. */
export type Side = 'out' | 'in' | 'between' | 'unread';
export const sideOf = (payment: Payment | undefined): Side => (payment === undefined ? 'unread' : payment.from === 'safe' ? 'out' : payment.to === 'safe' ? 'in' : 'between');

/** The owner and the receiver, or for an approval the spender, of a money call; the caller is the owner of all but a `transferFrom`. */
function paymentOf(kind: MoneyKind, call: TraceCall, sender: Address): Payment | undefined {
  const [first, second] = call.args ?? [];
  const from = kind === 'transferFrom' ? first : call.from;
  const to = kind === 'eth' ? call.to : kind === 'transferFrom' ? second : first;
  const name = (address: Address) => (address === sender ? 'safe' : address);
  return from === undefined || to === undefined ? undefined : { from: name(from), to: name(to) };
}

/**
 * A money call no line covers, grouped: under which call (from 1), between whom, of which kind, in how many
 * transactions, and every address outside the registry among its parties and token arguments, so a review names them.
 * `pays` holds each pair the calls move money between: who pays whom, or for an approval who lets whom spend; `sides`
 * in how many of the transactions at least one call is on each side of the sender.
 */
export type Uncovered = { readonly call: number; readonly from: string; readonly to: string; readonly kind: MoneyKind; readonly pays: readonly Payment[]; readonly sides: Readonly<Partial<Record<Side, number>>>; readonly transactions: number; readonly others: readonly Address[] };

/** In how many of the `of` transactions that tested something it was `seen`. */
export type Tally = { readonly seen: number; readonly of: number };

/** One card field a line names, with a tally for each registry token the field can name, also one no transaction held. */
export type FieldTally = { readonly field: string; readonly tokens: readonly (Tally & { readonly name: string })[] };

/** A line seen in `seen` of the `of` traced transactions that test it, and the same per token of each card field it names. */
export type LineTally = Tally & { readonly fields: readonly FieldTally[] };

/** Each line's tally, and the money calls no line covers. */
export type FlowComparison = { readonly lines: readonly LineTally[]; readonly uncovered: readonly Uncovered[] };

/** Whether some token a line's card field can name was held by none of the transactions that tested the line. */
export const tokenUntested = ({ fields }: LineTally): boolean => fields.some(({ tokens }) => tokens.some(({ of }) => of === 0));

const delegates = (call: TraceCall): boolean => call.type === 'DELEGATECALL' || call.type === 'CALLCODE';

/** Each call's index range under it, and the nearest call above it that is not a delegation. */
function shape(calls: readonly TraceCall[]): { readonly end: readonly number[]; readonly parent: readonly (number | undefined)[] } {
  const end = calls.map((call, i) => {
    let j = i + 1;
    while (j < calls.length && (calls[j] as TraceCall).depth > call.depth) j++;
    return j;
  });
  const stack: number[] = [];
  const parent = calls.map((call, i) => {
    while (stack.length > 0 && (calls[stack.at(-1) as number] as TraceCall).depth >= call.depth) stack.pop();
    const above = [...stack].reverse().find((j) => !delegates(calls[j] as TraceCall));
    stack.push(i);
    return above;
  });
  return { end, parent };
}

/**
 * The template's calls found in a trace, by template call index: for an EOA, its transaction's own call; for a Safe,
 * in order, the calls the Safe makes with each call's selector, or no data for a call with none, to a contract the
 * call's target can be. Undefined when one is missing.
 */
function templateCalls(template: Template, registry: Registry, tx: Extract<TracedTx, { kind: 'traced' }>): Map<number, number> | undefined {
  if (tx.sender.kind === 'eoa') return new Map([[tx.sender.call, 0]]);
  const safe = tx.sender.address.toLowerCase();
  const found = new Map<number, number>();
  let at = 1;
  for (const [i, call] of template.calls.entries()) {
    const selector = call.data === 'empty' ? undefined : call.data.fn.selector.toLowerCase();
    const targets = targetNames(call.to, template, registry)?.map((name) => registry.entries.get(name)?.address.toLowerCase());
    while (at < tx.calls.length) {
      const c = tx.calls[at] as TraceCall;
      if (c.type === 'CALL' && c.from === safe && c.selector === selector && (targets === undefined || targets.includes(c.to))) break;
      at++;
    }
    if (at >= tx.calls.length) return undefined;
    found.set(i, at++);
  }
  return found;
}

/** A traced transaction as it counts: UNVERIFIABLE, with why, when its trace does not hold the template's calls in order. */
export const holdingTemplateCalls = (template: Template, registry: Registry, tx: TracedTx): TracedTx =>
  tx.kind === 'traced' && templateCalls(template, registry, tx) === undefined ? { kind: 'unverifiable', hash: tx.hash, why: "the trace does not hold the template's calls in order" } : tx;

/**
 * The AI's `flow` lines against the traced transactions: each line seen in N of M, and every money call (a token
 * `transfer`, `transferFrom` or `approve`, or a call sending ETH) that touches the sender, under a template call, that
 * is not a call the template binds, nor one a seen line names, nor one made directly by either. `cards` holds, by
 * transaction, the address of each card field its calls carry; a line that names a field is compared with the
 * transaction's own, and a transaction that does not show it does not test the line.
 */
export function compareFlow(
  template: Template,
  registry: Registry,
  lines: readonly FlowLine[],
  traced: readonly Extract<TracedTx, { kind: 'traced' }>[],
  cards: ReadonlyMap<Hex, ReadonlyMap<string, Address>> = new Map(),
): FlowComparison {
  const addressOf = (name: string): Address | undefined => registry.entries.get(name)?.address.toLowerCase() as Address | undefined;
  const nested = callSites(template, registry).filter((site) => site.nested);
  const tallies = lines.map((line) => ({
    seen: 0,
    of: 0,
    fields: [...new Set([line.from, line.to].flatMap((end) => (end.kind === 'card' ? [end.field] : [])))].map((field) => ({
      field,
      tokens: refNames({ field, attribute: undefined }, template, registry).map((name) => ({ name, seen: 0, of: 0 })),
    })),
  }));
  const uncovered = new Map<string, Uncovered>();
  for (const tx of traced) {
    const calls = templateCalls(template, registry, tx);
    if (calls === undefined) continue;
    const { end, parent } = shape(tx.calls);
    const sender = tx.sender.address.toLowerCase() as Address;
    const under = (i: number): number[] => Array.from({ length: (end[i] as number) - i }, (_, k) => i + k);
    const named = new Set<number>();
    lines.forEach((line, l) => {
      const top = calls.get(line.after - 1);
      if (top === undefined || line.selector === undefined) return;
      const card = cards.get(tx.hash);
      const held = (end: FlowEnd): Address | undefined => (end.kind === 'entry' ? addressOf(end.name) : card?.get(end.field));
      const [from, to] = [held(line.from), held(line.to)];
      if ([line.from, line.to].some((end) => end.kind === 'card' && held(end) === undefined)) return;
      const hits = under(top).filter((j) => j !== top && tx.calls[j]?.from === from && tx.calls[j]?.to === to && tx.calls[j]?.selector === line.selector?.toLowerCase());
      const whole = tallies[l] as (typeof tallies)[number];
      const tokens = whole.fields.flatMap(({ field, tokens }) => tokens.filter(({ name }) => addressOf(name) === card?.get(field)));
      for (const tally of [whole, ...tokens]) {
        tally.of++;
        if (hits.length > 0) tally.seen++;
      }
      for (const j of hits) named.add(j);
    });
    const label = (a: Address): string => (a === sender ? 'safe' : (registry.byAddress.get(a)?.name ?? 'other'));
    for (const [n, top] of calls) {
      const bound = new Set([top, ...under(top).filter((j) => nested.some((site) => site.call === n && tx.calls[j]?.selector === site.fn.selector.toLowerCase() && site.names?.some((name) => addressOf(name) === tx.calls[j]?.to) === true))]);
      const covers = (j: number | undefined): boolean => j !== undefined && (bound.has(j) || named.has(j));
      const counted = new Set<string>();
      for (const j of under(top)) {
        const call = tx.calls[j] as TraceCall;
        const kind: MoneyKind | undefined = call.type !== 'CALL' || call.to === undefined ? undefined : (tokenCall(call.selector) ?? (call.value === undefined ? undefined : 'eth'));
        if (kind === undefined || call.to === undefined || !MONEY_PARTIES[kind](call).includes(sender) || covers(j) || covers(parent[j])) continue;
        const group = { call: n + 1, from: label(call.from), to: label(call.to), kind };
        const id = `${group.call}.${group.from}.${group.to}.${group.kind}`;
        const before = uncovered.get(id);
        const outside = [call.from, call.to, ...(call.args ?? [])].filter((a) => label(a) === 'other');
        const others = [...new Set([...(before?.others ?? []), ...outside])];
        const payment = paymentOf(kind, call, sender);
        const seenPays = before?.pays ?? [];
        const pays = payment === undefined || seenPays.some((p) => p.from === payment.from && p.to === payment.to) ? seenPays : [...seenPays, payment];
        const side = sideOf(payment);
        const first = (key: string): number => (counted.has(key) ? 0 : 1);
        const sides = { ...before?.sides, [side]: (before?.sides[side] ?? 0) + first(`${id} ${side}`) };
        uncovered.set(id, { ...group, pays, sides, transactions: (before?.transactions ?? 0) + first(id), others });
        counted.add(id).add(`${id} ${side}`);
      }
    }
  }
  return { lines: tallies, uncovered: [...uncovered.values()] };
}
