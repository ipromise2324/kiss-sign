import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { BlockHeader, EventLog, SimulatedCall, SimulationCall, SimulationRequest } from '../chain/types.ts';
import { selectorOf } from '../decode/abi.ts';
import { regionBytes, uintWord } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import { hashSafeTx } from '../safe/hash.ts';
import type { Registry } from '../registry.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import type { AllowanceChange, Observed, Permit2Allowance, Permit2Change, ViewAnswer, ViewCall, ViewReading } from './effects.ts';
import { PERMIT2, addressOf, executionOf, isEthTransfer, namesAddress, touchedBy, uintOf } from './events.ts';
import type { Allowance, Execution, Touched } from './events.ts';
import { parseSafeState, safeStateCalls } from './safe-state.ts';
import type { SafeState, SafeStateEvidence } from './safe-state.ts';

/** `logs` are every event the Safe transaction emitted, in order. */
export type Observation =
  | { readonly kind: 'observed'; readonly observed: Observed; readonly logs: readonly EventLog[] }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

export type SimulationInput = {
  readonly tx: SafeTx;
  /** The block the simulated block sits on. */
  readonly parent: BlockHeader;
  /** The simulated block's timestamp: the execution block's for an executed transaction, the next slot's otherwise. */
  readonly time: bigint;
  /** Tokens measured even if no log names the Safe, such as every token the card's effects name. */
  readonly watch: readonly Address[];
  /** Tokens whose balance after the transaction the result carries in `ends`. */
  readonly ends: readonly Address[];
  /** View calls the result carries in `views`, read just before and just after the transaction. */
  readonly views?: readonly ViewCall[];
};

/** Safe 1.1.1, 1.3.0 and 1.4.1: `mapping(address => mapping(bytes32 => uint256)) approvedHashes` is storage slot 8. */
const APPROVED_HASHES_SLOT = 8n;
/** EIP-7825 caps a transaction's gas at 2^24. */
const EXEC_GAS = 1n << 24n;
const READ_GAS = 100_000n;
/** A view effect may compute, such as interest accrued since the last update, so it gets more than a balance read. */
const VIEW_GAS = 1_000_000n;

/** Set by state override: returns the ETH balance of the address in the first 20 bytes of calldata. */
const ETH_BALANCE_READER = '0x000000000000000000000000000000000000ba1a' as Address;
const ETH_BALANCE_READER_CODE = '0x60003560601c3160005260206000f3' as Hex;
/**
 * Set by state override: STATICCALLs the address in the first calldata word with the rest of the calldata and returns
 * or reverts with its answer. A view read in the simulated block shares state with the transaction, so the EVM itself
 * must refuse a "view" that writes storage or emits a log: under STATICCALL either reverts.
 */
const STATIC_READER = '0x00000000000000000000000000000000000057a7' as Address;
const STATIC_READER_CODE = '0x60203603806020600037600060008260006000355afa3d600060003e6023573d6000fd5b3d6000f3' as Hex;

