import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ABI_CASES_DIR } from '../contracts/abi-case.ts';
import type { Language } from '../language.ts';
import type { Registry, RegistryEntry } from '../registry.ts';
import { callTargetEntries, loadTemplate, TEMPLATES_DIR } from '../template/template.ts';
import type { Template } from '../template/template.ts';
import { GENERATED_FILE, reportUnit } from '../template/vault-reports.ts';
import { SUMMARIES_DIR } from './past-txs-summary.ts';
import { factsScope } from './protocol-facts.ts';
import { DOCS_FILE, entriesOf, loadReport, ownedEntries, provedEntries, reportDir, reportRecordingPath } from './report.ts';
import type { TemplateTarget } from './report.ts';

/** The steps of building a template and its report, in the order the kiss-sign skill and docs/design/flow.md give them. */
export const STEPS = ['intent', 'addresses', 'abi', 'draft', 'pastTxs', 'health', 'report', 'notes', 'tests', 'commit', 'push'] as const;
export type Step = (typeof STEPS)[number];

/** `waits`: the step's files are written by a later step's command, which has not run yet. */
export type StepState = { readonly step: Step; readonly state: 'done' | 'partly' | 'not-started' | 'waits'; readonly missing: readonly string[] };

export type BuildProgress = { readonly steps: readonly StepState[]; readonly done: number; readonly next: Step | undefined };

/** Each step's usual minutes, low and high, measured as the file's `source` says. */
const MINUTES = (JSON.parse(readFileSync(join(import.meta.dirname, 'build-progress-times.json'), 'utf8')) as { minutes: Record<Step, readonly [number, number]> }).minutes;

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

const record = (raw: unknown): Record<string, unknown> => (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

const git = (root: string, args: readonly string[]): string | undefined => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
};

export class ProgressError extends Error {
  override name = 'ProgressError';
}

const state = (step: Step, missing: readonly string[], started: boolean): StepState => ({ step, state: missing.length === 0 ? 'done' : started ? 'partly' : 'not-started', missing });

/**
 * Where building `target` stands, decided only from files in the checkout at `root` and its git state: no network and
 * no key. `language` picks the report page the notes step looks for.
 */
