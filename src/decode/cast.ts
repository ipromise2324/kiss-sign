import { bytesToHex } from '@noble/hashes/utils.js';
import { checksumAddress } from '../safe/types.ts';
import type { AbiValue } from './codec.ts';

/** One decoded ABI value as `cast decode-calldata` prints it, which `check.sh` lays out for the signer to compare. */
export function castValue(value: AbiValue): string {
  switch (value.kind) {
    case 'uint':
    case 'int':
    case 'bool':
      return String(value.value);
    case 'address':
      return checksumAddress(value.value);
    case 'fixed-bytes':
      return value.value;
    case 'bytes':
      return `0x${bytesToHex(value.value)}`;
    case 'string':
      return JSON.stringify(new TextDecoder().decode(value.value));
    case 'array':
      return `[${value.items.map(castValue).join(', ')}]`;
    case 'tuple':
      return `(${value.fields.map(castValue).join(', ')})`;
  }
}
