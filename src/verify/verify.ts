import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { parseAddressBook } from '../address-book.ts';
import type { AddressBook } from '../address-book.ts';
import { parseCard, resolveCard } from '../card.ts';
import type { ResolvedCard } from '../card.ts';
import { readDecimals } from '../chain/decimals.ts';
import type { Exchange } from '../chain/recording.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockHeader, BlockRef } from '../chain/types.ts';
import { selectorOf } from '../decode/abi.ts';
import { checkFloor, standingSpenders } from '../floor/floor.ts';
import { checkObservation } from '../floor/summary.ts';
import { parseRegistry } from '../registry.ts';
import type { Registry } from '../registry.ts';
import { hashSafeTx } from '../safe/hash.ts';
import { parseSafeWebAppTx, parseServiceTx } from '../safe/parse.ts';
import { parseAddress, parseHex, parseSafeVersion } from '../safe/types.ts';
import type { Address, Hex, SafeTx, SafeTxHashes } from '../safe/types.ts';
import { endsNeeded, expectedChanges, keptSeen, viewCalls } from '../simulate/effects.ts';
import type { KeptSeen } from '../simulate/effects.ts';
import { observeExecuted, withSimulatedViews } from '../simulate/executed.ts';
import { scanCalls, simulateSafeTx } from '../simulate/simulate.ts';
import type { CallScan, Observation } from '../simulate/simulate.ts';
import { checkTemplateFields, inspectTemplateFields } from '../template/check.ts';
import type { Messages } from '../template/check.ts';
import { checkMutations } from '../template/mutation.ts';
import { parseTemplate } from '../template/template.ts';
import type { Template } from '../template/template.ts';
import { assetClaims, checkAssets } from './assets.ts';
import { checkCode, codeClaims } from './code.ts';
import { amountTokens } from './expected.ts';
import { decideVerdict } from './verdict.ts';
import type { ChainCheck, TemplateApproval, Verdict } from './verdict.ts';

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
  /** The markets table, absent when the commit has none, as in a verdict file from before markets. */
  readonly markets?: string;
  /** Only the entries the card names. */
  readonly addressBook: Readonly<Record<string, string>>;
  /** Each signed message read from a template's `lookup`, as text; absent in a verdict file from before messages. */
  readonly messages?: readonly string[];
};

/** Reads the text at a `lookup` URL, or says why it could not. */
export type MessageReader = (url: string) => Promise<{ readonly text: string } | { readonly why: string }>;

/** `calls` is information for the signer, not a check: which of the Safe's calls move none of its assets. */
export type Evaluation = { readonly verdict: Verdict; readonly hashes: SafeTxHashes; readonly calls: CallScan };

export const VERDICT_FORMAT = 'kiss-sign-verdict-2';

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

/** The inputs a verdict needs besides the transaction, parsed, with the card resolved to what it names. */
export type Prepared = {
  readonly registry: Registry;
  readonly safe: Address;
  readonly card: ResolvedCard;
  readonly templates: ReadonlyMap<string, Template>;
  readonly approvals: readonly TemplateApproval[];
  readonly addressBook: AddressBook;
  readonly messages: Messages;
};

export function prepare(inputs: VerifyInputs): Prepared {
  const registry = guard('the registry', () => parseRegistry(JSON.parse(inputs.registry), inputs.markets === undefined ? {} : JSON.parse(inputs.markets)));
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
  if (inputs.messages !== undefined && !inputs.messages.every((m) => typeof m === 'string')) throw new VerifyError('the signed messages are not texts');
  return { registry, safe, card: resolution.card, templates, approvals, addressBook, messages: inputs.messages ?? [] };
}

/** Every check on the transaction, given what a simulation or its receipt showed it doing. */
export function judge(prepared: Prepared, tx: SafeTx, observation: Observation, read: { readonly assets: ChainCheck; readonly code: ChainCheck }): Verdict {
  const { registry, safe, card, templates, approvals, messages } = prepared;
  const checks = {
    staticFloor: checkFloor(tx, standingSpenders(registry)),
    fields: checkTemplateFields(tx, card, templates, registry, messages),
    ...read,
    mutation: checkMutations(tx, card, templates, registry, messages),
    simulation: checkObservation(observation, safe, card, templates, registry),
    approvals,
  };
  return decideVerdict(checks, registry);
}

