import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { parseAddressBook } from '../address-book.ts';
import { parseCard, resolveCard } from '../card.ts';
import type { Exchange } from '../chain/recording.ts';
import type { Reader } from '../chain/reader.ts';
import { selectorOf } from '../decode/abi.ts';
import { checkFloor } from '../floor/floor.ts';
import { checkObservation } from '../floor/summary.ts';
import { parseRegistry } from '../registry.ts';
import { hashSafeTx } from '../safe/hash.ts';
import { parseSafeWebAppTx, parseServiceTx } from '../safe/parse.ts';
import { parseAddress, parseHex, parseSafeVersion } from '../safe/types.ts';
import type { Address, Hex, SafeTx, SafeTxHashes } from '../safe/types.ts';
import { expectedChanges } from '../simulate/effects.ts';
import { observeExecuted } from '../simulate/executed.ts';
import { simulateSafeTx } from '../simulate/simulate.ts';
import type { Observation } from '../simulate/simulate.ts';
import { checkTemplateFields } from '../template/check.ts';
import { checkMutations } from '../template/mutation.ts';
import { parseTemplate } from '../template/template.ts';
import type { Template } from '../template/template.ts';
import { decideVerdict } from './verdict.ts';
import type { Verdict } from './verdict.ts';

/** The Safe transaction as given: Transaction Service JSON, which carries its safeTxHash, or the Safe web app's JSON. */
export type TxInput = { readonly format: 'service' | 'web-app'; readonly json: unknown };

/** Every input a verdict uses besides the chain. The chain's answers sit beside it as recorded exchanges. */
export type VerifyInputs = {
  /** The origin/main commit the self-check passed on, which templates and the registry were read from. */
  readonly commit: string;
  readonly safe: string;
  readonly tx: TxInput;
  readonly card: { readonly hash: string; readonly text: string };
  readonly templates: readonly { readonly id: string; readonly text: string; readonly approved: string | null }[];
  readonly registry: string;
  /** Only the entries the card names. */
  readonly addressBook: Readonly<Record<string, string>>;
};

export type Evaluation = { readonly verdict: Verdict; readonly hashes: SafeTxHashes };

export const VERDICT_FORMAT = 'kiss-sign-verdict-1';

export type VerdictFile = {
  readonly format: typeof VERDICT_FORMAT;
  readonly inputs: VerifyInputs;
  readonly exchanges: readonly Exchange[];
  readonly result: Evaluation;
};

export class VerifyError extends Error {
  override name = 'VerifyError';
}

