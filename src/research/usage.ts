import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TemplateTarget } from './report.ts';

export const USAGE_DIR = join('testdata', 'usage');

/**
 * The tokens an AI used to make a report, as the API reported them call by call, the coordinating session left out.
 * `past-txs-rerun` covers only a later search of the past transactions run again, not the whole report.
 */
export type Usage = {
  readonly kind: 'full' | 'past-txs-rerun';
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
const MODEL_ID = /^claude-([a-z]{1,12})-(\d+(?:-\d{1,2})?)(?:-\d{8})?$/;
const MAX_MODELS = 4;

export function parseUsage(raw: unknown): Usage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new UsageError('usage: not a JSON object');
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !KEYS.has(key));
  if (unknown !== undefined) throw new UsageError(`usage: unknown key ${JSON.stringify(unknown)}`);
  const { kind, models } = record;
  if (kind !== 'full' && kind !== 'past-txs-rerun') throw new UsageError('usage.kind: not "full" or "past-txs-rerun"');
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS || !models.every((m): m is string => typeof m === 'string' && MODEL_ID.test(m))) throw new UsageError('usage.models: not a list of model ids');
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

export function readUsage(repoRoot: string, target: TemplateTarget): Usage | undefined {
  const file = usagePath(target);
  const path = join(repoRoot, file);
  if (!existsSync(path)) return undefined;
  try {
    return parseUsage(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch (e) {
    if (e instanceof UsageError || e instanceof SyntaxError) throw new UsageError(`${file}: ${e.message}`);
    throw e;
  }
}

export function modelName(id: string): string {
  const [, family, version] = MODEL_ID.exec(id) ?? [];
  if (family === undefined || version === undefined) throw new UsageError(`usage.models: ${JSON.stringify(id)} is not a model id`);
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${version.replace('-', '.')}`;
}

export const formatMillions = (tokens: number): string => `${(tokens / 1e6).toFixed(tokens >= 1e6 ? 1 : 2)}M`;

export const totalTokens = (u: Usage): number => u.input + u.cacheWrite + u.cacheRead + u.output;
