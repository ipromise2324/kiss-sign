import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpsUrl, Registry } from '../registry.ts';
import { SafeTxParseError, checksumAddress, parseAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { effectTokenNames } from '../template/template.ts';
import type { Effect, Template } from '../template/template.ts';
import { NotesError, citedUrl, plainText, shown } from './notes.ts';
import type { PastTxs } from './past-txs.ts';
import { ReportError, signedEntryNames } from './report.ts';
import type { PastTxsSection, Subject } from './report.ts';
import { TOKEN_CALLS, compareFlow, holdingTemplateCalls } from './trace.ts';
import type { MoneyKind, TraceCall, TracedTx } from './trace.ts';

type Traced = Extract<TracedTx, { kind: 'traced' }>;

type Direction = 'out' | 'in' | 'approval' | 'spent';
type Move = { readonly call: number; readonly kind: MoneyKind; readonly direction: Direction; readonly token: Address | 'eth'; readonly transactions: number; readonly example: Hex };

/** An address in a money call no template call covers whose code `verify` would not check at signing; `entry` is its name when the registry holds it. */
export type OutsideAddress = { readonly address: Address; readonly entry: string | undefined; readonly moves: readonly Move[] };

export type TracedRun = Pick<PastTxs, 'studies' | 'traces'>;
type Counted = { readonly tx: Traced; readonly callAddresses: ReadonlySet<string> };

function countTraces(template: Template, registry: Registry, runs: readonly TracedRun[]): { readonly counted: readonly Counted[]; readonly notCounted: number } {
  const fits = runs.flatMap(({ studies }) => studies.flatMap((study) => (study.kind === 'fit' && study.outside.length === 0 ? [study] : [])));
  const callAddresses = new Map(fits.map((fit) => [fit.hash, new Set(fit.values)] as const));
  const traces = runs.flatMap((run) => run.traces.map((tx) => holdingTemplateCalls(template, registry, tx)));
  const counted = new Map(traces.flatMap((tx) => (tx.kind === 'traced' ? [[tx.hash, tx] as const] : [])));
  const all = new Set([...callAddresses.keys(), ...traces.map(({ hash }) => hash)]);
  return { counted: [...counted.values()].map((tx) => ({ tx, callAddresses: callAddresses.get(tx.hash) ?? new Set() })), notCounted: all.size - counted.size };
}

const tokenKind = (call: TraceCall): MoneyKind | undefined => (call.selector === undefined ? undefined : (TOKEN_CALLS as Readonly<Record<string, MoneyKind>>)[call.selector]);

function movement(call: TraceCall, sender: Address): Pick<Move, 'kind' | 'direction' | 'token'> | undefined {
  if (call.type !== 'CALL' || call.to === undefined) return undefined;
  const kind = tokenKind(call) ?? (call.value === undefined ? undefined : 'eth');
  if (kind === undefined) return undefined;
  const [payer, payee] = kind === 'transferFrom' ? [call.args?.[0], call.args?.[1]] : kind === 'eth' ? [call.from, call.to] : [call.from, call.args?.[0]];
  const token = kind === 'eth' ? 'eth' : call.to;
  if (payer === sender) return { kind, direction: kind === 'approve' ? 'approval' : 'out', token };
  if (kind === 'approve') return undefined;
  if (payee === sender) return { kind, direction: 'in', token };
  return call.from === sender ? { kind, direction: 'spent', token } : undefined;
}

/**
 * Every address outside the code `verify` checks among the money calls of the traces, as `compareFlow` finds them with
 * no `flow` line written yet. For each trace the registry it labels with holds only the entries `verify` would check for
 * a card of that transaction, so a registered contract missing from `dependsOn` is found too.
 */
export const outsideAddresses = (template: Template, registry: Registry, runs: readonly TracedRun[]): OutsideAddress[] => outsideOf(template, registry, countTraces(template, registry, runs).counted);

function outsideOf(template: Template, registry: Registry, counted: readonly Counted[]): OutsideAddress[] {
  const found = new Map<Address, Map<string, Move>>();
  for (const { tx, callAddresses } of counted) {
    const signed = signedEntryNames(template, registry, callAddresses);
    const checked: Registry = { ...registry, byAddress: new Map([...registry.byAddress].filter(([, entry]) => signed.has(entry.name))) };
    const sender = tx.sender.address.toLowerCase() as Address;
    const label = (a: Address): string => (a === sender ? 'safe' : (checked.byAddress.get(a)?.name ?? 'other'));
    const inTx = new Set<string>();
    for (const group of compareFlow(template, checked, [], [tx]).uncovered) {
      for (const call of tx.calls) {
        const move = movement(call, sender);
        if (move?.kind !== group.kind || label(call.from) !== group.from || label(call.to as Address) !== group.to) continue;
        for (const address of new Set([call.from, call.to as Address, ...(call.args ?? [])])) {
          if (!group.others.includes(address)) continue;
          const moves = found.get(address) ?? new Map<string, Move>();
          found.set(address, moves);
          const key = `${group.call} ${move.kind} ${move.direction} ${move.token}`;
          const before = moves.get(key);
          const alreadyCounted = inTx.has(`${address} ${key}`);
          inTx.add(`${address} ${key}`);
          moves.set(key, { ...move, call: group.call, transactions: (before?.transactions ?? 0) + (alreadyCounted ? 0 : 1), example: before?.example ?? tx.hash });
        }
      }
    }
  }
  return [...found].map(([address, moves]) => ({ address, entry: registry.byAddress.get(address)?.name, moves: [...moves.values()] }));
}

const DIRECTION_WORDS: Readonly<Record<Direction, string>> = {
  out: 'paid by the sender',
  in: 'paid to the sender',
  approval: 'approved by the sender',
  spent: 'moved by the sender with an allowance it was given',
};

export function outsideLines(found: readonly OutsideAddress[], registry: Registry): string[] {
  const tokenName = (token: Move['token']): string => (token === 'eth' ? 'ETH' : (registry.byAddress.get(token)?.name ?? checksumAddress(token)));
  return found.flatMap(({ address, entry, moves }) => [
    `  ${checksumAddress(address)}: ${entry === undefined ? 'outside the registry' : `registered as ${entry}, whose code verify would not check for these transactions`}`,
    ...moves.map((m) => `    call ${m.call}: ${tokenName(m.token)} ${DIRECTION_WORDS[m.direction]} in a ${m.kind === 'eth' ? 'call that sends ETH' : m.kind}, ${m.transactions} transaction${m.transactions === 1 ? '' : 's'}, e.g. ${m.example}`),
  ]);
}

function tokenCoverageLines(template: Template, registry: Registry, traced: readonly Traced[]): string[] {
  const moved = (token: string, direction: Direction): number => {
    const address = token === 'eth' ? 'eth' : registry.entries.get(token)?.address.toLowerCase();
    return traced.filter((tx) => tx.calls.some((call) => {
      const move = movement(call, tx.sender.address.toLowerCase() as Address);
      return move?.direction === direction && move.token === address;
    })).length;
  };
  const choices = (effects: readonly Effect[]): string[] => [...new Set(effects.map((effect) => effectTokenNames(effect.token, template, registry)).filter((names) => names.length > 1).flat())].sort();
  const side = (tokens: readonly string[], direction: 'out' | 'in'): string => {
    const counts = tokens.map((token) => ({ token, n: moved(token, direction) }));
    const seen = counts.filter(({ n }) => n > 0).map(({ token, n }) => `${token} in ${n}`);
    const unseen = counts.filter(({ n }) => n === 0).map(({ token }) => token);
    return `  ${DIRECTION_WORDS[direction]}: ${[...seen, ...(unseen.length === 0 ? [] : [`in none: ${unseen.join(', ')}`])].join('; ')}`;
  };
  const [gives, gets] = [choices(template.effects.gives), choices(template.effects.gets)];
  if (gives.length === 0 || gets.length === 0) return [];
  return [`tokens the card can choose, over ${traced.length} traced transaction${traced.length === 1 ? '' : 's'} (a mint or burn is no call of a trace, so it counts as none):`, side(gives, 'out'), side(gets, 'in')];
}

export const TRACE_ADDRESSES_FILE = 'trace-addresses.json';

/**
 * The AI's judgement of one outside address, with at least one source. `not-fixed`: it differs per transaction or is
 * no fixed part of the operation. `known-limit`: the program cannot express it, and `needs` names the change that
 * would. A fixed contract that was missed has none: it is registered and listed in `dependsOn`.
 */
export type Judgement = { readonly sources: readonly HttpsUrl[]; readonly reason: string } & ({ readonly judgement: 'not-fixed' } | { readonly judgement: 'known-limit'; readonly needs: string });

/** A report's `trace-addresses.json`: each judged address, and why no trace counts when the AI states it. */
export type Judgements = { readonly addresses: ReadonlyMap<Address, Judgement>; readonly untraced: string | undefined };

const NONE: Judgements = { addresses: new Map(), untraced: undefined };
const UNTRACED = 'untraced';
const MAX_TEXT = 600;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fieldsOf(at: string, raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw)) throw new ReportError(`${at}: not a JSON object`);
  const extra = Object.keys(raw).find((field) => !fields.includes(field));
  if (extra !== undefined) throw new ReportError(`${at}: ${shown(extra)} is not a field here; use ${fields.join(', ')}`);
  return raw;
}

