import type { ResolvedCard } from '../card.ts';
import type { Registry } from '../registry.ts';
import type { Address } from '../safe/types.ts';
import { judgeEffects } from '../simulate/effects.ts';
import type { EffectVerdict } from '../simulate/effects.ts';
import type { Observation } from '../simulate/simulate.ts';
import type { FieldCheck } from '../template/check.ts';
import type { MutationResult } from '../template/mutation.ts';
import type { CardRef, Template } from '../template/template.ts';
import type { FloorResult } from './floor.ts';
import { checkSimulatedFloor } from './simulated.ts';
import type { SettingsChange } from './simulated.ts';

export type SimulatedChecks =
  | { readonly kind: 'observed'; readonly effects: EffectVerdict; readonly floor: FloorResult }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

/** Every engine check one Safe transaction gets, in the order they run. */
export type EngineChecks = {
  readonly staticFloor: FloorResult;
  readonly fields: FieldCheck;
  readonly mutation: MutationResult;
  readonly simulation: SimulatedChecks;
};

/**
 * The owner or threshold change the card's one operation with `effects.safe` declares, or undefined when none does.
 * Template load binds each to an owner or threshold field, which a resolved card holds as an address or a number.
 */
export function settingsChange(card: ResolvedCard, templates: ReadonlyMap<string, Template>): SettingsChange | undefined {
  for (const op of card.operations) {
    const declared = templates.get(op.template)?.effects.safe;
    if (declared === undefined) continue;
    const value = (ref: CardRef | undefined) => (ref === undefined ? undefined : op.values.get(ref.field));
    const address = (ref: CardRef | undefined): Address | undefined => {
      const held = value(ref);
      return held?.kind === 'address' ? held.address : undefined;
    };
    const threshold = value(declared.threshold);
    return { add: address(declared.add), remove: address(declared.remove), threshold: threshold?.kind === 'threshold' ? threshold.value : undefined };
  }
  return undefined;
}

/** The effects verdict and the floor rules on one observation, from a simulation or a receipt. */
export function checkObservation(
  observation: Observation,
  safe: Address,
  card: ResolvedCard,
  templates: ReadonlyMap<string, Template>,
  registry: Registry,
): SimulatedChecks {
  if (observation.kind === 'unverifiable') return observation;
  const { observed } = observation;
  return { kind: 'observed', effects: judgeEffects(observed, card, templates, registry), floor: checkSimulatedFloor(observed, safe, settingsChange(card, templates)) };
}
