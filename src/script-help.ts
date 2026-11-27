import { writeSync } from 'node:fs';

/** Prints `help` on stdout and exits 0 when the command's first argument is `--help` or `-h`, before it reads a key, a file or the network; a later `-h` may be a value. */
export function exitOnHelp(help: string, args: readonly string[] = process.argv.slice(2)): void {
  if (args[0] !== '--help' && args[0] !== '-h') return;
  writeSync(1, help.endsWith('\n') ? help : `${help}\n`);
  process.exit(0);
}

/** A usage refusal: prints `problem` and the first paragraph of `help` on stderr, then exits 64. */
export const usageExit =
  (help: string) =>
  (problem: string): never => {
    console.error(`${problem}\n${help.split('\n\n')[0]}`);
    process.exit(64);
  };
