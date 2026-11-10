import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { BlockHeader, SimulatedCall, SimulationCall, SimulationRequest } from '../chain/types.ts';
import { selectorOf } from '../decode/abi.ts';
import { uintWord } from '../decode/codec.ts';
import { hashSafeTx } from '../safe/hash.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import type { AllowanceChange, Observed } from './effects.ts';
import { addressOf, executionOf, isEthTransfer, namesAddress, touchedBy, uintOf } from './events.ts';
import type { Allowance, Execution } from './events.ts';

export type Observation = { readonly kind: 'observed'; readonly observed: Observed } | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

export type SimulationInput = {
  readonly tx: SafeTx;
  /** The block the simulated block sits on. */
  readonly parent: BlockHeader;
  /** The simulated block's timestamp: the execution block's for an executed transaction, the next slot's otherwise. */
  readonly time: bigint;
  /** Tokens measured even if no log names the Safe, such as every token the card's effects name. */
  readonly watch: readonly Address[];
};

/** Safe 1.3.0 and 1.4.1: `mapping(address => mapping(bytes32 => uint256)) approvedHashes` is storage slot 8. */
const APPROVED_HASHES_SLOT = 8n;
/** EIP-7825 caps a transaction's gas at 2^24. */
const EXEC_GAS = 1n << 24n;
const READ_GAS = 100_000n;

/** Set by state override: returns the ETH balance of the address in the first 20 bytes of calldata. */
const ETH_BALANCE_READER = '0x000000000000000000000000000000000000ba1a' as Address;
const ETH_BALANCE_READER_CODE = '0x60003560601c3160005260206000f3' as Hex;

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

function readsOf(safe: Address, from: Address, tokens: readonly Address[], allowances: readonly Allowance[]): Read[] {
  const read = (what: string, to: Address, data: Uint8Array): Read => ({ what, call: { from, to, data: hex(data), gas: READ_GAS } });
  return [
    read('the ETH balance', ETH_BALANCE_READER, bytesOf(safe)),
    ...tokens.map((token) => read(`balanceOf at ${token}`, token, concatBytes(selector('balanceOf(address)'), addressWord(safe)))),
    ...allowances.map(({ token, spender }) =>
      read(`allowance to ${spender} at ${token}`, token, concatBytes(selector('allowance(address,address)'), addressWord(safe), addressWord(spender))),
    ),
  ];
}

function executionOfCall(call: SimulatedCall, safe: Address, safeTxHash: Hex): Execution {
  if (call.status === 'reverted') return 'reverted';
  const execution = executionOf(call.logs, safe, safeTxHash);
  return execution === 'success' && word(call.returnData) !== 1n ? 'execution-failure' : execution;
}

/**
 * Runs the Safe transaction through the Safe's own `execTransaction`, signed by approved hashes of the first `threshold`
 * owners, on both providers. A first run finds the tokens and allowances the transaction touches; a second reads each
 * of them just before and just after it, in the same block. The threshold and owners stay as they are on chain.
 */
