import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadAddressBook, saveAddressBook } from '../address-book.ts';
import { parseCard, resolveCard, sealCard } from '../card.ts';
import type { Card } from '../card.ts';
import { ConfigError, loadApproved, loadConfig, loadStoredConfig, saveApproved, saveConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { DEFAULT_LANGUAGE, LANGUAGES, LANGUAGE_NAMES, isLanguage } from '../language.ts';
import { KEYS, createKeyFile, keyFilePath, kissSignHome } from '../keys.ts';
import { REGISTRY_DIR, REGISTRY_PATH, isEntryName, loadRegistry, parseRegistry } from '../registry.ts';
import { checksumAddress, parseAddress } from '../safe/types.ts';
import { TEMPLATES_DIR, loadTemplate, parseTemplate } from '../template/template.ts';
import { reportedVaultsIn, unreportedVault } from '../template/vault-reports.ts';
import { commitSubject, dataDiffersFromOriginMain, fetchOriginMain, fileAt, originRepo } from '../verify/self-check.ts';
import { keccakText } from '../verify/verify.ts';
import { cardSummary } from './card-view.ts';
import type { CardReads } from './card-view.ts';
import { WIDTH, paint, rows, text, wrap } from './format.ts';
import { FAILED, OK, UsageError, terminal } from './io.ts';
import { LABELS } from './labels.ts';
import type { Io, Terminal } from './io.ts';

export function requireConfig(home: string): Config {
  const config = loadConfig(home);
  if (config === undefined) throw new ConfigError(`no config in ${home}; run pnpm kiss-sign init --safe <address> first`);
  return config;
}

export function shellWord(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

function openCommand(platform: NodeJS.Platform, path: string): string {
  return platform === 'darwin' ? `open -e ${shellWord(path)}` : `\${EDITOR:-nano} ${shellWord(path)}`;
}

export async function init(args: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { safe: { type: 'string' }, language: { type: 'string' } }, strict: true });
  if (values.language !== undefined && !isLanguage(values.language)) throw new UsageError(`--language takes ${LANGUAGES.join(' or ')}.`);
  const home = kissSignHome(io.env);
  const existing = loadStoredConfig(home);
  const safe = values.safe !== undefined ? parseAddress('--safe', values.safe) : existing?.safe;
  if (safe === undefined) throw new UsageError('init needs --safe <address>.');
  const origin = originRepo(io.repoRoot);
  if (origin.kind === 'refused') {
    io.stderr(`kiss-sign: run init in a clone of your own fork on GitHub; nothing was set up:\n${origin.problems.map((problem) => `  ${problem}\n`).join('')}`);
    return FAILED;
  }
  const { repo } = origin;
  if (existing !== undefined && existing.safe !== safe) {
    io.stderr(`kiss-sign: ${home} is already set up for another Safe. Remove its config.json to change it.\n`);
    return FAILED;
  }
  if (existing?.repo !== undefined && existing.repo !== repo) {
    io.stderr(`kiss-sign: ${home} is already set up for another repository, ${existing.repo}. Remove its config.json to change it.\n`);
    return FAILED;
  }
  const language = values.language ?? existing?.language ?? DEFAULT_LANGUAGE;
  saveConfig(home, { chainId: 1n, safe, repo, language });
  const keyFile = keyFilePath(home);
  const created = createKeyFile(home);
  const mode = statSync(keyFile).mode & 0o777;
  const I = LABELS.init;
  const p = paint(io.color === true);
  const lines = [
    p.heading(I.title),
    ...rows([
      [I.safe, [checksumAddress(safe), I.chain]],
      [I.repository, [repo, I.trust]],
      [I.language, [`${LANGUAGE_NAMES[language]} (${language}), for reports and the verify page`, `pnpm kiss-sign init --language ${LANGUAGES.join('|')} changes it`]],
      [I.keyFile, [keyFile, created ? 'created, readable by you only' : 'it is already there and was left as it is']],
    ]),
    ...((mode & 0o077) === 0 ? [] : [p.warn(`Warning: other users can read ${keyFile} (mode ${mode.toString(8)}). Run chmod 600 ${shellWord(keyFile)}.`)]),
    '',
    p.heading(I.keys),
    ...rows(KEYS.map((spec) => [spec.env, [`${I.getIt} ${spec.signup}`, `${I.neededBy} ${spec.usedBy}`]])),
    '',
    p.heading(I.next),
    '  1. Open the key file and paste each key after its = sign:',
    `       ${openCommand(io.platform, keyFile)}`,
    '     Or enter each key with the command below; what you type is not shown on screen:',
    ...KEYS.map(({ name }) => `       pnpm kiss-sign key add ${name}`),
    '  2. See which keys are set:',
    '       pnpm kiss-sign key list',
  ];
  io.stdout(lines.map((line) => `${line}\n`).join(''));
  return OK;
}

