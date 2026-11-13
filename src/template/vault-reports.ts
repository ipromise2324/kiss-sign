import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Card } from '../card.ts';
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

export const VAULTS_DIR = 'vaults';
export const GENERATED_FILE = 'report.generated.md';

/**
 * What one report of a template covers: the template, or the template and one vault its card field `field` names. A
 * rebuilt template whose card names two vaults has no per-vault report yet.
 */
export type ReportUnit = { readonly kind: 'template' } | { readonly kind: 'vault'; readonly field: string } | { readonly kind: 'several-vaults' };

export function reportUnit(template: Template): ReportUnit {
  if (NOT_YET_REBUILT.has(template.id)) return { kind: 'template' };
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

/** Why a card may not be signed: a template reported per vault naming a vault with no report for it. Undefined when none. */
export function unreportedVault(card: Card, templates: ReadonlyMap<string, Template>, reported: (template: string) => ReadonlySet<string>): string | undefined {
  for (const op of card.operations) {
    const template = templates.get(op.template);
    if (template === undefined) continue;
    const unit = reportUnit(template);
    if (unit.kind === 'several-vaults') return severalVaults(template.id);
    if (unit.kind !== 'vault') continue;
    const vault = op.values[unit.field];
    if (vault !== undefined && !reported(template.id).has(vault)) return `${vault} has no report for ${template.id}; build one first`;
  }
  return undefined;
}
