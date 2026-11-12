import type { AbiProof, AbiRefusal } from '../contracts/prove.ts';
import { MARKET_ENTRY_PARTS, parseHttpsUrl } from '../registry.ts';
import type { HttpsUrl, RegistryEntry } from '../registry.ts';
import type { FixtureJudgement } from '../template/perturb.ts';
import { checkSources, githubLine, sourceSiteLine } from './listings.ts';
import type { Line } from './listings.ts';
import { entriesOf, hasMarket, pinVerdict, wordOf } from './report.ts';
import type { DocLink, ReportInputs, SpanCheck } from './report.ts';
import { isGitHubPage, pageUrlOf } from './source-page.ts';

/** ok passed; warn evidence missing (amber); bad a real disagreement (red); na nothing to compare (grey). */
export type State = 'ok' | 'warn' | 'bad' | 'na';

/** The check strip's lines that hold results, in strip order. 雙節點比對 is a rule of the program with no results. */
export const STRIP_LINES = ['sources', 'abi', 'code', 'params'] as const;
export type StripLine = (typeof STRIP_LINES)[number];

/** The sources an address row lists for the program, in row order. */
export const PROGRAM_SOURCES = ['page', 'api', 'coingecko', 'defillama'] as const;
export type ProgramSource = (typeof PROGRAM_SOURCES)[number];

/** The words an address row's source line shows beside a result that did not pass. */
export type Phrase = '讀不到' | '是另一個地址' | '是另一個網站' | '沒資料可比';

/** Why a result has its state. The kind alone fixes the state (`STATE_OF`), so evidence missing can never read as red. */
export type Finding =
  | { readonly kind: 'agrees' }
  /** The source's or a documentation page's registrable domain or GitHub org is not the one DefiLlama lists. */
  | { readonly kind: 'site-differs' }
  /** CoinGecko lists another coin at this address, or more than one. */
  | { readonly kind: 'other-coin' }
  /** The protocol API answered another address, nothing or no address at the path, or anything but its JSON. */
  | { readonly kind: 'other-answer' }
  /** A code pin span the chain did not run from its block. */
  | { readonly kind: 'pin-not-run' }
  /** The ABI proof proved code other than the current pin. */
  | { readonly kind: 'proof-not-pin' }
  | { readonly kind: 'refused'; readonly why: string }
  /** A recorded transaction of the template the program now judges otherwise. */
  | { readonly kind: 'judged-otherwise'; readonly why: 'card-refused' | 'fields' | 'mutation-uncaught' | 'perturbation'; readonly detail: string }
  /** A read that got no answer: `UNVERIFIABLE`. */
  | { readonly kind: 'no-answer' }
  /** The source page as served does not show the address next to its label. */
  | { readonly kind: 'page-unread'; readonly why: 'not-served' | 'not-fetched' | 'not-by-label' | 'no-label' }
  | { readonly kind: 'url-holds-address' }
  /** The site could not be compared: no slug, a slug DefiLlama lists none or several of, no Public Suffix List, no org. */
  | { readonly kind: 'site-not-compared' }
  /** DefiLlama lists no site and no other result of the entry vouches for its source. */
  | { readonly kind: 'no-second-source' }
  /** CoinGecko lists no coin at this address, or the entry names none. */
  | { readonly kind: 'no-coin' }
  /** Not pinned to a commit, the commit unknown, or not on the default branch. */
  | { readonly kind: 'commit-unconfirmed' }
  | { readonly kind: 'page-not-fetched' }
  | { readonly kind: 'name-not-on-page' }
  | { readonly kind: 'no-chain-result' }
  /** No code pin: signing would answer UNVERIFIABLE. */
  | { readonly kind: 'not-pinned' }
  /** DefiLlama lists no website or GitHub org, and CoinGecko lists the entry's coin at its address, or, for another site, the source's site agrees. */
  | { readonly kind: 'unlisted' }
  | { readonly kind: 'compiler-not-pinned'; readonly version: string }
  | { readonly kind: 'pinned-before-spans' }
  | { readonly kind: 'no-abi-case' };
export type FindingKind = Finding['kind'];

