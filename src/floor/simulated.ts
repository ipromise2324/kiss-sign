import type { EventLog } from '../chain/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { Observed } from '../simulate/effects.ts';
import { APPROVAL, PERMIT2, PERMIT2_INDEXED, addressOf, namesAddress, topic, uintOf } from '../simulate/events.ts';
import type { SafeState, SafeStateField } from '../simulate/safe-state.ts';
import { PERMIT2_MAX, UNLIMITED_ERC20, floorResult, isStanding } from './floor.ts';
import type { FloorFinding, FloorResult, StandingSpender } from './floor.ts';

/** Events the Safe logs when its settings change, from safe-global/safe-smart-account v1.3.0 to v1.5.0. */
const SETTINGS_EVENTS: ReadonlyMap<Hex, string> = new Map(
  [
    'AddedOwner(address)',
    'RemovedOwner(address)',
    'ChangedThreshold(uint256)',
    'EnabledModule(address)',
    'DisabledModule(address)',
    'ChangedGuard(address)',
    'ChangedModuleGuard(address)',
    'ChangedFallbackHandler(address)',
    'ChangedMasterCopy(address)',
    'SafeSetup(address,address[],uint256,address,address)',
  ].map((signature) => [topic(signature), signature]),
);

const render = (value: SafeState[SafeStateField]): string =>
  Array.isArray(value) ? `[${value.join(', ')}]` : String(value);

function stateFindings(before: SafeState, after: SafeState): FloorFinding[] {
  const fields = Object.keys(before) as SafeStateField[];
  return fields
    .filter((field) => render(before[field]) !== render(after[field]))
    .map((field) => ({
      rule: 'safe-state',
      callPath: 'safe',
      detail: `${field} changed from ${render(before[field])} to ${render(after[field])}`,
      bytes: undefined,
    }));
}

function unlimitedPermit2Of(log: EventLog, safe: Address, standing: readonly StandingSpender[]): FloorFinding | undefined {
  const [first, owner, token, spender] = log.topics;
  if (log.address !== PERMIT2 || first === undefined || !PERMIT2_INDEXED.has(first) || !namesAddress(owner, safe)) return undefined;
  if (token === undefined || spender === undefined || uintOf(log.data) !== PERMIT2_MAX) return undefined;
  if (isStanding(standing, 'permit2', addressOf(spender), addressOf(token))) return undefined;
  const detail = `Permit2 allowance of token ${addressOf(token)} to spender ${addressOf(spender)} for ${PERMIT2_MAX}`;
  return { rule: 'unlimited-approval', callPath: 'receipt', detail, bytes: undefined };
}

function receiptFindings(logs: readonly EventLog[], safe: Address, standing: readonly StandingSpender[]): FloorFinding[] {
  const findings: FloorFinding[] = [];
  for (const log of logs) {
    const event = log.address === safe && log.topics[0] !== undefined ? SETTINGS_EVENTS.get(log.topics[0]) : undefined;
    if (event !== undefined) findings.push({ rule: 'safe-state', callPath: 'receipt', detail: `the Safe logged ${event}`, bytes: undefined });
    const unlimitedPermit2 = unlimitedPermit2Of(log, safe, standing);
    if (unlimitedPermit2 !== undefined) findings.push(unlimitedPermit2);
    const [first, owner, spender] = log.topics;
    if (first !== APPROVAL || log.topics.length !== 3 || !namesAddress(owner, safe) || spender === undefined) continue;
    const value = uintOf(log.data);
    if (value >= UNLIMITED_ERC20 && !isStanding(standing, 'erc20', addressOf(spender), log.address)) {
      findings.push({
        rule: 'unlimited-approval',
        callPath: 'receipt',
        detail: `token ${log.address} approved spender ${addressOf(spender)} for ${value}`,
        bytes: undefined,
      });
    }
  }
  return findings;
}

/**
 * Floor rules on what the transaction did: the Safe's settings must end as they started, and no allowance from the
 * Safe, ERC-20 or Permit2, may be left unlimited, however the transaction reached it, except to a registry contract
 * when `standing` names it, as the card's templates keep it. A transaction that did not execute changed nothing.
 */
export function checkSimulatedFloor(observed: Observed, safe: Address, standing: readonly StandingSpender[] = []): FloorResult {
  if (observed.kind === 'not-executed') return floorResult([]);
  const evidence = observed.safeState;
  const findings =
    evidence.kind === 'read' ? stateFindings(evidence.before, evidence.after) : receiptFindings(evidence.logs, safe, standing);
  for (const allowance of observed.allowances) {
    if (allowance.after < UNLIMITED_ERC20 || isStanding(standing, 'erc20', allowance.spender, allowance.token)) continue;
    findings.push({
      rule: 'unlimited-approval',
      callPath: 'allowances',
      detail: `token ${allowance.token} approved spender ${allowance.spender} for ${allowance.after}`,
      bytes: undefined,
    });
  }
  for (const allowance of observed.permit2) {
    if (allowance.after.amount !== PERMIT2_MAX || isStanding(standing, 'permit2', allowance.spender, allowance.token)) continue;
    findings.push({
      rule: 'unlimited-approval',
      callPath: 'permit2',
      detail: `Permit2 allowance of token ${allowance.token} to spender ${allowance.spender} for ${allowance.after.amount}`,
      bytes: undefined,
    });
  }
  return floorResult(findings);
}
