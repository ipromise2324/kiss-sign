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

export const CONTRACT_KINDS = ['token', 'vault', 'router', 'multisend', 'adapter', 'factory', 'distributor', 'bridge', 'lending', 'oracle', 'irm'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

/** What a registry entry may say about itself, each naming another registry entry, and which kinds may say it. */
export const ATTRIBUTES = { asset: { of: ['vault'], names: 'token' }, factory: { of: ['vault'], names: 'factory' } } as const satisfies Record<
  string,
  { of: readonly ContractKind[]; names: ContractKind }
>;
export type Attribute = keyof typeof ATTRIBUTES;

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
  readonly attributes: { readonly [A in Attribute]?: string };
  /** A factory's view function that answers true only for a contract it created, such as `isMetaMorpho(address)`. */
  readonly instanceCheck?: AbiFunction;
  /** The DefiLlama protocol slug this contract belongs to, such as `morpho-blue`; `pnpm check-sources` compares its listing with `source`. */
  readonly defillama?: string;
  /** The CoinGecko coin id of a token or vault share, such as `usd-coin`; `pnpm check-sources` checks CoinGecko lists that coin at `address`. */
  readonly coingecko?: string;
  /** How a proxy that sends each selector to its own implementation answers its routes; its code pin then holds them. */
  readonly routes?: SelectorRouting;
  /** Entries a call to this one reaches though no call targets them, touched whenever this one is. */
  readonly dependsOn?: readonly string[];
  /** The code a call to this address ran at each block `pnpm pin-code` found; verify requires the code of the block it reads. */
  readonly code?: CodePins;
};

/**
 * A proxy's two views, `implementationOf(bytes4)`, answering one address word, and `selectorsOf(address)`, answering a
 * `bytes4[]`, and the seeds research chose so every implementation is reached: no view lists the implementations.
 */
export type SelectorRouting = { readonly implementationOf: AbiFunction; readonly selectorsOf: AbiFunction; readonly seeds: readonly Hex[] };

/** An implementation the seeds reach, its code hash, and the selectors it serves in the order `selectorsOf` answered. */
export type Route = { readonly address: Address; readonly hash: Hex; readonly selectors: readonly Hex[] };

/** An official page that lists an address, the text next to it there, and the heading above it when the page needs one. */
export type SourcePage = { readonly url: HttpsUrl; readonly label: string; readonly heading?: string };

/** Every page that lists the entry's address: its `source`, then each of `moreSources`. */
export const pageUrlsOf = (entry: RegistryEntry): readonly HttpsUrl[] => [entry.source, ...(entry.moreSources ?? []).map((page) => page.url)];

/**
 * keccak256 of the runtime code at the address, behind a proxy the implementation it delegates to and its code's, and
 * for an entry with `routes`, its routes sorted by address.
 */
export type CodePin = { readonly hash: Hex; readonly implementation?: { readonly address: Address; readonly hash: Hex }; readonly routes?: readonly Route[] };

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
  readonly entries: ReadonlyMap<string, RegistryEntry>;
  readonly byAddress: ReadonlyMap<Address, RegistryEntry>;
  readonly markets: ReadonlyMap<string, Market>;
};

export const REGISTRY_DIR = 'registry';
export const REGISTRY_PATH = join(REGISTRY_DIR, 'contracts.json');
export const MARKETS_PATH = join(REGISTRY_DIR, 'markets.json');

/** Lowercase words joined by `-` or `.`, such as `multisend-call-only-1.4.1`. `safe` names the Safe itself, `eth` native ETH. */
export const NAME = /^[a-z0-9]+([.-][a-z0-9]+)*$/;
export const RESERVED_NAMES = ['safe', 'eth'] as const;

const DEFILLAMA_SLUG = /^[a-z0-9]+([.-][a-z0-9]+)*$/;
const COINGECKO_ID = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
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

export function isAttribute(raw: string): raw is Attribute {
  return Object.hasOwn(ATTRIBUTES, raw);
}

function record(path: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new RegistryError(path, 'not a JSON object');
  return raw as Record<string, unknown>;
}

function onlyKeys(path: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new RegistryError(`${path}.${extra}`, 'unexpected field');
}

