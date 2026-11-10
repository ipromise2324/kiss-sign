import type { EventLog } from '../chain/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { Observed } from '../simulate/effects.ts';
import { APPROVAL, addressOf, namesAddress, topic, uintOf } from '../simulate/events.ts';
import type { SafeState, SafeStateField } from '../simulate/safe-state.ts';
import { UNLIMITED_ERC20, floorResult } from './floor.ts';
import type { FloorFinding, FloorResult } from './floor.ts';

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

function receiptFindings(logs: readonly EventLog[], safe: Address): FloorFinding[] {
  const findings: FloorFinding[] = [];
  for (const log of logs) {
    const event = log.address === safe && log.topics[0] !== undefined ? SETTINGS_EVENTS.get(log.topics[0]) : undefined;
    if (event !== undefined) findings.push({ rule: 'safe-state', callPath: 'receipt', detail: `the Safe logged ${event}`, bytes: undefined });
    const [first, owner, spender] = log.topics;
    if (first !== APPROVAL || log.topics.length !== 3 || !namesAddress(owner, safe) || spender === undefined) continue;
    const value = uintOf(log.data);
    if (value >= UNLIMITED_ERC20) {
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
 * Safe may be left unlimited, however the transaction reached it. A transaction that did not execute changed nothing.
 */
export function checkSimulatedFloor(observed: Observed, safe: Address): FloorResult {
  if (observed.kind === 'not-executed') return floorResult([]);
  const evidence = observed.safeState;
  const findings =
    evidence.kind === 'read' ? stateFindings(evidence.before, evidence.after) : receiptFindings(evidence.logs, safe);
  for (const allowance of observed.allowances) {
    if (allowance.after < UNLIMITED_ERC20) continue;
    findings.push({
      rule: 'unlimited-approval',
      callPath: 'allowances',
      detail: `token ${allowance.token} approved spender ${allowance.spender} for ${allowance.after}`,
      bytes: undefined,
    });
  }
  return floorResult(findings);
}
