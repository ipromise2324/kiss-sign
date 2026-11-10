import type { Reader } from '../chain/reader.ts';
import type { AbiType } from '../decode/abi.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { Template } from '../template/template.ts';
import { ResearchError, SOURCES, TooManyTransfers, searchBoth } from './sources.ts';
import type { Anchor, Ask, Hits, SourceName } from './sources.ts';
import { constText, shapesOf, studyTx } from './study.ts';
import type { LeafRule, Sender, TxStudy } from './study.ts';

export type BlockRange = { readonly fromBlock: bigint; readonly toBlock: bigint };

/**
 * `spread`: `count` windows of up to `blocks` blocks each, evenly spaced over the last year and placed by the head
 * block alone. A window whose transfers do not fit one page of a source is halved until they do. `range`: one window
 * the caller chose, refused when it holds more than a page.
 */
export type Sampling = { readonly kind: 'spread'; readonly count: number; readonly blocks: bigint } | { readonly kind: 'range'; readonly range: BlockRange };

export const DEFAULT_SPREAD: Sampling = { kind: 'spread', count: 12, blocks: 7200n };

const YEAR = (365n * 24n * 60n * 60n) / 12n;
const FINALITY = 64n;

export function spreadWindows(head: bigint, count: number, blocks: bigint): BlockRange[] {
  const top = ((head - FINALITY) / blocks) * blocks;
  const step = YEAR / BigInt(count);
  return Array.from({ length: count }, (_, i) => {
    const toBlock = top - BigInt(count - 1 - i) * step;
    return { fromBlock: toBlock - blocks + 1n, toBlock };
  });
}

export type PastTxsQuery = { readonly template: Template; readonly anchor: Omit<Anchor, keyof BlockRange>; readonly sampling: Sampling };

export type PastTxsDeps = {
  readonly ask: Ask;
  readonly reader: Reader;
  readonly registry: Registry;
  readonly exclude: Address | undefined;
  /** The most transactions studied in a run, shared evenly between the windows. */
  readonly maxTxs: number;
};

type Kept = Exclude<TxStudy, { kind: 'excluded' }>;

/** One window as searched: `found` transactions after exclusion, of which `studied` were read. */
export type WindowRun = { readonly range: BlockRange; readonly found: number; readonly studied: number };

export type PastTxs = {
  readonly query: PastTxsQuery;
  readonly windows: readonly WindowRun[];
  /** Each kept transaction with the sources that found it. */
  readonly found: ReadonlyMap<Hex, readonly SourceName[]>;
  readonly studies: readonly Kept[];
  readonly shapes: ReturnType<typeof shapesOf>;
  /** Transactions left out because they touch the configured Safe. Never printed. */
  readonly excluded: ReadonlySet<Hex>;
};

const ZERO = `0x${'00'.repeat(20)}`;

function hashesBySource(hits: Hits, exclude: Address | undefined): { found: Map<Hex, SourceName[]>; excluded: Set<Hex> } {
  const found = new Map<Hex, SourceName[]>();
  const excluded = new Set<Hex>();
  for (const source of SOURCES) {
    for (const hit of hits[source]) {
      if (exclude !== undefined && (hit.from === exclude || hit.to === exclude)) excluded.add(hit.hash);
      const sources = found.get(hit.hash) ?? [];
      if (!sources.includes(source)) sources.push(source);
      found.set(hit.hash, sources);
    }
  }
  for (const hash of excluded) found.delete(hash);
  return { found, excluded };
}

async function inPool<T, R>(items: readonly T[], width: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}

async function searchWindow(anchor: PastTxsQuery['anchor'], range: BlockRange, sampling: Sampling['kind'], ask: Ask): Promise<{ range: BlockRange; hits: Hits }> {
  for (;;) {
    try {
      return { range, hits: await searchBoth({ ...anchor, ...range }, ask) };
    } catch (error) {
      if (!(error instanceof TooManyTransfers)) throw error;
      if (sampling === 'range' || range.fromBlock === range.toBlock) throw new ResearchError(`${error.message}; narrow the block range`);
      range = { fromBlock: range.toBlock - (range.toBlock - range.fromBlock + 1n) / 2n + 1n, toBlock: range.toBlock };
    }
  }
}

