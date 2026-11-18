import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCard, resolveCard } from '../card.ts';
import type { Card, ResolvedCard } from '../card.ts';
import { replayReader } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import type { Read, Reader } from '../chain/reader.ts';
import { parseBlockHeader } from '../chain/types.ts';
import type { BlockHeader, EventLog } from '../chain/types.ts';
import { headerHash } from '../chain/header-hash.ts';
import { uintWord } from '../decode/codec.ts';
import type { Registry } from '../registry.ts';
import { parseServiceTx } from '../safe/parse.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { endsNeeded, expectedChanges, judgeEffects, keptAllowances, keptKey, viewCalls } from '../simulate/effects.ts';
import type { KeptAllowances } from '../simulate/effects.ts';
import type { Observed } from '../simulate/effects.ts';
import { APPROVAL, EXECUTION_SUCCESS, PERMIT2, PERMIT2_INDEXED, addressOf, namesAddress } from '../simulate/events.ts';
import { simulateSafeTx } from '../simulate/simulate.ts';
import type { Observation } from '../simulate/simulate.ts';
import { checkTemplateFields, inspectTemplateFields } from './check.ts';
import { checkMutations } from './mutation.ts';
import type { MutationResult } from './mutation.ts';
import type { FieldChain, Leaf } from './check.ts';
import { loadTemplate, parseTemplate } from './template.ts';
import type { FreeClaim, Template } from './template.ts';
import { readRecording } from '../chain/bytecode.ts';

/**
 * What a copy of the transaction with one free field changed did. `reverted`: it did not execute. `refused`: the
 * engine's field or effects check refuses it, so it could never be signed as a MATCH. `same`: it emitted the same logs and
 * changed the Safe's balances, allowances and the views its template reads the same way. `changed`: it ran, the engine
 * would pass it, and something differs, so the field steers the transaction where the engine does not look. `repriced`:
 * it ran, the engine would pass it, and only the logs and the Safe's token amounts differ, as another pool's price does.
 */
export type Outcome = 'reverted' | 'refused' | 'same' | 'repriced' | 'changed';

export type Run = { readonly leaf: Leaf; readonly value: string; readonly outcome: Outcome | 'unverifiable'; readonly detail: string };

export type PerturbationReport =
  | { readonly kind: 'pass'; readonly runs: readonly Run[] }
  | { readonly kind: 'fail'; readonly runs: readonly Run[]; readonly failed: readonly Run[] }
  | { readonly kind: 'not-run'; readonly cause: 'fields' | 'unverifiable' | 'not-executed'; readonly reason: string };

const ALLOWED: Readonly<Record<FreeClaim, readonly Outcome[]>> = {
  scalar: ['reverted', 'refused', 'same'],
  proof: ['reverted', 'refused'],
  unread: ['refused', 'same'],
  route: ['reverted', 'refused', 'same', 'repriced'],
};

type Change = { readonly value: string; readonly at: number; readonly bytes: Uint8Array };

const word = (bytes: Uint8Array): bigint => BigInt(`0x${bytesToHex(bytes) || '0'}`);
/** A word cut to the leaf's own size: a packed part, such as a 3-byte fee, is shorter than 32 bytes. */
const sized = (word: Uint8Array, size: number): Uint8Array => word.subarray(32 - size);
const flipFirst = (bytes: Uint8Array): Uint8Array => Uint8Array.of((bytes[0] as number) ^ 0x80, ...bytes.subarray(1));

