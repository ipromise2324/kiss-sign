import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Address = Brand<`0x${string}`, 'Address'>;
export type Hex = Brand<`0x${string}`, 'Hex'>;

export const SAFE_VERSIONS = ['1.3.0', '1.4.1', '1.5.0'] as const;
export type SafeVersion = (typeof SAFE_VERSIONS)[number];

export type SafeTx = {
  readonly chainId: bigint;
  readonly safe: Address;
  readonly version: SafeVersion;
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
  readonly operation: 0 | 1;
  readonly safeTxGas: bigint;
  readonly baseGas: bigint;
  readonly gasPrice: bigint;
  readonly gasToken: Address;
  readonly refundReceiver: Address;
  readonly nonce: bigint;
};

export type SafeTxHashes = {
  readonly domainHash: Hex;
  readonly messageHash: Hex;
  readonly safeTxHash: Hex;
};

export class SafeTxParseError extends Error {
  readonly field: string;

  constructor(field: string, problem: string) {
    super(`${field}: ${problem}`);
    this.name = 'SafeTxParseError';
    this.field = field;
  }
}

const UINT256_LIMIT = 1n << 256n;

export function parseAddress(field: string, raw: unknown): Address {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new SafeTxParseError(field, 'not a 20-byte hex address');
  }
  const body = raw.slice(2);
  const lower = body.toLowerCase();
  if (body !== lower && body !== checksummed(lower)) throw new SafeTxParseError(field, 'bad EIP-55 checksum');
  return `0x${lower}` as Address;
}

export function checksumAddress(address: Address): string {
  return `0x${checksummed(address.slice(2))}`;
}

function checksummed(lowerBody: string): string {
  const hash = bytesToHex(keccak_256(utf8ToBytes(lowerBody)));
  return [...lowerBody].map((c, i) => (parseInt(hash[i] ?? '0', 16) >= 8 ? c.toUpperCase() : c)).join('');
}

export function parseHex(field: string, raw: unknown): Hex {
  if (typeof raw !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(raw)) {
    throw new SafeTxParseError(field, 'not 0x-prefixed even-length hex');
  }
  return raw.toLowerCase() as Hex;
}

export function parseUint256(field: string, raw: unknown): bigint {
  let value: bigint;
  if (typeof raw === 'bigint') value = raw;
  else if (typeof raw === 'number' && Number.isSafeInteger(raw)) value = BigInt(raw);
  else if (typeof raw === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(raw)) value = BigInt(raw);
  else throw new SafeTxParseError(field, 'not a non-negative integer');
  if (value < 0n || value >= UINT256_LIMIT) throw new SafeTxParseError(field, 'out of uint256 range');
  return value;
}

export function parseOperation(raw: unknown): 0 | 1 {
  const operation = parseUint256('operation', raw);
  if (operation === 0n) return 0;
  if (operation === 1n) return 1;
  throw new SafeTxParseError('operation', 'must be 0 (call) or 1 (delegatecall)');
}

export function parseSafeVersion(raw: unknown): SafeVersion {
  const version = SAFE_VERSIONS.find((v) => v === raw);
  if (version === undefined) {
    throw new SafeTxParseError('version', `unsupported Safe version ${JSON.stringify(String(raw).slice(0, 32))}`);
  }
  return version;
}
