import type { ProviderName } from '../chain/providers.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import type { Registry, RegistryEntry } from '../registry.ts';
import type { Hex } from '../safe/types.ts';

/** The registry factory a registry entry names answered, through both providers, that it created that entry's contract. */
export type InstanceProof = {
  readonly kind: 'created';
  readonly entry: RegistryEntry;
  readonly factory: RegistryEntry;
  readonly block: BlockRef;
  readonly providers: readonly [ProviderName, ProviderName];
};

export type InstanceRefusal = { readonly kind: 'refused'; readonly why: string };

const TRUE = `0x${'00'.repeat(31)}01`;
const FALSE = `0x${'00'.repeat(32)}`;

export async function proveInstance(reader: Reader, registry: Registry, name: string, block: BlockRef): Promise<InstanceProof | InstanceRefusal> {
  const refuse = (why: string): InstanceRefusal => ({ kind: 'refused', why });
  const entry = registry.entries.get(name);
  if (entry === undefined) return refuse(`${name} is not in the registry`);
  const factoryName = entry.attributes.factory;
  if (factoryName === undefined) return refuse(`${name} names no factory`);
  const factory = registry.entries.get(factoryName) as RegistryEntry;
  const check = factory.instanceCheck;
  if (check === undefined) return refuse(`${factoryName} has no instanceCheck`);
  const data = `${check.selector}${entry.address.slice(2).padStart(64, '0')}` as Hex;
  const read = await reader.call({ to: factory.address, data }, block);
  if (read.kind === 'unverifiable') return refuse(read.reason);
  const answer = read.value.kind === 'returned' ? read.value.data.toLowerCase() : 'a revert';
  if (answer === FALSE) return refuse(`${factoryName} answered ${check.signature} false for ${name}: it did not create it`);
  if (answer !== TRUE) return refuse(`${factoryName} answered ${check.signature} with ${answer}, not true or false`);
  return { kind: 'created', entry, factory, block, providers: read.providers };
}
