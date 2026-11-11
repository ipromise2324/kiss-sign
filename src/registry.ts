import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AbiSignatureError, parseFunctionSignature } from './decode/abi.ts';
import type { AbiFunction } from './decode/abi.ts';
import { SafeTxParseError, parseAddress, parseHex } from './safe/types.ts';
import type { Address, Hex } from './safe/types.ts';

export const CONTRACT_KINDS = ['token', 'vault', 'router', 'multisend', 'adapter', 'factory', 'distributor', 'bridge'] as const;
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

export type RegistryEntry = {
  readonly name: string;
  readonly address: Address;
  readonly kind: ContractKind;
  /** A page that names this address as this contract. */
  readonly source: HttpsUrl;
  /** The text next to the address on the `source` page that names this contract or its role, such as `Bundler3`. */
  readonly sourceLabel?: string;
  /** Text the nearest heading above the address must hold, for a page whose rows name only a chain, such as `MessageTransmitter`. */
  readonly sourceHeading?: string;
  readonly attributes: { readonly [A in Attribute]?: string };
  /** A factory's view function that answers true only for a contract it created, such as `isMetaMorpho(address)`. */
  readonly instanceCheck?: AbiFunction;
  /** The DefiLlama protocol slug this contract belongs to, such as `morpho-blue`; `pnpm check-sources` compares its listing with `source`. */
  readonly defillama?: string;
  /** The CoinGecko coin id of a token or vault share, such as `usd-coin`; `pnpm check-sources` checks CoinGecko lists that coin at `address`. */
  readonly coingecko?: string;
  /** The code a call to this address ran at each block `pnpm pin-code` found; verify requires the code of the block it reads. */
  readonly code?: CodePins;
};

/** keccak256 of the runtime code at the address, and behind a proxy, the implementation it delegates to and its code's. */
export type CodePin = { readonly hash: Hex; readonly implementation?: { readonly address: Address; readonly hash: Hex } };

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

export type Registry = {
  readonly entries: ReadonlyMap<string, RegistryEntry>;
  readonly byAddress: ReadonlyMap<Address, RegistryEntry>;
};

export const REGISTRY_PATH = join('registry', 'contracts.json');

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

function instanceCheckOf(path: string, raw: unknown): AbiFunction {
  if (typeof raw !== 'string') throw new RegistryError(path, 'not a function signature');
  let fn: AbiFunction;
  try {
    fn = parseFunctionSignature(raw);
  } catch (error) {
    if (error instanceof AbiSignatureError) throw new RegistryError(path, error.message);
    throw error;
  }
  if (fn.params.length !== 1 || fn.params[0]?.type.kind !== 'address') throw new RegistryError(path, 'must take exactly one address');
  return fn;
}

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

function codePinOf(path: string, value: Record<string, unknown>): CodePin {
  const hash = hash32(`${path}.hash`, value.hash);
  if (value.implementation === undefined) return { hash };
  const implementation = record(`${path}.implementation`, value.implementation);
  onlyKeys(`${path}.implementation`, implementation, ['address', 'hash']);
  return {
    hash,
    implementation: {
      address: parsed(() => parseAddress(`${path}.implementation.address`, implementation.address)),
      hash: hash32(`${path}.implementation.hash`, implementation.hash),
    },
  };
}

/** `from` may be absent only on a pin with no earlier ones, as `pnpm pin-code` wrote before it read ranges: it holds from block 0. */
function codePinsOf(path: string, raw: unknown): CodePins {
  const value = record(path, raw);
  onlyKeys(path, value, ['hash', 'implementation', 'from', 'earlier']);
  const current = { from: value.from === undefined ? 0n : blockOf(`${path}.from`, value.from), pin: codePinOf(path, value) };
  if (value.earlier === undefined) return { earlier: [], current };
  if (!Array.isArray(value.earlier) || value.earlier.length === 0) throw new RegistryError(`${path}.earlier`, 'not a non-empty list of pins');
  const earlier = value.earlier.map((rawSpan: unknown, i): CodeSpan => {
    const at = `${path}.earlier[${i}]`;
    const span = record(at, rawSpan);
    onlyKeys(at, span, ['from', 'hash', 'implementation']);
    return { from: blockOf(`${at}.from`, span.from), pin: codePinOf(at, span) };
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

function entryOf(name: string, raw: unknown): RegistryEntry {
  const path = name;
  const value = record(path, raw);
  onlyKeys(path, value, ['address', 'kind', 'source', 'sourceLabel', 'sourceHeading', 'defillama', 'coingecko', 'attributes', 'code', 'instanceCheck']);
  const address = parsed(() => parseAddress(`${path}.address`, value.address));
  const code = value.code === undefined ? undefined : codePinsOf(`${path}.code`, value.code);
  const kind = CONTRACT_KINDS.find((k) => k === value.kind);
  if (kind === undefined) throw new RegistryError(`${path}.kind`, `not one of ${CONTRACT_KINDS.join(', ')}`);
  const source = parseHttpsUrl(value.source);
  if (source === undefined) throw new RegistryError(`${path}.source`, 'not an https URL');
  for (const key of ['sourceLabel', 'sourceHeading'] as const) {
    const text = value[key];
    if (text !== undefined && (typeof text !== 'string' || !/^\S(?:[^\p{Cc}]{0,118}\S)?$/u.test(text))) {
      throw new RegistryError(`${path}.${key}`, 'not page text of 1 to 120 characters');
    }
  }
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
    ...(value.sourceLabel === undefined ? {} : { sourceLabel: value.sourceLabel as string }),
    ...(value.sourceHeading === undefined ? {} : { sourceHeading: value.sourceHeading as string }),
    attributes,
    ...(value.defillama === undefined ? {} : { defillama: value.defillama }),
    ...(value.coingecko === undefined ? {} : { coingecko: value.coingecko }),
    ...(code === undefined ? {} : { code }),
  };
  if (kind !== 'factory') {
    if (value.instanceCheck !== undefined) throw new RegistryError(`${path}.instanceCheck`, `a ${kind} has no instanceCheck`);
    return entry;
  }
  return { ...entry, instanceCheck: instanceCheckOf(`${path}.instanceCheck`, value.instanceCheck) };
}

export function parseRegistry(raw: unknown): Registry {
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
  }
  return { entries, byAddress };
}

export function loadRegistry(repoRoot: string): Registry {
  return parseRegistry(JSON.parse(readFileSync(join(repoRoot, REGISTRY_PATH), 'utf8')));
}
