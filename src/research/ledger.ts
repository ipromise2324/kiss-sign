import type { AbiProof, AbiRefusal } from '../contracts/prove.ts';
import { MARKET_ENTRY_PARTS, parseHttpsUrl } from '../registry.ts';
import type { HttpsUrl, RegistryEntry } from '../registry.ts';
import type { FixtureJudgement } from '../template/perturb.ts';
import { checkSources, githubLine } from './listings.ts';
import type { Line } from './listings.ts';
import { docSiteLine, entriesOf, functionOnPage, hasMarket, onlyDependedOn, pinVerdict, todayEntries } from './report.ts';
import type { DocLink, ReportInputs, SpanCheck, TodayCheck } from './report.ts';
import { isGitHubPage, pageUrlOf } from './source-page.ts';
import { factoryAnswer } from './vault-evidence.ts';

/** ok passed; warn evidence missing (amber); bad a real disagreement (red); na nothing to compare (grey). */
export type State = 'ok' | 'warn' | 'bad' | 'na';

/** The check strip's lines that hold results, in strip order. 雙節點比對 is a rule of the program with no results. */
export const STRIP_LINES = ['sources', 'abi', 'code', 'params'] as const;
export type StripLine = (typeof STRIP_LINES)[number];

/**
 * The sources an address row lists for the program: the `source` page, each of `moreSources` by its number from 1, the
 * protocol API, CoinGecko and a vault's registry factory. Each can confirm the address.
 */
export type ProgramSource = 'page' | `more.${number}` | 'api' | 'coingecko' | 'factory';

/**
 * Where an address row shows a result: under its source, either as whether the source showed the address, or as the
 * source's site compared with what DefiLlama lists. A site confirms no address: DefiLlama lists none.
 */
export type RowPart = { readonly of: ProgramSource; readonly part: 'address' | 'site' };

const sourceRank = (source: ProgramSource): number => {
  const more = /^more\.(\d+)$/.exec(source);
  return more !== null ? Number(more[1]) : { page: 0, api: 1e6, coingecko: 1e6 + 1, factory: 1e6 + 2 }[source as Exclude<ProgramSource, `more.${number}`>];
};

/** The words an address row's source line shows beside a result that did not pass. */
export type Phrase = '讀不到' | '是另一個地址' | '是另一個網站' | '沒資料可比' | '工廠說不是它建的';

/** Why a result has its state. The kind alone fixes the state (`STATE_OF`), so evidence missing can never read as red. */
export type Finding =
  | { readonly kind: 'agrees' }
  /** The source's or a documentation page's registrable domain or GitHub org is not the one DefiLlama lists. */
  | { readonly kind: 'site-differs' }
  /** CoinGecko lists another coin at this address, or more than one. */
  | { readonly kind: 'other-coin' }
  /** The protocol API answered another address, nothing or no address at the path, or anything but its JSON. */
  | { readonly kind: 'other-answer' }
  /** A code pin span the chain did not run from its block, or a current pin it does not run at the report's latest block. */
  | { readonly kind: 'pin-not-run' }
  /** The ABI proof proved code other than the current pin. */
  | { readonly kind: 'proof-not-pin' }
  /** The vault's registry factory answered that it did not create the vault. */
  | { readonly kind: 'not-created' }
  /** The vault's registry factory answered neither true nor false. */
  | { readonly kind: 'factory-other-answer' }
  | { readonly kind: 'refused'; readonly why: string }
  /** The address is confirmed in fewer than two places; `by` names those that did. */
  | { readonly kind: 'few-confirmations'; readonly by: readonly ProgramSource[] }
  /** A source page or the protocol API got no answer: no confirmation, and nothing for the signer. */
  | { readonly kind: 'source-no-answer' }
  /** A recorded transaction of the template the program now judges otherwise. */
  | { readonly kind: 'judged-otherwise'; readonly why: 'card-refused' | 'fields' | 'mutation-uncaught' | 'perturbation'; readonly detail: string }
  /** A read that got no answer: `UNVERIFIABLE`. */
  | { readonly kind: 'no-answer' }
  /** The source page as served does not show the address next to its label. */
  | { readonly kind: 'page-unread'; readonly why: 'not-served' | 'not-fetched' | 'not-by-label' | 'no-label' }
  | { readonly kind: 'url-holds-address' }
  /** The site could not be compared: no slug, a slug DefiLlama lists none or several of, no Public Suffix List, no org. */
  | { readonly kind: 'site-not-compared' }
  /** CoinGecko lists no coin at this address. */
  | { readonly kind: 'no-coin' }
  /** The entry names no CoinGecko coin, yet CoinGecko lists one at its address. */
  | { readonly kind: 'unexplained-coin' }
  /** Not pinned to a commit, the commit unknown, or not on the default branch. */
  | { readonly kind: 'commit-unconfirmed' }
  | { readonly kind: 'page-not-fetched' }
  | { readonly kind: 'name-not-on-page' }
  | { readonly kind: 'no-chain-result' }
  /** No stored `pnpm vault-evidence` output holds the vault's factory's answer. */
  | { readonly kind: 'factory-unread' }
  /** No code pin: signing would answer UNVERIFIABLE. */
  | { readonly kind: 'not-pinned' }
  /** DefiLlama lists no website or GitHub org to compare the site with, and another result vouches for the site. */
  | { readonly kind: 'unlisted' }
  /** DefiLlama lists no website or GitHub org to compare the site with, and no other result vouches for it. */
  | { readonly kind: 'no-second-source' }
  | { readonly kind: 'compiler-not-pinned'; readonly version: string }
  | { readonly kind: 'pinned-before-spans' }
  | { readonly kind: 'no-abi-case' }
  | { readonly kind: 'not-called' }
  /** A selector-routed proxy: its calls run in the implementations its routes reach, so no proof of one contract covers it. */
  | { readonly kind: 'routed-proxy' };