export const STATE_OF: { readonly [K in FindingKind]: State } = {
  agrees: 'ok',
  'site-differs': 'bad',
  'other-coin': 'bad',
  'other-answer': 'bad',
  'pin-not-run': 'bad',
  'proof-not-pin': 'bad',
  refused: 'bad',
  'judged-otherwise': 'bad',
  'no-answer': 'warn',
  'page-unread': 'warn',
  'url-holds-address': 'warn',
  'site-not-compared': 'warn',
  'no-second-source': 'warn',
  'no-coin': 'warn',
  'commit-unconfirmed': 'warn',
  'page-not-fetched': 'warn',
  'name-not-on-page': 'warn',
  'no-chain-result': 'warn',
  'not-pinned': 'warn',
  unlisted: 'na',
  'compiler-not-pinned': 'na',
  'pinned-before-spans': 'na',
  'no-abi-case': 'warn',
};

const PHRASE_OF: { readonly [K in FindingKind]: Phrase | undefined } = {
  agrees: undefined,
  'site-differs': '是另一個網站',
  'other-coin': '是另一個地址',
  'other-answer': '是另一個地址',
  'pin-not-run': undefined,
  'proof-not-pin': undefined,
  refused: undefined,
  'judged-otherwise': undefined,
  'no-answer': '讀不到',
  'page-unread': '讀不到',
  'url-holds-address': '讀不到',
  'site-not-compared': '沒資料可比',
  'no-second-source': '沒資料可比',
  'no-coin': '沒資料可比',
  'commit-unconfirmed': '讀不到',
  'page-not-fetched': '讀不到',
  'name-not-on-page': '讀不到',
  'no-chain-result': undefined,
  'not-pinned': undefined,
  unlisted: '沒資料可比',
  'compiler-not-pinned': undefined,
  'pinned-before-spans': undefined,
  'no-abi-case': undefined,
};

/** `<registry name>/<check key>`, such as `cbbtc/source.coingecko` or `morpho-blue/doc.0x095ea7b3.page`, or `fixture.<safe-tx fixture>`. */
export type ResultId = string;

export type Result = {
  readonly id: ResultId;
  readonly line: StripLine;
  readonly about: { readonly kind: 'entry'; readonly entry: RegistryEntry } | { readonly kind: 'fixture'; readonly name: string };
  /** The address-row source it is shown under; undefined for documentation, market, ABI, code and fixture results. */
  readonly source: ProgramSource | undefined;
  /** What that source line links: the entry's source page, its API, its CoinGecko coin or its DefiLlama protocol. */
  readonly link: HttpsUrl | undefined;
  readonly finding: Finding;
};

export type Ledger = { readonly entries: readonly RegistryEntry[]; readonly results: readonly Result[] };

export const stateOf = (result: Result): State => STATE_OF[result.finding.kind];

/** The one rule for 待確認, the rail count and the reviews notes.json must hold: red or amber. */
export const needsSigner = (result: Result): boolean => stateOf(result) === 'bad' || stateOf(result) === 'warn';

/** A draft result: `vouches` marks a passed comparison saying the source belongs to the protocol. */
type Draft = Result & { readonly vouches?: 'coin' | 'source-site' };

const LINE_KEYS: Readonly<Record<Line['check'], string>> = {
  page: 'source.page',
  url: 'source.url',
  github: 'source.commit',
  defillama: 'source.site',
  'api-site': 'source.api.site',
  api: 'source.api',
  coingecko: 'source.coingecko',
};
const LINE_ORDER: readonly Line['check'][] = ['page', 'url', 'api', 'defillama', 'api-site', 'github', 'coingecko'];
const LINE_SOURCE: Readonly<Record<Line['check'], ProgramSource>> = {
  page: 'page',
  url: 'page',
  github: 'page',
  api: 'api',
  coingecko: 'coingecko',
  defillama: 'defillama',
  'api-site': 'defillama',
};

const coingeckoUrl = (id: string | undefined) => (id === undefined ? undefined : parseHttpsUrl(`https://www.coingecko.com/en/coins/${id}`));
const defillamaUrl = (slug: string | undefined) => (slug === undefined ? undefined : parseHttpsUrl(`https://defillama.com/protocol/${slug}`));

function linkOf(entry: RegistryEntry, source: ProgramSource): HttpsUrl | undefined {
  switch (source) {
    case 'page':
      return entry.source;
    case 'api':
      return entry.apiSource?.url;
    case 'coingecko':
      return coingeckoUrl(entry.coingecko);
    case 'defillama':
      return defillamaUrl(entry.defillama);
  }
}

