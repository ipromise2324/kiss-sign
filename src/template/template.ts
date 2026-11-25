import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AbiSignatureError, canonicalType, paramName, parseFunctionSignature, parseViewSignature } from '../decode/abi.ts';
import type { AbiFunction, AbiParam, AbiType } from '../decode/abi.ts';
import { ATTRIBUTES_PATH, CONTRACT_KINDS, MARKET_ENTRIES, MARKET_ENTRY_PARTS, MARKET_PARAMS, MARKET_PARTS, MARKETS_PATH, MAX_API_PATH_STEPS, isApiPathStep, isEntryName, isMarketEntryPart, parseHttpsUrl } from '../registry.ts';
import type { AllowanceRoute, ApiPathStep, ContractKind, HttpsUrl, MarketEntryPart, MarketPart, Registry, RegistryEntry } from '../registry.ts';
import { SafeTxParseError, parseAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import { domainSeparator, isMemberType, ownNames } from './eip712.ts';
import type { MemberSource, MessageAnswer, StructType } from './eip712.ts';
import { LANGUAGES, isProse } from '../language.ts';
import type { Prose } from '../language.ts';

/**
 * The registry entries a contract card field accepts: those of `registryKind`, when `protocol` is set only those that
 * belong to the DefiLlama protocol of that slug, and when `marketPart` is set only those that are that part of some
 * market in the markets table, such as a market's `collateralToken`.
 */
export type EntryScope = { readonly registryKind: ContractKind; readonly protocol: string | undefined; readonly marketPart: MarketEntryPart | undefined };

/**
 * The DefiLlama protocol an entry belongs to. An entry with a `factory` belongs to its factory's protocol, which the
 * chain proves through the factory's `instanceCheck`; its own `defillama` names the site that lists it, such as a curator's.
 */
export function protocolOf(entry: RegistryEntry, registry: Registry): { readonly slug: string | undefined; readonly why: string } {
  const factory = entry.attributes.factory;
  if (factory === undefined) return { slug: entry.defillama, why: '' };
  return { slug: registry.entries.get(factory)?.defillama, why: ` (its factory ${factory})` };
}

/** Why `entry` cannot fill a contract card field of `scope`, or undefined when it can. */
export function contractRefusal(
  scope: EntryScope,
  entry: RegistryEntry,
  registry: Registry,
): { readonly reason: 'wrong-contract-kind' | 'wrong-protocol' | 'not-in-markets'; readonly detail: string } | undefined {
  if (entry.kind !== scope.registryKind) return { reason: 'wrong-contract-kind', detail: `${entry.name} is a ${entry.kind}, not a ${scope.registryKind}` };
  const protocol = scope.protocol === undefined ? undefined : protocolOf(entry, registry);
  if (protocol !== undefined && protocol.slug !== scope.protocol) {
    return { reason: 'wrong-protocol', detail: `${entry.name} is a ${entry.kind} of ${protocol.slug ?? 'no DefiLlama protocol'}${protocol.why}, not of ${scope.protocol}` };
  }
  const part = scope.marketPart;
  if (part !== undefined && ![...registry.markets.values()].some((market) => market[part].name === entry.name)) {
    return { reason: 'not-in-markets', detail: `${entry.name} is not the ${part} of any market in ${MARKETS_PATH}` };
  }
  return undefined;
}

export const inScope = (scope: EntryScope, entry: RegistryEntry, registry: Registry): boolean => contractRefusal(scope, entry, registry) === undefined;

/** Every registry entry a contract card field of `scope` accepts, in registry order. */
export const scopeEntries = (scope: EntryScope, registry: Registry): RegistryEntry[] => [...registry.entries.values()].filter((entry) => inScope(scope, entry, registry));

/** What the signer fills in at each signing. */
export type CardField =
  | { readonly kind: 'contract'; readonly scope: EntryScope }
  /**
   * A base-unit integer of the token `of` names; `computed` when the protocol's app fills it in, so `card new` reads it
   * instead of asking; `max` a number the signer may choose by typing `max`, such as a cap of no limit; `floor` when it is
   * the least of its token to receive for another amount, so `card new` reads the price of the two tokens picked.
   */
  | { readonly kind: 'amount'; readonly of: TokenRef; readonly computed: Computed | undefined; readonly max: AmountMax | undefined; readonly floor?: Floor }
  /** A percent, held in WAD base units: 100% is 10^18. */
  | { readonly kind: 'percent' }
  /** A registry name, an address-book name, or `safe`. */
  | { readonly kind: 'address' }
  /** Who receives a transfer: an address-book name or `safe`, never a registry contract. */
  | { readonly kind: 'recipient' }
  /** A Safe nonce. */
  | { readonly kind: 'nonce' }
  /** An owner of the Safe, to add, remove or replace: an address-book name. */
  | { readonly kind: 'owner' }
  /** The Safe's threshold: a whole number from 1. */
  | { readonly kind: 'threshold' }
  /** A Morpho Blue market from `registry/markets.json`. */
  | { readonly kind: 'market' };

/**
 * `vault`, `vault.asset` or `market.loanToken`: a card field, an attribute of the registry entry that field names, or a
 * part of the market it names.
 */
export type CardRef = { readonly field: string; readonly attribute: string | MarketPart | undefined };

/** Native ETH, which no contract holds, or a token a card field names. */
export type TokenRef = 'eth' | CardRef;

/**
 * A view call `card new` makes on the contract `to` names, every argument bound, and the unsigned number of its answer
 * `output` picks: positions into `returns`, then into a tuple's components.
 */
export type ComputedRead = {
  readonly to: ViewTarget;
  readonly fn: AbiFunction;
  readonly args: readonly ComputedArg[];
  readonly returns: readonly AbiParam[];
  readonly output: readonly number[];
};
/** An argument bound as a view's is, or the number another read gives. */
export type ComputedArg = { readonly kind: 'bound'; readonly rule: Rule } | { readonly kind: 'read'; readonly read: ComputedRead };

/** The return value `output` picks, with its dotted name, such as `supplyShares`. */
export function computedOutput(read: Pick<ComputedRead, 'returns' | 'output'>): { readonly param: AbiParam; readonly name: string } {
  let params = read.returns;
  const names: string[] = [];
  let param: AbiParam | undefined;
  for (const i of read.output) {
    param = params[i] as AbiParam;
    names.push(paramName(param, i));
    params = param.type.kind === 'tuple' ? param.type.components : [];
  }
  return { param: param as AbiParam, name: names.join('.') };
}

/**
 * A card amount the protocol's app fills in by itself: `read` less (`floor`, rounded down) or plus (`ceiling`, rounded
 * up) the protocol's default slippage and an optional margin, both in basis points.
 */
export type Computed = {
  readonly read: ComputedRead;
  readonly bound: 'floor' | 'ceiling';
  readonly default: { readonly bps: number; readonly source: HttpsUrl };
  readonly margin: { readonly bps: number; readonly why: Prose } | undefined;
};

/** The card amount this field is the least to receive for: what the Safe sells. */
export type Floor = { readonly sells: string };

/** A number the signer may type as `max`, with the reason the template gives for it. */
export type AmountMax = { readonly value: bigint; readonly why: Prose };

/** A percent field's value for 100%. */
export const WAD = 10n ** 18n;

export const slippageBps = (computed: Computed): number => computed.default.bps + (computed.margin?.bps ?? 0);

export type ConstValue =
  | { readonly kind: 'uint' | 'int'; readonly value: bigint }
  | { readonly kind: 'address'; readonly value: Address }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'fixed-bytes' | 'bytes' | 'string'; readonly value: Hex };

/**
 * Why a free field is safe at any value. `scalar`: a number, bool, fixed-size bytes or an array of numbers, which the
 * reason explains. `proof`: the contract reverts unless it verifies the value against what it already holds, such as a
 * Merkle root or attesters' signatures. `unread`: the contract never reads the value. `route`: a number that picks one of
 * the protocol's pools, so another value may change the price but nothing the effects do not bound. Only `proof` and
 * `unread` may free bytes, a string or another array, and nothing may free an address or a tuple.
 */
export type FreeClaim = 'scalar' | 'proof' | 'unread' | 'route';

export type Rule =
  | { readonly kind: 'card'; readonly ref: CardRef }
  | { readonly kind: 'safe' }
  | { readonly kind: 'contract'; readonly name: string }
  /** A `bytes32` that holds the address `rule` binds, left-padded with 12 zero bytes, as bridges hold a recipient. */
  | { readonly kind: 'address-word'; readonly rule: AddressRule }
  | { readonly kind: 'const'; readonly value: ConstValue }
  /** `time`: a number of seconds since 1970, as a block's timestamp counts, which `pnpm past-txs` measures against the block's time. */
  | { readonly kind: 'free'; readonly reason: Prose; readonly claim: FreeClaim; readonly time?: true }
  /**
   * A time, in seconds since 1970 as a block's timestamp counts, at most `seconds` after the time of the block the
   * transaction is judged on, such as an order's expiry.
   */
  | { readonly kind: 'within-seconds'; readonly seconds: bigint }
  /** The same number as the transaction holds at an earlier template path, such as an approval its transfer spends. */
  | { readonly kind: 'equals'; readonly path: string; readonly rule: LeafRule }
  /**
   * An ERC-4626 price bound in assets per share, scaled by 10^`scale` (1e27 as Morpho's adapters take it). `max` must be
   * at most, and `min` at least, `assets` × 10^`scale` / `shares`, so the transaction's bound is at least as strict as the
   * card's amounts.
   */
  | { readonly kind: 'share-price'; readonly bound: 'max' | 'min'; readonly assets: Quantity; readonly shares: Quantity; readonly scale: number }
  /** The owner listed just before the card's owner in the Safe's `getOwners()`, or the sentinel when it is first. */
  | { readonly kind: 'owner-before'; readonly ref: CardRef }
  /** A number at least (`at-least`) or at most (`at-most`) the card amount `field`, such as a swap's fewest tokens out or most tokens in. */
  | { readonly kind: 'at-least' | 'at-most'; readonly field: string }
  | { readonly kind: 'call'; readonly call: CallNode }
  /** A view's bytes32 argument: keccak256 of the call or `encoded` parameters, every argument of which is bound. */
  | { readonly kind: 'keccak'; readonly call: CallNode }
  /** `bytes` that are the concatenation of fixed-size parts with no padding, as `abi.encodePacked` writes them. */
  | { readonly kind: 'packed'; readonly parts: readonly PackedPart[] }
  /** A `bytes32` that is the EIP-712 digest of a message the transaction does not hold, read from `lookup`. */
  | { readonly kind: 'eip712'; readonly message: SignedMessage }
  /** An array of exactly this many items. */
  | { readonly kind: 'items'; readonly items: readonly Rule[] }
  /** A tuple's components, by position. */
  | { readonly kind: 'fields'; readonly fields: readonly Rule[] };

/** A rule that binds an address, which `addressWord` may hold as a 32-byte word. */
export type AddressRule = Extract<Rule, { readonly kind: 'card' | 'safe' | 'contract' }>;

const WORD_PADDING = `0x${'00'.repeat(12)}`;

/** `address` as a 32-byte word, left-padded with 12 zero bytes, as `addressWord` binds it. */
export const addressWord = (address: Address): Hex => `${WORD_PADDING}${address.slice(2)}` as Hex;

/** The address a 32-byte word holds, or undefined when its first 12 bytes are not all zero. */
export const wordAddress = (word: string): Address | undefined =>
  word.length === 66 && word.startsWith(WORD_PADDING) ? (`0x${word.slice(26).toLowerCase()}` as Address) : undefined;