function oneParamFunction(path: string, raw: unknown, type: 'address' | 'bytes4'): AbiFunction {
  if (typeof raw !== 'string') throw new RegistryError(path, 'not a function signature');
  let fn: AbiFunction;
  try {
    fn = parseFunctionSignature(raw);
  } catch (error) {
    if (error instanceof AbiSignatureError) throw new RegistryError(path, error.message);
    throw error;
  }
  const [param, ...more] = fn.params;
  if (param === undefined || more.length > 0 || canonicalType(param.type) !== type) throw new RegistryError(path, `must take exactly one ${type}`);
  return fn;
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
  onlyKeys(`${path}.implementation`, implementation, ['address', 'hash']);
  return {
    hash,
    implementation: {
      address: parsed(() => parseAddress(`${path}.implementation.address`, implementation.address)),
      hash: hash32(`${path}.implementation.hash`, implementation.hash),
    },
    ...routes,
  };
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
    const ok = (typeof step === 'string' && API_KEY_STEP.test(step)) || (typeof step === 'number' && Number.isSafeInteger(step) && step >= 0 && step < 10_000);
    if (!ok) throw new RegistryError(`${path}.path[${i}]`, 'not a key of letters, digits and _ or an index below 10000');
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

function entryOf(name: string, raw: unknown): RegistryEntry {
  const path = name;
  const value = record(path, raw);
  onlyKeys(path, value, ['address', 'kind', 'source', 'apiSource', 'sourceLabel', 'sourceHeading', 'moreSources', 'defillama', 'coingecko', 'attributes', 'routes', 'dependsOn', 'code', 'instanceCheck']);
  const address = parsed(() => parseAddress(`${path}.address`, value.address));
  const routes = value.routes === undefined ? undefined : routingOf(`${path}.routes`, value.routes);
  const code = value.code === undefined ? undefined : codePinsOf(`${path}.code`, value.code, routes);
  const dependsOn = value.dependsOn === undefined ? undefined : dependsOnOf(`${path}.dependsOn`, value.dependsOn, name);
  const kind = CONTRACT_KINDS.find((k) => k === value.kind);
  if (kind === undefined) throw new RegistryError(`${path}.kind`, `not one of ${CONTRACT_KINDS.join(', ')}`);
  const source = parseHttpsUrl(value.source);
  if (source === undefined) throw new RegistryError(`${path}.source`, 'not an https URL');
  for (const key of ['sourceLabel', 'sourceHeading'] as const) if (value[key] !== undefined) pageText(`${path}.${key}`, value[key]);
  const attributes: { [A in Attribute]?: string } = {};
  if (value.attributes !== undefined) {
    const raws = record(`${path}.attributes`, value.attributes);
    for (const [key, target] of Object.entries(raws)) {
      if (!isAttribute(key)) throw new RegistryError(`${path}.attributes.${key}`, 'unknown attribute');
      if (!(ATTRIBUTES[key].of as readonly ContractKind[]).includes(kind)) {
        throw new RegistryError(`${path}.attributes.${key}`, `a ${kind} has no ${key}`);
      }
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
    ...(routes === undefined ? {} : { routes }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(code === undefined ? {} : { code }),
  };
  if (kind !== 'factory') {
    if (value.instanceCheck !== undefined) throw new RegistryError(`${path}.instanceCheck`, `a ${kind} has no instanceCheck`);
    return entry;
  }
  return { ...entry, instanceCheck: oneParamFunction(`${path}.instanceCheck`, value.instanceCheck, 'address') };
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

/** The registry's contracts, and its markets from `rawMarkets`, the markets table, which may be absent. */
export function parseRegistry(raw: unknown, rawMarkets: unknown = {}): Registry {
  const entries = new Map<string, RegistryEntry>();
  const byAddress = new Map<Address, RegistryEntry>();
  for (const [name, rawEntry] of Object.entries(record('registry', raw))) {
    if (!isEntryName(name)) throw new RegistryError(name, 'not a registry name');
    const entry = entryOf(name, rawEntry);
    const twin = byAddress.get(entry.address);
    if (twin !== undefined) throw new RegistryError(`${name}.address`, `same address as ${twin.name}`);
    entries.set(name, entry);
    byAddress.set(entry.address, entry);
  }
  for (const entry of entries.values()) {
    for (const [key, target] of Object.entries(entry.attributes) as [Attribute, string][]) {
      const named = entries.get(target);
      if (named?.kind !== ATTRIBUTES[key].names) {
        throw new RegistryError(`${entry.name}.attributes.${key}`, `${JSON.stringify(target)} is not a ${ATTRIBUTES[key].names} in the registry`);
      }
    }
    entry.dependsOn?.forEach((target, i) => {
      const named = entries.get(target);
      if (named === undefined) throw new RegistryError(`${entry.name}.dependsOn[${i}]`, `${JSON.stringify(target)} is not in the registry`);
      if (named.dependsOn !== undefined) throw new RegistryError(`${entry.name}.dependsOn[${i}]`, `${target} depends on other entries itself; a dependency is one step deep`);
    });
  }
  return { entries, byAddress, markets: marketsOf(rawMarkets, entries) };
}

/** The markets table's text, or undefined when the repository has none. */
export function marketsText(repoRoot: string): string | undefined {
  const path = join(repoRoot, MARKETS_PATH);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

export function loadRegistry(repoRoot: string): Registry {
  const markets = marketsText(repoRoot);
  return parseRegistry(JSON.parse(readFileSync(join(repoRoot, REGISTRY_PATH), 'utf8')), markets === undefined ? {} : JSON.parse(markets));
}
