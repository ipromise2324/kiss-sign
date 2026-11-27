import type { AbiType } from '../decode/abi.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { LeafRule, Quantity } from '../template/template.ts';
import { effectText, distributionOf, shown, toleranceFinding } from './amounts.ts';
import type { Difference, StatedEffect } from './amounts.ts';
import { WINDOWS, YEAR, foundBy, yearBefore } from './past-txs.ts';
import type { BlockRange, Coverage, Fit, Misfit, PastTxs, SafesFirst, Selection } from './past-txs.ts';
import { PAGE, SOURCES, searchedBy } from './sources.ts';
import { plain } from './shown.ts';
import { brokenRule, constText, functionNames, isOtherOperation, isTime, misfitText } from './study.ts';
import type { OutsideKind, Sender } from './study.ts';

const ZERO = `0x${'00'.repeat(20)}`;

const PERCENTILES = [50, 90, 99] as const;

export type Spread = { readonly count: number; readonly min: bigint; readonly percentiles: readonly bigint[]; readonly max: bigint };

export function spreadOf(values: readonly bigint[]): Spread | undefined {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = sorted.length;
  if (n === 0) return undefined;
  const nearestRank = (rank: number) => sorted[Math.max(rank, 1) - 1] as bigint;
  return { count: n, min: nearestRank(1), percentiles: PERCENTILES.map((p) => nearestRank(Math.ceil((p * n) / 100))), max: nearestRank(n) };
}

/**
 * One free or `withinSeconds` `uint` or `int` field over the fitting transactions of one sender type: its values, or
 * for a time, each less its block's time; `unrecorded` counts transactions whose block time was not read.
 */
type FreeNumber = { readonly path: string; readonly time: boolean; readonly spread: Spread | undefined; readonly unrecorded: number };

function freeNumbers(fits: readonly Fit[], rules: readonly LeafRule[]): FreeNumber[] {
  const first = fits[0];
  if (first === undefined) return [];
  return rules.flatMap((rule, i): FreeNumber[] => {
    const type = first.types[i];
    if ((rule.kind !== 'free' && rule.kind !== 'within-seconds') || (type?.kind !== 'uint' && type?.kind !== 'int')) return [];
    const time = isTime(rule);
    const values = fits.flatMap((fit) => {
      const value = BigInt(fit.values[i] as string);
      if (!time) return [value];
      return fit.time === undefined ? [] : [value - fit.time];
    });
    return [{ path: first.paths[i] as string, time, spread: spreadOf(values), unrecorded: fits.length - values.length }];
  });
}


const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function describeRule(rule: LeafRule, sender: string): string {
  switch (rule.kind) {
    case 'safe':
      return sender;
    case 'contract':
      return `contract ${rule.name}`;
    case 'address-word':
      return `${describeRule(rule.rule, sender)} as a 32-byte word`;
    case 'const':
      return `const ${constText(rule.value)}`;
    case 'card':
      return `card ${rule.ref.field}${rule.ref.attribute === undefined ? '' : `.${rule.ref.attribute}`}`;
    case 'free':
      return 'free';
    case 'within-seconds':
      return `at most ${rule.seconds} seconds after its block's time`;
    case 'equals':
      return `same as ${rule.path}`;
    case 'owner-before':
      return `the owner before card ${rule.ref.field}`;
    case 'at-least':
    case 'at-most':
      return `${rule.kind === 'at-least' ? 'at least' : 'at most'} card ${rule.field}`;
    case 'share-price': {
      const name = (q: Quantity): string => (q.kind === 'card' ? `card ${q.field}` : q.path);
      return `${rule.bound} share price, against ${name(rule.assets)} per ${name(rule.shares)}`;
    }
  }
}


