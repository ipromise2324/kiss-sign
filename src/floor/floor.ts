import { bytesToHex } from '@noble/hashes/utils.js';
import { selectorOf } from '../decode/abi.ts';
import type { Span } from '../decode/codec.ts';
import { regionBytes } from '../decode/codec.ts';
import { unwrapSafeTx } from '../decode/multisend.ts';
import type { InnerCall } from '../decode/multisend.ts';
import type { ResolvedCard } from '../card.ts';
import type { AllowanceRoute, Registry } from '../registry.ts';
import type { Address, Hex, SafeTx } from '../safe/types.ts';
import { keptAllowances } from '../simulate/effects.ts';
import { PERMIT2 } from '../simulate/events.ts';
import type { Template } from '../template/template.ts';

export type FloorRuleId = 'fee-fields' | 'delegatecall' | 'self-call' | 'unlimited-approval' | 'safe-state';

/** `bytes` is the span in the Safe transaction's `data`, absent for a field outside it. */
export type FloorFinding = { readonly rule: FloorRuleId; readonly callPath: string; readonly detail: string; readonly bytes: Span | undefined };

export type FloorResult = { readonly kind: 'pass' } | { readonly kind: 'refused'; readonly findings: readonly FloorFinding[] };

export const floorResult = (findings: readonly FloorFinding[]): FloorResult =>
  findings.length === 0 ? { kind: 'pass' } : { kind: 'refused', findings };

/** The Safe transaction with its calls unwrapped; `calls` is empty when a delegatecall cannot be unwrapped. */
type View = { readonly tx: SafeTx; readonly calls: readonly InnerCall[]; readonly unwrapError: Found | undefined };

/** A finding before the table stamps it with the rule that made it. */
type Found = Omit<FloorFinding, 'rule'>;

type StaticRule = { readonly id: FloorRuleId; readonly check: (view: View, allowed: FloorAllowed) => readonly Found[] };

/** An unlimited allowance from the Safe that may stay: of `token`, or of any token when undefined, to `spender` through `via`. */
export type StandingSpender = { readonly via: AllowanceRoute; readonly spender: Address; readonly token: Address | undefined };

/** The owner or threshold change the card's one `effects.safe` declares, resolved to addresses and a number. */
export type SettingsChange = { readonly add: Address | undefined; readonly remove: Address | undefined; readonly threshold: bigint | undefined };

/** What a card lets past the floor rules: the unlimited allowances its templates keep, and the owner or threshold change it declares. */
export type FloorAllowed = { readonly standing?: readonly StandingSpender[]; readonly change?: SettingsChange | undefined };

/** The allowances the card's templates keep unlimited (`effects.approves`): the only ones `verify`'s floor lets through. */
export const keptUnlimited = (card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): StandingSpender[] =>
  [...keptAllowances(card, templates, registry).kept].flatMap(([key, limit]) => {
    const [via, token, spender] = key.split('|') as [AllowanceRoute, Address, Address];
    return limit === 'unlimited' ? [{ via, spender, token }] : [];
  });

/**
 * Every registry contract whose entry declares a standing allowance, for any token: what some template could keep, so a
 * past transaction's unlimited approval to one is not refused by design.
 */
export const standingSpenders = (registry: Registry): StandingSpender[] =>
  [...registry.entries.values()].flatMap((entry) => (entry.standingAllowance === undefined ? [] : [{ via: entry.standingAllowance.via, spender: entry.address, token: undefined }]));

export const isStanding = (standing: readonly StandingSpender[], via: AllowanceRoute, spender: Address, token: Address): boolean =>
  standing.some((s) => s.via === via && s.spender.toLowerCase() === spender.toLowerCase() && (s.token === undefined || s.token.toLowerCase() === token.toLowerCase()));

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** ERC-20 allowances at or above 2^255 are treated as unlimited; no real amount comes near it. */
export const UNLIMITED_ERC20 = 1n << 255n;
/** Permit2 never lowers an allowance of 2^160-1 when it is spent. */
export const PERMIT2_MAX = (1n << 160n) - 1n;

/** `via` is the route a registry entry's standing allowance must name to keep this approval unlimited; none for an NFT approve-all. */
type Approval = {
  readonly signature: string;
  readonly selector: Hex;
  readonly token: 'target' | number;
  readonly spender: number;
  readonly amount: number;
  readonly unlimited: bigint;
  readonly via: AllowanceRoute | undefined;
};

const approval = (signature: string, token: 'target' | number, spender: number, amount: number, unlimited: bigint, via: AllowanceRoute | undefined): Approval => ({
  signature,
  selector: selectorOf(signature),
  token,
  spender,
  amount,
  unlimited,
  via,
});

/** Argument positions by word. An NFT approve-all is unlimited whenever its flag is set. Permit2's `approve` names the token as its first argument and is called on Permit2. */
const APPROVALS: readonly Approval[] = [
  approval('approve(address,uint256)', 'target', 0, 1, UNLIMITED_ERC20, 'erc20'),
  approval('increaseAllowance(address,uint256)', 'target', 0, 1, UNLIMITED_ERC20, 'erc20'),
  approval('approve(address,address,uint160,uint48)', 0, 1, 2, PERMIT2_MAX, 'permit2'),
  approval('setApprovalForAll(address,bool)', 'target', 0, 1, 1n, undefined),
];

const addressIn = (word: bigint): Address => `0x${word.toString(16).padStart(64, '0').slice(24)}` as Address;

