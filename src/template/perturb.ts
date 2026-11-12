import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCard, resolveCard } from '../card.ts';
import type { Card, ResolvedCard } from '../card.ts';
import { replayReader } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import type { Read } from '../chain/reader.ts';
import type { EventLog } from '../chain/types.ts';
import { uintWord } from '../decode/codec.ts';
import type { Registry } from '../registry.ts';
import { parseServiceTx } from '../safe/parse.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { endsNeeded, expectedChanges, judgeEffects, viewCalls } from '../simulate/effects.ts';
import type { Observed } from '../simulate/effects.ts';
import { EXECUTION_SUCCESS } from '../simulate/events.ts';
import { simulateSafeTx } from '../simulate/simulate.ts';
import type { Observation } from '../simulate/simulate.ts';
import { checkTemplateFields, inspectTemplateFields } from './check.ts';
import { checkMutations } from './mutation.ts';
import type { MutationResult } from './mutation.ts';
import type { Leaf } from './check.ts';
import { loadTemplate, parseTemplate } from './template.ts';
import type { FreeClaim, Template } from './template.ts';

/**
 * What a copy of the transaction with one free field changed did. `reverted`: it did not execute. `refused`: the
 * engine's field or effects check refuses it, so it could never be signed as a MATCH. `same`: it emitted the same logs and
 * changed the Safe's balances, allowances and the views its template reads the same way. `changed`: it ran, the engine
 * would pass it, and something differs, so the field steers the transaction where the engine does not look.
 */
export type Outcome = 'reverted' | 'refused' | 'same' | 'changed';

export type Run = { readonly leaf: Leaf; readonly value: string; readonly outcome: Outcome | 'unverifiable'; readonly detail: string };

export type PerturbationReport =
  | { readonly kind: 'pass'; readonly runs: readonly Run[] }
  | { readonly kind: 'fail'; readonly runs: readonly Run[]; readonly failed: readonly Run[] }
  | { readonly kind: 'not-run'; readonly cause: 'fields' | 'unverifiable' | 'not-executed'; readonly reason: string };

const ALLOWED: Readonly<Record<FreeClaim, readonly Outcome[]>> = {
  scalar: ['reverted', 'refused', 'same'],
  proof: ['reverted', 'refused'],
  unread: ['refused', 'same'],
};

type Change = { readonly value: string; readonly at: number; readonly bytes: Uint8Array };