function label(value: string, type: AbiType, fit: Fit, registry: Registry, anchorToken: Address | undefined, sender: string): string | undefined {
  if (type.kind !== 'address') return undefined;
  if (value === fit.sender.address) return sender;
  const named = registry.byAddress.get(value as Address)?.name;
  if (named !== undefined) return named;
  if (value === anchorToken) return 'the anchor token';
  if (value === ZERO) return 'the zero address';
  return 'another address';
}

const short = (value: string): string => (value.length > 24 ? `${value.slice(0, 18)}…(${(value.length - 2) / 2} bytes)` : value);

function distribution(run: PastTxs, fits: readonly Fit[], i: number, registry: Registry, sender: string): string {
  const type = fits[0]?.types[i] as AbiType;
  const counts = new Map<string, number>();
  const raw = new Set<string>();
  const labelOf = (value: string, fit: Fit) => label(value, type, fit, registry, run.query.anchor.token, sender);
  for (const fit of fits) {
    const value = fit.values[i] as string;
    raw.add(value);
    const name = labelOf(value, fit) ?? value;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (type.kind !== 'address' && counts.size > 3) return `${raw.size} distinct values`;
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${short(name)} in ${n}`);
  const others = type.kind === 'address' ? [...raw].filter((v) => labelOf(v, fits.find((f) => f.values[i] === v) as Fit) === 'another address').length : 0;
  return `${parts.join(', ')}${others > 1 ? ` (${others} distinct other addresses)` : ''}`;
}

const sendersOf = (studies: readonly { sender: Sender }[]): number => new Set(studies.map((s) => s.sender.address)).size;
const distinct = <T>(items: readonly T[]): number => new Set(items).size;

const examples = (hashes: readonly Hex[], n = 3): string => hashes.slice(0, n).join(', ');

const OUTSIDE: Readonly<Record<OutsideKind, string>> = { market: 'another market', token: 'a token outside the registry', vault: 'a vault outside the registry', address: 'an address outside the registry' };

type Group = { readonly fits: readonly Fit[]; readonly misfits: readonly Misfit[]; readonly rules: readonly LeafRule[]; readonly senderLabel: string; readonly senderNoun: string };

function renderGroup(lines: string[], group: Group, run: PastTxs, registry: Registry, mark: (hash: Hex) => string): void {
  const { fits, misfits, rules, senderLabel: sender, senderNoun: who } = group;
  const many = `${who}s`;
  lines.push(`fit the ${who === 'Safe' ? "template's" : "call's"} shape: ${plural(fits.length, 'transaction')} from ${plural(sendersOf(fits), who, many)}; misfits: ${misfits.length} from ${plural(sendersOf(misfits), who, many)}`);
  const outside = fits.filter((fit) => fit.outside.length > 0);
  if (outside.length > 0) {
    const exact = fits.filter((fit) => fit.outside.length === 0);
    const places = new Map<string, number>();
    for (const place of outside.flatMap((fit) => fit.outside.map((o) => `${OUTSIDE[o.kind]} at ${o.at}`))) places.set(place, (places.get(place) ?? 0) + 1);
    const where = [...places].sort((a, b) => b[1] - a[1]).map(([place, n]) => `${place} in ${n}`);
    lines.push(`  exactly the template: ${exact.length} from ${plural(sendersOf(exact), who, many)}; outside the registry: ${outside.length} from ${plural(sendersOf(outside), who, many)} (${where.join(', ')})`);
  }
  if (fits.length > 0) {
    lines.push(`fields, over the ${plural(fits.length, 'fitting transaction')}:`);
    const numbers = freeNumbers(fits, rules);
    const paths = fits[0]?.paths ?? [];
    rules.forEach((rule, i) => {
      const holding = fits.filter((fit) => brokenRule(rule, i, rules, fit.paths, fit.values, fit.sender) === undefined);
      lines.push(`  ${paths[i]}  [${describeRule(rule, sender)}]`);
      const heldText =
        rule.kind === 'free' || rule.kind === 'within-seconds' || rule.kind === 'equals' || rule.kind === 'share-price' || rule.kind === 'at-least' || rule.kind === 'at-most'
          ? ''
          : (rule.kind === 'address-word' ? rule.rule : rule).kind === 'card'
            ? `same as the other leaves bound to ${describeRule(rule, sender)} in ${holding.length} of ${fits.length}; `
            : `equalled ${describeRule(rule, sender)} in ${holding.length} of ${fits.length} (${plural(sendersOf(holding), who, many)}); `;
      const number = numbers.find((n) => n.path === paths[i]);
      lines.push(`    ${heldText}values: ${number === undefined ? distribution(run, fits, i, registry, sender) : spreadText(number)}`);
    });
  }
  if (misfits.length > 0) {
    lines.push('misfits, by reason:');
    const names = functionNames(run.query.template);
    const groups = new Map<string, Misfit[]>();
    for (const m of misfits) {
      const reason = plain(misfitText(m.reason, registry, names));
      groups.set(reason, [...(groups.get(reason) ?? []), m]);
    }
    for (const [reason, members] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  ${members.length} from ${plural(sendersOf(members), who, many)}: ${reason}`);
      lines.push(`    e.g. ${members.slice(0, 3).map((m) => mark(m.hash)).join(', ')}`);
    }
  }
  const exactFirst = [...fits.filter((fit) => fit.outside.length === 0), ...fits.filter((fit) => fit.outside.length > 0)];
  if (fits.length > 0) lines.push(`examples that fit: ${exactFirst.slice(0, 3).map((f) => mark(f.hash)).join(', ')}`);
}