export type Quantity = { readonly kind: 'card'; readonly field: string } | { readonly kind: 'path'; readonly path: string; readonly rule: LeafRule };

export type LeafRule = Exclude<Rule, { readonly kind: 'call' | 'keccak' | 'items' | 'fields' | 'packed' | 'eip712' }>;

export type PackedPart = { readonly name: string; readonly type: AbiType; readonly size: number; readonly rule: Rule };

/**
 * A message of one struct type under an EIP-712 domain on chain 1, `separator` computed from `domain`. `fields` holds a
 * rule per member, by position. `lookup` is an https URL where `{arg}` stands for the hex of the call argument that
 * holds the digest; `answer` says where its JSON answer holds the message.
 */
export type SignedMessage = {
  readonly domain: { readonly name: string; readonly version: string; readonly verifyingContract: string };
  readonly separator: Hex;
  readonly struct: StructType;
  readonly fields: readonly Rule[];
  readonly lookup: string;
  readonly answer: MessageAnswer;
};

/** Bytes a contract ignores after a call's arguments, which the template lets through up to `maxBytes`. */
export type TrailerAllowance = { readonly maxBytes: number; readonly why: Prose };

/**
 * `call`: a selector, then the arguments. `params`: the arguments alone, ABI-encoded with no selector, as a command
 * router takes each command's input; `fn`'s name is then only the protocol's name for them, such as `V4_SWAP`.
 */
export type Encoding = 'call' | 'params';

export type CallNode = {
  readonly encoding: Encoding;
  readonly fn: AbiFunction;
  /** One rule per parameter, by position. */
  readonly args: readonly Rule[];
  readonly trailer: TrailerAllowance | undefined;
};

/**
 * A call the Safe makes: a function call, or `empty` data, as a plain ETH transfer or a cancellation sends. `merge`,
 * with its reason, lets several operations share this call: see `checkTemplateFields`.
 */
export type TemplateCall = { readonly to: Rule; readonly value: Rule; readonly data: CallNode | 'empty'; readonly merge: Prose | undefined };

/**
 * `all`, only on what the Safe gives, means its whole balance: the Safe holds none of the token afterwards. `at-most`,
 * only on what the Safe gives, means no more than the card amount `field` and none gained; `at-least`, only on what the
 * Safe gets, at least that amount; `any`, only on what the Safe gets, any amount, none included.
 */
export type EffectAmount =
  | { readonly kind: 'card'; readonly field: string }
  | { readonly kind: 'positive' }
  | { readonly kind: 'any' }
  | { readonly kind: 'all' }
  | { readonly kind: 'at-least' | 'at-most'; readonly field: string };

/** A token an effect names: one a card field names, `eth`, or a registry token by name, such as stETH. */
export type EffectToken = TokenRef | { readonly contract: string };

/** Whether an effect names its token by registry name, rather than as `eth` or through a card field. */
export const isNamedToken = (token: EffectToken): token is { readonly contract: string } => typeof token === 'object' && 'contract' in token;

/**
 * How far the Safe's balance of a token may end below (`less`) or above (`more`) what the card explains, in base units,
 * for rounding the protocol documents; 0 in a direction the template does not name.
 */
export type Tolerance = { readonly less: bigint; readonly more: bigint; readonly why: Prose };

/** The most base units a tolerance allows in one direction: rounding loses a unit or two per conversion. */
const MAX_TOLERANCE = 10;

/**
 * `to`, on what the Safe gives, names the receiver; the Safe giving to itself changes nothing. `tolerance`, only on an
 * exact card amount, lets the balance end a few base units off it.
 */
export type Effect = { readonly token: EffectToken; readonly amount: EffectAmount; readonly to: CardRef | undefined; readonly tolerance: Tolerance | undefined };

/** Every registry token the template's effects name by name, in `gives`, `gets` or `touches`. */
export const namedEffectTokens = ({ gives, gets, touches }: Pick<Template['effects'], 'gives' | 'gets' | 'touches'>): string[] => [
  ...new Set([...[...gives, ...gets].flatMap(({ token }) => (isNamedToken(token) ? [token.contract] : [])), ...touches.map((t) => t.token)]),
];

/** The registry names an effect's token can be: `eth` none, a named token itself, a card field the entries it can name. */
export const effectTokenNames = (token: EffectToken, template: Template, registry: Registry): string[] =>
  token === 'eth' ? [] : isNamedToken(token) ? [token.contract] : refNames(token, template, registry);

/** A registry token the operation touches without moving it on purpose, whose balance may change within `tolerance`. */
export type Touch = { readonly token: string; readonly tolerance: Tolerance };

/**
 * An allowance from the Safe the transaction may leave open: of `token` to the registry contract `spender`, through an
 * ERC-20 `approve` or through Permit2. `unlimited` needs the spender's registry entry to declare a standing allowance
 * of that route; a card amount lets it end at no more than that amount.
 */
export type KeptApproval = {
  readonly token: CardRef;
  readonly spender: string;
  readonly via: AllowanceRoute;
  readonly amount: { readonly kind: 'card'; readonly field: string } | { readonly kind: 'unlimited' };
};

export const VIEW_CHANGES = ['increases', 'decreases', 'same'] as const;
export type ViewChange = (typeof VIEW_CHANGES)[number];

/** A view call on a registry contract with every argument bound before any transaction runs. */
export type BoundView = {
  readonly to: string;
  readonly fn: AbiFunction;
  readonly args: readonly Rule[];
  readonly returns: readonly AbiParam[];
};

/** The contract a view effect reads: a registry contract, or the one a contract card field or its attribute names. */
export type ViewTarget = { readonly kind: 'contract'; readonly name: string } | { readonly kind: 'card'; readonly ref: CardRef };

/** A direction, or `equals`: the value after the transaction is the card's amount or percent field of that name. */
export type ViewExpectation = ViewChange | { readonly equals: string };

/**
 * A view function, called just before and just after the transaction with every argument bound. Each return value
 * `changes` names must change that way; the others are not judged.
 */
export type ViewEffect = Omit<BoundView, 'to'> & {
  readonly to: ViewTarget;
  /** By the return value's position, which `returns` names. */
  readonly changes: readonly { readonly value: number; readonly change: ViewExpectation }[];
};

/**
 * A view the report reads for every value of one card field, `field`, to show the size of what it names. `verify` never
 * reads it. Every named return value is shown, counted in its unit's decimals; `ratio`, by return position, is printed
 * as a percentage.
 */
export type Fact = BoundView & {
  readonly field: string;
  /** By the return value's position, which `returns` names. */
  readonly units: readonly { readonly value: number; readonly unit: TokenRef }[];
  readonly ratio: readonly [number, number] | undefined;
  /** Where the protocol defines the ratio; present exactly when `ratio` is. */
  readonly reason: Prose | undefined;
};

/**
 * How the operation changes the Safe's own settings: the owner it adds, the one it removes, or both for a replacement,
 * and the card threshold the Safe's threshold ends at, unchanged when absent.
 */
export type SafeSettingsEffect = {
  readonly add: CardRef | undefined;
  readonly remove: CardRef | undefined;
  readonly threshold: CardRef | undefined;
};

export type Template = {
  readonly id: string;
  readonly card: ReadonlyMap<string, CardField>;
  /** The Safe transaction's own nonce. */
  readonly nonce: Rule | undefined;
  /** Card references that must all name the same address, such as two vaults' assets; a card where they differ is refused. */
  readonly same: readonly CardRef[];
  readonly calls: readonly TemplateCall[];
  readonly effects: {
    readonly gives: readonly Effect[];
    readonly gets: readonly Effect[];
    readonly views: readonly ViewEffect[];
    readonly safe: SafeSettingsEffect | undefined;
    readonly approves: readonly KeptApproval[];
    readonly touches: readonly Touch[];
  };
  readonly facts: readonly Fact[];
  /** The contract card field the template is reported per, as declared; `reportUnit` gives the default. */
  readonly instanceField: string | undefined;
};

export const TEMPLATES_DIR = 'templates';
const ID = /^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/;
const ADDRESS_BYTES = 20;
/** No trailer or constant `bytes` is long enough to hold a whole address. */
const MAX_TRAILER = ADDRESS_BYTES - 1;

export class TemplateError extends Error {
  override name = 'TemplateError';
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.path = path;
  }
}

type Json = Record<string, unknown>;

function object(path: string, raw: unknown): Json {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TemplateError(path, 'not a JSON object');
  return raw as Json;
}

function array(path: string, raw: unknown): unknown[] {
  if (!Array.isArray(raw)) throw new TemplateError(path, 'not a JSON array');
  return raw;
}

function text(path: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new TemplateError(path, 'not a non-empty string');
  return raw;
}

/**
 * A reason the author writes for the signer: an object keyed by language, `{ "en": ... }`, `{ "zh-TW": ... }` or both,
 * or a plain string, as templates held before, which reads as English so an older verdict file still replays.
 */
function prose(path: string, raw: unknown): Prose {
  if (typeof raw === 'string') return { en: printable(path, text(path, raw)) };
  if (!isProse(raw)) throw new TemplateError(path, `not a non-empty string or an object keyed by ${LANGUAGES.join(' or ')}`);
  return Object.fromEntries(LANGUAGES.flatMap((language) => (raw[language] === undefined ? [] : [[language, printable(`${path}.${language}`, text(`${path}.${language}`, raw[language]))]])));
}

function printable(path: string, written: string): string {
  if (UNPRINTABLE.test(written)) throw new TemplateError(path, 'holds a control or bidirectional character');
  return written;
}

/** The languages each reason holds, collected from the parsed template; a template whose reasons differ is refused. */
function proseLanguages(value: unknown, sets: Set<string>): Set<string> {
  if (value instanceof Map) value.forEach((item) => proseLanguages(item, sets));
  else if (isProse(value)) sets.add(LANGUAGES.filter((language) => value[language] !== undefined).join(' and '));
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach((item) => proseLanguages(item, sets));
  return sets;
}

function exactKeys(path: string, value: Json, required: readonly string[], optional: readonly string[] = []): void {
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new TemplateError(`${path}.${missing}`, 'missing');
  const extra = Object.keys(value).find((key) => !required.includes(key) && !optional.includes(key));
  if (extra !== undefined) throw new TemplateError(`${path}.${extra}`, 'unexpected field');
}

/**
 * `view` while a view's arguments are parsed, the only place a `keccak` rule binds; `inMessage` while parsing the members
 * of a signed message, which is hashed, never called.
 */
type Scope = { readonly card: CardFields; readonly registry: Registry; readonly uintLeaves: Map<string, LeafRule>; readonly view: boolean; readonly inMessage: boolean };

type CardFields = ReadonlyMap<string, CardField>;

function cardRef(path: string, raw: string, card: CardFields, registry: Registry): CardRef {
  const [field, attribute, extra] = raw.split('.');
  const target = field === undefined ? undefined : card.get(field);
  if (field === undefined || target === undefined || extra !== undefined) throw new TemplateError(path, `${JSON.stringify(raw)} is not a card field`);
  if (attribute === undefined) return { field, attribute: undefined };
  if (target.kind === 'market') {
    const part = MARKET_PARTS.find((p) => p === attribute);
    if (part === undefined) throw new TemplateError(path, `${JSON.stringify(attribute)} is not one of ${MARKET_PARTS.join(', ')}`);
    return { field, attribute: part };
  }
  if (!registry.attributes.has(attribute)) throw new TemplateError(path, `${JSON.stringify(attribute)} is not an attribute ${ATTRIBUTES_PATH} declares`);
  if (target.kind !== 'contract') throw new TemplateError(path, `card field ${field} has no ${attribute}`);
  if (!scopeEntries(target.scope, registry).some((entry) => entry.attributes[attribute] !== undefined)) throw new TemplateError(path, `card field ${field} has no ${attribute}: no entry it accepts carries one`);
  return { field, attribute };
}

