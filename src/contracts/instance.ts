import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { ProviderName } from '../chain/providers.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { encodeCall } from '../decode/codec.ts';
import type { AbiValue } from '../decode/codec.ts';
import type { InstanceCheck, Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';

/**
 * The registry factory a registry entry names answered, through both providers, that it created that entry's contract:
 * `asked` is the call with no space in it, such as `isMetaMorpho(address)` or `computeToken(usdc,"fToken")`, and
 * `answered` is `true` or the entry's checksum address.
 */
export type InstanceProof = {
  readonly kind: 'created';
  readonly entry: RegistryEntry;
  readonly factory: RegistryEntry;
  readonly asked: string;
  readonly answered: string;
  readonly block: BlockRef;
  readonly providers: readonly [ProviderName, ProviderName];
};

/**
 * Why the factory vouched for nothing: it answered false or another contract (`not-created`), answered neither true,
 * false nor an address (`other-answer`), the providers gave no agreed answer (`no-answer`), or the registry gives
 * nothing to ask (`unaskable`).
 */
export type RefusalCause = 'not-created' | 'other-answer' | 'no-answer' | 'unaskable';
export type InstanceRefusal = { readonly kind: 'refused'; readonly cause: RefusalCause; readonly why: string };

/** Why a vault vouched for nothing: as `RefusalCause`, but `not-used` when it answered false. */
export type AdapterCause = Exclude<RefusalCause, 'not-created'> | 'not-used';

/**
 * What a registry vault whose `adapter` attribute names an adapter answered, through both providers, to its factory's
 * `adapterCheck` for that adapter.
 */
export type AdapterAnswer = { readonly vault: RegistryEntry; readonly asked: string; readonly block: BlockRef } & (
  | { readonly kind: 'uses'; readonly providers: readonly [ProviderName, ProviderName] }
  | { readonly kind: 'refused'; readonly cause: AdapterCause; readonly why: string }
);

/** Why an adapter's answer vouched for nothing: as `AdapterCause`, but `other-parent` when it names another vault. */
export type ParentCause = Exclude<AdapterCause, 'not-used'> | 'other-parent';

/**
 * What an adapter answered, through both providers, to its factory's `parentCheck`, compared with one registry vault
 * whose `adapter` attribute names it: `made-for` when the answer is that vault's address.
 */
export type ParentAnswer = { readonly vault: RegistryEntry; readonly asked: string; readonly block: BlockRef } & (
  | { readonly kind: 'made-for'; readonly providers: readonly [ProviderName, ProviderName] }
  | { readonly kind: 'refused'; readonly cause: ParentCause; readonly why: string }
);

const TRUE = `0x${'00'.repeat(31)}01`;
const FALSE = `0x${'00'.repeat(32)}`;
const ADDRESS_WORD = /^0x0{24}([0-9a-f]{40})$/;

function question(check: InstanceCheck, entry: RegistryEntry, registry: Registry): { readonly asked: string; readonly data: Hex } | { readonly missing: string } {
  if (check.kind === 'answers-true') return { asked: check.fn.signature, data: `${check.fn.selector}${entry.address.slice(2).padStart(64, '0')}` as Hex };
  const words: string[] = [];
  const args: AbiValue[] = [];
  for (const arg of check.args) {
    if (arg.kind === 'string') {
      words.push(JSON.stringify(arg.value));
      args.push({ kind: 'string', value: utf8ToBytes(arg.value), span: [0, 0] });
      continue;
    }
    const name = entry.attributes[arg.attribute];
    if (name === undefined) return { missing: arg.attribute };
    words.push(name);
    args.push({ kind: 'address', value: (registry.entries.get(name) as RegistryEntry).address, span: [0, 0] });
  }
  return { asked: `${check.fn.name}(${words.join(',')})`, data: `0x${bytesToHex(encodeCall({ fn: check.fn, args, trailer: undefined }))}` as Hex };
}

export async function proveInstance(reader: Reader, registry: Registry, name: string, block: BlockRef): Promise<InstanceProof | InstanceRefusal> {
  const refuse = (cause: RefusalCause, why: string): InstanceRefusal => ({ kind: 'refused', cause, why });
  const entry = registry.entries.get(name);
  if (entry === undefined) return refuse('unaskable', `${name} is not in the registry`);
  const factoryName = entry.attributes.factory;
  if (factoryName === undefined) return refuse('unaskable', `${name} names no factory`);
  const factory = registry.entries.get(factoryName) as RegistryEntry;
  const check = factory.instanceCheck;
  if (check === undefined) return refuse('unaskable', `${factoryName} has no instanceCheck`);
  const asking = question(check, entry, registry);
  if ('missing' in asking) return refuse('unaskable', `${name} has no ${asking.missing} attribute, which ${factoryName}'s instanceCheck ${check.fn.signature} binds`);
  const { asked, data } = asking;
  const read = await reader.call({ to: factory.address, data }, block);
  if (read.kind === 'unverifiable') return refuse('no-answer', read.reason);
  const answer = read.value.kind === 'returned' ? read.value.data.toLowerCase() : 'a revert';
  const created = (answered: string): InstanceProof => ({ kind: 'created', entry, factory, asked, answered, block, providers: read.providers });
  if (check.kind === 'answers-true') {
    if (answer === FALSE) return refuse('not-created', `${factoryName} answered ${asked} false for ${name}: it did not create it`);
    if (answer !== TRUE) return refuse('other-answer', `${factoryName} answered ${asked} with ${answer}, not true or false`);
    return created('true');
  }
  const address = ADDRESS_WORD.exec(answer)?.[1];
  if (address === undefined) return refuse('other-answer', `${factoryName} answered ${asked} with ${answer}, not an address`);
  if (`0x${address}` !== entry.address) return refuse('not-created', `${factoryName} answered ${asked} = ${checksumAddress(`0x${address}` as Address)}, not ${name}: its official contract is another`);
  return created(checksumAddress(entry.address));
}

export const vaultsNaming = (registry: Registry, adapter: string): RegistryEntry[] => [...registry.entries.values()].filter((entry) => entry.kind === 'vault' && entry.attributes.adapter === adapter);

/** Asks each registry vault whose `adapter` attribute names the adapter, through its factory's `adapterCheck`, whether it allocates through it. */
export async function proveAdapterOf(reader: Reader, registry: Registry, adapter: RegistryEntry, block: BlockRef): Promise<AdapterAnswer[]> {
  const answers: AdapterAnswer[] = [];
  for (const vault of vaultsNaming(registry, adapter.name)) {
    const factoryName = vault.attributes.factory;
    const check = factoryName === undefined ? undefined : registry.entries.get(factoryName)?.adapterCheck;
    const asked = check === undefined ? 'adapterCheck' : check.signature;
    const refuse = (cause: AdapterCause, why: string): AdapterAnswer => ({ vault, asked, block, kind: 'refused', cause, why });
    if (check === undefined) {
      answers.push(refuse('unaskable', factoryName === undefined ? `${vault.name} names no factory` : `${factoryName} has no adapterCheck`));
      continue;
    }
    const read = await reader.call({ to: vault.address, data: `${check.selector}${adapter.address.slice(2).padStart(64, '0')}` as Hex }, block);
    if (read.kind === 'unverifiable') {
      answers.push(refuse('no-answer', read.reason));
      continue;
    }
    const answer = read.value.kind === 'returned' ? read.value.data.toLowerCase() : 'a revert';
    if (answer === TRUE) answers.push({ vault, asked, block, kind: 'uses', providers: read.providers });
    else if (answer === FALSE) answers.push(refuse('not-used', `${vault.name} answered ${asked} false for ${adapter.name}: it does not allocate through it`));
    else answers.push(refuse('other-answer', `${vault.name} answered ${asked} with ${answer}, not true or false`));
  }
  return answers;
}

/** Asks the adapter, through its factory's `parentCheck`, which contract it was made for, and compares the answer with each registry vault naming it. */
export async function proveParentOf(reader: Reader, registry: Registry, adapter: RegistryEntry, block: BlockRef): Promise<ParentAnswer[]> {
  const vaults = vaultsNaming(registry, adapter.name);
  if (vaults.length === 0) return [];
  const factoryName = adapter.attributes.factory;
  const check = factoryName === undefined ? undefined : registry.entries.get(factoryName)?.parentCheck;
  const asked = check === undefined ? 'parentCheck' : check.signature;
  const refuseAll = (cause: ParentCause, why: string): ParentAnswer[] => vaults.map((vault) => ({ vault, asked, block, kind: 'refused', cause, why }));
  if (check === undefined) return refuseAll('unaskable', factoryName === undefined ? `${adapter.name} names no factory` : `${factoryName} has no parentCheck`);
  const read = await reader.call({ to: adapter.address, data: check.selector }, block);
  if (read.kind === 'unverifiable') return refuseAll('no-answer', read.reason);
  const answer = read.value.kind === 'returned' ? read.value.data.toLowerCase() : 'a revert';
  const parent = ADDRESS_WORD.exec(answer)?.[1];
  if (parent === undefined) return refuseAll('other-answer', `${adapter.name} answered ${asked} with ${answer}, not an address`);
  return vaults.map((vault): ParentAnswer =>
    `0x${parent}` === vault.address
      ? { vault, asked, block, kind: 'made-for', providers: read.providers }
      : { vault, asked, block, kind: 'refused', cause: 'other-parent', why: `${adapter.name} answered ${asked} = ${checksumAddress(`0x${parent}` as Address)}, not ${vault.name}: it was made for another vault` },
  );
}
