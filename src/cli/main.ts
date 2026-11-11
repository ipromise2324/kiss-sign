import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AddressBookError } from '../address-book.ts';
import { CardError } from '../card.ts';
import { MissingKeyError } from '../chain/providers.ts';
import { httpsTransport } from '../chain/rpc.ts';
import { ConfigError } from '../config.ts';
import { KEYS, KeyError, findKey, keyFilePath, keySpec, kissSignHome, removeKey, saveKey } from '../keys.ts';
import type { KeySpec } from '../keys.ts';
import { RegistryError } from '../registry.ts';
import { SafeTxParseError } from '../safe/types.ts';
import { TemplateError } from '../template/template.ts';
import { VerifyError } from '../verify/verify.ts';
import { cardNew } from './card-new.ts';
import { FAILED, OK, USAGE, UsageError } from './io.ts';
import { printManagedSettings } from './managed-settings.ts';
import type { Io } from './io.ts';
import { hiddenPrompt } from './prompt.ts';
import { bookAdd, bookList, cardSeal, init, templateApprove } from './setup.ts';
import { replay, verify } from './verify.ts';

export type { Io } from './io.ts';

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
  init: { usage: 'init --safe <address>', run: init },
  'book add': { usage: 'book add <name> <address>', run: bookAdd },
  'book list': { usage: 'book list', run: bookList },
  'card new': { usage: 'card new <protocol>/<operation>...', run: cardNew },
  'card seal': { usage: 'card seal <card.json>', run: cardSeal },
  'template approve': { usage: 'template approve <protocol>/<operation>', run: templateApprove },
  verify: { usage: 'verify --card <sealed card hash> (--tx <file> | --safe-tx-hash <hash>)', run: verify },
  replay: { usage: 'replay <verdict file>', run: replay },
  'key add': { usage: `key add <${KEYS.map(({ name }) => name).join('|')}>`, run: keyAdd },
  'key list': { usage: 'key list', run: keyList },
  'key remove': { usage: 'key remove <name>', run: keyRemove },
  'managed-settings': { usage: 'managed-settings', run: printManagedSettings },
};

const USAGE_TEXT = `Usage:\n${Object.values(COMMANDS)
  .map(({ usage }) => `  pnpm kiss-sign ${usage}\n`)
  .join('')}`;

/** Errors whose message is written for the signer. */
const FAILURES = [KeyError, CardError, ConfigError, VerifyError, AddressBookError, SafeTxParseError, TemplateError, RegistryError, MissingKeyError];

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const name = [argv.slice(0, 2).join(' '), argv[0] ?? ''].find((words) => Object.hasOwn(COMMANDS, words));
  const command = name === undefined ? undefined : COMMANDS[name];
  if (name === undefined || command === undefined) {
    io.stderr(USAGE_TEXT);
    return USAGE;
  }
  try {
    return await command.run(argv.slice(name.split(' ').length), io);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof UsageError || code?.startsWith('ERR_PARSE_ARGS')) {
      io.stderr(`kiss-sign: ${error.message}\n`);
      return USAGE;
    }
    if (FAILURES.some((kind) => error instanceof kind) || error instanceof SyntaxError || code === 'ENOENT') {
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
    platform: process.platform,
    readSecret: process.stdin.isTTY ? (question) => hiddenPrompt(question, process.stdin, process.stderr) : undefined,
    ask: process.stdin.isTTY ? askLine : undefined,
    repoRoot: join(import.meta.dirname, '..', '..'),
    transport: httpsTransport(),
    fetchJson: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new VerifyError(`${new URL(url).host} answered ${response.status}`);
      return response.json();
    },
  };
}

async function askLine(question: string): Promise<string | undefined> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(question);
  } catch {
    return undefined;
  } finally {
    terminal.close();
  }
}
