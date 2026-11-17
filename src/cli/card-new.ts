import { existsSync } from 'node:fs';
import { say } from '../language.ts';
import type { Language } from '../language.ts';
import { join } from 'node:path';
import { loadAddressBook } from '../address-book.ts';
import type { AddressBook } from '../address-book.ts';
import { CardError, parseUint256 } from '../card.ts';
import type { CardOperation } from '../card.ts';
import { groupedTokens, readDecimals } from '../chain/decimals.ts';
import { openMainnetReader } from '../chain/reader.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { kissSignHome } from '../keys.ts';
import { isAttribute, isMarketEntryPart, loadRegistry } from '../registry.ts';
import type { Attribute, Market, MarketPart, Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { TEMPLATES_DIR, loadTemplate, scopeEntries, slippageBps, WAD } from '../template/template.ts';
import type { CardField, CardRef, Computed, ComputedRead, Template, TokenRef } from '../template/template.ts';
import { gatesVaults, isRegistryVault, reportUnit, reportedVaultsIn, severalVaults } from '../template/vault-reports.ts';
import { marketHead, marketTable } from './card-view.ts';
import { paint, rows, section, table, text } from './format.ts';
import type { Paint, Row } from './format.ts';
import { FAILED, UsageError, terminal } from './io.ts';
import type { Labels } from './labels.ts';
import type { Io, Terminal } from './io.ts';
import { stopUnlessDataIsMain, requireConfig, seal } from './setup.ts';

/** A name a field may hold; a registry entry carries the factory that created it, so two vaults of one display name stay apart. */
type Choice = { readonly name: string; readonly address: Address; readonly from: 'registry' | 'address-book' | 'safe'; readonly factory?: RegistryEntry };

type Sources = { readonly registry: Registry; readonly book: AddressBook; readonly safe: Address };

type TypedField = Extract<CardField, { kind: 'amount' | 'nonce' | 'threshold' | 'percent' }>;
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

/** A name the signer can pick, with the address or market id it may also be picked by. */
type Option = (Choice & { readonly id: Address }) | { readonly name: string; readonly id: Hex; readonly market: Market };

type CardWords = Labels['card'];

function optionsFor(field: ChosenField, sources: Sources): readonly Option[] {
  if (field.kind === 'market') return [...sources.registry.markets.values()].map((market) => ({ name: market.name, id: market.id, market }));
  return choicesFor(field, sources).map((c) => ({ ...c, id: c.address }));
}

/**
 * The numbered list: names and full addresses in columns, each factory once below it, and a factory or source column
 * only when the listed choices differ in it.
 */
function listLines(options: readonly Option[], p: Paint, L: CardWords): string[] {
  const markets = options.flatMap((o) => ('market' in o ? [o.market] : []));
  if (markets.length > 0) return markets.flatMap((market, i) => [`${`${i + 1}.`.padStart(4)}  ${marketHead(market, L)}`, ...marketTable(market, L, 6)]);
  const choices = options.flatMap((o) => ('market' in o ? [] : [o]));
  const factories = [...new Map(choices.flatMap((c) => (c.factory === undefined ? [] : [[c.factory.address, c.factory] as const]))).values()];
  const factoryColumn = factories.length > 1 || (factories.length === 1 && choices.some((c) => c.factory === undefined));
  const sourceColumn = new Set(choices.map((c) => c.from)).size > 1;
  const cells = choices.map((c, i) => [
    `${i + 1}.`.padStart(4),
    c.name,
    ...(factoryColumn ? [c.factory?.name ?? ''] : []),
    ...(sourceColumn ? [p.dim(L.from[c.from])] : []),
    checksumAddress(c.address),
  ]);
  const made = factories.map((f): Row => [factoryColumn ? L.factory : L.createdBy(choices.length), `${f.name}  ${checksumAddress(f.address)}`]);
  return [...table(cells, 0), ...rows(made, 6)];
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
  readonly call: (to: RegistryEntry, data: Hex, call: string) => Promise<bigint>;
  /** Each token's decimals read so far. */
  readonly known: ReadonlyMap<Address, number>;
  /** The block every read was made at and the providers that agreed, once anything was read. */
  readonly provenance: () => string | undefined;
};

function openChain(reader: Reader | undefined, L: CardWords): Chain {
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
    known,
    provenance: () => (at === undefined || reader === undefined ? undefined : L.chainReads(at.number, reader.providers)),
    decimals: async (entry) => {
      const cached = known.get(entry.address);
      if (cached !== undefined) return cached;
      const refuse = (why: string): never => {
        throw new CardError(L.noDecimalsRead(entry.name, checksumAddress(entry.address), why));
      };
      const { reader: r, at: ref } = await agreedBlock(refuse);
      const decimals = await readDecimals(r, entry.address, ref);
      if (typeof decimals !== 'number') return refuse(decimals.problem);
      known.set(entry.address, decimals);
      return decimals;
    },
    call: async (to, data, call) => {
      const refuse = (why: string): never => {
        throw new CardError(L.noRead(call, to.name, checksumAddress(to.address), why));
      };
      const { reader: r, at: ref } = await agreedBlock(refuse);
      const read = await r.call({ to: to.address, data }, ref);
      if (read.kind === 'unverifiable') return refuse(read.reason);
      if (read.value.kind === 'reverted') return refuse(L.reverted);
      if (read.value.data.length !== 66) return refuse(L.notOneWord((read.value.data.length - 2) / 2));
      return BigInt(read.value.data);
    },
  };
}

