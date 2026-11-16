import type { ResolvedCard } from '../card.ts';
import type { Registry } from '../registry.ts';
import type { Address } from '../safe/types.ts';
import { judgeEffects } from '../simulate/effects.ts';
import type { EffectVerdict } from '../simulate/effects.ts';
import type { Observation } from '../simulate/simulate.ts';
import type { FieldCheck } from '../template/check.ts';
import type { MutationResult } from '../template/mutation.ts';
import type { Template } from '../template/template.ts';
import { keptUnlimited } from './floor.ts';
import type { FloorResult } from './floor.ts';
import { checkSimulatedFloor } from './simulated.ts';

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
  return { kind: 'observed', effects: judgeEffects(observed, card, templates, registry), floor: checkSimulatedFloor(observed, safe, keptUnlimited(card, templates, registry)) };
}
