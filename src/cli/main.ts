import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AddressBookError } from '../address-book.ts';
import { CardError } from '../card.ts';
import { MissingKeyError } from '../chain/providers.ts';
import { httpsTransport } from '../chain/rpc.ts';
import { ConfigError, loadStoredConfig } from '../config.ts';
import { KEYS, KeyError, findKey, keyFilePath, keySpec, kissSignHome, removeKey, saveKey } from '../keys.ts';
import type { KeySpec } from '../keys.ts';
import { DEFAULT_LANGUAGE, isLanguage } from '../language.ts';
import type { Language } from '../language.ts';
import { RegistryError } from '../registry.ts';
import { SafeTxParseError } from '../safe/types.ts';
import { TemplateError } from '../template/template.ts';
import { httpsMessage } from '../verify/messages.ts';
import { VerifyError } from '../verify/verify.ts';
import { cardNew } from './card-new.ts';
import { colorWanted } from './format.ts';
import { FAILED, OK, USAGE, UsageError } from './io.ts';
import type { Io } from './io.ts';
import { LABELS } from './labels.ts';
import type { Labels } from './labels.ts';
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

/** `help` is what `--help` prints below the usage line, in English, before the command reads the config, a key or the network. */
type Command = { readonly usage: string; readonly help: string; readonly run: (args: readonly string[], io: Io, w: Labels) => number | Promise<number> };

const INIT_HELP = `Sets up $KISS_SIGN_HOME (default ~/.kiss-sign) for one Safe on Ethereum mainnet. It writes
config.json with chain 1, the Safe, the language and, as repo, the GitHub repository
(github.com/<owner>/<name>, lowercase) that this clone's origin names after any
url.<base>.insteadOf rewrite: the signer's own fork, whose main verify trusts.
It refuses an origin with a URL that is not a GitHub https or ssh URL, or whose URLs name more
than one repository, and a home already set up for another Safe or another repository. Run again with the same Safe, it adds repo to a config that
lacks one, and keeps the recorded language unless --language changes it.
It also writes $KISS_SIGN_HOME/.env when there is none, mode 0600, with an empty line per key,
each under a comment naming the commands that need it. It never overwrites an existing .env and
warns when other users can read it. It prints the .env path, the keys to fill in, and a command
that opens the file (open -e on macOS, \${EDITOR:-nano} elsewhere).

Options:
  --safe <address>       the Safe; may be left out on a home already set up, to change only the
                         language
  --language en|zh-TW    the language of the HTML report, verify's page and the signing
                         commands' terminal text; en unless given, and a config with none reads en

Writes: $KISS_SIGN_HOME/config.json, and $KISS_SIGN_HOME/.env when there is none.
Keys: none.
Rules: docs/design.md, "Two tiers"; docs/design/program-ownership.md, "The program checks itself
first"; docs/design/engine-and-chain.md, "Chain access".
`;

const KEY_ADD_HELP = `Asks for one API key at a hidden prompt and saves it in $KISS_SIGN_HOME/.env, readable by you
only. It never prints the key. Run it in your own terminal with nothing piped into it, and never
type a key on the command line. A key set in the environment wins over the file.
alchemy is ALCHEMY_API_KEY, etherscan is ETHERSCAN_API_KEY, and github is GITHUB_TOKEN, which is
optional: a fine-grained, read-only token with access to public repositories only. Only the
research commands read GITHUB_TOKEN, and only for api.github.com, where it raises the limit from
60 to 5,000 requests an hour and changes no answer. verify, card, template approve, replay and
pnpm history never read it.

Writes: $KISS_SIGN_HOME/.env.
Keys: none.
Rules: docs/design/engine-and-chain.md, "Chain access".
`;

const KEY_LIST_HELP = `Says which keys are set and where from (the environment or $KISS_SIGN_HOME/.env), and for a key
not set where to get one. It never prints a key.

Writes: nothing.
Keys: none.
Rules: docs/design/engine-and-chain.md, "Chain access".
`;

const KEY_REMOVE_HELP = `Takes one key (alchemy, etherscan or github) out of $KISS_SIGN_HOME/.env, and says when the same
key is still set in your environment.

Writes: $KISS_SIGN_HOME/.env.
Keys: none.
Rules: docs/design/engine-and-chain.md, "Chain access".
`;

const BOOK_ADD_HELP = `Adds an address-book entry, a name for an address a card may name, such as a transfer's
recipient. Take the address from a source outside the chat and check it character by character.
It prints the name and the full address, and the entry it replaces, and saves only after your
yes at a terminal. It refuses a name the contract registry holds.

Writes: $KISS_SIGN_HOME/address-book.json.
Keys: none.
Rules: docs/design.md, "Who authorises what"; docs/design/data-shapes.md, "Intent card".
`;