export async function bookAdd(args: readonly string[], io: Io): Promise<number> {
  const [name, raw, ...extra] = args;
  if (name === undefined || raw === undefined || extra.length > 0) throw new UsageError('book add takes a name and an address.');
  if (!isEntryName(name)) throw new UsageError(`${JSON.stringify(name.slice(0, 64))} is not a name: lowercase words joined by - or ., and not "safe" or "eth".`);
  const address = parseAddress('address', raw);
  const { confirm } = terminal(io, 'book add');
  if (loadRegistry(io.repoRoot).entries.has(name)) throw new UsageError(`${name} is already a contract in the registry; choose another name.`);
  const home = kissSignHome(io.env);
  const book = loadAddressBook(home);
  const old = book.get(name);
  if (old === address) {
    io.stdout(`${name} is already ${checksumAddress(address)}.\n`);
    return OK;
  }
  const B = LABELS.book;
  const p = paint(io.color === true);
  io.stdout(
    text([
      ...rows([[B.name, p.picked(name)], [B.address, p.picked(checksumAddress(address))], ...(old === undefined ? [] : [[B.replacing, checksumAddress(old)] as const])]),
      B.check,
    ]),
  );
  if (!(await confirm('Add this entry? [y/N] '))) {
    io.stderr('Nothing added.\n');
    return FAILED;
  }
  saveAddressBook(home, new Map([...book, [name, address]]));
  io.stdout(`Added ${name}.\n`);
  return OK;
}

export function bookList(args: readonly string[], io: Io): number {
  if (args.length > 0) throw new UsageError('book list takes nothing more.');
  const book = loadAddressBook(kissSignHome(io.env));
  if (book.size === 0) io.stdout(`${LABELS.book.empty}\n`);
  else io.stdout(text(rows([...book].map(([name, address]) => [name, checksumAddress(address)]), 0)));
  return OK;
}

/**
 * `card new` and `card seal` read the templates and the registry from the clone. Stops, printing why, unless they are
 * main of the configured repository as GitHub has it now, since a merge on GitHub changes nothing here until a pull.
 */
export function stopUnlessDataIsMain(io: Io): boolean {
  const { repo } = requireConfig(kissSignHome(io.env));
  const data = dataDiffersFromOriginMain(io.repoRoot, repo, [TEMPLATES_DIR, REGISTRY_DIR]);
  if (data.kind === 'current') return true;
  const why =
    data.kind === 'differs'
      ? `${TEMPLATES_DIR}/ and ${REGISTRY_DIR}/ here are not main of ${repo} on GitHub; run git pull, then run this again.`
      : `could not check that ${TEMPLATES_DIR}/ and ${REGISTRY_DIR}/ here are main of ${repo} on GitHub, so nothing was asked.`;
  io.stderr(`kiss-sign: ${why}\n${data.problems.map((p) => `  ${p}\n`).join('')}`);
  return false;
}

