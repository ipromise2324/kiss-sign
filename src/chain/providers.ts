import { findKey, keySpec } from '../keys.ts';
import type { Env, KeyName, KeySpec } from '../keys.ts';

type ProviderEntry = {
  readonly name: string;
  readonly company: string;
  readonly key: KeyName | undefined;
  readonly url: (key: string) => string;
};

export const PROVIDERS = [
  { name: 'alchemy', company: 'Alchemy', key: 'alchemy', url: (key: string) => `https://eth-mainnet.g.alchemy.com/v2/${key}` },
  { name: 'drpc', company: 'drpc', key: undefined, url: () => 'https://eth.drpc.org' },
] as const satisfies readonly ProviderEntry[];

export type ProviderName = (typeof PROVIDERS)[number]['name'];

/** A provider with its URL filled in. The URL may hold a key, so nothing user-facing ever prints it. */
export type Endpoint = { readonly provider: ProviderName; readonly company: string; readonly url: string };

export class MissingKeyError extends Error {
  override name = 'MissingKeyError';

  constructor(spec: KeySpec) {
    super(
      `${spec.label} needs an API key in ${spec.env}, and none is set. Get a free key at ${spec.signup}, ` +
        `then run \`kiss-sign key add ${spec.name}\` in your own terminal, not in a chat.`,
    );
  }
}

function endpointOf(entry: (typeof PROVIDERS)[number], env: Env): Endpoint {
  const spec = entry.key === undefined ? undefined : keySpec(entry.key);
  const key = spec === undefined ? '' : findKey(spec, env)?.value;
  if (spec !== undefined && key === undefined) throw new MissingKeyError(spec);
  return { provider: entry.name, company: entry.company, url: entry.url(key ?? '') };
}

export function mainnetEndpoints(env: Env): readonly [Endpoint, Endpoint] {
  const [alchemy, drpc] = PROVIDERS;
  return [endpointOf(alchemy, env), endpointOf(drpc, env)];
}