export type FindingKind = Finding['kind'];

export const STATE_OF: { readonly [K in FindingKind]: State } = {
  agrees: 'ok',
  'site-differs': 'bad',
  'other-coin': 'bad',
  'other-answer': 'bad',
  'pin-not-run': 'bad',
  'proof-not-pin': 'bad',
  'not-created': 'bad',
  'factory-other-answer': 'bad',
  refused: 'bad',
  'judged-otherwise': 'bad',
  'few-confirmations': 'warn',
  'source-no-answer': 'na',
  'no-answer': 'warn',
  'page-unread': 'na',
  'url-holds-address': 'na',
  'site-not-compared': 'warn',
  'no-coin': 'na',
  'unexplained-coin': 'warn',
  'commit-unconfirmed': 'warn',
  'page-not-fetched': 'warn',
  'name-not-on-page': 'warn',
  'no-chain-result': 'warn',
  'factory-unread': 'warn',
  'not-pinned': 'warn',
  unlisted: 'na',
  'no-second-source': 'warn',
  'compiler-not-pinned': 'warn',
  'pinned-before-spans': 'warn',
  'no-abi-case': 'warn',
  'not-called': 'na',
  'routed-proxy': 'na',
};

const PHRASE_OF: { readonly [K in FindingKind]: Phrase | undefined } = {
  agrees: undefined,
  'site-differs': '是另一個網站',
  'other-coin': '是另一個地址',
  'other-answer': '是另一個地址',
  'pin-not-run': undefined,
  'proof-not-pin': undefined,
  'not-created': '工廠說不是它建的',
  'factory-other-answer': '讀不到',
  refused: undefined,
  'judged-otherwise': undefined,
  'few-confirmations': undefined,
  'source-no-answer': '讀不到',
  'no-answer': '讀不到',
  'page-unread': '讀不到',
  'url-holds-address': '讀不到',
  'site-not-compared': '沒資料可比',
  'no-coin': '沒資料可比',
  'unexplained-coin': '沒資料可比',
  'commit-unconfirmed': '讀不到',
  'page-not-fetched': '讀不到',
  'name-not-on-page': '讀不到',
  'no-chain-result': undefined,
  'factory-unread': '讀不到',
  'not-pinned': undefined,
  unlisted: '沒資料可比',
  'no-second-source': '沒資料可比',
  'compiler-not-pinned': undefined,
  'pinned-before-spans': undefined,
  'no-abi-case': undefined,
  'not-called': undefined,
  'routed-proxy': undefined,
};

/** `<registry name>/<check key>`, such as `cbbtc/source.coingecko` or `morpho-blue/doc.0x095ea7b3.page`, or `fixture.<safe-tx fixture>`. */
export type ResultId = string;

export type Result = {
  readonly id: ResultId;
  readonly line: StripLine;
  readonly about: { readonly kind: 'entry'; readonly entry: RegistryEntry } | { readonly kind: 'fixture'; readonly name: string };
  /** Where the address row shows it; undefined for the address, documentation, market, ABI, code and fixture results. */
  readonly source: RowPart | undefined;
  /** What it links: the entry's page, its API, its CoinGecko coin, or for a site its DefiLlama protocol. */
  readonly link: HttpsUrl | undefined;
  readonly finding: Finding;
};