function feeFields({ tx }: View): Found[] {
  const fields = [
    ['safeTxGas', tx.safeTxGas, 0n],
    ['baseGas', tx.baseGas, 0n],
    ['gasPrice', tx.gasPrice, 0n],
    ['gasToken', tx.gasToken, ZERO],
    ['refundReceiver', tx.refundReceiver, ZERO],
  ] as const;
  return fields
    .filter(([, value, zero]) => value !== zero)
    .map(([name, value]) => ({ callPath: 'safeTx', detail: `${name} is ${value}, must be zero`, bytes: undefined }));
}

/**
 * The Safe may delegatecall only an official MultiSend, and every call inside it must be a plain call. A nested
 * delegatecall is refused outright, so the rule never has to hold at a deeper level.
 */
function delegatecall({ calls, unwrapError }: View): Found[] {
  const nested = calls
    .filter((call) => call.operation !== 0)
    .map((call): Found => ({ callPath: call.path, detail: `a delegatecall to ${call.to} inside the MultiSend`, bytes: call.fields?.operation }));
  return unwrapError === undefined ? nested : [unwrapError, ...nested];
}

/**
 * The owner and threshold functions a template may call on the Safe itself; the simulated floor then requires the
 * change its `effects.safe` declares, and no other.
 */
export const OWNER_FUNCTIONS: ReadonlySet<Hex> = new Set(
  ['addOwnerWithThreshold(address,uint256)', 'removeOwner(address,address,uint256)', 'swapOwner(address,address,address)', 'changeThreshold(uint256)'].map(selectorOf),
);

/**
 * Every owner, threshold, module, guard, fallback handler and singleton change is a call from the Safe to itself. Only
 * the owner and threshold functions pass, and only for a card that declares such a change.
 */
function selfCall({ tx, calls }: View, { change }: FloorAllowed): Found[] {
  return calls
    .filter((call) => call.to === tx.safe && call.data.end > call.data.start)
    .filter((call) => change === undefined || !OWNER_FUNCTIONS.has(`0x${bytesToHex(regionBytes(call.data).subarray(0, 4))}` as Hex))
    .map((call) => {
      const selector = bytesToHex(regionBytes(call.data).subarray(0, 4));
      return { callPath: call.path, detail: `a call to the Safe itself with data (selector 0x${selector})`, bytes: [call.data.start, call.data.end] as const };
    });
}

function unlimitedApproval({ calls }: View, { standing = [] }: FloorAllowed): Found[] {
  const findings: Found[] = [];
  for (const call of calls) {
    const data = regionBytes(call.data);
    const selector = `0x${bytesToHex(data.subarray(0, 4))}`;
    const kind = APPROVALS.find((a) => a.selector === selector);
    if (kind === undefined) continue;
    // Read words as the EVM does: a short calldata reads as zero-padded, which an old token without a length check accepts.
    const word = (i: number): bigint => {
      const bytes = new Uint8Array(32);
      bytes.set(data.subarray(4 + i * 32, 4 + (i + 1) * 32));
      return BigInt(`0x${bytesToHex(bytes)}`);
    };
    const amount = word(kind.amount);
    if (amount < kind.unlimited) continue;
    const token = kind.token === 'target' ? call.to : addressIn(word(kind.token));
    // Permit2's approve counts only when it is Permit2 that is called.
    const route = kind.via === 'permit2' && call.to.toLowerCase() !== PERMIT2 ? undefined : kind.via;
    if (route !== undefined && isStanding(standing, route, addressIn(word(kind.spender)), token)) continue;
    const at = call.data.start + 4 + kind.amount * 32;
    findings.push({
      callPath: call.path,
      detail: `${kind.signature} of token ${token} to spender ${addressIn(word(kind.spender))}, amount ${amount}`,
      bytes: [at, Math.min(at + 32, call.data.end)],
    });
  }
  return findings;
}

export const STATIC_RULES: readonly StaticRule[] = [
  { id: 'fee-fields', check: feeFields },
  { id: 'delegatecall', check: delegatecall },
  { id: 'self-call', check: selfCall },
  { id: 'unlimited-approval', check: unlimitedApproval },
];

function viewOf(tx: SafeTx): View {
  const unwrapped = unwrapSafeTx(tx);
  switch (unwrapped.kind) {
    case 'direct':
    case 'multisend':
      return { tx, calls: unwrapped.calls, unwrapError: undefined };
    case 'foreign-delegatecall':
      return { tx, calls: [], unwrapError: { callPath: 'safeTx', detail: `a delegatecall to ${unwrapped.to}, which is not an official MultiSend`, bytes: undefined } };
    default:
      return {
        tx,
        calls: [],
        unwrapError: { callPath: 'safeTx', detail: `the MultiSend data does not decode (${unwrapped.kind} at byte ${unwrapped.at})`, bytes: [unwrapped.at, unwrapped.at + 1] },
      };
  }
}

/**
 * Protocol-free rules every Safe transaction must meet, whatever its template says. Only what `allowed` names passes
 * beyond them: for `verify`, the unlimited allowances the card's templates keep, which template load allows only to a
 * registry contract that declares a standing allowance of that route, and the Safe's owner and threshold functions
 * when one of the card's operations declares such a change.
 */
export function checkFloor(tx: SafeTx, allowed: FloorAllowed = {}): FloorResult {
  const view = viewOf(tx);
  return floorResult(STATIC_RULES.flatMap((rule) => rule.check(view, allowed).map((found) => ({ rule: rule.id, ...found }))));
}