/** Whole tokens in plain digits, or with commas between groups of exactly three digits before the point. */
const AMOUNT = /^(0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.([0-9]+))?$/;

function baseUnits(name: string, typed: string, decimals: number, token: string, L: CardWords): bigint {
  const match = AMOUNT.exec(typed);
  const shown = JSON.stringify(typed.slice(0, 80));
  if (match === null) throw new CardError(L.notDecimal(name, shown));
  const [, grouped = '', fraction = ''] = match;
  const whole = grouped.replaceAll(',', '');
  if (fraction.length > decimals) throw new CardError(L.tooManyDigits(name, shown, decimals, token));
  const value = whole.length > 78 ? UINT256_LIMIT : BigInt(whole + fraction.padEnd(decimals, '0'));
  if (value >= UINT256_LIMIT) throw new CardError(L.tooLarge(name, shown));
  return value;
}

async function answer(ask: Terminal['ask'], question: string): Promise<string> {
  return (await ask(question))?.trim() ?? '';
}

/** A percent in plain digits, at most 100 with at most 16 decimals, in WAD base units: 100% is 10^18. */
const PERCENT = /^(0|[1-9][0-9]{0,2})(?:\.([0-9]{1,16}))?$/;

function percentValue(name: string, typed: string, L: CardWords): string {
  const match = PERCENT.exec(typed);
  const shown = JSON.stringify(typed.slice(0, 80));
  if (match === null) throw new CardError(L.notPercent(name, shown));
  const [, whole = '', fraction = ''] = match;
  const value = BigInt(whole + fraction.padEnd(16, '0'));
  if (value > WAD) throw new CardError(L.overHundred(name, shown));
  return value.toString();
}

async function typedValue(name: string, field: TypedField, values: Readonly<Record<string, string>>, ctx: Context): Promise<string> {
  const { io, p, L } = ctx;
  io.stdout(text(section(p, name, L.type)));
  if (field.kind === 'percent') return percentValue(name, await answer(ctx.ask, L.askPercent(name)), L);
  const unit = field.kind === 'amount' ? unitOf(field.of, values, ctx.sources.registry) : undefined;
  if (unit === undefined || unit.kind === 'unregistered') {
    const question = field.kind === 'threshold' ? L.askThreshold(name) : unit === undefined ? L.askNonce(name) : L.askBaseUnits(name, unit.ref);
    const typed = await answer(ctx.ask, question);
    const parsed = parseUint256(typed);
    if (parsed === undefined || (field.kind === 'threshold' && parsed === 0n)) throw new CardError(L.notWhole(name, JSON.stringify(typed.slice(0, 80)), field.kind === 'threshold'));
    return typed;
  }
  const token = unit.kind === 'eth' ? 'ETH' : unit.entry.name;
  const decimals = unit.kind === 'eth' ? 18 : await ctx.chain.decimals(unit.entry);
  io.stdout(text(rows([[L.token, unit.kind === 'eth' ? L.eth : `${token}  ${checksumAddress(unit.entry.address)}  ${L.decimals(decimals)}`]], 4)));
  const max = field.kind === 'amount' ? field.max : undefined;
  const typed = await answer(ctx.ask, L.askAmount(name, token, decimals, max !== undefined));
  if (max !== undefined && typed === 'max') {
    io.stdout(text(rows([[L.max, say(max.why, ctx.language), p.dim]], 4)));
    return max.value.toString();
  }
  return baseUnits(name, typed, decimals, token, L).toString();
}