const hex = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}` as Hex;
const bytesOf = (data: Hex | Address): Uint8Array => hexToBytes(data.slice(2));
const addressWord = (address: Address): Uint8Array => uintWord(BigInt(address));
const selector = (signature: string): Uint8Array => bytesOf(selectorOf(signature));

export function approvedHashSlot(owner: Address, safeTxHash: Hex): Hex {
  const inner = keccak_256(concatBytes(addressWord(owner), uintWord(APPROVED_HASHES_SLOT)));
  return hex(keccak_256(concatBytes(bytesOf(safeTxHash), inner)));
}

const dynamicBytes = (bytes: Uint8Array): Uint8Array => {
  const padded = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
  padded.set(bytes);
  return concatBytes(uintWord(BigInt(bytes.length)), padded);
};

/** Type-1 signatures: `r` is the owner, `s` zero, `v` 1. The Safe takes them in ascending owner order. */
function execTransactionData(tx: SafeTx, approvers: readonly Address[]): Hex {
  const signatures = concatBytes(...approvers.map((owner) => concatBytes(addressWord(owner), uintWord(0n), new Uint8Array([1]))));
  const data = dynamicBytes(bytesOf(tx.data));
  const HEAD = 10n * 32n;
  return hex(
    concatBytes(
      selector('execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)'),
      addressWord(tx.to),
      uintWord(tx.value),
      uintWord(HEAD),
      uintWord(BigInt(tx.operation)),
      uintWord(tx.safeTxGas),
      uintWord(tx.baseGas),
      uintWord(tx.gasPrice),
      addressWord(tx.gasToken),
      addressWord(tx.refundReceiver),
      uintWord(HEAD + BigInt(data.length)),
      data,
      dynamicBytes(signatures),
    ),
  );
}

function word(data: Hex): bigint | undefined {
  return data.length === 66 ? uintOf(data) : undefined;
}

function addressList(data: Hex): Address[] | undefined {
  const count = data.length >= 130 ? uintOf(data, 1) : undefined;
  if (count === undefined || uintOf(data, 0) !== 32n || BigInt(data.length) !== 130n + count * 64n) return undefined;
  const items = Array.from({ length: Number(count) }, (_, i) => `0x${data.slice(2 + (i + 2) * 64, 2 + (i + 3) * 64)}` as Hex);
  return items.every((item) => item.startsWith('0x000000000000000000000000')) ? items.map(addressOf) : undefined;
}

type Read = { readonly what: string; readonly call: SimulationCall };

type Measured = { readonly tokens: readonly Address[]; readonly allowances: readonly Allowance[]; readonly permit2: readonly Allowance[] };

function readsOf(safe: Address, from: Address, { tokens, allowances, permit2 }: Measured): Read[] {
  const read = (what: string, to: Address, data: Uint8Array): Read => ({ what, call: { from, to, data: hex(data), gas: READ_GAS } });
  return [
    read('the ETH balance', ETH_BALANCE_READER, bytesOf(safe)),
    ...tokens.map((token) => read(`balanceOf at ${token}`, token, concatBytes(selector('balanceOf(address)'), addressWord(safe)))),
    ...allowances.map(({ token, spender }) =>
      read(`allowance to ${spender} at ${token}`, token, concatBytes(selector('allowance(address,address)'), addressWord(safe), addressWord(spender))),
    ),
    ...permit2.map(({ token, spender }) =>
      read(
        `Permit2 allowance of ${token} to ${spender}`,
        PERMIT2,
        concatBytes(selector('allowance(address,address,address)'), addressWord(safe), addressWord(token), addressWord(spender)),
      ),
    ),
  ];
}

export function permit2AllowanceOf(data: Hex): Permit2Allowance | undefined {
  return data.length === 2 + 3 * 64 ? { amount: uintOf(data, 0), expiration: uintOf(data, 1), nonce: uintOf(data, 2) } : undefined;
}

/** Who sent the transaction: a Safe through `execTransaction`, or an EOA making the one call itself. */
export type Sender = 'safe' | 'eoa';

type Executor = {
  /** The `from` of every read around the transaction. */
  readonly sender: Address;
  readonly exec: (tx: SafeTx) => SimulationCall;
  readonly execution: (call: SimulatedCall, tx: SafeTx) => Execution;
  readonly block: (txs: readonly SafeTx[]) => Omit<SimulationRequest, 'calls'>;
  /** Set when a reverted run may not be the transaction's own revert, with why. */
  readonly revertUnsure?: string;
  /** The calls that read the sender's settings, and the evidence their results before and after give, or what could not be read. */
  readonly settings: {
    readonly calls: readonly SimulationCall[];
    readonly evidence: (before: readonly SimulatedCall[], after: readonly SimulatedCall[]) => SafeStateEvidence | string;
  };
};

type ExecutorInput = { readonly tx: SafeTx; readonly parent: BlockHeader; readonly time: bigint };

const blockOf = (input: ExecutorInput, overrides: SimulationRequest['stateOverrides']): Omit<SimulationRequest, 'calls'> => ({
  block: { number: input.parent.number + 1n, time: input.time, gasLimit: input.parent.gasLimit, prevRandao: input.parent.mixHash },
  stateOverrides: { ...overrides, [ETH_BALANCE_READER]: { code: ETH_BALANCE_READER_CODE } },
});

async function safeExecutor(reader: Reader, input: ExecutorInput): Promise<Executor | { readonly reasons: readonly string[] }> {
  const { tx, parent } = input;
  const safe = tx.safe;
  const problems: string[] = [];
  const view = async <T>(signature: string, decode: (data: Hex) => T | undefined): Promise<T | undefined> => {
    const read = await reader.call({ to: safe, data: selectorOf(signature) }, parent);
    const value = read.kind === 'agreed' && read.value.kind === 'returned' ? decode(read.value.data) : undefined;
    if (value === undefined) problems.push(read.kind === 'unverifiable' ? read.reason : `the Safe gave no ${signature}`);
    return value;
  };
  const [owners, threshold, nonce] = await Promise.all([view('getOwners()', addressList), view('getThreshold()', word), view('nonce()', word)]);
  if (owners === undefined || threshold === undefined || nonce === undefined) return { reasons: problems };
  if (nonce !== tx.nonce) return { reasons: [`the Safe's nonce at block ${parent.number} is ${nonce}, the transaction's is ${tx.nonce}`] };
  if (threshold < 1n || threshold > BigInt(owners.length)) return { reasons: [`the Safe's threshold ${threshold} does not fit its ${owners.length} owners`] };

  const approvers = [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).slice(0, Number(threshold));
  const sender = approvers[0] as Address;
  const one = `0x${'1'.padStart(64, '0')}` as Hex;
  const parsed = (results: readonly SimulatedCall[], when: string): SafeState | string => {
    const state = parseSafeState(results, tx.version);
    return 'unreadable' in state ? `the Safe's ${state.unreadable} could not be read ${when} the transaction` : state;
  };
  return {
    sender,
    exec: (each) => ({ from: sender, to: safe, data: execTransactionData(each, approvers), gas: EXEC_GAS }),
    execution: (call, each) => {
      if (call.status === 'reverted') return 'reverted';
      const execution = executionOf(call.logs, safe, hashSafeTx(each).safeTxHash);
      return execution === 'success' && word(call.returnData) !== 1n ? 'execution-failure' : execution;
    },
    block: (txs) =>
      blockOf(input, {
        [safe]: { stateDiff: Object.fromEntries(txs.flatMap((each) => approvers.map((owner) => [approvedHashSlot(owner, hashSafeTx(each).safeTxHash), one]))) },
      }),
    settings: {
      calls: safeStateCalls(safe, sender, tx.version),
      evidence: (beforeCalls, afterCalls) => {
        const [before, after] = [parsed(beforeCalls, 'before'), parsed(afterCalls, 'after')];
        return typeof before === 'string' ? before : typeof after === 'string' ? after : { kind: 'read', before, after };
      },
    },
  };
}

