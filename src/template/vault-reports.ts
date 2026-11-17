import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedCard, ResolvedValue } from '../card.ts';
import type { ContractKind, Registry } from '../registry.ts';
import { TEMPLATES_DIR } from './template.ts';
import type { Template } from './template.ts';

/** Templates that predate the HTML report: each keeps its one report until it is rebuilt. The list only shrinks. */
export const NOT_YET_REBUILT: ReadonlySet<string> = new Set([]);

/** Whether a template's reports gate the vaults its card names: every template but those not yet rebuilt. */
export const gatesVaults = (template: Template): boolean => !NOT_YET_REBUILT.has(template.id);

export const VAULTS_DIR = 'vaults';
export const GENERATED_FILE = 'report.generated.md';

/**
 * What one report of a template covers: the template, or the template and one instance its card field `field` names,
 * an entry of kind `kind`. A rebuilt template whose card has two contract fields of that kind has no per-instance report yet.
 */
export type ReportUnit = { readonly kind: 'template' } | { readonly kind: 'vault'; readonly field: string; readonly of: ContractKind } | { readonly kind: 'several-vaults' };

/** The kind of entry a template is reported per: its declared instance field's, or else `vault`. */
function instanceKind(template: Template): ContractKind {
  const field = template.instanceField === undefined ? undefined : template.card.get(template.instanceField);
  return field?.kind === 'contract' ? field.scope.registryKind : 'vault';
}

/** The template's instance field: the one it declares, or else its card's one contract field of kind `vault`. */
export function reportUnit(template: Template): ReportUnit {
  if (!gatesVaults(template)) return { kind: 'template' };
  const of = instanceKind(template);
  const fields = [...template.card].filter(([, field]) => field.kind === 'contract' && field.scope.registryKind === of).map(([name]) => name);
  if (fields.length === 0) return { kind: 'template' };
  return fields.length === 1 ? { kind: 'vault', field: fields[0] as string, of } : { kind: 'several-vaults' };
}

export const vaultReportDir = (template: string, vault: string): string => join(TEMPLATES_DIR, template, VAULTS_DIR, vault);

/** The vaults with a report for the template, from the repository's file paths (`templates/<id>/vaults/<vault>/report.generated.md`). */
export function reportedVaults(template: string, paths: readonly string[]): Set<string> {
  const prefix = `${TEMPLATES_DIR}/${template}/${VAULTS_DIR}/`;
  return new Set(paths.flatMap((path) => (path.startsWith(prefix) && path.endsWith(`/${GENERATED_FILE}`) && path.split('/').length === prefix.split('/').length + 1 ? [path.slice(prefix.length, -GENERATED_FILE.length - 1)] : [])));
}

/** The same set, read from a checkout's working tree. A symlinked folder is skipped, as git lists no files under it. */
export function reportedVaultsIn(repoRoot: string, template: string): Set<string> {
  const dir = join(repoRoot, TEMPLATES_DIR, template, VAULTS_DIR);
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return new Set();
  return reportedVaults(
    template,
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${TEMPLATES_DIR}/${template}/${VAULTS_DIR}/${entry.name}/${GENERATED_FILE}`)
      .filter((path) => existsSync(join(repoRoot, path))),
  );
}

export const severalVaults = (template: string): string => `${template} names more than one instance of its report's kind, and no report covers such an operation yet`;

/** Whether a name a card field may take is a registry entry of the template's instance kind, which a gated template may name only with a report for it. */
export const isInstanceOf = (template: Template, name: string, registry: Registry): boolean => registry.entries.get(name)?.kind === instanceKind(template);

function instanceNamed(template: Template, value: ResolvedValue, registry: Registry): string | undefined {
  const name = value.kind === 'contract' || (value.kind === 'address' && value.from === 'registry') ? value.name : undefined;
  return name !== undefined && isInstanceOf(template, name, registry) ? name : undefined;
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
      const vault = instanceNamed(template, value, registry);
      if (vault !== undefined && !reported(template.id).has(vault)) return `${vault} has no report for ${template.id}; build one first`;
    }
  }
  return undefined;
}
