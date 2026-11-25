import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHttpsUrl } from '../registry.ts';
import type { HttpsUrl, Registry } from '../registry.ts';
import { checksumAddress, parseAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { effectTokenNames } from '../template/template.ts';
import type { Effect, Template } from '../template/template.ts';
import { ReportError, signedEntryNames } from './report.ts';
import type { PastTxsSection, Subject } from './report.ts';
import { TOKEN_CALLS, compareFlow } from './trace.ts';
import type { MoneyKind, TraceCall, TracedTx } from './trace.ts';

type Traced = Extract<TracedTx, { kind: 'traced' }>;

/** How a money call touches the sender: what it pays, what it is paid, an allowance it gives, or one it was given and spends. */
type Direction = 'out' | 'in' | 'approval' | 'spent';
type Move = { readonly call: number; readonly kind: MoneyKind; readonly direction: Direction; readonly token: Address | 'eth'; readonly transactions: number; readonly example: Hex };

/** An address in a money call no template call covers whose code `verify` does not check at signing; `entry` is its name when the registry holds it. */
export type OutsideAddress = { readonly address: Address; readonly entry: string | undefined; readonly moves: readonly Move[] };

const tracedOnce = (traces: readonly TracedTx[]): Traced[] => [...new Map(traces.flatMap((t) => (t.kind === 'traced' ? [[t.hash, t] as const] : []))).values()];

const tokenKind = (call: TraceCall): MoneyKind | undefined => (call.selector === undefined ? undefined : (TOKEN_CALLS as Readonly<Record<string, MoneyKind>>)[call.selector]);

/** How `call` moves the sender's money, or undefined when it does not. */
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
 * no `flow` line written yet. The registry it labels with holds only the entries `signedEntryNames` names, so a
 * registered contract missing from `dependsOn` is found too.
 */
export function outsideAddresses(template: Template, registry: Registry, traces: readonly TracedTx[]): OutsideAddress[] {
  const signed = signedEntryNames(template, registry);
  const checked: Registry = { ...registry, byAddress: new Map([...registry.byAddress].filter(([, entry]) => signed.has(entry.name))) };
  const found = new Map<Address, Map<string, Move>>();
  for (const tx of tracedOnce(traces)) {
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
          const counted = inTx.has(`${address} ${key}`);
          inTx.add(`${address} ${key}`);
          moves.set(key, { ...move, call: group.call, transactions: (before?.transactions ?? 0) + (counted ? 0 : 1), example: before?.example ?? tx.hash });
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

/** One block per address: its name in the registry when it has one, then each way it moves the sender's money. */
export function outsideLines(found: readonly OutsideAddress[], registry: Registry): string[] {
  const tokenName = (token: Move['token']): string => (token === 'eth' ? 'ETH' : (registry.byAddress.get(token)?.name ?? checksumAddress(token)));
  return found.flatMap(({ address, entry, moves }) => [
    `  ${checksumAddress(address)}: ${entry === undefined ? 'outside the registry' : `registered as ${entry}, whose code verify does not check for this template`}`,
    ...moves.map((m) => `    call ${m.call}: ${tokenName(m.token)} ${DIRECTION_WORDS[m.direction]} in a ${m.kind === 'eth' ? 'call that sends ETH' : m.kind}, ${m.transactions} transaction${m.transactions === 1 ? '' : 's'}, e.g. ${m.example}`),
  ]);
}

/** For each side of the effects where the card chooses among several tokens, in how many traced transactions each token moved. */
export function tokenCoverageLines(template: Template, registry: Registry, traces: readonly TracedTx[]): string[] {
  const traced = tracedOnce(traces);
  const moved = (token: string, direction: Direction): number => {
    const address = token === 'eth' ? 'eth' : registry.entries.get(token)?.address.toLowerCase();
    return traced.filter((tx) => tx.calls.some((call) => {
      const move = movement(call, tx.sender.address.toLowerCase() as Address);
      return move?.direction === direction && move.token === address;
    })).length;
  };
  const side = (effects: readonly Effect[], direction: 'out' | 'in'): string[] => {
    const chosen = effects.map((effect) => effectTokenNames(effect.token, template, registry)).filter((names) => names.length > 1);
    const tokens = [...new Set(chosen.flat())].sort();
    if (tokens.length === 0) return [];
    const counts = tokens.map((token) => ({ token, n: moved(token, direction) }));
    const seen = counts.filter(({ n }) => n > 0).map(({ token, n }) => `${token} in ${n}`);
    const unseen = counts.filter(({ n }) => n === 0).map(({ token }) => token);
    return [`  ${DIRECTION_WORDS[direction]}: ${[...seen, ...(unseen.length === 0 ? [] : [`in none: ${unseen.join(', ')}`])].join('; ')}`];
  };
  const lines = [...side(template.effects.gives, 'out'), ...side(template.effects.gets, 'in')];
  return lines.length === 0 ? [] : [`tokens the card can choose, over ${traced.length} traced transaction${traced.length === 1 ? '' : 's'} (a mint or burn is no call of a trace, so it counts as none):`, ...lines];
}

export const TRACE_ADDRESSES_FILE = 'trace-addresses.json';

/**
 * The AI's judgement of one outside address, with at least one source. `not-fixed`: it differs per transaction or is
 * no fixed part of the operation. `known-limit`: the program cannot express it, and `needs` names the change that
 * would. A fixed contract that was missed has none: it is registered and listed in `dependsOn`.
 */
export type Judgement = { readonly sources: readonly HttpsUrl[]; readonly reason: string } & ({ readonly judgement: 'not-fixed' } | { readonly judgement: 'known-limit'; readonly needs: string });

/** A report's `trace-addresses.json`: each judged address once, in full, with its judgement. */
export function parseJudgements(file: string, raw: unknown): Map<Address, Judgement> {
  const refuse = (at: string, why: string): never => {
    throw new ReportError(`${file}${at}: ${why}`);
  };
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isRecord(raw)) return refuse('', 'not a JSON object');
  const judged = new Map<Address, Judgement>();
  for (const [key, value] of Object.entries(raw)) {
    const at = `.${key}`;
    let address: Address;
    try {
      address = parseAddress(file + at, key);
    } catch (error) {
      return refuse(at, (error as Error).message);
    }
    if (judged.has(address)) refuse(at, 'judged twice');
    if (!isRecord(value)) return refuse(at, 'not a JSON object');
    const text = (field: string): string => {
      const v = value[field];
      return typeof v === 'string' && v.trim() !== '' ? v : refuse(at, `${field} is not a non-empty string`);
    };
    const { judgement, sources } = value;
    if (judgement !== 'not-fixed' && judgement !== 'known-limit') return refuse(at, 'judgement is not not-fixed or known-limit');
    const fields = ['judgement', 'reason', 'sources', ...(judgement === 'known-limit' ? ['needs'] : [])];
    const extra = Object.keys(value).find((field) => !fields.includes(field));
    if (extra !== undefined) refuse(at, `${JSON.stringify(extra.slice(0, 80))} is not a field of a ${judgement} judgement`);
    if (!Array.isArray(sources) || sources.length === 0) return refuse(at, 'sources is not a list of at least one https URL');
    const shared = { reason: text('reason'), sources: sources.map((url, i) => parseHttpsUrl(url) ?? refuse(`${at}.sources[${i}]`, 'not an https URL in RFC 3986 characters')) };
    judged.set(address, judgement === 'known-limit' ? { judgement, ...shared, needs: text('needs') } : { judgement, ...shared });
  }
  return judged;
}

function readJudgements(repoRoot: string, file: string): Map<Address, Judgement> {
  const path = join(repoRoot, file);
  if (!existsSync(path)) return new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ReportError(`${file}: not JSON`);
  }
  return parseJudgements(file, raw);
}

/**
 * Refuses a report to be recorded while an outside address in its past transactions' traces has no judgement in the
 * `trace-addresses.json` beside the report, naming every one, or while that file judges an entry `verify` checks.
 */
export function requireJudged(repoRoot: string, subject: Subject, registry: Registry, pastTxs: readonly PastTxsSection[]): void {
  const file = join(subject.dir, TRACE_ADDRESSES_FILE);
  const judged = readJudgements(repoRoot, file);
  const signed = signedEntryNames(subject.template, registry);
  for (const address of judged.keys()) {
    const entry = registry.byAddress.get(address)?.name;
    if (entry !== undefined && signed.has(entry)) throw new ReportError(`${file}: ${checksumAddress(address)} is ${entry}, whose code verify checks; delete its judgement`);
  }
  const unjudged = outsideAddresses(subject.template, registry, pastTxs.flatMap(({ run }) => run.traces)).filter(({ address }) => !judged.has(address));
  if (unjudged.length === 0) return;
  throw new ReportError(
    [
      `unjudged addresses move the sender's money in the recorded call traces; register a fixed contract and list it in dependsOn, or judge it in ${file}:`,
      ...outsideLines(unjudged, registry),
    ].join('\n'),
  );
}

/** What `pnpm past-txs` prints after a run: every outside address its traces hold, and the tokens they cover. */
export function traceAddressesText(template: Template, registry: Registry, traces: readonly TracedTx[]): string {
  const found = outsideAddresses(template, registry, traces);
  const coverage = tokenCoverageLines(template, registry, traces);
  const addresses = found.length === 0 ? [] : [`addresses that move the sender's money in the traces and whose code verify does not check, to register or judge in ${TRACE_ADDRESSES_FILE} before pnpm report --record:`, ...outsideLines(found, registry)];
  return [...addresses, ...coverage].map((line) => `${line}\n`).join('');
}
