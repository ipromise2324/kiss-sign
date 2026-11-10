import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEntryName } from './registry.ts';
import { SafeTxParseError, checksumAddress, parseAddress } from './safe/types.ts';
import type { Address } from './safe/types.ts';

/** Addresses the signer confirmed by hand, by name. Local only: it lives in `$KISS_SIGN_HOME`, never in the repository. */
export type AddressBook = ReadonlyMap<string, Address>;

export class AddressBookError extends Error {
  override name = 'AddressBookError';
}

export function addressBookPath(home: string): string {
  return join(home, 'address-book.json');
}

export function parseAddressBook(raw: unknown): AddressBook {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new AddressBookError('address book: not a JSON object');
  const book = new Map<string, Address>();
  for (const [name, value] of Object.entries(raw)) {
    if (!isEntryName(name)) throw new AddressBookError(`${JSON.stringify(name.slice(0, 64))}: not an address-book name`);
    try {
      book.set(name, parseAddress(name, value));
    } catch (error) {
      if (error instanceof SafeTxParseError) throw new AddressBookError(error.message);
      throw error;
    }
  }
  return book;
}

export function loadAddressBook(home: string): AddressBook {
  let text: string;
  try {
    text = readFileSync(addressBookPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  return parseAddressBook(JSON.parse(text));
}

export function saveAddressBook(home: string, book: AddressBook): void {
  const sorted = Object.fromEntries([...book].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, address]) => [name, checksumAddress(address)]));
  parseAddressBook(sorted);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = addressBookPath(home);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
