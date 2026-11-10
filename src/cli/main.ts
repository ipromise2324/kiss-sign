import { KEYS, KeyError, findKey, keyFilePath, keySpec, kissSignHome, removeKey, saveKey } from '../keys.ts';
import type { Env, KeySpec } from '../keys.ts';
import { hiddenPrompt } from './prompt.ts';

export type Io = {
  readonly env: Env;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Undefined when stdin is not a terminal, so no key can arrive through a pipe or a chat. */
  readonly readSecret: ((question: string) => Promise<string | undefined>) | undefined;
};

const OK = 0;
const FAILED = 1;
const USAGE = 64;

class UsageError extends Error {}

const KEY_NAMES = KEYS.map(({ name }) => name).join(' or ');

function keyArg(args: readonly string[], command: string): KeySpec {
  const [name, ...extra] = args;
  if (extra.length > 0) {
    throw new UsageError(
      `${command} takes only the key name. If you typed a key on the command line, your shell history holds it: revoke it and make a new one.`,
    );
  }
  const spec = name === undefined ? undefined : keySpec(name);
  if (spec === undefined) throw new UsageError(`${command} needs a key name: ${KEY_NAMES}.`);
  return spec;
}

async function keyAdd(args: readonly string[], io: Io): Promise<number> {
  const spec = keyArg(args, 'key add');
  if (io.readSecret === undefined) {
    throw new UsageError('key add reads the key at a hidden prompt, so run it in your own terminal with nothing piped into it.');
  }
  const typed = await io.readSecret(`${spec.label} API key (typing is hidden): `);
  if (typed === undefined || typed.trim() === '') {
    io.stderr('No key saved.\n');
    return FAILED;
  }
  const home = kissSignHome(io.env);
  saveKey(home, spec, typed.trim());
  io.stdout(`Saved the ${spec.label} key to ${keyFilePath(home)}, readable by you only.\n`);
  if (io.env[spec.env]) io.stdout(`${spec.env} is also set in your environment, and it wins over the file.\n`);
  return OK;
}

function keyList(args: readonly string[], io: Io): number {
  if (args.length > 0) throw new UsageError('key list takes nothing more.');
  for (const spec of KEYS) {
    const found = findKey(spec, io.env);
    const state = found === undefined ? `not set (get a free key at ${spec.signup})` : `set (${found.from})`;
    io.stdout(`${spec.name} ${spec.env}: ${state}\n`);
  }
  return OK;
}

function keyRemove(args: readonly string[], io: Io): number {
  const spec = keyArg(args, 'key remove');
  const home = kissSignHome(io.env);
  const removed = removeKey(home, spec);
  io.stdout(removed ? `Removed the ${spec.label} key from ${keyFilePath(home)}.\n` : `No ${spec.label} key in ${keyFilePath(home)}.\n`);
  if (io.env[spec.env]) io.stdout(`${spec.env} is still set in your environment.\n`);
  return OK;
}

type Command = { readonly usage: string; readonly run: (args: readonly string[], io: Io) => number | Promise<number> };

const COMMANDS: Readonly<Record<string, Command>> = {
  'key add': { usage: `key add <${KEYS.map(({ name }) => name).join('|')}>`, run: keyAdd },
  'key list': { usage: 'key list', run: keyList },
  'key remove': { usage: 'key remove <name>', run: keyRemove },
};

const USAGE_TEXT = `Usage:\n${Object.values(COMMANDS)
  .map(({ usage }) => `  kiss-sign ${usage}\n`)
  .join('')}`;

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const name = argv.slice(0, 2).join(' ');
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) {
    io.stderr(USAGE_TEXT);
    return USAGE;
  }
  try {
    return await command.run(argv.slice(2), io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`kiss-sign: ${error.message}\n`);
      return USAGE;
    }
    if (error instanceof KeyError) {
      io.stderr(`kiss-sign: ${error.message}\n`);
      return FAILED;
    }
    throw error;
  }
}

export function nodeIo(): Io {
  return {
    env: process.env,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    readSecret: process.stdin.isTTY ? (question) => hiddenPrompt(question, process.stdin, process.stderr) : undefined,
  };
}
