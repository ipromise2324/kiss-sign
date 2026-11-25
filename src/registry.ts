import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { AbiSignatureError, canonicalType, parseFunctionSignature } from './decode/abi.ts';
import { uintWord } from './decode/codec.ts';
import type { AbiFunction } from './decode/abi.ts';
import { samePageKey, sourceHoldsAddress } from './research/source-page.ts';
import { SafeTxParseError, parseAddress, parseHex } from './safe/types.ts';
import type { Address, Hex } from './safe/types.ts';

export const CONTRACT_KINDS = ['token', 'vault', 'router', 'multisend', 'adapter', 'factory', 'distributor', 'bridge', 'lending', 'oracle', 'irm', 'allowance', 'singleton', 'pool'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

/** What a registry entry may say about itself, from `registry/attributes.json`: each attribute and the kind of entry it names. */
export type AttributeTable = ReadonlyMap<string, ContractKind>;

/** The attributes the program knew before `registry/attributes.json`, which a verdict file from before it relies on. */
export const ATTRIBUTES_BEFORE_TABLE = { asset: 'token', factory: 'factory', adapter: 'adapter' } as const satisfies Record<string, ContractKind>;

/** A lowercase-led word of letters and digits, such as `asset` or `token0`: a card reference reads it after a `.`. */
const ATTRIBUTE_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;

declare const httpsUrlBrand: unique symbol;
/**
 * An https URL of RFC 3986 characters other than `[` and `]`, so a report prints it inside `<…>` and in a table cell
 * as itself: no `|`, `<`, `>`, backtick, backslash or whitespace can end the link or the cell.
 */
export type HttpsUrl = string & { readonly [httpsUrlBrand]: true };
const HTTPS_URL = /^https:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+$/;
export const parseHttpsUrl = (raw: unknown): HttpsUrl | undefined => (typeof raw === 'string' && HTTPS_URL.test(raw) && URL.canParse(raw) ? (raw as HttpsUrl) : undefined);

/** A JSON value as `JSON.parse` returns it. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** One step into a JSON answer: an object's key, or an array's index. */
export type ApiPathStep = string | number;

/**
 * A protocol's own API that answers this address, asked with no key and no header of the AI's choosing: an https URL on
 * a DNS name, a GET, or a POST of a JSON `body`, and the `path` that walks the JSON answer to the address.
 */
export type ApiSource = { readonly url: HttpsUrl; readonly path: readonly ApiPathStep[] } & ({ readonly method: 'GET' } | { readonly method: 'POST'; readonly body: Json });

export const MAX_API_BODY_BYTES = 4096;
export const MAX_API_PATH_STEPS = 16;
const API_KEY_STEP = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A step of a path into a JSON answer: a key of letters, digits and `_`, or an array index below 10000. */
export const isApiPathStep = (step: unknown): step is ApiPathStep =>
  (typeof step === 'string' && API_KEY_STEP.test(step)) || (typeof step === 'number' && Number.isSafeInteger(step) && step >= 0 && step < 10_000);

export type RegistryEntry = {
  readonly name: string;
  readonly address: Address;
  readonly kind: ContractKind;
  /** A page that names this address as this contract. */
  readonly source: HttpsUrl;
  /** The protocol's own API, asked as one more source of the address, for a `source` page that shows it only with JavaScript. */
  readonly apiSource?: ApiSource;
  /** The text next to the address on the `source` page that names this contract or its role, such as `Bundler3`. */
  readonly sourceLabel?: string;
  /** Text the nearest heading above the address must hold, for a page whose rows name only a chain, such as `MessageTransmitter`. */
  readonly sourceHeading?: string;
  /** More official pages that list the address, each checked as `source` is. */
  readonly moreSources?: readonly SourcePage[];
  /** Each attribute the entry carries and the registry entry it names, of the kind the attribute table declares. */
  readonly attributes: { readonly [attribute: string]: string };
  /** A factory's: the views that admit each entry whose `factory` attribute names it, all of which must pass. */
  readonly instanceCheck?: InstanceCheck;
  /** What `pnpm instance-evidence` reads of the entry, or of each instance of a factory that has none of its own. */
  readonly size?: SizeView;
  /** The DefiLlama protocol slug this contract belongs to, such as `morpho-blue`; `pnpm check-sources` compares its listing with `source`. */
  readonly defillama?: string;
  /** The CoinGecko coin id of a token or vault share, such as `usd-coin`; `pnpm check-sources` checks CoinGecko lists that coin at `address`. */
  readonly coingecko?: string;
  /** The protocol's Immunefi bug bounty program, such as `cowprotocol`: its scope may hold the address, and it lists the protocol's sites. */
  readonly immunefi?: string;
  /** The protocol's npm package, pinned, whose `file` shows the address next to `label`. */
  readonly sdk?: SdkPackage;
  /** How a proxy that sends each selector to its own implementation answers its routes; its code pin then holds them. */
  readonly routes?: SelectorRouting;
  /** The views that answer a proxy's one implementation, where no slot the program knows holds it. */
  readonly implementationRead?: ImplementationRead;
  /** Entries a call to this one reaches though no call targets them, touched whenever this one is. */
  readonly dependsOn?: readonly string[];
  /** The code a call to this address ran at each block `pnpm pin-code` found; verify requires the code of the block it reads. */
  readonly code?: CodePins;
  /** An allowance from the Safe that this contract may keep after the transaction, and why its code makes that safe. */
  readonly standingAllowance?: StandingAllowance;
  /** A price feed's: what it prices and how far its answer may be off. */
  readonly feed?: Feed;
  /** A token's or vault's: the feed that prices one whole token of it, and the unit it is meant to be worth one of. */
  readonly price?: TokenPrice;
  /** Numbers a factory's `instanceCheck` passes about this instance, such as a pool's fee. */
  readonly numbers?: { readonly [name: string]: bigint };
  /** A pool's: it answers `observe` as a Uniswap v3 pool does, so its mean price over a window may be a second source. */
  readonly twap?: { readonly minLiquidity: bigint };
  /** Why this contract's code never reads calldata past a call's arguments, so a template may allow a trailer of more than 19 bytes. */
  readonly ignoresTrailer?: string;
};

/**
 * What a standing allowance goes through: an ERC-20 `approve` of a token to this contract, or a Permit2 allowance to it.
 * A template may keep such an allowance open (`effects.approves`) only to a registry entry that declares it.
 */
export const ALLOWANCE_ROUTES = ['erc20', 'permit2'] as const;
export type AllowanceRoute = (typeof ALLOWANCE_ROUTES)[number];
export type StandingAllowance = { readonly via: AllowanceRoute; readonly why: string };

/** What the publisher's own list says a feed's data are: exchange prices, or the state of decentralized exchanges. */
export const SOURCE_CLASSES = ['cex_price', 'dex_state_price'] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

export const DOLLAR = 'usd';

/**
 * A feed that answers `latestRoundData()`, `decimals()` and `description()`: its `description` and `decimals` as it
 * answers them, the seconds between answers and the basis points of change its publisher lets pass without a new one,
 * and the unit its price is in: `usd`, or the feed that prices that unit.
 */
export type Feed = {
  readonly description: string;
  readonly decimals: number;
  readonly heartbeat: number;
  readonly deviationBps: number;
  readonly sourceClass: SourceClass;
  readonly quote: string;
};

/**
 * `feed` names a registry feed, and `unit` what it prices when that is not the token's own name, as a wrapped token is
 * worth one of what it wraps; `peg` is `usd` or the feed on the token's own chain of feeds that prices what it is pegged to.
 */
export type TokenPrice = { readonly feed: string; readonly unit: string | undefined; readonly peg: string | undefined };

/** A pool whose mean price may be read, its tokens in the pool's order, and the least harmonic mean liquidity to read it at. */
export type TwapPool = { readonly entry: RegistryEntry; readonly token0: RegistryEntry; readonly token1: RegistryEntry; readonly minLiquidity: bigint };

/**
 * A contract an instance view asks, or an address it binds or expects, seen from the instance: its factory, the instance
 * itself, the entry an attribute of the instance names, or each registry entry whose attribute names the instance.
 */
export type Party =
  | { readonly kind: 'factory' }
  | { readonly kind: 'instance' }
  | { readonly kind: 'attribute'; readonly attribute: string }
  | { readonly kind: 'named-by'; readonly attribute: string };

/** One argument of an instance view: a party's address, a number the instance's entry declares, or a constant of the parameter's type. */
export type InstanceArg =
  | { readonly kind: 'party'; readonly party: Party }
  | { readonly kind: 'number'; readonly name: string; readonly bits: number }
  | { readonly kind: 'uint' | 'int'; readonly value: bigint }
  | { readonly kind: 'address'; readonly value: Address }
  | { readonly kind: 'bytes32'; readonly value: Hex }
  | { readonly kind: 'string'; readonly value: string };

/**
 * One party vouching for an instance: `ask` is called with `args` and must answer true, or the address of the party
 * `answers` names, in its word `word` when it answers a static struct, else in its one word.
 */
export type InstanceView = {
  readonly ask: Party;
  readonly fn: AbiFunction;
  readonly args: readonly InstanceArg[];
  readonly answers: { readonly kind: 'true' } | { readonly kind: 'party'; readonly party: Party };
  readonly word: number | undefined;
};

/** A factory's views that admit an instance, in order, at least one. */
export type InstanceCheck = readonly [InstanceView, ...InstanceView[]];

/**
 * What `pnpm instance-evidence` reads of an instance: `fn`, a number it answers each month; `unit`, a view it answers with
 * the token that number counts, which must be the entry `attribute` names; `holders`, whether its own ERC-20 shares'
 * holders are counted.
 */
export type SizeView = { readonly fn: AbiFunction; readonly unit: { readonly fn: AbiFunction; readonly attribute: string } | undefined; readonly holders: boolean };

/**
 * A proxy's two views, `implementationOf(bytes4)`, answering one address word, and `selectorsOf(address)`, answering a
 * `bytes4[]`, and the seeds research chose so every implementation is reached: no view lists the implementations.
 */
export type SelectorRouting = { readonly implementationOf: AbiFunction; readonly selectorsOf: AbiFunction; readonly seeds: readonly Hex[] };

/**
 * A view of one step of an `implementationRead`, with its arguments as 32-byte words: the first step is called on the
 * entry, each next one on the address the step before answered, and the last answer is the implementation.
 */
type ReadStep = { readonly fn: AbiFunction; readonly args: readonly Hex[] };
export type ImplementationRead = readonly ReadStep[];

/** How an entry's proxy names the code it runs, when the program does not find it on its own. */
export type ProxyDeclaration = Pick<RegistryEntry, 'routes' | 'implementationRead'>;

/** An implementation the seeds reach, its code hash, and the selectors it serves in the order `selectorsOf` answered. */
export type Route = { readonly address: Address; readonly hash: Hex; readonly selectors: readonly Hex[] };

/** An official page that lists an address, the text next to it there, and the heading above it when the page needs one. */
export type SourcePage = { readonly url: HttpsUrl; readonly label: string; readonly heading?: string };

/** An npm package pinned to one version and the sha256 of its tarball, with a file in it and the text next to the address there. */
export type SdkPackage = { readonly package: string; readonly version: string; readonly sha256: Hex; readonly file: string; readonly label: string };

/** Every page that lists the entry's address: its `source`, then each of `moreSources`. */
export const pageUrlsOf = (entry: RegistryEntry): readonly HttpsUrl[] => [entry.source, ...(entry.moreSources ?? []).map((page) => page.url)];

/** An address and the keccak256 of the runtime code there. */
export type PinnedCode = { readonly address: Address; readonly hash: Hex };

/**
 * keccak256 of the runtime code at the address, behind a proxy the implementation it delegates to and its code's, with
 * the extension that implementation hands a call it has no function for to, if any, and for an entry with `routes`,
 * its routes sorted by address.
 */
export type ImplementationPin = PinnedCode & { readonly extension?: PinnedCode };
export type CodePin = { readonly hash: Hex; readonly implementation?: ImplementationPin; readonly routes?: readonly Route[] };

/** A pin and the first block whose state held its code. It holds until the block before the next span's `from`. */
export type CodeSpan = { readonly from: bigint; readonly pin: CodePin };

/**
 * The code each block ran, oldest first: `earlier` spans with strictly increasing `from`, then `current`, which holds
 * from its `from` to the latest block. A block before the first `from` has no pin.
 */
export type CodePins = { readonly earlier: readonly CodeSpan[]; readonly current: CodeSpan };

/** The pin of the span that holds `block`, if any. */
export function pinAt(pins: CodePins, block: bigint): CodePin | undefined {
  return [...pins.earlier, pins.current].findLast((span) => span.from <= block)?.pin;
}

/** Morpho Blue's `MarketParams`, in its order: what a market's id hashes. */
export const MARKET_PARAMS = ['loanToken', 'collateralToken', 'oracle', 'irm', 'lltv'] as const;
export type MarketParams = { readonly [P in (typeof MARKET_PARAMS)[number]]: P extends 'lltv' ? bigint : Address };

/** The registry entry each address part of a market names, by the kind it must be. */
export const MARKET_ENTRIES = { lending: 'lending', loanToken: 'token', collateralToken: 'token', oracle: 'oracle', irm: 'irm' } as const satisfies Record<
  string,
  ContractKind
>;
export type MarketEntryPart = keyof typeof MARKET_ENTRIES;
export const MARKET_ENTRY_PARTS = Object.keys(MARKET_ENTRIES) as readonly MarketEntryPart[];
export const isMarketEntryPart = (raw: string): raw is MarketEntryPart => Object.hasOwn(MARKET_ENTRIES, raw);

/** What a card reference may name of a market: one of its registry entries, its lltv, or its id. */
export const MARKET_PARTS = ['lending', 'loanToken', 'collateralToken', 'oracle', 'irm', 'lltv', 'id'] as const satisfies readonly (MarketEntryPart | 'lltv' | 'id')[];
export type MarketPart = (typeof MARKET_PARTS)[number];

/** A Morpho Blue market from `registry/markets.json`: its parameters as registry entries, and the id they hash to. */
export type Market = { readonly name: string; readonly id: Hex; readonly lltv: bigint } & { readonly [P in MarketEntryPart]: RegistryEntry };

export type Registry = {
  readonly attributes: AttributeTable;
  readonly entries: ReadonlyMap<string, RegistryEntry>;
  readonly byAddress: ReadonlyMap<Address, RegistryEntry>;
  readonly markets: ReadonlyMap<string, Market>;
};

export const REGISTRY_DIR = 'registry';
export const REGISTRY_PATH = join(REGISTRY_DIR, 'contracts.json');
export const MARKETS_PATH = join(REGISTRY_DIR, 'markets.json');
export const ATTRIBUTES_PATH = join(REGISTRY_DIR, 'attributes.json');

/** Lowercase words joined by `-` or `.`, such as `multisend-call-only-1.4.1`. `safe` names the Safe itself, `eth` native ETH. */
export const NAME = /^[a-z0-9]+([.-][a-z0-9]+)*$/;
export const RESERVED_NAMES = ['safe', 'eth'] as const;

const DEFILLAMA_SLUG = /^[a-z0-9]+([.-][a-z0-9]+)*$/;
const COINGECKO_ID = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const IMMUNEFI_PROGRAM = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NPM_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const PACKAGE_FILE = /^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@-]+)*$/;
export const COINGECKO_KINDS: readonly ContractKind[] = ['token', 'vault'];

