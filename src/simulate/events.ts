import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { EventLog } from '../chain/types.ts';
import type { Address, Hex } from '../safe/types.ts';

export const topic = (signature: string): Hex => `0x${bytesToHex(keccak_256(utf8ToBytes(signature)))}` as Hex;

export const TRANSFER = topic('Transfer(address,address,uint256)');
export const APPROVAL = topic('Approval(address,address,uint256)');
export const EXECUTION_SUCCESS = topic('ExecutionSuccess(bytes32,uint256)');
export const EXECUTION_FAILURE = topic('ExecutionFailure(bytes32,uint256)');
export const SAFE_RECEIVED = topic('SafeReceived(address,uint256)');

/** `traceTransfers` reports each ETH move as a `Transfer` logged from this address. */
export const ETH_TRANSFER_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address;

export const wordOf = (address: Address): Hex => `0x${address.slice(2).padStart(64, '0')}` as Hex;
export const addressOf = (word: Hex): Address => `0x${word.slice(26)}` as Address;

/** Low 20 bytes only, so a word with dirty high bytes still names the Safe and gets measured. */
export const namesAddress = (word: Hex | undefined, address: Address): boolean => word?.slice(26) === address.slice(2);

export const uintOf = (data: Hex, word = 0): bigint => BigInt(`0x${data.slice(2 + word * 64, 2 + (word + 1) * 64) || '0'}`);

export const isEthTransfer = (log: EventLog): boolean =>
  log.address === ETH_TRANSFER_ADDRESS && log.topics[0] === TRANSFER && log.topics.length === 3;

export type Touched = { readonly tokens: ReadonlySet<Address>; readonly approvals: ReadonlyMap<string, Allowance> };
export type Allowance = { readonly token: Address; readonly spender: Address };

export const allowanceKey = ({ token, spender }: Allowance): string => `${token}/${spender}`;

/** Every token whose `Transfer` names the Safe on either side, and every allowance an `Approval` from the Safe sets. */
export function touchedBy(logs: readonly EventLog[], safe: Address): Touched {
  const tokens = new Set<Address>();
  const approvals = new Map<string, Allowance>();
  for (const log of logs) {
    if (isEthTransfer(log)) continue;
    const [first, a, b] = log.topics;
    if (first === TRANSFER && (namesAddress(a, safe) || namesAddress(b, safe))) tokens.add(log.address);
    if (first === APPROVAL && namesAddress(a, safe) && b !== undefined) {
      const allowance = { token: log.address, spender: addressOf(b) };
      approvals.set(allowanceKey(allowance), allowance);
    }
  }
  return { tokens, approvals };
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
