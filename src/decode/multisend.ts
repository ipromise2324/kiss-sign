import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { Address, SafeTx } from '../safe/types.ts';
import { parseFunctionSignature } from './abi.ts';
import { decodeCall, regionBytes, requireCanonical, uintWord, wholeRegion } from './codec.ts';
import type { DecodeFailure, DecodedCall, Region, Span } from './codec.ts';

export type MultiSendDeployment = {
  readonly address: Address;
  readonly contract: 'MultiSend' | 'MultiSendCallOnly';
  readonly version: '1.3.0' | '1.4.1' | '1.5.0';
};

/** Mainnet addresses from github.com/safe-global/safe-deployments, `src/assets/v<version>/multi_send{,_call_only}.json`. */
export const OFFICIAL_MULTISEND: readonly MultiSendDeployment[] = [
  { address: '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761' as Address, contract: 'MultiSend', version: '1.3.0' },
  { address: '0x998739bfdaadde7c933b942a68053933098f9eda' as Address, contract: 'MultiSend', version: '1.3.0' },
  { address: '0x40a2accbd92bca938b02010e17a5b8929b49130d' as Address, contract: 'MultiSendCallOnly', version: '1.3.0' },
  { address: '0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b' as Address, contract: 'MultiSendCallOnly', version: '1.3.0' },
  { address: '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526' as Address, contract: 'MultiSend', version: '1.4.1' },
  { address: '0x9641d764fc13c8b624c04430c7356c1c7c8102e2' as Address, contract: 'MultiSendCallOnly', version: '1.4.1' },
  { address: '0x218543288004cd07832472d464648173c77d7eb7' as Address, contract: 'MultiSend', version: '1.5.0' },
  { address: '0xa83c336b20401af773b6219ba5027174338d1836' as Address, contract: 'MultiSendCallOnly', version: '1.5.0' },
];

export const MULTISEND = parseFunctionSignature('multiSend(bytes transactions)');

/** One call the Safe makes. `fields` locates `operation`, `to` and `value` in `data`; a direct call carries them outside it. */
export type InnerCall = {
  readonly path: string;
  readonly operation: 0 | 1;
  readonly to: Address;
  readonly value: bigint;
  readonly data: Region;
  readonly span: Span;
  readonly fields: { readonly operation: Span; readonly to: Span; readonly value: Span } | undefined;
};

export type Unwrapped =
  | { readonly kind: 'direct'; readonly calls: readonly [InnerCall] }
  | { readonly kind: 'multisend'; readonly deployment: MultiSendDeployment; readonly outer: DecodedCall; readonly calls: readonly InnerCall[] }
  /** A delegatecall to anything but an official MultiSend. It is not unwrapped; the floor rules refuse it. */
  | { readonly kind: 'foreign-delegatecall'; readonly to: Address };

const HEADER = 1 + 20 + 32 + 32;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}` as Address;

function packEntry(call: InnerCall): Uint8Array {
  const data = regionBytes(call.data);
  return concatBytes(new Uint8Array([call.operation]), hexToBytes(call.to.slice(2)), uintWord(call.value), uintWord(BigInt(data.length)), data);
}

/** Reads MultiSend's packed entries (uint8 operation, address to, uint256 value, uint256 dataLength, bytes data) and requires that packing them again gives `packed`. */
export function decodeMultiSendTransactions(packed: Region): readonly InnerCall[] | DecodeFailure {
  const { root, end } = packed;
  const calls: InnerCall[] = [];
  for (let at = packed.start; at < end; ) {
    if (at + HEADER > end) return { kind: 'malformed', at, problem: 'a MultiSend entry header runs past the end' };
    const operation = root[at];
    if (operation !== 0 && operation !== 1) return { kind: 'malformed', at, problem: 'a MultiSend operation that is neither 0 nor 1' };
    const length = BigInt(`0x${bytesToHex(root.subarray(at + 53, at + HEADER))}`);
    if (BigInt(at + HEADER) + length > BigInt(end)) return { kind: 'malformed', at: at + 53, problem: 'a MultiSend entry runs past the end' };
    const dataEnd = at + HEADER + Number(length);
    calls.push({
      path: `multiSend[${calls.length}]`,
      operation,
      to: `0x${bytesToHex(root.subarray(at + 1, at + 21))}` as Address,
      value: BigInt(`0x${bytesToHex(root.subarray(at + 21, at + 53))}`),
      data: { root, start: at + HEADER, end: dataEnd },
      span: [at, dataEnd],
      fields: { operation: [at, at + 1], to: [at + 1, at + 21], value: [at + 21, at + 53] },
    });
    at = dataEnd;
  }
  return requireCanonical(concatBytes(...calls.map(packEntry)), packed) ?? calls;
}

/**
 * The flat list of calls a Safe transaction makes. A call is one direct call; a delegatecall to an official MultiSend
 * is its packed entries, which must decode and repack byte for byte.
 */
export function unwrapSafeTx(tx: Pick<SafeTx, 'to' | 'value' | 'data' | 'operation'>): Unwrapped | DecodeFailure {
  const data = wholeRegion(hexToBytes(tx.data.slice(2)));
  if (tx.operation === 0) {
    const call: InnerCall = { path: 'call', operation: 0, to: tx.to, value: tx.value, data, span: [0, data.end], fields: undefined };
    return { kind: 'direct', calls: [call] };
  }
  const deployment = OFFICIAL_MULTISEND.find((d) => d.address === tx.to);
  if (deployment === undefined) return { kind: 'foreign-delegatecall', to: tx.to };
  const outer = decodeCall(MULTISEND, data);
  if (outer.kind !== 'decoded') return outer;
  const transactions = outer.args[0];
  if (transactions?.kind !== 'bytes') throw new Error('multiSend(bytes) decoded without its bytes');
  const calls = decodeMultiSendTransactions({ root: data.root, start: transactions.span[0], end: transactions.span[1] });
  if ('kind' in calls) return calls;
  // MultiSend 1.5.0 sends a call whose `to` is zero to the Safe itself, which every check here reads as the zero address.
  const zeroTo = deployment.version === '1.5.0' ? calls.find((call) => call.to === ZERO_ADDRESS) : undefined;
  if (zeroTo?.fields !== undefined) return { kind: 'malformed', at: zeroTo.fields.to[0], problem: 'a MultiSend 1.5.0 call to the zero address, which it sends to the Safe itself' };
  return { kind: 'multisend', deployment, outer, calls };
}
