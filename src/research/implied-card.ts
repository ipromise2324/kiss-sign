import { resolveValue } from '../card.ts';
import type { Card } from '../card.ts';
import { isMarketEntryPart } from '../registry.ts';
import type { Market, Registry } from '../registry.ts';
import type { Address } from '../safe/types.ts';
import type { CardField, CardRef, LeafRule, Quantity, Template } from '../template/template.ts';

const MAX_UINT = (1n << 256n) - 1n;

/** One end of the values a card amount can hold and still match: `least`, it must be at least `value`; `most`, at most. */
export type Boundary = { readonly field: string; readonly side: 'least' | 'most'; readonly value: bigint };

/**
 * The card a transaction was made for, as its values show it: `card` holds each field a value shows, `book` the
 * address-book name given to each address a book field needs, `boundaries` each end a bound rather than a stated value
 * puts on an amount, which the card holds at the `most` end when it has one, and `missing` each field none shows, with why.
 */
export type ImpliedCard = {
  readonly card: Card;
  readonly book: ReadonlyMap<string, Address>;
  readonly boundaries: readonly Boundary[];
  readonly missing: readonly { readonly field: string; readonly why: string }[];
};

type SharePrice = Extract<LeafRule, { kind: 'share-price' }>;

/** What the transaction requires of one card amount: values it states, and ends its bounds put. */
type Limits = { readonly exact: bigint[]; readonly least: bigint[]; readonly most: bigint[] };

const floorDiv = (a: bigint, b: bigint): bigint => a / b;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/**
 * The end one share price bound puts on the card amount on its `side` (`assets` or `shares`) when the other side is
 * `other`: `max` requires price × shares ≤ assets × 10^scale, `min` the reverse. Undefined when it bounds nothing, as a
 * price of 0 under `max`; a reason when no value can meet it.
 */
function priceLimit(rule: SharePrice, price: bigint, side: 'assets' | 'shares', other: bigint): Partial<Pick<Limits, 'least' | 'most'>> | { readonly impossible: string } | undefined {
  const scale = 10n ** BigInt(rule.scale);
  if (side === 'assets') {
    if (rule.shares.kind === 'path' && other === MAX_UINT) return { impossible: 'its share price bound is given the whole balance (2^256-1) as shares, which never matches' };
    return rule.bound === 'max' ? { least: [ceilDiv(price * other, scale)] } : { most: [floorDiv(price * other, scale)] };
  }
  if (price === 0n) {
    if (rule.bound === 'max' || other === 0n) return undefined;
    return { impossible: `its share price bound is a least price of 0 for ${other} assets, which no share count meets` };
  }
  return rule.bound === 'max' ? { most: [floorDiv(other * scale, price)] } : { least: [ceilDiv(other * scale, price)] };
}

/**
 * The value of a card amount the transaction requires, intersecting every value it states and every end its bounds put
 * in the uint256 range: a stated value when there is one, else the `most` end, else the `least`; or why there is none.
 */
function settle(field: string, limits: Limits): { readonly value: bigint; readonly boundaries: Boundary[] } | { readonly why: string } {
  const exact = [...new Set(limits.exact)];
  const least = limits.least.reduce((a, b) => (a > b ? a : b), 0n);
  const most = limits.most.reduce((a, b) => (a < b ? a : b), MAX_UINT);
  if (exact.length > 1) return { why: `the transaction states it as ${exact.join(' and as ')}` };
  if (least > most) return { why: `the transaction needs it at least ${least} and at most ${most}` };
  const [stated] = exact;
  if (stated !== undefined) return stated < least || stated > most ? { why: `the transaction states it as ${stated}, outside ${least} to ${most}` } : { value: stated, boundaries: [] };
  const boundaries: Boundary[] = [...(most < MAX_UINT ? [{ field, side: 'most' as const, value: most }] : []), ...(least > 0n ? [{ field, side: 'least' as const, value: least }] : [])];
  const [first] = boundaries;
  if (first === undefined) return { why: limits.least.length + limits.most.length === 0 ? 'no value of the transaction is bound to it, at a bound or a share price' : 'its bounds allow every uint256' };
  return { value: first.value, boundaries };
}

