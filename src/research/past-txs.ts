import type { Reader } from '../chain/reader.ts';
import type { AbiType } from '../decode/abi.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address, Hex } from '../safe/types.ts';
import type { Template } from '../template/template.ts';
import { SOURCES, searchBoth } from './sources.ts';
import type { Anchor, Ask, Hits, SourceName } from './sources.ts';
import { constText, loosen, studyTx } from './study.ts';
import type { LeafRule, TxStudy } from './study.ts';

export type PastTxsQuery = { readonly template: Template; readonly anchor: Anchor };

export type PastTxsDeps = {
  readonly ask: Ask;
  readonly reader: Reader;
  readonly registry: Registry;
  readonly exclude: Address | undefined;
  /** Refuses a search that finds more transactions than this. */
  readonly maxTxs: number;
};

type Kept = Exclude<TxStudy, { kind: 'excluded' }>;

export type PastTxs = {
  readonly query: PastTxsQuery;
  /** Each kept transaction with the sources that found it. */
  readonly found: ReadonlyMap<Hex, readonly SourceName[]>;
  readonly studies: readonly Kept[];
  readonly rules: readonly LeafRule[];
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

export async function pastTxs(query: PastTxsQuery, deps: PastTxsDeps): Promise<PastTxs> {
  const hits = await searchBoth(query.anchor, deps.ask);
  const { found, excluded } = hashesBySource(hits, deps.exclude);
  if (found.size > deps.maxTxs) throw new Error(`the sources found ${found.size} transactions, more than ${deps.maxTxs}; narrow the block range`);
  const loosened = loosen(query.template);
  const context = { template: query.template, loosened, registry: deps.registry, exclude: deps.exclude };
  const all = await inPool([...found.keys()], 4, (hash) => studyTx(deps.reader, hash, context).then((study) => ({ hash, study })));
  const studies: Kept[] = [];
  for (const { hash, study } of all) {
    if (study.kind === 'excluded') {
      excluded.add(hash);
      found.delete(hash);
    } else studies.push(study);
  }
  return { query, found, studies, rules: loosened.rules, excluded };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function describeRule(rule: LeafRule): string {
  switch (rule.kind) {
    case 'safe':
      return 'the Safe';
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

/** Whether the rule held in this transaction; undefined for a free leaf. */
function held(rule: LeafRule, fit: Fit, i: number, rules: readonly LeafRule[], registry: Registry): boolean | undefined {
  const value = fit.values[i];
  switch (rule.kind) {
    case 'safe':
      return value === fit.safe;
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

function label(value: string, type: AbiType, fit: Fit, registry: Registry, anchorToken: Address): string | undefined {
  if (type.kind !== 'address') return undefined;
  if (value === fit.safe) return 'the Safe';
  const named = registry.byAddress.get(value as Address)?.name;
  if (named !== undefined) return named;
  if (value === anchorToken) return 'the anchor token';
  if (value === ZERO) return 'the zero address';
  return 'another address';
}

const short = (value: string): string => (value.length > 24 ? `${value.slice(0, 18)}…(${(value.length - 2) / 2} bytes)` : value);

function distribution(run: PastTxs, fits: readonly Fit[], i: number, registry: Registry): string {
  const type = fits[0]?.types[i] as AbiType;
  const counts = new Map<string, number>();
  const raw = new Set<string>();
  for (const fit of fits) {
    const value = fit.values[i] as string;
    raw.add(value);
    const name = label(value, type, fit, registry, run.query.anchor.token) ?? value;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (type.kind !== 'address' && counts.size > 3) return `${raw.size} distinct values`;
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${short(name)} in ${n}`);
  const others = type.kind === 'address' ? [...raw].filter((v) => label(v, type, fits.find((f) => f.values[i] === v) as Fit, registry, run.query.anchor.token) === 'another address').length : 0;
  return `${parts.join(', ')}${others > 1 ? ` (${others} distinct other addresses)` : ''}`;
}

const safesOf = (studies: readonly { safe: Address }[]): number => new Set(studies.map((s) => s.safe)).size;

const examples = (hashes: readonly Hex[], n = 3): string => hashes.slice(0, n).join(', ');

/** What a reader of the report sees. Never names the configured Safe, and names no other Safe either. */
export function renderPastTxs(run: PastTxs, registry: Registry): string {
  const { anchor, template } = run.query;
  const lines: string[] = [];
  const tokenName = registry.byAddress.get(anchor.token)?.name;
  const direction = { mint: 'minted (from the zero address)', burn: 'burned (to the zero address)', any: 'moved' }[anchor.kind];
  lines.push(`past transactions for ${template.id}`);
  lines.push(`anchor: Transfer of ${tokenName === undefined ? '' : `${tokenName} `}${checksumAddress(anchor.token)} ${direction}, blocks ${anchor.fromBlock} to ${anchor.toBlock}`);

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

  const unreadable = run.studies.filter((s) => s.kind === 'unreadable');
  const notSafe = run.studies.filter((s) => s.kind === 'not-safe');
  const fits = run.studies.filter((s): s is Fit => s.kind === 'fit');
  const misfits = run.studies.filter((s) => s.kind === 'misfit');
  const bySafe = [...fits, ...misfits];
  lines.push(`executed by a Safe through execTransaction: ${bySafe.length} of ${run.studies.length}, from ${plural(safesOf(bySafe), 'Safe')}`);
  const whyGroups = new Map<string, Map<string, number>>();
  for (const s of notSafe) {
    const selectors = whyGroups.get(s.why) ?? new Map<string, number>();
    selectors.set(s.selector, (selectors.get(s.selector) ?? 0) + 1);
    whyGroups.set(s.why, selectors);
  }
  for (const [why, selectors] of whyGroups) {
    const n = [...selectors.values()].reduce((a, b) => a + b, 0);
    const top = [...selectors].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([sel, k]) => `${sel} in ${k}`).join(', ');
    lines.push(`  ${n} ${why} (called ${top}${selectors.size > 4 ? ', …' : ''})`);
  }
  if (unreadable.length > 0) lines.push(`  ${unreadable.length} unreadable (the two providers did not agree): ${examples(unreadable.map((s) => s.hash))}`);
  lines.push(`fit the template's shape: ${plural(fits.length, 'transaction')} from ${plural(safesOf(fits), 'Safe')}; misfits: ${misfits.length} from ${plural(safesOf(misfits), 'Safe')}`);

  if (fits.length > 0) {
    lines.push(`fields, over the ${plural(fits.length, 'fitting transaction')}:`);
    const paths = fits[0]?.paths ?? [];
    run.rules.forEach((rule, i) => {
      const verdicts = fits.map((fit) => held(rule, fit, i, run.rules, registry));
      const holding = fits.filter((_, k) => verdicts[k] === true);
      lines.push(`  ${paths[i]}  [${describeRule(rule)}]`);
      const heldText =
        rule.kind === 'free'
          ? ''
          : rule.kind === 'card'
            ? `same as the other leaves bound to ${describeRule(rule)} in ${holding.length} of ${fits.length}; `
            : `equalled ${describeRule(rule)} in ${holding.length} of ${fits.length} (${plural(safesOf(holding), 'Safe')}); `;
      lines.push(`    ${heldText}values: ${distribution(run, fits, i, registry)}`);
    });
  }

  if (misfits.length > 0) {
    lines.push('misfits, by reason:');
    const groups = new Map<string, typeof misfits>();
    for (const m of misfits) groups.set(m.reason, [...(groups.get(m.reason) ?? []), m]);
    for (const [reason, group] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  ${group.length} from ${plural(safesOf(group), 'Safe')}: ${reason}`);
      lines.push(`    e.g. ${group.slice(0, 3).map((m) => mark(m.hash)).join(', ')}`);
    }
  }
  if (fits.length > 0) lines.push(`examples that fit: ${fits.slice(0, 3).map((f) => mark(f.hash)).join(', ')}`);
  return `${lines.join('\n')}\n`;
}
