import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedCard, ResolvedValue } from '../card.ts';
import type { Registry } from '../registry.ts';
import { TEMPLATES_DIR } from './template.ts';
import type { Template } from './template.ts';

/** Templates that predate the HTML report: each keeps its one report until it is rebuilt. The list only shrinks. */
export const NOT_YET_REBUILT: ReadonlySet<string> = new Set([
  'cctp/receive',
  'erc20/transfer',
  'eth/transfer',
  'fluid/rewards-claim',
  'fluid/vault-deposit',
  'fluid/vault-redeem',
  'fluid/vault-withdraw',
  'merkl/claim',
  'morpho/urd-claim',
  'morpho/vault-bundles-deposit',
  'morpho/vault-migrate-all',
  'morpho/vault-withdraw',
  'morpho/vault-withdraw-all',
  'safe/cancel',
]);

/** Whether a template's reports gate the vaults its card names: every template but those not yet rebuilt. */
export const gatesVaults = (template: Template): boolean => !NOT_YET_REBUILT.has(template.id);

export const VAULTS_DIR = 'vaults';
export const GENERATED_FILE = 'report.generated.md';

/**
 * What one report of a template covers: the template, or the template and one vault its card field `field` names. A
 * rebuilt template whose card names two vaults has no per-vault report yet.
 */
export type ReportUnit = { readonly kind: 'template' } | { readonly kind: 'vault'; readonly field: string } | { readonly kind: 'several-vaults' };

export function reportUnit(template: Template): ReportUnit {
  if (!gatesVaults(template)) return { kind: 'template' };
  const fields = [...template.card].filter(([, field]) => field.kind === 'contract' && field.scope.registryKind === 'vault').map(([name]) => name);
  if (fields.length === 0) return { kind: 'template' };
  return fields.length === 1 ? { kind: 'vault', field: fields[0] as string } : { kind: 'several-vaults' };
}

export const vaultReportDir = (template: string, vault: string): string => join(TEMPLATES_DIR, template, VAULTS_DIR, vault);

/** The vaults with a report for the template, from the repository's file paths (`templates/<id>/vaults/<vault>/report.generated.md`). */
export function reportedVaults(template: string, paths: readonly string[]): Set<string> {
  const prefix = `${TEMPLATES_DIR}/${template}/${VAULTS_DIR}/`;
  return new Set(paths.flatMap((path) => (path.startsWith(prefix) && path.endsWith(`/${GENERATED_FILE}`) && path.split('/').length === prefix.split('/').length + 1 ? [path.slice(prefix.length, -GENERATED_FILE.length - 1)] : [])));
}

/** The same set, read from a checkout's working tree. */
export function reportedVaultsIn(repoRoot: string, template: string): Set<string> {
  const dir = join(repoRoot, TEMPLATES_DIR, template, VAULTS_DIR);
  if (!existsSync(dir)) return new Set();
  return reportedVaults(
    template,
    readdirSync(dir).map((vault) => `${TEMPLATES_DIR}/${template}/${VAULTS_DIR}/${vault}/${GENERATED_FILE}`).filter((path) => existsSync(join(repoRoot, path))),
  );
}

export const severalVaults = (template: string): string => `${template} names more than one vault, and no report covers such an operation yet`;

/** Whether a name a card field may take is a registry vault, which a gated template may name only with a report for it. */
export const isRegistryVault = (name: string, registry: Registry): boolean => registry.entries.get(name)?.kind === 'vault';

function vaultNamed(value: ResolvedValue, registry: Registry): string | undefined {
  if (value.kind === 'contract') return value.entry.kind === 'vault' ? value.name : undefined;
  return value.kind === 'address' && value.from === 'registry' && isRegistryVault(value.name, registry) ? value.name : undefined;
}

/**
 * Why a card may not be signed: a template its reports gate naming, through any field, a vault with no report for that
 * template. Undefined when none.
 */
export function unreportedVault(
  card: ResolvedCard,
  templates: ReadonlyMap<string, Template>,
  registry: Registry,
  reported: (template: string) => ReadonlySet<string>,
): string | undefined {
  for (const op of card.operations) {
    const template = templates.get(op.template);
    if (template === undefined || !gatesVaults(template)) continue;
    if (reportUnit(template).kind === 'several-vaults') return severalVaults(template.id);
    for (const value of op.values.values()) {
      const vault = vaultNamed(value, registry);
      if (vault !== undefined && !reported(template.id).has(vault)) return `${vault} has no report for ${template.id}; build one first`;
    }
  }
  return undefined;
}
