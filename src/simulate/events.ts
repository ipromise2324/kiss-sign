import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { EventLog } from '../chain/types.ts';
import type { Address, Hex } from '../safe/types.ts';

export const topic = (signature: string): Hex => `0x${bytesToHex(keccak_256(utf8ToBytes(signature)))}` as Hex;

export const TRANSFER = topic('Transfer(address,address,uint256)');
export const APPROVAL = topic('Approval(address,address,uint256)');
export const EXECUTION_SUCCESS = topic('ExecutionSuccess(bytes32,uint256)');
export const EXECUTION_FAILURE = topic('ExecutionFailure(bytes32,uint256)');

/** Uniswap's Permit2, at the same address on every chain. */
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as Address;
/** Permit2 events that index the owner, the token and the spender, in that order. */
export const PERMIT2_INDEXED = new Set<Hex>([
  topic('Approval(address,address,address,uint160,uint48)'),
  topic('Permit(address,address,address,uint160,uint48,uint48)'),
  topic('NonceInvalidation(address,address,address,uint48,uint48)'),
]);
/** Indexes only the owner; the token and the spender are its two data words. */
const PERMIT2_LOCKDOWN = topic('Lockdown(address,address,address)');

/** `traceTransfers` reports each ETH move as a `Transfer` logged from this address. */
export const ETH_TRANSFER_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address;

export const wordOf = (address: Address): Hex => `0x${address.slice(2).padStart(64, '0')}` as Hex;
export const addressOf = (word: Hex): Address => `0x${word.slice(26)}` as Address;

/** Low 20 bytes only, so a word with dirty high bytes still names the Safe and gets measured. */
export const namesAddress = (word: Hex | undefined, address: Address): boolean => word?.slice(26) === address.slice(2);

export const uintOf = (data: Hex, word = 0): bigint => BigInt(`0x${data.slice(2 + word * 64, 2 + (word + 1) * 64) || '0'}`);

export const isEthTransfer = (log: EventLog): boolean =>
  log.address === ETH_TRANSFER_ADDRESS && log.topics[0] === TRANSFER && log.topics.length === 3;

export type Touched = {
  readonly tokens: ReadonlySet<Address>;
  readonly approvals: ReadonlyMap<string, Allowance>;
  readonly permit2: ReadonlyMap<string, Allowance>;
};
export type Allowance = { readonly token: Address; readonly spender: Address };

export const allowanceKey = ({ token, spender }: Allowance): string => `${token}/${spender}`;

function permit2PairOf(log: EventLog, safe: Address): Allowance | undefined {
  const [first, owner, token, spender] = log.topics;
  if (log.address !== PERMIT2 || !namesAddress(owner, safe)) return undefined;
  if (first !== undefined && PERMIT2_INDEXED.has(first) && token !== undefined && spender !== undefined) {
    return { token: addressOf(token), spender: addressOf(spender) };
  }
  if (first === PERMIT2_LOCKDOWN && log.data.length >= 130) {
    const word = (i: number) => `0x${log.data.slice(2 + i * 64, 2 + (i + 1) * 64)}` as Hex;
    return { token: addressOf(word(0)), spender: addressOf(word(1)) };
  }
  return undefined;
}

/**
 * Every token whose `Transfer` names the Safe on either side, every allowance an `Approval` from the Safe sets, and
 * every Permit2 allowance of the Safe's a Permit2 event names.
 */
export function touchedBy(logs: readonly EventLog[], safe: Address): Touched {
  const tokens = new Set<Address>();
  const approvals = new Map<string, Allowance>();
  const permit2 = new Map<string, Allowance>();
  for (const log of logs) {
    const viaPermit2 = permit2PairOf(log, safe);
    if (viaPermit2 !== undefined) permit2.set(allowanceKey(viaPermit2), viaPermit2);
    if (isEthTransfer(log)) continue;
    const [first, a, b] = log.topics;
    if (first === TRANSFER && (namesAddress(a, safe) || namesAddress(b, safe))) tokens.add(log.address);
    if (first === APPROVAL && namesAddress(a, safe) && b !== undefined) {
      const allowance = { token: log.address, spender: addressOf(b) };
      approvals.set(allowanceKey(allowance), allowance);
    }
  }
  return { tokens, approvals, permit2 };
}

export type Execution = 'success' | 'reverted' | 'execution-failure' | 'other-safe-tx-hash' | 'no-execution-event' | 'several-safe-executions-in-one-transaction';

/**
 * A `delegatecall` runs in the Safe's context and can log a forged execution event from the Safe's address, so
 * anything but exactly one event is refused. Several events also come from one Ethereum transaction that executes several
 * Safe transactions; its receipt mixes their effects, so it cannot judge any one of them. Safe 1.3.0 logs the hash as data, 1.4.1 and later as an indexed topic.
 */
export function executionOf(logs: readonly EventLog[], safe: Address, safeTxHash: Hex): Execution {
  const events = logs.filter((log) => log.address === safe && (log.topics[0] === EXECUTION_SUCCESS || log.topics[0] === EXECUTION_FAILURE));
  const [event] = events;
  if (event === undefined) return 'no-execution-event';
  if (events.length > 1) return 'several-safe-executions-in-one-transaction';
  if (event.topics[0] === EXECUTION_FAILURE) return 'execution-failure';
  const hash = event.topics.length === 2 ? event.topics[1] : event.data.slice(0, 66);
  return hash === safeTxHash ? 'success' : 'other-safe-tx-hash';
}