export class RegistryError extends Error {
  override name = 'RegistryError';
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.path = path;
  }
}

export function isEntryName(raw: string): boolean {
  return NAME.test(raw) && !(RESERVED_NAMES as readonly string[]).includes(raw);
}

/** `registry/attributes.json`: each attribute's name and the kind of entry it names. */
export function parseAttributeTable(raw: unknown): AttributeTable {
  const table = new Map<string, ContractKind>();
  for (const [name, kind] of Object.entries(record('attributes', raw))) {
    if (!ATTRIBUTE_NAME.test(name) || name in Object.prototype) throw new RegistryError(`attributes.${name}`, 'not an attribute name: a lowercase letter, then up to 31 letters and digits');
    const named = CONTRACT_KINDS.find((k) => k === kind);
    if (named === undefined) throw new RegistryError(`attributes.${name}`, `not one of ${CONTRACT_KINDS.join(', ')}`);
    table.set(name, named);
  }
  return table;
}

/** The entry the instance view's party names, seen from `instance`; a `named-by` party names several, and is resolved by the caller. */
export function partyEntry(party: Exclude<Party, { kind: 'named-by' }>, instance: RegistryEntry, registry: Registry): RegistryEntry | undefined {
  if (party.kind === 'instance') return instance;
  const name = instance.attributes[party.kind === 'factory' ? 'factory' : party.attribute];
  return name === undefined ? undefined : registry.entries.get(name);
}