function siteFinding(line: Line): Finding {
  if (line.kind === 'agrees') return { kind: 'agrees' };
  if (line.kind === 'unverifiable') return { kind: 'no-answer' };
  if (line.cause === 'differs') return { kind: 'site-differs' };
  if (line.cause === 'unlisted') return { kind: 'unlisted' };
  return { kind: 'site-not-compared' };
}

function lineFinding(entry: RegistryEntry, line: Line): Finding {
  if (line.kind === 'agrees') return { kind: 'agrees' };
  if (line.kind === 'unverifiable') return { kind: 'no-answer' };
  switch (line.check) {
    case 'page':
      if (line.cause === 'not-served' || line.cause === 'not-fetched') return { kind: 'page-unread', why: line.cause };
      return { kind: 'page-unread', why: entry.sourceLabel === undefined ? 'no-label' : 'not-by-label' };
    case 'url':
      return { kind: 'url-holds-address' };
    case 'github':
      return { kind: 'commit-unconfirmed' };
    case 'api':
      return { kind: 'other-answer' };
    case 'coingecko':
      return line.cause === 'differs' ? { kind: 'other-coin' } : { kind: 'no-coin' };
    case 'defillama':
    case 'api-site':
      return siteFinding(line);
  }
}

function sourceResults(entry: RegistryEntry, lines: readonly Line[]): Draft[] {
  const about = { kind: 'entry', entry } as const;
  return [...lines]
    .sort((a, b) => LINE_ORDER.indexOf(a.check) - LINE_ORDER.indexOf(b.check))
    .map((line): Draft => {
      const source = LINE_SOURCE[line.check];
      const finding = lineFinding(entry, line);
      const vouches = finding.kind !== 'agrees' ? undefined : line.check === 'coingecko' ? 'coin' : line.check === 'defillama' ? 'source-site' : undefined;
      return { id: `${entry.name}/${LINE_KEYS[line.check]}`, line: 'sources', about, source, link: linkOf(entry, source), finding, ...(vouches === undefined ? {} : { vouches }) };
    });
}

function docResults(doc: DocLink, inputs: ReportInputs): Draft[] {
  const about = { kind: 'entry', entry: doc.contract } as const;
  const result = (check: string, finding: Finding): Draft => ({ id: `${doc.contract.name}/doc.${doc.fn.selector}.${check}`, line: 'sources', about, source: undefined, link: undefined, finding });
  const page = inputs.pages.pages.get(pageUrlOf(doc.url));
  const pageFinding: Finding =
    page?.kind === 'unread'
      ? { kind: 'no-answer' }
      : page?.kind !== 'served'
        ? { kind: 'page-not-fetched' }
        : page.blocks.some((block) => wordOf(doc.fn).test(block.text))
          ? { kind: 'agrees' }
          : { kind: 'name-not-on-page' };
  const site = siteFinding(sourceSiteLine(doc.url, doc.contract.defillama, inputs.listings));
  const results = [result('page', pageFinding), result('site', site)];
  const url = new URL(doc.url);
  if (isGitHubPage(url)) {
    const commit = githubLine(url, inputs.pages.commits);
    results.push(result('commit', commit.kind === 'agrees' ? { kind: 'agrees' } : commit.kind === 'unverifiable' ? { kind: 'no-answer' } : { kind: 'commit-unconfirmed' }));
  }
  return results;
}

function marketResults(entry: RegistryEntry, inputs: ReportInputs): Draft[] {
  if (inputs.subject.kind !== 'template' || !hasMarket(inputs.subject.template)) return [];
  return [...inputs.registry.markets.values()].flatMap((market) =>
    MARKET_ENTRY_PARTS.filter((part) => market[part].name === entry.name).map(
      (part): Draft => ({ id: `${entry.name}/market.${market.name}.${part}`, line: 'sources', about: { kind: 'entry', entry }, source: undefined, link: undefined, finding: { kind: 'agrees' } }),
    ),
  );
}

