import { writeSync } from 'node:fs';
import { MissingKeyError } from './chain/providers.ts';
import { UsageError } from './cli/io.ts';
import { RegistryError } from './registry.ts';
import { TemplateError } from './template/template.ts';

const oneLine = (text: string): string => text.replace(/\r?\n/g, '\\n');

/**
 * The line, and exit code, a script ends with on an error whose message is written for the reader: a usage error with
 * `usageCode`, else a registry, template, missing-key, JSON or missing-file error as one `REFUSED` line with 1;
 * undefined for any other.
 */
export function refusal(error: unknown, usageCode: number): { readonly line: string; readonly code: number } | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (error instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS'))) return { line: error.message, code: usageCode };
  const kind = error instanceof RegistryError ? 'registry: ' : error instanceof TemplateError ? 'template: ' : '';
  if (kind !== '' || error instanceof MissingKeyError || error instanceof SyntaxError || code === 'ENOENT') return { line: `REFUSED  ${kind}${oneLine(error.message)}`, code: 1 };
  return undefined;
}

/** Ends the script on such an error it does not catch with that line instead of a stack trace. */
export function refuseReadableErrors(usageCode = 2): void {
  process.on('uncaughtExceptionMonitor', (error) => {
    const refused = refusal(error, usageCode);
    if (refused === undefined) return;
    writeSync(2, `${refused.line}\n`);
    process.exit(refused.code);
  });
}
