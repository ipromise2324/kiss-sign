import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAddressBook } from '../address-book.ts';
import type { AddressBook } from '../address-book.ts';
import { CardError, marketLines, parseUint256 } from '../card.ts';
import type { CardOperation } from '../card.ts';
import { readDecimals, wholeTokens } from '../chain/decimals.ts';
import { openMainnetReader } from '../chain/reader.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { kissSignHome } from '../keys.ts';
import { isAttribute, isMarketEntryPart, loadRegistry } from '../registry.ts';
import type { Attribute, MarketPart, Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { TEMPLATES_DIR, loadTemplate, scopeEntries, slippageBps } from '../template/template.ts';
import type { CardField, CardRef, Computed, ComputedRead, Template, TokenRef } from '../template/template.ts';
import { gatesVaults, isRegistryVault, reportUnit, reportedVaultsIn, severalVaults } from '../template/vault-reports.ts';
import { FAILED, UsageError, terminal } from './io.ts';
import type { Io, Terminal } from './io.ts';
import { stopUnlessDataIsMain, requireConfig, seal } from './setup.ts';

/** A name a field may hold; a registry entry carries the factory that created it, so two vaults of one display name stay apart. */
type Choice = { readonly name: string; readonly address: Address; readonly from: 'registry' | 'address-book' | 'safe'; readonly factory?: RegistryEntry };

type Sources = { readonly registry: Registry; readonly book: AddressBook; readonly safe: Address };

type TypedField = Extract<CardField, { kind: 'amount' | 'nonce' | 'threshold' }>;
type ChosenField = Exclude<CardField, TypedField>;

/** The names a field may hold, as resolveCard accepts them. */
function choicesFor(field: Exclude<ChosenField, { kind: 'market' }>, { registry, book, safe }: Sources): readonly Choice[] {
  const listed = (e: RegistryEntry): Choice => {
    const factory = e.attributes.factory === undefined ? undefined : registry.entries.get(e.attributes.factory);
    return { name: e.name, address: e.address, from: 'registry', ...(factory === undefined ? {} : { factory }) };
  };
  const contracts = (): Choice[] => [...registry.entries.values()].map(listed);
  const self: Choice = { name: 'safe', address: safe, from: 'safe' };
  const booked = [...book].map(([name, address]): Choice => ({ name, address, from: 'address-book' }));
  switch (field.kind) {
    case 'contract':
      return scopeEntries(field.scope, registry).map(listed);
    case 'address':
      return [self, ...contracts(), ...booked];
    case 'recipient':
      return [self, ...booked];
    case 'owner':
      return booked;
  }
}

/** A name the signer can pick, the address or market id listed with it, and the lines that show what it names. */
type Option = { readonly name: string; readonly id: Hex | Address; readonly lines: readonly string[] };

function optionsFor(field: ChosenField, sources: Sources): readonly Option[] {
  if (field.kind === 'market') return [...sources.registry.markets.values()].map((market) => ({ name: market.name, id: market.id, lines: marketLines(market) }));
  return choicesFor(field, sources).map((c) => {
    const factory = c.factory === undefined ? '' : `  (factory ${c.factory.name} ${checksumAddress(c.factory.address)})`;
    return { name: c.name, id: c.address, lines: [`${c.name} ${checksumAddress(c.address)} (${c.from})${factory}`] };
  });
}

/** The choices a typed answer names: by its listed number, its exact name, or its full address or market id in any case. */
function picked(typed: string, choices: readonly Option[]): readonly Option[] {
  if (/^[1-9][0-9]{0,5}$/.test(typed)) return choices.slice(Number(typed) - 1, Number(typed));
  if (/^0x[0-9a-f]+$/i.test(typed)) return choices.filter((c) => c.id.toLowerCase() === typed.toLowerCase());
  return choices.filter((c) => c.name === typed);
}

/** What an amount counts: native ETH, a registry contract whose decimals() the chain answers, or a token outside the registry. */
type Unit =
  | { readonly kind: 'eth' }
  | { readonly kind: 'registry'; readonly entry: RegistryEntry }
  | { readonly kind: 'unregistered'; readonly ref: string };

/** The registry entry a chosen name, or the attribute or market part `attribute` names of it, is. */
function entryOf(chosen: string, attribute: Attribute | MarketPart | undefined, registry: Registry): RegistryEntry | undefined {
  if (attribute === undefined) return registry.entries.get(chosen);
  if (isMarketEntryPart(attribute)) return registry.markets.get(chosen)?.[attribute];
  const name = isAttribute(attribute) ? registry.entries.get(chosen)?.attributes[attribute] : undefined;
  return name === undefined ? undefined : registry.entries.get(name);
}

function unitOf(of: TokenRef, values: Readonly<Record<string, string>>, registry: Registry): Unit {
  if (of === 'eth') return { kind: 'eth' };
  const chosen = values[of.field];
  const entry = chosen === undefined ? undefined : entryOf(chosen, of.attribute, registry);
  if (entry === undefined) return { kind: 'unregistered', ref: `card.${of.field}${of.attribute === undefined ? '' : `.${of.attribute}`}` };
  return { kind: 'registry', entry };
}

const UINT256_LIMIT = 1n << 256n;

/** Every chain read of one card, through both providers at the one block they agree on. */
type Chain = {
  readonly decimals: (entry: RegistryEntry) => Promise<number>;
  /** One uint256 a view answers. */
  readonly call: (to: Address, data: Hex, what: string) => Promise<bigint>;
};

function openChain(reader: Reader | undefined, io: Io): Chain {
  let at: BlockRef | undefined;
  const agreedBlock = async (refuse: (why: string) => never): Promise<{ readonly reader: Reader; readonly at: BlockRef }> => {
    if (reader === undefined) throw new Error('no chain reader');
    if (at === undefined) {
      const latest = await reader.block('latest');
      at = latest.kind === 'agreed' ? latest.value : refuse(latest.reason);
    }
    return { reader, at };
  };
  const known = new Map<Address, number>();
  return {
    decimals: async (entry) => {
      const cached = known.get(entry.address);
      if (cached !== undefined) return cached;
      const token = `${entry.name} ${checksumAddress(entry.address)}`;
      const refuse = (why: string): never => {
        throw new CardError(`cannot read the decimals of ${token}: ${why}`);
      };
      const { reader: r, at: ref } = await agreedBlock(refuse);
      const decimals = await readDecimals(r, entry.address, ref);
      if (typeof decimals !== 'number') return refuse(decimals.problem);
      known.set(entry.address, decimals);
      io.stdout(`${token} has ${decimals} decimals: decimals() at block ${ref.number}, where ${r.providers.join(' and ')} agree\n`);
      return decimals;
    },
    call: async (to, data, what) => {
      const refuse = (why: string): never => {
        throw new CardError(`cannot read ${what}: ${why}`);
      };
      const { reader: r, at: ref } = await agreedBlock(refuse);
      const read = await r.call({ to, data }, ref);
      if (read.kind === 'unverifiable') return refuse(read.reason);
      if (read.value.kind === 'reverted') return refuse('it reverted');
      if (read.value.data.length !== 66) return refuse(`it answered ${(read.value.data.length - 2) / 2} bytes, not one word`);
      const value = BigInt(read.value.data);
      io.stdout(`  ${what} = ${value}: at block ${ref.number}, where ${r.providers.join(' and ')} agree\n`);
      return value;
    },
  };
}

/** Whole tokens in plain digits, or with commas between groups of exactly three digits before the point. */
const AMOUNT = /^(0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.([0-9]+))?$/;

function baseUnits(name: string, typed: string, decimals: number, token: string): bigint {
  const match = AMOUNT.exec(typed);
  const shown = JSON.stringify(typed.slice(0, 80));
  if (match === null) throw new CardError(`${name}: ${shown} is not a plain decimal number such as 5, 1.25 or 1,000,000.5`);
  const [, grouped = '', fraction = ''] = match;
  const whole = grouped.replaceAll(',', '');
  if (fraction.length > decimals) throw new CardError(`${name}: ${shown} has more than ${decimals} digits after the point, and ${token} has ${decimals} decimals`);
  const value = whole.length > 78 ? UINT256_LIMIT : BigInt(whole + fraction.padEnd(decimals, '0'));
  if (value >= UINT256_LIMIT) throw new CardError(`${name}: ${shown} is 2^256 base units or more`);
  return value;
}

async function answer(ask: Terminal['ask'], question: string): Promise<string> {
  return (await ask(question))?.trim() ?? '';
}

async function typedValue(name: string, field: TypedField, values: Readonly<Record<string, string>>, ctx: Context): Promise<string> {
  const unit = field.kind === 'amount' ? unitOf(field.of, values, ctx.sources.registry) : undefined;
  if (unit === undefined || unit.kind === 'unregistered') {
    const label = field.kind === 'threshold' ? 'how many owners must sign, a whole number from 1' : unit === undefined ? 'a Safe nonce' : `base units of ${unit.ref}, which is no registry contract, so its decimals are not read`;
    const typed = await answer(ctx.ask, `${name} (${label}): `);
    const parsed = parseUint256(typed);
    if (parsed === undefined || (field.kind === 'threshold' && parsed === 0n)) throw new CardError(`${name}: ${JSON.stringify(typed.slice(0, 80))} is not a whole number in plain digits${field.kind === 'threshold' ? ' from 1' : ''}`);
    return typed;
  }
  const token = unit.kind === 'eth' ? 'eth' : unit.entry.name;
  const decimals = unit.kind === 'eth' ? 18 : await ctx.chain.decimals(unit.entry);
  const full = unit.kind === 'eth' ? 'eth' : `${token} ${checksumAddress(unit.entry.address)}`;
  const value = baseUnits(name, await answer(ctx.ask, `${name} (${full}, ${decimals} decimals): `), decimals, token);
  return listed(name, value, decimals, token, ctx);
}

function listed(name: string, value: bigint, decimals: number, token: string, ctx: Context): string {
  const line = `${name}: ${wholeTokens(value, decimals)} ${token} = ${value} base units`;
  ctx.io.stdout(`  ${line}\n`);
  ctx.amounts.push(line);
  return value.toString();
}

const word = (value: bigint): string => value.toString(16).padStart(64, '0');

function entryAt(ref: CardRef, values: Readonly<Record<string, string>>, sources: Sources): RegistryEntry {
  const chosen = values[ref.field] as string;
  const entry = entryOf(chosen, ref.attribute, sources.registry);
  if (entry === undefined) throw new CardError(`${ref.field}: ${chosen} has no ${ref.attribute ?? 'registry entry'} to read`);
  return entry;
}

async function readValue(read: ComputedRead, values: Readonly<Record<string, string>>, ctx: Context): Promise<bigint> {
  const words: string[] = [];
  const shown: string[] = [];
  for (const arg of read.args) {
    if (arg.kind === 'safe') {
      words.push(word(BigInt(ctx.sources.safe)));
      shown.push('safe');
    } else if (arg.kind === 'read') {
      const inner = await readValue(arg.read, values, ctx);
      words.push(word(inner));
      shown.push(String(inner));
    } else if (ctx.template.card.get(arg.ref.field)?.kind === 'amount') {
      const amount = BigInt(values[arg.ref.field] as string);
      words.push(word(amount));
      shown.push(String(amount));
    } else {
      const entry = entryAt(arg.ref, values, ctx.sources);
      words.push(word(BigInt(entry.address)));
      shown.push(entry.name);
    }
  }
  const to = entryAt(read.to, values, ctx.sources);
  return ctx.chain.call(to.address, `${read.fn.selector}${words.join('')}` as Hex, `${read.fn.name}(${shown.join(', ')}) on ${to.name} ${checksumAddress(to.address)}`);
}

const percent = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

async function computedValue(name: string, field: TypedField & { readonly kind: 'amount' }, computed: Computed, values: Readonly<Record<string, string>>, ctx: Context): Promise<string> {
  const unit = unitOf(field.of, values, ctx.sources.registry);
  if (unit.kind === 'unregistered') throw new CardError(`${name}: counts ${unit.ref}, which is no registry contract, so it cannot be computed in whole tokens`);
  const token = unit.kind === 'eth' ? 'eth' : unit.entry.name;
  const decimals = unit.kind === 'eth' ? 18 : await ctx.chain.decimals(unit.entry);
  ctx.io.stdout(`${name} is not asked: the protocol's app fills it in itself, so it is computed\n`);
  const read = await readValue(computed.read, values, ctx);
  const total = BigInt(slippageBps(computed));
  const value = computed.bound === 'floor' ? (read * (10_000n - total)) / 10_000n : (read * (10_000n + total) + 9_999n) / 10_000n;
  ctx.io.stdout(`  expected: ${wholeTokens(read, decimals)} ${token} = ${read} base units\n`);
  const margin = computed.margin === undefined ? '' : ` plus a margin of ${percent(computed.margin.bps)}`;
  ctx.io.stdout(`  slippage: ${percent(Number(total))}, ${computed.bound === 'floor' ? 'less' : 'more'} than expected: the protocol's default ${percent(computed.default.bps)} (${computed.default.source})${margin}\n`);
  if (computed.margin !== undefined) ctx.io.stdout(`  margin, as the template says: ${computed.margin.why}\n`);
  if (value === 0n) throw new CardError(`${name} comes to 0, which would bound nothing or nothing could meet`);
  if (value >= UINT256_LIMIT) throw new CardError(`${name} comes to 2^256 base units or more`);
  return listed(name, value, decimals, token, ctx);
}

type Context = {
  readonly template: Template;
  readonly sources: Sources;
  readonly io: Io;
  readonly ask: Terminal['ask'];
  readonly chain: Chain;
  readonly amounts: string[];
  /** The vaults with a report for a template reported per vault. */
  readonly reported: (template: string) => ReadonlySet<string>;
};

const isTyped = (entry: [string, CardField]): entry is [string, TypedField] => entry[1].kind === 'amount' || entry[1].kind === 'nonce' || entry[1].kind === 'threshold';
const isChosen = (entry: [string, CardField]): entry is [string, ChosenField] => !isTyped(entry);

/**
 * Every choice comes before every typed number, so the token an amount counts is known when it is asked, and every typed
 * number before every computed one, in card order, so a computed field may read any value but a later computed one.
 */
async function fill(template: Template, shared: Omit<Context, 'template'>): Promise<CardOperation> {
  const ctx: Context = { ...shared, template };
  const values: Record<string, string> = {};
  const fields = [...template.card];
  const unit = reportUnit(template);
  if (unit.kind === 'several-vaults') throw new CardError(severalVaults(template.id));
  for (const [name, field] of fields.filter(isChosen)) {
    const listed = optionsFor(field, ctx.sources);
    const gated = gatesVaults(template) && field.kind !== 'market';
    const choices = gated ? listed.filter((choice) => !isRegistryVault(choice.name, ctx.sources.registry) || ctx.reported(template.id).has(choice.name)) : listed;
    if (unit.kind === 'vault' && unit.field === name && choices.length === 0) throw new CardError(`${name}: no vault has a report for ${template.id}; build one first`);
    if (choices.length === 0) {
      throw new CardError(`${name}: ${field.kind === 'market' ? 'registry/markets.json holds no market' : `the registry and address book hold nothing ${template.id} accepts here`}`);
    }
    ctx.io.stdout(`${name}:\n`);
    for (const [i, { lines: [first, ...rest] }] of choices.entries()) {
      ctx.io.stdout(`  ${i + 1}. ${first}\n`);
      for (const line of rest) ctx.io.stdout(`       ${line}\n`);
    }
    const range = `1-${choices.length}`;
    const typed = await answer(ctx.ask, `${name}: type its number (${range}): `);
    const [choice, ...others] = picked(typed, choices);
    const shown = JSON.stringify(typed.slice(0, 80));
    if (choice === undefined) throw new CardError(`${name}: ${shown} is none of the listed choices; type the number in front of the one you mean (${range})`);
    if (others.length > 0) throw new CardError(`${name}: ${shown} matches more than one listed choice; type the number in front of the one you mean (${range})`);
    values[name] = choice.name;
  }
  for (const [name, field] of fields.filter(isTyped)) if (!isComputed(field)) values[name] = await typedValue(name, field, values, ctx);
  for (const [name, field] of fields.filter(isTyped)) if (isComputed(field)) values[name] = await computedValue(name, field, field.computed, values, ctx);
  return { template: template.id, values: Object.fromEntries(fields.map(([name]) => [name, values[name] as string])) };
}

const isComputed = (field: CardField): field is Extract<CardField, { kind: 'amount' }> & { readonly computed: Computed } => field.kind === 'amount' && field.computed !== undefined;

const readsChain = (template: Template): boolean => [...template.card.values()].some((f) => f.kind === 'amount' && (f.of !== 'eth' || f.computed !== undefined));

export async function cardNew(args: readonly string[], io: Io): Promise<number> {
  if (args.length === 0) throw new UsageError('card new takes one or more template ids, such as morpho/vault-deposit.');
  const { ask, confirm } = terminal(io, 'card new');
  if (!stopUnlessDataIsMain(io)) return FAILED;
  const home = kissSignHome(io.env);
  const sources: Sources = { registry: loadRegistry(io.repoRoot), book: loadAddressBook(home), safe: requireConfig(home).safe };
  const templates = args.map((id) => {
    if (!existsSync(join(io.repoRoot, TEMPLATES_DIR, id, 'template.json'))) throw new CardError(`no template ${id} in ${TEMPLATES_DIR}/`);
    return loadTemplate(io.repoRoot, id, sources.registry);
  });
  const reader = templates.some(readsChain) ? openMainnetReader(io.env, io.transport) : undefined;
  const ctx = { sources, io, ask, chain: openChain(reader, io), amounts: [] as string[], reported: (id: string) => reportedVaultsIn(io.repoRoot, id) };
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
