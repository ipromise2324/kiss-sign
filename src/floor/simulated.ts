import type { EventLog } from '../chain/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { Observed } from '../simulate/effects.ts';
import { APPROVAL, PERMIT2, PERMIT2_INDEXED, addressOf, namesAddress, topic, uintOf } from '../simulate/events.ts';
import type { SafeState, SafeStateField } from '../simulate/safe-state.ts';
import { PERMIT2_MAX, UNLIMITED_ERC20, floorResult } from './floor.ts';
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

/** The owner or threshold change the card's one `effects.safe` declares, resolved to addresses and a number. */
export type SettingsChange = { readonly add: Address | undefined; readonly remove: Address | undefined; readonly threshold: bigint | undefined };

const render = (value: SafeState[SafeStateField]): string =>
  Array.isArray(value) ? `[${value.join(', ')}]` : String(value);

const finding = (detail: string, callPath = 'safe'): FloorFinding => ({ rule: 'safe-state', callPath, detail, bytes: undefined });

/** Owners as a set: the Safe puts an added owner first and a replacement in place, and the order decides nothing. */
const ownerSet = (owners: readonly Address[]): string => [...owners].sort().join(', ');

/** The settings `before` must end as: unchanged, or changed exactly as `change` says. */
function expectedAfter(before: SafeState, change: SettingsChange | undefined): SafeState | FloorFinding[] {
  if (change === undefined) return before;
  const problems: FloorFinding[] = [];
  if (change.remove !== undefined && !before.owners.includes(change.remove)) problems.push(finding(`${change.remove}, to remove, is not an owner before the transaction`));
  if (change.add !== undefined && before.owners.includes(change.add)) problems.push(finding(`${change.add}, to add, is an owner before the transaction already`));
  if (problems.length > 0) return problems;
  const owners = [...before.owners.filter((owner) => owner !== change.remove), ...(change.add === undefined ? [] : [change.add])];
  return { ...before, owners, threshold: change.threshold ?? before.threshold };
}

function stateFindings(before: SafeState, after: SafeState, change: SettingsChange | undefined): FloorFinding[] {
  const expected = expectedAfter(before, change);
  if (Array.isArray(expected)) return expected;
  const fields = Object.keys(before) as SafeStateField[];
  const same = (field: SafeStateField, x: SafeState, y: SafeState): boolean =>
    field === 'owners' ? ownerSet(x.owners) === ownerSet(y.owners) : render(x[field]) === render(y[field]);
  return fields.flatMap((field) => {
    if (same(field, expected, after)) return [];
    const was = render(before[field]);
    const is = render(after[field]);
    const moved = same(field, before, after) ? `${field} stayed ${is}` : `${field} changed from ${was} to ${is}`;
    return [finding(same(field, expected, before) ? moved : `${moved}, not to ${render(expected[field])}`)];
  });
}

const OWNER_EVENTS = { added: topic('AddedOwner(address)'), removed: topic('RemovedOwner(address)'), threshold: topic('ChangedThreshold(uint256)') } as const;

/** Safe 1.4.1 indexes the owner of `AddedOwner` and `RemovedOwner`; 1.3.0 puts it in the data. */
const eventAddress = (log: EventLog): Address => addressOf(log.topics[1] ?? (log.data.slice(0, 66) as Hex));

/** Whether a settings event the Safe logged is one the declared change makes. */
function declared(log: EventLog, change: SettingsChange | undefined): boolean {
  if (change === undefined) return false;
  const [first] = log.topics;
  if (first === OWNER_EVENTS.added) return change.add !== undefined && eventAddress(log) === change.add;
  if (first === OWNER_EVENTS.removed) return change.remove !== undefined && eventAddress(log) === change.remove;
  if (first === OWNER_EVENTS.threshold) return change.threshold !== undefined && uintOf(log.data) === change.threshold;
  return false;
}

function unlimitedPermit2Of(log: EventLog, safe: Address): FloorFinding | undefined {
  const [first, owner, token, spender] = log.topics;
  if (log.address !== PERMIT2 || first === undefined || !PERMIT2_INDEXED.has(first) || !namesAddress(owner, safe)) return undefined;
  if (token === undefined || spender === undefined || uintOf(log.data) !== PERMIT2_MAX) return undefined;
  const detail = `Permit2 allowance of token ${addressOf(token)} to spender ${addressOf(spender)} for ${PERMIT2_MAX}`;
  return { rule: 'unlimited-approval', callPath: 'receipt', detail, bytes: undefined };
}

function receiptFindings(logs: readonly EventLog[], safe: Address, change: SettingsChange | undefined): FloorFinding[] {
  const findings: FloorFinding[] = [];
  for (const log of logs) {
    const event = log.address === safe && log.topics[0] !== undefined ? SETTINGS_EVENTS.get(log.topics[0]) : undefined;
    if (event !== undefined && !declared(log, change)) findings.push(finding(`the Safe logged ${event}${change === undefined ? '' : ', which the card does not declare'}`, 'receipt'));
    const unlimitedPermit2 = unlimitedPermit2Of(log, safe);
    if (unlimitedPermit2 !== undefined) findings.push(unlimitedPermit2);
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
 * Floor rules on what the transaction did: the Safe's settings must end as they started, or as `change` declares, and no allowance from the
 * Safe, ERC-20 or Permit2, may be left unlimited, however the transaction reached it. A transaction that did not
 * execute changed nothing.
 */
export function checkSimulatedFloor(observed: Observed, safe: Address, change?: SettingsChange): FloorResult {
  if (observed.kind === 'not-executed') return floorResult([]);
  const evidence = observed.safeState;
  const findings: FloorFinding[] = [];
  if (evidence.kind === 'read') findings.push(...stateFindings(evidence.before, evidence.after, change));
  else {
    findings.push(...receiptFindings(evidence.logs, safe, change));
    if (evidence.alone !== undefined) findings.push(...stateFindings(evidence.alone.before, evidence.alone.after, change).map((f) => ({ ...f, callPath: 'simulation' })));
    else if (change !== undefined) findings.push(finding("the Safe's settings were not read in a simulation of the transaction alone", 'simulation'));
  }
  for (const allowance of observed.allowances) {
    if (allowance.after < UNLIMITED_ERC20) continue;
    findings.push({
      rule: 'unlimited-approval',
      callPath: 'allowances',
      detail: `token ${allowance.token} approved spender ${allowance.spender} for ${allowance.after}`,
      bytes: undefined,
    });
  }
  for (const allowance of observed.permit2) {
    if (allowance.after.amount !== PERMIT2_MAX) continue;
    findings.push({
      rule: 'unlimited-approval',
      callPath: 'permit2',
      detail: `Permit2 allowance of token ${allowance.token} to spender ${allowance.spender} for ${allowance.after.amount}`,
      bytes: undefined,
    });
  }
  return floorResult(findings);
}