const BOOK_LIST_HELP = `Prints the address book: each name with its full address.

Writes: nothing.
Keys: none.
Rules: docs/design/data-shapes.md, "Intent card".
`;

const TEMPLATE_APPROVE_HELP = `Approves a template for verify. It requires every origin URL to be the config's repo, fetches its
main, and prints the repository, that commit with its subject line, the template's file, and the
template's keccak256 as its fingerprint. After your yes at a terminal it records that hash of the
template as it is at origin/main. Run it once per template and again whenever it changes.

Writes: $KISS_SIGN_HOME/approved-templates.json.
Keys: none.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 8);
docs/design/program-ownership.md, "The program checks itself first".
`;

const CARD_NEW_HELP = `Builds an intent card at your terminal, one or more templates on one card, then asks the card seal
step's question. It refuses without a terminal. It first fetches main of the config's repo and
stops before asking anything, telling you to run git pull, when any file under templates/ or
registry/ differs from origin/main.
Each address is picked by number, exact name, full address or market id from the lists it
prints: registry entries of the right kind, address-book entries or the Safe, or the markets.
Amounts are typed in whole tokens, such as 5, 1.25 or 1,000,611.448606, or max where the field
declares one; a token outside the registry is typed in base units. A percent, such as 100 or 35.5, is at most 100 with at most 16 decimals. Decimals
are read through both providers at one block they agree on. A computed field is read, not asked.
It ends with the card in one box, each amount in whole tokens and base units, and the block and
providers of every chain read. Output is plain text when stdout is not a terminal or NO_COLOR is
set.

Writes: $KISS_SIGN_HOME/cards/<hash>.json, after your yes.
Keys: ALCHEMY_API_KEY, from the environment or $KISS_SIGN_HOME/.env, when a template has an amount
of a token or a computed amount.
Rules: docs/design/flow.md, "Every signing" (steps 9 and 10); docs/design/data-shapes.md, "Intent
card"; docs/design/program-ownership.md, "The program checks itself first".
`;

const CARD_SEAL_HELP = `Seals a card written as a file. It runs the same check against GitHub's main as card new, resolves
every name, and refuses 0 in a computed amount field or in one a share price bound or atLeast
compares with, and an instance, named in any field, with no report for its template (an entry of
the kind the template is reported per, a vault unless its instanceField names another kind),
reading the report folders from the clone. It prints the card in
one box with full addresses and each amount in base units, since it reads no decimals. After
your yes at a terminal it stores the card and prints its hash.

Writes: $KISS_SIGN_HOME/cards/<hash>.json.
Keys: none.
Rules: docs/design/flow.md, "Every signing" (step 10); docs/design/data-shapes.md, "Intent card".
`;

const VERIFY_HELP = `Checks a Safe transaction against a sealed card and prints one verdict: MATCH with the
safeTxHash, or MISMATCH or UNVERIFIABLE with the checks that caused it.
It first runs the self-check: every origin URL must be the config's repo, and the checkout must
be exactly its main. It refuses, writing no verdict, a card holding 0 where card seal refuses it
or naming an instance with no report for its template at that commit. It reads each signed message
the transaction holds only by its digest, such as a CoW order, from the template's lookup, then
runs every check. An executed transaction is judged by its receipt, and also simulated alone on
its parent block when the card reads views or changes a Safe setting; any other is simulated on
the latest block.
It writes a verdict file and an HTML page in the config's language, with no script and nothing
loaded from outside, showing the verdict, each check, the card, the asset changes it expects, the
calls that move no asset of the Safe and, on MATCH, the 比對清單. It prints the page's path
and the command that opens it. On MATCH it prints the command for the independent computer,
./check.sh <nonce>, with --hints '<hints>' when a template reads bytes as encoded parameters or
packed parts.

Options:
  --card <hash>          the hash card seal printed
  --tx <file>            the transaction as Transaction Service JSON or the Safe web app's JSON
  --safe-tx-hash <hash>  read the transaction from the Safe Transaction Service

Writes: the verdict file and its page in $KISS_SIGN_HOME/verdicts/.
Keys: ALCHEMY_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "Every signing" (step 12);
docs/design/program-ownership.md, "The program checks itself first";
docs/design/data-shapes.md, "Verdict file";
docs/design/independent-check.md, "The independent check (hardened tier)".
`;

