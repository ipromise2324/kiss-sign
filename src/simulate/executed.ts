import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { selectorOf } from '../decode/abi.ts';
import { uintWord } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import { hashSafeTx } from '../safe/hash.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import type { AllowanceChange } from './effects.ts';
import { SAFE_RECEIVED, TRANSFER, executionOf, isEthTransfer, namesAddress, touchedBy, uintOf } from './events.ts';
import type { Allowance } from './events.ts';
import type { Observation } from './simulate.ts';

const allowanceCall = (safe: Address, { token, spender }: Allowance) => ({
  to: token,
  data: `0x${bytesToHex(
    concatBytes(hexToBytes(selectorOf('allowance(address,address)').slice(2)), uintWord(BigInt(safe)), uintWord(BigInt(spender))),
  )}` as Hex,
});

/**
 * What an executed Safe transaction did, from its receipt as both providers agree on it: token changes from the
 * `Transfer` logs that name the Safe, ETH out from the values of the calls the Safe made, and ETH in from the Safe's
 * `SafeReceived` logs.
 */
export async function observeExecuted(reader: Reader, txHash: Hex, tx: SafeTx): Promise<Observation> {
  const safe = tx.safe;
  const unverifiable = (...reasons: string[]): Observation => ({ kind: 'unverifiable', reasons });
  const read = await reader.getTransactionReceipt(txHash);
  if (read.kind === 'unverifiable') return unverifiable(read.reason);
  const receipt = read.value;
  if (receipt === null) return unverifiable(`no receipt for ${txHash}`);
  if (receipt.status === 0) return { kind: 'observed', observed: { kind: 'not-executed', why: 'reverted' } };
  const execution = executionOf(receipt.logs, safe, hashSafeTx(tx).safeTxHash);
  if (execution !== 'success') return { kind: 'observed', observed: { kind: 'not-executed', why: execution } };

  const unwrapped = unwrapSafeTx(tx);
  if (unwrapped.kind !== 'direct' && unwrapped.kind !== 'multisend') return unverifiable(`the Safe transaction's calls do not decode: ${unwrapped.kind}`);
  const ethOut = unwrapped.calls.reduce((sum, call) => sum + (call.operation === 0 ? call.value : 0n), 0n);
  const ethIn = receipt.logs
    .filter((log) => log.address === safe && log.topics[0] === SAFE_RECEIVED && log.topics.length === 2)
    .reduce((sum, log) => sum + uintOf(log.data), 0n);

  const tokens = new Map<Address, bigint>();
  for (const log of receipt.logs) {
    const [first, from, to] = log.topics;
    if (first !== TRANSFER || isEthTransfer(log) || (!namesAddress(from, safe) && !namesAddress(to, safe))) continue;
    // An ERC-721 Transfer indexes the token id as a fourth topic and moves one token.
    const amount = log.topics.length === 4 ? 1n : uintOf(log.data);
    const delta = (namesAddress(to, safe) ? amount : 0n) - (namesAddress(from, safe) ? amount : 0n);
    tokens.set(log.address, (tokens.get(log.address) ?? 0n) + delta);
  }

  // Receipts cannot show allowances, and tokens such as USDC spend one without a log, so each allowance an Approval
  // names is read at the parent block and at the execution block; another transaction in that block could move it.
  const [parent, block] = await Promise.all([reader.block(receipt.blockNumber - 1n), reader.block(receipt.blockNumber)]);
  if (parent.kind === 'unverifiable') return unverifiable(parent.reason);
  if (block.kind === 'unverifiable') return unverifiable(block.reason);
  if (block.value.hash !== receipt.blockHash) return unverifiable(`block ${receipt.blockNumber} is no longer the block the receipt names`);
  const allowanceAt = async (allowance: Allowance, at: BlockRef): Promise<bigint | string> => {
    const answer = await reader.call(allowanceCall(safe, allowance), at);
    if (answer.kind === 'unverifiable') return answer.reason;
    return answer.value.kind === 'returned' && answer.value.data.length === 66 ? uintOf(answer.value.data) : `allowance at ${allowance.token} could not be read`;
  };
  const allowances: AllowanceChange[] = [];
  for (const allowance of touchedBy(receipt.logs, safe).approvals.values()) {
    const [before, after] = await Promise.all([allowanceAt(allowance, parent.value), allowanceAt(allowance, block.value)]);
    if (typeof before === 'string') return unverifiable(before);
    if (typeof after === 'string') return unverifiable(after);
    allowances.push({ ...allowance, before, after });
  }
  return { kind: 'observed', observed: { kind: 'executed', eth: ethIn - ethOut, tokens, allowances } };
}