/** What a card reference resolves to: an address, a number, a market's bytes32 id, or a whole market. */
type RefType = 'address' | 'uint' | 'bytes32' | 'market';

function refType(ref: CardRef, card: CardFields): RefType {
  const kind = card.get(ref.field)?.kind;
  if (kind === 'market') return ref.attribute === undefined ? 'market' : ref.attribute === 'lltv' ? 'uint' : ref.attribute === 'id' ? 'bytes32' : 'address';
  return ref.attribute === undefined && (kind === 'amount' || kind === 'nonce' || kind === 'threshold' || kind === 'percent') ? 'uint' : 'address';
}

const binds = (ref: Exclude<RefType, 'market'>, type: AbiType): boolean =>
  ref === 'bytes32' ? type.kind === 'fixed-bytes' && type.size === 32 : type.kind === ref;

/** Morpho Blue's `MarketParams`, which a whole card market binds part by part. */
const isMarketParams = (type: AbiType): boolean => canonicalType(type) === '(address,address,address,address,uint256)';

function cardToken(path: string, raw: string, card: CardFields, registry: Registry): CardRef {
  const ref = cardRef(path, raw, card, registry);
  if (refType(ref, card) !== 'address') throw new TemplateError(path, 'must name a token');
  return ref;
}

/** A constant string: a tag such as `this/marketParams`, too short to spell a 40-digit hex address. */
const MAX_TAG = 32;
const TAG = new RegExp(`^[\\x20-\\x7e]{1,${MAX_TAG}}$`);

function constValue(path: string, raw: unknown, type: AbiType): ConstValue {
  const value = text(path, raw);
  const bad = (): never => {
    throw new TemplateError(path, `${JSON.stringify(value.slice(0, 80))} is not a ${canonicalType(type)}`);
  };
  switch (type.kind) {
    case 'uint':
    case 'int': {
      if (!/^-?(0|[1-9][0-9]{0,77})$/.test(value)) return bad();
      const n = BigInt(value);
      const fits = type.kind === 'uint' ? BigInt.asUintN(type.bits, n) === n : BigInt.asIntN(type.bits, n) === n;
      return fits ? { kind: type.kind, value: n } : bad();
    }
    case 'bool':
      return value === 'true' || value === 'false' ? { kind: 'bool', value: value === 'true' } : bad();
    case 'address':
      try {
        return { kind: 'address', value: parseAddress(path, value) };
      } catch (error) {
        if (error instanceof SafeTxParseError) return bad();
        throw error;
      }
    case 'fixed-bytes':
      return new RegExp(`^0x[0-9a-fA-F]{${type.size * 2}}$`).test(value) ? { kind: 'fixed-bytes', value: value.toLowerCase() as Hex } : bad();
    case 'bytes':
      return /^0x([0-9a-fA-F]{2})*$/.test(value) ? { kind: 'bytes', value: value.toLowerCase() as Hex } : bad();
    case 'string':
      return { kind: 'string', value: `0x${Buffer.from(value, 'utf8').toString('hex')}` as Hex };
    default:
      return bad();
  }
}

const contains = (type: AbiType, kind: AbiType['kind']): boolean =>
  type.kind === kind ||
  ((type.kind === 'array' || type.kind === 'fixed-array') && contains(type.item, kind)) ||
  (type.kind === 'tuple' && type.components.some((param) => contains(param.type, kind)));

function free(path: string, raw: unknown, type: AbiType): Rule {
  if (contains(type, 'address')) throw new TemplateError(path, 'an address is never free; bind it to the Safe, a card value or a registry contract');
  if (contains(type, 'tuple')) throw new TemplateError(path, 'a tuple is never free as a whole; bind its fields');
  if (typeof raw === 'string' || isProse(raw)) {
    const numbers = (type.kind === 'array' || type.kind === 'fixed-array') && (type.item.kind === 'uint' || type.item.kind === 'int');
    if (!numbers && !['uint', 'int', 'bool', 'fixed-bytes'].includes(type.kind)) {
      throw new TemplateError(path, `a free ${canonicalType(type)} needs {"proof": why} or {"unread": why}`);
    }
    return { kind: 'free', reason: prose(path, raw), claim: 'scalar' };
  }
  const value = object(path, raw);
  const [claim, ...extra] = Object.keys(value);
  if ((claim !== 'proof' && claim !== 'unread' && claim !== 'route' && claim !== 'time') || extra.length > 0) throw new TemplateError(path, 'must be a reason, or exactly one of proof, unread, route, time');
  if (claim === 'route' && type.kind !== 'uint' && type.kind !== 'int') throw new TemplateError(path, 'a route is a number that picks a pool');
  if (claim === 'time') {
    if (type.kind !== 'uint' && type.kind !== 'int') throw new TemplateError(path, 'a time is a number of seconds');
    return { kind: 'free', reason: prose(`${path}.time`, value.time), claim: 'scalar', time: true };
  }
  return { kind: 'free', reason: prose(`${path}.${claim}`, value[claim]), claim };
}

function quantity(path: string, raw: unknown, scope: Scope): Quantity {
  const name = text(path, raw);
  const field = cardFieldName(name);
  if (field !== undefined) {
    if (scope.card.get(field)?.kind !== 'amount') throw new TemplateError(path, `${JSON.stringify(name)} is not a card amount`);
    return { kind: 'card', field };
  }
  const rule = scope.uintLeaves.get(name);
  if (rule === undefined) throw new TemplateError(path, `${JSON.stringify(name)} is neither card.<amount> nor the path of an earlier uint argument`);
  return { kind: 'path', path: name, rule };
}

/** The longest `withinSeconds` a template may declare: a time bound beyond a year bounds next to nothing. */
const MAX_WITHIN_SECONDS = 365 * 24 * 60 * 60;

const SHARE_PRICE_SCALE = { default: 27, min: 1, max: 36 } as const;

function sharePrice(path: string, raw: unknown, type: AbiType, scope: Scope, bound: 'max' | 'min'): Rule {
  if (type.kind !== 'uint') throw new TemplateError(path, `a share price bound cannot bind a ${canonicalType(type)}`);
  const value = object(path, raw);
  exactKeys(path, value, ['assets', 'shares'], ['scale']);
  const scale = value.scale ?? SHARE_PRICE_SCALE.default;
  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale < SHARE_PRICE_SCALE.min || scale > SHARE_PRICE_SCALE.max) {
    throw new TemplateError(`${path}.scale`, `the power of ten the price is scaled by, a whole number from ${SHARE_PRICE_SCALE.min} to ${SHARE_PRICE_SCALE.max}`);
  }
  return { kind: 'share-price', bound, assets: quantity(`${path}.assets`, value.assets, scope), shares: quantity(`${path}.shares`, value.shares, scope), scale };
}

function rule(path: string, raw: unknown, type: AbiType, scope: Scope): Rule {
  const parsed = parseRule(path, raw, type, scope);
  if (type.kind === 'uint' && !['call', 'keccak', 'items', 'fields', 'packed', 'eip712'].includes(parsed.kind)) scope.uintLeaves.set(path, parsed as LeafRule);
  return parsed;
}

const PACKABLE: readonly AbiType['kind'][] = ['address', 'uint', 'int', 'bool', 'fixed-bytes'];

const packedSize = (type: AbiType): number =>
  type.kind === 'address' ? ADDRESS_BYTES : type.kind === 'uint' || type.kind === 'int' ? type.bits / 8 : type.kind === 'fixed-bytes' ? type.size : 1;

function abiType(path: string, raw: unknown): AbiType {
  try {
    const [param, ...rest] = parseFunctionSignature(`t(${text(path, raw)})`).params;
    if (param === undefined || rest.length > 0) throw new TemplateError(path, 'not one type');
    return param.type;
  } catch (error) {
    if (error instanceof AbiSignatureError) throw new TemplateError(path, error.message);
    throw error;
  }
}

function packed(path: string, raw: unknown, scope: Scope): Rule {
  const names = new Set<string>();
  const parts = array(path, raw).map((item, i): PackedPart => {
    const at = `${path}[${i}]`;
    const value = object(at, item);
    exactKeys(at, value, ['name', 'type', 'rule']);
    const name = text(`${at}.name`, value.name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) throw new TemplateError(`${at}.name`, 'not an identifier, or named twice');
    names.add(name);
    const type = abiType(`${at}.type`, value.type);
    if (!PACKABLE.includes(type.kind)) throw new TemplateError(`${at}.type`, `${canonicalType(type)} is not a fixed-size part`);
    return { name, type, size: packedSize(type), rule: recipientWord(`${path}.${name}`, name, type, rule(`${path}.${name}`, value.rule, type, scope)) };
  });
  if (parts.length === 0) throw new TemplateError(path, 'no parts');
  return { kind: 'packed', parts };
}

function structType(path: string, raw: unknown): StructType {
  const written = text(path, raw);
  let fn: AbiFunction;
  try {
    fn = parseFunctionSignature(written);
  } catch (error) {
    if (error instanceof AbiSignatureError) throw new TemplateError(path, error.message);
    throw error;
  }
  const bad = fn.params.find((param, i) => param.name === undefined || !isMemberType(param.type) || fn.params.findIndex((p) => p.name === param.name) !== i);
  if (bad !== undefined || fn.params.length === 0) throw new TemplateError(path, 'every member is named once, of an atomic type, string or bytes');
  const encoded = `${fn.name}(${fn.params.map((param) => `${canonicalType(param.type)} ${param.name}`).join(',')})`;
  if (encoded !== written) throw new TemplateError(path, `not written as EIP-712 encodes it: ${encoded}`);
  return { name: fn.name, members: fn.params, encoded };
}

function signedMessage(path: string, raw: unknown, scope: Scope): Rule {
  const value = object(path, raw);
  exactKeys(path, value, ['domain', 'type', 'fields', 'lookup'], ['answer']);
  const domain = object(`${path}.domain`, value.domain);
  exactKeys(`${path}.domain`, domain, ['name', 'version', 'verifyingContract']);
  const verifyingContract = text(`${path}.domain.verifyingContract`, domain.verifyingContract);
  const entry = scope.registry.entries.get(verifyingContract);
  if (entry === undefined) throw new TemplateError(`${path}.domain.verifyingContract`, `${JSON.stringify(verifyingContract)} is not in the contract registry`);
  const name = text(`${path}.domain.name`, domain.name);
  const version = text(`${path}.domain.version`, domain.version);
  const lookup = text(`${path}.lookup`, value.lookup);
  if (lookup.split('{arg}').length !== 2 || parseHttpsUrl(lookup.replace('{arg}', '0x00')) === undefined) {
    throw new TemplateError(`${path}.lookup`, 'an https URL holding {arg} once');
  }
  const struct = structType(`${path}.type`, value.type);
  const fields = params(`${path}.fields`, value.fields, struct.members, { ...scope, inMessage: true });
  const answer = value.answer === undefined ? ownNames(struct) : messageAnswer(`${path}.answer`, value.answer, struct);
  return {
    kind: 'eip712',
    message: { domain: { name, version, verifyingContract }, separator: domainSeparator({ name, version, verifyingContract: entry.address }), struct, fields, lookup, answer },
  };
}

