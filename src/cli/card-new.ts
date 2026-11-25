import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { existsSync } from 'node:fs';
import { say } from '../language.ts';
import type { Language } from '../language.ts';
import { join } from 'node:path';
import { loadAddressBook } from '../address-book.ts';
import type { AddressBook } from '../address-book.ts';
import { CardError, isZeroFloor, parseUint256, resolveRef, resolveValue } from '../card.ts';
import type { CardOperation, ResolvedValue } from '../card.ts';
import { groupedTokens, readDecimals } from '../chain/decimals.ts';
import { canonicalType } from '../decode/abi.ts';
import { decodeValues, encodeCall } from '../decode/codec.ts';
import type { AbiValue } from '../decode/codec.ts';
import { openMainnetReader } from '../chain/reader.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { kissSignHome } from '../keys.ts';
import { isMarketEntryPart, loadRegistry } from '../registry.ts';
import type { Market, Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { FLOOR_RULE, FeedError, floorOf, moreThan, pairFacts, readReference, valueOf } from '../price/reference.ts';
import type { Doubt, PairFacts, PriceReads, Reference, ViewFunction } from '../price/reference.ts';
import { TEMPLATES_DIR, callRules, loadTemplate, scopeEntries, slippageBps, WAD } from '../template/template.ts';
import type { CardField, CardRef, Computed, ComputedRead, Floor, Rule, Template, TokenRef } from '../template/template.ts';
import { gatesInstances, isInstanceOf, reportUnit, reportedInstancesIn, severalInstances } from '../template/vault-reports.ts';
import type { ReportedInstances } from '../template/vault-reports.ts';
import { marketHead, marketTable } from './card-view.ts';
import { paint, rows, section, table, text } from './format.ts';
import type { Paint, Row } from './format.ts';
import { FAILED, UsageError, terminal } from './io.ts';
import type { Labels } from './labels.ts';
import type { Io, Terminal } from './io.ts';
import { stopUnlessDataIsMain, requireConfig, seal } from './setup.ts';
import { bindView } from '../simulate/effects.ts';
import { checkCode } from '../verify/code.ts';

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
function entryOf(chosen: string, attribute: string | undefined, registry: Registry): RegistryEntry | undefined {
  if (attribute === undefined) return registry.entries.get(chosen);
  if (isMarketEntryPart(attribute)) return registry.markets.get(chosen)?.[attribute];
  const name = registry.entries.get(chosen)?.attributes[attribute];
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
  /** The time of the block every read is made at. */
  readonly time: () => Promise<bigint>;
  /** Refuses the card unless `entry`, and each entry it depends on, runs the code its registry pin names. */
  readonly pinned: (entry: RegistryEntry) => Promise<void>;
  /** What a view answers. */
  readonly call: (to: RegistryEntry, data: Hex, call: string) => Promise<Hex>;
  /** What a view answers, or that it reverted at both providers. */
  readonly callOrRevert: (to: RegistryEntry, data: Hex, call: string) => Promise<Hex | 'reverted'>;
  /** Each token's decimals read so far. */
  readonly known: ReadonlyMap<Address, number>;
  /** The block every read was made at and the providers that agreed, once anything was read. */
  readonly provenance: () => string | undefined;
};

function openChain(reader: Reader | undefined, registry: Registry, L: CardWords): Chain {
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
  const pinned = new Set<string>();
  let time: bigint | undefined;
  const callOrRevert: Chain['callOrRevert'] = async (to, data, call) => {
    const refuse = (why: string): never => {
      throw new CardError(L.noRead(call, to.name, checksumAddress(to.address), why));
    };
    const { reader: r, at: ref } = await agreedBlock(refuse);
    const read = await r.call({ to: to.address, data }, ref);
    if (read.kind === 'unverifiable') return refuse(read.reason);
    return read.value.kind === 'reverted' ? 'reverted' : read.value.data;
  };
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
    pinned: async (entry) => {
      const refuse = (why: string): never => {
        throw new CardError(L.codeNotPinned(entry.name, checksumAddress(entry.address), why));
      };
      const { reader: r, at: ref } = await agreedBlock(refuse);
      const entries = [entry, ...(entry.dependsOn ?? []).map((name) => registry.entries.get(name) as RegistryEntry)].filter(({ name }) => !pinned.has(name));
      const check = await checkCode(r, entries, ref, 'pending');
      if (check.kind === 'mismatch') refuse(check.findings.join('; '));
      if (check.kind === 'unverifiable') refuse(check.reasons.join('; '));
      for (const { name } of entries) pinned.add(name);
    },
    time: async () => {
      if (time !== undefined) return time;
      const refuse = (why: string): never => {
        throw new CardError(L.noBlockTime(why));
      };
      const { reader: r, at: ref } = await agreedBlock(refuse);
      const header = await r.header(ref);
      if (header.kind === 'unverifiable') return refuse(header.reason);
      return (time = header.value.time);
    },
    callOrRevert,
    call: async (to, data, call) => {
      const answer = await callOrRevert(to, data, call);
      if (answer === 'reverted') throw new CardError(L.noRead(call, to.name, checksumAddress(to.address), L.reverted));
      return answer;
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
    return askedUntilNotZeroFloor(name, ctx, async () => {
      const typed = await answer(ctx.ask, question);
      const parsed = parseUint256(typed);
      if (parsed === undefined || (field.kind === 'threshold' && parsed === 0n)) throw new CardError(L.notWhole(name, JSON.stringify(typed.slice(0, 80)), field.kind === 'threshold'));
      return parsed;
    });
  }
  const token = unit.kind === 'eth' ? 'ETH' : unit.entry.name;
  const decimals = unit.kind === 'eth' ? 18 : await ctx.chain.decimals(unit.entry);
  io.stdout(text(rows([[L.token, unit.kind === 'eth' ? L.eth : `${token}  ${checksumAddress(unit.entry.address)}  ${L.decimals(decimals)}`]], 4)));
  const max = field.kind === 'amount' ? field.max : undefined;
  return askedUntilNotZeroFloor(name, ctx, async () => {
    const typed = await answer(ctx.ask, L.askAmount(name, token, decimals, max !== undefined));
    if (max !== undefined && typed === 'max') {
      io.stdout(text(rows([[L.max, say(max.why, ctx.language), p.dim]], 4)));
      return max.value;
    }
    return baseUnits(name, typed, decimals, token, L);
  });
}

async function askedUntilNotZeroFloor(name: string, ctx: Context, asked: () => Promise<bigint>): Promise<string> {
  for (;;) {
    const value = await asked();
    if (!isZeroFloor(ctx.template, name, value)) return value.toString();
    ctx.io.stdout(text(rows([['', ctx.L.zeroFloorAgain(name), ctx.p.warn]], 2)));
  }
}

function entryAt(ref: CardRef, values: Readonly<Record<string, string>>, sources: Sources, L: CardWords): RegistryEntry {
  const chosen = values[ref.field] as string;
  const entry = entryOf(chosen, ref.attribute, sources.registry);
  if (entry === undefined) throw new CardError(L.nothingToRead(ref.field, chosen, ref.attribute));
  return entry;
}

/** One view call `card new` made: what it called, on which contract, and its answer. */
type Step = { readonly call: string; readonly on: RegistryEntry; readonly value: bigint };

async function readValue(read: ComputedRead, values: Readonly<Record<string, string>>, ctx: Context, steps: Step[]): Promise<bigint> {
  const args: Rule[] = [];
  for (const arg of read.args) args.push(arg.kind === 'bound' ? arg.rule : { kind: 'const', value: { kind: 'uint', value: await readValue(arg.read, values, ctx, steps) } });
  const { registry, safe } = ctx.sources;
  const resolved = resolvedValues(values, ctx);
  const call = `${read.fn.name}(${args.map((arg) => shown(arg, resolved, registry)).join(', ')})`;
  const to = read.to.kind === 'contract' ? (registry.entries.get(read.to.name) as RegistryEntry) : entryAt(read.to.ref, values, ctx.sources, ctx.L);
  const refuse = (why: string): never => {
    throw new CardError(ctx.L.noRead(call, to.name, checksumAddress(to.address), why));
  };
  const bound = bindView({ ...read, args }, { safe, values: resolved, registry });
  if ('problem' in bound) return refuse(bound.problem);
  await ctx.chain.pinned(to);
  const answer = decodeValues(read.returns.map((param) => param.type), hexToBytes((await ctx.chain.call(to, bound.call.data, call)).slice(2)));
  if (answer === undefined) return refuse(ctx.L.notReturns(`(${read.returns.map((param) => canonicalType(param.type)).join(',')})`));
  const [first, ...rest] = read.output;
  const picked = rest.reduce((value, i) => (value as Extract<AbiValue, { kind: 'tuple' }>).fields[i] as AbiValue, answer[first as number] as AbiValue);
  const value = (picked as Extract<AbiValue, { kind: 'uint' | 'int' }>).value;
  steps.push({ call, on: to, value });
  return value;
}

/** An argument as the signer reads it: a name where the value has one, such as `safe` or a registry entry. */
function shown(rule: Rule, values: ReadonlyMap<string, ResolvedValue>, registry: Registry): string {
  switch (rule.kind) {
    case 'safe':
      return 'safe';
    case 'contract':
      return rule.name;
    case 'const':
      return String(rule.value.value);
    case 'card': {
      const target = resolveRef(rule.ref, values, registry);
      return 'problem' in target ? `card.${rule.ref.field}` : target.kind === 'address' ? target.name : target.kind === 'market' ? target.market.name : String(target.value);
    }
    case 'fields':
      return `(${rule.fields.map((field) => shown(field, values, registry)).join(', ')})`;
    case 'items':
      return `[${rule.items.map((item) => shown(item, values, registry)).join(', ')}]`;
    case 'call':
    case 'keccak': {
      const inner = `${rule.call.fn.name}(${rule.call.args.map((arg) => shown(arg, values, registry)).join(', ')})`;
      return rule.kind === 'keccak' ? `keccak256(${inner})` : inner;
    }
    default:
      return rule.kind;
  }
}

/** The values chosen and typed so far, as a sealed card resolves them. */
function resolvedValues(values: Readonly<Record<string, string>>, ctx: Context): Map<string, ResolvedValue> {
  const context = { registry: ctx.sources.registry, addressBook: ctx.sources.book, safe: ctx.sources.safe };
  return new Map(
    Object.entries(values).map(([name, raw]) => {
      const resolved = resolveValue(ctx.template.card.get(name) as CardField, raw, context);
      if ('reason' in resolved) throw new CardError(`${name}: ${resolved.detail}`);
      return [name, resolved];
    }),
  );
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

/** The price reads of one card: from contracts that run their pinned code, at the card's one block. */
function priceReads({ chain, L }: Context): PriceReads {
  const viewOrRevert = async (on: RegistryEntry, { fn, returns }: ViewFunction, args: Parameters<PriceReads['view']>[2]) => {
    await chain.pinned(on);
    const answer = await chain.callOrRevert(on, `0x${bytesToHex(encodeCall({ fn, args, trailer: undefined }))}` as Hex, fn.signature);
    if (answer === 'reverted') return answer;
    const values = decodeValues(returns.map((param) => param.type), hexToBytes(answer.slice(2)));
    if (values === undefined) throw new CardError(L.noRead(fn.signature, on.name, checksumAddress(on.address), L.notReturns(`(${returns.map((param) => canonicalType(param.type)).join(',')})`)));
    return values;
  };
  return {
    time: chain.time,
    decimals: chain.decimals,
    viewOrRevert,
    view: async (on, view, args) => {
      const values = await viewOrRevert(on, view, args);
      if (values === 'reverted') throw new CardError(L.noRead(view.fn.signature, on.name, checksumAddress(on.address), L.reverted));
      return values;
    },
  };
}

async function referenceOf(facts: Extract<PairFacts, { kind: 'feeds' }>, sell: RegistryEntry, buy: RegistryEntry, ctx: Context): Promise<Reference> {
  try {
    return await readReference(facts, sell, buy, priceReads(ctx));
  } catch (error) {
    if (!(error instanceof FeedError)) throw error;
    const { entry, why, answered } = error;
    throw new CardError(ctx.L.feedRefused(entry.name, checksumAddress(entry.address), ctx.L.feedWhy[why](answered, entry.feed as NonNullable<RegistryEntry['feed']>)));
  }
}

const tenths = (seconds: bigint): string => (Number(seconds) / 3600).toFixed(1);
const hundredths = (gap: bigint): string => `${(Number(gap) / 10_000).toFixed(4)}%`;

function doubtText(doubt: Doubt, sell: RegistryEntry, buy: RegistryEntry, L: CardWords): string {
  switch (doubt.kind) {
    case 'stale':
      return L.doubt.stale(doubt.read.entry.name, tenths(doubt.read.age), tenths(doubt.read.limit));
    case 'off-peg':
      return L.doubt.offPeg((doubt.side === 'sell' ? sell : buy).name, groupedTokens((doubt.price.num * 100_000_000n) / doubt.price.den, 8), percent(FLOOR_RULE.bandBps));
    case 'sources-differ':
      return L.doubt.sourcesDiffer(hundredths(doubt.gap), percent(doubt.limitBps));
    case 'pool-unusable':
      return doubt.why === 'thin' ? L.doubt.thin(doubt.pool.name, `${doubt.window / 60n}`, `${doubt.liquidity}`, `${doubt.pool.twap?.minLiquidity}`) : L.doubt.poolReverted(doubt.pool.name, `${doubt.window / 60n}`);
  }
}

/** A percent of at most `maxSlippageBps` with at most two decimals, in basis points; an empty answer is the rule's own. */
function typedSlippage(name: string, typed: string, L: CardWords): number {
  if (typed === '') return FLOOR_RULE.slippageBps;
  const match = /^(0|[1-9][0-9]{0,2})(?:\.([0-9]{1,2}))?$/.exec(typed);
  const shown = JSON.stringify(typed.slice(0, 80));
  if (match === null) throw new CardError(L.notSlippage(name, shown));
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (bps > FLOOR_RULE.maxSlippageBps) throw new CardError(L.overSlippage(name, shown, percent(FLOOR_RULE.maxSlippageBps)));
  return bps;
}

type Filled = { readonly value: string; readonly by: 'computed' | 'typed' };

/**
 * The least to receive, by the rule of the token pair picked: computed from the price of a pair that shares a peg, or
 * typed and compared with the price, typed again when far below it or when the price is in doubt, or typed with no price.
 */
async function floorValue(name: string, field: TypedField & { readonly kind: 'amount' }, { sells }: Floor, values: Readonly<Record<string, string>>, ctx: Context): Promise<Filled> {
  const { io, p, L } = ctx;
  const { registry } = ctx.sources;
  const tokenOf = (of: TokenRef): RegistryEntry => {
    const unit = unitOf(of, values, registry);
    if (unit.kind !== 'registry') throw new Error(`${name}: a floor counts a registry token`);
    return unit.entry;
  };
  const sell = tokenOf((ctx.template.card.get(sells) as Extract<CardField, { kind: 'amount' }>).of);
  const buy = tokenOf(field.of);
  if (sell.address === buy.address) throw new CardError(L.sameToken(name, sell.name));
  const named = new Set(callRules(ctx.template).flatMap((rule) => (rule.kind === 'contract' ? [rule.name] : [])));
  const facts = pairFacts(sell, buy, registry, named);
  if (facts.kind === 'no-feed') {
    io.stdout(text(rows([['', L.noIndependentPrice(facts.tokens.map((token) => token.name)), p.warn]], 2)));
    return { value: await typedValue(name, field, values, ctx), by: 'typed' };
  }
  const reference = await referenceOf(facts, sell, buy, ctx);
  const [sellDecimals, decimals] = [await ctx.chain.decimals(sell), await ctx.chain.decimals(buy)];
  const amount = BigInt(values[sells] as string);
  const shown = (value: bigint): string => `${groupedTokens(value, decimals)} ${buy.name}`;
  const expected = valueOf(amount, reference.strict);
  const computes = facts.pegged !== undefined && reference.doubts.length === 0;
  io.stdout(
    text([
      ...section(p, name, computes ? L.floorComputed : L.floorTyped),
      ...rows([
        ...reference.feeds.map(
          (read): Row => [
            L.read,
            [`latestRoundData() = ${groupedTokens(read.answer, read.entry.feed.decimals)}  ${read.entry.feed.description}`, `${L.on} ${read.entry.name}  ${checksumAddress(read.entry.address)}`, L.updated(tenths(read.age), tenths(read.limit))],
          ],
        ),
        ...reference.pools.map((read): Row => [L.read, [L.poolMean(`${reference.window / 60n}`, `${read.liquidity}`), `${L.on} ${read.entry.name}  ${checksumAddress(read.entry.address)}`]]),
        [L.selling, `${groupedTokens(amount, sellDecimals)} ${sell.name}`],
        [L.feedValue, shown(valueOf(amount, reference.chain)), p.computed],
        ...reference.twaps.map((ratio): Row => [L.poolValue, shown(valueOf(amount, ratio)), p.computed]),
        ...(facts.alone === undefined ? [] : [[L.sources, L.alone[facts.alone], p.dim] as const]),
        ...reference.doubts.map((doubt): Row => [L.doubtful, doubtText(doubt, sell, buy, L), p.warn]),
      ], 4),
    ]),
  );
  if (expected === 0n) throw new CardError(L.priceComesToZero(name));
  if (computes) {
    const typed = typedSlippage(name, await answer(ctx.ask, L.askSlippage(name, percent(FLOOR_RULE.slippageBps), percent(FLOOR_RULE.maxSlippageBps))), L);
    const total = typed + FLOOR_RULE.marginBps;
    const value = floorOf(amount, reference.strict, total);
    const stricter = reference.twaps.some((ratio) => moreThan(ratio, reference.chain)) ? L.poolValue : L.feedValue;
    io.stdout(
      text(
        rows([
          ...(reference.twaps.length === 0 ? [] : [[L.stricter, stricter] as const]),
          [L.slippage, L.floorSlippage(percent(total), percent(typed), percent(FLOOR_RULE.marginBps))],
          [L.result, shown(value), p.computed],
          [L.compare, L.compareFloor, p.dim],
        ], 4),
      ),
    );
    if (value === 0n) throw new CardError(L.comesToZero(name));
    if (value >= UINT256_LIMIT) throw new CardError(L.comesTooLarge(name));
    return { value: value.toString(), by: 'computed' };
  }
  if (reference.doubts.length > 0) io.stdout(text(rows([['', L.doubtThenType(name), p.warn]], 2)));
  for (;;) {
    const value = BigInt(await typedValue(name, field, values, ctx));
    const below = value >= expected ? 0n : ((expected - value) * 1_000_000n) / expected;
    const far = below > BigInt(FLOOR_RULE.retypeBps) * 100n;
    io.stdout(text(rows([['', value > expected ? L.abovePrice(shown(expected)) : L.belowPrice(shown(expected), hundredths(below)), far || value > expected ? p.warn : p.computed]], 4)));
    if (!far && reference.doubts.length === 0) return { value: `${value}`, by: 'typed' };
    if (baseUnits(name, await answer(ctx.ask, L.askAgain(name, buy.name)), decimals, buy.name, L) === value) return { value: `${value}`, by: 'typed' };
    io.stdout(text(rows([['', L.notTheSame(name), p.warn]], 2)));
  }
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
  /** The instances with a report for a template reported per instance. */
  readonly reported: (template: string) => ReportedInstances;
};

const isTyped = (entry: [string, CardField]): entry is [string, TypedField] => ['amount', 'nonce', 'threshold', 'percent'].includes(entry[1].kind);
const isChosen = (entry: [string, CardField]): entry is [string, ChosenField] => !isTyped(entry);

/**
 * Every choice comes before every typed number, so the token an amount counts is known when it is asked, and every typed
 * number before every floor and every computed one, in card order, so a floor knows what it is for and a computed field
 * may read any value but a later computed one.
 */
async function fill(template: Template, shared: Omit<Context, 'template'>): Promise<{ readonly operation: CardOperation; readonly computed: readonly string[] }> {
  const ctx: Context = { ...shared, template };
  const { L } = ctx;
  const values: Record<string, string> = {};
  const fields = [...template.card];
  const unit = reportUnit(template);
  if (unit.kind === 'several-instances') throw new CardError(severalInstances(template.id));
  for (const [name, field] of fields.filter(isChosen)) {
    const listed = optionsFor(field, ctx.sources);
    const gated = gatesInstances(template) && field.kind !== 'market';
    const instances = gated ? listed.filter((choice) => isInstanceOf(template, choice.name, ctx.sources.registry)) : [];
    const reported = instances.length === 0 ? new Set<string>() : ctx.reported(template.id);
    const choices = listed.filter((choice) => !instances.includes(choice) || reported.has(choice.name));
    if (unit.kind === 'instance' && unit.field === name && choices.length === 0) throw new CardError(L.noReportedInstance(name, unit.of, template.id));
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
  const computed: string[] = [];
  const typed = fields.filter(isTyped);
  for (const [name, field] of typed) if (!isComputed(field) && !hasFloor(field)) values[name] = await typedValue(name, field, values, ctx);
  for (const [name, field] of typed) {
    if (!hasFloor(field)) continue;
    const filled = await floorValue(name, field, field.floor, values, ctx);
    values[name] = filled.value;
    if (filled.by === 'computed') computed.push(name);
  }
  for (const [name, field] of typed) {
    if (!isComputed(field)) continue;
    values[name] = await computedValue(name, field, field.computed, values, ctx);
    computed.push(name);
  }
  return { operation: { template: template.id, values: Object.fromEntries(fields.map(([name]) => [name, values[name] as string])) }, computed };
}

const isComputed = (field: CardField): field is Extract<CardField, { kind: 'amount' }> & { readonly computed: Computed } => field.kind === 'amount' && field.computed !== undefined;

const hasFloor = (field: CardField): field is Extract<CardField, { kind: 'amount' }> & { readonly floor: Floor } => field.kind === 'amount' && field.floor !== undefined;

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
  const chain = openChain(reader, sources.registry, L);
  const ctx = { sources, io, ask, chain, p: paint(io.color === true), L, language: w.language, reported: (id: string) => reportedInstancesIn(io.repoRoot, id) };
  const operations: CardOperation[] = [];
  const computed = new Set<string>();
  for (const [i, template] of templates.entries()) {
    io.stdout(text(['', ctx.p.heading(L.operation(template.id, i + 1, templates.length))]));
    const filled = await fill(template, ctx);
    operations.push(filled.operation);
    for (const name of filled.computed) computed.add(`${i}:${name}`);
  }
  io.stdout('\n');
  return seal({ operations }, io, w, confirm, { decimals: chain.known, provenance: chain.provenance(), computed });
}