/** Each registry entry whose attribute `attribute` names `name`, in registry order. */
export const entriesNaming = (registry: Registry, attribute: string, name: string): RegistryEntry[] => [...registry.entries.values()].filter((entry) => entry.attributes[attribute] === name);

/** The `size` the entry declares, or else its factory's. */
export function sizeOf(entry: RegistryEntry, registry: Registry): SizeView | undefined {
  const factory = entry.attributes.factory;
  return entry.size ?? (factory === undefined ? undefined : registry.entries.get(factory)?.size);
}

function record(path: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new RegistryError(path, 'not a JSON object');
  return raw as Record<string, unknown>;
}

function onlyKeys(path: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new RegistryError(`${path}.${extra}`, 'unexpected field');
}

function signatureOf(path: string, raw: unknown): AbiFunction {
  if (typeof raw !== 'string') throw new RegistryError(path, 'not a function signature');
  try {
    return parseFunctionSignature(raw);
  } catch (error) {
    if (error instanceof AbiSignatureError) throw new RegistryError(path, error.message);
    throw error;
  }
}

function oneParamFunction(path: string, raw: unknown, type: 'address' | 'bytes4'): AbiFunction {
  const fn = signatureOf(path, raw);
  const [param, ...more] = fn.params;
  if (param === undefined || more.length > 0 || canonicalType(param.type) !== type) throw new RegistryError(path, `must take exactly one ${type}`);
  return fn;
}

function noParamFunction(path: string, raw: unknown): AbiFunction {
  const fn = signatureOf(path, raw);
  if (fn.params.length > 0) throw new RegistryError(path, 'must take no parameters');
  return fn;
}

const INSTANCE_STRING = /^[A-Za-z0-9_.-]{1,32}$/;
const DECIMAL = /^-?(0|[1-9][0-9]{0,77})$/;
const MAX_ANSWER_WORD = 63;

const PARTY_FORMS = '"factory", "instance", {"attribute": ...}, {"namedBy": ...}';

function partyOf(path: string, raw: unknown, table: AttributeTable): Party {
  if (raw === 'factory' || raw === 'instance') return { kind: raw };
  const declared = (key: string, name: unknown): string => {
    if (typeof name !== 'string' || !table.has(name)) throw new RegistryError(`${path}.${key}`, `not one of ${[...table.keys()].join(', ')}`);
    return name;
  };
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    const [key, ...more] = Object.keys(value);
    if (more.length === 0 && key === 'attribute') return { kind: 'attribute', attribute: declared(key, value[key]) };
    if (more.length === 0 && key === 'namedBy') return { kind: 'named-by', attribute: declared(key, value[key]) };
  }
  throw new RegistryError(path, `not one of ${PARTY_FORMS}`);
}

const CONSTANT_KEYS = ['uint', 'int', 'address', 'bytes32', 'string'] as const;

function constantOf(path: string, key: (typeof CONSTANT_KEYS)[number], bound: unknown, type: string): InstanceArg {
  const sized = key === 'uint' || key === 'int';
  if (!(sized ? new RegExp(`^${key}\\d+$`) : new RegExp(`^${key}$`)).test(type)) throw new RegistryError(path, `a constant ${key} binds only ${sized ? `${key}<bits>` : key} parameters, and this one is ${type}`);
  if (key === 'string') {
    if (typeof bound !== 'string' || !INSTANCE_STRING.test(bound)) throw new RegistryError(`${path}.string`, 'not 1 to 32 letters, digits, _, . or -');
    return { kind: 'string', value: bound };
  }
  if (key === 'address') return { kind: 'address', value: parsed(() => parseAddress(`${path}.address`, bound)) };
  if (key === 'bytes32') return { kind: 'bytes32', value: hash32(`${path}.bytes32`, bound) };
  const bits = BigInt(type.slice(key.length));
  const value = typeof bound === 'string' && DECIMAL.test(bound) ? BigInt(bound) : undefined;
  const [low, high] = key === 'uint' ? [0n, (1n << bits) - 1n] : [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n];
  if (value === undefined || value < low || value > high) throw new RegistryError(`${path}.${key}`, `not a decimal integer string in the range of ${type}`);
  return { kind: key, value };
}

function instanceArg(path: string, raw: unknown, type: string, table: AttributeTable): InstanceArg {
  const keys = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? Object.keys(raw) : [];
  if (keys.length === 1 && keys[0] === 'number') {
    const name = (raw as Record<string, unknown>).number;
    if (typeof name !== 'string' || !ATTRIBUTE_NAME.test(name)) throw new RegistryError(`${path}.number`, 'not the name of a number');
    const bits = /^uint(\d+)$/.exec(type)?.[1];
    if (bits === undefined) throw new RegistryError(path, `a number binds only uint<bits> parameters, and this one is ${type}`);
    return { kind: 'number', name, bits: Number(bits) };
  }
  const constant = keys.length === 1 ? CONSTANT_KEYS.find((k) => k === keys[0]) : undefined;
  if (constant !== undefined) return constantOf(path, constant, (raw as Record<string, unknown>)[constant], type);
  const party = raw === 'factory' || raw === 'instance' || (keys.length === 1 && (keys[0] === 'attribute' || keys[0] === 'namedBy'));
  if (!party) throw new RegistryError(path, `not one of ${PARTY_FORMS}, a number, {"number": ...}, or a constant, ${CONSTANT_KEYS.map((k) => `{"${k}": ...}`).join(', ')}`);
  if (type !== 'address') throw new RegistryError(path, `a party binds only an address parameter, and this one is ${type}`);
  return { kind: 'party', party: partyOf(path, raw, table) };
}

const isInstance = (party: Party): boolean => party.kind === 'instance';
const boundParties = (view: InstanceView): Party[] => view.args.flatMap((arg) => (arg.kind === 'party' ? [arg.party] : []));

/**
 * One view of an `instanceCheck`. A bare signature with one `address` parameter asks the factory with the instance's
 * address and expects true; an object without `ask` asks the factory, and without `answers` expects the instance.
 */