function spreadText({ time, spread, unrecorded }: FreeNumber): string {
  const missing = unrecorded === 0 ? '' : `; block time not recorded for ${unrecorded}`;
  if (spread === undefined) return `${time ? "less the block's time: " : ''}none${missing}`;
  const percentiles = PERCENTILES.map((p, i) => `p${p} ${spread.percentiles[i]}`).join(', ');
  return `${time ? "less the block's time, in seconds: " : ''}${plural(spread.count, 'transaction')}, min ${spread.min}, ${percentiles}, max ${spread.max}${missing}`;
}

/** One token an effect moved in the measured transactions: each party's differences, and the sender types they came from. */
type TokenAmounts = {
  readonly token: Address;
  /** A registry entry, which a card can name; only such a token gives a finding. */
  readonly inRegistry: boolean;
  readonly sender: readonly Difference[];
  readonly receiver: readonly Difference[];
  readonly safes: number;
  readonly eoas: number;
};

/** A measured effect the report shows: one whose differences are not all 0, or that declares a tolerance. */
type EffectAmounts = {
  readonly effect: StatedEffect;
  readonly tokens: readonly TokenAmounts[];
  readonly finding: ReturnType<typeof toleranceFinding>;
};

type Amounts = { readonly effects: readonly EffectAmounts[]; readonly unmeasured: ReadonlyMap<string, readonly Hex[]> };

export function amountsOf(run: PastTxs, registry: Registry): Amounts {
  const senderOf = new Map(run.studies.flatMap((s) => (s.kind === 'fit' ? [[s.hash, s.sender] as const] : [])));
  const measured = [...run.measurements].flatMap(([hash, m]) => (m.kind === 'measured' ? m.differences.map((d) => ({ hash, d })) : []));
  const effects = run.effects.flatMap((effect, i): EffectAmounts[] => {
    const mine = measured.filter(({ d }) => d.effect === i);
    if (!shown(effect, mine.map(({ d }) => d))) return [];
    const tokens = [...new Set(mine.map(({ d }) => d.token))].map((token): TokenAmounts => {
      const of = mine.filter(({ d }) => d.token === token);
      const sender = of.filter(({ d }) => d.party === 'sender');
      const kinds = sender.map(({ hash }) => senderOf.get(hash)?.kind);
      return {
        token,
        inRegistry: registry.byAddress.has(token),
        sender: sender.map(({ d }) => d),
        receiver: of.filter(({ d }) => d.party === 'receiver').map(({ d }) => d),
        safes: kinds.filter((k) => k === 'safe').length,
        eoas: kinds.filter((k) => k === 'eoa').length,
      };
    });
    return [{ effect, tokens, finding: toleranceFinding(effect, tokens.filter((t) => t.inRegistry).flatMap((t) => t.sender)) }];
  });
  const unmeasured = new Map<string, Hex[]>();
  if (effects.length > 0) for (const [hash, m] of run.measurements) if (m.kind === 'unmeasured') unmeasured.set(m.why, [...(unmeasured.get(m.why) ?? []), hash]);
  return { effects, unmeasured };
}

