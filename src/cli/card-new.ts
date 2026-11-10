import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAddressBook } from '../address-book.ts';
import type { AddressBook } from '../address-book.ts';
import { CardError, parseUint256 } from '../card.ts';
import type { CardOperation } from '../card.ts';
import { kissSignHome } from '../keys.ts';
import { loadRegistry } from '../registry.ts';
import type { ContractKind, Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import { TEMPLATES_DIR, loadTemplate } from '../template/template.ts';
import type { CardField, TokenRef } from '../template/template.ts';
import { UsageError, terminal } from './io.ts';
import type { Io, Terminal } from './io.ts';
import { requireConfig, seal } from './setup.ts';

type Choice = { readonly name: string; readonly address: Address; readonly from: 'registry' | 'address-book' | 'safe' };

type Sources = { readonly registry: Registry; readonly book: AddressBook; readonly safe: Address };

/** The names a field may hold, as resolveCard accepts them; undefined for a typed number. */
function choicesFor(field: CardField, { registry, book, safe }: Sources): readonly Choice[] | undefined {
  const contracts = (kind?: ContractKind): Choice[] =>
    [...registry.entries.values()].filter((e) => kind === undefined || e.kind === kind).map((e) => ({ name: e.name, address: e.address, from: 'registry' }));
  const self: Choice = { name: 'safe', address: safe, from: 'safe' };
  const booked = [...book].map(([name, address]): Choice => ({ name, address, from: 'address-book' }));
  switch (field.kind) {
    case 'contract':
      return contracts(field.registryKind);
    case 'address':
      return [self, ...contracts(), ...booked];
    case 'recipient':
      return [self, ...booked];
    case 'amount':
    case 'nonce':
      return undefined;
  }
}

/** The token an amount counts, named with its full address once the field it refers to is chosen. */
function unitOf(of: TokenRef, values: Readonly<Record<string, string>>, registry: Registry): string {
  if (of === 'eth') return 'wei of eth';
  const chosen = values[of.field];
  const name = chosen === undefined || of.attribute === undefined ? chosen : registry.entries.get(chosen)?.attributes[of.attribute];
  const entry = name === undefined ? undefined : registry.entries.get(name);
  if (entry === undefined) return `base units of card.${of.field}${of.attribute === undefined ? '' : `.${of.attribute}`}`;
  return `base units of ${entry.name} ${checksumAddress(entry.address)}`;
}

async function answer(ask: Terminal['ask'], question: string): Promise<string> {
  return (await ask(question))?.trim() ?? '';
}

async function fill(id: string, sources: Sources, io: Io, ask: Terminal['ask']): Promise<CardOperation> {
  if (!existsSync(join(io.repoRoot, TEMPLATES_DIR, id, 'template.json'))) throw new CardError(`no template ${id} in ${TEMPLATES_DIR}/`);
  const template = loadTemplate(io.repoRoot, id, sources.registry);
  const values: Record<string, string> = {};
  for (const [name, field] of template.card) {
    const choices = choicesFor(field, sources);
    if (choices === undefined) {
      const unit = field.kind === 'amount' ? unitOf(field.of, values, sources.registry) : 'a Safe nonce';
      const typed = await answer(ask, `${name} (${unit}): `);
      if (parseUint256(typed) === undefined) throw new CardError(`${name}: ${JSON.stringify(typed.slice(0, 80))} is not a whole number in plain digits`);
      values[name] = typed;
      continue;
    }
    if (choices.length === 0) throw new CardError(`${name}: the registry and address book hold nothing ${id} accepts here`);
    io.stdout(`${name}:\n`);
    for (const [i, c] of choices.entries()) io.stdout(`  ${i + 1}. ${c.name} ${checksumAddress(c.address)} (${c.from})\n`);
    const typed = await answer(ask, `${name} [1-${choices.length}]: `);
    const choice = /^[1-9][0-9]{0,5}$/.test(typed) ? choices[Number(typed) - 1] : undefined;
    if (choice === undefined) throw new CardError(`${name}: ${JSON.stringify(typed.slice(0, 80))} is not a number from 1 to ${choices.length}`);
    values[name] = choice.name;
  }
  return { template: id, values };
}

export async function cardNew(args: readonly string[], io: Io): Promise<number> {
  if (args.length === 0) throw new UsageError('card new takes one or more template ids, such as morpho/vault-deposit.');
  const { ask, confirm } = terminal(io, 'card new');
  const home = kissSignHome(io.env);
  const sources: Sources = { registry: loadRegistry(io.repoRoot), book: loadAddressBook(home), safe: requireConfig(home).safe };
  const operations: CardOperation[] = [];
  for (const [i, id] of args.entries()) {
    io.stdout(`operation ${i + 1}: ${id}\n`);
    operations.push(await fill(id, sources, io, ask));
  }
  io.stdout('\n');
  return seal({ operations }, io, confirm);
}