export const keccakText = (text: string): Hex => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}` as Hex;

/** The next slot after the block a pending transaction is simulated on. */
const SLOT_SECONDS = 12n;

function abiString(data: Hex): string | undefined {
  const hex = data.slice(2);
  if (hex.length < 128 || BigInt(`0x${hex.slice(0, 64)}`) !== 32n) return undefined;
  const length = Number(BigInt(`0x${hex.slice(64, 128)}`));
  const body = hex.slice(128, 128 + length * 2);
  return body.length === length * 2 ? Buffer.from(body, 'hex').toString('utf8') : undefined;
}

function guard<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof Error && !(error instanceof VerifyError)) throw new VerifyError(`${what}: ${error.message}`);
    throw error;
  }
}

function parseTx(input: TxInput, safe: Address, version: string): SafeTx {
  return guard('the Safe transaction', () =>
    input.format === 'service'
      ? parseServiceTx(input.json, { chainId: 1n, version })
      : parseSafeWebAppTx(input.json, { chainId: 1n, safe, version }),
  );
}

/** The receipt's hash when the Transaction Service says the transaction executed; the receipt itself must confirm it. */
function executedIn(input: TxInput): Hex | undefined {
  if (input.format !== 'service') return undefined;
  const { isExecuted, transactionHash } = input.json as { isExecuted?: unknown; transactionHash?: unknown };
  return isExecuted === true && typeof transactionHash === 'string' ? parseHex('transactionHash', transactionHash) : undefined;
}

/**
 * Runs every check on the inputs, reading the chain only through `reader`. The same inputs and the same chain answers
 * give the same verdict, which is what `replay` relies on.
 */
export async function evaluate(inputs: VerifyInputs, reader: Reader): Promise<Evaluation> {
  const registry = guard('the registry', () => parseRegistry(JSON.parse(inputs.registry)));
  const safe = guard('the configured Safe', () => parseAddress('safe', inputs.safe));
  if (keccakText(inputs.card.text) !== inputs.card.hash) throw new VerifyError(`the card does not hash to ${inputs.card.hash}`);
  const card = guard('the card', () => parseCard(JSON.parse(inputs.card.text)));
  const templates = new Map<string, Template>();
  const approvals = inputs.templates.map(({ id, text, approved }) => {
    const template = guard(`template ${id}`, () => parseTemplate(JSON.parse(text), registry));
    if (template.id !== id) throw new VerifyError(`template ${id} names itself ${template.id}`);
    templates.set(id, template);
    return { template: id, hash: keccakText(text), approved: approved === null ? undefined : guard(id, () => parseHex(id, approved)) };
  });
  const addressBook = guard('the address book', () => parseAddressBook(inputs.addressBook));
  const resolution = resolveCard(card, { templates, registry, addressBook, safe });
  if (resolution.kind === 'refused') throw new VerifyError(`the card is refused at ${resolution.at}: ${resolution.detail}`);
  const resolved = resolution.card;

  const latest = await reader.block('latest');
  if (latest.kind === 'unverifiable') throw new VerifyError(`no agreed latest block: ${latest.reason}`);
  const versionRead = await reader.call({ to: safe, data: selectorOf('VERSION()') }, latest.value);
  if (versionRead.kind === 'unverifiable') throw new VerifyError(`the Safe's version: ${versionRead.reason}`);
  const version = versionRead.value.kind === 'returned' ? abiString(versionRead.value.data) : undefined;
  const tx = parseTx(inputs.tx, safe, guard("the Safe's version", () => parseSafeVersion(version)));

  const fields = checkTemplateFields(tx, resolved, templates, registry);
  const mutation = checkMutations(tx, resolved, templates, registry);
  const executed = guard('the Safe transaction', () => executedIn(inputs.tx));
  let observation: Observation;
  if (executed !== undefined) {
    observation = await observeExecuted(reader, executed, tx);
  } else {
    const header = await reader.header(latest.value);
    const expected = expectedChanges(resolved, templates, registry);
    const watch = expected.kind === 'expected' ? [...expected.changes.keys()] : [];
    observation =
      header.kind === 'unverifiable'
        ? { kind: 'unverifiable', reasons: [header.reason] }
        : await simulateSafeTx(reader, { tx, parent: header.value, time: header.value.time + SLOT_SECONDS, watch });
  }
  const checks = { staticFloor: checkFloor(tx), fields, mutation, simulation: checkObservation(observation, safe, resolved, templates, registry), approvals };
  return { verdict: decideVerdict(checks, registry), hashes: hashSafeTx(tx) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string';

/** Reads a verdict file's JSON, refusing anything not shaped like one. Each input is parsed again when it is used. */
export function parseVerdictFile(raw: unknown): VerdictFile {
  const refuse = (problem: string): never => {
    throw new VerifyError(`not a ${VERDICT_FORMAT} file: ${problem}`);
  };
  if (!isRecord(raw) || raw.format !== VERDICT_FORMAT) return refuse('format');
  const { inputs, exchanges, result } = raw;
  if (!isRecord(inputs) || !isText(inputs.commit) || !isText(inputs.safe) || !isText(inputs.registry)) return refuse('inputs');
  if (!isRecord(inputs.tx) || (inputs.tx.format !== 'service' && inputs.tx.format !== 'web-app')) return refuse('inputs.tx');
  if (!isRecord(inputs.card) || !isText(inputs.card.hash) || !isText(inputs.card.text)) return refuse('inputs.card');
  if (!isRecord(inputs.addressBook)) return refuse('inputs.addressBook');
  const templateOk = (t: unknown) => isRecord(t) && isText(t.id) && isText(t.text) && (t.approved === null || isText(t.approved));
  if (!Array.isArray(inputs.templates) || !inputs.templates.every(templateOk)) return refuse('inputs.templates');
  const exchangeOk = (e: unknown) => isRecord(e) && isText(e.method) && isRecord(e.answers);
  if (!Array.isArray(exchanges) || !exchanges.every(exchangeOk)) return refuse('exchanges');
  if (!isRecord(result) || !isRecord(result.verdict) || !isRecord(result.hashes)) return refuse('result');
  return raw as unknown as VerdictFile;
}