export type Ledger = { readonly entries: readonly RegistryEntry[]; readonly results: readonly Result[] };

export const stateOf = (result: Result): State => STATE_OF[result.finding.kind];

/** The one rule for 待確認, the rail count and the reviews notes.json must hold: red or amber. */
export const needsSigner = (result: Result): boolean => stateOf(result) === 'bad' || stateOf(result) === 'warn';

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
  defillama: 'page',
  'api-site': 'api',
};
const SITE_CHECKS: ReadonlySet<Line['check']> = new Set(['defillama', 'api-site']);

const coingeckoUrl = (id: string | undefined) => (id === undefined ? undefined : parseHttpsUrl(`https://www.coingecko.com/en/coins/${id}`));
const defillamaUrl = (slug: string | undefined) => (slug === undefined ? undefined : parseHttpsUrl(`https://defillama.com/protocol/${slug}`));

function linkOf(entry: RegistryEntry, { of, part }: RowPart): HttpsUrl | undefined {
  if (part === 'site') return defillamaUrl(entry.defillama);
  if (of.startsWith('more.')) return entry.moreSources?.[Number(of.slice(5)) - 1]?.url;
  if (of === 'page') return entry.source;
  if (of === 'api') return entry.apiSource?.url;
  return of === 'coingecko' ? coingeckoUrl(entry.coingecko) : undefined;
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
  if (line.kind === 'unverifiable') return line.check === 'page' || line.check === 'api' ? { kind: 'source-no-answer' } : { kind: 'no-answer' };
  switch (line.check) {
    case 'page':
      if (line.cause === 'not-served' || line.cause === 'not-fetched') return { kind: 'page-unread', why: line.cause };
      return { kind: 'page-unread', why: line.more === undefined && entry.sourceLabel === undefined ? 'no-label' : 'not-by-label' };
    case 'url':
      return { kind: 'url-holds-address' };
    case 'github':
      return { kind: 'commit-unconfirmed' };
    case 'api':
      return { kind: 'other-answer' };
    case 'coingecko':
      return line.cause === 'differs' ? { kind: 'other-coin' } : line.cause === 'unexplained' ? { kind: 'unexplained-coin' } : { kind: 'no-coin' };
    case 'defillama':
    case 'api-site':
      return siteFinding(line);
  }
}

const MORE_KEYS: Readonly<Partial<Record<Line['check'], string>>> = { page: 'page', github: 'commit', defillama: 'site' };

function sourceResults(entry: RegistryEntry, lines: readonly Line[]): Result[] {
  const about = { kind: 'entry', entry } as const;
  const order = (line: Line) => (line.more ?? 0) * LINE_ORDER.length + LINE_ORDER.indexOf(line.check);
  return [...lines]
    .sort((a, b) => order(a) - order(b))
    .map((line): Result => {
      const more = line.more === undefined ? undefined : (`more.${line.more}` as const);
      const source: RowPart = { of: more ?? LINE_SOURCE[line.check], part: SITE_CHECKS.has(line.check) ? 'site' : 'address' };
      const id = more === undefined ? LINE_KEYS[line.check] : `source.${more}.${MORE_KEYS[line.check]}`;
      return { id: `${entry.name}/${id}`, line: 'sources', about, source, link: linkOf(entry, source), finding: lineFinding(entry, line) };
    });
}

function docResults(doc: DocLink, inputs: ReportInputs): Result[] {
  const about = { kind: 'entry', entry: doc.contract } as const;
  const result = (check: string, finding: Finding): Result => ({ id: `${doc.contract.name}/doc.${doc.fn.selector}.${check}`, line: 'sources', about, source: undefined, link: undefined, finding });
  const page = inputs.pages.pages.get(pageUrlOf(doc.url));
  const pageFinding: Finding =
    page?.kind === 'unread'
      ? { kind: 'no-answer' }
      : page?.kind !== 'served'
        ? { kind: 'page-not-fetched' }
        : page.blocks.some((block) => functionOnPage(doc).test(block.text))
          ? { kind: 'agrees' }
          : { kind: 'name-not-on-page' };
  const site = siteFinding(docSiteLine(doc, inputs.listings));
  const results = [result('page', pageFinding), result('site', site)];
  const url = new URL(doc.url);
  if (isGitHubPage(url)) {
    const commit = githubLine(url, inputs.pages.commits);
    results.push(result('commit', commit.kind === 'agrees' ? { kind: 'agrees' } : commit.kind === 'unverifiable' ? { kind: 'no-answer' } : { kind: 'commit-unconfirmed' }));
  }
  return results;
}