const word = (value: bigint): string => value.toString(16).padStart(64, '0');

function entryAt(ref: CardRef, values: Readonly<Record<string, string>>, sources: Sources, L: CardWords): RegistryEntry {
  const chosen = values[ref.field] as string;
  const entry = entryOf(chosen, ref.attribute, sources.registry);
  if (entry === undefined) throw new CardError(L.nothingToRead(ref.field, chosen, ref.attribute));
  return entry;
}

/** One view call `card new` made: what it called, on which contract, and its answer. */
type Step = { readonly call: string; readonly on: RegistryEntry; readonly value: bigint };

async function readValue(read: ComputedRead, values: Readonly<Record<string, string>>, ctx: Context, steps: Step[]): Promise<bigint> {
  const words: string[] = [];
  const shown: string[] = [];
  for (const arg of read.args) {
    if (arg.kind === 'safe') {
      words.push(word(BigInt(ctx.sources.safe)));
      shown.push('safe');
    } else if (arg.kind === 'read') {
      const inner = await readValue(arg.read, values, ctx, steps);
      words.push(word(inner));
      shown.push(String(inner));
    } else if (ctx.template.card.get(arg.ref.field)?.kind === 'amount') {
      const amount = BigInt(values[arg.ref.field] as string);
      words.push(word(amount));
      shown.push(String(amount));
    } else {
      const entry = entryAt(arg.ref, values, ctx.sources, ctx.L);
      words.push(word(BigInt(entry.address)));
      shown.push(entry.name);
    }
  }
  const to = entryAt(read.to, values, ctx.sources, ctx.L);
  const call = `${read.fn.name}(${shown.join(', ')})`;
  const value = await ctx.chain.call(to, `${read.fn.selector}${words.join('')}` as Hex, call);
  steps.push({ call, on: to, value });
  return value;
}

const percent = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

async function computedValue(name: string, field: TypedField & { readonly kind: 'amount' }, computed: Computed, values: Readonly<Record<string, string>>, ctx: Context): Promise<string> {
  const { io, p, L } = ctx;
  const unit = unitOf(field.of, values, ctx.sources.registry);
  if (unit.kind === 'unregistered') throw new CardError(L.notComputable(name, unit.ref));
  const token = unit.kind === 'eth' ? 'ETH' : unit.entry.name;
  const decimals = unit.kind === 'eth' ? 18 : await ctx.chain.decimals(unit.entry);
  io.stdout(text(section(p, name, L.computed)));
  const steps: Step[] = [];
  const read = await readValue(computed.read, values, ctx, steps);
  const total = BigInt(slippageBps(computed));
  const value = computed.bound === 'floor' ? (read * (10_000n - total)) / 10_000n : (read * (10_000n + total) + 9_999n) / 10_000n;
  const reads = steps.map((step): Row => [L.read, [`${step.call} = ${step.value}`, `${L.on} ${step.on.name}  ${checksumAddress(step.on.address)}`]]);
  const margin = computed.margin === undefined ? undefined : percent(computed.margin.bps);
  io.stdout(
    text(
      rows([
        ...reads,
        [L.expected, `${groupedTokens(read, decimals)} ${token}`, p.computed],
        [L.slippage, L.slippageText(percent(Number(total)), computed.bound, percent(computed.default.bps), margin)],
        [L.result, `${groupedTokens(value, decimals)} ${token}`, p.computed],
        [L.defaultSource, computed.default.source, p.dim],
        ...(computed.margin === undefined ? [] : [[L.margin, say(computed.margin.why, ctx.language), p.dim] as const]),
      ], 4),
    ),
  );
  if (value === 0n) throw new CardError(L.comesToZero(name));
  if (value >= UINT256_LIMIT) throw new CardError(L.comesTooLarge(name));
  return value.toString();
}

type Context = {
  readonly template: Template;
  readonly sources: Sources;
  readonly io: Io;
  readonly ask: Terminal['ask'];
  readonly chain: Chain;
  readonly p: Paint;
  readonly L: CardWords;
  /** The language a template's reason is shown in, when the template holds it. */
  readonly language: Language;
  /** The vaults with a report for a template reported per vault. */
  readonly reported: (template: string) => ReadonlySet<string>;
};