/**
 * Set by state override at the EOA when its call sends ETH, which a simulated call cannot carry: called by the EOA
 * itself, it CALLs the address in the first calldata word with the ETH value in the second and the rest of the
 * calldata, and returns or reverts with its answer; called by anyone else, it stops, as an EOA takes any call. So the
 * target sees the EOA as `msg.sender` and `tx.origin`, the value leaves the EOA's own balance, and no gas does.
 */
const EOA_FORWARDER_CODE = '0x333014600757005b60403603806040600037600060008260006020356000355af13d600060003e602e573d6000fd5b3d6000f3' as Hex;

/**
 * An EOA's one call. Without ETH it is sent from the EOA as it is, with no override, so the EOA has no code, as on
 * chain. With ETH it runs through the forwarder, which gives the EOA code for that block. A contract can read that
 * code: an ERC-1271 signature check, an ERC-721, ERC-1155 or ERC-777 receiver hook, or a guard on the caller's code
 * size then takes another path than for an EOA, so a forwarded call that reverts is unverifiable, not reverted.
 */
function eoaExecutor(input: ExecutorInput): Executor | { readonly reasons: readonly string[] } {
  const { tx } = input;
  const eoa = tx.safe;
  if (tx.operation !== 0) return { reasons: ['an EOA makes a call, never a delegatecall'] };
  if (tx.to === eoa) return { reasons: ["an EOA's call to itself is not simulated"] };
  const forwarded = tx.value > 0n;
  return {
    sender: eoa,
    exec: (each) =>
      forwarded
        ? { from: eoa, to: eoa, data: hex(concatBytes(addressWord(each.to), uintWord(each.value), bytesOf(each.data))), gas: EXEC_GAS }
        : { from: eoa, to: each.to, data: each.data, gas: EXEC_GAS },
    execution: (call) => (call.status === 'reverted' ? 'reverted' : 'success'),
    ...(forwarded ? { revertUnsure: "the EOA's call sends ETH, so it ran through a forwarder that gives the EOA code a contract may read, and its revert may come from that code" } : {}),
    block: () => blockOf(input, forwarded ? { [eoa]: { code: EOA_FORWARDER_CODE } } : {}),
    settings: { calls: [], evidence: () => ({ kind: 'not-a-safe' }) },
  };
}