function changes(leaf: Leaf, data: Uint8Array): Change[] {
  if (leaf.bytes === undefined) return [];
  const [start, end] = leaf.bytes;
  const current = data.subarray(start, end);
  const type = leaf.type;
  switch (type.kind) {
    case 'uint':
    case 'int': {
      const v = type.kind === 'uint' ? word(current) : BigInt.asIntN(type.bits, word(current));
      const min = type.kind === 'uint' ? 0n : -(1n << BigInt(type.bits - 1));
      const max = type.kind === 'uint' ? (1n << BigInt(type.bits)) - 1n : (1n << BigInt(type.bits - 1)) - 1n;
      const values = [...new Set([v + 1n, v - 1n, 0n])].filter((n) => n !== v && n >= min && n <= max);
      return values.map((n) => ({ value: String(n), at: start, bytes: sized(uintWord(n), current.length) }));
    }
    case 'bool':
      return [{ value: String(word(current) === 0n), at: start, bytes: sized(uintWord(word(current) === 0n ? 1n : 0n), current.length) }];
    case 'fixed-bytes': {
      const zero = new Uint8Array(current.length);
      const flipped = { value: 'first byte flipped', at: start, bytes: flipFirst(current) };
      return word(current) === 0n ? [flipped] : [flipped, { value: 'zero', at: start, bytes: zero }];
    }
    case 'bytes':
    case 'string': {
      if (current.length === 0) return [];
      const first = { value: 'first byte flipped', at: start, bytes: flipFirst(current.subarray(0, 1)) };
      return current.length === 1 ? [first] : [first, { value: 'last byte flipped', at: end - 1, bytes: flipFirst(current.subarray(-1)) }];
    }
    case 'array':
    case 'fixed-array': {
      const body = type.kind === 'array' ? start + 32 : start;
      if (end - body < 32) return [];
      const at = (offset: number, value: string): Change => ({ value, at: offset, bytes: flipFirst(data.subarray(offset, offset + 1)) });
      return end - body === 32 ? [at(body, 'first word flipped')] : [at(body, 'first word flipped'), at(end - 32, 'last word flipped')];
    }
    default:
      return [];
  }
}

function applied(tx: SafeTx, change: Change): SafeTx {
  const data = hexToBytes(tx.data.slice(2));
  data.set(change.bytes, change.at);
  return { ...tx, data: `0x${bytesToHex(data)}` as Hex };
}

/** Allowances the card's templates keep open at any amount, which a free field may set to any value without changing what they allow. */
type Unlimited = (via: 'erc20' | 'permit2', token: Address, spender: Address) => boolean;

const unlimitedOf = (kept: KeptAllowances): Unlimited => (via, token, spender) => kept.get(keptKey(via, token, spender)) === 'unlimited';

/** Whether `log` sets or reports an allowance from the Safe that the card keeps open at any amount. */
function setsUnlimited(log: EventLog, safe: Address, unlimited: Unlimited): boolean {
  const [first, owner, a, b] = log.topics;
  if (!namesAddress(owner, safe) || a === undefined) return false;
  if (log.address === PERMIT2 && first !== undefined && PERMIT2_INDEXED.has(first)) return b !== undefined && unlimited('permit2', addressOf(a), addressOf(b));
  return first === APPROVAL && log.topics.length === 3 && unlimited('erc20', log.address, addressOf(a));
}

/**
 * The logs, without the Safe's own ExecutionSuccess, which names the transaction's hash and so differs in every copy,
 * and without those that set an allowance the card keeps open at any amount.
 */
function logText(logs: readonly EventLog[], safe: Address, unlimited: Unlimited): string {
  return JSON.stringify(logs.filter((log) => !(log.address === safe && log.topics[0] === EXECUTION_SUCCESS) && !setsUnlimited(log, safe, unlimited)));
}

/** What the copy left besides the Safe's token amounts: its allowances, the balances it ends with and the views it read. */
function settingsText(observed: Extract<Observed, { kind: 'executed' }>, unlimited: Unlimited): string {
  return JSON.stringify(JSON.parse(effectsText(observed, unlimited)).slice(2));
}

function effectsText(observed: Extract<Observed, { kind: 'executed' }>, unlimited: Unlimited): string {
  const allowances = observed.allowances.filter((a) => !unlimited('erc20', a.token, a.spender)).map((a) => [a.token, a.spender, String(a.before), String(a.after)]);
  const permit2 = observed.permit2
    .filter((p) => !unlimited('permit2', p.token, p.spender))
    .map((p) => [p.token, p.spender, ...[p.before, p.after].flatMap((a) => [String(a.amount), String(a.expiration), String(a.nonce)])]);
  const views = (observed.views ?? []).map((v) => [v.to, v.data, ...[v.before, v.after].map((a) => (a.kind === 'returned' ? a.data : 'unread'))]);
  return JSON.stringify([String(observed.eth), [...observed.tokens].map(([t, d]) => [t, String(d)]), allowances, permit2, [...observed.ends].map(([t, v]) => [t, String(v)]), views]);
}

