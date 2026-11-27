import { KeyError } from '../keys.ts';
import type { KeySpec } from '../keys.ts';

/** The Ethereum endpoint each provider's dashboard shows, the key at its end; it matches the URL `src/chain/providers.ts` builds. */
const ENDPOINTS: Readonly<Partial<Record<KeySpec['name'], string>>> = {
  alchemy: 'https://eth-mainnet.g.alchemy.com/v2/',
  drpc: 'https://lb.drpc.live/ethereum/',
};

export class PastedKeyError extends KeyError {
  override name = 'PastedKeyError';
}

/** What `key add` asks for: a provider's Ethereum endpoint URL, as its dashboard shows it, or the key alone. */
export function keyPrompt(spec: KeySpec): string {
  const endpoint = ENDPOINTS[spec.name];
  if (endpoint === undefined) return `${spec.label} API key (typing is hidden): `;
  return `Paste the whole ${spec.label} Ethereum URL from your dashboard, such as ${endpoint}AbC123, or the key alone (typing is hidden): `;
}

/** The key in what the signer pasted. Throws, without the value, for a URL that is not the provider's Ethereum endpoint. */
export function keyFromPasted(spec: KeySpec, pasted: string): string {
  const text = pasted.trim();
  const endpoint = ENDPOINTS[spec.name];
  if (endpoint !== undefined && text.startsWith(endpoint)) return text.slice(endpoint.length);
  if (text.includes('://')) {
    const want = endpoint === undefined ? `the ${spec.label} key alone` : `the whole ${endpoint}<key> URL, or the key alone`;
    throw new PastedKeyError(`What you pasted is a URL, but not one kiss-sign takes for ${spec.label}. Paste ${want}. No key saved.`);
  }
  return text;
}