async function ranOn(reader: Reader, executed: Hex | undefined, latest: BlockRef): Promise<BlockRef | string> {
  if (executed === undefined) return latest;
  const receipt = await reader.getTransactionReceipt(executed);
  if (receipt.kind === 'unverifiable') return receipt.reason;
  if (receipt.value === null) return `no receipt for ${executed}`;
  const parent = await reader.block(receipt.value.blockNumber - 1n);
  return parent.kind === 'unverifiable' ? parent.reason : parent.value;
}

async function simulatedOn(reader: Reader, executed: Hex | undefined, latest: BlockRef): Promise<{ parent: BlockHeader; time: bigint } | string> {
  const header = async (at: BlockRef | string): Promise<BlockHeader | string> => {
    if (typeof at === 'string') return at;
    const read = await reader.header(at);
    return read.kind === 'unverifiable' ? read.reason : read.value;
  };
  const parent = await header(await ranOn(reader, executed, latest));
  if (typeof parent === 'string') return parent;
  if (executed === undefined) return { parent, time: parent.time + SLOT_SECONDS };
  const block = await reader.block(parent.number + 1n);
  const own = await header(block.kind === 'unverifiable' ? block.reason : block.value);
  return typeof own === 'string' ? own : { parent, time: own.time };
}

/**
 * Runs every check on the inputs, reading the chain only through `reader`. The same inputs and the same chain answers
 * give the same verdict, which is what `replay` relies on.
 */
export async function evaluate(inputs: VerifyInputs, reader: Reader): Promise<Evaluation> {
  return (await evaluateTx(inputs, reader)).evaluation;
}

/**
 * The inputs with each signed message the transaction names by its digest and the inputs lack, read through
 * `readMessage`. A message that cannot be read is left out, so the field check says it was not read.
 */
async function withMessages(inputs: VerifyInputs, prepared: Prepared, tx: SafeTx, readMessage: MessageReader | undefined): Promise<{ inputs: VerifyInputs; prepared: Prepared }> {
  const { lookups } = inspectTemplateFields(tx, prepared.card, prepared.templates, prepared.registry, prepared.messages);
  if (readMessage === undefined || lookups.length === 0) return { inputs, prepared };
  const read: string[] = [];
  for (const url of new Set(lookups)) {
    const answer = await readMessage(url);
    if ('text' in answer) read.push(answer.text);
  }
  const messages = [...prepared.messages, ...read];
  return { inputs: { ...inputs, messages }, prepared: { ...prepared, messages } };
}

/**
 * `evaluate`, with the transaction it judged, the inputs it used, signed messages read through `readMessage` included,
 * the inputs it prepared and the latest block it read, for showing what that transaction does.
 */
export async function evaluateTx(
  given: VerifyInputs,
  reader: Reader,
  readMessage?: MessageReader,
): Promise<{ readonly evaluation: Evaluation; readonly tx: SafeTx; readonly inputs: VerifyInputs; readonly prepared: Prepared; readonly latest: BlockRef; readonly kept: readonly KeptSeen[] }> {
  const { safe } = prepare(given);
  const latest = await reader.block('latest');
  if (latest.kind === 'unverifiable') throw new VerifyError(`no agreed latest block: ${latest.reason}`);
  const versionRead = await reader.call({ to: safe, data: selectorOf('VERSION()') }, latest.value);
  if (versionRead.kind === 'unverifiable') throw new VerifyError(`the Safe's version: ${versionRead.reason}`);
  const version = versionRead.value.kind === 'returned' ? abiString(versionRead.value.data) : undefined;
  const tx = parseTx(given.tx, safe, guard("the Safe's version", () => parseSafeVersion(version)));
  const { inputs, prepared } = await withMessages(given, prepare(given), tx, readMessage);

  const executed = guard('the Safe transaction', () => executedIn(inputs.tx));
  const expected = expectedChanges(prepared.card, prepared.templates, prepared.registry);
  const ends = endsNeeded(expected);
  const watch = expected.kind === 'expected' ? [...expected.changes.keys()].filter((asset) => asset !== 'eth') : [];
  const views = viewCalls(prepared.card, prepared.templates, prepared.registry);
  const on = await simulatedOn(reader, executed, latest.value);
  const simulate = async (): Promise<Observation> => (typeof on === 'string' ? { kind: 'unverifiable', reasons: [on] } : simulateSafeTx(reader, { tx, ...on, watch, ends, views }));
  let observation = executed === undefined ? await simulate() : await observeExecuted(reader, executed, tx, ends, views);
  if (executed !== undefined && views.length > 0) observation = withSimulatedViews(observation, await simulate(), views);
  const calls: CallScan = typeof on === 'string' ? { kind: 'unverifiable', reasons: [on] } : await scanCalls(reader, { tx, ...on, watch });
  const claims = assetClaims(prepared.card, prepared.templates, prepared.registry);
  const pinned = codeClaims(tx, prepared.card, prepared.templates, prepared.registry);
  const at = claims.length > 0 || pinned.length > 0 ? await ranOn(reader, executed, latest.value) : latest.value;
  const readAt = async <T>(subjects: readonly T[], check: (at: BlockRef) => Promise<ChainCheck>): Promise<ChainCheck> => {
    if (subjects.length === 0) return { kind: 'pass' };
    return typeof at === 'string' ? { kind: 'unverifiable', reasons: [at] } : check(at);
  };
  const read = {
    assets: await readAt(claims, (block) => checkAssets(reader, claims, block)),
    code: await readAt(pinned, (block) => checkCode(reader, pinned, block, executed === undefined ? 'pending' : 'executed')),
  };
  const kept = observation.kind === 'observed' ? keptSeen(observation.observed, prepared.card, prepared.templates, prepared.registry) : [];
  return { evaluation: { verdict: judge(prepared, tx, observation, read), hashes: hashSafeTx(tx), calls }, tx, inputs, prepared, latest: latest.value, kept };
}