function pathSteps(path: string, raw: unknown): ApiPathStep[] {
  const steps = array(path, raw);
  if (steps.length === 0 || steps.length > MAX_API_PATH_STEPS) throw new TemplateError(path, `not a list of 1 to ${MAX_API_PATH_STEPS} steps`);
  steps.forEach((step, i) => {
    if (!isApiPathStep(step)) throw new TemplateError(`${path}[${i}]`, 'not a key of letters, digits and _ or an index below 10000');
  });
  return steps as ApiPathStep[];
}

/** Where a `lookup` answer holds the message: an optional `path` to its object and, per member, its own `path` and `encoding`. */
function messageAnswer(path: string, raw: unknown, struct: StructType): MessageAnswer {
  const value = object(path, raw);
  exactKeys(path, value, [], ['path', 'members']);
  if (value.path === undefined && value.members === undefined) throw new TemplateError(path, 'names a path, members, or both');
  const declared = value.members === undefined ? {} : object(`${path}.members`, value.members);
  if (value.members !== undefined && Object.keys(declared).length === 0) throw new TemplateError(`${path}.members`, 'names no member');
  const unknown = Object.keys(declared).find((name) => !struct.members.some((member) => member.name === name));
  if (unknown !== undefined) throw new TemplateError(`${path}.members.${unknown}`, `not a member of ${struct.name}`);
  const members = struct.members.map((member, i): MemberSource => {
    const name = member.name as string;
    const own = ownNames(struct).members[i] as MemberSource;
    if (!Object.hasOwn(declared, name)) return own;
    const at = `${path}.members.${name}`;
    const source = object(at, declared[name]);
    exactKeys(at, source, [], ['path', 'encoding']);
    if (source.path === undefined && source.encoding === undefined) throw new TemplateError(at, 'names a path, an encoding, or both');
    if (source.encoding !== undefined && (source.encoding !== 'hex' || member.type.kind !== 'uint')) throw new TemplateError(`${at}.encoding`, '"hex", on a uintN member only');
    const read: MemberSource = { path: source.path === undefined ? own.path : pathSteps(`${at}.path`, source.path), encoding: source.encoding === undefined ? 'plain' : 'hex' };
    if (read.encoding === 'plain' && read.path.length === 1 && read.path[0] === name) throw new TemplateError(at, 'names nothing the default does not');
    return read;
  });
  return { path: value.path === undefined ? [] : pathSteps(`${path}.path`, value.path), members };
}

function parseRule(path: string, raw: unknown, type: AbiType, scope: Scope): Rule {
  const value = object(path, raw);
  const keys = Object.keys(value);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined) {
    throw new TemplateError(path, 'a rule has exactly one of card, safe, contract, addressWord, ownerBefore, const, free, withinSeconds, equals, atLeast, atMost, maxSharePrice, minSharePrice, call, encoded, keccak, items, fields, packed, eip712');
  }
  const body = value[key];
  const at = `${path}.${key}`;
  const cannotBind = () => new TemplateError(path, `a ${key} rule cannot bind a ${canonicalType(type)}`);
  const needs = (kinds: readonly AbiType['kind'][]) => {
    if (!kinds.includes(type.kind)) throw cannotBind();
  };
  switch (key) {
    case 'card': {
      const ref = cardRef(at, text(at, body), scope.card, scope.registry);
      const resolves = refType(ref, scope.card);
      if (resolves === 'market') {
        if (!isMarketParams(type)) throw new TemplateError(path, `a whole market binds only a (address,address,address,address,uint256) tuple, not a ${canonicalType(type)}`);
        return { kind: 'fields', fields: MARKET_PARAMS.map((part): Rule => ({ kind: 'card', ref: { field: ref.field, attribute: part } })) };
      }
      if (!binds(resolves, type)) throw cannotBind();
      return { kind: 'card', ref };
    }
    case 'safe':
      if (body !== true) throw new TemplateError(at, 'must be true');
      needs(['address']);
      return { kind: 'safe' };
    case 'contract': {
      const name = text(at, body);
      if (!scope.registry.entries.has(name)) throw new TemplateError(at, `${JSON.stringify(name)} is not in the contract registry`);
      needs(['address']);
      return { kind: 'contract', name };
    }
    case 'addressWord': {
      if (type.kind !== 'fixed-bytes' || type.size !== 32) throw cannotBind();
      const inner = parseRule(at, body, { kind: 'address' }, scope);
      if (inner.kind !== 'card' && inner.kind !== 'safe' && inner.kind !== 'contract') throw new TemplateError(at, 'holds one card, safe or contract rule');
      return { kind: 'address-word', rule: inner };
    }
    case 'ownerBefore': {
      needs(['address']);
      return { kind: 'owner-before', ref: ownerRef(at, body, scope.card) };
    }
    case 'const': {
      const constant = constValue(at, body, type);
      if (constant.kind === 'address' && BigInt(constant.value) !== 0n) {
        throw new TemplateError(at, 'a constant address must be the zero address; bind any other with contract, from the registry');
      }
      if (constant.kind === 'bytes' && (constant.value.length - 2) / 2 > MAX_TRAILER) throw new TemplateError(at, `a constant bytes holds at most ${MAX_TRAILER} bytes, so no whole address fits`);
      if (constant.kind === 'string' && !scope.inMessage && !TAG.test(text(at, body))) throw new TemplateError(at, `a constant string outside a signed message is a tag of at most ${MAX_TAG} printable ASCII characters`);
      return { kind: 'const', value: constant };
    }
    case 'free': {
      const freed = free(at, body, type);
      if (scope.inMessage && freed.kind === 'free' && freed.claim !== 'scalar') throw new TemplateError(at, 'a member of a signed message is free only as a number, a bool or bytesN');
      return freed;
    }
    case 'withinSeconds':
      needs(['uint', 'int']);
      if (typeof body !== 'number' || !Number.isInteger(body) || body < 1 || body > MAX_WITHIN_SECONDS) {
        throw new TemplateError(at, `a whole number of seconds from 1 to ${MAX_WITHIN_SECONDS} (365 days)`);
      }
      return { kind: 'within-seconds', seconds: BigInt(body) };
    case 'atLeast':
    case 'atMost': {
      needs(['uint']);
      const field = cardFieldName(text(at, body));
      if (field === undefined || scope.card.get(field)?.kind !== 'amount') throw new TemplateError(at, `${JSON.stringify(body)} is not card.<amount field>`);
      return { kind: key === 'atLeast' ? 'at-least' : 'at-most', field };
    }
    case 'packed':
      needs(['bytes']);
      if (scope.inMessage) throw cannotBind();
      return packed(at, body, scope);
    case 'eip712':
      if (type.kind !== 'fixed-bytes' || type.size !== 32 || scope.inMessage) throw cannotBind();
      return signedMessage(at, body, scope);
    case 'equals': {
      const quantityAt = quantity(at, body, scope);
      if (quantityAt.kind !== 'path' || type.kind !== 'uint') throw new TemplateError(at, 'must name the path of an earlier uint argument, on a uint');
      return { kind: 'equals', path: quantityAt.path, rule: quantityAt.rule };
    }
    case 'maxSharePrice':
      return sharePrice(at, body, type, scope, 'max');
    case 'minSharePrice':
      return sharePrice(at, body, type, scope, 'min');
    case 'call':
      needs(['bytes']);
      if (scope.inMessage) throw cannotBind();
      return { kind: 'call', call: callNode(at, body, scope) };
    case 'encoded':
      needs(['bytes']);
      if (scope.inMessage) throw cannotBind();
      return { kind: 'call', call: encodedNode(at, body, scope) };
    case 'keccak': {
      if (!scope.view) throw new TemplateError(at, "binds only a view's argument");
      if (type.kind !== 'fixed-bytes' || type.size !== 32) throw cannotBind();
      const inner = rule(at, body, { kind: 'bytes' }, scope);
      if (inner.kind !== 'call') throw new TemplateError(at, 'must hold one call or encoded rule');
      return { kind: 'keccak', call: inner.call };
    }
    case 'items': {
      if (type.kind !== 'array' && type.kind !== 'fixed-array') throw cannotBind();
      const items = array(at, body);
      if (type.kind === 'fixed-array' && items.length !== type.length) throw new TemplateError(at, `${canonicalType(type)} needs ${type.length} items`);
      return { kind: 'items', items: items.map((item, i) => rule(`${at}[${i}]`, item, type.item, scope)) };
    }
    case 'fields': {
      if (type.kind !== 'tuple') throw cannotBind();
      return { kind: 'fields', fields: params(at, body, type.components, scope) };
    }
    default:
      throw new TemplateError(at, 'not a rule');
  }
}

/** Rules keyed by parameter name (its index when unnamed), or a list by position. Every parameter needs one. */
function params(path: string, raw: unknown, list: readonly AbiParam[], scope: Scope): Rule[] {
  if (Array.isArray(raw)) {
    if (raw.length !== list.length) throw new TemplateError(path, `${list.length} rules needed, ${raw.length} given`);
    return list.map((param, i) => recipientWord(`${path}[${i}]`, param.name, param.type, rule(`${path}[${i}]`, raw[i], param.type, scope)));
  }
  const value = object(path, raw);
  exactKeys(path, value, list.map(paramName));
  return list.map((param, i) => {
    const at = `${path}.${paramName(param, i)}`;
    return recipientWord(at, param.name, param.type, rule(at, value[paramName(param, i)], param.type, scope));
  });
}

const RECIPIENT_NAME = /^_?to$|recipient$|receiver$|beneficiary$/i;

/** A `bytes32` named as a recipient holds an address as a word, so it is never free or a constant other than zero. */
function recipientWord(path: string, name: string | undefined, type: AbiType, parsed: Rule): Rule {
  if (name === undefined || type.kind !== 'fixed-bytes' || type.size !== 32 || !RECIPIENT_NAME.test(name)) return parsed;
  if (parsed.kind === 'free' || (parsed.kind === 'const' && BigInt(parsed.value.value as Hex) !== 0n)) {
    throw new TemplateError(path, `${name} names a recipient, whose address a bytes32 holds as a word; bind it with {"addressWord": {"card": ...}}, {"addressWord": {"safe": true}} or {"addressWord": {"contract": ...}}`);
  }
  return parsed;
}

function signature(path: string, raw: unknown): AbiFunction {
  try {
    return parseFunctionSignature(text(path, raw));
  } catch (error) {
    if (error instanceof AbiSignatureError) throw new TemplateError(path, error.message);
    throw error;
  }
}

/** The longest trailer a call may allow to a registry contract whose entry declares it never reads past its arguments. */
const MAX_IGNORED_TRAILER = 64;

/** `upTo` is how long a trailer this call may allow: 19 bytes, or more for a target that declares it reads none. */
function trailer(path: string, raw: unknown, upTo: number = MAX_TRAILER): TrailerAllowance | undefined {
  if (raw === undefined) return undefined;
  const value = object(path, raw);
  exactKeys(path, value, ['maxBytes', 'why']);
  const maxBytes = value.maxBytes;
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > upTo) {
    const longer = upTo === MAX_TRAILER ? `; more only on a call to a registry contract that declares ignoresTrailer, up to ${MAX_IGNORED_TRAILER}` : '';
    throw new TemplateError(`${path}.maxBytes`, `an integer from 1 to ${upTo}${longer}`);
  }
  return { maxBytes, why: prose(`${path}.why`, value.why) };
}

function callNode(path: string, raw: unknown, scope: Scope, trailerUpTo?: number): CallNode {
  const value = object(path, raw);
  exactKeys(path, value, ['function', 'args'], ['trailer']);
  const fn = signature(`${path}.function`, value.function);
  return { encoding: 'call', fn, args: params(`${path}.args`, value.args, fn.params, scope), trailer: trailer(`${path}.trailer`, value.trailer, trailerUpTo) };
}