export async function simulateSafeTx(reader: Reader, input: SimulationInput): Promise<Observation> {
  const { tx, parent } = input;
  const safe = tx.safe;
  const unverifiable = (...reasons: string[]): Observation => ({ kind: 'unverifiable', reasons });
  const problems: string[] = [];
  const view = async <T>(signature: string, decode: (data: Hex) => T | undefined): Promise<T | undefined> => {
    const read = await reader.call({ to: safe, data: selectorOf(signature) }, parent);
    const value = read.kind === 'agreed' && read.value.kind === 'returned' ? decode(read.value.data) : undefined;
    if (value === undefined) problems.push(read.kind === 'unverifiable' ? read.reason : `the Safe gave no ${signature}`);
    return value;
  };
  const [owners, threshold, nonce] = await Promise.all([view('getOwners()', addressList), view('getThreshold()', word), view('nonce()', word)]);
  if (owners === undefined || threshold === undefined || nonce === undefined) return unverifiable(...problems);
  if (nonce !== tx.nonce) return unverifiable(`the Safe's nonce at block ${parent.number} is ${nonce}, the transaction's is ${tx.nonce}`);
  if (threshold < 1n || threshold > BigInt(owners.length)) return unverifiable(`the Safe's threshold ${threshold} does not fit its ${owners.length} owners`);

  const { safeTxHash } = hashSafeTx(tx);
  const approvers = [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).slice(0, Number(threshold));
  const sender = approvers[0] as Address;
  const exec: SimulationCall = { from: sender, to: safe, data: execTransactionData(tx, approvers), gas: EXEC_GAS };
  const one = `0x${'1'.padStart(64, '0')}` as Hex;
  const base: Omit<SimulationRequest, 'calls'> = {
    block: { number: parent.number + 1n, time: input.time, gasLimit: parent.gasLimit, prevRandao: parent.mixHash },
    stateOverrides: {
      [safe]: { stateDiff: Object.fromEntries(approvers.map((owner) => [approvedHashSlot(owner, safeTxHash), one])) },
      [ETH_BALANCE_READER]: { code: ETH_BALANCE_READER_CODE },
    },
  };

  const discovery = await reader.simulateV1({ ...base, calls: [exec] }, parent);
  if (discovery.kind === 'unverifiable') return unverifiable(discovery.reason);
  const alone = discovery.value[0] as SimulatedCall;
  const execution = executionOfCall(alone, safe, safeTxHash);
  if (execution !== 'success') return { kind: 'observed', observed: { kind: 'not-executed', why: execution } };

  const touched = touchedBy(alone.logs, safe);
  const tokens = [...new Set([...input.watch, ...touched.tokens])];
  const allowances = [...touched.approvals.values()];
  const reads = readsOf(safe, sender, tokens, allowances);
  const measured = await reader.simulateV1({ ...base, calls: [...reads.map((r) => r.call), exec, ...reads.map((r) => r.call)] }, parent);
  if (measured.kind === 'unverifiable') return unverifiable(measured.reason);
  const calls = measured.value;
  const run = calls[reads.length] as SimulatedCall;
  if (executionOfCall(run, safe, safeTxHash) !== 'success') return unverifiable('the transaction executed alone but not between the balance reads');
  const again = touchedBy(run.logs, safe);
  const unmeasured: string[] = [...again.tokens].filter((t) => !tokens.includes(t));
  unmeasured.push(...[...again.approvals.keys()].filter((k) => !touched.approvals.has(k)));
  if (unmeasured.length > 0) return unverifiable(`between the balance reads the transaction touched what it did not touch alone: ${unmeasured.join(', ')}`);

  const values: bigint[] = [];
  for (const [i, call] of calls.entries()) {
    if (i === reads.length) continue;
    const read = reads[i < reads.length ? i : i - reads.length - 1] as Read;
    const value = call.status === 'success' ? word(call.returnData) : undefined;
    if (value === undefined) return unverifiable(`${read.what} could not be read`);
    values.push(value);
  }
  const before = (i: number) => values[i] as bigint;
  const after = (i: number) => values[reads.length + i] as bigint;
  const eth = after(0) - before(0);
  const traced = run.logs.filter(isEthTransfer).reduce((sum, log) => {
    const amount = uintOf(log.data);
    return sum + (namesAddress(log.topics[2], safe) ? amount : 0n) - (namesAddress(log.topics[1], safe) ? amount : 0n);
  }, 0n);
  if (traced !== eth) return unverifiable(`the Safe's ETH balance changed by ${eth}, its traced ETH transfers by ${traced}`);
  const allowanceChanges: AllowanceChange[] = allowances.map((a, i) => ({ ...a, before: before(1 + tokens.length + i), after: after(1 + tokens.length + i) }));
  return {
    kind: 'observed',
    observed: {
      kind: 'executed',
      eth,
      tokens: new Map(tokens.map((token, i) => [token, after(1 + i) - before(1 + i)])),
      allowances: allowanceChanges,
    },
  };
}
