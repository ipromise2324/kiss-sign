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

export type InstanceRefusal = { readonly kind: 'refused'; readonly why: string };

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
  const refuse = (why: string): InstanceRefusal => ({ kind: 'refused', why });
  const entry = registry.entries.get(name);
  if (entry === undefined) return refuse(`${name} is not in the registry`);
  const factoryName = entry.attributes.factory;
  if (factoryName === undefined) return refuse(`${name} names no factory`);
  const factory = registry.entries.get(factoryName) as RegistryEntry;
  const check = factory.instanceCheck;
  if (check === undefined) return refuse(`${factoryName} has no instanceCheck`);
  const asking = question(check, entry, registry);
  if ('missing' in asking) return refuse(`${name} has no ${asking.missing} attribute, which ${factoryName}'s instanceCheck ${check.fn.signature} binds`);
  const { asked, data } = asking;
  const read = await reader.call({ to: factory.address, data }, block);
  if (read.kind === 'unverifiable') return refuse(read.reason);
  const answer = read.value.kind === 'returned' ? read.value.data.toLowerCase() : 'a revert';
  const created = (answered: string): InstanceProof => ({ kind: 'created', entry, factory, asked, answered, block, providers: read.providers });
  if (check.kind === 'answers-true') {
    if (answer === FALSE) return refuse(`${factoryName} answered ${asked} false for ${name}: it did not create it`);
    if (answer !== TRUE) return refuse(`${factoryName} answered ${asked} with ${answer}, not true or false`);
    return created('true');
  }
  const address = ADDRESS_WORD.exec(answer)?.[1];
  if (address === undefined) return refuse(`${factoryName} answered ${asked} with ${answer}, not an address`);
  if (`0x${address}` !== entry.address) return refuse(`${factoryName} answered ${asked} = ${checksumAddress(`0x${address}` as Address)}, not ${name}: its official contract is another`);
  return created(checksumAddress(entry.address));
}