/** `as` names the parameters the bytes hold, such as `V4_SWAP(bytes actions, bytes[] params)`; no trailer is allowed. */
function encodedNode(path: string, raw: unknown, scope: Scope): CallNode {
  const value = object(path, raw);
  exactKeys(path, value, ['as', 'args']);
  const fn = signature(`${path}.as`, value.as);
  return { encoding: 'params', fn, args: params(`${path}.args`, value.args, fn.params, scope), trailer: undefined };
}

/**
 * A merged call must be the template's last, to a named contract, with a constant value and every argument an array
 * bound by items, each with the same number of items: the operations sharing it put their items in, item by item across
 * the arrays, as the Merkl distributor takes parallel `users`, `tokens`, `amounts` and `proofs`. Only those items can
 * differ between them.
 */
function mergeReason(path: string, raw: unknown, call: TemplateCall, last: boolean): Prose | undefined {
  if (raw === undefined) return undefined;
  const why = prose(path, raw);
  const data = call.data === 'empty' ? undefined : call.data;
  if (!last) throw new TemplateError(path, 'only the last call may merge');
  if (call.to.kind !== 'contract' || call.value.kind !== 'const') throw new TemplateError(path, 'a merged call needs a contract target and a constant value');
  const counts = new Set(data?.args.map((arg) => (arg.kind === 'items' ? arg.items.length : -1)));
  if (data === undefined || data.args.length === 0 || counts.has(-1) || counts.size !== 1) {
    throw new TemplateError(path, 'every argument of a merged call is bound by items, with as many items in each');
  }
  return why;
}

function templateCall(path: string, raw: unknown, scope: Scope, last: boolean): TemplateCall {
  const { merge, ...value } = object(path, raw);
  const { to, value: amount, ...call } = value;
  let data: TemplateCall['data'];
  if (Object.hasOwn(call, 'data')) {
    exactKeys(path, value, ['to', 'value', 'data']);
    if (call.data !== 'empty') throw new TemplateError(`${path}.data`, 'must be "empty"; a call with data names its function and args');
    data = 'empty';
  } else {
    exactKeys(path, value, ['to', 'value', 'function', 'args'], ['trailer']);
    // A contract that reads its caller from calldata's last 20 bytes (ERC-2771) would read a longer trailer as an address.
    const target = typeof to === 'object' && to !== null && 'contract' in to ? scope.registry.entries.get(String((to as Json).contract)) : undefined;
    data = callNode(path, call, scope, target?.ignoresTrailer === undefined ? MAX_TRAILER : MAX_IGNORED_TRAILER);
  }
  const parsed = {
    to: rule(`${path}.to`, to, { kind: 'address' }, scope),
    value: rule(`${path}.value`, amount, { kind: 'uint', bits: 256 }, scope),
    data,
  };
  return { ...parsed, merge: mergeReason(`${path}.merge`, merge, { ...parsed, merge: undefined }, last) };
}

/** A field's parser waits for the full field list, since `amount.of` may name a field declared after it. */
function cardField(path: string, raw: unknown, registry: Registry): (fields: CardFields) => CardField {
  const value = object(path, raw);
  switch (value.kind) {
    case 'contract': {
      exactKeys(path, value, ['kind', 'registryKind'], ['defillama', 'marketPart']);
      const registryKind = CONTRACT_KINDS.find((k) => k === value.registryKind);
      if (registryKind === undefined) throw new TemplateError(`${path}.registryKind`, `not one of ${CONTRACT_KINDS.join(', ')}`);
      const marketPart = value.marketPart === undefined ? undefined : MARKET_ENTRY_PARTS.find((part) => part === value.marketPart);
      if (value.marketPart !== undefined && marketPart === undefined) throw new TemplateError(`${path}.marketPart`, `not one of ${MARKET_ENTRY_PARTS.join(', ')}`);
      if (marketPart !== undefined && MARKET_ENTRIES[marketPart] !== registryKind) throw new TemplateError(`${path}.marketPart`, `a market's ${marketPart} is of kind ${MARKET_ENTRIES[marketPart]}, not ${registryKind}`);
      const scope = { registryKind, protocol: value.defillama === undefined ? undefined : text(`${path}.defillama`, value.defillama), marketPart };
      if (scope.protocol !== undefined && scopeEntries({ ...scope, marketPart: undefined }, registry).length === 0) {
        throw new TemplateError(`${path}.defillama`, `no registry ${registryKind} belongs to the DefiLlama protocol ${JSON.stringify(scope.protocol.slice(0, 80))}`);
      }
      if (marketPart !== undefined && scopeEntries(scope, registry).length === 0) throw new TemplateError(`${path}.marketPart`, `no registry ${registryKind} this field accepts is the ${marketPart} of a market in ${MARKETS_PATH}`);
      return () => ({ kind: 'contract', scope });
    }
    case 'amount': {
      exactKeys(path, value, ['kind', 'of'], ['computed', 'max', 'floor']);
      const of = text(`${path}.of`, value.of);
      if (value.computed !== undefined && value.max !== undefined) throw new TemplateError(`${path}.max`, 'a computed field is never typed, so it has no max');
      const max = value.max === undefined ? undefined : amountMax(`${path}.max`, value.max);
      for (const key of ['computed', 'max']) if (value.floor !== undefined && value[key] !== undefined) throw new TemplateError(`${path}.floor`, `beside ${key}; a floor is computed or typed by the rule of its token pair`);
      return (fields) => ({ kind: 'amount', of: of === 'eth' ? 'eth' : cardToken(`${path}.of`, of, fields, registry), computed: undefined, max });
    }
    case 'percent':
      exactKeys(path, value, ['kind']);
      return () => ({ kind: 'percent' });
    case 'address':
      exactKeys(path, value, ['kind']);
      return () => ({ kind: 'address' });
    case 'recipient':
      exactKeys(path, value, ['kind']);
      return () => ({ kind: 'recipient' });
    case 'nonce':
      exactKeys(path, value, ['kind']);
      return () => ({ kind: 'nonce' });
    case 'owner':
      exactKeys(path, value, ['kind']);
      return () => ({ kind: 'owner' });
    case 'threshold':
      exactKeys(path, value, ['kind']);
      return () => ({ kind: 'threshold' });
    case 'market':
      exactKeys(path, value, ['kind']);
      return () => ({ kind: 'market' });
    default:
      throw new TemplateError(`${path}.kind`, 'not one of contract, amount, percent, address, recipient, nonce, owner, threshold, market');
  }
}

function amountMax(path: string, raw: unknown): AmountMax {
  const value = object(path, raw);
  exactKeys(path, value, ['value', 'why']);
  const number = constValue(`${path}.value`, value.value, { kind: 'uint', bits: 256 });
  return { value: number.value as bigint, why: prose(`${path}.why`, value.why) };
}

const MAX_BPS = 1000;

/** A registry contract a contract or market field names, which `card new` resolves exactly as `card seal` does. */
const isContractRef = (ref: CardRef, card: CardFields): boolean => ['contract', 'market'].includes(card.get(ref.field)?.kind ?? '') && refType(ref, card) === 'address';

/** Control and bidirectional characters, which could rewrite what the signer's terminal shows. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function bps(path: string, raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_BPS) throw new TemplateError(path, `not a whole number of basis points from 0 to ${MAX_BPS}`);
  return raw;
}

/**
 * The fields a computed field may read from: each field declared before it, and each field declared after it that is not
 * computed, since every typed and chosen value is known before any computed one is read.
 */
type Readable = (field: string) => boolean;

/**
 * The older form of a computed read's `to` and arguments, which a template written before reads took rules may still hold
 * and a verdict file of that time does: `"card.<field>"` is `{ "card": "<field>" }`, `"safe"` is `{ "safe": true }`, and a
 * read written without `read` around it is `{ "read": ... }`. Nothing else is read as the older form.
 */
function olderReadForm(raw: unknown): unknown {
  if (raw === 'safe') return { safe: true };
  const field = typeof raw === 'string' ? cardFieldName(raw) : undefined;
  if (field !== undefined) return { card: field };
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'to' in raw && !('read' in raw)) return { read: raw };
  return raw;
}

function computedArg(path: string, raw: unknown, { name, type }: AbiParam, scope: Scope, readable: Readable): ComputedArg {
  const value = object(path, olderReadForm(raw));
  if (value.read !== undefined) {
    exactKeys(path, value, ['read']);
    const read = computedRead(`${path}.read`, value.read, scope, readable);
    const answer = computedOutput(read).param.type as Extract<AbiType, { kind: 'uint' }>;
    if (type.kind !== 'uint' || type.bits < answer.bits) throw new TemplateError(`${path}.read`, `answers a uint${answer.bits}, which a ${canonicalType(type)} parameter cannot hold`);
    return { kind: 'read', read };
  }
  const bound = rule(path, value, type, scope);
  boundArgument(path, bound);
  wholeCardNumbers(path, bound, type);
  for (const leaf of ruleLeaves(bound)) if (leaf.kind === 'card') readableRef(path, leaf.ref, readable);
  return { kind: 'bound', rule: recipientWord(path, name, type, bound) };
}

/** A card number, never range-checked against its parameter, is passed to a read only as a whole uint256. */
function wholeCardNumbers(path: string, bound: Rule, type: AbiType): void {
  if (bound.kind === 'card' && (type.kind === 'uint' || type.kind === 'int') && !(type.kind === 'uint' && type.bits === 256)) {
    throw new TemplateError(path, `card.${bound.ref.field}${bound.ref.attribute === undefined ? '' : `.${bound.ref.attribute}`} is a number passed whole, so only to a uint256, not a ${canonicalType(type)}`);
  }
  if (bound.kind === 'fields' && type.kind === 'tuple') bound.fields.forEach((field, i) => wholeCardNumbers(path, field, (type.components[i] as AbiParam).type));
  if (bound.kind === 'items' && (type.kind === 'array' || type.kind === 'fixed-array')) bound.items.forEach((item) => wholeCardNumbers(path, item, type.item));
  if (bound.kind === 'call' || bound.kind === 'keccak') bound.call.args.forEach((arg, i) => wholeCardNumbers(path, arg, (bound.call.fn.params[i] as AbiParam).type));
}

function readableRef(path: string, ref: CardRef, readable: Readable): void {
  if (!readable(ref.field)) throw new TemplateError(path, `card field ${ref.field} is computed after this one or is this one`);
}

/** Positions of the unsigned number `raw` names in `returns`, by a dotted path of names; none is needed for one value. */
function outputPath(path: string, raw: unknown, returns: readonly AbiParam[]): number[] {
  if (raw === undefined && returns.length !== 1) throw new TemplateError(path, `names none of the ${returns.length} values the function returns`);
  const output = raw === undefined ? [0] : [];
  let params = returns;
  for (const step of raw === undefined ? [] : text(path, raw).split('.')) {
    const i = params.findIndex((param) => param.name === step);
    if (i === -1) throw new TemplateError(path, `${JSON.stringify(step)} is not a named return value or tuple component`);
    output.push(i);
    const { type } = params[i] as AbiParam;
    params = type.kind === 'tuple' ? type.components : [];
  }
  const { type } = computedOutput({ returns, output }).param;
  if (type.kind !== 'uint') throw new TemplateError(path, `picks a value of type ${canonicalType(type)}; a computed amount is an unsigned integer`);
  return output;
}

