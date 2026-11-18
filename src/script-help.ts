import { writeSync } from 'node:fs';

export const asksHelp = (args: readonly string[]): boolean => args.some((arg) => arg === '--help' || arg === '-h');

/** Prints `help` on stdout and exits 0 when the command's arguments hold `--help` or `-h`, before it reads a key, a file or the network. */
export function exitOnHelp(help: string, args: readonly string[] = process.argv.slice(2)): void {
  if (!asksHelp(args)) return;
  writeSync(1, help.endsWith('\n') ? help : `${help}\n`);
  process.exit(0);
}
