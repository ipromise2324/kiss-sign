import { lltvText, percentText } from '../card.ts';
import type { ResolvedCard, ResolvedValue } from '../card.ts';
import { groupedTokens } from '../chain/decimals.ts';
import { MARKET_ENTRY_PARTS, isMarketEntryPart } from '../registry.ts';
import type { Market, Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import type { Values } from '../template/check.ts';
import type { Template, TokenRef } from '../template/template.ts';
import { amountToken } from '../verify/expected.ts';
import type { AmountToken } from '../verify/expected.ts';
import { BOX_WIDTH, box, rows, table } from './format.ts';
import type { Paint } from './format.ts';
import { LABELS } from './labels.ts';

const L = LABELS.card;

export const marketHead = (market: Market): string => `${market.name}  ${L.lltv(lltvText(market), `${market.lltv}`)}`;

/** A market's id and each part's registry name and full address, aligned. */
export function marketTable(market: Market, indent: number, width?: number): string[] {
  return table([[L.id, market.id], ...MARKET_ENTRY_PARTS.map((part) => [part, market[part].name, checksumAddress(market[part].address)])], indent, width);
}

/** What `card new` read, so the summary can give whole tokens; absent for a card sealed from a file. */
export type CardReads = {
  readonly decimals: ReadonlyMap<Address, number>;
  readonly provenance: string | undefined;
  /** The fields `card new` computed, as `<operation index>:<field>`; every other value the signer picked or typed. */
  readonly computed: ReadonlySet<string>;
};

/** The token an amount counts, a market's part included, which the verify page does not name. */
function tokenOf(of: TokenRef, values: Values, registry: Registry): AmountToken | undefined {
  const token = amountToken(of, values, registry);
  if (token !== undefined || of === 'eth' || of.attribute === undefined || !isMarketEntryPart(of.attribute)) return token;
  const chosen = values.get(of.field);
  return chosen?.kind === 'market' ? { address: chosen.market[of.attribute].address, name: chosen.market[of.attribute].name } : undefined;
}

function amountLines(value: bigint, token: AmountToken | undefined, reads: CardReads | undefined): string[] {
  const base = `${value}`;
  if (token === undefined) return [L.baseUnits(base)];
  const decimals = token.address === 'eth' ? 18 : reads?.decimals.get(token.address);
  if (decimals === undefined) return [L.baseUnitsOf(base, token.name)];
  return [`${groupedTokens(value, decimals)} ${token.name}`, L.baseUnits(base)];
}

function valueLines(value: ResolvedValue, token: AmountToken | undefined, reads: CardReads | undefined): string[] {
  switch (value.kind) {
    case 'contract':
      return [`${value.name}  ${checksumAddress(value.entry.address)}`];
    case 'address':
      return [`${value.name}${value.from === 'registry' ? '' : ` (${L.from[value.from]})`}  ${checksumAddress(value.address)}`];
    case 'amount':
      return amountLines(value.value, token, reads);
    case 'nonce':
    case 'threshold':
      return [`${value.value}`];
    case 'percent':
      return [percentText(value.value), L.percentBase(`${value.value}`)];
    case 'market':
      return [marketHead(value.market)];
  }
}

/** The card the signer confirms, in one box: every full address, each amount in whole tokens and base units. */
export function cardSummary(card: ResolvedCard, templates: ReadonlyMap<string, Template>, registry: Registry, reads: CardReads | undefined, p: Paint): string[] {
  const body = rows([[L.safe, checksumAddress(card.safe)]], 0, BOX_WIDTH);
  const several = card.operations.length > 1;
  let amounts = false;
  for (const [i, op] of card.operations.entries()) {
    body.push('', p.heading(several ? `${i + 1}. ${op.template}` : op.template));
    const keyWidth = Math.max(...[...op.values.keys()].map((name) => name.length));
    for (const [name, value] of op.values) {
      const field = templates.get(op.template)?.card.get(name);
      const token = field?.kind === 'amount' ? tokenOf(field.of, op.values, registry) : undefined;
      if (value.kind === 'amount') amounts = true;
      const style = reads === undefined ? undefined : reads.computed.has(`${i}:${name}`) ? p.computed : p.picked;
      body.push(...rows([[name.padEnd(keyWidth), valueLines(value, token, reads), style]], 2, BOX_WIDTH));
      if (value.kind === 'market') body.push(...marketTable(value.market, 4, BOX_WIDTH));
    }
  }
  const footer = reads?.provenance ?? (reads === undefined && amounts ? L.noDecimals : undefined);
  if (footer !== undefined) body.push('', p.dim(footer));
  return box(p.heading(L.summary), body);
}