function computedRead(path: string, raw: unknown, scope: Scope, readable: Readable): ComputedRead {
  const value = object(path, raw);
  exactKeys(path, value, ['to', 'function', 'args'], ['output']);
  const target = parseRule(`${path}.to`, typeof value.to === 'string' ? olderReadForm(value.to) : value.to, { kind: 'address' }, scope);
  let to: ViewTarget;
  if (target.kind === 'contract') to = { kind: 'contract', name: target.name };
  else if (target.kind === 'card' && isContractRef(target.ref, scope.card)) to = { kind: 'card', ref: target.ref };
  else throw new TemplateError(`${path}.to`, 'must name a registry contract, or a contract or market field or one of its parts');
  if (to.kind === 'card') readableRef(`${path}.to`, to.ref, readable);
  const { fn, returns } = viewSignature(`${path}.function`, value.function);
  const args = object(`${path}.args`, value.args);
  exactKeys(`${path}.args`, args, fn.params.map((param, i) => paramName(param, i)));
  return {
    to,
    fn,
    args: fn.params.map((param, i) => computedArg(`${path}.args.${paramName(param, i)}`, args[paramName(param, i)], param, scope, readable)),
    returns,
    output: outputPath(`${path}.output`, value.output, returns),
  };
}

/** A computed amount field, `computed` of card field `name`; `order` lists the card's fields with whether each is computed. */
function computed(path: string, raw: unknown, name: string, scope: Scope, order: readonly (readonly [string, boolean])[]): Computed {
  const value = object(path, raw);
  exactKeys(path, value, ['read', 'bound', 'default'], ['margin']);
  const at = order.findIndex(([field]) => field === name);
  const readable: Readable = (field) => {
    const i = order.findIndex(([f]) => f === field);
    return i !== at && (i < at || !(order[i]?.[1] ?? false));
  };
  const read = computedRead(`${path}.read`, value.read, { ...scope, uintLeaves: new Map(), view: true }, readable);
  if (value.bound !== 'floor' && value.bound !== 'ceiling') throw new TemplateError(`${path}.bound`, 'not one of floor, ceiling');
  const fallback = object(`${path}.default`, value.default);
  exactKeys(`${path}.default`, fallback, ['bps', 'source']);
  const source = parseHttpsUrl(fallback.source);
  if (source === undefined) throw new TemplateError(`${path}.default.source`, 'not an https URL');
  let margin: Computed['margin'];
  if (value.margin !== undefined) {
    const m = object(`${path}.margin`, value.margin);
    exactKeys(`${path}.margin`, m, ['bps', 'why']);
    margin = { bps: bps(`${path}.margin.bps`, m.bps), why: prose(`${path}.margin.why`, m.why) };
  }
  return { read, bound: value.bound, default: { bps: bps(`${path}.default.bps`, fallback.bps), source }, margin };
}

/** An amount field's `floor`: what it sells is another typed amount, and both count a token a card field picks from the registry. */
function floor(path: string, raw: unknown, name: string, fields: CardFields): Floor {
  const value = object(path, raw);
  exactKeys(path, value, ['sells']);
  const sells = text(`${path}.sells`, value.sells);
  const [sold, own] = [fields.get(sells), fields.get(name)];
  if (sells === name || sold?.kind !== 'amount' || sold.computed !== undefined || sold.floor !== undefined) throw new TemplateError(`${path}.sells`, `${JSON.stringify(sells)} is not another amount field the signer types`);
  const picked = (field: CardField | undefined): boolean => {
    if (field?.kind !== 'amount' || field.of === 'eth' || field.of.attribute !== undefined) return false;
    const token = fields.get(field.of.field);
    return token?.kind === 'contract' && (token.scope.registryKind === 'token' || token.scope.registryKind === 'vault');
  };
  if (!picked(own)) throw new TemplateError(path, 'the amount does not count a token a card field picks');
  if (!picked(sold)) throw new TemplateError(`${path}.sells`, `${sells} does not count a token a card field picks`);
  return { sells };
}

/** `card.<field>` with the prefix removed, or undefined when `raw` lacks it. */
const cardFieldName = (raw: string): string | undefined => (raw.startsWith('card.') ? raw.slice(5) : undefined);

function tolerance(path: string, raw: unknown): Tolerance {
  const value = object(path, raw);
  exactKeys(path, value, ['why'], ['less', 'more']);
  if (value.less === undefined && value.more === undefined) throw new TemplateError(path, 'names neither less nor more');
  const units = (side: 'less' | 'more'): bigint => {
    const n = value[side];
    if (n === undefined) return 0n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_TOLERANCE) throw new TemplateError(`${path}.${side}`, `not a whole number of base units from 1 to ${MAX_TOLERANCE}`);
    return BigInt(n);
  };
  return { less: units('less'), more: units('more'), why: prose(`${path}.why`, value.why) };
}

/** A registry token by name: an entry of kind `token` or `vault`, which holds balances. */
function registryToken(path: string, name: string, registry: Registry): string {
  const entry = registry.entries.get(name);
  if (entry === undefined) throw new TemplateError(path, `${JSON.stringify(name)} is not in the contract registry`);
  if (entry.kind !== 'token' && entry.kind !== 'vault') throw new TemplateError(path, `${name} is a ${entry.kind}, not a token or a vault`);
  return name;
}

function effect(path: string, raw: unknown, scope: Scope, side: 'gives' | 'gets'): Effect {
  const value = object(path, raw);
  exactKeys(path, value, ['token', 'amount'], side === 'gives' ? ['to', 'tolerance'] : ['tolerance']);
  const token = text(`${path}.token`, value.token);
  const field = cardFieldName(token);
  const ref: EffectToken = token === 'eth' ? 'eth' : field === undefined ? { contract: registryToken(`${path}.token`, token, scope.registry) } : cardToken(`${path}.token`, field, scope.card, scope.registry);
  let to: CardRef | undefined;
  if (value.to !== undefined) {
    const name = cardFieldName(text(`${path}.to`, value.to)) ?? '';
    if (!['address', 'recipient'].includes(scope.card.get(name)?.kind ?? '')) throw new TemplateError(`${path}.to`, 'must be card.<address field>');
    to = { field: name, attribute: undefined };
  }
  const amount = effectAmount(`${path}.amount`, value.amount, scope, side);
  if (value.tolerance !== undefined && (amount.kind !== 'card' || ref === 'eth')) throw new TemplateError(`${path}.tolerance`, 'only an exact card amount of a token takes a tolerance');
  return { token: ref, amount, to, tolerance: value.tolerance === undefined ? undefined : tolerance(`${path}.tolerance`, value.tolerance) };
}

function effectAmount(path: string, raw: unknown, scope: Scope, side: 'gives' | 'gets'): EffectAmount {
  const bound = side === 'gives' ? 'atMost' : 'atLeast';
  if (typeof raw === 'object' && raw !== null) {
    const value = object(path, raw);
    exactKeys(path, value, [bound]);
    const field = cardFieldName(text(`${path}.${bound}`, value[bound])) ?? '';
    if (scope.card.get(field)?.kind !== 'amount') throw new TemplateError(`${path}.${bound}`, 'must be card.<amount field>');
    return { kind: side === 'gives' ? 'at-most' : 'at-least', field };
  }
  const amount = text(path, raw);
  if (amount === 'positive') return { kind: 'positive' };
  if (amount === 'all' && side === 'gives') return { kind: 'all' };
  if (amount === 'any' && side === 'gets') return { kind: 'any' };
  const field = cardFieldName(amount) ?? '';
  if (scope.card.get(field)?.kind !== 'amount') {
    throw new TemplateError(path, side === 'gives' ? 'must be "positive", "all", card.<amount field> or {"atMost": card.<amount field>}' : 'must be "positive", "any", card.<amount field> or {"atLeast": card.<amount field>}');
  }
  return { kind: 'card', field };
}

function touch(path: string, raw: unknown, scope: Scope, moved: ReadonlySet<string>): Touch {
  const value = object(path, raw);
  exactKeys(path, value, ['token', 'tolerance']);
  const token = registryToken(`${path}.token`, text(`${path}.token`, value.token), scope.registry);
  if (moved.has(token)) throw new TemplateError(`${path}.token`, `${token} is named in gives, gets or touches already`);
  return { token, tolerance: tolerance(`${path}.tolerance`, value.tolerance) };
}

function keptApproval(path: string, raw: unknown, scope: Scope): KeptApproval {
  const value = object(path, raw);
  exactKeys(path, value, ['token', 'spender', 'amount'], ['via']);
  const field = cardFieldName(text(`${path}.token`, value.token));
  if (field === undefined) throw new TemplateError(`${path}.token`, 'must be card.<field>');
  const token = cardToken(`${path}.token`, field, scope.card, scope.registry);
  const spender = text(`${path}.spender`, value.spender);
  const entry = scope.registry.entries.get(spender);
  if (entry === undefined) throw new TemplateError(`${path}.spender`, `${JSON.stringify(spender)} is not in the contract registry`);
  const via = value.via === undefined ? 'erc20' : (['erc20', 'permit2'] as const).find((route) => route === value.via);
  if (via === undefined) throw new TemplateError(`${path}.via`, 'not one of erc20, permit2');
  const amount = text(`${path}.amount`, value.amount);
  if (amount === 'unlimited') {
    if (entry.standingAllowance?.via !== via) throw new TemplateError(`${path}.amount`, `${spender} declares no standing allowance through ${via} in the registry, so none may stay unlimited`);
    return { token, spender, via, amount: { kind: 'unlimited' } };
  }
  const limit = cardFieldName(amount) ?? '';
  const counted = scope.card.get(limit);
  if (counted?.kind !== 'amount') throw new TemplateError(`${path}.amount`, 'must be "unlimited" or card.<amount field>');
  if (JSON.stringify(counted.of) !== JSON.stringify(token)) throw new TemplateError(`${path}.amount`, `counts another token than card.${field}`);
  return { token, spender, via, amount: { kind: 'card', field: limit } };
}

/**
 * A view's arguments are known before the transaction runs: bound by card, safe, contract or const, never free, and
 * encoded or hashed from such values.
 */
function boundArgument(path: string, rule: Rule): void {
  if (rule.kind === 'fields') rule.fields.forEach((field, i) => boundArgument(`${path}[${i}]`, field));
  else if (rule.kind === 'items') rule.items.forEach((item, i) => boundArgument(`${path}[${i}]`, item));
  else if (rule.kind === 'call' || rule.kind === 'keccak') rule.call.args.forEach((arg, i) => boundArgument(`${path}.${paramName(rule.call.fn.params[i] as AbiParam, i)}`, arg));
  else if (!['card', 'safe', 'contract', 'const'].includes(rule.kind)) throw new TemplateError(path, `a view's argument is bound by card, safe, contract or const, not ${rule.kind}`);
}

function viewSignature(path: string, raw: unknown): ReturnType<typeof parseViewSignature> {
  try {
    return parseViewSignature(text(path, raw));
  } catch (error) {
    if (error instanceof AbiSignatureError) throw new TemplateError(path, error.message);
    throw error;
  }
}

/** `to`, `function` and `args` of a view, as `effects.views` and `facts` write them; `to` is the rule as written. */
function boundView(path: string, value: Json, scope: Scope): Omit<BoundView, 'to'> & { readonly to: Rule } {
  const to = rule(`${path}.to`, value.to, { kind: 'address' }, scope);
  const { fn, returns } = viewSignature(`${path}.function`, value.function);
  const args = params(`${path}.args`, value.args, fn.params, { ...scope, view: true });
  args.forEach((arg, i) => boundArgument(`${path}.args.${paramName(fn.params[i] as AbiParam, i)}`, arg));
  return { to, fn, args, returns };
}

