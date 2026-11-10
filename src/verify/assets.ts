import type { ResolvedCard } from '../card.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { selectorOf } from '../decode/abi.ts';
import type { Registry, RegistryEntry } from '../registry.ts';
import { addressOf, uintOf } from '../simulate/events.ts';
import { cardRefs } from '../template/template.ts';
import type { Template } from '../template/template.ts';

/** A vault on the card whose registry `asset` a template relies on, and the token that attribute names. */
export type AssetClaim = { readonly vault: RegistryEntry; readonly asset: RegistryEntry };

export type AssetCheck =
  | { readonly kind: 'pass' }
  | { readonly kind: 'mismatch'; readonly findings: readonly string[] }
  | { readonly kind: 'unverifiable'; readonly reasons: readonly string[] };

/** Each vault, once, whose `asset` attribute a template on the card reads. */
export function assetClaims(card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry): AssetClaim[] {
  const claims = new Map<string, AssetClaim>();
  for (const op of card.operations) {
    const template = templates.get(op.template);
    for (const ref of template === undefined ? [] : cardRefs(template)) {
      const value = op.values.get(ref.field);
      if (ref.attribute !== 'asset' || value?.kind !== 'contract') continue;
      const name = value.entry.attributes.asset;
      const asset = name === undefined ? undefined : registry.entries.get(name);
      if (asset !== undefined) claims.set(value.entry.name, { vault: value.entry, asset });
    }
  }
  return [...claims.values()];
}

/** Each claim's vault `asset()`, read at `at`, must be the token the registry names. */
export async function checkAssets(reader: Reader, claims: readonly AssetClaim[], at: BlockRef): Promise<AssetCheck> {
  const findings: string[] = [];
  const reasons: string[] = [];
  for (const { vault, asset } of claims) {
    const read = await reader.call({ to: vault.address, data: selectorOf('asset()') }, at);
    const data = read.kind === 'agreed' && read.value.kind === 'returned' ? read.value.data : undefined;
    if (data === undefined || data.length !== 66 || uintOf(data) >> 160n !== 0n) {
      reasons.push(read.kind === 'unverifiable' ? read.reason : `${vault.name} ${vault.address} gave no asset() at block ${at.number}`);
      continue;
    }
    const actual = addressOf(data);
    if (actual !== asset.address) {
      findings.push(`${vault.name} ${vault.address} holds ${actual} by its asset() at block ${at.number}, the registry says ${asset.name} ${asset.address}`);
    }
  }
  if (findings.length > 0) return { kind: 'mismatch', findings };
  return reasons.length > 0 ? { kind: 'unverifiable', reasons } : { kind: 'pass' };
}