function instanceViewOf(path: string, raw: unknown, table: AttributeTable): InstanceView {
  if (typeof raw === 'string') {
    return { ask: { kind: 'factory' }, fn: oneParamFunction(path, raw, 'address'), args: [{ kind: 'party', party: { kind: 'instance' } }], answers: { kind: 'true' }, word: undefined };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new RegistryError(path, 'not a function signature or a {"function", "args"} object');
  const value = raw as Record<string, unknown>;
  onlyKeys(path, value, ['ask', 'function', 'args', 'answers', 'word']);
  const fn = signatureOf(`${path}.function`, value.function);
  if (!Array.isArray(value.args) || value.args.length !== fn.params.length) throw new RegistryError(`${path}.args`, `not a list of one argument for each of the ${fn.params.length} parameters`);
  const args = fn.params.map((param, i) => instanceArg(`${path}.args[${i}]`, (value.args as unknown[])[i], canonicalType(param.type), table));
  const ask = value.ask === undefined ? { kind: 'factory' as const } : partyOf(`${path}.ask`, value.ask, table);
  const answers = value.answers === undefined ? { kind: 'party' as const, party: { kind: 'instance' as const } } : value.answers === true ? { kind: 'true' as const } : { kind: 'party' as const, party: partyOf(`${path}.answers`, value.answers, table) };
  if (value.word !== undefined && (typeof value.word !== 'number' || !Number.isSafeInteger(value.word) || value.word < 0 || value.word > MAX_ANSWER_WORD)) {
    throw new RegistryError(`${path}.word`, `not a word index from 0 to ${MAX_ANSWER_WORD}`);
  }
  const view: InstanceView = { ask, fn, args, answers, word: value.word as number | undefined };
  const parties = [ask, ...boundParties(view), ...(answers.kind === 'party' ? [answers.party] : [])];
  if (!parties.some(isInstance)) throw new RegistryError(path, 'names the instance nowhere, so it answers the same for every contract');
  if (new Set(parties.flatMap((party) => (party.kind === 'named-by' ? [party.attribute] : []))).size > 1) throw new RegistryError(path, 'names the instance by two attributes, and is asked once per entry naming it by one');
  if (answers.kind === 'party' && isInstance(answers.party) && !boundParties(view).some((party) => party.kind === 'attribute' || party.kind === 'named-by')) {
    throw new RegistryError(`${path}.args`, 'binds no attribute of the contract, so the address it computes is the same for every contract');
  }
  return view;
}

function instanceCheckOf(path: string, raw: unknown, table: AttributeTable): InstanceCheck {
  const [first, ...more] = Array.isArray(raw) ? raw.map((view: unknown, i) => instanceViewOf(`${path}[${i}]`, view, table)) : [instanceViewOf(path, raw, table)];
  if (first === undefined) throw new RegistryError(path, 'not a non-empty list of views');
  const check: InstanceCheck = [first, ...more];
  if (check.every((view) => isInstance(view.ask))) throw new RegistryError(path, "asks only the instance, whose own word tells it from no lookalike");
  return check;
}

function sizeViewOf(path: string, raw: unknown, table: AttributeTable): SizeView {
  const value = record(path, raw);
  onlyKeys(path, value, ['function', 'unit', 'holders']);
  if (value.holders !== undefined && typeof value.holders !== 'boolean') throw new RegistryError(`${path}.holders`, 'not true or false');
  if (value.unit === undefined) return { fn: noParamFunction(`${path}.function`, value.function), unit: undefined, holders: value.holders === true };
  const unit = record(`${path}.unit`, value.unit);
  onlyKeys(`${path}.unit`, unit, ['function', 'attribute']);
  if (typeof unit.attribute !== 'string' || table.get(unit.attribute) !== 'token') throw new RegistryError(`${path}.unit.attribute`, 'not an attribute that names a token');
  return { fn: noParamFunction(`${path}.function`, value.function), unit: { fn: noParamFunction(`${path}.unit.function`, unit.function), attribute: unit.attribute }, holders: value.holders === true };
}

const SELECTOR = /^0x[0-9a-f]{8}$/;

function selectorList(path: string, raw: unknown, max?: number): Hex[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > (max ?? Infinity)) throw new RegistryError(path, max === undefined ? 'not a non-empty list of selectors' : `not a list of 1 to ${max} selectors`);
  const seen = new Set<string>();
  return raw.map((selector: unknown, i) => {
    if (typeof selector !== 'string' || !SELECTOR.test(selector)) throw new RegistryError(`${path}[${i}]`, 'not a lowercase 4-byte selector');
    if (seen.has(selector)) throw new RegistryError(`${path}[${i}]`, `${selector} is listed twice`);
    seen.add(selector);
    return selector as Hex;
  });
}

const MAX_SEEDS = 16;

function routingOf(path: string, raw: unknown): SelectorRouting {
  const value = record(path, raw);
  onlyKeys(path, value, ['implementationOf', 'selectorsOf', 'seeds']);
  return {
    implementationOf: oneParamFunction(`${path}.implementationOf`, value.implementationOf, 'bytes4'),
    selectorsOf: oneParamFunction(`${path}.selectorsOf`, value.selectorsOf, 'address'),
    seeds: selectorList(`${path}.seeds`, value.seeds, MAX_SEEDS),
  };
}

export const unreachedSeeds = (routing: SelectorRouting, routes: readonly Route[]): Hex[] => routing.seeds.filter((seed) => !routes.some((route) => route.selectors.includes(seed)));

const MAX_READ_STEPS = 3;
const READ_PARAM_TYPES = ['address', 'bytes32', 'uint256'];
const WORD = /^0x[0-9a-f]{64}$/;

export function parseImplementationRead(path: string, raw: unknown): ImplementationRead {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_READ_STEPS) throw new RegistryError(path, `not a list of 1 to ${MAX_READ_STEPS} views`);
  return raw.map((rawStep: unknown, i): ReadStep => {
    const at = `${path}[${i}]`;
    const step = record(at, rawStep);
    onlyKeys(at, step, ['function', 'args']);
    const fn = signatureOf(`${at}.function`, step.function);
    const types = fn.params.map((param) => canonicalType(param.type));
    if (!types.every((type) => READ_PARAM_TYPES.includes(type))) throw new RegistryError(`${at}.function`, `may take only ${READ_PARAM_TYPES.join(', ')}`);
    const args = step.args === undefined ? [] : step.args;
    if (!Array.isArray(args) || args.length !== types.length) throw new RegistryError(`${at}.args`, `not ${types.length} arguments`);
    return {
      fn,
      args: args.map((arg: unknown, j): Hex => {
        if (typeof arg !== 'string' || !WORD.test(arg)) throw new RegistryError(`${at}.args[${j}]`, 'not a lowercase 32-byte word');
        if (types[j] === 'address' && !/^0x0{24}/.test(arg)) throw new RegistryError(`${at}.args[${j}]`, 'not an address word');
        return arg as Hex;
      }),
    };
  });
}

/** The JSON an `implementationRead` is written in, as the registry holds it. */
export const implementationReadJson = (read: ImplementationRead) => read.map((step) => ({ function: step.fn.signature, ...(step.args.length === 0 ? {} : { args: step.args }) }));

const MAX_DEPENDS_ON = 8;

function parsed<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof SafeTxParseError) throw new RegistryError(error.field, error.message.slice(error.field.length + 2));
    throw error;
  }
}

function hash32(path: string, raw: unknown): Hex {
  const hash = parsed(() => parseHex(path, raw));
  if (hash.length !== 66) throw new RegistryError(path, 'not 32 bytes');
  return hash;
}

function blockOf(path: string, raw: unknown): bigint {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) throw new RegistryError(path, 'not a block number');
  return BigInt(raw);
}

function routesOf(path: string, raw: unknown): Route[] {
  if (!Array.isArray(raw)) throw new RegistryError(path, 'not a list of routes');
  const selectors = new Set<string>();
  const routes = raw.map((rawRoute: unknown, i): Route => {
    const at = `${path}[${i}]`;
    const route = record(at, rawRoute);
    onlyKeys(at, route, ['address', 'hash', 'selectors']);
    const served = selectorList(`${at}.selectors`, route.selectors);
    served.forEach((selector, j) => {
      if (selectors.has(selector)) throw new RegistryError(`${at}.selectors[${j}]`, `${selector} is in another route too`);
      selectors.add(selector);
    });
    const address = parsed(() => parseAddress(`${at}.address`, route.address));
    if (BigInt(address) === 0n) throw new RegistryError(`${at}.address`, 'the zero address, which a selector that routes nowhere answers, is no implementation');
    return { address, hash: hash32(`${at}.hash`, route.hash), selectors: served };
  });
  routes.forEach((route, i) => {
    const before = routes[i - 1];
    if (before !== undefined && before.address >= route.address) throw new RegistryError(`${path}[${i}].address`, `not after ${before.address}: routes are sorted by address, each implementation once`);
  });
  return routes;
}

