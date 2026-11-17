import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { EventLog, SimulationCall } from '../chain/types.ts';
import { selectorOf } from '../decode/abi.ts';
import { uintWord } from '../decode/codec.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { uintOf } from '../simulate/events.ts';
import { isNamedToken } from '../template/template.ts';
import type { CardRef, EffectToken, LeafRule, Template, Tolerance } from '../template/template.ts';
import type { Sender } from './study.ts';

/**
 * An effect whose amount the transaction states: an exact card amount of a token, which the argument bound to that
 * card field holds, or a token the operation touches, stated as none. `receiver` is the card field of whom it gives to;
 * giving to the sender itself changes nothing and is not measured, as `verify` does not judge it.
 */
export type StatedEffect = {
  readonly side: 'gives' | 'gets' | 'touches';
  readonly token: EffectToken;
  readonly amount: string | undefined;
  readonly receiver: CardRef | undefined;
  readonly tolerance: Tolerance | undefined;
};

export function statedEffects(template: Template): StatedEffect[] {
  const { gives, gets, touches } = template.effects;
  const exact = (side: 'gives' | 'gets') => (effect: Template['effects']['gives'][number]): StatedEffect[] =>
    effect.token === 'eth' || effect.amount.kind !== 'card' ? [] : [{ side, token: effect.token, amount: effect.amount.field, receiver: effect.to, tolerance: effect.tolerance }];
  return [
    ...gives.flatMap(exact('gives')),
    ...gets.flatMap(exact('gets')),
    ...touches.map((t): StatedEffect => ({ side: 'touches', token: { contract: t.token }, amount: undefined, receiver: undefined, tolerance: t.tolerance })),
  ];
}

const refText = (ref: CardRef): string => `card.${ref.field}${ref.attribute === undefined ? '' : `.${ref.attribute}`}`;
const tokenText = (token: EffectToken): string => (token === 'eth' ? 'eth' : isNamedToken(token) ? token.contract : refText(token));

/** Such as `gives card.amount of card.token to card.recipient`. */
export function effectText(effect: StatedEffect): string {
  if (effect.side === 'touches') return `touches ${tokenText(effect.token)}`;
  return `${effect.side} card.${effect.amount} of ${tokenText(effect.token)}${effect.receiver === undefined ? '' : ` to ${refText(effect.receiver)}`}`;
}

type Party = 'sender' | 'receiver';

/** How far a party's balance of `token` ended from what the transaction states, in signed base units: below 0, lower. */
export type Difference = { readonly effect: number; readonly token: Address; readonly party: Party; readonly by: bigint };

export type Measurement = { readonly kind: 'measured'; readonly differences: readonly Difference[] } | { readonly kind: 'unmeasured'; readonly why: string };

/** One fitting transaction as `measure` reads it: its leaves, paired with the rules of the shape it fit. */
type FitLeaves = { readonly hash: Hex; readonly sender: Sender; readonly rules: readonly LeafRule[]; readonly values: readonly string[] };

const sameRef = (a: CardRef, b: CardRef): boolean => a.field === b.field && a.attribute === b.attribute;

function cardValue(fit: FitLeaves, ref: CardRef): string | undefined {
  const i = fit.rules.findIndex((leaf) => {
    const rule = leaf.kind === 'address-word' ? leaf.rule : leaf;
    return rule.kind === 'card' && sameRef(rule.ref, ref);
  });
  return i === -1 ? undefined : fit.values[i];
}

function addressOf(fit: FitLeaves, ref: CardRef, registry: Registry): Address | undefined {
  const held = cardValue(fit, ref);
  if (held !== undefined) return /^0x[0-9a-f]{40}$/.test(held) ? (held as Address) : undefined;
  if (ref.attribute === undefined) return undefined;
  const owner = cardValue(fit, { field: ref.field, attribute: undefined });
  const name = owner === undefined ? undefined : registry.byAddress.get(owner as Address)?.attributes[ref.attribute];
  return name === undefined ? undefined : registry.entries.get(name)?.address;
}

