import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TemplateTarget } from './report.ts';

export const USAGE_DIR = join('testdata', 'usage');

/**
 * The tokens an AI used to make a report, as the API reported them call by call, the coordinating session left out.
 * `partial` covers only a later search of the past transactions run again, not the whole report.
 */
export type Usage = {
  readonly kind: 'full' | 'partial';
  readonly models: readonly string[];
  readonly calls: number;
  readonly minutes: number;
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
};

export class UsageError extends Error {
  override name = 'UsageError';
}

const COUNTS = ['calls', 'minutes', 'input', 'cacheWrite', 'cacheRead', 'output'] as const;
const KEYS = new Set<string>(['kind', 'models', ...COUNTS]);
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export function parseUsage(raw: unknown): Usage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new UsageError('usage: not a JSON object');
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !KEYS.has(key));
  if (unknown !== undefined) throw new UsageError(`usage: unknown key ${JSON.stringify(unknown)}`);
  const { kind, models } = record;
  if (kind !== 'full' && kind !== 'partial') throw new UsageError('usage.kind: not "full" or "partial"');
  if (!Array.isArray(models) || models.length === 0 || !models.every((m): m is string => typeof m === 'string' && MODEL_ID.test(m))) throw new UsageError('usage.models: not a list of model ids');
  const count = (key: (typeof COUNTS)[number]): number => {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new UsageError(`usage.${key}: not a whole number of at least 0`);
    return value;
  };
  return { kind, models, calls: count('calls'), minutes: count('minutes'), input: count('input'), cacheWrite: count('cacheWrite'), cacheRead: count('cacheRead'), output: count('output') };
}

export function usagePath(target: TemplateTarget): string {
  const name = target.template.replace('/', '-');
  return join(USAGE_DIR, target.instance === undefined ? `${name}.json` : join(name, `${target.instance}.json`));
}

/** The usage recorded for a report, or undefined when it was not measured. */
export function readUsage(repoRoot: string, target: TemplateTarget): Usage | undefined {
  const path = join(repoRoot, usagePath(target));
  return existsSync(path) ? parseUsage(JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined;
}

/** `claude-opus-5-5` as `Opus 5.5`; an id of another shape as it is. */
export function modelName(id: string): string {
  const [, family, version] = /^claude-([a-z]+)-(\d+(?:-\d{1,2})?)$/.exec(id) ?? [];
  return family === undefined || version === undefined ? id : `${family[0]!.toUpperCase()}${family.slice(1)} ${version.replace('-', '.')}`;
}

/** A token count in millions: one decimal from 1M, two below. */
export const millions = (tokens: number): string => `${(tokens / 1e6).toFixed(tokens >= 1e6 ? 1 : 2)}M`;

export const totalTokens = (u: Usage): number => u.input + u.cacheWrite + u.cacheRead + u.output;
