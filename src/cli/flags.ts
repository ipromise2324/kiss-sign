import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { UsageError } from './io.ts';

/** A flag that takes one value, given more than once. */
export class RepeatedFlagError extends UsageError {
  readonly flag: string;

  constructor(flag: string) {
    super(`--${flag} is given more than once, and it takes one value`);
    this.flag = flag;
  }
}

/** parseArgs, refusing a flag that takes one value given twice, of which parseArgs would keep only the last; a flag declared `multiple` may repeat, and so may a boolean. */
export function parseFlags<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  const { tokens, ...parsed } = parseArgs({ ...config, tokens: true });
  const seen = new Set<string>();
  for (const token of tokens ?? []) {
    if (token.kind !== 'option') continue;
    const option = config.options?.[token.name];
    if (option?.type !== 'string' || option.multiple === true) continue;
    if (seen.has(token.name)) throw new RepeatedFlagError(token.name);
    seen.add(token.name);
  }
  return (config.tokens === true ? { ...parsed, tokens } : parsed) as ReturnType<typeof parseArgs<T>>;
}