function codePinOf(path: string, value: Record<string, unknown>, routed: boolean): CodePin {
  const hash = hash32(`${path}.hash`, value.hash);
  if (routed && value.routes === undefined) throw new RegistryError(`${path}.routes`, 'missing, though the entry declares routes; remove the code pin and run pnpm pin-code');
  if (!routed && value.routes !== undefined) throw new RegistryError(`${path}.routes`, 'the entry declares no routes');
  const routes = value.routes === undefined ? {} : { routes: routesOf(`${path}.routes`, value.routes) };
  if (value.implementation === undefined) return { hash, ...routes };
  const implementation = record(`${path}.implementation`, value.implementation);
  onlyKeys(`${path}.implementation`, implementation, ['address', 'hash', 'extension']);
  const pinned = pinnedCodeOf(`${path}.implementation`, implementation);
  if (implementation.extension === undefined) return { hash, implementation: pinned, ...routes };
  const at = `${path}.implementation.extension`;
  const extension = record(at, implementation.extension);
  onlyKeys(at, extension, ['address', 'hash']);
  return { hash, implementation: { ...pinned, extension: pinnedCodeOf(at, extension) }, ...routes };
}

function pinnedCodeOf(path: string, value: Record<string, unknown>): PinnedCode {
  return { address: parsed(() => parseAddress(`${path}.address`, value.address)), hash: hash32(`${path}.hash`, value.hash) };
}

/** `from` may be absent only on a pin with no earlier ones, as `pnpm pin-code` wrote before it read ranges: it holds from block 0. */
function codePinsOf(path: string, raw: unknown, routing: SelectorRouting | undefined): CodePins {
  const value = record(path, raw);
  onlyKeys(path, value, ['hash', 'implementation', 'routes', 'from', 'earlier']);
  const current = { from: value.from === undefined ? 0n : blockOf(`${path}.from`, value.from), pin: codePinOf(path, value, routing !== undefined) };
  const unreached = routing === undefined ? [] : unreachedSeeds(routing, current.pin.routes ?? []);
  if (unreached.length > 0) throw new RegistryError(`${path}.routes`, `no route lists the seed ${unreached.join(', ')}, which then routes nowhere`);
  const seedless = routing === undefined ? -1 : (current.pin.routes ?? []).findIndex((route) => !route.selectors.some((selector) => routing.seeds.includes(selector)));
  if (seedless !== -1) throw new RegistryError(`${path}.routes[${seedless}]`, 'lists no seed, and pnpm pin-code reaches an implementation only through a seed');
  if (value.earlier === undefined) return { earlier: [], current };
  if (!Array.isArray(value.earlier) || value.earlier.length === 0) throw new RegistryError(`${path}.earlier`, 'not a non-empty list of pins');
  const earlier = value.earlier.map((rawSpan: unknown, i): CodeSpan => {
    const at = `${path}.earlier[${i}]`;
    const span = record(at, rawSpan);
    onlyKeys(at, span, ['from', 'hash', 'implementation', 'routes']);
    return { from: blockOf(`${at}.from`, span.from), pin: codePinOf(at, span, routing !== undefined) };
  });
  const spans = [...earlier, current];
  spans.forEach((span, i) => {
    const before = spans[i - 1];
    if (before !== undefined && span.from <= before.from) {
      throw new RegistryError(i === earlier.length ? `${path}.from` : `${path}.earlier[${i}].from`, `not after ${before.from}, the from of the pin before it`);
    }
  });
  return { earlier, current };
}

/** Whether `text` holds 8 or more hex digits of `address` in a row, in any letter case: a prefix is enough to ask for it. */
function namesAddress(text: string, address: Address): boolean {
  const lower = text.toLowerCase();
  const hex = address.slice(2);
  for (let i = 0; i + 8 <= hex.length; i++) if (lower.includes(hex.slice(i, i + 8))) return true;
  return false;
}

/** Printable ASCII with no backslash, plus tab and newline: a request needs no escape a server would decode into the address. */
const PLAIN_TEXT = /^[\t\n\x20-\x5b\x5d-\x7e]*$/;

/**
 * The request and path of an `apiSource`. A request that names the entry's address is refused, since an API may echo
 * what it is asked, as a page echoes its own URL; so is any escape a server decodes, which could spell it out of sight:
 * a backslash or a character outside printable ASCII in the body, and an escaped `%` or backslash in the URL. A host must be a DNS name with no port or user, so the request goes
 * where the URL reads, and not GitHub's, which serves JSON of any fork's commit under the parent repository's path.
 */
function apiSourceOf(path: string, raw: unknown, address: Address): ApiSource {
  const value = record(path, raw);
  onlyKeys(path, value, ['url', 'method', 'body', 'path']);
  const url = parseHttpsUrl(value.url);
  if (url === undefined) throw new RegistryError(`${path}.url`, 'not an https URL');
  const parsedUrl = new URL(url);
  if (parsedUrl.port !== '' || parsedUrl.username !== '' || parsedUrl.password !== '' || isIP(parsedUrl.hostname) !== 0 || parsedUrl.hostname.startsWith('[') || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(parsedUrl.hostname)) {
    throw new RegistryError(`${path}.url`, 'must name a DNS host with no port and no user');
  }
  if (/(^|\.)(github\.com|githubusercontent\.com)$/.test(parsedUrl.hostname)) throw new RegistryError(`${path}.url`, 'GitHub serves any fork\'s text under a repository\'s path; name the protocol\'s own API');
  const steps = value.path;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_API_PATH_STEPS) throw new RegistryError(`${path}.path`, `not a list of 1 to ${MAX_API_PATH_STEPS} steps`);
  steps.forEach((step: unknown, i) => {
    if (!isApiPathStep(step)) throw new RegistryError(`${path}.path[${i}]`, 'not a key of letters, digits and _ or an index below 10000');
  });
  const walk = steps as ApiPathStep[];
  const echoes = (text: string) => namesAddress(text, address);
  if (/%(25|5c)/i.test(url)) throw new RegistryError(`${path}.url`, 'holds an escaped % or backslash');
  if (echoes(url) || echoes(url.replace(/%([0-9a-fA-F]{2})/g, (_, byte: string) => String.fromCharCode(parseInt(byte, 16))))) throw new RegistryError(`${path}.url`, "holds the entry's address, and an API may echo what it is asked");
  if (value.method === 'GET') {
    if (value.body !== undefined) throw new RegistryError(`${path}.body`, 'a GET sends no body');
    return { url, method: 'GET', path: walk };
  }
  if (value.method !== 'POST') throw new RegistryError(`${path}.method`, 'not GET or POST');
  if (value.body === undefined) throw new RegistryError(`${path}.body`, 'a POST sends a JSON body');
  const body = JSON.stringify(value.body);
  if (Buffer.byteLength(body) > MAX_API_BODY_BYTES) throw new RegistryError(`${path}.body`, `longer than ${MAX_API_BODY_BYTES} bytes`);
  const texts = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : typeof value === 'object' && value !== null ? Object.entries(value).flatMap(([key, item]) => [key, ...texts(item)]) : [String(value)];
  if (!texts(value.body).every((text) => PLAIN_TEXT.test(text))) throw new RegistryError(`${path}.body`, 'holds a backslash or a character outside printable ASCII');
  if (echoes(texts(value.body).join('\n'))) throw new RegistryError(`${path}.body`, "holds the entry's address, and an API may echo what it is asked");
  return { url, method: 'POST', body: value.body as Json, path: walk };
}

const PAGE_TEXT = /^\S(?:[^\p{Cc}]{0,118}\S)?$/u;

function pageText(path: string, raw: unknown): string {
  if (typeof raw !== 'string' || !PAGE_TEXT.test(raw)) throw new RegistryError(path, 'not page text of 1 to 120 characters');
  return raw;
}