const isTyped = (entry: [string, CardField]): entry is [string, TypedField] => ['amount', 'nonce', 'threshold', 'percent'].includes(entry[1].kind);
const isChosen = (entry: [string, CardField]): entry is [string, ChosenField] => !isTyped(entry);

/**
 * Every choice comes before every typed number, so the token an amount counts is known when it is asked, and every typed
 * number before every computed one, in card order, so a computed field may read any value but a later computed one.
 */
async function fill(template: Template, shared: Omit<Context, 'template'>): Promise<CardOperation> {
  const ctx: Context = { ...shared, template };
  const { L } = ctx;
  const values: Record<string, string> = {};
  const fields = [...template.card];
  const unit = reportUnit(template);
  if (unit.kind === 'several-vaults') throw new CardError(severalVaults(template.id));
  for (const [name, field] of fields.filter(isChosen)) {
    const listed = optionsFor(field, ctx.sources);
    const gated = gatesVaults(template) && field.kind !== 'market';
    const choices = gated ? listed.filter((choice) => !isRegistryVault(choice.name, ctx.sources.registry) || ctx.reported(template.id).has(choice.name)) : listed;
    if (unit.kind === 'vault' && unit.field === name && choices.length === 0) throw new CardError(L.noReportedVault(name, template.id));
    if (choices.length === 0) {
      throw new CardError(field.kind === 'market' ? L.noMarket(name) : L.nothingAccepted(name, template.id));
    }
    ctx.io.stdout(text([...section(ctx.p, name, L.pick), ...listLines(choices, ctx.p, L)]));
    const range = `1-${choices.length}`;
    const typed = await answer(ctx.ask, L.askNumber(name, range));
    const [choice, ...others] = picked(typed, choices);
    const shown = JSON.stringify(typed.slice(0, 80));
    if (choice === undefined) throw new CardError(L.notListed(name, shown, range));
    if (others.length > 0) throw new CardError(L.severalListed(name, shown, range));
    values[name] = choice.name;
  }
  for (const [name, field] of fields.filter(isTyped)) if (!isComputed(field)) values[name] = await typedValue(name, field, values, ctx);
  for (const [name, field] of fields.filter(isTyped)) if (isComputed(field)) values[name] = await computedValue(name, field, field.computed, values, ctx);
  return { template: template.id, values: Object.fromEntries(fields.map(([name]) => [name, values[name] as string])) };
}

const isComputed = (field: CardField): field is Extract<CardField, { kind: 'amount' }> & { readonly computed: Computed } => field.kind === 'amount' && field.computed !== undefined;

const readsChain = (template: Template): boolean => [...template.card.values()].some((f) => f.kind === 'amount' && (f.of !== 'eth' || f.computed !== undefined));

export async function cardNew(args: readonly string[], io: Io, w: Labels): Promise<number> {
  const L = w.card;
  if (args.length === 0) throw new UsageError(L.newUsage);
  const { ask, confirm } = terminal(io, 'card new', w);
  if (!stopUnlessDataIsMain(io, w)) return FAILED;
  const home = kissSignHome(io.env);
  const sources: Sources = { registry: loadRegistry(io.repoRoot), book: loadAddressBook(home), safe: requireConfig(home).safe };
  const templates = args.map((id) => {
    if (!existsSync(join(io.repoRoot, TEMPLATES_DIR, id, 'template.json'))) throw new CardError(L.noTemplate(id, TEMPLATES_DIR));
    return loadTemplate(io.repoRoot, id, sources.registry);
  });
  const reader = templates.some(readsChain) ? openMainnetReader(io.env, io.transport) : undefined;
  const chain = openChain(reader, L);
  const ctx = { sources, io, ask, chain, p: paint(io.color === true), L, language: w.language, reported: (id: string) => reportedVaultsIn(io.repoRoot, id) };
  const operations: CardOperation[] = [];
  for (const [i, template] of templates.entries()) {
    io.stdout(text(['', ctx.p.heading(L.operation(template.id, i + 1, templates.length))]));
    operations.push(await fill(template, ctx));
  }
  io.stdout('\n');
  const computed = new Set(templates.flatMap((template, i) => [...template.card].filter(([, field]) => isComputed(field)).map(([name]) => `${i}:${name}`)));
  return seal({ operations }, io, w, confirm, { decimals: chain.known, provenance: chain.provenance(), computed });
}
