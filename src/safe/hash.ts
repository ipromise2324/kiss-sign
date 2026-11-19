import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Address, Hex, SafeTx, SafeTxHashes } from './types.ts';

// Every supported version uses this SafeTx typehash and word order. Safe 1.1.1's domain has no chainId. Check a new
// version's contract source before adding it to SAFE_VERSIONS.
const DOMAIN_TYPEHASH = keccak_256(utf8ToBytes('EIP712Domain(uint256 chainId,address verifyingContract)'));
const DOMAIN_TYPEHASH_1_1_1 = keccak_256(utf8ToBytes('EIP712Domain(address verifyingContract)'));
export const SAFE_TX_TYPEHASH = keccak_256(
  utf8ToBytes(
    'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)',
  ),
);

function uintWord(value: bigint): Uint8Array {
  return hexToBytes(value.toString(16).padStart(64, '0'));
}

function addressWord(address: Address): Uint8Array {
  return hexToBytes(address.slice(2).padStart(64, '0'));
}

function toHex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}` as Hex;
}

export function hashSafeTx(tx: SafeTx): SafeTxHashes {
  const domainHash = keccak_256(
    tx.version === '1.1.1'
      ? concatBytes(DOMAIN_TYPEHASH_1_1_1, addressWord(tx.safe))
      : concatBytes(DOMAIN_TYPEHASH, uintWord(tx.chainId), addressWord(tx.safe)),
  );
  const messageHash = keccak_256(
    concatBytes(
      SAFE_TX_TYPEHASH,
      addressWord(tx.to),
      uintWord(tx.value),
      keccak_256(hexToBytes(tx.data.slice(2))),
      uintWord(BigInt(tx.operation)),
      uintWord(tx.safeTxGas),
      uintWord(tx.baseGas),
      uintWord(tx.gasPrice),
      addressWord(tx.gasToken),
      addressWord(tx.refundReceiver),
      uintWord(tx.nonce),
    ),
  );
  const safeTxHash = keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domainHash, messageHash));
  return { domainHash: toHex(domainHash), messageHash: toHex(messageHash), safeTxHash: toHex(safeTxHash) };
}