/**
 * A page whose URL holds the address, plainly or percent-encoded, is refused: a page may echo its own URL. So is a page
 * the entry already names under another spelling, such as a github.com file and its raw.githubusercontent.com copy,
 * since one page is one confirmation.
 */
function moreSourcesOf(path: string, raw: unknown, address: Address, source: HttpsUrl): SourcePage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new RegistryError(path, 'not a non-empty list of pages');
  const pages = new Set<string>([samePageKey(source)]);
  return raw.map((rawPage: unknown, i): SourcePage => {
    const at = `${path}[${i}]`;
    const page = record(at, rawPage);
    onlyKeys(at, page, ['url', 'label', 'heading']);
    const url = parseHttpsUrl(page.url);
    if (url === undefined) throw new RegistryError(`${at}.url`, 'not an https URL');
    if (sourceHoldsAddress(url, address)) throw new RegistryError(`${at}.url`, "holds the entry's address, and a page may echo its own URL");
    const key = samePageKey(url);
    if (pages.has(key)) throw new RegistryError(`${at}.url`, 'names a page the entry already names');
    pages.add(key);
    return { url, label: pageText(`${at}.label`, page.label), ...(page.heading === undefined ? {} : { heading: pageText(`${at}.heading`, page.heading) }) };
  });
}

function nonEmpty(path: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new RegistryError(path, 'not a non-empty string');
  return raw;
}

function sdkOf(path: string, raw: unknown): SdkPackage {
  const value = record(path, raw);
  onlyKeys(path, value, ['package', 'version', 'sha256', 'file', 'label']);
  if (typeof value.package !== 'string' || value.package.length > 214 || !NPM_PACKAGE.test(value.package)) throw new RegistryError(`${path}.package`, 'not an npm package name');
  if (typeof value.version !== 'string' || !NPM_VERSION.test(value.version)) throw new RegistryError(`${path}.version`, 'not an exact npm version');
  const sha256 = parsed(() => parseHex(`${path}.sha256`, value.sha256));
  if (sha256.length !== 66) throw new RegistryError(`${path}.sha256`, 'not 32 bytes');
  if (typeof value.file !== 'string' || !PACKAGE_FILE.test(value.file) || value.file.split('/').some((part) => part === '.' || part === '..')) {
    throw new RegistryError(`${path}.file`, 'not a plain path inside the package');
  }
  return { package: value.package, version: value.version, sha256, file: value.file, label: pageText(`${path}.label`, value.label) };
}

function standingAllowanceOf(path: string, raw: unknown): StandingAllowance {
  const value = record(path, raw);
  onlyKeys(path, value, ['via', 'why']);
  const via = ALLOWANCE_ROUTES.find((route) => route === value.via);
  if (via === undefined) throw new RegistryError(`${path}.via`, `not one of ${ALLOWANCE_ROUTES.join(', ')}`);
  return { via, why: nonEmpty(`${path}.why`, value.why) };
}

function wholeNumber(path: string, raw: unknown, least: number, most: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < least || raw > most) throw new RegistryError(path, `not a whole number from ${least} to ${most}`);
  return raw;
}

function decimalString(path: string, raw: unknown): bigint {
  const value = typeof raw === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(raw) ? BigInt(raw) : undefined;
  if (value === undefined || value >> 256n !== 0n) throw new RegistryError(path, 'not a decimal integer string below 2^256');
  return value;
}

const FEED_DESCRIPTION = /^[A-Za-z0-9.]{1,16} \/ [A-Za-z0-9.]{1,16}$/;
const MAX_FEED_DECIMALS = 36;
/** The longest heartbeat publishers of dollar feeds state; a longer one calls a dead feed fresh. */
const MAX_HEARTBEAT = 86_400;
const MAX_FEED_DEVIATION = 1000;
/** A feed's chain of quotes ends in the dollar within this many feeds. */
const MAX_FEEDS = 3;

/** The unit a feed's description says it prices, and the one it prices it in. */
const feedUnits = (description: string): readonly [string, string] => description.split(' / ') as [string, string];

function feedOf(path: string, raw: unknown): Feed {
  const value = record(path, raw);
  const keys = ['description', 'decimals', 'heartbeat', 'deviationBps', 'sourceClass', 'quote'];
  onlyKeys(path, value, keys);
  if (typeof value.description !== 'string' || !FEED_DESCRIPTION.test(value.description)) throw new RegistryError(`${path}.description`, 'not a description such as ETH / USD');
  const sourceClass = SOURCE_CLASSES.find((c) => c === value.sourceClass);
  if (sourceClass === undefined) throw new RegistryError(`${path}.sourceClass`, `not one of ${SOURCE_CLASSES.join(', ')}`);
  if (typeof value.quote !== 'string') throw new RegistryError(`${path}.quote`, `not ${DOLLAR} or the name of a feed`);
  if (value.quote === DOLLAR && feedUnits(value.description)[1] !== 'USD') throw new RegistryError(`${path}.quote`, `the description prices in ${feedUnits(value.description)[1]}, not USD`);
  return {
    description: value.description,
    decimals: wholeNumber(`${path}.decimals`, value.decimals, 0, MAX_FEED_DECIMALS),
    heartbeat: wholeNumber(`${path}.heartbeat`, value.heartbeat, 1, MAX_HEARTBEAT),
    deviationBps: wholeNumber(`${path}.deviationBps`, value.deviationBps, 1, MAX_FEED_DEVIATION),
    sourceClass,
    quote: value.quote,
  };
}

function priceOf(path: string, raw: unknown): TokenPrice {
  const value = record(path, raw);
  onlyKeys(path, value, ['feed', 'unit', 'peg']);
  if (typeof value.feed !== 'string') throw new RegistryError(`${path}.feed`, 'not the name of a feed');
  if (value.peg !== undefined && typeof value.peg !== 'string') throw new RegistryError(`${path}.peg`, `not ${DOLLAR} or the name of a feed`);
  if (value.unit !== undefined && typeof value.unit !== 'string') throw new RegistryError(`${path}.unit`, 'not the unit a feed prices');
  return { feed: value.feed, unit: value.unit, peg: value.peg };
}

function numbersOf(path: string, raw: unknown): { [name: string]: bigint } {
  return Object.fromEntries(
    Object.entries(record(path, raw)).map(([name, value]) => {
      if (!ATTRIBUTE_NAME.test(name) || name in Object.prototype) throw new RegistryError(`${path}.${name}`, 'not a number\'s name: a lowercase letter, then up to 31 letters and digits');
      return [name, decimalString(`${path}.${name}`, value)];
    }),
  );
}

function twapOf(path: string, raw: unknown): { readonly minLiquidity: bigint } {
  const value = record(path, raw);
  onlyKeys(path, value, ['minLiquidity']);
  const minLiquidity = decimalString(`${path}.minLiquidity`, value.minLiquidity);
  if (minLiquidity === 0n) throw new RegistryError(`${path}.minLiquidity`, 'is 0, which any pool meets');
  return { minLiquidity };
}

/** The kinds an entry may have to carry each of these, such as `price` on a token or a vault. */
const PRICE_KINDS: Readonly<Record<'feed' | 'price' | 'twap', readonly ContractKind[]>> = { feed: ['oracle'], price: ['token', 'vault'], twap: ['pool'] };

/** The feeds that price `feed`'s unit in dollars, itself first, as `parseRegistry` proved they do. */
export function feedChain(feed: string, registry: Pick<Registry, 'entries'>): readonly RegistryEntry[] {
  const chain: RegistryEntry[] = [];
  for (let name = feed; name !== DOLLAR; ) {
    const entry = registry.entries.get(name) as RegistryEntry;
    chain.push(entry);
    name = (entry.feed as Feed).quote;
  }
  return chain;
}

