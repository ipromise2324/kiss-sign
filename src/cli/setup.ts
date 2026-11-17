import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadAddressBook, saveAddressBook } from '../address-book.ts';
import { parseCard, resolveCard, sealCard } from '../card.ts';
import type { Card } from '../card.ts';
import { ConfigError, loadApproved, loadConfig, loadStoredConfig, saveApproved, saveConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { DEFAULT_LANGUAGE, LANGUAGES, isLanguage } from '../language.ts';
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
import type { Labels } from './labels.ts';
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

export async function init(args: readonly string[], io: Io, w: Labels): Promise<number> {
  const I = w.init;
  const { values } = parseArgs({ args: [...args], options: { safe: { type: 'string' }, language: { type: 'string' } }, strict: true });
  if (values.language !== undefined && !isLanguage(values.language)) throw new UsageError(I.languageFlag(LANGUAGES.join(' or ')));
  const home = kissSignHome(io.env);
  const existing = loadStoredConfig(home);
  const safe = values.safe !== undefined ? parseAddress('--safe', values.safe) : existing?.safe;
  if (safe === undefined) throw new UsageError(I.needsSafe);
  const origin = originRepo(io.repoRoot);
  if (origin.kind === 'refused') {
    io.stderr(`kiss-sign: ${I.notFork}\n${origin.problems.map((problem) => `  ${problem}\n`).join('')}`);
    return FAILED;
  }
  const { repo } = origin;
  if (existing !== undefined && existing.safe !== safe) {
    io.stderr(`kiss-sign: ${I.otherSafe(home)}\n`);
    return FAILED;
  }
  if (existing?.repo !== undefined && existing.repo !== repo) {
    io.stderr(`kiss-sign: ${I.otherRepo(home, existing.repo)}\n`);
    return FAILED;
  }
  const language = values.language ?? existing?.language ?? DEFAULT_LANGUAGE;
  saveConfig(home, { chainId: 1n, safe, repo, language });
  const keyFile = keyFilePath(home);
  const created = createKeyFile(home);
  const mode = statSync(keyFile).mode & 0o777;
  const p = paint(io.color === true);
  const lines = [
    p.heading(I.title),
    ...rows([
      [I.safe, [checksumAddress(safe), I.chain]],
      [I.repository, [repo, I.trust]],
      [I.language, [I.languageUse(I.languageName[language], language), I.languageChange(`pnpm kiss-sign init --language ${LANGUAGES.join('|')}`)]],
      [I.keyFile, [keyFile, created ? I.created : I.kept]],
    ]),
    ...((mode & 0o077) === 0 ? [] : [p.warn(I.readable(keyFile, mode.toString(8), `chmod 600 ${shellWord(keyFile)}`))]),
    '',
    p.heading(I.keys),
    ...rows(KEYS.map((spec) => [spec.env, [`${I.getIt} ${spec.signup}`, `${I.neededBy} ${I.usedBy[spec.name]}`]])),
    '',
    p.heading(I.next),
    I.openKeyFile,
    `       ${openCommand(io.platform, keyFile)}`,
    I.orKeyAdd,
    ...KEYS.map(({ name }) => `       pnpm kiss-sign key add ${name}`),
    I.seeKeys,
    '       pnpm kiss-sign key list',
  ];
  io.stdout(lines.map((line) => `${line}\n`).join(''));
  return OK;
}

export async function bookAdd(args: readonly string[], io: Io, w: Labels): Promise<number> {
  const B = w.book;
  const [name, raw, ...extra] = args;
  if (name === undefined || raw === undefined || extra.length > 0) throw new UsageError(B.addUsage);
  if (!isEntryName(name)) throw new UsageError(B.notName(JSON.stringify(name.slice(0, 64))));
  const address = parseAddress('address', raw);
  const { confirm } = terminal(io, 'book add', w);
  if (loadRegistry(io.repoRoot).entries.has(name)) throw new UsageError(B.inRegistry(name));
  const home = kissSignHome(io.env);
  const book = loadAddressBook(home);
  const old = book.get(name);
  if (old === address) {
    io.stdout(`${B.already(name, checksumAddress(address))}\n`);
    return OK;
  }
  const p = paint(io.color === true);
  io.stdout(
    text([
      ...rows([[B.name, p.picked(name)], [B.address, p.picked(checksumAddress(address))], ...(old === undefined ? [] : [[B.replacing, checksumAddress(old)] as const])]),
      B.check,
    ]),
  );
  if (!(await confirm(B.confirm))) {
    io.stderr(`${B.nothingAdded}\n`);
    return FAILED;
  }
  saveAddressBook(home, new Map([...book, [name, address]]));
  io.stdout(`${B.added(name)}\n`);
  return OK;
}

export function bookList(args: readonly string[], io: Io, w: Labels): number {
  if (args.length > 0) throw new UsageError(w.book.listUsage);
  const book = loadAddressBook(kissSignHome(io.env));
  if (book.size === 0) io.stdout(`${w.book.empty}\n`);
  else io.stdout(text(rows([...book].map(([name, address]) => [name, checksumAddress(address)]), 0)));
  return OK;
}

/**
 * `card new` and `card seal` read the templates and the registry from the clone. Stops, printing why, unless they are
 * main of the configured repository as GitHub has it now, since a merge on GitHub changes nothing here until a pull.
 */
export function stopUnlessDataIsMain(io: Io, w: Labels): boolean {
  const { repo } = requireConfig(kissSignHome(io.env));
  const data = dataDiffersFromOriginMain(io.repoRoot, repo, [TEMPLATES_DIR, REGISTRY_DIR]);
  if (data.kind === 'current') return true;
  const dirs = w.card.and(`${TEMPLATES_DIR}/`, `${REGISTRY_DIR}/`);
  const why = data.kind === 'differs' ? w.card.behindMain(dirs, repo) : w.card.mainUnknown(dirs, repo);
  io.stderr(`kiss-sign: ${why}\n${data.problems.map((p) => `  ${p}\n`).join('')}`);
  return false;
}

export async function cardSeal(args: readonly string[], io: Io, w: Labels): Promise<number> {
  const [path, ...extra] = args;
  if (path === undefined || extra.length > 0) throw new UsageError(w.card.sealUsage);
  const { confirm } = terminal(io, 'card seal', w);
  if (!stopUnlessDataIsMain(io, w)) return FAILED;
  return seal(parseCard(JSON.parse(readFileSync(path, 'utf8'))), io, w, confirm);
}

/** Resolves every name, shows the card with full addresses, and stores it under its hash once the signer says yes. */
export async function seal(card: Card, io: Io, w: Labels, confirm: Terminal['confirm'], reads?: CardReads): Promise<number> {
  const L = w.card;
  const home = kissSignHome(io.env);
  const { safe } = requireConfig(home);
  const registry = loadRegistry(io.repoRoot);
  const templates = new Map(card.operations.map((op) => [op.template, loadTemplate(io.repoRoot, op.template, registry)]));
  const resolution = resolveCard(card, { templates, registry, addressBook: loadAddressBook(home), safe });
  if (resolution.kind === 'refused') {
    io.stderr(`kiss-sign: ${L.refusedAt(resolution.at, resolution.detail)}\n`);
    return FAILED;
  }
  const unreported = unreportedVault(resolution.card, templates, registry, (id) => reportedVaultsIn(io.repoRoot, id));
  if (unreported !== undefined) {
    io.stderr(`kiss-sign: ${L.refused(unreported)}\n`);
    return FAILED;
  }
  io.stdout(text(cardSummary(resolution.card, templates, registry, reads, paint(io.color === true), L)));
  if (!(await confirm(L.confirm))) {
    io.stderr(`${L.nothingSealed}\n`);
    return FAILED;
  }
  io.stdout(`${L.sealed(sealCard(home, card))}\n`);
  return OK;
}

export async function templateApprove(args: readonly string[], io: Io, w: Labels): Promise<number> {
  const A = w.approve;
  const [id, ...extra] = args;
  if (id === undefined || extra.length > 0) throw new UsageError(A.usage);
  const { confirm } = terminal(io, 'template approve', w);
  const home = kissSignHome(io.env);
  const { repo } = requireConfig(home);
  const origin = fetchOriginMain(io.repoRoot, repo);
  if (origin.kind !== 'fetched') {
    const problems = origin.kind === 'refused' ? origin.problems : [A.noFetch(repo)];
    io.stderr(`kiss-sign: ${A.refused}\n${problems.map((problem) => `  ${problem}\n`).join('')}`);
    return FAILED;
  }
  const { commit } = origin;
  let json: string;
  try {
    json = fileAt(io.repoRoot, commit, `${TEMPLATES_DIR}/${id}/template.json`);
  } catch {
    io.stderr(`kiss-sign: ${A.notMerged(`${TEMPLATES_DIR}/${id}/template.json`)}\n`);
    return FAILED;
  }
  const template = parseTemplate(JSON.parse(json), parseRegistry(JSON.parse(fileAt(io.repoRoot, commit, REGISTRY_PATH))));
  if (template.id !== id) throw new UsageError(A.namesItself(`${TEMPLATES_DIR}/${id}/template.json`, template.id));
  const hash = keccakText(json);
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
  if (!(await confirm(A.confirm(id)))) {
    io.stderr(`${A.nothingApproved}\n`);
    return FAILED;
  }
  saveApproved(home, new Map([...loadApproved(home), [id, hash]]));
  io.stdout(`${A.approved(id)}\n`);
  return OK;
}
