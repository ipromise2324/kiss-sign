import type { Registry } from './registry.ts';
import { SafeTxParseError, parseAddress } from './safe/types.ts';
import type { Address } from './safe/types.ts';

/** The address a command-line word names, as a registry name or as an address; undefined when it is neither. */
export function addressOfWord(registry: Pick<Registry, 'entries'>, word: string): Address | undefined {
  try {
    return registry.entries.get(word)?.address ?? parseAddress('address', word);
  } catch (error) {
    if (error instanceof SafeTxParseError) return undefined;
    throw error;
  }
}
