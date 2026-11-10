import { resolve } from 'node:path';
import { kissSignHome } from '../keys.ts';
import { OK, UsageError } from './io.ts';
import type { Io } from './io.ts';

export type ManagedSettings = {
  readonly permissions: { readonly disableBypassPermissionsMode: 'disable'; readonly deny: readonly string[] };
  readonly sandbox: { readonly enabled: true; readonly failIfUnavailable: true; readonly allowUnsandboxedCommands: false };
};

const POLICY_DIR: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: '/Library/Application Support/ClaudeCode',
  linux: '/etc/claude-code',
};

/** A `//` rule path covering `dir` and everything in it. */
function absoluteRule(dir: string): string {
  const path = resolve(dir);
  if (/[*?[\]!\\]/.test(path)) throw new UsageError(`${path} holds a character a permission rule reads as a pattern; move it first.`);
  return `/${path}/**`;
}

export function managedSettings(clone: string, home: string): ManagedSettings {
  const paths = [absoluteRule(clone), absoluteRule(home)];
  return {
    permissions: {
      disableBypassPermissionsMode: 'disable',
      deny: [...paths.flatMap((path) => [`Edit(${path})`, `Read(${path})`]), 'Read(~/.kiss-sign/.env)'],
    },
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
  };
}

export function printManagedSettings(args: readonly string[], io: Io): number {
  if (args.length > 0) throw new UsageError('managed-settings takes nothing more.');
  const clone = resolve(io.repoRoot);
  const home = resolve(kissSignHome(io.env));
  io.stdout(`${JSON.stringify(managedSettings(clone, home), null, 2)}\n`);
  const dir = POLICY_DIR[process.platform];
  const install =
    dir === undefined
      ? `  Put it where Claude Code reads managed settings on ${process.platform}: https://code.claude.com/docs/en/managed-settings.md\n`
      : `  sudo mkdir -p '${dir}'\n  '${clone}/bin/kiss-sign' managed-settings | sudo tee '${dir}/managed-settings.json' > /dev/null\n` +
        `If ${dir}/managed-settings.json already exists, merge these keys into it by hand instead.\n`;
  io.stderr(
    `The JSON above keeps Claude Code out of this clone (${clone}) and out of ${home}, and keeps its sandbox on.\n` +
      `Install it once on the device you sign on, from your own terminal, not from an AI session:\n${install}` +
      `Then restart Claude Code and run /status: Setting sources shows "Enterprise managed settings (file)".\n` +
      `From then on, work with the AI in another clone. Run verify, card seal and template approve from this one.\n`,
  );
  return OK;
}
