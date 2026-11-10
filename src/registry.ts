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

export type RegistryEntry = {
  readonly name: string;
  readonly address: Address;
  readonly kind: ContractKind;
  /** A page that names this address as this contract. */
  readonly source: string;
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
  /** The code a call to this address ran when `pnpm pin-code` read it; verify requires the same code at every signing. */
  readonly code?: CodePin;
};

/** keccak256 of the runtime code at the address, and behind a proxy, the implementation it delegates to and its code's. */
export type CodePin = { readonly hash: Hex; readonly implementation?: { readonly address: Address; readonly hash: Hex } };

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

function codePinOf(path: string, raw: unknown): CodePin {
  const value = record(path, raw);
  onlyKeys(path, value, ['hash', 'implementation']);
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

function entryOf(name: string, raw: unknown): RegistryEntry {
  const path = name;
  const value = record(path, raw);
  onlyKeys(path, value, ['address', 'kind', 'source', 'sourceLabel', 'sourceHeading', 'defillama', 'coingecko', 'attributes', 'code', 'instanceCheck']);
  const address = parsed(() => parseAddress(`${path}.address`, value.address));
  const code = value.code === undefined ? undefined : codePinOf(`${path}.code`, value.code);
  const kind = CONTRACT_KINDS.find((k) => k === value.kind);
  if (kind === undefined) throw new RegistryError(`${path}.kind`, `not one of ${CONTRACT_KINDS.join(', ')}`);
  if (typeof value.source !== 'string' || !/^https:\/\/\S+$/.test(value.source)) {
    throw new RegistryError(`${path}.source`, 'not an https URL');
  }
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
    source: value.source,
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