type Stated = { readonly effect: number; readonly token: Address; readonly amount: bigint; readonly receiver: Address | undefined; readonly side: StatedEffect['side'] };

/** Each effect the transaction states, resolved to its token, amount and receiver; an effect it does not state is left out. */
function statedIn(fit: FitLeaves, effects: readonly StatedEffect[], registry: Registry): Stated[] {
  return effects.flatMap((effect, i): Stated[] => {
    const token = effect.token === 'eth' ? undefined : isNamedToken(effect.token) ? registry.entries.get(effect.token.contract)?.address : addressOf(fit, effect.token, registry);
    const raw = effect.amount === undefined ? '0' : cardValue(fit, { field: effect.amount, attribute: undefined });
    if (token === undefined || raw === undefined || !/^[0-9]+$/.test(raw)) return [];
    const receiver = effect.receiver === undefined ? undefined : addressOf(fit, effect.receiver, registry);
    if (receiver === fit.sender.address) return [];
    return [{ effect: i, token, amount: BigInt(raw), receiver, side: effect.side }];
  });
}

/** EIP-7825 caps a transaction's gas at 2^24. */
const RUN_GAS = 1n << 24n;
const READ_GAS = 100_000n;

const balanceOf = (from: Address, token: Address, holder: Address): SimulationCall => ({
  from,
  to: token,
  data: `0x${bytesToHex(concatBytes(hexToBytes(selectorOf('balanceOf(address)').slice(2)), uintWord(BigInt(holder))))}` as Hex,
  gas: READ_GAS,
});

const logsOf = (logs: readonly EventLog[], token: Address): string => JSON.stringify(logs.filter((l) => l.address === token).map(({ topics, data }) => ({ topics, data })));

/**
 * Runs the transaction alone, as sent, on its parent block, and reads each party's balance of each stated token just
 * before and just after it in the same simulated block. Undefined when the transaction states no amount.
 */