function parseJudgement(at: string, raw: unknown): Judgement {
  const { judgement } = fieldsOf(at, raw, ['judgement', 'reason', 'sources', 'needs']);
  if (judgement !== 'not-fixed' && judgement !== 'known-limit') throw new ReportError(`${at}: judgement is not not-fixed or known-limit`);
  const { reason, sources, needs } = fieldsOf(at, raw, ['judgement', 'reason', 'sources', ...(judgement === 'known-limit' ? ['needs'] : [])]);
  if (!Array.isArray(sources) || sources.length === 0) throw new ReportError(`${at}: sources is not a list of at least one https URL`);
  const shared = { reason: plainText(`${at}.reason`, reason, MAX_TEXT), sources: sources.map((url, i) => citedUrl(`${at}.sources[${i}]`, url)) };
  return judgement === 'known-limit' ? { judgement, ...shared, needs: plainText(`${at}.needs`, needs, MAX_TEXT) } : { judgement, ...shared };
}

export function parseJudgements(file: string, text: string): Judgements {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ReportError(`${file}: not JSON`);
  }
  if (!isRecord(raw)) throw new ReportError(`${file}: not a JSON object`);
  const addresses = new Map<Address, Judgement>();
  let untraced: string | undefined;
  try {
    for (const [key, value] of Object.entries(raw)) {
      const at = `${file}[${shown(key)}]`;
      if (key === UNTRACED) {
        untraced = plainText(`${at}.reason`, fieldsOf(at, value, ['reason']).reason, MAX_TEXT);
        continue;
      }
      const address = parseAddress(at, key);
      if (addresses.has(address)) throw new ReportError(`${at}: judged twice`);
      addresses.set(address, parseJudgement(at, value));
    }
  } catch (error) {
    throw error instanceof NotesError || error instanceof SafeTxParseError ? new ReportError(error.message) : error;
  }
  return { addresses, untraced };
}