const word = (bytes: Uint8Array): bigint => BigInt(`0x${bytesToHex(bytes) || '0'}`);
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
      return values.map((n) => ({ value: String(n), at: start, bytes: uintWord(n) }));
    }
    case 'bool':
      return [{ value: String(word(current) === 0n), at: start, bytes: uintWord(word(current) === 0n ? 1n : 0n) }];
    case 'fixed-bytes': {
      const zero = new Uint8Array(32);
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

/** The logs, without the Safe's own ExecutionSuccess, which names the transaction's hash and so differs in every copy. */
function logText(logs: readonly EventLog[], safe: string): string {
  return JSON.stringify(logs.filter((log) => !(log.address === safe && log.topics[0] === EXECUTION_SUCCESS)));
}

function effectsText(observed: Extract<Observed, { kind: 'executed' }>): string {
  const allowances = observed.allowances.map((a) => [a.token, a.spender, String(a.before), String(a.after)]);
  const permit2 = observed.permit2.map((p) => [p.token, p.spender, ...[p.before, p.after].flatMap((a) => [String(a.amount), String(a.expiration), String(a.nonce)])]);
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
): Promise<PerturbationReport> {
  const { check, leaves } = inspectTemplateFields(tx, card, templates, registry);
  if (check.kind !== 'match') return { kind: 'not-run', cause: 'fields', reason: `the transaction's fields give ${check.kind}` };
  const base = await simulate(tx);
  if (base.kind === 'unverifiable') return { kind: 'not-run', cause: 'unverifiable', reason: base.reasons.join('; ') };
  if (base.observed.kind !== 'executed') return { kind: 'not-run', cause: 'not-executed', reason: `the transaction did not execute: ${base.observed.why}` };
  const baseLogs = logText(base.logs, tx.safe);
  const baseEffects = effectsText(base.observed);
  const data = hexToBytes(tx.data.slice(2));
  const runs: Run[] = [];
  for (const leaf of leaves) {
    if (leaf.rule.kind !== 'free') continue;
    for (const change of changes(leaf, data)) {
      const copy = applied(tx, change);
      const run = (outcome: Run['outcome'], detail = ''): void => {
        runs.push({ leaf, value: change.value, outcome, detail });
      };
      const fields = checkTemplateFields(copy, card, templates, registry);
      if (fields.kind !== 'match') {
        run('refused', `fields: ${fields.kind}`);
        continue;
      }
      const observation = await simulate(copy);
      if (observation.kind === 'unverifiable') run('unverifiable', observation.reasons.join('; '));
      else if (observation.observed.kind !== 'executed') run('reverted', observation.observed.why);
      else if (judgeEffects(observation.observed, card, templates, registry).kind !== 'match') run('refused', 'effects');
      else if (logText(observation.logs, tx.safe) === baseLogs && effectsText(observation.observed) === baseEffects) run('same');
      else run('changed', logText(observation.logs, tx.safe) === baseLogs ? "the Safe's balances, allowances or views differ" : 'the logs differ');
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

const readRecording = (repoRoot: string, name: string): PerturbRecording =>
  JSON.parse(readFileSync(join(repoRoot, PERTURB_DIR, `${name}.json`), 'utf8')) as PerturbRecording;

function recordedTx(repoRoot: string, recording: PerturbRecording): SafeTx {
  const fixture = JSON.parse(readFileSync(join(repoRoot, 'testdata', 'safe-tx', `${recording.safeTx}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

async function replay(name: string, recording: PerturbRecording, tx: SafeTx, card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): Promise<PerturbationReport> {
  const reader = replayReader(recording.exchanges);
  const header = async (at: PerturbRecording['parent']) => agreed(await reader.header({ number: BigInt(at.number), hash: at.hash }), `${PERTURB_DIR}/${name}.json block ${at.number}`);
  const [parent, executed] = [await header(recording.parent), await header(recording.executed)];
  const expectations = expectedChanges(card, templates, registry);
  const watch = expectations.kind === 'expected' ? [...expectations.changes.keys()].filter((asset): asset is Address => asset !== 'eth') : [];
  return checkPerturbations(tx, card, templates, registry, (copy) =>
    simulateSafeTx(reader, { tx: copy, parent, time: executed.time, watch, ends: endsNeeded(expectations), views: viewCalls(card, templates, registry) }),
  );
}

/**
 * Runs `checkPerturbations` again on the recording `testdata/perturb/<name>.json`, offline: its card resolved against the
 * repository's templates and registry, every copy simulated from the recorded chain answers on the recorded parent block.
 */
export async function replayPerturbRecording(repoRoot: string, name: string, registry: Registry): Promise<PerturbationReport> {
  const recording = readRecording(repoRoot, name);
  const tx = recordedTx(repoRoot, recording);
  const card = parseCard(recording.card);
  const templates = new Map(card.operations.map((op) => [op.template, loadTemplate(repoRoot, op.template, registry)]));
  if (recording.template !== undefined) {
    const replacing = parseTemplate(recording.template, registry);
    templates.set(replacing.id, replacing);
  }
  const resolution = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  if (resolution.kind === 'refused') throw new Error(`${PERTURB_DIR}/${name}.json: card refused: ${resolution.reason} at ${resolution.at}: ${resolution.detail}`);
  return replay(name, recording, tx, resolution.card, templates, registry);
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
      const recording = readRecording(repoRoot, name);
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
    const tx = recordedTx(repoRoot, recording);
    const resolution = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
    if (resolution.kind === 'refused') {
      judged.push({ name: recording.safeTx, outcome: { kind: 'card-refused', why: `${resolution.reason} at ${resolution.at}: ${resolution.detail}` } });
      continue;
    }
    const mutations = checkMutations(tx, resolution.card, templates, registry);
    const perturbation = await replay(name, recording, tx, resolution.card, templates, registry);
    judged.push({ name: recording.safeTx, outcome: { kind: 'judged', mutations, perturbation } });
  }
  return judged;
}

/** The template's first recorded test transaction, the first of `recordingsOf`, with its card; undefined when its card is refused or there is none. */
export function firstRecordedTx(repoRoot: string, template: Template, registry: Registry): { readonly name: string; readonly tx: SafeTx; readonly card: ResolvedCard } | undefined {
  const [first] = recordingsOf(repoRoot, template);
  if (first === undefined) return undefined;
  const tx = recordedTx(repoRoot, first.recording);
  const resolution = resolveCard(first.card, { templates: new Map([[template.id, template]]), registry, addressBook: new Map(), safe: tx.safe });
  return resolution.kind === 'resolved' ? { name: first.recording.safeTx, tx, card: resolution.card } : undefined;
}