const spacedSample = <T>(items: readonly T[], cap: number): T[] =>
  items.length <= cap ? [...items] : Array.from({ length: cap }, (_, i) => items[Math.floor((i * items.length) / cap)] as T);

export async function pastTxs(query: PastTxsQuery, deps: PastTxsDeps): Promise<PastTxs> {
  const { sampling } = query;
  let ranges: BlockRange[];
  if (sampling.kind === 'range') ranges = [sampling.range];
  else {
    const head = await deps.reader.blockNumber();
    if (head.kind === 'unverifiable') throw new ResearchError(`the head block: ${head.reason}`);
    ranges = spreadWindows(head.value, sampling.count, sampling.blocks);
  }
  const cap = Math.max(1, Math.floor(deps.maxTxs / ranges.length));
  const found = new Map<Hex, SourceName[]>();
  const excluded = new Set<Hex>();
  const searched: { range: BlockRange; found: Hex[]; sample: Hex[] }[] = [];
  for (const asked of ranges) {
    const { range, hits } = await searchWindow(query.anchor, asked, sampling.kind, deps.ask);
    const window = hashesBySource(hits, deps.exclude);
    for (const hash of window.excluded) excluded.add(hash);
    for (const [hash, sources] of window.found) found.set(hash, sources);
    searched.push({ range, found: [...window.found.keys()], sample: spacedSample([...window.found.keys()], cap) });
  }
  const shapes = shapesOf(query.template);
  const context = { shapes, registry: deps.registry, exclude: deps.exclude };
  const all = await inPool(searched.flatMap((w) => w.sample), 4, (hash) => studyTx(deps.reader, hash, context).then((study) => ({ hash, study })));
  const studies: Kept[] = [];
  for (const { hash, study } of all) {
    if (study.kind === 'excluded') {
      excluded.add(hash);
      found.delete(hash);
    } else studies.push(study);
  }
  const kept = (hashes: readonly Hex[]) => hashes.filter((hash) => !excluded.has(hash)).length;
  const windows = searched.map(({ range, found, sample }) => ({ range, found: kept(found), studied: kept(sample) }));
  return { query, windows, found, studies, shapes, excluded };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function describeRule(rule: LeafRule, sender: string): string {
  switch (rule.kind) {
    case 'safe':
      return sender;
    case 'contract':
      return `contract ${rule.name}`;
    case 'const':
      return `const ${constText(rule.value)}`;
    case 'card':
      return `card ${rule.ref.field}${rule.ref.attribute === undefined ? '' : `.${rule.ref.attribute}`}`;
    case 'free':
      return 'free';
  }
}

const cardKey = (rule: LeafRule): string | undefined =>
  rule.kind === 'card' ? `${rule.ref.field}.${rule.ref.attribute ?? ''}` : undefined;

type Fit = Extract<Kept, { kind: 'fit' }>;
type Misfit = Extract<Kept, { kind: 'misfit' }>;

/** Whether the rule held in this transaction; undefined for a free leaf. */
function held(rule: LeafRule, fit: Fit, i: number, rules: readonly LeafRule[], registry: Registry): boolean | undefined {
  const value = fit.values[i];
  switch (rule.kind) {
    case 'safe':
      return value === fit.sender.address;
    case 'contract':
      return value === registry.entries.get(rule.name)?.address;
    case 'const':
      return value === constText(rule.value);
    case 'card': {
      const key = cardKey(rule);
      return rules.every((other, j) => cardKey(other) !== key || fit.values[j] === value);
    }
    case 'free':
      return undefined;
  }
}

function label(value: string, type: AbiType, fit: Fit, registry: Registry, anchorToken: Address, sender: string): string | undefined {
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

type Group = { readonly fits: readonly Fit[]; readonly misfits: readonly Misfit[]; readonly rules: readonly LeafRule[]; readonly senderLabel: string; readonly senderNoun: string };

function renderGroup(lines: string[], group: Group, run: PastTxs, registry: Registry, mark: (hash: Hex) => string): void {
  const { fits, misfits, rules, senderLabel: sender, senderNoun: who } = group;
  const many = `${who}s`;
  lines.push(`fit the ${who === 'Safe' ? "template's" : "call's"} shape: ${plural(fits.length, 'transaction')} from ${plural(sendersOf(fits), who, many)}; misfits: ${misfits.length} from ${plural(sendersOf(misfits), who, many)}`);
  if (fits.length > 0) {
    lines.push(`fields, over the ${plural(fits.length, 'fitting transaction')}:`);
    const paths = fits[0]?.paths ?? [];
    rules.forEach((rule, i) => {
      const verdicts = fits.map((fit) => held(rule, fit, i, rules, registry));
      const holding = fits.filter((_, k) => verdicts[k] === true);
      lines.push(`  ${paths[i]}  [${describeRule(rule, sender)}]`);
      const heldText =
        rule.kind === 'free'
          ? ''
          : rule.kind === 'card'
            ? `same as the other leaves bound to ${describeRule(rule, sender)} in ${holding.length} of ${fits.length}; `
            : `equalled ${describeRule(rule, sender)} in ${holding.length} of ${fits.length} (${plural(sendersOf(holding), who, many)}); `;
      lines.push(`    ${heldText}values: ${distribution(run, fits, i, registry, sender)}`);
    });
  }
  if (misfits.length > 0) {
    lines.push('misfits, by reason:');
    const groups = new Map<string, Misfit[]>();
    for (const m of misfits) groups.set(m.reason, [...(groups.get(m.reason) ?? []), m]);
    for (const [reason, members] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  ${members.length} from ${plural(sendersOf(members), who, many)}: ${reason}`);
      lines.push(`    e.g. ${members.slice(0, 3).map((m) => mark(m.hash)).join(', ')}`);
    }
  }
  if (fits.length > 0) lines.push(`examples that fit: ${fits.slice(0, 3).map((f) => mark(f.hash)).join(', ')}`);
}

/** What a reader of the report sees. Never names the configured Safe, and names no other sender either. */
export function renderPastTxs(run: PastTxs, registry: Registry): string {
  const { anchor, template, sampling } = run.query;
  const lines: string[] = [];
  const tokenName = registry.byAddress.get(anchor.token)?.name;
  const sender = anchor.from === undefined ? undefined : (registry.byAddress.get(anchor.from)?.name ?? checksumAddress(anchor.from));
  const direction = { mint: 'minted (from the zero address)', burn: 'burned (to the zero address)', any: sender === undefined ? 'moved' : `moved out of ${sender}` }[anchor.kind];
  lines.push(`past transactions for ${template.id}`);
  lines.push(`anchor: Transfer of ${tokenName === undefined ? '' : `${tokenName} `}${checksumAddress(anchor.token)} ${direction}`);
  if (sampling.kind === 'spread') {
    const cap = run.windows.length === 0 ? 0 : Math.max(...run.windows.map((w) => w.studied));
    lines.push(`windows: ${sampling.count} of up to ${sampling.blocks} blocks, one every ${YEAR / BigInt(sampling.count)} blocks over the last year; at most ${cap} studied per window`);
  } else lines.push('windows: one block range given by hand');
  for (const w of run.windows) lines.push(`  blocks ${w.range.fromBlock} to ${w.range.toBlock}: ${w.found} found, ${w.studied} studied`);

  const bySource = (source: SourceName) => [...run.found].filter(([, s]) => s.includes(source)).length;
  const only = (source: SourceName) => [...run.found].filter(([, s]) => s.length === 1 && s[0] === source).map(([hash]) => hash);
  const both = [...run.found].filter(([, s]) => s.length === SOURCES.length).length;
  lines.push(`sources: alchemy found ${bySource('alchemy')}, etherscan found ${bySource('etherscan')}; both ${both}, only alchemy ${only('alchemy').length}, only etherscan ${only('etherscan').length}`);
  for (const source of SOURCES) {
    const hashes = only(source);
    if (hashes.length > 0) lines.push(`  only ${source}: ${hashes.join(', ')}`);
  }
  const mark = (hash: Hex): string => {
    const sources = run.found.get(hash) ?? [];
    return sources.length === SOURCES.length ? hash : `${hash} [only ${sources[0]}]`;
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

  lines.push('by proven Safes, the whole template in one transaction:');
  renderGroup(lines, { fits: fits.filter(bySafe), misfits: misfits.filter(bySafe), rules: run.shapes.whole.loosened.rules, senderLabel: 'the Safe', senderNoun: 'Safe' }, run, registry, mark);
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
