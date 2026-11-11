import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAddressBook } from '../address-book.ts';
import type { AddressBook } from '../address-book.ts';
import { CardError, parseUint256 } from '../card.ts';
import type { CardOperation } from '../card.ts';
import { openMainnetReader } from '../chain/reader.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { kissSignHome } from '../keys.ts';
import { loadRegistry } from '../registry.ts';
import type { ContractKind, Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { TEMPLATES_DIR, loadTemplate } from '../template/template.ts';
import type { CardField, Template, TokenRef } from '../template/template.ts';
import { UsageError, terminal } from './io.ts';
import type { Io, Terminal } from './io.ts';
import { requireConfig, seal } from './setup.ts';

type Choice = { readonly name: string; readonly address: Address; readonly from: 'registry' | 'address-book' | 'safe' };

type Sources = { readonly registry: Registry; readonly book: AddressBook; readonly safe: Address };

type TypedField = Extract<CardField, { kind: 'amount' | 'nonce' }>;
type ChosenField = Exclude<CardField, TypedField>;

/** The names a field may hold, as resolveCard accepts them. */
function choicesFor(field: ChosenField, { registry, book, safe }: Sources): readonly Choice[] {
  const contracts = (kind?: ContractKind): Choice[] =>
    [...registry.entries.values()].filter((e) => kind === undefined || e.kind === kind).map((e) => ({ name: e.name, address: e.address, from: 'registry' }));
  const self: Choice = { name: 'safe', address: safe, from: 'safe' };
  const booked = [...book].map(([name, address]): Choice => ({ name, address, from: 'address-book' }));
  switch (field.kind) {
    case 'contract':
      return contracts(field.registryKind);
    case 'address':
      return [self, ...contracts(), ...booked];
    case 'recipient':
      return [self, ...booked];
  }
}

/** What an amount counts: native ETH, a registry contract whose decimals() the chain answers, or a token outside the registry. */
type Unit =
  | { readonly kind: 'eth' }
  | { readonly kind: 'registry'; readonly entry: RegistryEntry }
  | { readonly kind: 'unregistered'; readonly ref: string };

function unitOf(of: TokenRef, values: Readonly<Record<string, string>>, registry: Registry): Unit {
  if (of === 'eth') return { kind: 'eth' };
  const chosen = values[of.field];
  const name = chosen === undefined || of.attribute === undefined ? chosen : registry.entries.get(chosen)?.attributes[of.attribute];
  const entry = name === undefined ? undefined : registry.entries.get(name);
  if (entry === undefined) return { kind: 'unregistered', ref: `card.${of.field}${of.attribute === undefined ? '' : `.${of.attribute}`}` };
  return { kind: 'registry', entry };
}

const DECIMALS = '0x313ce567' as Hex;
const MAX_DECIMALS = 77;
const UINT256_LIMIT = 1n << 256n;

type TokenDecimals = (entry: RegistryEntry) => Promise<number>;

/** decimals() of each token, read once through both providers at one block they agree on. */
function chainDecimals(reader: Reader | undefined, io: Io): TokenDecimals {
  let at: BlockRef | undefined;
  const known = new Map<Address, number>();
  return async (entry) => {
    const cached = known.get(entry.address);
    if (cached !== undefined) return cached;
    const token = `${entry.name} ${checksumAddress(entry.address)}`;
    if (reader === undefined) throw new Error(`no chain reader for ${token}`);
    const refuse = (why: string): never => {
      throw new CardError(`cannot read the decimals of ${token}: ${why}`);
    };
    if (at === undefined) {
      const block = await reader.block('latest');
      at = block.kind === 'agreed' ? block.value : refuse(block.reason);
    }
    const read = await reader.call({ to: entry.address, data: DECIMALS }, at);
    if (read.kind === 'unverifiable') return refuse(read.reason);
    if (read.value.kind === 'reverted') return refuse('decimals() reverted');
    if (read.value.data.length !== 66) return refuse(`decimals() answered ${(read.value.data.length - 2) / 2} bytes, not one word`);
    const decimals = BigInt(read.value.data);
    if (decimals > BigInt(MAX_DECIMALS)) return refuse(`decimals() answered ${decimals}`);
    known.set(entry.address, Number(decimals));
    io.stdout(`${token} has ${decimals} decimals: decimals() at block ${at.number}, where ${reader.providers.join(' and ')} agree\n`);
    return Number(decimals);
  };
}

const AMOUNT = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function baseUnits(name: string, typed: string, decimals: number, token: string): bigint {
  const match = AMOUNT.exec(typed);
  const shown = JSON.stringify(typed.slice(0, 80));
  if (match === null) throw new CardError(`${name}: ${shown} is not a plain decimal number such as 5 or 1.25`);
  const [, whole = '', fraction = ''] = match;
  if (fraction.length > decimals) throw new CardError(`${name}: ${shown} has more than ${decimals} digits after the point, and ${token} has ${decimals} decimals`);
  const value = whole.length > 78 ? UINT256_LIMIT : BigInt(whole + fraction.padEnd(decimals, '0'));
  if (value >= UINT256_LIMIT) throw new CardError(`${name}: ${shown} is 2^256 base units or more`);
  return value;
}

function human(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / scale}${fraction === '' ? '' : `.${fraction}`}`;
}

async function answer(ask: Terminal['ask'], question: string): Promise<string> {
  return (await ask(question))?.trim() ?? '';
}

async function typedValue(name: string, field: TypedField, values: Readonly<Record<string, string>>, ctx: Context): Promise<string> {
  const unit = field.kind === 'amount' ? unitOf(field.of, values, ctx.sources.registry) : undefined;
  if (unit === undefined || unit.kind === 'unregistered') {
    const label = unit === undefined ? 'a Safe nonce' : `base units of ${unit.ref}, which is no registry contract, so its decimals are not read`;
    const typed = await answer(ctx.ask, `${name} (${label}): `);
    if (parseUint256(typed) === undefined) throw new CardError(`${name}: ${JSON.stringify(typed.slice(0, 80))} is not a whole number in plain digits`);
    return typed;
  }
  const token = unit.kind === 'eth' ? 'eth' : unit.entry.name;
  const decimals = unit.kind === 'eth' ? 18 : await ctx.decimals(unit.entry);
  const full = unit.kind === 'eth' ? 'eth' : `${token} ${checksumAddress(unit.entry.address)}`;
  const value = baseUnits(name, await answer(ctx.ask, `${name} (${full}, ${decimals} decimals): `), decimals, token);
  const line = `${name}: ${human(value, decimals)} ${token} = ${value} base units`;
  ctx.io.stdout(`  ${line}\n`);
  ctx.amounts.push(line);
  return value.toString();
}

type Context = { readonly sources: Sources; readonly io: Io; readonly ask: Terminal['ask']; readonly decimals: TokenDecimals; readonly amounts: string[] };

const isTyped = (entry: [string, CardField]): entry is [string, TypedField] => entry[1].kind === 'amount' || entry[1].kind === 'nonce';
const isChosen = (entry: [string, CardField]): entry is [string, ChosenField] => !isTyped(entry);

/** Every choice comes before every typed number, so the token an amount counts is known when it is asked. */
async function fill(template: Template, ctx: Context): Promise<CardOperation> {
  const values: Record<string, string> = {};
  const fields = [...template.card];
  for (const [name, field] of fields.filter(isChosen)) {
    const choices = choicesFor(field, ctx.sources);
    if (choices.length === 0) throw new CardError(`${name}: the registry and address book hold nothing ${template.id} accepts here`);
    ctx.io.stdout(`${name}:\n`);
    for (const [i, c] of choices.entries()) ctx.io.stdout(`  ${i + 1}. ${c.name} ${checksumAddress(c.address)} (${c.from})\n`);
    const typed = await answer(ctx.ask, `${name} [1-${choices.length}]: `);
    const choice = /^[1-9][0-9]{0,5}$/.test(typed) ? choices[Number(typed) - 1] : undefined;
    if (choice === undefined) throw new CardError(`${name}: ${JSON.stringify(typed.slice(0, 80))} is not a number from 1 to ${choices.length}`);
    values[name] = choice.name;
  }
  for (const [name, field] of fields.filter(isTyped)) values[name] = await typedValue(name, field, values, ctx);
  return { template: template.id, values };
}

const countsRegistryToken = (template: Template): boolean => [...template.card.values()].some((f) => f.kind === 'amount' && f.of !== 'eth');

export async function cardNew(args: readonly string[], io: Io): Promise<number> {
  if (args.length === 0) throw new UsageError('card new takes one or more template ids, such as morpho/vault-deposit.');
  const { ask, confirm } = terminal(io, 'card new');
  const home = kissSignHome(io.env);
  const sources: Sources = { registry: loadRegistry(io.repoRoot), book: loadAddressBook(home), safe: requireConfig(home).safe };
  const templates = args.map((id) => {
    if (!existsSync(join(io.repoRoot, TEMPLATES_DIR, id, 'template.json'))) throw new CardError(`no template ${id} in ${TEMPLATES_DIR}/`);
    return loadTemplate(io.repoRoot, id, sources.registry);
  });
  const reader = templates.some(countsRegistryToken) ? openMainnetReader(io.env, io.transport) : undefined;
  const ctx: Context = { sources, io, ask, decimals: chainDecimals(reader, io), amounts: [] };
  const operations: CardOperation[] = [];
  for (const [i, template] of templates.entries()) {
    io.stdout(`operation ${i + 1}: ${template.id}\n`);
    const before = ctx.amounts.length;
    operations.push(await fill(template, ctx));
    if (templates.length > 1) ctx.amounts.splice(before, Infinity, ...ctx.amounts.slice(before).map((line) => `operation ${i + 1} ${line}`));
  }
  io.stdout('\n');
  if (ctx.amounts.length > 0) io.stdout(`amounts in whole tokens:\n${ctx.amounts.map((line) => `  ${line}\n`).join('')}\n`);
  return seal({ operations }, io, confirm);
}