const unitsText = (n: bigint): string => `${n} base unit${n === 1n ? '' : 's'}`;
const byText = (by: bigint): string => (by === 0n ? 'exact' : `${unitsText(by < 0n ? -by : by)} ${by < 0n ? 'lower' : 'higher'}`);

/** Such as `2 base units lower in 8, 1 base unit lower in 10, exact in 20; at most 2 base units lower`. */
function distributionText(differences: readonly Difference[]): string {
  const { counts, lowest, highest } = distributionOf(differences);
  const parts = [...counts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([by, n]) => `${byText(by)} in ${n}`);
  const extremes = [lowest < 0n ? `${unitsText(-lowest)} lower` : '', highest > 0n ? `${unitsText(highest)} higher` : ''].filter((t) => t !== '');
  return `${parts.join(', ')}; at most ${extremes.length === 0 ? '0 base units either way' : extremes.join(' and ')}`;
}

const toleranceText = (effect: StatedEffect): string =>
  effect.tolerance === undefined ? 'none declared, so 0' : `${unitsText(effect.tolerance.less)} lower, ${unitsText(effect.tolerance.more)} higher`;

function renderAmounts(lines: string[], run: PastTxs, registry: Registry): void {
  const { effects, unmeasured } = amountsOf(run, registry);
  if (effects.length === 0) return;
  lines.push("amounts against balances, each transaction run alone on its parent block (shown for an effect that declares a tolerance or whose balances did not all change by exactly the stated amount):");
  for (const { effect, tokens, finding } of effects) {
    lines.push(`  ${effectText(effect)}; tolerance: ${toleranceText(effect)}`);
    for (const t of tokens) {
      const name = registry.byAddress.get(t.token)?.name;
      lines.push(`    ${name === undefined ? `${checksumAddress(t.token)}, outside the registry, so no card can name it and it gives no finding` : `${name} ${checksumAddress(t.token)}`}: ${plural(t.sender.length, 'transaction')}, ${t.safes} from Safes, ${t.eoas} from EOAs`);
      lines.push(`      the sender: ${distributionText(t.sender)}`);
      if (t.receiver.length > 0) lines.push(`      the receiver: ${distributionText(t.receiver)}`);
    }
    if (finding?.kind === 'beyond') {
      const ends = [finding.lower > 0n ? `${unitsText(finding.lower)} lower` : '', finding.higher > 0n ? `${unitsText(finding.higher)} higher` : ''].filter((x) => x !== '').join(' and ');
      lines.push(`    FINDING: a sender's balance ended up to ${ends} than stated, beyond the tolerance; such a transaction to sign would be MISMATCH`);
    }
    if (finding?.kind === 'unfounded') lines.push('    FINDING: a tolerance is declared, but no measured transaction ended other than exactly as stated: no evidence for it');
  }
  for (const [why, hashes] of unmeasured) lines.push(`  not measured, ${why}: ${hashes.length}, e.g. ${examples(hashes)}`);
}