export function buildProgress(root: string, registry: Registry, target: TemplateTarget, language: Language): BuildProgress {
  if (target.instance !== undefined && !registry.entries.has(target.instance)) throw new ProgressError(`${target.instance} is not a registry entry; add it first (step 2)`);
  const templateDir = join(TEMPLATES_DIR, target.template);
  const dir = reportDir(root, target);
  const at = (path: string): boolean => existsSync(join(root, path));

  let template: Template | undefined;
  let templateError: string | undefined;
  if (at(join(templateDir, 'template.json'))) {
    try {
      template = loadTemplate(root, target.template, registry);
    } catch (error) {
      templateError = (error as Error).message.split('\n')[0];
    }
  }
  let entries: RegistryEntry[] = [];
  let proved: RegistryEntry[] = [];
  if (template !== undefined) {
    const perInstance = reportUnit(template).kind === 'instance';
    if (perInstance && target.instance === undefined) throw new ProgressError(`${target.template} is reported per instance; name one with --instance <registry name>`);
    if (!perInstance && target.instance !== undefined) throw new ProgressError(`${target.template} has one report, not one per instance; leave out --instance`);
    try {
      const report = loadReport(root, registry, target);
      entries = entriesOf(report.subject, report.registry);
      proved = provedEntries(report.subject, report.registry);
    } catch {
      entries = callTargetEntries(template, registry).filter((entry) => !otherInstances(registry, target.instance).has(entry.name));
      proved = entries;
    }
  }
  const notesFiles = [join(templateDir, 'notes.json'), ...(target.instance === undefined ? [] : [join(dir, 'notes.json')])].filter(at);
  const notes = notesFiles.map((file) => record(readJson(join(root, file))));
  const noted = new Set(notes.flatMap((note) => Object.keys(record(note.entries))));
  for (const name of noted) {
    const entry = registry.entries.get(name);
    if (entry !== undefined && !entries.includes(entry)) entries.push(entry);
  }

  const steps: StepState[] = [];
  const add = (step: StepState): void => void steps.push(step);

  add(state('intent', at(templateDir) ? [] : [templateDir], false));

  const unpinned = entries.flatMap((entry) => [...(entry.source === undefined ? [`${entry.name}: source`] : []), ...(entry.code === undefined ? [`${entry.name}: code pin`] : [])]);
  add(state('addresses', entries.length === 0 && template === undefined ? ['registry entries'] : unpinned, entries.length > 0 || noted.size > 0));

  const recorded = at(reportRecordingPath(target));
  const cases = abiCaseAddresses(root);
  const unproved = proved.filter((entry) => !cases.has(entry.address.toLowerCase())).map((entry) => entry.name);
  const abi = state('abi', template === undefined ? ['template.json'] : unproved, proved.length > unproved.length);
  add(abi.state !== 'done' && template !== undefined && !recorded ? { ...abi, state: 'waits' } : abi);

  add(state('draft', template !== undefined ? [] : [templateError ?? join(templateDir, 'template.json')], templateError !== undefined));

  const summaries = pastTxsSummaries(root, target, registry);
  add(state('pastTxs', summaries.length > 0 ? [] : [SUMMARIES_DIR], false));

  const protocols = record(notes.map((note) => note.protocols).find((value) => value !== undefined));
  const facts = template === undefined ? undefined : factsScope(template, registry, entries);
  const covered = facts === undefined ? Object.keys(protocols) : facts.protocols.map(({ slug }) => slug);
  const unchecked = covered.flatMap((slug) => (protocols[slug] === undefined ? [`notes.json: protocols.${slug}`] : ['audits', 'incidents'].filter((key) => record(protocols[slug])[key] === undefined).map((key) => `${slug}: ${key}`)));
  const judged = notes.some((note) => Array.isArray(note.judgments) && note.judgments.length > 0);
  const unlisted = facts === undefined || facts.unlisted.length === 0 || judged ? [] : [`notes.json: judgments (the health of ${facts.unlisted.map((entry) => entry.name).join(', ')}, which DefiLlama does not list)`];
  add(state('health', facts === undefined && covered.length === 0 ? ['notes.json: protocols'] : [...unchecked, ...unlisted], Object.keys(protocols).length > 0 || judged));

  const docs = at(join(templateDir, DOCS_FILE));
  const generated = at(join(dir, GENERATED_FILE));
  const reportMissing = [...(docs ? [] : [join(templateDir, DOCS_FILE)]), ...(recorded ? [] : [reportRecordingPath(target)]), ...(generated ? [] : [join(dir, GENERATED_FILE)])];
  add(state('report', reportMissing, docs || recorded));

  const page = join(dir, `report.generated.${language}.html`);
  const stale = at(page) && notesFiles.some((file) => edited(root, file) && statSync(join(root, file)).mtimeMs > statSync(join(root, page)).mtimeMs);
  const notesMissing = [...(notesFiles.length === 0 ? [join(dir, 'notes.json')] : []), ...(at(page) && !stale ? [] : [stale ? `${page} (notes.json changed after it)` : page])];
  add(state('notes', notesMissing, notesFiles.length > 0));

  const perturbed = perturbRecordings(root, target);
  const names = [target.template, ...(target.instance === undefined ? [] : [target.instance])];
  const namesBoth = (text: string): boolean => names.every((name) => text.includes(`'${name}'`) || text.includes(`"${name}"`));
  const testFiles = readdirSync(join(root, 'test')).filter((file) => file.endsWith('.test.ts') && namesBoth(readFileSync(join(root, 'test', file), 'utf8')));
  const branched = branchedFrom(root);
  const newBuild = branched !== undefined && git(root, ['cat-file', '-e', `${branched}:${dir}`]) === undefined;
  const changed = newBuild ? changedSince(root, branched, 'test') : undefined;
  const ownTests = changed === undefined ? testFiles : testFiles.filter((file) => changed.has(join('test', file)));
  add(state('tests', ownTests.length > 0 ? [] : [testFiles.length > 0 ? 'test/*.test.ts changed on this branch' : 'test/*.test.ts'], perturbed > 0));

  const paths = [templateDir, reportRecordingPath(target), ...summaries, ...testFiles.map((file) => join('test', file)), 'registry'];
  const uncommitted = (git(root, ['status', '--porcelain', '-uall', '--', ...paths]) ?? '').split('\n').filter((line) => line !== '').map((line) => line.slice(3));
  const ready = steps.every((step) => step.state === 'done');
  add(state('commit', !ready ? ['1-9'] : uncommitted, ready && uncommitted.length > 0));

  const last = git(root, ['log', '-1', '--format=%H', '--', templateDir, reportRecordingPath(target), ...summaries, ...ownTests.map((file) => join('test', file))])?.trim();
  const pushed = last !== undefined && last !== '' && (git(root, ['branch', '-r', '--contains', last]) ?? '').trim() !== '';
  add(state('push', ready && uncommitted.length === 0 && pushed ? [] : ['git push'], false));

  const done = steps.filter((step) => step.state === 'done').length;
  return { steps, done, next: steps.find((step) => step.state === 'partly' || step.state === 'not-started')?.step };
}

/** The entries only another instance of `instance`'s kind names, which its report does not cover. */
function otherInstances(registry: Registry, instance: string | undefined): Set<string> {
  const vault = instance === undefined ? undefined : registry.entries.get(instance);
  if (vault === undefined) return new Set();
  const own = ownedEntries(vault);
  return new Set([...registry.entries.values()].filter((entry) => entry.kind === vault.kind && entry !== vault).flatMap((entry) => [...ownedEntries(entry)].filter((name) => !own.has(name))));
}

/** The commit HEAD left origin/main at; undefined without origin/main, as in a shallow clone, or without a commit. */
const branchedFrom = (root: string): string | undefined => git(root, ['merge-base', 'HEAD', 'origin/main'])?.trim() || undefined;