function view(path: string, raw: unknown, scope: Scope): ViewEffect {
  const value = object(path, raw);
  exactKeys(path, value, ['to', 'function', 'args', 'change']);
  const { to: rawTo, fn, args, returns } = boundView(path, value, scope);
  let to: ViewTarget;
  if (rawTo.kind === 'contract') to = { kind: 'contract', name: rawTo.name };
  else if (rawTo.kind === 'card' && scope.card.get(rawTo.ref.field)?.kind === 'contract') to = { kind: 'card', ref: rawTo.ref };
  else throw new TemplateError(`${path}.to`, 'must name a registry contract, or a contract card field or one of its attributes');
  const changes = Object.entries(object(`${path}.change`, value.change)).map(([name, change]) => {
    const at = `${path}.change.${name}`;
    const index = returns.findIndex((param) => param.name === name);
    const type = returns[index]?.type;
    if (type === undefined) throw new TemplateError(at, `not a named return value of ${fn.name}`);
    if (type.kind !== 'uint' && type.kind !== 'int') throw new TemplateError(at, `${canonicalType(type)} is not a number; only a number is judged`);
    const field = typeof change === 'string' ? cardFieldName(change) : undefined;
    if (field !== undefined) {
      const kind = scope.card.get(field)?.kind;
      if (kind !== 'amount' && kind !== 'percent') throw new TemplateError(at, `card.${field} is not an amount or percent field`);
      return { value: index, change: { equals: field } };
    }
    const known = VIEW_CHANGES.find((c) => c === change);
    if (known === undefined) throw new TemplateError(at, `not one of ${VIEW_CHANGES.join(', ')}, or card.<amount or percent field>`);
    return { value: index, change: known };
  });
  if (changes.length === 0) throw new TemplateError(`${path}.change`, 'names no return value');
  return { to, fn, args, returns, changes };
}

function fieldOfKind(path: string, raw: unknown, card: CardFields, kind: 'owner' | 'threshold'): CardRef {
  const name = cardFieldName(text(path, raw));
  if (name === undefined || card.get(name)?.kind !== kind) throw new TemplateError(path, `must be card.<${kind} field>`);
  return { field: name, attribute: undefined };
}

const ownerRef = (path: string, raw: unknown, card: CardFields): CardRef => fieldOfKind(path, raw, card, 'owner');

function safeSettings(path: string, raw: unknown, scope: Scope): SafeSettingsEffect {
  const value = object(path, raw);
  exactKeys(path, value, [], ['owners', 'threshold']);
  let owners: Json = {};
  if (value.owners !== undefined) {
    owners = object(`${path}.owners`, value.owners);
    exactKeys(`${path}.owners`, owners, [], ['add', 'remove']);
    if (owners.add === undefined && owners.remove === undefined) throw new TemplateError(`${path}.owners`, 'names neither add nor remove');
  }
  const add = owners.add === undefined ? undefined : ownerRef(`${path}.owners.add`, owners.add, scope.card);
  const remove = owners.remove === undefined ? undefined : ownerRef(`${path}.owners.remove`, owners.remove, scope.card);
  if (add !== undefined && add.field === remove?.field) throw new TemplateError(`${path}.owners`, 'adds and removes one card field');
  const threshold = value.threshold === undefined ? undefined : fieldOfKind(`${path}.threshold`, value.threshold, scope.card, 'threshold');
  if (add === undefined && remove === undefined && threshold === undefined) throw new TemplateError(path, 'declares no change');
  return { add, remove, threshold };
}

export function ruleLeaves(rule: Rule): Rule[] {
  if (rule.kind === 'fields') return rule.fields.flatMap(ruleLeaves);
  if (rule.kind === 'items') return rule.items.flatMap(ruleLeaves);
  if (rule.kind === 'call' || rule.kind === 'keccak') return rule.call.args.flatMap(ruleLeaves);
  return [rule];
}

function fact(path: string, raw: unknown, scope: Scope, protocols: ReadonlyMap<string, readonly RegistryEntry[]>): Fact {
  const value = object(path, raw);
  exactKeys(path, value, ['to', 'function', 'args', 'units'], ['ratio', 'reason']);
  const { to, ...rest } = boundView(path, value, scope);
  if (to.kind !== 'contract') throw new TemplateError(`${path}.to`, 'must name a registry contract');
  const view: BoundView = { ...rest, to: to.name };
  const slug = scope.registry.entries.get(view.to)?.defillama;
  if (slug === undefined || !protocols.has(slug)) {
    throw new TemplateError(`${path}.to`, `${view.to} is not a contract of a DefiLlama protocol a call targets (${[...protocols.keys()].join(', ') || 'none'}), so the report would show the fact under no protocol`);
  }
  const leaves = view.args.flatMap(ruleLeaves);
  if (leaves.some((rule) => rule.kind === 'safe')) throw new TemplateError(`${path}.args`, "a fact never reads the Safe's state");
  const fields = [...new Set(leaves.flatMap((rule) => (rule.kind === 'card' ? [rule.ref.field] : [])))];
  const [field] = fields;
  if (field === undefined || fields.length > 1) throw new TemplateError(`${path}.args`, `must name exactly one card field, not ${fields.length}`);
  const kind = scope.card.get(field)?.kind;
  if (kind !== 'contract' && kind !== 'market') throw new TemplateError(`${path}.args`, `card field ${field} is not a contract or a market field`);
  const units = Object.entries(object(`${path}.units`, value.units)).map(([name, raw]) => {
    const at = `${path}.units.${name}`;
    const index = view.returns.findIndex((param) => param.name === name);
    const type = view.returns[index]?.type;
    if (type === undefined) throw new TemplateError(at, `not a named return value of ${view.fn.name}`);
    if (type.kind !== 'uint' && type.kind !== 'int') throw new TemplateError(at, `${canonicalType(type)} is not a number; only a number is counted in a token`);
    const token = text(at, raw);
    if (token === 'eth') return { value: index, unit: 'eth' as const };
    const ref = cardFieldName(token);
    if (ref === undefined) throw new TemplateError(at, 'must be eth or card.<field>');
    const unit = cardToken(at, ref, scope.card, scope.registry);
    if (unit.field !== field) throw new TemplateError(at, `must be a token of card field ${field}, which the fact reads for`);
    return { value: index, unit };
  });
  const unnamed = view.returns.find((param) => param.name !== undefined && !units.some((u) => view.returns[u.value] === param));
  if (unnamed !== undefined) throw new TemplateError(`${path}.units`, `names no unit for ${unnamed.name}; leave a return value unnamed to leave it unshown`);
  let ratio: Fact['ratio'];
  if (value.ratio !== undefined) {
    const pair = array(`${path}.ratio`, value.ratio);
    const of = pair.map((name, i) => units.find((u) => view.returns[u.value]?.name === text(`${path}.ratio[${i}]`, name)));
    const [a, b] = of;
    if (pair.length !== 2 || a === undefined || b === undefined || a === b) throw new TemplateError(`${path}.ratio`, 'must name two different named return values');
    if (JSON.stringify(a.unit) !== JSON.stringify(b.unit)) throw new TemplateError(`${path}.ratio`, 'names two values counted in different tokens');
    ratio = [a.value, b.value];
  }
  const reason = value.reason === undefined ? undefined : prose(`${path}.reason`, value.reason);
  if ((ratio === undefined) !== (reason === undefined)) {
    throw new TemplateError(`${path}.reason`, ratio === undefined ? 'explains a ratio the fact does not name' : 'missing: say where the protocol defines the ratio');
  }
  return { ...view, field, units, ratio, reason };
}

/** The registry names a card reference can resolve to, in registry order. */
export function refNames(ref: CardRef, template: Template, registry: Registry): string[] {
  const field = template.card.get(ref.field);
  const { attribute } = ref;
  if (field?.kind === 'market') {
    return attribute !== undefined && isMarketEntryPart(attribute) ? [...new Set([...registry.markets.values()].map((m) => m[attribute].name))] : [];
  }
  if (field?.kind !== 'contract') return [];
  const candidates = scopeEntries(field.scope, registry);
  if (attribute === undefined) return candidates.map((e) => e.name);
  return [...new Set(candidates.flatMap((e) => e.attributes[attribute] ?? []))];
}

/** The registry names a rule binds an address to: a named contract, or the entries a card field can name; undefined for any other rule. */
export function targetNames(rule: Rule, template: Template, registry: Registry): string[] | undefined {
  if (rule.kind === 'address-word') return targetNames(rule.rule, template, registry);
  if (rule.kind === 'contract') return [rule.name];
  const names = rule.kind === 'card' ? refNames(rule.ref, template, registry) : [];
  return names.length > 0 ? names : undefined;
}

/** The registry names a view effect's contract can be: its named contract, or the entries its card field can name. */
export const viewTargetNames = (to: ViewTarget, template: Template, registry: Registry): string[] =>
  to.kind === 'contract' ? [to.name] : refNames(to.ref, template, registry);


/**
 * One function the template calls: `call` is its top-level call's index, `nested` whether it is a call inside that
 * call's arguments, such as a Bundler3 bundle item, and `names` the registry names its target can be: a call's `to`, or
 * for a call nested in a tuple, the tuple's one address field. Undefined when no call site binds its target.
 */
export type CallSite = { readonly call: number; readonly nested: boolean; readonly fn: AbiFunction; readonly names: readonly string[] | undefined };

/** Every function the template calls, each top-level call first and then the calls nested in its arguments. */
export function callSites(template: Template, registry: Registry): CallSite[] {
  const sites: CallSite[] = [];
  const visitCall = (call: number, node: CallNode, target: Rule | undefined, nested: boolean): void => {
    sites.push({ call, nested, fn: node.fn, names: target === undefined ? undefined : targetNames(target, template, registry) });
    node.fn.params.forEach((param, i) => visitArg(call, node.args[i] as Rule, param));
  };
  const visitArg = (call: number, rule: Rule, param: AbiParam | undefined): void => {
    if (rule.kind === 'call') visitCall(call, rule.call, undefined, true);
    if (rule.kind === 'items') {
      const item = param?.type.kind === 'array' || param?.type.kind === 'fixed-array' ? { name: undefined, type: param.type.item } : undefined;
      rule.items.forEach((r) => visitArg(call, r, item));
    }
    if (rule.kind === 'fields') {
      const components = param?.type.kind === 'tuple' ? param.type.components : [];
      const addresses = components.flatMap((c, i) => (c.type.kind === 'address' ? [rule.fields[i] as Rule] : []));
      const target = addresses.length === 1 ? addresses[0] : undefined;
      rule.fields.forEach((r, i) => (r.kind === 'call' ? visitCall(call, r.call, target, true) : visitArg(call, r, components[i])));
    }
  };
  template.calls.forEach((call, i) => {
    if (call.data !== 'empty') visitCall(i, call.data, call.to, false);
  });
  return sites;
}

/**
 * For each function, by signature, the registry names the template calls it on: a call's `to`, or for a call nested in
 * a tuple, such as a Bundler3 bundle item, the tuple's one address field. Absent when no call site binds its target.
 */
export function callTargets(template: Template, registry: Registry): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const { fn, names } of callSites(template, registry)) {
    if (names !== undefined) targets.set(fn.signature, [...new Set([...(targets.get(fn.signature) ?? []), ...names])]);
  }
  return targets;
}

/** The registry entries the template's calls go to, nested calls' targets included, in call order. */
export function callTargetEntries(template: Template, registry: Registry): RegistryEntry[] {
  const empty = template.calls.flatMap((call) => (call.data === 'empty' ? (targetNames(call.to, template, registry) ?? []) : []));
  const names = new Set([...callTargets(template, registry).values()].flat().concat(empty));
  return [...names].map((name) => registry.entries.get(name) as RegistryEntry);
}

