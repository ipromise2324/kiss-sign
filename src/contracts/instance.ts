import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { ProviderName } from '../chain/providers.ts';
import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { encodeCall } from '../decode/codec.ts';
import type { AbiValue } from '../decode/codec.ts';
import { entriesNaming, partyEntry } from '../registry.ts';
import type { InstanceArg, InstanceView, Party, Registry, RegistryEntry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';

/**
 * Why a view vouched for nothing: its party said no, answering false or another address (`denied`), answered neither
 * true, false nor an address (`other-answer`), the providers gave no agreed answer (`no-answer`), or the registry gives
 * nothing to ask (`unaskable`).
 */
export type RefusalCause = 'denied' | 'other-answer' | 'no-answer' | 'unaskable';

/**
 * What one view of a factory's `instanceCheck` answered about an instance, through both providers: `asker` is the entry
 * asked, `namer` the entry a `namedBy` party stood for, `asked` the call with no space in it, such as
 * `isMetaMorpho(address)` or `computeToken(usdc,"fToken")`, and `answered` is `true` or the expected checksum address.
 */
export type ViewAnswer = { readonly view: InstanceView; readonly index: number; readonly asker: RegistryEntry | undefined; readonly namer: RegistryEntry | undefined; readonly asked: string } & (
  | { readonly kind: 'vouched'; readonly answered: string; readonly providers: readonly [ProviderName, ProviderName] }
  | { readonly kind: 'refused'; readonly cause: RefusalCause; readonly why: string }
);

/** Every view of the factory's `instanceCheck` asked about `entry` at `block`, in order, a `namedBy` view once per entry naming it. */
export type InstanceAnswers = { readonly kind: 'asked'; readonly entry: RegistryEntry; readonly factory: RegistryEntry; readonly block: BlockRef; readonly answers: readonly ViewAnswer[] };
export type InstanceUnasked = { readonly kind: 'unasked'; readonly why: string };

/** Whether the factory admitted the instance: every view vouched. */
export const admitted = (proof: InstanceAnswers): boolean => proof.answers.every((answer) => answer.kind === 'vouched');

const TRUE = `0x${'00'.repeat(31)}01`;
const FALSE = `0x${'00'.repeat(32)}`;
const ADDRESS_WORD = /^0x0{24}([0-9a-f]{40})$/;

const partiesOf = (view: InstanceView): Party[] => [view.ask, ...view.args.flatMap((arg) => (arg.kind === 'party' ? [arg.party] : [])), ...(view.answers.kind === 'party' ? [view.answers.party] : [])];

/** The one attribute a view's `namedBy` parties name the instance by, if it has any. */
const namedByOf = (view: InstanceView): string | undefined => partiesOf(view).find((party) => party.kind === 'named-by')?.attribute;

type Resolved = { readonly entry: RegistryEntry } | { readonly missing: string };

function resolve(party: Party, instance: RegistryEntry, namer: RegistryEntry | undefined, registry: Registry): Resolved {
  if (party.kind === 'named-by') return { entry: namer as RegistryEntry };
  const entry = partyEntry(party, instance, registry);
  return entry === undefined ? { missing: party.kind === 'attribute' ? party.attribute : 'factory' } : { entry };
}

const word = (arg: Exclude<InstanceArg, { kind: 'party' }>): string =>
  arg.kind === 'string' ? JSON.stringify(arg.value) : arg.kind === 'address' ? checksumAddress(arg.value) : arg.kind === 'bytes32' ? arg.value : `${arg.value}`;

const constantValue = (arg: Exclude<InstanceArg, { kind: 'party' }>): AbiValue =>
  arg.kind === 'string'
    ? { kind: 'string', value: utf8ToBytes(arg.value), span: [0, 0] }
    : arg.kind === 'bytes32'
      ? { kind: 'fixed-bytes', value: arg.value, span: [0, 0] }
      : arg.kind === 'address'
        ? { kind: 'address', value: arg.value, span: [0, 0] }
        : { kind: arg.kind, value: arg.value, span: [0, 0] };

/**
 * The call a view makes about `instance`: the instance shows as its type, `address`, as a bare `isMetaMorpho(address)`
 * always printed; any other party by its registry name, and each constant as written.
 */
function question(view: InstanceView, instance: RegistryEntry, namer: RegistryEntry | undefined, registry: Registry): { readonly asked: string; readonly to: RegistryEntry; readonly data: Hex } | { readonly missing: string } {
  const words: string[] = [];
  const args: AbiValue[] = [];
  for (const arg of view.args) {
    if (arg.kind !== 'party') {
      words.push(word(arg));
      args.push(constantValue(arg));
      continue;
    }
    const bound = resolve(arg.party, instance, namer, registry);
    if ('missing' in bound) return bound;
    words.push(arg.party.kind === 'instance' ? 'address' : bound.entry.name);
    args.push({ kind: 'address', value: bound.entry.address, span: [0, 0] });
  }
  const to = resolve(view.ask, instance, namer, registry);
  if ('missing' in to) return to;
  return { asked: `${view.fn.name}(${words.join(',')})`, to: to.entry, data: `0x${bytesToHex(encodeCall({ fn: view.fn, args, trailer: undefined }))}` as Hex };
}

/**
 * The answers that admit `name`, as `proveInstance` prints them, worked out from the registry alone: each asker's name,
 * the call and the answer expected. Undefined when there is nothing to ask, or a view cannot be asked.
 */
export function expectedAnswers(registry: Registry, name: string): { readonly asker: string; readonly asked: string; readonly answered: string }[] | undefined {
  const entry = registry.entries.get(name);
  const factory = registry.entries.get(entry?.attributes.factory ?? '');
  if (entry === undefined || factory?.instanceCheck === undefined) return undefined;
  const expected = [];
  for (const view of factory.instanceCheck) {
    const attribute = namedByOf(view);
    const namers = attribute === undefined ? [undefined] : entriesNaming(registry, attribute, name);
    if (namers.length === 0) return undefined;
    for (const namer of namers) {
      const asking = question(view, entry, namer, registry);
      const answer = resolveExpected(view, entry, namer, registry);
      if ('missing' in asking || (view.answers.kind === 'party' && answer === undefined)) return undefined;
      expected.push({ asker: asking.to.name, asked: asking.asked, answered: answer === undefined ? 'true' : checksumAddress(answer.address) });
    }
  }
  return expected;
}

/** Asks every view of the instance's factory's `instanceCheck` through both providers at `block`; one call is read once however many namers share it. */
export async function proveInstance(reader: Reader, registry: Registry, name: string, block: BlockRef): Promise<InstanceAnswers | InstanceUnasked> {
  const entry = registry.entries.get(name);
  if (entry === undefined) return { kind: 'unasked', why: `${name} is not in the registry` };
  const factoryName = entry.attributes.factory;
  if (factoryName === undefined) return { kind: 'unasked', why: `${name} names no factory` };
  const factory = registry.entries.get(factoryName) as RegistryEntry;
  if (factory.instanceCheck === undefined) return { kind: 'unasked', why: `${factoryName} has no instanceCheck` };
  const reads = new Map<string, ReturnType<Reader['call']>>();
  const answers: ViewAnswer[] = [];
  for (const [index, view] of factory.instanceCheck.entries()) {
    const attribute = namedByOf(view);
    const namers = attribute === undefined ? [undefined] : entriesNaming(registry, attribute, name);
    if (namers.length === 0) {
      answers.push({ view, index, asker: undefined, namer: undefined, asked: view.fn.signature, kind: 'refused', cause: 'unaskable', why: `no registry entry names ${name} as its ${attribute}` });
      continue;
    }
    for (const namer of namers) {
      const asking = question(view, entry, namer, registry);
      if ('missing' in asking) {
        answers.push({ view, index, asker: undefined, namer, asked: view.fn.signature, kind: 'refused', cause: 'unaskable', why: `${name} has no ${asking.missing} attribute, which ${factoryName}'s instanceCheck ${view.fn.signature} binds` });
        continue;
      }
      const key = `${asking.to.address}${asking.data}`;
      if (!reads.has(key)) reads.set(key, reader.call({ to: asking.to.address, data: asking.data }, block));
      const read = await (reads.get(key) as ReturnType<Reader['call']>);
      const base = { view, index, asker: asking.to, namer, asked: asking.asked };
      if (read.kind === 'unverifiable') {
        answers.push({ ...base, kind: 'refused', cause: 'no-answer', why: read.reason });
        continue;
      }
      const verdict = judged(view, read.value.kind === 'returned' ? read.value.data.toLowerCase() : undefined, entry, factory, asking, resolveExpected(view, entry, namer, registry));
      answers.push(verdict.kind === 'vouched' ? { ...base, ...verdict, providers: read.providers } : { ...base, ...verdict });
    }
  }
  return { kind: 'asked', entry, factory, block, answers };
}

const resolveExpected = (view: InstanceView, instance: RegistryEntry, namer: RegistryEntry | undefined, registry: Registry): RegistryEntry | undefined => {
  if (view.answers.kind === 'true') return undefined;
  const expected = resolve(view.answers.party, instance, namer, registry);
  return 'entry' in expected ? expected.entry : undefined;
};

/** The view's verdict on one answer: the messages for a factory asked about its instance are the ones `pnpm vault-evidence` has always stored. */
function judged(
  view: InstanceView,
  data: string | undefined,
  instance: RegistryEntry,
  factory: RegistryEntry,
  asking: { readonly asked: string; readonly to: RegistryEntry },
  expected: RegistryEntry | undefined,
): { readonly kind: 'vouched'; readonly answered: string } | { readonly kind: 'refused'; readonly cause: RefusalCause; readonly why: string } {
  const { asked, to } = asking;
  const byFactory = to.name === factory.name;
  const refuse = (cause: RefusalCause, why: string) => ({ kind: 'refused', cause, why }) as const;
  if (view.word !== undefined && data !== undefined && data.length < 2 + 64 * (view.word + 1)) return refuse('other-answer', `${to.name} answered ${asked} with ${data}, which has no word ${view.word}`);
  if (view.answers.kind === 'party' && expected === undefined) return refuse('unaskable', `${instance.name} names no entry for ${asked} to answer, as ${factory.name}'s instanceCheck expects`);
  const answer = data === undefined ? 'a revert' : view.word === undefined ? data : `0x${data.slice(2 + 64 * view.word, 2 + 64 * (view.word + 1))}`;
  if (view.answers.kind === 'true') {
    if (answer === FALSE) return refuse('denied', `${to.name} answered ${asked} false for ${instance.name}: ${byFactory ? 'it did not create it' : 'it does not vouch for it'}`);
    if (answer !== TRUE) return refuse('other-answer', `${to.name} answered ${asked} with ${answer}, not true or false`);
    return { kind: 'vouched', answered: 'true' };
  }
  const address = ADDRESS_WORD.exec(answer)?.[1];
  if (address === undefined || expected === undefined) return refuse('other-answer', `${to.name} answered ${asked} with ${answer}, not an address`);
  if (`0x${address}` !== expected.address) {
    const other = checksumAddress(`0x${address}` as Address);
    return refuse('denied', byFactory && expected === instance ? `${to.name} answered ${asked} = ${other}, not ${instance.name}: its official contract is another` : `${to.name} answered ${asked} = ${other}, not ${expected.name}`);
  }
  return { kind: 'vouched', answered: checksumAddress(expected.address) };
}

/**
 * Whether a view asks or expects another entry than the factory and the instance, such as a vault asked about its
 * adapter: such answers rest on that entry's word, so they never make the instance confirmed elsewhere for a shared deployer.
 */
export const restsOnOthers = (factory: RegistryEntry | undefined): boolean =>
  (factory?.instanceCheck ?? []).some((view) => [view.ask, ...(view.answers.kind === 'party' ? [view.answers.party] : [])].some((party) => party.kind === 'attribute' || party.kind === 'named-by'));