/** The files under `path` new or changed since `commit`, committed or not. */
function changedSince(root: string, commit: string, path: string): Set<string> {
  const listed = [...(git(root, ['diff', '--name-only', commit, '--', path]) ?? '').split('\n'), ...(git(root, ['ls-files', '--others', '--exclude-standard', '--', path]) ?? '').split('\n')];
  return new Set(listed.filter((line) => line !== ''));
}

/** Whether git shows `file` changed or new: a committed file's time on disk says only when it was checked out. */
const edited = (root: string, file: string): boolean => (git(root, ['status', '--porcelain', '--', file]) ?? '').trim() !== '';

function abiCaseAddresses(root: string): Set<string> {
  const dir = join(root, ABI_CASES_DIR);
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => String(record(readJson(join(dir, file))).address ?? '').toLowerCase()));
}

function pastTxsSummaries(root: string, target: TemplateTarget, registry: Registry): string[] {
  const dir = join(root, SUMMARIES_DIR);
  if (!existsSync(dir)) return [];
  const vault = target.instance === undefined ? undefined : registry.entries.get(target.instance)?.address.toLowerCase();
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .filter((file) => {
      const query = record(record(readJson(join(dir, file))).query);
      return query.template === target.template && (vault === undefined || String(query.token ?? '').toLowerCase() === vault);
    })
    .map((file) => join(SUMMARIES_DIR, file));
}

function perturbRecordings(root: string, target: TemplateTarget): number {
  const dir = join(root, 'testdata', 'perturb');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((file) => {
    const operations = record(record(readJson(join(dir, file))).card).operations;
    return Array.isArray(operations) && operations.some((op) => record(op).template === target.template && (target.instance === undefined || record(record(op).values).vault === target.instance));
  }).length;
}

type Words = {
  readonly steps: Readonly<Record<Step, string>>;
  readonly states: Readonly<Record<StepState['state'], string>>;
  readonly missing: string;
  readonly stepsDone: string;
  readonly next: string;
  readonly usually: (low: number, high: number) => string;
  readonly allDone: string;
};

const WORDS: Readonly<Record<Language, Words>> = {
  en: {
    steps: {
      intent: 'State the intent',
      addresses: 'Research the addresses',
      abi: 'Establish the ABI',
      draft: 'Draft the template',
      pastTxs: 'Study past transactions',
      health: "Check the protocol's health",
      report: 'Generate the report',
      notes: 'Write the notes and reviews',
      tests: 'Add the tests',
      commit: 'Check and commit',
      push: 'Push and tell the signer',
    },
    states: { done: 'done', partly: 'partly done', 'not-started': 'not started', waits: 'written by step 7' },
    missing: 'missing',
    stepsDone: 'steps done',
    next: 'Next',
    usually: (low: number, high: number) => `usually ${low}-${high} min`,
    allDone: 'All steps are done.',
  },
  'zh-TW': {
    steps: {
      intent: '說明意圖',
      addresses: '研究地址',
      abi: '確立 ABI',
      draft: '起草模板',
      pastTxs: '研究過去的交易',
      health: '檢查協議的健康狀況',
      report: '產生報告',
      notes: '撰寫說明與審查',
      tests: '加上測試',
      commit: '檢查並提交',
      push: '推送並告知簽署者',
    },
    states: { done: '完成', partly: '部分完成', 'not-started': '尚未開始', waits: '由第 7 步寫入' },
    missing: '缺少',
    stepsDone: '步完成',
    next: '下一步',
    usually: (low: number, high: number) => `通常 ${low}-${high} 分鐘`,
    allDone: '所有步驟都已完成。',
  },
};

/** The progress as the user reads it: "N / M", one line per step, and the next step with its usual minutes. */
export function renderProgress(progress: BuildProgress, target: TemplateTarget, language: Language): string {
  const words = WORDS[language] as (typeof WORDS)['en'] & { missing: string; stepsDone: string; next: string; usually: (low: number, high: number) => string; allDone: string };
  const name = target.instance === undefined ? target.template : `${target.template} (${target.instance})`;
  const lines = [`${name}: ${progress.done} / ${STEPS.length} ${words.stepsDone}`];
  progress.steps.forEach((step, index) => {
    const missing = step.state === 'done' || step.missing.length === 0 ? '' : ` (${words.missing}: ${step.missing.slice(0, 4).join(', ')}${step.missing.length > 4 ? ', …' : ''})`;
    lines.push(`${String(index + 1).padStart(2)}. ${words.steps[step.step]}: ${words.states[step.state]}${missing}`);
  });
  if (progress.next === undefined) lines.push(words.allDone);
  else {
    const [low, high] = MINUTES[progress.next];
    lines.push(`${words.next}: ${STEPS.indexOf(progress.next) + 1}. ${words.steps[progress.next]} (${words.usually(low, high)})`);
  }
  return `${lines.join('\n')}\n`;
}