export async function measure(reader: Reader, fit: FitLeaves, effects: readonly StatedEffect[], registry: Registry): Promise<Measurement | undefined> {
  const stated = statedIn(fit, effects, registry);
  if (stated.length === 0) return undefined;
  const unmeasured = (why: string): Measurement => ({ kind: 'unmeasured', why });
  const txRead = await reader.getTransaction(fit.hash);
  if (txRead.kind === 'unverifiable') return unmeasured(txRead.reason);
  const tx = txRead.value;
  if (tx === null || tx.to === null || tx.blockNumber === null) return unmeasured('neither provider knows the transaction as executed');
  if (tx.value !== 0n) return unmeasured('it sends ETH, which the run alone does not');
  const receiptRead = await reader.getTransactionReceipt(fit.hash);
  if (receiptRead.kind === 'unverifiable') return unmeasured(receiptRead.reason);
  const receipt = receiptRead.value;
  if (receipt === null || receipt.status !== 1) return unmeasured('it has no successful receipt');
  const [parent, block] = await Promise.all([reader.block(tx.blockNumber - 1n), reader.block(tx.blockNumber)]);
  if (parent.kind === 'unverifiable') return unmeasured(parent.reason);
  if (block.kind === 'unverifiable') return unmeasured(block.reason);
  if (block.value.hash !== receipt.blockHash) return unmeasured(`block ${tx.blockNumber} is no longer the block the receipt names`);
  const header = await reader.header(block.value);
  if (header.kind === 'unverifiable') return unmeasured(header.reason);

  const holders = (s: Stated): Address[] => [fit.sender.address, ...(s.receiver === undefined ? [] : [s.receiver])];
  const key = (token: Address, holder: Address) => `${token}:${holder}`;
  const pairs = [...new Map(stated.flatMap((s) => holders(s).map((holder) => [key(s.token, holder), { token: s.token, holder }] as const))).values()];
  const reads = pairs.map(({ token, holder }) => balanceOf(tx.from, token, holder));
  const run: SimulationCall = { from: tx.from, to: tx.to, data: tx.input, gas: RUN_GAS };
  const { number, time, gasLimit, mixHash } = header.value;
  const simulated = await reader.simulateV1({ block: { number, time, gasLimit, prevRandao: mixHash }, stateOverrides: {}, calls: [...reads, run, ...reads] }, parent.value);
  if (simulated.kind === 'unverifiable') return unmeasured(simulated.reason);
  const calls = simulated.value;
  const alone = calls[reads.length];
  if (alone?.status !== 'success') return unmeasured('it reverts alone on its parent block');
  const moved = [...new Set(stated.map((s) => s.token))].filter((token) => logsOf(alone.logs, token) !== logsOf(receipt.logs, token));
  if (moved.length > 0) return unmeasured('alone on its parent block its token logs differ from its receipt, so it moved the token otherwise');
  const change = new Map<string, bigint>();
  for (const [i, { token, holder }] of pairs.entries()) {
    const [before, after] = [calls[i], calls[reads.length + 1 + i]];
    if (before?.status !== 'success' || after?.status !== 'success' || before.returnData.length !== 66 || after.returnData.length !== 66) {
      return unmeasured(`balanceOf at ${checksumAddress(token)} could not be read`);
    }
    change.set(key(token, holder), uintOf(after.returnData) - uintOf(before.returnData));
  }
  const expected = new Map<string, bigint>();
  const expect = (token: Address, holder: Address, by: bigint) => expected.set(key(token, holder), (expected.get(key(token, holder)) ?? 0n) + by);
  for (const s of stated) {
    expect(s.token, fit.sender.address, s.side === 'gives' ? -s.amount : s.side === 'gets' ? s.amount : 0n);
    if (s.receiver !== undefined) expect(s.token, s.receiver, s.amount);
  }
  const by = (token: Address, holder: Address): bigint => (change.get(key(token, holder)) ?? 0n) - (expected.get(key(token, holder)) ?? 0n);
  const differences = stated.flatMap((s): Difference[] => [
    { effect: s.effect, token: s.token, party: 'sender', by: by(s.token, fit.sender.address) },
    ...(s.receiver === undefined ? [] : [{ effect: s.effect, token: s.token, party: 'receiver' as const, by: by(s.token, s.receiver) }]),
  ]);
  return { kind: 'measured', differences };
}

/** One effect over every measured transaction of one token, for one party: how many differed by each amount. */
type Distribution = { readonly counts: ReadonlyMap<bigint, number>; readonly lowest: bigint; readonly highest: bigint };

export function distributionOf(differences: readonly Difference[]): Distribution {
  const counts = new Map<bigint, number>();
  for (const { by } of differences) counts.set(by, (counts.get(by) ?? 0) + 1);
  const values = [...counts.keys()];
  return { counts, lowest: values.reduce((a, b) => (b < a ? b : a), 0n), highest: values.reduce((a, b) => (b > a ? b : a), 0n) };
}

/**
 * What the evidence says of an effect's tolerance, from the sender's differences in tokens a card can name:
 * `beyond` when one ended further than the tolerance allows (0 without one), `unfounded` when a tolerance is declared
 * and none differed at all.
 */
type ToleranceFinding = { readonly kind: 'beyond'; readonly lower: bigint; readonly higher: bigint } | { readonly kind: 'unfounded' };

export function toleranceFinding(effect: StatedEffect, sender: readonly Difference[]): ToleranceFinding | undefined {
  const { lowest, highest } = distributionOf(sender);
  const less = effect.tolerance?.less ?? 0n;
  const more = effect.tolerance?.more ?? 0n;
  if (-lowest > less || highest > more) return { kind: 'beyond', lower: -lowest > less ? -lowest : 0n, higher: highest > more ? highest : 0n };
  if (effect.tolerance !== undefined && lowest === 0n && highest === 0n) return { kind: 'unfounded' };
  return undefined;
}

/** Whether the report shows an effect: some measured difference is not 0, or it declares a tolerance. */
export const shown = (effect: StatedEffect, differences: readonly Difference[]): boolean => effect.tolerance !== undefined || differences.some((d) => d.by !== 0n);
