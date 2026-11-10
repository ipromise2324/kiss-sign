import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { EventLog, SimulatedCall, SimulationCall } from '../chain/types.ts';
import { selectorOf } from '../decode/abi.ts';
import { uintWord } from '../decode/codec.ts';
import type { Address, Hex, SafeVersion } from '../safe/types.ts';
import { addressOf, uintOf } from './events.ts';

/**
 * The settings a Safe transaction must never change. Storage slots are kept as raw 32-byte words, so a change in
 * bytes an address would ignore still shows.
 */
export type SafeState = {
  readonly singleton: Hex;
  readonly threshold: bigint;
  readonly owners: readonly Address[];
  readonly modules: readonly Address[];
  readonly guard: Hex;
  /** Safe 1.5.0 only. */
  readonly moduleGuard: Hex | undefined;
  readonly fallbackHandler: Hex;
};

export type SafeStateField = keyof SafeState;

/**
 * How a transaction's effect on the Safe's settings was observed: read before and after it inside one simulated block,
 * or, for an executed transaction, the receipt's logs.
 */
export type SafeStateEvidence =
  | { readonly kind: 'read'; readonly before: SafeState; readonly after: SafeState }
  | { readonly kind: 'receipt'; readonly logs: readonly EventLog[] };

/** Slot constants from safe-global/safe-smart-account v1.3.0, v1.4.1 and v1.5.0; `singleton` is the first state variable. */
export const SLOTS = {
  singleton: 0n,
  // keccak256("guard_manager.guard.address"), GuardManager.sol
  guard: 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n,
  // keccak256("module_manager.module_guard.address"), ModuleManager.sol, 1.5.0
  moduleGuard: 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947n,
  // keccak256("fallback_manager.handler.address"), FallbackManager.sol
  fallbackHandler: 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5n,
} as const;

const SENTINEL = '0x0000000000000000000000000000000000000001' as Address;
const MODULE_PAGE = 50n;
const READ_GAS = 100_000n;

const hex = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}` as Hex;
const selector = (signature: string): Uint8Array => hexToBytes(selectorOf(signature).slice(2));

const wordAt = (data: Hex, i: number): Hex => `0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}` as Hex;
const words = (data: Hex): number => (data.length - 2) / 64;

/** `getStorageAt(slot, 1)` returns `bytes` of one word. */
function storageWord(data: Hex): Hex | undefined {
  return words(data) === 3 && uintOf(data, 0) === 32n && uintOf(data, 1) === 32n ? wordAt(data, 2) : undefined;
}

function addressArray(data: Hex, offsetWord: number): Address[] | undefined {
  const offset = uintOf(data, offsetWord);
  if (offset % 32n !== 0n) return undefined;
  const at = Number(offset / 32n);
  const count = at < words(data) ? uintOf(data, at) : undefined;
  if (count === undefined || at + 1 + Number(count) !== words(data)) return undefined;
  const items = Array.from({ length: Number(count) }, (_, i) => wordAt(data, at + 1 + i));
  return items.every((item) => item.startsWith('0x000000000000000000000000')) ? items.map(addressOf) : undefined;
}

const ownersOf = (data: Hex): Address[] | undefined => (words(data) >= 2 && uintOf(data, 0) === 32n ? addressArray(data, 0) : undefined);

/** `(address[] array, address next)`: the whole list only when `next` is the sentinel, the end of the list. */
function modulesOf(data: Hex): Address[] | undefined {
  if (words(data) < 3 || uintOf(data, 0) !== 64n || wordAt(data, 1) !== `0x${SENTINEL.slice(2).padStart(64, '0')}`) return undefined;
  return addressArray(data, 0);
}

const thresholdOf = (data: Hex): bigint | undefined => (words(data) === 1 ? uintOf(data) : undefined);

type StateRead = { readonly field: SafeStateField; readonly data: Uint8Array; readonly decode: (data: Hex) => unknown };

const storage = (field: SafeStateField, slot: bigint): StateRead => ({
  field,
  data: concatBytes(selector('getStorageAt(uint256,uint256)'), uintWord(slot), uintWord(1n)),
  decode: storageWord,
});

function stateReads(version: SafeVersion): StateRead[] {
  return [
    storage('singleton', SLOTS.singleton),
    { field: 'threshold', data: selector('getThreshold()'), decode: thresholdOf },
    { field: 'owners', data: selector('getOwners()'), decode: ownersOf },
    {
      field: 'modules',
      data: concatBytes(selector('getModulesPaginated(address,uint256)'), uintWord(BigInt(SENTINEL)), uintWord(MODULE_PAGE)),
      decode: modulesOf,
    },
    storage('guard', SLOTS.guard),
    ...(version === '1.5.0' ? [storage('moduleGuard', SLOTS.moduleGuard)] : []),
    storage('fallbackHandler', SLOTS.fallbackHandler),
  ];
}

/** Calls the Safe's own views, so reading its settings needs no state override. */
export function safeStateCalls(safe: Address, from: Address, version: SafeVersion): SimulationCall[] {
  return stateReads(version).map((read) => ({ from, to: safe, data: hex(read.data), gas: READ_GAS }));
}

/** The state from the results of `safeStateCalls`, in order, or the field that could not be read. */
export function parseSafeState(results: readonly SimulatedCall[], version: SafeVersion): SafeState | { readonly unreadable: SafeStateField } {
  const reads = stateReads(version);
  const state: Record<string, unknown> = {};
  for (const [i, read] of reads.entries()) {
    const result = results[i];
    const value = result?.status === 'success' ? read.decode(result.returnData) : undefined;
    if (value === undefined) return { unreadable: read.field };
    state[read.field] = value;
  }
  return { ...state, moduleGuard: state.moduleGuard } as SafeState;
}
