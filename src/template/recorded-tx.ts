import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseServiceTx } from '../safe/parse.ts';
import { parseAddress, parseHex, parseSafeVersion, parseUint256 } from '../safe/types.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import type { EventLog } from '../chain/types.ts';
import { isEthTransfer } from '../simulate/events.ts';
import type { Sender } from '../simulate/simulate.ts';
import type { Template } from './template.ts';

export const RECORDED_TX_DIR = join('testdata', 'safe-tx');

/**
 * The block a recorded transaction ran in: its number, its time in seconds and, for an EOA's, its hash, which the
 * same two providers that answer every later read gave; the Safe Transaction Service gives no block hash.
 */
export type ExecutedAt = { readonly number: bigint; readonly time: bigint; readonly hash?: Hex };

/**
 * A test transaction of `testdata/safe-tx/<name>.json`, as every command that judges one reads it. `tx` holds the call
 * the field check and the simulation read; for an EOA, its one call, with `safe` the EOA (see `eoaCall`). `hash` is the
 * transaction's hash on chain.
 */
export type RecordedTx = { readonly sender: Sender; readonly tx: SafeTx; readonly hash: Hex; readonly executed: ExecutedAt };

/**
 * An EOA's call as the field check reads a transaction: `safe` is the sender and the operation a CALL, as an EOA's own
 * call is. A SafeTx must also name a Safe version, gas fields and a nonce; they hold an empty Safe transaction's, and
 * nothing reads them for an EOA: `simulateTx('eoa', ...)` neither hashes the transaction nor reads Safe settings, and
 * `eoaCannotTest` refuses a template that binds the nonce.
 */
function eoaCall(from: Address, to: Address, value: bigint, data: Hex): SafeTx {
  const zero = parseAddress('zero', `0x${'00'.repeat(20)}`);
  return { chainId: 1n, safe: from, version: '1.4.1', to, value, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zero, refundReceiver: zero, nonce: 0n };
}

/** The block the Safe Transaction Service says a Safe's transaction ran in: its `blockNumber` and its `executionDate` in seconds. */
function serviceExecution(service: { readonly blockNumber?: unknown; readonly executionDate?: unknown }): ExecutedAt {
  const ms = typeof service.executionDate === 'string' ? Date.parse(service.executionDate) : Number.NaN;
  if (!Number.isSafeInteger(service.blockNumber) || !Number.isSafeInteger(ms) || ms % 1000 !== 0) throw new Error('the Safe Transaction Service record has no whole blockNumber and executionDate');
  return { number: BigInt(service.blockNumber as number), time: BigInt(ms / 1000) };
}

const hash32Of = (what: string, raw: unknown): Hex => {
  const hash = parseHex(what, raw);
  if (hash.length !== 66) throw new Error(`${what} is not 32 bytes`);
  return hash;
};

type Fields = Record<string, unknown>;
const fields = (value: unknown, what: string): Fields => {
  if (typeof value !== 'object' || value === null) throw new Error(`${what} is not an object`);
  return value as Fields;
};

/** A fixture `pnpm record-safe-tx` wrote, or, with `"sender": "eoa"`, one `pnpm record-eoa-tx` wrote. */
export function parseRecordedTx(raw: unknown, file: string): RecordedTx {
  const fixture = fields(raw, file);
  if (fixture.sender === undefined) {
    const service = fields(fixture.service, `${file} service`);
    const chain = fields(fixture.chain, `${file} chain`);
    const tx = parseServiceTx(service, { chainId: 1n, version: parseSafeVersion(chain.version) });
    return { sender: 'safe', tx, hash: hash32Of(`${file} transactionHash`, service.transactionHash), executed: serviceExecution(service) };
  }
  if (fixture.sender !== 'eoa') throw new Error(`${file}: sender is "eoa" or absent, not ${JSON.stringify(fixture.sender)}`);
  const sent = fields(fixture.transaction, `${file} transaction`);
  const block = fields(fixture.block, `${file} block`);
  const tx = eoaCall(parseAddress('from', sent.from), parseAddress('to', sent.to), parseUint256('value', sent.value), parseHex('input', sent.input));
  if (tx.to === tx.safe) throw new Error(`${file}: the EOA calls itself`);
  return {
    sender: 'eoa',
    tx,
    hash: hash32Of(`${file} transaction hash`, sent.hash),
    executed: { number: parseUint256('block number', block.number), time: parseUint256('block time', block.time), hash: hash32Of(`${file} block hash`, block.hash) },
  };
}

export function loadRecordedTx(repoRoot: string, name: string): RecordedTx {
  const file = join(RECORDED_TX_DIR, `${name}.json`);
  return parseRecordedTx(JSON.parse(readFileSync(join(repoRoot, file), 'utf8')), file);
}

/**
 * Why an EOA's transaction cannot test `template`, or undefined: a rule on the Safe's nonce, or a change of the Safe's
 * owners or threshold, reads what an EOA's call does not have.
 */
export function eoaCannotTest(recorded: RecordedTx, template: Template): string | undefined {
  if (recorded.sender !== 'eoa') return undefined;
  if (template.nonce !== undefined) return `${template.id} binds the Safe's nonce, which an EOA's transaction does not have`;
  if (template.effects.safe !== undefined) return `${template.id} changes the Safe's settings, which an EOA does not have`;
  return undefined;
}

/**
 * Why a simulated EOA's call is not the one its receipt records, or undefined. An EOA's receipt holds its one call's
 * logs alone, so the simulation must emit logs from the same addresses with the same topics, in the same order. Their
 * data may differ, since the transactions before it in its block are not simulated.
 */
export function eoaReceiptDiffers(receipt: readonly EventLog[], simulated: readonly EventLog[]): string | undefined {
  const shape = (logs: readonly EventLog[]): string[] => logs.filter((log) => !isEthTransfer(log)).map((log) => [log.address, ...log.topics].join(' '));
  const [recorded, ran] = [shape(receipt), shape(simulated)];
  const at = recorded.findIndex((log, i) => log !== ran[i]);
  if (at === -1 && recorded.length === ran.length) return undefined;
  return `the simulated call is not the one its receipt records: log ${at === -1 ? recorded.length : at} of the ${ran.length} it emitted differs in address or topics from the receipt's ${recorded.length}`;
}