/**
 * Changes every free field of a matching transaction, one value at a time, simulates each copy, and requires its
 * outcome to be one the field's claim allows: a scalar may stop the call or be refused but must otherwise change
 * nothing, a proof must stop the call, and an unread field must change nothing. This finds a free field that grants a
 * permission, approves a hash or moves value where the effects check does not look.
 */
export async function checkPerturbations(
  tx: SafeTx,
  card: ResolvedCard,
  templates: ReadonlyMap<string, Template>,
  registry: Registry,
  simulate: (tx: SafeTx) => Promise<Observation>,
  chain: FieldChain = {},
): Promise<PerturbationReport> {
  const { check, leaves } = inspectTemplateFields(tx, card, templates, registry, [], chain);
  if (check.kind !== 'match') return { kind: 'not-run', cause: 'fields', reason: `the transaction's fields give ${check.kind}` };
  const base = await simulate(tx);
  if (base.kind === 'unverifiable') return { kind: 'not-run', cause: 'unverifiable', reason: base.reasons.join('; ') };
  if (base.observed.kind !== 'executed') return { kind: 'not-run', cause: 'not-executed', reason: `the transaction did not execute: ${base.observed.why}` };
  const unlimited = unlimitedOf(keptAllowances(card, templates, registry).kept);
  const baseLogs = logText(base.logs, tx.safe, unlimited);
  const baseEffects = effectsText(base.observed, unlimited);
  const baseSettings = settingsText(base.observed, unlimited);
  const data = hexToBytes(tx.data.slice(2));
  const runs: Run[] = [];
  for (const leaf of leaves) {
    if (leaf.rule.kind !== 'free') continue;
    for (const change of changes(leaf, data)) {
      const copy = applied(tx, change);
      const run = (outcome: Run['outcome'], detail = ''): void => {
        runs.push({ leaf, value: change.value, outcome, detail });
      };
      const fields = checkTemplateFields(copy, card, templates, registry, [], chain);
      if (fields.kind !== 'match') {
        run('refused', `fields: ${fields.kind}`);
        continue;
      }
      const observation = await simulate(copy);
      if (observation.kind === 'unverifiable') run('unverifiable', observation.reasons.join('; '));
      else if (observation.observed.kind !== 'executed') run('reverted', observation.observed.why);
      else if (judgeEffects(observation.observed, card, templates, registry).kind !== 'match') run('refused', 'effects');
      else if (logText(observation.logs, tx.safe, unlimited) === baseLogs && effectsText(observation.observed, unlimited) === baseEffects) run('same');
      else if (leaf.rule.claim === 'route' && settingsText(observation.observed, unlimited) === baseSettings) run('repriced', logText(observation.logs, tx.safe, unlimited) === baseLogs ? "the Safe's token amounts differ" : 'the logs differ');
      else run('changed', logText(observation.logs, tx.safe, unlimited) === baseLogs ? "the Safe's balances, allowances or views differ" : 'the logs differ');
    }
  }
  const failed = runs.filter((r) => r.outcome === 'unverifiable' || r.leaf.rule.kind !== 'free' || !ALLOWED[r.leaf.rule.claim].includes(r.outcome));
  return failed.length === 0 ? { kind: 'pass', runs } : { kind: 'fail', runs, failed };
}

export const PERTURB_DIR = join('testdata', 'perturb');

/** A `pnpm perturb --record` file: the Safe transaction it changed, the card, any replacing template, and the chain's answers. */
type PerturbRecording = {
  readonly safeTx: string;
  readonly card: unknown;
  readonly template?: unknown;
  readonly executed: { readonly number: string; readonly hash: Hex };
  readonly parent: { readonly number: string; readonly hash: Hex };
  readonly exchanges: readonly Exchange[];
};

const agreed = <T>(read: Read<T>, what: string): T => {
  if (read.kind === 'unverifiable') throw new Error(`${what}: ${read.reason}`);
  return read.value;
};