const REPLAY_HELP = `Recomputes a verdict offline from the verdict file alone and says whether it equals the recorded
one. It exits 0 when it does, a recorded MISMATCH or UNVERIFIABLE included, and 1 when it
differs or the file cannot be replayed.

Writes: nothing.
Keys: none.
Rules: docs/design/data-shapes.md, "Verdict file".
`;

const COMMANDS: Readonly<Record<string, Command>> = {
  init: { usage: 'init --safe <address> [--language en|zh-TW]', help: INIT_HELP, run: init },
  'book add': { usage: 'book add <name> <address>', help: BOOK_ADD_HELP, run: bookAdd },
  'book list': { usage: 'book list', help: BOOK_LIST_HELP, run: bookList },
  'card new': { usage: 'card new <protocol>/<operation>...', help: CARD_NEW_HELP, run: cardNew },
  'card seal': { usage: 'card seal <card.json>', help: CARD_SEAL_HELP, run: cardSeal },
  'template approve': { usage: 'template approve <protocol>/<operation>', help: TEMPLATE_APPROVE_HELP, run: templateApprove },
  verify: { usage: 'verify --card <sealed card hash> (--tx <file> | --safe-tx-hash <hash>)', help: VERIFY_HELP, run: verify },
  replay: { usage: 'replay <verdict file>', help: REPLAY_HELP, run: replay },
  'key add': { usage: `key add <${KEYS.map(({ name }) => name).join('|')}>`, help: KEY_ADD_HELP, run: keyAdd },
  'key list': { usage: 'key list', help: KEY_LIST_HELP, run: keyList },
  'key remove': { usage: 'key remove <name>', help: KEY_REMOVE_HELP, run: keyRemove },
};

const usageText = (w: Labels): string => `${w.usage}\n${Object.values(COMMANDS)
  .map(({ usage }) => `  pnpm kiss-sign ${usage}\n`)
  .join('')}`;

/**
 * The language a command prints in: the one its last `--language` names, as parseArgs takes, else the config's, else English, so a command run
 * before any config exists, or whose config cannot be read, prints English.
 */
function languageOf(argv: readonly string[], io: Io): Language {
  const at = argv.findLastIndex((arg) => arg === '--language' || arg.startsWith('--language='));
  const arg = argv[at];
  const flag = arg === '--language' ? argv[at + 1] : arg?.slice('--language='.length);
  if (isLanguage(flag)) return flag;
  try {
    return loadStoredConfig(kissSignHome(io.env))?.language ?? DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/** Errors whose message is written for the signer. */
const FAILURES = [KeyError, CardError, ConfigError, VerifyError, AddressBookError, SafeTxParseError, TemplateError, RegistryError, MissingKeyError];

const isHelpFlag = (arg: string): boolean => arg === '--help' || arg === '-h';

const TOP_HELP = `usage: pnpm kiss-sign <command> [--help]

The signing commands: set up a home, build and seal a card, and check a Safe transaction against
it before you sign. pnpm kiss-sign runs bin/kiss-sign from this clone; the two are the same program.
Run pnpm kiss-sign <command> --help for one command.

${Object.values(COMMANDS)
  .map(({ usage }) => `  ${usage}\n`)
  .join('')}`;

/**
 * The help a command line asks for: `--help` or `-h` as the command, or right after the words of one command or of a group such
 * as `card`, never later, where it could be a value such as a file named `-h`.
 */
function helpAsked(argv: readonly string[]): string | undefined {
  const at = argv.findIndex(isHelpFlag);
  if (at === -1) return undefined;
  const words = argv.slice(0, at).join(' ');
  if (words === '') return TOP_HELP;
  const named = Object.entries(COMMANDS).filter(([name]) => name === words || name.split(' ')[0] === words);
  return named.length === 0 ? undefined : named.map(([, { usage, help }]) => `usage: pnpm kiss-sign ${usage}\n\n${help}`).join('\n');
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const help = helpAsked(argv);
  if (help !== undefined) {
    io.stdout(help);
    return OK;
  }
  const name = [argv.slice(0, 2).join(' '), argv[0] ?? ''].find((words) => Object.hasOwn(COMMANDS, words));
  const command = name === undefined ? undefined : COMMANDS[name];
  const w = LABELS[languageOf(argv, io)];
  if (name === undefined || command === undefined) {
    io.stderr(usageText(w));
    return USAGE;
  }
  try {
    return await command.run(argv.slice(name.split(' ').length), io, w);
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
    color: colorWanted(process.stdout.isTTY, process.env),
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
    readMessage: httpsMessage,
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