const executorFor = (sender: Sender, reader: Reader, input: ExecutorInput): Promise<Executor | { readonly reasons: readonly string[] }> =>
  sender === 'safe' ? safeExecutor(reader, input) : Promise.resolve(eoaExecutor(input));

/**
 * Runs the Safe transaction on both providers. A first run finds the tokens, allowances and Permit2 allowances the
 * transaction touches; a second reads each of them, and the Safe's own settings, just before and just after it, in the
 * same block.
 */
export const simulateSafeTx = (reader: Reader, input: SimulationInput): Promise<Observation> => simulateTx('safe', reader, input);

/**
 * `simulateSafeTx` for either sender. An EOA's transaction is its one call, `tx.safe` the EOA: its effects are read on
 * the EOA as a Safe's are on the Safe, and its evidence of settings is `not-a-safe`, since an EOA has none to read.
 */
export async function simulateTx(sender: Sender, reader: Reader, input: SimulationInput): Promise<Observation> {
  const { tx } = input;
  const safe = tx.safe;
  const unverifiable = (...reasons: string[]): Observation => ({ kind: 'unverifiable', reasons });
  const executor = await executorFor(sender, reader, input);
  if ('reasons' in executor) return unverifiable(...executor.reasons);
  const exec = executor.exec(tx);
  const base = executor.block([tx]);

  const discovery = await reader.simulateV1({ ...base, calls: [exec] }, input.parent);
  if (discovery.kind === 'unverifiable') return unverifiable(discovery.reason);
  const alone = discovery.value[0] as SimulatedCall;
  const execution = executor.execution(alone, tx);
  if (execution === 'reverted' && executor.revertUnsure !== undefined) return unverifiable(executor.revertUnsure);
  if (execution !== 'success') return { kind: 'observed', observed: { kind: 'not-executed', why: execution }, logs: alone.logs };

  const touched = touchedBy(alone.logs, safe);
  const tokens = [...new Set([...input.watch, ...input.ends, ...touched.tokens])];
  const allowances = [...touched.approvals.values()];
  const permit2 = [...touched.permit2.values()];
  const reads = readsOf(safe, executor.sender, { tokens, allowances, permit2 });
  const stateCalls = executor.settings.calls;
  const views = input.views ?? [];
  const viewReads = views.map(({ to, data }) => ({ from: executor.sender, to: STATIC_READER, data: `0x${bytesToHex(concatBytes(addressWord(to), bytesOf(data)))}` as Hex, gas: VIEW_GAS }));
  const around = [...reads.map((r) => r.call), ...stateCalls, ...viewReads];
  const overrides = views.length === 0 ? base.stateOverrides : { ...base.stateOverrides, [STATIC_READER]: { code: STATIC_READER_CODE } };
  const measured = await reader.simulateV1({ ...base, stateOverrides: overrides, calls: [...around, exec, ...around] }, input.parent);
  if (measured.kind === 'unverifiable') return unverifiable(measured.reason);
  const calls = measured.value;
  const run = calls[around.length] as SimulatedCall;
  if (executor.execution(run, tx) !== 'success') return unverifiable('the transaction executed alone but not between the balance reads');
  const unmeasured = unmeasuredBy(touchedBy(run.logs, safe), touched, tokens);
  if (unmeasured.length > 0) return unverifiable(`between the balance reads the transaction touched what it did not touch alone: ${unmeasured.join(', ')}`);

  const after0 = around.length + 1;
  const returned: { readonly before: Hex; readonly after: Hex }[] = [];
  for (const [i, read] of reads.entries()) {
    const [before, after] = [calls[i], calls[after0 + i]];
    if (before?.status !== 'success' || after?.status !== 'success') return unverifiable(`${read.what} could not be read`);
    returned.push({ before: before.returnData, after: after.returnData });
  }
  const words: { readonly before: bigint; readonly after: bigint }[] = [];
  for (const [i, { before, after }] of returned.slice(0, 1 + tokens.length + allowances.length).entries()) {
    const [b, a] = [word(before), word(after)];
    if (b === undefined || a === undefined) return unverifiable(`${(reads[i] as Read).what} could not be read`);
    words.push({ before: b, after: a });
  }
  const permit2Changes: Permit2Change[] = [];
  for (const [i, { before, after }] of returned.slice(words.length).entries()) {
    const [b, a] = [permit2AllowanceOf(before), permit2AllowanceOf(after)];
    if (b === undefined || a === undefined) return unverifiable(`${(reads[words.length + i] as Read).what} could not be read`);
    permit2Changes.push({ ...(permit2[i] as Allowance), before: b, after: a });
  }
  const viewsAt = reads.length + stateCalls.length;
  const safeState = executor.settings.evidence(calls.slice(reads.length, viewsAt), calls.slice(after0 + reads.length, after0 + viewsAt));
  if (typeof safeState === 'string') return unverifiable(safeState);
  const before = (i: number) => (words[i] as { before: bigint }).before;
  const after = (i: number) => (words[i] as { after: bigint }).after;
  const eth = after(0) - before(0);
  const traced = run.logs.filter(isEthTransfer).reduce((sum, log) => {
    const amount = uintOf(log.data);
    return sum + (namesAddress(log.topics[2], safe) ? amount : 0n) - (namesAddress(log.topics[1], safe) ? amount : 0n);
  }, 0n);
  if (traced !== eth) return unverifiable(`the Safe's ETH balance changed by ${eth}, its traced ETH transfers by ${traced}`);
  const allowanceChanges: AllowanceChange[] = allowances.map((a, i) => ({ ...a, before: before(1 + tokens.length + i), after: after(1 + tokens.length + i) }));
  const answer = (call: SimulatedCall | undefined): ViewAnswer =>
    call?.status === 'success' ? { kind: 'returned', data: call.returnData } : { kind: 'unread', why: 'it reverted in the simulated block, read by STATICCALL: it failed, or it wrote state or emitted a log' };
  const viewReadings: ViewReading[] = views.map((view, i) => ({ ...view, before: answer(calls[viewsAt + i]), after: answer(calls[after0 + viewsAt + i]), readIn: 'simulation' }));
  return {
    kind: 'observed',
    observed: {
      kind: 'executed',
      eth,
      tokens: new Map(tokens.map((token, i) => [token, after(1 + i) - before(1 + i)])),
      allowances: allowanceChanges,
      permit2: permit2Changes,
      ends: new Map(input.ends.map((token) => [token, after(1 + tokens.indexOf(token))])),
      safeState,
      ...(views.length === 0 ? {} : { views: viewReadings }),
    },
    logs: run.logs,
  };
}

