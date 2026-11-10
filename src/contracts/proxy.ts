import type { Read, Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import type { Address, Hex } from '../safe/types.ts';

export const EIP1967_IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbcn;
export const EIP1967_BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50n;
const IMPLEMENTATION_CALL = '0x5c60da1b' as Hex;

const EIP1167_HEAD = '0x363d3d373d3d3d363d73';
const EIP1167_TAIL = '5af43d82803e903d91602b57fd5bf3';

export type SafeProxyName = 'Proxy 1.0.0' | 'Proxy 1.1.1' | 'GnosisSafeProxy 1.3.0' | 'SafeProxy 1.4.1' | 'SafeProxy 1.5.0';

/**
 * The runtime code each official Safe proxy factory deploys, as read from Safes these factories created
 * (`testdata/safe-proxy/`). The proxy keeps its singleton in slot 0 and delegates every call to it, except
 * `masterCopy()` from 1.1.1 on.
 */
const SAFE_PROXY_CODE: ReadonlyMap<string, SafeProxyName> = new Map([
  [
    '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054163660008037600080366000845af43d6000803e6000811415603d573d6000fd5b3d6000f3fea165627a7a723058201e7d648b83cfac072cbccefc2ffc62a6999d4a050ee87a721942de1da9670db80029',
    'Proxy 1.0.0',
  ],
  [
    '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea265627a7a72315820d8a00dc4fe6bf675a9d7416fc2d00bb3433362aa8186b750f76c4027269667ff64736f6c634300050e0032',
    'Proxy 1.1.1',
  ],
  [
    '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2646970667358221220d1429297349653a4918076d650332de1a1068c5f3e07c5c82360c277770b955264736f6c63430007060033',
    'GnosisSafeProxy 1.3.0',
  ],
  [
    '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033',
    'SafeProxy 1.4.1',
  ],
  [
    '0x608060405260005463a619486e60003560e01c14156024578060601b606c5260206060f35b3660008037600080366000845af43d6000803e806040573d6000fd5b3d6000f3fea2646970667358221220e61834ebd2d8cd909d362bf67c47ef58fd665df38e6dd036ce65611101d072e964736f6c63430007060033',
    'SafeProxy 1.5.0',
  ],
]);

export type Proxy =
  | { readonly kind: 'none' }
  | { readonly kind: 'eip1967'; readonly implementation: Address }
  | { readonly kind: 'eip1967-beacon'; readonly beacon: Address; readonly implementation: Address }
  | { readonly kind: 'eip1167'; readonly implementation: Address }
  | { readonly kind: 'safe'; readonly factory: SafeProxyName; readonly implementation: Address };

export type ProxyRefusal =
  | { readonly why: 'unverifiable'; readonly read: string }
  | { readonly why: 'slot-not-an-address'; readonly slot: 'eip1967-implementation' | 'eip1967-beacon' | 'safe-singleton' }
  | { readonly why: 'beacon-answer-not-an-address'; readonly beacon: Address }
  | { readonly why: 'both-eip1967-slots-set' }
  | { readonly why: 'slot-without-delegatecall' };

export type Located = { readonly kind: 'located'; readonly proxy: Proxy } | { readonly kind: 'refused'; readonly refusal: ProxyRefusal };

const DELEGATECALL = 0xf4;
const PUSH1 = 0x60;
const PUSH32 = 0x7f;

/** Walks opcodes so push data is skipped, and stops at Solidity's CBOR metadata, whose length is its last two bytes. */
export function hasDelegatecall(code: Hex): boolean {
  const bytes = Buffer.from(code.slice(2), 'hex');
  const trailer = bytes.length >= 2 ? (bytes[bytes.length - 2] ?? 0) * 256 + (bytes[bytes.length - 1] ?? 0) + 2 : 0;
  const end = trailer <= bytes.length && (bytes[bytes.length - trailer] ?? 0) >= 0xa0 ? bytes.length - trailer : bytes.length;
  for (let at = 0; at < end; at++) {
    const op = bytes[at] ?? 0;
    if (op === DELEGATECALL) return true;
    if (op >= PUSH1 && op <= PUSH32) at += op - PUSH1 + 1;
  }
  return false;
}

export function minimalProxyTarget(code: Hex): Address | undefined {
  if (code.length !== 2 + 45 * 2 || !code.startsWith(EIP1167_HEAD) || !code.endsWith(EIP1167_TAIL)) return undefined;
  return `0x${code.slice(EIP1167_HEAD.length, EIP1167_HEAD.length + 40)}` as Address;
}

export function safeProxyFactory(code: Hex): SafeProxyName | undefined {
  return SAFE_PROXY_CODE.get(code);
}

/** A 32-byte word holding an address, with the 12 high bytes zero. Zero itself is `null`. */
function addressWord(word: Hex): Address | null | undefined {
  if (word.length !== 66 || !/^0x0{24}/.test(word)) return undefined;
  const address = `0x${word.slice(26)}` as Address;
  return /^0x0{40}$/.test(address) ? null : address;
}

const unverifiable = (read: Read<unknown> & { kind: 'unverifiable' }): Located => ({
  kind: 'refused',
  refusal: { why: 'unverifiable', read: read.reason },
});
const refused = (refusal: ProxyRefusal): Located => ({ kind: 'refused', refusal });

/**
 * Which code a call to `address` runs. A minimal proxy and a Safe proxy are known by their whole code. An EIP-1967
 * slot counts only when the code can DELEGATECALL, since a slot is storage that any code may have written.
 */
export async function locate(reader: Reader, address: Address, code: Hex, at: BlockRef): Promise<Located> {
  const clone = minimalProxyTarget(code);
  if (clone !== undefined) return { kind: 'located', proxy: { kind: 'eip1167', implementation: clone } };
  const factory = safeProxyFactory(code);
  if (factory !== undefined) {
    const slot = await reader.getStorageAt(address, 0n, at);
    if (slot.kind === 'unverifiable') return unverifiable(slot);
    const singleton = addressWord(slot.value);
    if (singleton == null) return refused({ why: 'slot-not-an-address', slot: 'safe-singleton' });
    return { kind: 'located', proxy: { kind: 'safe', factory, implementation: singleton } };
  }
  const [implementationSlot, beaconSlot] = await Promise.all([
    reader.getStorageAt(address, EIP1967_IMPLEMENTATION_SLOT, at),
    reader.getStorageAt(address, EIP1967_BEACON_SLOT, at),
  ]);
  if (implementationSlot.kind === 'unverifiable') return unverifiable(implementationSlot);
  if (beaconSlot.kind === 'unverifiable') return unverifiable(beaconSlot);
  const implementation = addressWord(implementationSlot.value);
  const beacon = addressWord(beaconSlot.value);
  if (implementation === undefined) return refused({ why: 'slot-not-an-address', slot: 'eip1967-implementation' });
  if (beacon === undefined) return refused({ why: 'slot-not-an-address', slot: 'eip1967-beacon' });
  if (implementation !== null) {
    if (beacon !== null) return refused({ why: 'both-eip1967-slots-set' });
    if (!hasDelegatecall(code)) return refused({ why: 'slot-without-delegatecall' });
    return { kind: 'located', proxy: { kind: 'eip1967', implementation } };
  }
  if (beacon === null) return { kind: 'located', proxy: { kind: 'none' } };
  if (!hasDelegatecall(code)) return refused({ why: 'slot-without-delegatecall' });
  const answer = await reader.call({ to: beacon, data: IMPLEMENTATION_CALL }, at);
  if (answer.kind === 'unverifiable') return unverifiable(answer);
  const behind = answer.value.kind === 'returned' ? addressWord(answer.value.data) : undefined;
  if (behind == null) return refused({ why: 'beacon-answer-not-an-address', beacon });
  return { kind: 'located', proxy: { kind: 'eip1967-beacon', beacon, implementation: behind } };
}
