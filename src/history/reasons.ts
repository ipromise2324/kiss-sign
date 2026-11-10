import { bytesToHex } from '@noble/hashes/utils.js';
import { selectorOf } from '../decode/abi.ts';
import { regionBytes } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import type { FloorResult } from '../floor/floor.ts';
import type { Address, SafeTx } from '../safe/types.ts';
import type { Verdict } from '../verify/verdict.ts';

/** CoW Protocol's settlement contract on mainnet, github.com/cowprotocol/contracts `networks.json`. */
export const GPV2_SETTLEMENT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41' as Address;
const COW_CALLS = new Map<string, string>(['setPreSignature(bytes,bool)', 'invalidateOrder(bytes)'].map((sig) => [selectorOf(sig), sig.slice(0, sig.indexOf('('))]));

/** What the harness knows about one past transaction when it picks the reason it is not MATCH. */
export type Facts = {
  readonly tx: SafeTx;
  readonly floor: FloorResult;
  readonly hasCard: boolean;
  /** Absent when no card was evaluated; `error` when the evaluation stopped before a verdict. */
  readonly outcome: { readonly kind: 'verdict'; readonly verdict: Verdict } | { readonly kind: 'error'; readonly message: string } | undefined;
};

/** `key` groups rows in the summary; `detail` says what about this transaction gave it. */
export type Reason = { readonly key: string; readonly detail: string };

function cowCalls(tx: SafeTx): string[] {
  const unwrapped = unwrapSafeTx(tx);
  if (unwrapped.kind !== 'direct' && unwrapped.kind !== 'multisend') return [];
  return unwrapped.calls.flatMap((call) => {
    const name = call.to === GPV2_SETTLEMENT ? COW_CALLS.get(`0x${bytesToHex(regionBytes(call.data).subarray(0, 4))}`) : undefined;
    return name === undefined ? [] : [`${name} at ${call.path}`];
  });
}

const floorRules = (floor: FloorResult): string | undefined =>
  floor.kind === 'pass' ? undefined : [...new Set(floor.findings.map((f) => `${f.rule} at ${f.callPath}`))].join(', ');

function verdictCauses(outcome: Facts['outcome']): Reason | undefined {
  if (outcome === undefined) return undefined;
  if (outcome.kind === 'error') return { key: 'error', detail: outcome.message };
  const { verdict } = outcome;
  if (verdict.kind === 'MATCH') return undefined;
  return {
    key: `${verdict.kind.toLowerCase()}: ${verdict.causes.map((c) => c.check).join('+')}`,
    detail:
      verdict.causes.length === 1
        ? (verdict.causes[0]?.details[0] ?? '')
        : verdict.causes.map((c) => `${c.check}: ${c.details[0] ?? ''}`).join('; '),
  };
}

/**
 * Why a past transaction is not MATCH, first row that applies. A MATCH has no reason, whatever the rows say.
 * The CoW row comes first because pre-signing or cancelling an order is a known next-phase operation even when the
 * floor refuses the open approval that comes with it.
 */
export const REASONS: readonly { readonly key: string; readonly decide: (facts: Facts) => string | undefined }[] = [
  {
    key: 'cow-next-phase',
    decide: ({ tx, floor }) => {
      const calls = cowCalls(tx);
      if (calls.length === 0) return undefined;
      const refused = floorRules(floor);
      return `GPv2Settlement ${calls.join(', ')}${refused === undefined ? '' : `; the floor also refuses ${refused}`}`;
    },
  },
  {
    key: 'refused-by-design',
    decide: ({ floor }) => floorRules(floor),
  },
  { key: 'no-card-yet', decide: ({ hasCard }) => (hasCard ? undefined : 'no card file, so no template covers it yet') },
];

export function reasonFor(facts: Facts): Reason | undefined {
  if (facts.outcome?.kind === 'verdict' && facts.outcome.verdict.kind === 'MATCH') return undefined;
  for (const { key, decide } of REASONS) {
    const detail = decide(facts);
    if (detail !== undefined) return { key, detail };
  }
  return verdictCauses(facts.outcome);
}

/**
 * The reason of an approval without a card that a later nonce spends: the spender's, since the approval is half of that
 * operation. A spender without a reason, a MATCH, leaves the approval its own.
 */
export function spentReason(own: Reason | undefined, spender: { readonly nonce: number; readonly reason: Reason | undefined }): Reason | undefined {
  if (own?.key !== 'no-card-yet' || spender.reason === undefined) return own;
  return { key: spender.reason.key, detail: `its approval is spent by nonce ${spender.nonce}: ${spender.reason.detail}` };
}