function unmeasuredBy(again: Touched, first: Touched, tokens: readonly Address[]): string[] {
  return [
    ...[...again.tokens].filter((t) => !tokens.includes(t)),
    ...[...again.approvals.keys()].filter((k) => !first.approvals.has(k)),
    ...[...again.permit2.keys()].filter((k) => !first.permit2.has(k)).map((k) => `Permit2 ${k}`),
  ];
}

export type SafeCall = { readonly path: string; readonly to: Address; readonly selector: Hex | undefined };

/**
 * Which of the Safe's calls moved none of its assets: no ETH, no token balance, no allowance and no Permit2 allowance
 * of the Safe's changed across it.
 */
export type CallScan =
  | { readonly kind: 'scanned'; readonly movesNothing: readonly SafeCall[] }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

/**
 * Runs each call of the Safe transaction, MultiSend unwrapped, as a Safe transaction of its own through
 * `execTransaction`, one after another in one block on the given parent, and reads everything any of them touched
 * between each two. A call to the Safe itself without data is left out.
 */
export const scanCalls = (reader: Reader, input: Omit<SimulationInput, 'ends' | 'views'>): Promise<CallScan> => scanCallsOf('safe', reader, input);

/** `scanCalls` for either sender; an EOA's transaction is its one call. */
export async function scanCallsOf(sender: Sender, reader: Reader, input: Omit<SimulationInput, 'ends' | 'views'>): Promise<CallScan> {
  const { tx } = input;
  const safe = tx.safe;
  const unverifiable = (...reasons: string[]): CallScan => ({ kind: 'unverifiable', reasons });
  const unwrapped = unwrapSafeTx(tx);
  if (unwrapped.kind !== 'direct' && unwrapped.kind !== 'multisend') return unverifiable('the transaction does not unwrap into calls');
  const inner = unwrapped.calls;
  const txs = inner.map((call, i): SafeTx => ({ ...tx, to: call.to, value: call.value, data: hex(regionBytes(call.data)), operation: call.operation, nonce: tx.nonce + BigInt(i) }));
  const executor = await executorFor(sender, reader, input);
  if ('reasons' in executor) return unverifiable(...executor.reasons);
  const base = executor.block(txs);
  const execs = txs.map(executor.exec);
  const failed = (run: readonly SimulatedCall[], at: (i: number) => number): string | undefined => {
    const i = txs.findIndex((each, n) => executor.execution(run[at(n)] as SimulatedCall, each) !== 'success');
    return i === -1 ? undefined : `${inner[i]?.path} did not execute as a Safe transaction of its own`;
  };

  const discovery = await reader.simulateV1({ ...base, calls: execs }, input.parent);
  if (discovery.kind === 'unverifiable') return unverifiable(discovery.reason);
  const discoveryFailed = failed(discovery.value, (i) => i);
  if (discoveryFailed !== undefined) return unverifiable(discoveryFailed);
  const touched = touchedBy(discovery.value.flatMap((call) => call.logs), safe);
  const tokens = [...new Set([...input.watch, ...touched.tokens])];
  const reads = readsOf(safe, executor.sender, { tokens, allowances: [...touched.approvals.values()], permit2: [...touched.permit2.values()] }).map((r) => r.call);
  const stride = reads.length + 1;
  const measured = await reader.simulateV1({ ...base, calls: [...execs.flatMap((exec) => [...reads, exec]), ...reads] }, input.parent);
  if (measured.kind === 'unverifiable') return unverifiable(measured.reason);
  const run = measured.value;
  const measuredFailed = failed(run, (i) => i * stride + reads.length);
  if (measuredFailed !== undefined) return unverifiable(measuredFailed);
  const unmeasured = unmeasuredBy(touchedBy(run.flatMap((call) => call.logs), safe), touched, tokens);
  if (unmeasured.length > 0) return unverifiable(`between the reads the calls touched what they did not touch alone: ${unmeasured.join(', ')}`);
  const snapshot = (i: number): string | undefined => {
    const block = run.slice(i * stride, i * stride + reads.length);
    return block.every((call) => call.status === 'success') ? block.map((call) => call.returnData).join() : undefined;
  };
  const movesNothing: SafeCall[] = [];
  for (const [i, call] of inner.entries()) {
    const [before, after] = [snapshot(i), snapshot(i + 1)];
    if (before === undefined || after === undefined) return unverifiable(`the Safe's assets could not be read around ${call.path}`);
    const data = regionBytes(call.data);
    const toSafeReceive = call.to === safe && data.length === 0;
    if (before !== after || toSafeReceive) continue;
    movesNothing.push({ path: call.path, to: call.to, selector: data.length >= 4 ? hex(data.subarray(0, 4)) : undefined });
  }
  return { kind: 'scanned', movesNothing };
}

export function describeCallScan(scan: CallScan, registry: Registry): string[] {
  if (scan.kind === 'unverifiable') return [`Which calls move no asset of the Safe could not be read: ${scan.reasons.join('; ')}`];
  if (scan.movesNothing.length === 0) return ['Every call moves an asset of the Safe.'];
  return [
    'These calls move no asset of the Safe. Whatever they do changes a setting or grants a permission:',
    ...scan.movesNothing.map(({ path, to, selector }) => {
      const name = registry.byAddress.get(to)?.name ?? 'unregistered';
      return `  ${path} to ${name} ${to}, ${selector === undefined ? 'no data' : `selector ${selector}`}`;
    }),
  ];
}
