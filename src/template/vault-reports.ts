import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedCard, ResolvedValue } from '../card.ts';
import type { ContractKind, Registry } from '../registry.ts';
import { TEMPLATES_DIR } from './template.ts';
import type { Template } from './template.ts';

/** Templates that predate the HTML report: each keeps its one report until it is rebuilt. The list only shrinks. */
export const NOT_YET_REBUILT: ReadonlySet<string> = new Set([]);

/** Whether a template's reports gate the instances its card names: every template but those not yet rebuilt. */
export const gatesInstances = (template: Template): boolean => !NOT_YET_REBUILT.has(template.id);

/** The folders under a template that hold its per-instance reports: `instances/`, and `vaults/`, their earlier name. */
export const INSTANCE_FOLDERS = ['instances', 'vaults'] as const;
export type InstanceFolder = (typeof INSTANCE_FOLDERS)[number];
export const GENERATED_FILE = 'report.generated.md';

/**
 * What one report of a template covers: the template, or the template and one instance its card field `field` names,
 * an entry of kind `kind`. A rebuilt template whose card has two contract fields of that kind has no per-instance report yet.
 */
export type ReportUnit = { readonly kind: 'template' } | { readonly kind: 'instance'; readonly field: string; readonly of: ContractKind } | { readonly kind: 'several-instances' };

/** The kind of entry a template is reported per: its declared instance field's, or else `vault`. */
function instanceKind(template: Template): ContractKind {
  const field = template.instanceField === undefined ? undefined : template.card.get(template.instanceField);
  return field?.kind === 'contract' ? field.scope.registryKind : 'vault';
}

/** The template's instance field: the one it declares, or else its card's one contract field of kind `vault`. */
export function reportUnit(template: Template): ReportUnit {
  if (!gatesInstances(template)) return { kind: 'template' };
  const of = instanceKind(template);
  const fields = [...template.card].filter(([, field]) => field.kind === 'contract' && field.scope.registryKind === of).map(([name]) => name);
  if (fields.length === 0) return { kind: 'template' };
  return fields.length === 1 ? { kind: 'instance', field: fields[0] as string, of } : { kind: 'several-instances' };
}

/** The folder `pnpm report` writes an instance's report to, until reports move to `instances/`. */
export const vaultReportDir = (template: string, instance: string): string => join(TEMPLATES_DIR, template, 'vaults', instance);

/** Each instance with a report for the template, and the folders that hold one. */
export type ReportedInstances = ReadonlyMap<string, readonly InstanceFolder[]>;

/** The reported instances, from the repository's file paths (`templates/<id>/<folder>/<instance>/report.generated.md`). */
export function reportedInstances(template: string, paths: readonly string[]): ReportedInstances {
  const reported = new Map<string, InstanceFolder[]>();
  for (const folder of INSTANCE_FOLDERS) {
    const prefix = `${TEMPLATES_DIR}/${template}/${folder}/`;
    for (const path of paths) {
      if (!path.startsWith(prefix) || !path.endsWith(`/${GENERATED_FILE}`) || path.split('/').length !== prefix.split('/').length + 1) continue;
      const name = path.slice(prefix.length, -GENERATED_FILE.length - 1);
      reported.set(name, [...(reported.get(name) ?? []), folder]);
    }
  }
  return reported;
}

/** The same, read from a checkout's working tree. A symlinked folder is skipped, as git lists no files under it. */
export function reportedInstancesIn(repoRoot: string, template: string): ReportedInstances {
  const paths = INSTANCE_FOLDERS.flatMap((folder) => {
    const dir = join(repoRoot, TEMPLATES_DIR, template, folder);
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${TEMPLATES_DIR}/${template}/${folder}/${entry.name}/${GENERATED_FILE}`)
      .filter((path) => existsSync(join(repoRoot, path)));
  });
  return reportedInstances(template, paths);
}

export const severalInstances = (template: string): string => `${template} names more than one instance of its report's kind, and no report covers such an operation yet`;

export const inBothFolders = (template: string, instance: string): string =>
  `${instance} has a report for ${template} in both ${INSTANCE_FOLDERS.map((folder) => `${folder}/`).join(' and ')}; keep one`;

/** Whether a name a card field may take is a registry entry of the template's instance kind, which a gated template may name only with a report for it. */
export const isInstanceOf = (template: Template, name: string, registry: Registry): boolean => registry.entries.get(name)?.kind === instanceKind(template);

function instanceNamed(template: Template, value: ResolvedValue, registry: Registry): string | undefined {
  const name = value.kind === 'contract' || (value.kind === 'address' && value.from === 'registry') ? value.name : undefined;
  return name !== undefined && isInstanceOf(template, name, registry) ? name : undefined;
}

/**
 * Why a card may not be signed: a template its reports gate naming, through any field, an instance with no report for that
 * template, or with one in each folder. Undefined when none.
 */
export function unreportedInstance(
  card: ResolvedCard,
  templates: ReadonlyMap<string, Template>,
  registry: Registry,
  reported: (template: string) => ReportedInstances,
): string | undefined {
  for (const op of card.operations) {
    const template = templates.get(op.template);
    if (template === undefined || !gatesInstances(template)) continue;
    if (reportUnit(template).kind === 'several-instances') return severalInstances(template.id);
    for (const value of op.values.values()) {
      const instance = instanceNamed(template, value, registry);
      if (instance === undefined) continue;
      const folders = reported(template.id).get(instance);
      if (folders === undefined) return `${instance} has no report for ${template.id}; build one first`;
      if (folders.length > 1) return inBothFolders(template.id, instance);
    }
  }
  return undefined;
}