const movesMoney = ({ effects }: Template): boolean => [effects.gives, effects.gets, effects.touches, effects.approves].some((list) => list.length > 0);

/**
 * Refuses a report to be recorded until its `trace-addresses.json` settles its past transactions' traces: a judgement
 * for each outside address, naming every one without, and for no other, and an `untraced` reason when a template that
 * moves money has no counted trace, and only then.
 */
export function requireJudged(repoRoot: string, subject: Subject, registry: Registry, pastTxs: readonly PastTxsSection[]): void {
  const file = join(subject.dir, TRACE_ADDRESSES_FILE);
  const path = join(repoRoot, file);
  const { addresses: judged, untraced } = existsSync(path) ? parseJudgements(file, readFileSync(path, 'utf8')) : NONE;
  const { counted, notCounted } = countTraces(subject.template, registry, pastTxs.map(({ run }) => run));
  const found = outsideOf(subject.template, registry, counted);
  const problems: string[] = [];
  const unjudged = found.filter(({ address }) => !judged.has(address));
  if (unjudged.length > 0)
    problems.push(`unjudged addresses move the sender's money in the recorded call traces; register a fixed contract and list it in dependsOn, or judge it in ${file}:`, ...outsideLines(unjudged, registry));
  for (const address of judged.keys())
    if (!found.some((outside) => outside.address === address)) problems.push(`${file}: no recorded call trace names ${checksumAddress(address)} as an address to settle; delete its judgement`);
  const needsReason = counted.length === 0 && movesMoney(subject.template);
  if (needsReason && untraced === undefined)
    problems.push(`no call trace counts (0 traced, ${notCounted} not counted), so nothing shows which addresses move the sender's money; study transactions with pnpm past-txs, or say why none can be traced in ${file} as "${UNTRACED}": { "reason" }`);
  if (!needsReason && untraced !== undefined) problems.push(`${file}: "${UNTRACED}" is only for a template that moves money with no counted trace; delete it`);
  if (problems.length > 0) throw new ReportError(problems.join('\n'));
}

export function traceAddressesText(template: Template, registry: Registry, run: TracedRun): string {
  const { counted, notCounted } = countTraces(template, registry, [run]);
  const found = outsideOf(template, registry, counted);
  const over = `over ${counted.length} traced, ${notCounted} not counted`;
  const addresses =
    found.length === 0
      ? [`addresses that move the sender's money in the traces and whose code verify does not check: nothing found ${over}`]
      : [`addresses that move the sender's money in the traces and whose code verify does not check, ${over}, to register or judge in ${TRACE_ADDRESSES_FILE} before pnpm report --record:`, ...outsideLines(found, registry)];
  const coverage = tokenCoverageLines(template, registry, counted.map(({ tx }) => tx));
  return [...addresses, ...coverage].map((line) => `${line}\n`).join('');
}
