import { resolveRef } from './card.ts';
import type { ResolvedValue } from './card.ts';
import type { RegistryView } from './registry.ts';
import type { CardRef, Template } from './template/template.ts';

const refLabel = (ref: CardRef): string => (ref.attribute === undefined ? ref.field : `${ref.field}.${ref.attribute}`);

/** The card references `same` ties together, as `vault.asset and market.loanToken`. */
export const sameText = (template: Template): string => template.same.map(refLabel).join(' and ');

/** Whether every `same` reference to a field among `values` names one address; a field not given yet holds any. */
export function sameSoFar(template: Template, values: ReadonlyMap<string, ResolvedValue>, registry: RegistryView): boolean {
  const addresses = template.same.filter((ref) => values.has(ref.field)).map((ref) => {
    const target = resolveRef(ref, values, registry);
    return 'kind' in target && target.kind === 'address' ? target.address : undefined;
  });
  return addresses.every((address) => address !== undefined && address === addresses[0]);
}
