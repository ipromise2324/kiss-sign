import { MARKET_ENTRY_PARTS } from '../registry.ts';
import type { MarketEntryPart, Registry, RegistryEntry, RegistryView, StandingAllowance, StudyEntry, StudyMarket } from '../registry.ts';
import type { Address } from '../safe/types.ts';

export class StudyFieldError extends Error {
  override name = 'StudyFieldError';
}

/** Getters that throw, one per field of `T` a study does not read, as a projected object's prototype. */
function unread<T>(fields: Readonly<Record<string & keyof T, true>>, what: string): object {
  const proto = {};
  for (const field of Object.keys(fields)) {
    Object.defineProperty(proto, field, {
      get() {
        throw new StudyFieldError(`a study reads no ${what} ${field}: add it to StudyEntry in src/registry.ts, so each summary's registry hash covers it`);
      },
    });
  }
  return Object.freeze(proto);
}

const UNREAD_ENTRY = unread<Omit<RegistryEntry, keyof StudyEntry>>(
  {
    source: true,
    apiSource: true,
    sourceLabel: true,
    sourceHeading: true,
    moreSources: true,
    instanceCheck: true,
    size: true,
    coingecko: true,
    immunefi: true,
    sdk: true,
    routes: true,
    implementationRead: true,
    dependsOn: true,
    code: true,
    feed: true,
    price: true,
    numbers: true,
    twap: true,
  },
  'entry field',
);
const UNREAD_ALLOWANCE = unread<Omit<StandingAllowance, 'via'>>({ why: true }, 'standingAllowance field');

const onto = <T extends object>(prototype: object, own: T): T => Object.freeze(Object.assign(Object.create(prototype) as object, own));

/** The entry as a study reads it: its own keys are what a summary's hash covers, and any other field of it throws. */
function studyEntry(entry: RegistryEntry): StudyEntry {
  const { name, address, kind, attributes, defillama, standingAllowance, ignoresTrailer } = entry;
  return onto(UNREAD_ENTRY, {
    name,
    address,
    kind,
    attributes,
    ...(defillama === undefined ? {} : { defillama }),
    ...(standingAllowance === undefined ? {} : { standingAllowance: onto(UNREAD_ALLOWANCE, { via: standingAllowance.via }) }),
    ...(ignoresTrailer === undefined ? {} : { ignoresTrailer: true as const }),
  });
}

declare const projected: unique symbol;
/** A registry of projected entries, which only `studyRegistry` makes. */
export type StudyRegistry = RegistryView & { readonly [projected]: true };

export function studyRegistry(registry: Registry): StudyRegistry {
  const entries = new Map([...registry.entries].map(([name, entry]) => [name, studyEntry(entry)]));
  const byAddress = new Map<Address, StudyEntry>([...entries.values()].map((entry) => [entry.address, entry]));
  const markets = new Map(
    [...registry.markets].map(([name, market]): [string, StudyMarket] => {
      const parts = Object.fromEntries(MARKET_ENTRY_PARTS.map((part) => [part, entries.get(market[part].name)])) as { readonly [P in MarketEntryPart]: StudyEntry };
      return [name, { name, id: market.id, lltv: market.lltv, ...parts }];
    }),
  );
  return { attributes: registry.attributes, entries, byAddress, markets } as RegistryView as StudyRegistry;
}