function marketResults(entry: RegistryEntry, inputs: ReportInputs): Result[] {
  if (inputs.subject.kind !== 'template' || !hasMarket(inputs.subject.template)) return [];
  return [...inputs.registry.markets.values()].flatMap((market) =>
    MARKET_ENTRY_PARTS.filter((part) => market[part].name === entry.name).map(
      (part): Result => ({ id: `${entry.name}/market.${market.name}.${part}`, line: 'sources', about: { kind: 'entry', entry }, source: undefined, link: undefined, finding: { kind: 'agrees' } }),
    ),
  );
}

const FACTORY_FINDINGS: Readonly<Record<ReturnType<typeof factoryAnswer>, Finding>> = {
  admitted: { kind: 'agrees' },
  'not-created': { kind: 'not-created' },
  'other-answer': { kind: 'factory-other-answer' },
  unread: { kind: 'factory-unread' },
};

function factoryResults(entry: RegistryEntry, inputs: ReportInputs): Result[] {
  if (entry.kind !== 'vault' || entry.attributes.factory === undefined) return [];
  const finding = FACTORY_FINDINGS[factoryAnswer(inputs.vaults.get(entry.name), entry.attributes.factory)];
  return [{ id: `${entry.name}/factory.admitted`, line: 'sources', about: { kind: 'entry', entry }, source: { of: 'factory', part: 'address' }, link: undefined, finding }];
}