/**
 * The DefiLlama protocols the template's calls go to, each with its call targets, an entry with a `factory` under its
 * factory's protocol; a token's issuer is not such a protocol.
 */
export function calledProtocols(template: Template, registry: Registry): ReadonlyMap<string, readonly RegistryEntry[]> {
  const protocols = new Map<string, RegistryEntry[]>();
  for (const entry of callTargetEntries(template, registry)) {
    const { slug } = protocolOf(entry, registry);
    if (entry.kind !== 'token' && slug !== undefined) protocols.set(slug, [...(protocols.get(slug) ?? []), entry]);
  }
  return protocols;
}

export function parseTemplate(raw: unknown, registry: Registry): Template {
  const value = object('template', raw);
  exactKeys('template', value, ['id', 'card', 'calls', 'effects'], ['nonce', 'same', 'facts', 'instanceField']);
  const id = text('id', value.id);
  if (!ID.test(id)) throw new TemplateError('id', 'not <protocol>/<operation>');
  const pending = Object.entries(object('card', value.card)).map(([name, field]) => {
    if (!isEntryName(name) || name.includes('.')) throw new TemplateError(`card.${name}`, 'not a card field name');
    return [name, cardField(`card.${name}`, field, registry)] as const;
  });
  const fields = new Map<string, CardField>(pending.map(([name]) => [name, { kind: 'address' }]));
  for (const [name, build] of pending) fields.set(name, build(fields));
  const scope: Scope = { card: fields, registry, uintLeaves: new Map(), view: false, inMessage: false };
  const rawCard = object('card', value.card);
  const order = pending.map(([name]) => [name, object(`card.${name}`, rawCard[name]).computed !== undefined] as const);
  for (const [name, isComputed] of order) {
    const field = fields.get(name);
    if (isComputed && field?.kind === 'amount') fields.set(name, { ...field, computed: computed(`card.${name}.computed`, object(`card.${name}`, rawCard[name]).computed, name, scope, order) });
  }
  for (const [name] of pending) {
    const raw = object(`card.${name}`, rawCard[name]).floor;
    const field = fields.get(name);
    if (raw !== undefined && field?.kind === 'amount') fields.set(name, { ...field, floor: floor(`card.${name}.floor`, raw, name, fields) });
  }
  const nonce = value.nonce === undefined ? undefined : rule('nonce', value.nonce, { kind: 'uint', bits: 256 }, scope);
  const same = value.same === undefined ? [] : array('same', value.same).map((ref, i) => cardToken(`same[${i}]`, text(`same[${i}]`, ref), fields, registry));
  if (value.same !== undefined && same.length < 2) throw new TemplateError('same', 'names fewer than two card references');
  const rawCalls = array('calls', value.calls);
  const calls = rawCalls.map((call, i) => templateCall(`calls[${i}]`, call, scope, i === rawCalls.length - 1));
  if (calls.length === 0) throw new TemplateError('calls', 'empty');
  const effects = object('effects', value.effects);
  exactKeys('effects', effects, ['gives', 'gets'], ['views', 'safe', 'approves', 'touches']);
  const gives = array('effects.gives', effects.gives).map((e, i) => effect(`effects.gives[${i}]`, e, scope, 'gives'));
  const gets = array('effects.gets', effects.gets).map((e, i) => effect(`effects.gets[${i}]`, e, scope, 'gets'));
  const moved = new Set(namedEffectTokens({ gives, gets, touches: [] }));
  const touched = (t: Touch): Touch => {
    moved.add(t.token);
    return t;
  };
  const template: Template = {
    id,
    card: fields,
    nonce,
    same,
    calls,
    effects: {
      gives,
      gets,
      views: effects.views === undefined ? [] : array('effects.views', effects.views).map((v, i) => view(`effects.views[${i}]`, v, scope)),
      safe: effects.safe === undefined ? undefined : safeSettings('effects.safe', effects.safe, scope),
      approves: effects.approves === undefined ? [] : array('effects.approves', effects.approves).map((a, i) => keptApproval(`effects.approves[${i}]`, a, scope)),
      touches: effects.touches === undefined ? [] : array('effects.touches', effects.touches).map((t, i) => touched(touch(`effects.touches[${i}]`, t, scope, moved))),
    },
    facts: [],
    instanceField: value.instanceField === undefined ? undefined : instanceField(text('instanceField', value.instanceField), fields),
  };
  const atLeast = atLeastFields(template);
  const loose = [...fields].find(([name, field]) => field.kind === 'amount' && field.floor !== undefined && !atLeast.has(name));
  if (loose !== undefined) throw new TemplateError(`card.${loose[0]}.floor`, 'no atLeast of the calls or of what the Safe gets compares with this field, so it bounds nothing');
  const unbounded = [...template.effects.gives, ...template.effects.gets].some((effect) => effect.amount.kind === 'positive' || effect.amount.kind === 'any');
  if (unbounded && routes(template)) throw new TemplateError('effects', 'a template with a route claim must bound each token the Safe gives or gets by a card amount, atLeast, atMost or all, since a route may change the price');
  const protocols = calledProtocols(template, registry);
  const parsed = { ...template, facts: value.facts === undefined ? [] : array('facts', value.facts).map((f, i) => fact(`facts[${i}]`, f, scope, protocols)) };
  const languages = proseLanguages(parsed, new Set());
  if (languages.size > 1) throw new TemplateError('template', `holds reasons in ${[...languages].join(', in ')}; every reason in one template holds the same languages`);
  return parsed;
}

function instanceField(name: string, card: CardFields): string {
  if (card.get(name)?.kind !== 'contract') throw new TemplateError('instanceField', `${JSON.stringify(name.slice(0, 80))} is not a contract card field`);
  return name;
}

/** The struct name of each message the template signs by its digest (`eip712`), such as CoW's `Order`, once each. */
export function signedStructs(template: Pick<Template, 'calls'>): string[] {
  const visit = (rule: Rule): string[] => {
    switch (rule.kind) {
      case 'eip712':
        return [rule.message.struct.name];
      case 'call':
      case 'keccak':
        return rule.call.args.flatMap(visit);
      case 'items':
        return rule.items.flatMap(visit);
      case 'fields':
        return rule.fields.flatMap(visit);
      case 'packed':
        return rule.parts.flatMap((part) => visit(part.rule));
      default:
        return [];
    }
  };
  return [...new Set(template.calls.flatMap((call) => (call.data === 'empty' ? [] : call.data.args.flatMap(visit))))];
}

/** Whether any argument is free with a `route` claim, which lets a changed value pick another pool. */
function routes(template: Template): boolean {
  const visit = (rule: Rule): boolean =>
    (rule.kind === 'free' && rule.claim === 'route') ||
    (rule.kind === 'call' && rule.call.args.some(visit)) ||
    (rule.kind === 'items' && rule.items.some(visit)) ||
    (rule.kind === 'fields' && rule.fields.some(visit)) ||
    (rule.kind === 'packed' && rule.parts.some((part) => visit(part.rule)));
  return template.calls.some((call) => visit(call.to) || visit(call.value) || (call.data !== 'empty' && call.data.args.some(visit)));
}

/** A rule and every rule nested in it, the parts of packed bytes and the members of a signed message included. */
export function rulesUnder(rule: Rule | undefined): Rule[] {
  if (rule === undefined) return [];
  const nested = (): readonly Rule[] => {
    switch (rule.kind) {
      case 'call':
      case 'keccak':
        return rule.call.args;
      case 'address-word':
        return [rule.rule];
      case 'items':
        return rule.items;
      case 'fields':
        return rule.fields;
      case 'packed':
        return rule.parts.map((part) => part.rule);
      case 'eip712':
        return rule.message.fields;
      default:
        return [];
    }
  };
  return [rule, ...nested().flatMap(rulesUnder)];
}

/** Every rule of the template's nonce and calls, nested ones included. */
export const callRules = (template: Template): Rule[] =>
  [template.nonce, ...template.calls.flatMap((call) => [call.to, call.value, ...(call.data === 'empty' ? [] : call.data.args)])].flatMap(rulesUnder);

/** The card amount fields a share price bound or an `atLeast` compares with: card fields only, never a path. */
function comparedFields(rule: Rule): string[] {
  if (rule.kind === 'share-price') return [rule.assets, rule.shares].flatMap((q) => (q.kind === 'card' ? [q.field] : []));
  return rule.kind === 'at-least' ? [rule.field] : [];
}

/**
 * The card amount fields that bound the transaction from one side, where 0 bounds nothing: each computed field, and
 * each a share price bound or an `atLeast`, of a call or of what the Safe gets, compares with.
 */
export function floorFields(template: Template): ReadonlySet<string> {
  return new Set([
    ...[...template.card].flatMap(([name, field]) => (field.kind === 'amount' && field.computed !== undefined ? [name] : [])),
    ...[...callRules(template), ...template.effects.views.flatMap(({ args }) => args.flatMap(rulesUnder))].flatMap(comparedFields),
    ...template.effects.gets.flatMap(({ amount }) => (amount.kind === 'at-least' ? [amount.field] : [])),
  ]);
}

/** The card amount fields an `atLeast` of a call or of what the Safe gets compares with. */
function atLeastFields(template: Template): ReadonlySet<string> {
  return new Set([
    ...callRules(template).flatMap((rule) => (rule.kind === 'at-least' ? [rule.field] : [])),
    ...template.effects.gets.flatMap(({ amount }) => (amount.kind === 'at-least' ? [amount.field] : [])),
  ]);
}

/** Every card reference the template makes. */
export function cardRefs(template: Template): CardRef[] {
  const refs: CardRef[] = [...template.same];
  const refsOf = (rule: Rule): CardRef[] =>
    rule.kind === 'card' || rule.kind === 'owner-before'
      ? [rule.ref]
      : [...comparedFields(rule), ...(rule.kind === 'at-most' ? [rule.field] : [])].map((field) => ({ field, attribute: undefined }));
  refs.push(...callRules(template).flatMap(refsOf));
  for (const { to, args } of template.effects.views) {
    if (to.kind === 'card') refs.push(to.ref);
    refs.push(...args.flatMap(rulesUnder).flatMap(refsOf));
  }
  for (const field of template.card.values()) if (field.kind === 'amount' && field.of !== 'eth') refs.push(field.of);
  const settings = template.effects.safe;
  for (const ref of [settings?.add, settings?.remove, settings?.threshold]) if (ref !== undefined) refs.push(ref);
  for (const { token } of template.effects.approves) refs.push(token);
  for (const { token, to } of [...template.effects.gives, ...template.effects.gets]) {
    if (token !== 'eth' && !isNamedToken(token)) refs.push(token);
    if (to !== undefined) refs.push(to);
  }
  for (const { token } of template.effects.approves) refs.push(token);
  return refs;
}

/** Reads `templates/<id>/template.json` and requires its `id` to be the folder it sits in. */
export function loadTemplate(repoRoot: string, id: string, registry: Registry): Template {
  if (!ID.test(id)) throw new TemplateError('id', `${JSON.stringify(id.slice(0, 80))} is not <protocol>/<operation>`);
  const template = parseTemplate(JSON.parse(readFileSync(join(repoRoot, TEMPLATES_DIR, id, 'template.json'), 'utf8')), registry);
  if (template.id !== id) throw new TemplateError('id', `${JSON.stringify(template.id)} sits in templates/${id}`);
  return template;
}