export async function cardSeal(args: readonly string[], io: Io): Promise<number> {
  const [path, ...extra] = args;
  if (path === undefined || extra.length > 0) throw new UsageError('card seal takes the path of one card JSON file.');
  const { confirm } = terminal(io, 'card seal');
  if (!stopUnlessDataIsMain(io)) return FAILED;
  return seal(parseCard(JSON.parse(readFileSync(path, 'utf8'))), io, confirm);
}

/** Resolves every name, shows the card with full addresses, and stores it under its hash once the signer says yes. */
export async function seal(card: Card, io: Io, confirm: Terminal['confirm'], reads?: CardReads): Promise<number> {
  const home = kissSignHome(io.env);
  const { safe } = requireConfig(home);
  const registry = loadRegistry(io.repoRoot);
  const templates = new Map(card.operations.map((op) => [op.template, loadTemplate(io.repoRoot, op.template, registry)]));
  const resolution = resolveCard(card, { templates, registry, addressBook: loadAddressBook(home), safe });
  if (resolution.kind === 'refused') {
    io.stderr(`kiss-sign: card refused at ${resolution.at}: ${resolution.detail}\n`);
    return FAILED;
  }
  const unreported = unreportedVault(resolution.card, templates, registry, (id) => reportedVaultsIn(io.repoRoot, id));
  if (unreported !== undefined) {
    io.stderr(`kiss-sign: card refused: ${unreported}\n`);
    return FAILED;
  }
  io.stdout(text(cardSummary(resolution.card, templates, registry, reads, paint(io.color === true))));
  if (!(await confirm(LABELS.card.confirm))) {
    io.stderr('Nothing sealed.\n');
    return FAILED;
  }
  io.stdout(`${LABELS.card.sealed(sealCard(home, card))}\n`);
  return OK;
}

export async function templateApprove(args: readonly string[], io: Io): Promise<number> {
  const [id, ...extra] = args;
  if (id === undefined || extra.length > 0) throw new UsageError('template approve takes one template id, such as morpho/vault-deposit.');
  const { confirm } = terminal(io, 'template approve');
  const home = kissSignHome(io.env);
  const { repo } = requireConfig(home);
  const origin = fetchOriginMain(io.repoRoot, repo);
  if (origin.kind !== 'fetched') {
    const problems = origin.kind === 'refused' ? origin.problems : [`could not fetch ${repo}`];
    io.stderr(`kiss-sign: nothing was approved:\n${problems.map((problem) => `  ${problem}\n`).join('')}`);
    return FAILED;
  }
  const { commit } = origin;
  let json: string;
  try {
    json = fileAt(io.repoRoot, commit, `${TEMPLATES_DIR}/${id}/template.json`);
  } catch {
    io.stderr(`kiss-sign: origin/main has no ${TEMPLATES_DIR}/${id}/template.json; a template counts only once it is merged.\n`);
    return FAILED;
  }
  const template = parseTemplate(JSON.parse(json), parseRegistry(JSON.parse(fileAt(io.repoRoot, commit, REGISTRY_PATH))));
  if (template.id !== id) throw new UsageError(`${TEMPLATES_DIR}/${id}/template.json names itself ${template.id}.`);
  const hash = keccakText(json);
  const A = LABELS.approve;
  const p = paint(io.color === true);
  io.stdout(
    text([
      p.heading(A.title(id)),
      ...rows([
        [A.repository, `${repo}, main`],
        [A.commit, commit],
        // JSON escapes any control character the subject carries, so it cannot steer the terminal.
        [A.subject, JSON.stringify(commitSubject(io.repoRoot, commit))],
        [A.file, `${TEMPLATES_DIR}/${id}/template.json`],
        [A.fingerprint, hash, p.heading],
      ]),
      ...wrap(A.why, WIDTH).map(p.dim),
      '',
      A.nothingByHand,
    ]),
  );
  if (!(await confirm(`Approve ${id} as merged in that commit? [y/N] `))) {
    io.stderr('Nothing approved.\n');
    return FAILED;
  }
  saveApproved(home, new Map([...loadApproved(home), [id, hash]]));
  io.stdout(`Approved ${id}.\n`);
  return OK;
}