/**
 * decimals() of each token the card counts or its effects watch, for the page alone. Read at the block `evaluateTx`
 * read as latest, never at `latest` again: the recording keeps one answer per request, and a second `latest` would
 * replace the block the verdict used.
 */
export async function readTokenDecimals(reader: Reader, prepared: Prepared, at: BlockRef): Promise<ReadonlyMap<Address, number>> {
  const expected = expectedChanges(prepared.card, prepared.templates, prepared.registry);
  const watched = expected.kind === 'expected' ? [...expected.changes.keys()].filter((asset) => asset !== 'eth') : [];
  const decimals = new Map<Address, number>();
  for (const token of new Set([...amountTokens(prepared.card, prepared.templates, prepared.registry), ...watched])) {
    const answer = await readDecimals(reader, token, at);
    if (typeof answer === 'number') decimals.set(token, answer);
  }
  return decimals;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string';

/** Reads a verdict file's JSON, refusing anything not shaped like one. Each input is parsed again when it is used. */
export function parseVerdictFile(raw: unknown): VerdictFile {
  const refuse = (problem: string): never => {
    throw new VerifyError(`not a ${VERDICT_FORMAT} file: ${problem}`);
  };
  if (!isRecord(raw)) return refuse('format');
  if (raw.format !== VERDICT_FORMAT) {
    throw new VerifyError(`this verdict file is in format ${JSON.stringify(raw.format)}, not ${VERDICT_FORMAT}; run verify again to get a file this program can replay`);
  }
  const { inputs, exchanges, result } = raw;
  if (!isRecord(inputs) || !isText(inputs.commit) || !isText(inputs.safe) || !isText(inputs.registry)) return refuse('inputs');
  if (inputs.markets !== undefined && !isText(inputs.markets)) return refuse('inputs.markets');
  if (!isRecord(inputs.tx) || (inputs.tx.format !== 'service' && inputs.tx.format !== 'web-app')) return refuse('inputs.tx');
  if (!isRecord(inputs.card) || !isText(inputs.card.hash) || !isText(inputs.card.text)) return refuse('inputs.card');
  if (!isRecord(inputs.addressBook)) return refuse('inputs.addressBook');
  if (inputs.messages !== undefined && !(Array.isArray(inputs.messages) && inputs.messages.every(isText))) return refuse('inputs.messages');
  const templateOk = (t: unknown) => isRecord(t) && isText(t.id) && isText(t.text) && (t.approved === null || isText(t.approved));
  if (!Array.isArray(inputs.templates) || !inputs.templates.every(templateOk)) return refuse('inputs.templates');
  const exchangeOk = (e: unknown) => isRecord(e) && isText(e.method) && isRecord(e.answers);
  if (!Array.isArray(exchanges) || !exchanges.every(exchangeOk)) return refuse('exchanges');
  if (!isRecord(result) || !isRecord(result.verdict) || !isRecord(result.hashes) || !isRecord(result.calls)) return refuse('result');
  return raw as unknown as VerdictFile;
}
