import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { selectorOf } from '../decode/abi.ts';
import { uintWord } from '../decode/codec.ts';
import { hashSafeTx } from '../safe/hash.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import type { AllowanceChange, Permit2Allowance, Permit2Change } from './effects.ts';
import { PERMIT2, TRANSFER, executionOf, isEthTransfer, namesAddress, touchedBy, uintOf } from './events.ts';
import type { Allowance } from './events.ts';
import { permit2AllowanceOf } from './simulate.ts';
import type { Observation } from './simulate.ts';

const allowanceCall = (safe: Address, { token, spender }: Allowance) => ({
  to: token,
  data: `0x${bytesToHex(
    concatBytes(hexToBytes(selectorOf('allowance(address,address)').slice(2)), uintWord(BigInt(safe)), uintWord(BigInt(spender))),
  )}` as Hex,
});

const permit2Call = (safe: Address, { token, spender }: Allowance) => ({
  to: PERMIT2,
  data: `0x${bytesToHex(
    concatBytes(hexToBytes(selectorOf('allowance(address,address,address)').slice(2)), uintWord(BigInt(safe)), uintWord(BigInt(token)), uintWord(BigInt(spender))),
  )}` as Hex,
});

const balanceCall = (safe: Address, token: Address) => ({
  to: token,
  data: `0x${bytesToHex(concatBytes(hexToBytes(selectorOf('balanceOf(address)').slice(2)), uintWord(BigInt(safe))))}` as Hex,
});

/**
 * What an executed Safe transaction did, from its receipt as both providers agree on it: token changes from the
 * `Transfer` logs that name the Safe, and the ETH change from the Safe's balance at the parent block and at the
 * execution block. No log shows ETH that reaches the Safe as the value of `execTransaction` itself or without calling
 * it, and with every fee field zero the Safe pays no gas. The balance of each token in `ends` is read at the parent block
 * and at the execution block, and must differ by exactly this transaction's change; otherwise another transaction in
 * that block moved it.
 */
export async function observeExecuted(reader: Reader, txHash: Hex, tx: SafeTx, ends: readonly Address[]): Promise<Observation> {
  const safe = tx.safe;
  const unverifiable = (...reasons: string[]): Observation => ({ kind: 'unverifiable', reasons });
  const read = await reader.getTransactionReceipt(txHash);
  if (read.kind === 'unverifiable') return unverifiable(read.reason);
  const receipt = read.value;
  if (receipt === null) return unverifiable(`no receipt for ${txHash}`);
  if (receipt.status === 0) return { kind: 'observed', observed: { kind: 'not-executed', why: 'reverted' } };
  const execution = executionOf(receipt.logs, safe, hashSafeTx(tx).safeTxHash);
  if (execution !== 'success') return { kind: 'observed', observed: { kind: 'not-executed', why: execution } };

  const tokens = new Map<Address, bigint>();
  for (const log of receipt.logs) {
    const [first, from, to] = log.topics;
    if (first !== TRANSFER || isEthTransfer(log) || (!namesAddress(from, safe) && !namesAddress(to, safe))) continue;
    // An ERC-721 Transfer indexes the token id as a fourth topic and moves one token.
    const amount = log.topics.length === 4 ? 1n : uintOf(log.data);
    const delta = (namesAddress(to, safe) ? amount : 0n) - (namesAddress(from, safe) ? amount : 0n);
    tokens.set(log.address, (tokens.get(log.address) ?? 0n) + delta);
  }

  // Receipts cannot show allowances, and tokens such as USDC spend one without a log, so each allowance an Approval or
  // a Permit2 event names, and the ETH balance, is read at the parent block and at the execution block; another
  // transaction in that block could move either.
  const [parent, block] = await Promise.all([reader.block(receipt.blockNumber - 1n), reader.block(receipt.blockNumber)]);
  if (parent.kind === 'unverifiable') return unverifiable(parent.reason);
  if (block.kind === 'unverifiable') return unverifiable(block.reason);
  if (block.value.hash !== receipt.blockHash) return unverifiable(`block ${receipt.blockNumber} is no longer the block the receipt names`);
  const [ethBefore, ethAfter] = await Promise.all([reader.getBalance(safe, parent.value), reader.getBalance(safe, block.value)]);
  if (ethBefore.kind === 'unverifiable') return unverifiable(ethBefore.reason);
  if (ethAfter.kind === 'unverifiable') return unverifiable(ethAfter.reason);
  const allowanceAt = async (allowance: Allowance, at: BlockRef): Promise<bigint | string> => {
    const answer = await reader.call(allowanceCall(safe, allowance), at);
    if (answer.kind === 'unverifiable') return answer.reason;
    return answer.value.kind === 'returned' && answer.value.data.length === 66 ? uintOf(answer.value.data) : `allowance at ${allowance.token} could not be read`;
  };
  const touched = touchedBy(receipt.logs, safe);
  const allowances: AllowanceChange[] = [];
  for (const allowance of touched.approvals.values()) {
    const [before, after] = await Promise.all([allowanceAt(allowance, parent.value), allowanceAt(allowance, block.value)]);
    if (typeof before === 'string') return unverifiable(before);
    if (typeof after === 'string') return unverifiable(after);
    allowances.push({ ...allowance, before, after });
  }
  const permit2At = async (allowance: Allowance, at: BlockRef): Promise<Permit2Allowance | string> => {
    const answer = await reader.call(permit2Call(safe, allowance), at);
    if (answer.kind === 'unverifiable') return answer.reason;
    const read = answer.value.kind === 'returned' ? permit2AllowanceOf(answer.value.data) : undefined;
    return read ?? `the Permit2 allowance of ${allowance.token} to ${allowance.spender} could not be read`;
  };
  const permit2: Permit2Change[] = [];
  for (const allowance of touched.permit2.values()) {
    const [before, after] = await Promise.all([permit2At(allowance, parent.value), permit2At(allowance, block.value)]);
    if (typeof before === 'string') return unverifiable(before);
    if (typeof after === 'string') return unverifiable(after);
    permit2.push({ ...allowance, before, after });
  }
  const balanceAt = async (token: Address, at: BlockRef): Promise<bigint | string> => {
    const answer = await reader.call(balanceCall(safe, token), at);
    if (answer.kind === 'unverifiable') return answer.reason;
    return answer.value.kind === 'returned' && answer.value.data.length === 66 ? uintOf(answer.value.data) : `balanceOf at ${token} could not be read`;
  };
  const held = new Map<Address, bigint>();
  for (const token of ends) {
    const [before, after] = await Promise.all([balanceAt(token, parent.value), balanceAt(token, block.value)]);
    if (typeof before === 'string') return unverifiable(before);
    if (typeof after === 'string') return unverifiable(after);
    if (before + (tokens.get(token) ?? 0n) !== after) {
      return unverifiable(`another transaction in block ${receipt.blockNumber} moved the Safe's ${token}, so its balance right after this one is unknown`);
    }
    held.set(token, after);
  }
  const logs = receipt.logs.map(({ address, topics, data }) => ({ address, topics, data }));
  const eth = ethAfter.value - ethBefore.value;
  return { kind: 'observed', observed: { kind: 'executed', eth, tokens, allowances, permit2, ends: held, safeState: { kind: 'receipt', logs } } };
}
