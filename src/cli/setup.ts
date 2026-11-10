import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadAddressBook, saveAddressBook } from '../address-book.ts';
import { parseCard, resolveCard, sealCard } from '../card.ts';
import type { Card, ResolvedValue } from '../card.ts';
import { ConfigError, loadApproved, loadConfig, saveApproved, saveConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { kissSignHome } from '../keys.ts';
import { REGISTRY_PATH, isEntryName, loadRegistry, parseRegistry } from '../registry.ts';
import { checksumAddress, parseAddress } from '../safe/types.ts';
import { TEMPLATES_DIR, loadTemplate, parseTemplate } from '../template/template.ts';
import { fetchOriginMain, fileAt } from '../verify/self-check.ts';
import { keccakText } from '../verify/verify.ts';
import { FAILED, OK, UsageError, terminal } from './io.ts';
import type { Io, Terminal } from './io.ts';

export function requireConfig(home: string): Config {
  const config = loadConfig(home);
  if (config === undefined) throw new ConfigError(`no config in ${home}; run kiss-sign init --safe <address> first`);
  return config;
}

export async function init(args: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { safe: { type: 'string' } }, strict: true });
  if (values.safe === undefined) throw new UsageError('init needs --safe <address>.');
  const safe = parseAddress('--safe', values.safe);
  const home = kissSignHome(io.env);
  const existing = loadConfig(home);
  if (existing !== undefined && existing.safe !== safe) {
    io.stderr(`kiss-sign: ${home} is already set up for another Safe. Remove its config.json to change it.\n`);
    return FAILED;
  }
  saveConfig(home, { chainId: 1n, safe });
  io.stdout(`kiss-sign checks transactions of the Safe ${checksumAddress(safe)} on Ethereum mainnet (chain 1).\n`);
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
  const replacing = old === undefined ? '' : ` (replacing ${checksumAddress(old)})`;
  io.stdout(`${name} -> ${checksumAddress(address)}${replacing}\nCheck every character against a source outside this chat.\n`);
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
  if (book.size === 0) io.stdout('The address book is empty.\n');
  for (const [name, address] of book) io.stdout(`${name} ${checksumAddress(address)}\n`);
  return OK;
}

function show(value: ResolvedValue): string {
  if (value.kind === 'amount' || value.kind === 'nonce') return `${value.value}`;
  if (value.kind === 'contract') return `${value.name} ${checksumAddress(value.entry.address)} (registry)`;
  return `${value.name} ${checksumAddress(value.address)} (${value.from})`;
}

export async function cardSeal(args: readonly string[], io: Io): Promise<number> {
  const [path, ...extra] = args;
  if (path === undefined || extra.length > 0) throw new UsageError('card seal takes the path of one card JSON file.');
  const { confirm } = terminal(io, 'card seal');
  return seal(parseCard(JSON.parse(readFileSync(path, 'utf8'))), io, confirm);
}

/** Resolves every name, shows the card with full addresses, and stores it under its hash once the signer says yes. */
export async function seal(card: Card, io: Io, confirm: Terminal['confirm']): Promise<number> {
  const home = kissSignHome(io.env);
  const { safe } = requireConfig(home);
  const registry = loadRegistry(io.repoRoot);
  const templates = new Map(card.operations.map((op) => [op.template, loadTemplate(io.repoRoot, op.template, registry)]));
  const resolution = resolveCard(card, { templates, registry, addressBook: loadAddressBook(home), safe });
  if (resolution.kind === 'refused') {
    io.stderr(`kiss-sign: card refused at ${resolution.at}: ${resolution.detail}\n`);
    return FAILED;
  }
  io.stdout(`Safe ${checksumAddress(safe)}\n`);
  for (const [i, op] of resolution.card.operations.entries()) {
    io.stdout(`operation ${i + 1}: ${op.template}\n`);
    for (const [name, value] of op.values) io.stdout(`  ${name}: ${show(value)}\n`);
  }
  if (!(await confirm('Is this what you mean to do? [y/N] '))) {
    io.stderr('Nothing sealed.\n');
    return FAILED;
  }
  io.stdout(`Sealed card ${sealCard(home, card)}\n`);
  return OK;
}

export async function templateApprove(args: readonly string[], io: Io): Promise<number> {
  const [id, ...extra] = args;
  if (id === undefined || extra.length > 0) throw new UsageError('template approve takes one template id, such as morpho/vault-deposit.');
  const { confirm } = terminal(io, 'template approve');
  const origin = fetchOriginMain(io.repoRoot);
  if (origin.kind !== 'fetched') {
    const problems = origin.kind === 'refused' ? origin.problems : ['could not fetch origin'];
    io.stderr(`kiss-sign: nothing was approved:\n${problems.map((problem) => `  ${problem}\n`).join('')}`);
    return FAILED;
  }
  const { commit } = origin;
  let text: string;
  try {
    text = fileAt(io.repoRoot, commit, `${TEMPLATES_DIR}/${id}/template.json`);
  } catch {
    io.stderr(`kiss-sign: origin/main has no ${TEMPLATES_DIR}/${id}/template.json; a template counts only once it is merged.\n`);
    return FAILED;
  }
  const template = parseTemplate(JSON.parse(text), parseRegistry(JSON.parse(fileAt(io.repoRoot, commit, REGISTRY_PATH))));
  if (template.id !== id) throw new UsageError(`${TEMPLATES_DIR}/${id}/template.json names itself ${template.id}.`);
  const hash = keccakText(text);
  io.stdout(`${id} at origin/main ${commit.slice(0, 12)} hashes to ${hash}\n`);
  if (!(await confirm('Approve this template as merged? [y/N] '))) {
    io.stderr('Nothing approved.\n');
    return FAILED;
  }
  const home = kissSignHome(io.env);
  saveApproved(home, new Map([...loadApproved(home), [id, hash]]));
  io.stdout(`Approved ${id}.\n`);
  return OK;
}
