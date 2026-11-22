import { type Registry, attributesText, parseRegistry } from '../src/registry.ts';

/**
 * `contracts`, such as an edited copy of `registry/contracts.json`, parsed with `markets` and the attribute table of the
 * repository at `root`, as `loadRegistry(root)` reads it, so an attribute that table declares parses.
 */
export function parseRegistryAt(root: string, contracts: unknown, markets: unknown = {}): Registry {
  const attributes = attributesText(root);
  return parseRegistry(contracts, markets, attributes === undefined ? undefined : JSON.parse(attributes));
}