const readPerturbRecording = (repoRoot: string, name: string): PerturbRecording =>
  readRecording(join(repoRoot, PERTURB_DIR, `${name}.json`)) as PerturbRecording;

/** The block the Safe Transaction Service says the transaction ran in: its `blockNumber` and its `executionDate` in seconds. */
export type ServiceExecution = { readonly number: bigint; readonly time: bigint };

export function serviceExecution(service: { readonly blockNumber?: unknown; readonly executionDate?: unknown }): ServiceExecution {
  const ms = typeof service.executionDate === 'string' ? Date.parse(service.executionDate) : Number.NaN;
  if (!Number.isSafeInteger(service.blockNumber) || !Number.isSafeInteger(ms) || ms % 1000 !== 0) throw new Error('the Safe Transaction Service record has no whole blockNumber and executionDate');
  return { number: BigInt(service.blockNumber as number), time: BigInt(ms / 1000) };
}

function recordedTx(repoRoot: string, recording: PerturbRecording): { readonly tx: SafeTx; readonly execution: ServiceExecution } {
  const fixture = JSON.parse(readFileSync(join(repoRoot, 'testdata', 'safe-tx', `${recording.safeTx}.json`), 'utf8'));
  return { tx: parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version }), execution: serviceExecution(fixture.service) };
}

const BLOCK_METHODS = new Set(['eth_getBlockByNumber', 'eth_getBlockByHash']);

/**
 * Refuses a recording whose block headers are not what they claim: each block answer must hash to its own `hash` and,
 * at the height of the executed or parent block, be that block; the executed block must name the recorded parent as
 * its parent, and its number and time must be those the Safe Transaction Service gave for the transaction.
 */
export function checkRecordedBlocks(file: string, recording: Pick<PerturbRecording, 'executed' | 'parent' | 'exchanges'>, execution: ServiceExecution): void {
  for (const exchange of recording.exchanges.filter((e) => BLOCK_METHODS.has(e.method))) {
    for (const [provider, answer] of Object.entries(exchange.answers)) {
      if (answer === null) continue;
      const block = parseBlockHeader(answer);
      if (headerHash(answer) !== block.hash) throw new Error(`${file}: ${provider}'s block ${block.number} does not hash to its hash ${block.hash}`);
      const recorded = [recording.executed, recording.parent].find((at) => BigInt(at.number) === block.number);
      if (recorded !== undefined && recorded.hash !== block.hash) throw new Error(`${file}: block ${block.number} is recorded with hash ${recorded.hash}, not ${block.hash}`);
      if (block.hash !== recording.executed.hash) continue;
      if ((answer as { parentHash?: unknown }).parentHash !== recording.parent.hash) throw new Error(`${file}: block ${block.number} does not name the recorded parent ${recording.parent.hash}`);
      if (block.number !== execution.number || block.time !== execution.time) {
        throw new Error(`${file}: block ${block.number} has time ${block.time}; the Safe Transaction Service says the transaction ran in block ${execution.number} at time ${execution.time}`);
      }
    }
  }
}

/** The field checks' chain for a transaction judged on the block it ran in: that block's time, as `verify` counts it. */
export const executedOn = (executed: BlockHeader): FieldChain => ({ blockTime: { kind: 'read', number: executed.number, time: executed.time } });

type Replayed = { readonly reader: Reader; readonly parent: BlockHeader; readonly executed: BlockHeader };

async function replayed(name: string, recording: PerturbRecording, execution: ServiceExecution): Promise<Replayed> {
  const file = `${PERTURB_DIR}/${name}.json`;
  checkRecordedBlocks(file, recording, execution);
  const reader = replayReader(recording.exchanges);
  const header = async (at: PerturbRecording['parent']) => agreed(await reader.header({ number: BigInt(at.number), hash: at.hash }), `${file} block ${at.number}`);
  return { reader, parent: await header(recording.parent), executed: await header(recording.executed) };
}

