import type { ResolvedCard } from '../card.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { keccakCode } from '../contracts/code.ts';
import { describeRefusal } from '../contracts/prove.ts';
import { locate } from '../contracts/proxy.ts';
import { pinAt } from '../registry.ts';
import type { Registry, RegistryEntry } from '../registry.ts';
import type { SafeTx } from '../safe/types.ts';
import { cardRefs } from '../template/template.ts';
import type { Rule, Template } from '../template/template.ts';
import type { ChainCheck } from './verdict.ts';

/**
 * Every registry contract the transaction or the card names: the Safe transaction's target, each contract a template
 * rule names, each registry address on the card, and each entry a card reference's attribute names, such as a vault's asset.
 */
export function codeClaims(tx: SafeTx, card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): RegistryEntry[] {
  const touched = new Map<string, RegistryEntry>();
  const add = (entry: RegistryEntry | undefined): void => {
    if (entry !== undefined) touched.set(entry.name, entry);
  };
  const visit = (rule: Rule | undefined): void => {
    if (rule?.kind === 'contract') add(registry.entries.get(rule.name));
    else if (rule?.kind === 'const' && rule.value.kind === 'address') add(registry.byAddress.get(rule.value.value));
    else if (rule?.kind === 'call') rule.call.args.forEach(visit);
    else if (rule?.kind === 'items') rule.items.forEach(visit);
    else if (rule?.kind === 'fields') rule.fields.forEach(visit);
  };
  add(registry.byAddress.get(tx.to));
  for (const op of card.operations) {
    const named = (field: string): RegistryEntry | undefined => {
      const value = op.values.get(field);
      if (value?.kind === 'contract') return value.entry;
      return value?.kind === 'address' && value.from === 'registry' ? registry.byAddress.get(value.address) : undefined;
    };
    for (const field of op.values.keys()) add(named(field));
    const template = templates.get(op.template);
    if (template === undefined) continue;
    for (const ref of cardRefs(template)) {
      const target = ref.attribute === undefined ? undefined : named(ref.field)?.attributes[ref.attribute];
      add(target === undefined ? undefined : registry.entries.get(target));
    }
    visit(template.nonce);
    for (const call of template.calls) {
      visit(call.to);
      visit(call.value);
      if (call.data !== 'empty') call.data.args.forEach(visit);
    }
  }
  return [...touched.values()];
}

const PASS: ChainCheck = { kind: 'pass' };
const mismatch = (finding: string): ChainCheck => ({ kind: 'mismatch', findings: [finding] });
const unverifiable = (reason: string): ChainCheck => ({ kind: 'unverifiable', reasons: [reason] });

/** A transaction to sign runs today's code. One that ran is judged by the code its block held. */
export type CodeTime = 'pending' | 'executed';

async function compare(reader: Reader, entry: RegistryEntry, at: BlockRef, time: CodeTime): Promise<ChainCheck> {
  const where = `${entry.name} ${entry.address}`;
  const pins = entry.code;
  if (pins === undefined) return unverifiable(`${where} has no code pin in the registry; run pnpm pin-code ${entry.name}`);
  const block = `at block ${at.number}`;
  const pin = time === 'pending' ? pins.current.pin : pinAt(pins, at.number);
  if (pin === undefined) return mismatch(`${where} ${block}: the registry pins its code only from block ${(pins.earlier[0] ?? pins.current).from}`);
  const own = await reader.getCode(entry.address, at);
  if (own.kind === 'unverifiable') return unverifiable(own.reason);
  const hash = keccakCode(own.value);
  if (hash !== pin.hash) return mismatch(`${where} has code hash ${hash} ${block}, the registry pins ${pin.hash}`);
  const located = await locate(reader, entry.address, own.value, at);
  if (located.kind === 'refused') {
    const detail = `${where} ${block}: ${describeRefusal(located.refusal)}`;
    return located.refusal.why === 'unverifiable' ? unverifiable(detail) : mismatch(detail);
  }
  const { proxy } = located;
  const was = pin.implementation;
  if (proxy.kind === 'none') return was === undefined ? PASS : mismatch(`${where} no longer delegates to ${was.address} ${block}, the registry pins that implementation`);
  if (was === undefined) return mismatch(`${where} delegates to ${proxy.implementation} ${block}, the registry pins no implementation`);
  if (proxy.implementation !== was.address) return mismatch(`${where} delegates to ${proxy.implementation} ${block}, the registry pins ${was.address}`);
  const runs = await reader.getCode(was.address, at);
  if (runs.kind === 'unverifiable') return unverifiable(runs.reason);
  const runsHash = keccakCode(runs.value);
  if (runsHash !== was.hash) return mismatch(`${where}'s implementation ${was.address} has code hash ${runsHash} ${block}, the registry pins ${was.hash}`);
  return PASS;
}

/**
 * Each entry must run, at `at`, the code its registry pin names: the same code, and behind a proxy the same
 * implementation. A pending transaction needs the current pin; an executed one the pin whose span holds `at`.
 */
export async function checkCode(reader: Reader, entries: readonly RegistryEntry[], at: BlockRef, time: CodeTime): Promise<ChainCheck> {
  const results: ChainCheck[] = [];
  for (const entry of entries) results.push(await compare(reader, entry, at, time));
  const findings = results.flatMap((r) => (r.kind === 'mismatch' ? r.findings : []));
  const reasons = results.flatMap((r) => (r.kind === 'unverifiable' ? r.reasons : []));
  if (findings.length > 0) return { kind: 'mismatch', findings };
  return reasons.length > 0 ? { kind: 'unverifiable', reasons } : PASS;
}