/**
 * What one transaction's leaves imply of each card field. `rules` and `values` pair by position, as a loosened check
 * visits them and as a past-transactions study keeps them; `sender` is the Safe, or the EOA that made the call; `nonce`
 * the Safe transaction's, when known. A field bound directly takes that value. An amount the transaction bounds takes an
 * end of what still matches, every bound on it intersected: `atLeast` matches a card at most the transaction's value and
 * `atMost` one at least it; a `max` share price bound allows at most so many shares and at least so many assets, a `min`
 * the reverse. A contract or market seen only through attributes takes the entry or market whose attributes are the
 * values it shows.
 */
export function impliedCard(template: Template, rules: readonly LeafRule[], values: readonly string[], sender: Address, registry: Registry, nonce?: bigint): ImpliedCard {
  const direct = new Map<string, string>();
  const attributes = new Map<string, Map<string, string>>();
  const limits = new Map<string, Limits>();
  const limitsOf = (field: string): Limits => {
    const had = limits.get(field) ?? { exact: [], least: [], most: [] };
    limits.set(field, had);
    return had;
  };
  const prices: { readonly rule: SharePrice; readonly price: bigint }[] = [];
  const uint = (value: string | undefined): bigint | undefined => (value !== undefined && /^[0-9]+$/.test(value) ? BigInt(value) : undefined);
  const bind = (ref: CardRef, value: string): void => {
    if (ref.attribute === undefined) {
      if (!direct.has(ref.field)) direct.set(ref.field, value);
      const n = uint(value);
      if (n !== undefined) limitsOf(ref.field).exact.push(n);
      return;
    }
    const known = attributes.get(ref.field) ?? new Map<string, string>();
    known.set(ref.attribute, value.toLowerCase());
    attributes.set(ref.field, known);
  };
  rules.forEach((rule, i) => {
    const value = values[i];
    if (value === undefined) return;
    if (rule.kind === 'card') bind(rule.ref, value);
    else if (rule.kind === 'address-word' && rule.rule.kind === 'card') bind(rule.rule.ref, value);
    else if (rule.kind === 'at-least' || rule.kind === 'at-most') {
      const n = uint(value);
      if (n !== undefined) limitsOf(rule.field)[rule.kind === 'at-least' ? 'most' : 'least'].push(n);
    } else if (rule.kind === 'share-price') {
      const price = uint(value);
      if (price !== undefined) prices.push({ rule, price });
    }
  });
  if (template.nonce?.kind === 'card' && nonce !== undefined) bind(template.nonce.ref, String(nonce));

  const amounts = new Map<string, bigint>();
  const boundaries: Boundary[] = [];
  const unsettled = new Map<string, string>();
  const pathValue = (q: Extract<Quantity, { kind: 'path' }>): bigint | undefined => uint(values[rules.indexOf(q.rule)]);
  for (const { rule } of prices) for (const q of [rule.assets, rule.shares]) if (q.kind === 'card') limitsOf(q.field);
  const waiting = new Set(limits.keys());
  const hasOwn = (field: string): boolean => {
    const own = limitsOf(field);
    return own.exact.length + own.least.length + own.most.length > 0;
  };
  const settleReady = (force: boolean): boolean => {
    let progressed = false;
    const stated = (field: string): number => (limitsOf(field).exact.length > 0 ? 0 : 1);
    for (const field of force ? [...waiting].sort((a, b) => stated(a) - stated(b)) : [...waiting]) {
      if (force && progressed) break;
      const own = limitsOf(field);
      const added: Limits = { exact: [...own.exact], least: [...own.least], most: [...own.most] };
      let blocked: string | undefined;
      for (const { rule, price } of prices) {
        for (const side of ['assets', 'shares'] as const) {
          const [mine, theirs] = side === 'assets' ? [rule.assets, rule.shares] : [rule.shares, rule.assets];
          if (mine.kind !== 'card' || mine.field !== field) continue;
          const other = theirs.kind === 'path' ? pathValue(theirs) : theirs.field === field ? undefined : amounts.get(theirs.field);
          if (other === undefined) {
            if (theirs.kind === 'path') unsettled.set(field, `its share price bound has no number at ${theirs.path}`);
            else if (!unsettled.has(theirs.field)) blocked = theirs.field;
            continue;
          }
          const limit = priceLimit(rule, price, side, other);
          if (limit === undefined) continue;
          if ('impossible' in limit) unsettled.set(field, limit.impossible);
          else {
            added.least.push(...(limit.least ?? []));
            added.most.push(...(limit.most ?? []));
          }
        }
      }
      if (blocked !== undefined && !unsettled.has(field) && !(force && hasOwn(field))) continue;
      waiting.delete(field);
      progressed = true;
      if (unsettled.has(field)) continue;
      const settled = settle(field, added);
      if ('why' in settled) unsettled.set(field, settled.why);
      else {
        amounts.set(field, settled.value);
        boundaries.push(...settled.boundaries);
      }
    }
    return progressed;
  };
  while (settleReady(false) || settleReady(true));
  for (const field of waiting) {
    const needs = prices.flatMap(({ rule }) => [rule.assets, rule.shares].filter((q) => q.kind === 'card' && q.field !== field && [rule.assets, rule.shares].some((p) => p.kind === 'card' && p.field === field)));
    unsettled.set(field, `its share price bound needs ${needs.map((q) => (q.kind === 'card' ? q.field : q.path)).join(' and ') || 'itself'}, which no value of the transaction fixes`);
  }

  const book = new Map<string, Address>();
  const missing: { field: string; why: string }[] = [];
  const card: Record<string, string> = {};
  const context = { registry, addressBook: new Map<string, Address>(), safe: sender };
  const refusal = (field: CardField, name: string): string | undefined => {
    const resolved = resolveValue(field, name, context);
    return 'reason' in resolved ? resolved.detail : undefined;
  };
  const addressName = (field: string, kind: CardField['kind'], address: Address): string => {
    if (address === sender && kind !== 'owner') return 'safe';
    const entry = kind === 'address' ? registry.byAddress.get(address) : undefined;
    if (entry !== undefined) return entry.name;
    book.set(field, address);
    return field;
  };
  const marketMatches = (market: Market, known: ReadonlyMap<string, string>, id: string | undefined): boolean =>
    (id === undefined || market.id === id.toLowerCase()) &&
    [...known].every(([attribute, value]) =>
      attribute === 'id' ? market.id === value : attribute === 'lltv' ? String(market.lltv) === value : isMarketEntryPart(attribute) && market[attribute].address === value,
    );
  for (const [name, field] of template.card) {
    const value = direct.get(name);
    const known = attributes.get(name) ?? new Map<string, string>();
    const set = (text: string | undefined, why: string): void => {
      if (text === undefined) missing.push({ field: name, why });
      else card[name] = text;
    };
    switch (field.kind) {
      case 'amount':
      case 'nonce':
      case 'percent':
      case 'threshold':
        set(amounts.get(name)?.toString(), unsettled.get(name) ?? 'no value of the transaction is bound to it, at a bound or a share price');
        break;
      case 'contract': {
        if (value !== undefined) {
          const entry = registry.byAddress.get(value.toLowerCase() as Address);
          const refused = entry === undefined ? `${value} is no registry entry` : refusal(field, entry.name);
          set(refused === undefined ? entry?.name : undefined, refused === undefined ? '' : refused);
          break;
        }
        const fits = [...registry.entries.values()].filter(
          (entry) => refusal(field, entry.name) === undefined && known.size > 0 && [...known].every(([attribute, held]) => registry.entries.get(entry.attributes[attribute] ?? '')?.address === held),
        );
        set(fits.length === 1 ? fits[0]?.name : undefined, known.size === 0 ? 'no value of the transaction is bound to it' : `${fits.length} registry entries it may name have ${[...known].map(([a, v]) => `${a} ${v}`).join(' and ')}`);
        break;
      }
      case 'market': {
        const fits = [...registry.markets.values()].filter((market) => marketMatches(market, known, value));
        set(fits.length === 1 ? fits[0]?.name : undefined, value === undefined && known.size === 0 ? 'no value of the transaction is bound to it' : `${fits.length} markets of registry/markets.json have the values it shows`);
        break;
      }
      case 'address':
      case 'recipient':
      case 'owner':
        set(value === undefined ? undefined : addressName(name, field.kind, value.toLowerCase() as Address), 'no value of the transaction is bound to it');
        break;
    }
  }
  return { card: { operations: [{ template: template.id, values: card }] }, book, boundaries: boundaries.filter((b) => card[b.field] !== undefined), missing };
}