function replay({ reader, parent, executed }: Replayed, tx: SafeTx, card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): Promise<PerturbationReport> {
  const expectations = expectedChanges(card, templates, registry);
  const watch = expectations.kind === 'expected' ? [...expectations.changes.keys()].filter((asset): asset is Address => asset !== 'eth') : [];
  return checkPerturbations(
    tx,
    card,
    templates,
    registry,
    (copy) => simulateSafeTx(reader, { tx: copy, parent, time: executed.time, watch, ends: endsNeeded(expectations), views: viewCalls(card, templates, registry) }),
    executedOn(executed),
  );
}

/**
 * Runs `checkPerturbations` again on the recording `testdata/perturb/<name>.json`, offline: its card resolved against the
 * repository's templates and registry, every copy simulated from the recorded chain answers on the recorded parent block.
 */
export async function replayPerturbRecording(repoRoot: string, name: string, registry: Registry): Promise<PerturbationReport> {
  const recording = readPerturbRecording(repoRoot, name);
  const { tx, execution } = recordedTx(repoRoot, recording);
  const card = parseCard(recording.card);
  const templates = new Map(card.operations.map((op) => [op.template, loadTemplate(repoRoot, op.template, registry)]));
  if (recording.template !== undefined) {
    const replacing = parseTemplate(recording.template, registry);
    templates.set(replacing.id, replacing);
  }
  const resolution = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  if (resolution.kind === 'refused') throw new Error(`${PERTURB_DIR}/${name}.json: card refused: ${resolution.reason} at ${resolution.at}: ${resolution.detail}`);
  return replay(await replayed(name, recording, execution), tx, resolution.card, templates, registry);
}

/** A recorded transaction of one template, judged again offline with the template as it is now. */
export type FixtureJudgement = {
  readonly name: string;
  readonly outcome:
    | { readonly kind: 'card-refused'; readonly why: string }
    | { readonly kind: 'judged'; readonly mutations: MutationResult; readonly perturbation: PerturbationReport };
};

/** Each `testdata/perturb/` recording, by file name, whose card names only `template` and replaces no template. */
function recordingsOf(repoRoot: string, template: Template): { readonly name: string; readonly recording: PerturbRecording; readonly card: Card }[] {
  return readdirSync(join(repoRoot, PERTURB_DIR))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      const name = file.replace(/\.json$/, '');
      const recording = readPerturbRecording(repoRoot, name);
      const card = parseCard(recording.card);
      return recording.template === undefined && card.operations.every((op) => op.template === template.id) ? [{ name, recording, card }] : [];
    });
}

/**
 * Every recording `recordingsOf` names, in file-name order: its card resolved, its bound fields mutated
 * (`checkMutations`) and its free fields perturbed again from the recording. Each is named by its Safe transaction fixture.
 */
export async function judgeFixtures(repoRoot: string, template: Template, registry: Registry): Promise<FixtureJudgement[]> {
  const templates = new Map([[template.id, template]]);
  const judged: FixtureJudgement[] = [];
  for (const { name, recording, card } of recordingsOf(repoRoot, template)) {
    const { tx, execution } = recordedTx(repoRoot, recording);
    const resolution = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
    if (resolution.kind === 'refused') {
      judged.push({ name: recording.safeTx, outcome: { kind: 'card-refused', why: `${resolution.reason} at ${resolution.at}: ${resolution.detail}` } });
      continue;
    }
    const at = await replayed(name, recording, execution);
    const mutations = checkMutations(tx, resolution.card, templates, registry, [], executedOn(at.executed));
    const perturbation = await replay(at, tx, resolution.card, templates, registry);
    judged.push({ name: recording.safeTx, outcome: { kind: 'judged', mutations, perturbation } });
  }
  return judged;
}

/** The template's first recorded test transaction, of `recordingsOf`, whose card resolves against `registry`, with its card. */
export function firstRecordedTx(repoRoot: string, template: Template, registry: Registry): { readonly name: string; readonly tx: SafeTx; readonly card: ResolvedCard } | undefined {
  for (const { recording, card } of recordingsOf(repoRoot, template)) {
    const { tx } = recordedTx(repoRoot, recording);
    const resolution = resolveCard(card, { templates: new Map([[template.id, template]]), registry, addressBook: new Map(), safe: tx.safe });
    if (resolution.kind === 'resolved') return { name: recording.safeTx, tx, card: resolution.card };
  }
  return undefined;
}