function renderTraces(lines: string[], run: PastTxs): void {
  if (run.traces.length === 0) return;
  const traced = run.traces.filter((t) => t.kind === 'traced').length;
  lines.push(`call traces, from drpc, of the transactions exactly the template: ${plural(run.traces.length, 'transaction')}, ${traced} checked against the receipt both providers agree on`);
  const why = new Map<string, Hex[]>();
  for (const t of run.traces) if (t.kind === 'unverifiable') why.set(t.why, [...(why.get(t.why) ?? []), t.hash]);
  for (const [reason, hashes] of why) lines.push(`  UNVERIFIABLE, ${reason}: ${hashes.length}, e.g. ${examples(hashes)}`);
}

function chosenText({ safes, safesChosen, rest, restChosen }: Selection, checked: boolean): string {
  const some = (chosen: number, of: number, noun: string) => `${chosen === of ? 'all ' : `${chosen} of `}${plural(of, noun)}`;
  const others =
    rest === 0 ? `no ${checked ? 'other ' : ''}transaction`
    : !checked ? some(restChosen, rest, 'transaction')
    : restChosen === rest ? `all ${plural(rest, 'other')}`
    : `${restChosen} of the other ${rest}`;
  const withSafe = safes === 0 ? 'no transaction with a proven Safe party' : `${some(safesChosen, safes, 'transaction')} with a proven Safe party`;
  const evenly = safesChosen + restChosen > 0 ? ', taken evenly in block order' : '';
  return `${checked ? `${withSafe}, and ${others}` : others}${evenly}`;
}

const dateOf = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString().slice(0, 10);

/** How long `seconds` is, in days, or in hours below a day. */
const lengthText = (seconds: bigint): string => {
  const days = Number(seconds) / 86400;
  return days >= 1 ? `${days.toFixed(1)} days` : `${(days * 24).toFixed(1)} hours`;
};

/** The range a newest-first search read completely, its dates and length, and why it starts where it does. */
function coverageText({ kind, range, pages, time }: Coverage, head: bigint): string {
  const when = time === undefined ? '' : ` (${dateOf(time.from)} to ${dateOf(time.to)}, ${lengthText(time.to - time.from)})`;
  if (kind === 'year') return `whole year, newest first: blocks ${range.fromBlock} to ${range.toBlock}${when}, in ${plural(pages, 'page')} of up to ${PAGE}, so the search covers the year with no gap`;
  return `newest first: blocks ${range.fromBlock} to ${range.toBlock}${when}, every transaction in them; the search stopped at its cap of ${plural(pages, 'page')} of up to ${PAGE}, so blocks ${yearBefore(head).fromBlock} to ${range.fromBlock - 1n} of the last year are not searched`;
}