function abiFinding(entry: RegistryEntry, proof: AbiProof | AbiRefusal | undefined, depended: boolean): Finding {
  if (depended) return { kind: 'not-called' };
  if (entry.routes !== undefined) return { kind: 'routed-proxy' };
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

function spanResults(entry: RegistryEntry, verdicts: readonly SpanCheck[] | undefined): Result[] {
  const about = { kind: 'entry', entry } as const;
  if (entry.code === undefined) return [{ id: `${entry.name}/code`, line: 'code', about, source: undefined, link: undefined, finding: { kind: 'not-pinned' } }];
  const spans = [...entry.code.earlier, entry.code.current];
  return spans.map((_, i): Result => {
    const verdict = verdicts?.[i];
    return { id: `${entry.name}/code.${i + 1}`, line: 'code', about, source: undefined, link: undefined, finding: verdict === undefined ? { kind: 'no-chain-result' } : SPAN_FINDINGS[verdict.kind] };
  });
}

const TODAY_FINDINGS: Readonly<Record<TodayCheck['kind'], Finding>> = { pass: { kind: 'agrees' }, finding: { kind: 'pin-not-run' }, unverifiable: { kind: 'no-answer' } };

function todayResults(entry: RegistryEntry, inputs: ReportInputs, readToday: ReadonlySet<string>): Result[] {
  if (!readToday.has(entry.name) || entry.code === undefined) return [];
  const check = inputs.today?.checks.get(entry.address);
  return [{ id: `${entry.name}/code.today`, line: 'code', about: { kind: 'entry', entry }, source: undefined, link: undefined, finding: check === undefined ? { kind: 'no-chain-result' } : TODAY_FINDINGS[check.kind] }];
}

/**
 * A site DefiLlama lists nothing for stays for the signer unless something else ties the entry to the protocol:
 * CoinGecko listing the entry's coin at its address, or another official page's site that DefiLlama lists. Without
 * that, a lookalike vault the factory made and one page on a site no one vouches for would confirm the address. An
 * API's or a documentation page's site vouches for nothing: such a site answers for whatever it indexes or hosts.
 */
function unvouchedUnlistedHasNoSecondSource(entry: RegistryEntry, results: readonly Result[]): Result[] {
  const key = (r: Result) => r.id.slice(entry.name.length + 1);
  const coin = results.some((r) => key(r) === LINE_KEYS.coingecko && r.finding.kind === 'agrees');
  const pageSite = (r: Result) => /^source\.(more\.\d+\.)?site$/.test(key(r)) && r.finding.kind === 'agrees';
  const vouched = (result: Result) => coin || results.some((r) => r !== result && pageSite(r));
  return results.map((r) => (r.finding.kind === 'unlisted' && !vouched(r) ? { ...r, finding: { kind: 'no-second-source' } } : r));
}

/** The sources whose every result passed, each one place that showed the entry's address for its role; a site shows none. */
function confirmingSources(results: readonly Result[]): ProgramSource[] {
  const showing = results.filter((r) => r.source?.part === 'address');
  const sources = [...new Set(showing.map((r) => (r.source as RowPart).of))];
  return sources.filter((source) => showing.every((r) => r.source?.of !== source || STATE_OF[r.finding.kind] === 'ok')).sort((a, b) => sourceRank(a) - sourceRank(b));
}

export const MIN_CONFIRMATIONS = 2;

/** The entry's `<name>/address` result, first among its results: it passes when enough sources confirmed the address. */
function withAddressResult(entry: RegistryEntry, results: readonly Result[]): Result[] {
  const by = confirmingSources(results);
  const finding: Finding = by.length >= MIN_CONFIRMATIONS ? { kind: 'agrees' } : { kind: 'few-confirmations', by };
  return [{ id: `${entry.name}/address`, line: 'sources', about: { kind: 'entry', entry }, source: undefined, link: undefined, finding }, ...results];
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
 * Every result of the report: for each entry `entriesOf` names, in registry order, its source results, a vault's
 * factory answer, documentation pages, market parts, ABI proof, code pin spans and, for one no ABI proof compares with
 * the chain, its code at the latest block, with the vouching rule applied; then each recorded transaction.
 */
export function judge(inputs: ReportInputs, fixtures: readonly FixtureJudgement[]): Ledger {
  const { subject } = inputs;
  const docs = subject.kind === 'template' ? subject.docs : [];
  const checked = checkSources(entriesOf(subject, inputs.registry), inputs.listings, inputs.pages);
  const depended = onlyDependedOn(subject, inputs.registry);
  const today = new Set(todayEntries(subject, inputs.registry).map((entry) => entry.name));
  const results = checked.flatMap(({ entry, lines }) =>
    withAddressResult(entry, unvouchedUnlistedHasNoSecondSource(entry, [
      ...sourceResults(entry, lines),
      ...factoryResults(entry, inputs),
      ...docs.filter((doc) => doc.contract.name === entry.name).flatMap((doc) => docResults(doc, inputs)),
      ...marketResults(entry, inputs),
      { id: `${entry.name}/abi`, line: 'abi', about: { kind: 'entry', entry }, source: undefined, link: undefined, finding: abiFinding(entry, inputs.abi.get(entry.address), depended.has(entry.name)) },
      ...spanResults(entry, inputs.spans.get(entry.address)),
      ...todayResults(entry, inputs, today),
    ])),
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

/** The places that confirmed the entry's address, in row order. */
export const confirmations = (ledger: Ledger, entry: RegistryEntry): ProgramSource[] => confirmingSources(resultsOf(ledger, entry));

/**
 * From the entry's results alone: low when any is for the signer; high when none is, an official page is among the
 * address's confirmations, and a code pin span passed; medium otherwise. An AI review never moves it.
 */
export function confidence(ledger: Ledger, entry: RegistryEntry): Confidence {
  const results = resultsOf(ledger, entry);
  if (results.some(needsSigner)) return 'low';
  const page = confirmations(ledger, entry).some((source) => source === 'page' || source.startsWith('more.'));
  const pinned = results.some((r) => stateOf(r) === 'ok' && /^code\.\d+$/.test(r.id.slice(entry.name.length + 1)));
  return page && pinned ? 'high' : 'medium';
}

/** The worst of some results, worded by the worst one; a passing one has no phrase, only its icon. */
export type Judged = {
  readonly state: State;
  readonly phrase: Phrase | undefined;
  readonly link: HttpsUrl | undefined;
};

/** A program source: whether it showed the entry's address, and for a page or the API, whether its site is the protocol's. */
export type SourceLine = Judged & { readonly source: ProgramSource; readonly site: Judged | undefined };

function judged(results: readonly Result[]): Judged {
  const state = worst(results);
  const shown = results.find((r) => stateOf(r) === state) as Result;
  return { state, phrase: state === 'ok' ? undefined : PHRASE_OF[shown.finding.kind], link: shown.link };
}

/** The entry's program sources in row order, each judged by its address results, with its site judged apart. */
export function sourcesOf(ledger: Ledger, entry: RegistryEntry): SourceLine[] {
  const results = resultsOf(ledger, entry);
  const sources = [...new Set(results.flatMap((r) => (r.source === undefined ? [] : [r.source.of])))].sort((a, b) => sourceRank(a) - sourceRank(b));
  return sources.map((source) => {
    const of = (part: RowPart['part']) => results.filter((r) => r.source?.of === source && r.source.part === part);
    const site = of('site');
    if (of('address').length === 0) throw new Error(`${entry.name}: source ${source} has a site result but none for its address`);
    return { ...judged(of('address')), source, site: site.length === 0 ? undefined : judged(site) };
  });
}
