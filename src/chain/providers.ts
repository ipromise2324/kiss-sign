import { findKey, keySpec } from '../keys.ts';
import type { Env, KeyName, KeySpec } from '../keys.ts';

/** The requests a reader may have open at a provider at once: `start` at first, up to `max` while none is refused. */
export type Load = { readonly start: number; readonly max: number };

type ProviderEntry = {
  readonly name: string;
  readonly company: string;
  readonly key: KeyName;
  readonly url: (key: string) => string;
  readonly load: Load;
};

export const PROVIDERS = [
  { name: 'alchemy', company: 'Alchemy', key: 'alchemy', url: (key: string) => `https://eth-mainnet.g.alchemy.com/v2/${key}`, load: { start: 8, max: 32 } },
  { name: 'drpc', company: 'drpc', key: 'drpc', url: (key: string) => `https://lb.drpc.live/ethereum/${key}`, load: { start: 16, max: 64 } },
] as const satisfies readonly ProviderEntry[];

export type ProviderName = (typeof PROVIDERS)[number]['name'];

/** A provider with its URL filled in. The URL holds its key, when it has one, so nothing user-facing ever prints it. */
export type Endpoint = { readonly provider: ProviderName; readonly company: string; readonly url: string; readonly key?: string; readonly load?: Load };

export class MissingKeyError extends Error {
  override name = 'MissingKeyError';
  readonly env: string;

  constructor(spec: KeySpec) {
    super(
      `${spec.label} needs an API key in ${spec.env}, and none is set. Get a free key at ${spec.signup}, ` +
        `then run \`pnpm kiss-sign key add ${spec.name}\` in your own terminal, not in a chat.`,
    );
    this.env = spec.env;
  }
}

function endpointOf(entry: (typeof PROVIDERS)[number], env: Env): Endpoint {
  const spec = keySpec(entry.key) as KeySpec;
  const key = findKey(spec, env)?.value;
  if (key === undefined) throw new MissingKeyError(spec);
  return { provider: entry.name, company: entry.company, url: entry.url(key), key, load: entry.load };
}

export function mainnetEndpoints(env: Env): readonly [Endpoint, Endpoint] {
  const [alchemy, drpc] = PROVIDERS;
  return [endpointOf(alchemy, env), endpointOf(drpc, env)];
}