function abiFinding(entry: RegistryEntry, proof: AbiProof | AbiRefusal | undefined): Finding {
  if (proof === undefined) return { kind: 'no-abi-case' };
  if (proof.kind === 'refused') {
    const { refusal } = proof;
    return refusal.why === 'compiler-not-pinned' ? { kind: 'compiler-not-pinned', version: refusal.version } : { kind: 'refused', why: refusal.why };
  }
  const verdict = pinVerdict(entry, proof);
  return verdict === 'PASS' ? { kind: 'agrees' } : verdict === 'FINDING' ? { kind: 'proof-not-pin' } : { kind: 'not-pinned' };
}

const SPAN_FINDINGS: Readonly<Record<SpanCheck['kind'], Finding>> = {
  pass: { kind: 'agrees' },
  finding: { kind: 'pin-not-run' },
  unverifiable: { kind: 'no-answer' },
  'not-read': { kind: 'pinned-before-spans' },
};

function spanResults(entry: RegistryEntry, verdicts: readonly SpanCheck[] | undefined): Draft[] {
  const about = { kind: 'entry', entry } as const;
  if (entry.code === undefined) return [{ id: `${entry.name}/code`, line: 'code', about, source: undefined, link: undefined, finding: { kind: 'not-pinned' } }];
  const spans = [...entry.code.earlier, entry.code.current];
  return spans.map((_, i): Draft => {
    const verdict = verdicts?.[i];
    return { id: `${entry.name}/code.${i + 1}`, line: 'code', about, source: undefined, link: undefined, finding: verdict === undefined ? { kind: 'no-chain-result' } : SPAN_FINDINGS[verdict.kind] };
  });
}

function unvouchedUnlistedHasNoSecondSource(entry: RegistryEntry, drafts: readonly Draft[]): Result[] {
  const coin = drafts.some((draft) => draft.vouches === 'coin');
  const sourceSite = drafts.some((draft) => draft.vouches === 'source-site');
  const vouched = (result: Result) => coin || (sourceSite && result.id !== `${entry.name}/${LINE_KEYS.defillama}`);
  return drafts.map(({ vouches: _, ...result }) => (result.finding.kind === 'unlisted' && !vouched(result) ? { ...result, finding: { kind: 'no-second-source' } } : result));
}

function fixtureFinding(judgement: FixtureJudgement): Finding {
  const { outcome } = judgement;
  if (outcome.kind === 'card-refused') return { kind: 'judged-otherwise', why: 'card-refused', detail: outcome.why };
  const { mutations, perturbation } = outcome;
  if (mutations.kind === 'not-run') return { kind: 'judged-otherwise', why: 'fields', detail: `the fields give ${mutations.check.kind.toUpperCase()}` };
  if (mutations.kind === 'weak-template') return { kind: 'judged-otherwise', why: 'mutation-uncaught', detail: `${mutations.uncaught.length} bound fields changed and not caught` };
  if (perturbation.kind === 'not-run' && perturbation.cause === 'unverifiable') return { kind: 'no-answer' };
  if (perturbation.kind === 'not-run') return { kind: 'judged-otherwise', why: 'perturbation', detail: perturbation.reason };
  if (perturbation.kind === 'pass') return { kind: 'agrees' };
  if (perturbation.failed.every((run) => run.outcome === 'unverifiable')) return { kind: 'no-answer' };
  return { kind: 'judged-otherwise', why: 'perturbation', detail: `${perturbation.failed.length} changed free fields gave an outcome their claim forbids` };
}

/**
 * Every result of the report: for each entry `entriesOf` names, in registry order, its source results, documentation
 * pages, market parts, ABI proof and code pin spans, with the vouching rule applied; then each recorded transaction.
 */
export function judge(inputs: ReportInputs, fixtures: readonly FixtureJudgement[]): Ledger {
  const { subject } = inputs;
  const docs = subject.kind === 'template' ? subject.docs : [];
  const checked = checkSources(entriesOf(subject, inputs.registry), inputs.listings, inputs.pages);
  const results = checked.flatMap(({ entry, lines }) =>
    unvouchedUnlistedHasNoSecondSource(entry, [
      ...sourceResults(entry, lines),
      ...docs.filter((doc) => doc.contract.name === entry.name).flatMap((doc) => docResults(doc, inputs)),
      ...marketResults(entry, inputs),
      { id: `${entry.name}/abi`, line: 'abi', about: { kind: 'entry', entry }, source: undefined, link: undefined, finding: abiFinding(entry, inputs.abi.get(entry.address)) },
      ...spanResults(entry, inputs.spans.get(entry.address)),
    ]),
  );
  const judged = fixtures.map(
    (fixture): Result => ({ id: `fixture.${fixture.name}`, line: 'params', about: { kind: 'fixture', name: fixture.name }, source: undefined, link: undefined, finding: fixtureFinding(fixture) }),
  );
  return { entries: checked.map(({ entry }) => entry), results: [...results, ...judged] };
}