/** What a reader of the report sees. Never names the configured Safe, and names no other sender either. */
export function renderPastTxs(run: PastTxs, registry: Registry): string {
  const { anchor, template, sampling } = run.query;
  const lines: string[] = [];
  const named = (address: Address): string => registry.byAddress.get(address)?.name ?? checksumAddress(address);
  const moved = `moved${anchor.from === undefined ? '' : ` out of ${named(anchor.from)}`}${anchor.to === undefined ? '' : ` into ${named(anchor.to)}`}`;
  const of = anchor.token === undefined ? 'any contract, studied only where the sender logged it itself' : `${registry.byAddress.get(anchor.token)?.name ?? ''} ${checksumAddress(anchor.token)}`.trim();
  lines.push(`past transactions for ${template.id}`);
  if (anchor.kind === 'event') lines.push(`anchor: ${anchor.event?.signature} logged by ${of}`);
  else lines.push(`anchor: Transfer of ${of} ${{ mint: 'minted (from the zero address)', burn: 'burned (to the zero address)', any: moved }[anchor.kind]}`);
  const blocks = (range: BlockRange) => `blocks ${range.fromBlock} to ${range.toBlock}`;
  const search = run.search;
  let chosen: SafesFirst | undefined;
  if (search.kind === 'newest-first') {
    lines.push(coverageText(search.coverage, run.head as bigint));
    const { selection } = search.safesFirst;
    lines.push(`  ${blocks(search.coverage.range)}: ${run.found.total} found, ${selection.safesChosen + selection.restChosen} studied`);
    chosen = search.safesFirst;
  } else {
    const { year } = search;
    if (year?.kind === 'covered' && year.safesFirst === undefined) {
      lines.push(`whole year: ${blocks(year.range)}, every source's answer in one page, so the search covers the year with no gap; at most ${search.perWindow} studied, taken evenly in block order`);
    } else if (year?.kind === 'covered') {
      const pages = [...year.pages].map(([source, n]) => `${source} in ${plural(n, 'page')}`).join(' and ');
      lines.push(`whole year: ${blocks(year.range)}, ${pages} of up to ${PAGE}, so the search covers the year with no gap`);
    } else if (sampling.kind !== 'range') {
      if (year !== undefined) {
        const over = year.pages === 1 ? 'more than one page of a source' : `more than ${year.pages} pages of ${PAGE} in ${year.sources.join(' and ')}`;
        lines.push(`whole year: ${blocks(year.range)} hold ${over}, so the windows are searched`);
      }
      lines.push(`windows: ${WINDOWS.count} of up to ${WINDOWS.blocks} blocks, one every ${YEAR / BigInt(WINDOWS.count)} blocks over the last year; at most ${search.perWindow} studied per window`);
    } else lines.push('windows: one block range given by hand');
    for (const { asked, range, found, studied } of search.windows) {
      const halved = asked.fromBlock === range.fromBlock ? '' : `; halved, too many transfers in ${asked.fromBlock} to ${asked.toBlock}, so ${asked.fromBlock} to ${range.fromBlock - 1n} not searched`;
      lines.push(`  ${blocks(range)}: ${found} found, ${studied} studied${halved}`);
    }
    if (year?.kind === 'covered') chosen = year.safesFirst;
  }
  if (chosen !== undefined) {
    const { check, selection } = chosen;
    const unreadable = check.kind === 'checked' && check.unreadable > 0 ? `, ${check.unreadable} unreadable` : '';
    lines.push(
      check.kind === 'checked'
        ? `anchor parties, ${check.noun}: ${check.parties}, read at block ${check.block}: ${plural(check.safes, 'proven Safe')}${unreadable}`
        : `anchor parties: not checked, ${check.why}`,
    );
    lines.push(`chosen to study: ${chosenText(selection, check.kind === 'checked')}`);
  }

  const { only } = run.found;
  if (searchedBy(anchor).length === SOURCES.length) {
    const both = run.found.total - only.alchemy.length - only.etherscan.length;
    lines.push(`sources: alchemy found ${foundBy(run.found, 'alchemy')}, etherscan found ${foundBy(run.found, 'etherscan')}; both ${both}, only alchemy ${only.alchemy.length}, only etherscan ${only.etherscan.length}`);
    for (const source of SOURCES) if (only[source].length > 0) lines.push(`  only ${source}: ${only[source].join(', ')}`);
  } else lines.push(`sources: etherscan found ${foundBy(run.found, 'etherscan')}; alchemy does not search an event (its eth_getLogs reads at most 10 blocks at a time on the free plan)`);
  if (run.otherEmitter.length > 0) lines.push(`not studied, the event logged only by another contract than the sender: ${run.otherEmitter.length}, e.g. ${examples(run.otherEmitter)}`);
  const onlyBy = new Map(SOURCES.flatMap((source) => only[source].map((hash) => [hash, source] as const)));
  const mark = (hash: Hex): string => {
    const source = onlyBy.get(hash);
    return source === undefined ? hash : `${hash} [only ${source}]`;
  };

  const n = run.studies.length;
  const fits = run.studies.filter((s): s is Fit => s.kind === 'fit');
  const misfits = run.studies.filter((s): s is Misfit => s.kind === 'misfit');
  const bySafe = (s: { sender: Sender }) => s.sender.kind === 'safe';
  const safes = [...fits, ...misfits].filter(bySafe);
  const eoas = [...fits, ...misfits].filter((s) => !bySafe(s));
  const unproven = run.studies.filter((s) => s.kind === 'unproven');
  const other = run.studies.filter((s) => s.kind === 'not-studied');
  lines.push(`senders, of ${plural(n, 'transaction')} studied:`);
  lines.push(`  proven Safe: ${safes.length}, from ${plural(sendersOf(safes), 'Safe')}`);
  lines.push(`  contract, not a proven Safe: ${unproven.length}, from ${plural(distinct(unproven.map((s) => s.contract)), 'contract')}`);
  const unprovenGroups = new Map<string, Hex[]>();
  for (const s of unproven) unprovenGroups.set(s.why, [...(unprovenGroups.get(s.why) ?? []), s.hash]);
  for (const [why, hashes] of unprovenGroups) lines.push(`    ${hashes.length} ${why}: ${examples(hashes)}`);
  lines.push(`  EOA calling a function of the template directly: ${eoas.length}, from ${plural(sendersOf(eoas), 'EOA')}`);
  lines.push(`  neither: ${other.length}`);
  const whyGroups = new Map<string, Map<string, number>>();
  for (const s of other) {
    const selectors = whyGroups.get(s.why) ?? new Map<string, number>();
    selectors.set(s.selector, (selectors.get(s.selector) ?? 0) + 1);
    whyGroups.set(s.why, selectors);
  }
  for (const [why, selectors] of whyGroups) {
    const count = [...selectors.values()].reduce((a, b) => a + b, 0);
    const top = [...selectors].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([sel, k]) => `${sel} in ${k}`).join(', ');
    lines.push(`    ${count} ${why} (called ${top}${selectors.size > 4 ? ', …' : ''})`);
  }
  const unreadable = run.studies.filter((s) => s.kind === 'unreadable');
  const unreadableGroups = new Map<string, Hex[]>();
  for (const s of unreadable) unreadableGroups.set(s.reason, [...(unreadableGroups.get(s.reason) ?? []), s.hash]);
  for (const [reason, hashes] of [...unreadableGroups].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${hashes.length} unreadable, ${reason}: ${examples(hashes)}`);
  }

  renderAmounts(lines, run, registry);
  renderTraces(lines, run);
  lines.push('by proven Safes, the whole template in one transaction:');
  const otherOperation = misfits.filter((m) => isOtherOperation(m, template));
  if (otherOperation.length > 0) {
    lines.push(`another operation, making none of the template's calls: ${plural(otherOperation.length, 'transaction')} from ${plural(sendersOf(otherOperation), 'Safe')}; not counted below`);
    const names = functionNames(template);
    for (const m of otherOperation.slice(0, 3)) lines.push(`  e.g. ${mark(m.hash)}: ${plain(misfitText(m.reason, registry, names))}`);
  }
  renderGroup(lines, { fits: fits.filter(bySafe), misfits: misfits.filter((m) => bySafe(m) && !isOtherOperation(m, template)), rules: run.shapes.whole.loosened.rules, senderLabel: 'the Safe', senderNoun: 'Safe' }, run, registry, mark);
  run.shapes.calls.forEach((shape, call) => {
    const ofCall = (s: { sender: Sender }) => s.sender.kind === 'eoa' && s.sender.call === call;
    const group = { fits: fits.filter(ofCall), misfits: misfits.filter(ofCall), rules: shape.loosened.rules, senderLabel: 'the sender', senderNoun: 'EOA' };
    if (group.fits.length + group.misfits.length === 0) return;
    const data = shape.template.calls[0]?.data;
    lines.push(`by EOAs, call ${call + 1} of ${run.shapes.calls.length} (${data === undefined || data === 'empty' ? 'no data' : data.fn.name}) as its own transaction:`);
    renderGroup(lines, group, run, registry, mark);
  });
  return `${lines.join('\n')}\n`;
}