/** Every pool of the registry whose mean price may be read. */
export function twapPools(registry: Pick<Registry, 'entries'>): readonly TwapPool[] {
  const named = (entry: RegistryEntry, attribute: string): RegistryEntry => registry.entries.get(entry.attributes[attribute] as string) as RegistryEntry;
  return [...registry.entries.values()].flatMap((entry) =>
    entry.twap === undefined ? [] : [{ entry, token0: named(entry, 'token0'), token1: named(entry, 'token1'), minLiquidity: entry.twap.minLiquidity }],
  );
}

function checkPrices(entries: ReadonlyMap<string, RegistryEntry>): void {
  for (const { name, feed, twap, code } of entries.values()) {
    if ((feed !== undefined || twap !== undefined) && code === undefined) throw new RegistryError(`${name}.code`, `missing, and a price is read from it; run pnpm pin-code ${name}`);
  }
  for (const { name, feed } of entries.values()) {
    if (feed === undefined) continue;
    let at: Feed = feed;
    for (let steps = 1; at.quote !== DOLLAR; steps++) {
      const next: Feed | undefined = entries.get(at.quote)?.feed;
      if (next === undefined) throw new RegistryError(`${name}.feed.quote`, `${JSON.stringify(at.quote)} is not ${DOLLAR} or a feed in the registry`);
      const [priced] = feedUnits(next.description);
      if (feedUnits(at.description)[1] !== priced) throw new RegistryError(`${name}.feed.quote`, `${JSON.stringify(at.description)} is not in the unit ${at.quote} prices, ${priced}`);
      if (steps === MAX_FEEDS) throw new RegistryError(`${name}.feed.quote`, `does not reach ${DOLLAR} within ${MAX_FEEDS} feeds`);
      at = next;
    }
  }
  for (const { name, price } of entries.values()) {
    if (price === undefined) continue;
    const feed = entries.get(price.feed)?.feed;
    if (feed === undefined) throw new RegistryError(`${name}.price.feed`, `${JSON.stringify(price.feed)} is not a feed in the registry`);
    const [priced] = feedUnits(feed.description);
    if (price.unit !== undefined && price.unit !== priced) throw new RegistryError(`${name}.price.unit`, `${price.feed} prices ${priced}`);
    if (priced.toLowerCase() !== name) {
      if (price.unit === undefined) throw new RegistryError(`${name}.price.feed`, `${price.feed} prices ${priced}, which is not ${name}'s name; a token worth one ${priced} says so in unit`);
      if (entries.has(priced.toLowerCase())) throw new RegistryError(`${name}.price.unit`, `${priced} is another entry's name`);
    }
    const peg = price.peg;
    if (peg !== undefined && peg !== DOLLAR && !feedChain(price.feed, { entries }).some((feed) => feed.name === peg)) {
      throw new RegistryError(`${name}.price.peg`, `${JSON.stringify(peg)} is not ${DOLLAR} or a feed on the way from ${price.feed} to it`);
    }
  }
  const pairs = new Map<string, string>();
  for (const { name, twap, attributes } of entries.values()) {
    if (twap === undefined) continue;
    for (const attribute of ['factory', 'token0', 'token1']) if (attributes[attribute] === undefined) throw new RegistryError(`${name}.attributes.${attribute}`, 'missing, and a twap needs it');
    const [token0, token1] = [entries.get(attributes.token0 as string) as RegistryEntry, entries.get(attributes.token1 as string) as RegistryEntry];
    if (token0.address >= token1.address) throw new RegistryError(`${name}.attributes.token1`, 'is not above token0 by address, the order a pool holds its tokens in');
    const pair = `${token0.name} ${token1.name}`;
    const twin = pairs.get(pair);
    if (twin !== undefined) throw new RegistryError(`${name}.twap`, `${twin} is already the twap pool of ${pair}`);
    pairs.set(pair, name);
  }
}

function entryOf(name: string, raw: unknown, table: AttributeTable): RegistryEntry {
  const path = name;
  const value = record(path, raw);
  onlyKeys(path, value, ['address', 'kind', 'source', 'apiSource', 'sourceLabel', 'sourceHeading', 'moreSources', 'defillama', 'coingecko', 'immunefi', 'sdk', 'attributes', 'routes', 'implementationRead', 'dependsOn', 'code', 'instanceCheck', 'size', 'standingAllowance', 'ignoresTrailer', 'feed', 'price', 'numbers', 'twap']);
  const address = parsed(() => parseAddress(`${path}.address`, value.address));
  const routes = value.routes === undefined ? undefined : routingOf(`${path}.routes`, value.routes);
  const implementationRead = value.implementationRead === undefined ? undefined : parseImplementationRead(`${path}.implementationRead`, value.implementationRead);
  if (routes !== undefined && implementationRead !== undefined) throw new RegistryError(`${path}.implementationRead`, 'beside routes, which name the code each selector runs');
  const code = value.code === undefined ? undefined : codePinsOf(`${path}.code`, value.code, routes);
  if (implementationRead !== undefined && code !== undefined) {
    const bare = [...code.earlier, code.current].findIndex((span) => span.pin.implementation === undefined);
    if (bare !== -1) throw new RegistryError(bare === code.earlier.length ? `${path}.code` : `${path}.code.earlier[${bare}]`, 'names no implementation, though the entry declares implementationRead');
  }
  const dependsOn = value.dependsOn === undefined ? undefined : dependsOnOf(`${path}.dependsOn`, value.dependsOn, name);
  const kind = CONTRACT_KINDS.find((k) => k === value.kind);
  if (kind === undefined) throw new RegistryError(`${path}.kind`, `not one of ${CONTRACT_KINDS.join(', ')}`);
  const source = parseHttpsUrl(value.source);
  if (source === undefined) throw new RegistryError(`${path}.source`, 'not an https URL');
  for (const key of ['sourceLabel', 'sourceHeading'] as const) if (value[key] !== undefined) pageText(`${path}.${key}`, value[key]);
  const attributes: { [attribute: string]: string } = {};
  if (value.attributes !== undefined) {
    for (const [key, target] of Object.entries(record(`${path}.attributes`, value.attributes))) {
      if (!table.has(key)) throw new RegistryError(`${path}.attributes.${key}`, `not an attribute ${ATTRIBUTES_PATH} declares`);
      if (typeof target !== 'string') throw new RegistryError(`${path}.attributes.${key}`, 'not a registry name');
      attributes[key] = target;
    }
  }
  if (value.defillama !== undefined && (typeof value.defillama !== 'string' || !DEFILLAMA_SLUG.test(value.defillama))) {
    throw new RegistryError(`${path}.defillama`, 'not a DefiLlama protocol slug');
  }
  if (value.coingecko !== undefined) {
    if (typeof value.coingecko !== 'string' || !COINGECKO_ID.test(value.coingecko)) throw new RegistryError(`${path}.coingecko`, 'not a CoinGecko coin id');
    if (!COINGECKO_KINDS.includes(kind)) throw new RegistryError(`${path}.coingecko`, `a ${kind} has no coingecko`);
  }
  if (value.immunefi !== undefined && (typeof value.immunefi !== 'string' || !IMMUNEFI_PROGRAM.test(value.immunefi))) {
    throw new RegistryError(`${path}.immunefi`, 'not an Immunefi program slug');
  }
  const entry = {
    name,
    address,
    kind,
    source,
    ...(value.apiSource === undefined ? {} : { apiSource: apiSourceOf(`${path}.apiSource`, value.apiSource, address) }),
    ...(value.sourceLabel === undefined ? {} : { sourceLabel: value.sourceLabel as string }),
    ...(value.sourceHeading === undefined ? {} : { sourceHeading: value.sourceHeading as string }),
    ...(value.moreSources === undefined ? {} : { moreSources: moreSourcesOf(`${path}.moreSources`, value.moreSources, address, source) }),
    attributes,
    ...(value.defillama === undefined ? {} : { defillama: value.defillama }),
    ...(value.coingecko === undefined ? {} : { coingecko: value.coingecko }),
    ...(value.immunefi === undefined ? {} : { immunefi: value.immunefi }),
    ...(value.sdk === undefined ? {} : { sdk: sdkOf(`${path}.sdk`, value.sdk) }),
    ...(routes === undefined ? {} : { routes }),
    ...(implementationRead === undefined ? {} : { implementationRead }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(code === undefined ? {} : { code }),
    ...(value.standingAllowance === undefined ? {} : { standingAllowance: standingAllowanceOf(`${path}.standingAllowance`, value.standingAllowance) }),
    ...(value.ignoresTrailer === undefined ? {} : { ignoresTrailer: nonEmpty(`${path}.ignoresTrailer`, value.ignoresTrailer) }),
    ...(value.size === undefined ? {} : { size: sizeViewOf(`${path}.size`, value.size, table) }),
    ...(value.feed === undefined ? {} : { feed: feedOf(`${path}.feed`, value.feed) }),
    ...(value.price === undefined ? {} : { price: priceOf(`${path}.price`, value.price) }),
    ...(value.numbers === undefined ? {} : { numbers: numbersOf(`${path}.numbers`, value.numbers) }),
    ...(value.twap === undefined ? {} : { twap: twapOf(`${path}.twap`, value.twap) }),
  };
  for (const key of ['feed', 'price', 'twap'] as const) if (value[key] !== undefined && !PRICE_KINDS[key].includes(kind)) throw new RegistryError(`${path}.${key}`, `a ${kind} has no ${key}`);
  if (kind !== 'factory') {
    if (value.instanceCheck !== undefined) throw new RegistryError(`${path}.instanceCheck`, `a ${kind} has no instanceCheck`);
    return entry;
  }
  return { ...entry, instanceCheck: instanceCheckOf(`${path}.instanceCheck`, value.instanceCheck, table) };
}

function dependsOnOf(path: string, raw: unknown, own: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DEPENDS_ON) throw new RegistryError(path, `not a list of 1 to ${MAX_DEPENDS_ON} registry names`);
  return raw.map((name: unknown, i) => {
    if (typeof name !== 'string' || !isEntryName(name)) throw new RegistryError(`${path}[${i}]`, 'not a registry name');
    if (name === own) throw new RegistryError(`${path}[${i}]`, 'names the entry itself');
    if (raw.indexOf(name) !== i) throw new RegistryError(`${path}[${i}]`, `${name} is listed twice`);
    return name;
  });
}