const RANK: Readonly<Record<State, number>> = { na: 0, ok: 1, warn: 2, bad: 3 };

/** The worst state among results; `na` when there are none. */
export const worst = (results: readonly Result[]): State => results.reduce<State>((acc, r) => (RANK[stateOf(r)] > RANK[acc] ? stateOf(r) : acc), 'na');

/** 待確認: the results for the signer, red first, then amber, each in ledger order. */
export const forSigner = (ledger: Ledger): Result[] => [...ledger.results.filter((r) => stateOf(r) === 'bad'), ...ledger.results.filter((r) => stateOf(r) === 'warn')];

const subjectOf = (result: Result): string => (result.about.kind === 'entry' ? result.about.entry.name : `fixture.${result.about.name}`);

export type StripItem = { readonly line: StripLine; readonly state: State; readonly passed: number; readonly counted: number };

/**
 * One item per strip line: the worst state of its results, and a tally over addresses (or recorded transactions): each
 * counts with the worst of its results on that line, `passed` the ok ones of `counted`, which leaves out those with
 * nothing to compare.
 */
export function strip(ledger: Ledger): StripItem[] {
  return STRIP_LINES.map((line) => {
    const results = ledger.results.filter((r) => r.line === line);
    const bySubject = new Map<string, Result[]>();
    for (const r of results) bySubject.set(subjectOf(r), [...(bySubject.get(subjectOf(r)) ?? []), r]);
    const states = [...bySubject.values()].map(worst).filter((state) => state !== 'na');
    return { line, state: worst(results), passed: states.filter((state) => state === 'ok').length, counted: states.length };
  });
}

const resultsOf = (ledger: Ledger, entry: RegistryEntry): Result[] => ledger.results.filter((r) => r.about.kind === 'entry' && r.about.entry.name === entry.name);

/** 地址: entries with a result for the signer open, in ledger order; the rest fold into one row. */
export function addressRows(ledger: Ledger): { readonly open: readonly RegistryEntry[]; readonly folded: readonly RegistryEntry[] } {
  const asks = (entry: RegistryEntry) => resultsOf(ledger, entry).some(needsSigner);
  return { open: ledger.entries.filter(asks), folded: ledger.entries.filter((entry) => !asks(entry)) };
}

export type Confidence = 'high' | 'medium' | 'low';

/**
 * From the entry's results alone: low when any is for the signer; high when none is, none has nothing to compare, and
 * both its source page and a code pin span passed; medium otherwise. An AI review never moves it.
 */
export function confidence(ledger: Ledger, entry: RegistryEntry): Confidence {
  const results = resultsOf(ledger, entry);
  if (results.some(needsSigner)) return 'low';
  const passed = (key: RegExp) => results.some((r) => stateOf(r) === 'ok' && key.test(r.id.slice(entry.name.length + 1)));
  return results.every((r) => stateOf(r) === 'ok') && passed(/^source\.page$/) && passed(/^code\.\d+$/) ? 'high' : 'medium';
}

export type SourceLine = {
  readonly source: ProgramSource;
  readonly state: State;
  /** Undefined when the source passed: the icon alone. */
  readonly phrase: Phrase | undefined;
  readonly link: HttpsUrl | undefined;
  readonly results: readonly Result[];
};

/** The entry's program sources in row order, each the worst of its results, worded by its worst result. */
export function sourcesOf(ledger: Ledger, entry: RegistryEntry): SourceLine[] {
  const results = resultsOf(ledger, entry);
  return PROGRAM_SOURCES.flatMap((source) => {
    const of = results.filter((r) => r.source === source);
    if (of.length === 0) return [];
    const state = worst(of);
    const shown = of.find((r) => stateOf(r) === state) as Result;
    return [{ source, state, phrase: state === 'ok' ? undefined : PHRASE_OF[shown.finding.kind], link: shown.link, results: of }];
  });
}