/** Morpho's `MarketParamsLib.id`: keccak256 of the ABI-encoded `MarketParams`. */
export function marketId(params: MarketParams): Hex {
  const words = MARKET_PARAMS.map((part) => uintWord(part === 'lltv' ? params.lltv : BigInt(params[part])));
  return `0x${bytesToHex(keccak_256(concatBytes(...words)))}` as Hex;
}

function marketOf(name: string, raw: unknown, entries: ReadonlyMap<string, RegistryEntry>): Market {
  const path = `markets.${name}`;
  const value = record(path, raw);
  const keys = [...Object.keys(MARKET_ENTRIES), 'lltv', 'id'];
  onlyKeys(path, value, keys);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new RegistryError(`${path}.${missing}`, 'missing');
  const parts = Object.fromEntries(
    (Object.entries(MARKET_ENTRIES) as [MarketEntryPart, ContractKind][]).map(([part, kind]) => {
      const target = value[part];
      const entry = typeof target === 'string' ? entries.get(target) : undefined;
      if (entry?.kind !== kind) throw new RegistryError(`${path}.${part}`, `${JSON.stringify(target)} is not ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} in the registry`);
      return [part, entry];
    }),
  ) as { readonly [P in MarketEntryPart]: RegistryEntry };
  const lltv = typeof value.lltv === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value.lltv) ? BigInt(value.lltv) : undefined;
  if (lltv === undefined || lltv >> 256n !== 0n) throw new RegistryError(`${path}.lltv`, 'not a decimal integer below 2^256');
  const id = hash32(`${path}.id`, value.id);
  const hashed = marketId({ loanToken: parts.loanToken.address, collateralToken: parts.collateralToken.address, oracle: parts.oracle.address, irm: parts.irm.address, lltv });
  if (id !== hashed) throw new RegistryError(`${path}.id`, `is not the id of these parameters, which hash to ${hashed}`);
  return { name, id, lltv, ...parts };
}

/** `registry/markets.json`: each market by name, every part resolved against the registry's entries. */
function marketsOf(raw: unknown, entries: ReadonlyMap<string, RegistryEntry>): Map<string, Market> {
  const markets = new Map<string, Market>();
  for (const [name, rawMarket] of Object.entries(record('markets', raw))) {
    if (!isEntryName(name)) throw new RegistryError(`markets.${name}`, 'not a market name');
    if (entries.has(name)) throw new RegistryError(`markets.${name}`, 'is also a registry contract');
    markets.set(name, marketOf(name, rawMarket, entries));
  }
  return markets;
}

/**
 * The registry's contracts, its markets from `rawMarkets`, the markets table, which may be absent, and the attributes
 * its entries may carry from `rawAttributes`, the attributes table, which is `ATTRIBUTES_BEFORE_TABLE` when absent.
 */
export function parseRegistry(raw: unknown, rawMarkets: unknown = {}, rawAttributes: unknown = ATTRIBUTES_BEFORE_TABLE): Registry {
  const attributes = parseAttributeTable(rawAttributes);
  const entries = new Map<string, RegistryEntry>();
  const byAddress = new Map<Address, RegistryEntry>();
  for (const [name, rawEntry] of Object.entries(record('registry', raw))) {
    if (!isEntryName(name)) throw new RegistryError(name, 'not a registry name');
    const entry = entryOf(name, rawEntry, attributes);
    const twin = byAddress.get(entry.address);
    if (twin !== undefined) throw new RegistryError(`${name}.address`, `same address as ${twin.name}`);
    entries.set(name, entry);
    byAddress.set(entry.address, entry);
  }
  for (const entry of entries.values()) {
    for (const [key, target] of Object.entries(entry.attributes)) {
      const kind = attributes.get(key) as ContractKind;
      if (entries.get(target)?.kind !== kind) throw new RegistryError(`${entry.name}.attributes.${key}`, `${JSON.stringify(target)} is not ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} in the registry`);
    }
    entry.dependsOn?.forEach((target, i) => {
      const named = entries.get(target);
      if (named === undefined) throw new RegistryError(`${entry.name}.dependsOn[${i}]`, `${JSON.stringify(target)} is not in the registry`);
      if (named.dependsOn !== undefined) throw new RegistryError(`${entry.name}.dependsOn[${i}]`, `${target} depends on other entries itself; a dependency is one step deep`);
    });
  }
  checkPrices(entries);
  return { attributes, entries, byAddress, markets: marketsOf(rawMarkets, entries) };
}

const optionalText = (repoRoot: string, path: string): string | undefined => (existsSync(join(repoRoot, path)) ? readFileSync(join(repoRoot, path), 'utf8') : undefined);

/** The markets table's text, or undefined when the repository has none. */
export const marketsText = (repoRoot: string): string | undefined => optionalText(repoRoot, MARKETS_PATH);

/** The attributes table's text, or undefined when the repository has none. */
export const attributesText = (repoRoot: string): string | undefined => optionalText(repoRoot, ATTRIBUTES_PATH);

/** The registry from its three files' texts; an absent table is parsed as `parseRegistry` takes it. */
export function registryFromTexts(contracts: string, markets: string | undefined, attributes: string | undefined): Registry {
  return parseRegistry(JSON.parse(contracts), markets === undefined ? {} : JSON.parse(markets), attributes === undefined ? ATTRIBUTES_BEFORE_TABLE : JSON.parse(attributes));
}

export function loadRegistry(repoRoot: string): Registry {
  return registryFromTexts(readFileSync(join(repoRoot, REGISTRY_PATH), 'utf8'), marketsText(repoRoot), attributesText(repoRoot));
}
