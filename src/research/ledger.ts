import type { AdapterCause, RefusalCause } from '../contracts/instance.ts';
import type { AbiProof, AbiRefusal } from '../contracts/prove.ts';
import { MARKET_ENTRY_PARTS, parseHttpsUrl } from '../registry.ts';
import type { HttpsUrl, RegistryEntry } from '../registry.ts';
import type { FixtureJudgement } from '../template/perturb.ts';
import { checkSources, githubLine } from './listings.ts';
import type { DeployerShare, Line, SitePlace } from './listings.ts';
import { abiUnused, docSiteLine, entriesOf, functionOnPage, hasMarket, pinVerdict, todayEntries } from './report.ts';
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
 * protocol API, CoinGecko and an entry's registry factory, for an adapter with each vault naming it. Each can confirm the address.
 */
export type ProgramSource = 'page' | `more.${number}` | 'api' | 'coingecko' | 'factory' | 'bounty' | 'sdk' | 'deployer';

/**
 * Where an address row shows a result: under its source, either as whether the source showed the address, or as the
 * source's site compared with what DefiLlama lists. A site confirms no address: DefiLlama lists none.
 */
export type RowPart = { readonly of: ProgramSource; readonly part: 'address' | 'site' };

const sourceRank = (source: ProgramSource): number => {
  const more = /^more\.(\d+)$/.exec(source);
  return more !== null ? Number(more[1]) : { page: 0, api: 1e6, coingecko: 1e6 + 1, factory: 1e6 + 2, bounty: 1e6 + 3, sdk: 1e6 + 4, deployer: 1e6 + 5 }[source as Exclude<ProgramSource, `more.${number}`>];
};

/** What an address row's source line, or a call's documentation line, says beside a result that did not pass; the page words it. */
export type Phrase =
  | 'unread'
  | 'other-address'
  | 'other-site'
  | 'nothing-to-compare'
  | 'not-created'
  | 'not-adapter'
  | 'not-on-page'
  | 'not-listed'
  | 'other-file'
  | 'no-provenance'
  | 'creation-unproven'
  | 'deployer-alone';

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
  /** The entry's registry factory answered that it did not create the entry. */
  | { readonly kind: 'not-created' }
  /** The entry's registry factory answered neither true nor false. */
  | { readonly kind: 'factory-other-answer' }
  /** A registry vault naming the adapter answered its factory's `adapterCheck` false for it. */
  | { readonly kind: 'not-adapter' }
  /** A registry vault naming the adapter answered its factory's `adapterCheck` neither true nor false. */
  | { readonly kind: 'adapter-other-answer' }
  | { readonly kind: 'refused'; readonly why: string }
  /** The address is confirmed in fewer than two places; `by` names those that did. */
  | { readonly kind: 'few-confirmations'; readonly by: readonly ProgramSource[] }
  /** A bounty program's scope, or an SDK file next to its label, does not hold the address: no confirmation. */
  | { readonly kind: 'not-listed' }
  /** The SDK tarball's hash is not the pinned one, or not the one npm gives. */
  | { readonly kind: 'package-differs' }
  /** npm holds no provenance for the SDK version, so nothing ties its publisher to the protocol. */
  | { readonly kind: 'no-provenance' }
  /** The program could not prove the entry's creation from its transaction. */
  | { readonly kind: 'creation-unproven' }
  /** The entry's deployer deployed no other entry of the protocol confirmed in two places without its own deployer. */
  | { readonly kind: 'deployer-alone' }
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
  /** No stored `pnpm vault-evidence` output or report recording holds the factory's answer, or the registry gives nothing to ask. */
  | { readonly kind: 'factory-unread' }
  /** No report recording holds a vault's answer for the adapter, or no registry vault whose factory has an `adapterCheck` names it. */
  | { readonly kind: 'adapter-unread' }
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
  'not-adapter': 'bad',
  'adapter-other-answer': 'bad',
  refused: 'bad',
  'judged-otherwise': 'bad',
  'few-confirmations': 'warn',
  'not-listed': 'na',
  'package-differs': 'bad',
  'no-provenance': 'na',
  'creation-unproven': 'na',
  'deployer-alone': 'na',
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
  'adapter-unread': 'warn',
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
  'site-differs': 'other-site',
  'other-coin': 'other-address',
  'other-answer': 'other-address',
  'pin-not-run': undefined,
  'proof-not-pin': undefined,
  'not-created': 'not-created',
  'factory-other-answer': 'unread',
  'not-adapter': 'not-adapter',
  'adapter-other-answer': 'unread',
  refused: undefined,
  'judged-otherwise': undefined,
  'few-confirmations': undefined,
  'not-listed': 'not-listed',
  'package-differs': 'other-file',
  'no-provenance': 'no-provenance',
  'creation-unproven': 'creation-unproven',
  'deployer-alone': 'deployer-alone',
  'source-no-answer': 'unread',
  'no-answer': 'unread',
  'page-unread': 'unread',
  'url-holds-address': 'unread',
  'site-not-compared': 'nothing-to-compare',
  'no-coin': 'nothing-to-compare',
  'unexplained-coin': 'nothing-to-compare',
  'commit-unconfirmed': 'unread',
  'page-not-fetched': 'unread',
  'name-not-on-page': 'not-on-page',
  'no-chain-result': undefined,
  'factory-unread': 'unread',
  'adapter-unread': 'unread',
  'not-pinned': undefined,
  unlisted: 'nothing-to-compare',
  'no-second-source': 'nothing-to-compare',
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
  /** For a site, the places that list it, or that were compared when none does. */
  readonly places?: readonly SitePlace[];
  /** For the deployer, who it is and which other entries share it. */
  readonly shared?: DeployerShare;
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
  bounty: 'source.bounty',
  sdk: 'source.sdk',
  'sdk-site': 'source.sdk.site',
  deployer: 'source.deployer',
};
const LINE_ORDER: readonly Line['check'][] = ['page', 'url', 'api', 'defillama', 'api-site', 'github', 'coingecko', 'bounty', 'sdk', 'sdk-site', 'deployer'];
const LINE_SOURCE: Readonly<Record<Line['check'], ProgramSource>> = {
  page: 'page',
  url: 'page',
  github: 'page',
  api: 'api',
  coingecko: 'coingecko',
  defillama: 'page',
  'api-site': 'api',
  bounty: 'bounty',
  sdk: 'sdk',
  'sdk-site': 'sdk',
  deployer: 'deployer',
};
const SITE_CHECKS: ReadonlySet<Line['check']> = new Set(['defillama', 'api-site', 'sdk-site']);

const coingeckoUrl = (id: string | undefined) => (id === undefined ? undefined : parseHttpsUrl(`https://www.coingecko.com/en/coins/${id}`));
const defillamaUrl = (slug: string | undefined) => (slug === undefined ? undefined : parseHttpsUrl(`https://defillama.com/protocol/${slug}`));

function linkOf(entry: RegistryEntry, { of, part }: RowPart, shared: DeployerShare | undefined): HttpsUrl | undefined {
  if (part === 'site') return defillamaUrl(entry.defillama);
  if (of.startsWith('more.')) return entry.moreSources?.[Number(of.slice(5)) - 1]?.url;
  if (of === 'page') return entry.source;
  if (of === 'api') return entry.apiSource?.url;
  if (of === 'bounty') return entry.immunefi === undefined ? undefined : parseHttpsUrl(`https://immunefi.com/bug-bounty/${entry.immunefi}/`);
  if (of === 'sdk') return entry.sdk === undefined ? undefined : parseHttpsUrl(`https://www.npmjs.com/package/${entry.sdk.package}/v/${entry.sdk.version}`);
  if (of === 'deployer') return shared === undefined ? undefined : parseHttpsUrl(`https://etherscan.io/address/${shared.deployer}`);
  return of === 'coingecko' ? coingeckoUrl(entry.coingecko) : undefined;
}

function siteFinding(line: Line): Finding {
  if (line.kind === 'agrees') return { kind: 'agrees' };
  if (line.kind === 'unverifiable') return { kind: 'no-answer' };
  if (line.cause === 'differs') return { kind: 'site-differs' };
  if (line.cause === 'unlisted') return { kind: 'unlisted' };
  if (line.cause === 'unattested') return { kind: 'no-provenance' };
  return { kind: 'site-not-compared' };
}

function lineFinding(entry: RegistryEntry, line: Line): Finding {
  if (line.kind === 'agrees') return { kind: 'agrees' };
  if (line.kind === 'unverifiable') return ['page', 'api', 'bounty', 'sdk', 'deployer'].includes(line.check) ? { kind: 'source-no-answer' } : { kind: 'no-answer' };
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
    case 'bounty':
      return line.cause === 'differs' ? { kind: 'site-differs' } : { kind: 'not-listed' };
    case 'sdk':
      return line.cause === 'differs' ? { kind: 'package-differs' } : line.cause === 'not-fetched' ? { kind: 'page-unread', why: 'not-fetched' } : { kind: 'not-listed' };
    case 'deployer':
      return line.cause === 'unlisted' ? { kind: 'deployer-alone' } : { kind: 'creation-unproven' };
    case 'defillama':
    case 'api-site':
    case 'sdk-site':
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
      return {
        id: `${entry.name}/${id}`,
        line: 'sources',
        about,
        source,
        link: linkOf(entry, source, line.shared),
        finding: lineFinding(entry, line),
        ...(line.places === undefined ? {} : { places: line.places }),
        ...(line.shared === undefined ? {} : { shared: line.shared }),
      };
    });
}

function docResults(doc: DocLink, inputs: ReportInputs): Result[] {
  const about = { kind: 'entry', entry: doc.contract } as const;
  const result = (check: string, finding: Finding, places?: readonly SitePlace[]): Result => ({
    id: `${doc.contract.name}/doc.${doc.fn.selector}.${check}`,
    line: 'sources',
    about,
    source: undefined,
    link: undefined,
    finding,
    ...(places === undefined ? {} : { places }),
  });
  const page = inputs.pages.pages.get(pageUrlOf(doc.url));
  const pageFinding: Finding =
    page?.kind === 'unread'
      ? { kind: 'no-answer' }
      : page?.kind !== 'served'
        ? { kind: 'page-not-fetched' }
        : page.blocks.some((block) => functionOnPage(doc).test(block.text))
          ? { kind: 'agrees' }
          : { kind: 'name-not-on-page' };
  const siteLine = docSiteLine(doc, inputs.listings);
  const results = [result('page', pageFinding), result('site', siteFinding(siteLine), siteLine.places)];
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

const REFUSAL_FINDINGS: Readonly<Record<RefusalCause, Finding>> = {
  'not-created': { kind: 'not-created' },
  'other-answer': { kind: 'factory-other-answer' },
  'no-answer': { kind: 'no-answer' },
  unaskable: { kind: 'factory-unread' },
};

const ADAPTER_FINDINGS: Readonly<Record<AdapterCause, Finding>> = {
  'not-used': { kind: 'not-adapter' },
  'other-answer': { kind: 'adapter-other-answer' },
  'no-answer': { kind: 'no-answer' },
  unaskable: { kind: 'adapter-unread' },
};

/**
 * The `factory` place: a vault's factory answer, stored by `pnpm vault-evidence`; another entry's, read by the report,
 * with, for an adapter, each registry vault naming it, since an `instanceCheck` answer does not say whose adapter it is.
 */
function factoryResults(entry: RegistryEntry, inputs: ReportInputs): Result[] {
  if (entry.attributes.factory === undefined) return [];
  const result = (key: string, finding: Finding): Result => ({ id: `${entry.name}/${key}`, line: 'sources', about: { kind: 'entry', entry }, source: { of: 'factory', part: 'address' }, link: undefined, finding });
  if (entry.kind === 'vault') return [result('factory.admitted', FACTORY_FINDINGS[factoryAnswer(inputs.vaults.get(entry.name), entry, inputs.registry)])];
  const answers = inputs.instances?.answers.get(entry.name);
  const admitted = result('factory.admitted', answers === undefined ? { kind: 'factory-unread' } : answers.factory.kind === 'created' ? { kind: 'agrees' } : REFUSAL_FINDINGS[answers.factory.cause]);
  if (entry.kind !== 'adapter') return [admitted];
  if (answers === undefined || answers.vaults.length === 0) return [admitted, result('vault.adapter', { kind: 'adapter-unread' })];
  return [admitted, ...answers.vaults.map((answer) => result(`vault.${answer.vault.name}.adapter`, answer.kind === 'uses' ? { kind: 'agrees' } : ADAPTER_FINDINGS[answer.cause]))];
}

function abiFinding(entry: RegistryEntry, proof: AbiProof | AbiRefusal | undefined, unused: boolean): Finding {
  if (unused) return { kind: 'not-called' };
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

/**
 * A shared deployer confirms the address only through another entry confirmed in two places without its own deployer,
 * so two entries never confirm each other by their deployer alone; it then names only those entries.
 */
function deployerCounts(result: Result, confirmedElsewhere: ReadonlySet<string>): Result {
  if (result.source?.of !== 'deployer' || result.finding.kind !== 'agrees' || result.shared === undefined) return result;
  const siblings = result.shared.siblings.filter((name) => confirmedElsewhere.has(name));
  return { ...result, shared: { ...result.shared, siblings }, ...(siblings.length === 0 ? { finding: { kind: 'deployer-alone' } } : {}) };
}

/**
 * The sources whose every result passed, each one place that showed the entry's address for its role; a site shows
 * none. An SDK counts only with its publisher too, since anyone can publish a package that names an address.
 */
function confirmingSources(results: readonly Result[]): ProgramSource[] {
  const showing = results.filter((r) => r.source?.part === 'address' || r.source?.of === 'sdk');
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
  const unused = abiUnused(subject, inputs.registry);
  const today = new Set(todayEntries(subject, inputs.registry).map((entry) => entry.name));
  const byEntry = checked.map(({ entry, lines }) => ({
    entry,
    results: unvouchedUnlistedHasNoSecondSource(entry, [
      ...sourceResults(entry, lines),
      ...factoryResults(entry, inputs),
      ...docs.filter((doc) => doc.contract.name === entry.name).flatMap((doc) => docResults(doc, inputs)),
      ...marketResults(entry, inputs),
      { id: `${entry.name}/abi`, line: 'abi', about: { kind: 'entry', entry }, source: undefined, link: undefined, finding: abiFinding(entry, inputs.abi.get(entry.address), unused.has(entry.name)) },
      ...spanResults(entry, inputs.spans.get(entry.address)),
      ...todayResults(entry, inputs, today),
    ]),
  }));
  const confirmedElsewhere = new Set(byEntry.filter(({ results }) => confirmingSources(results.filter((r) => r.source?.of !== 'deployer')).length >= MIN_CONFIRMATIONS).map(({ entry }) => entry.name));
  const results = byEntry.flatMap(({ entry, results: own }) => withAddressResult(entry, own.map((r) => deployerCounts(r, confirmedElsewhere))));
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
  readonly places: readonly SitePlace[];
};

/** A program source: whether it showed the entry's address, and for a page or the API, whether its site is the protocol's. */
export type SourceLine = Judged & { readonly source: ProgramSource; readonly site: Judged | undefined; readonly shared: DeployerShare | undefined };

function judged(results: readonly Result[]): Judged {
  const state = worst(results);
  const shown = results.find((r) => stateOf(r) === state) as Result;
  return { state, phrase: state === 'ok' ? undefined : PHRASE_OF[shown.finding.kind], link: shown.link, places: shown.places ?? [] };
}

/** The entry's program sources in row order, each judged by its address results, with its site judged apart. */
export function sourcesOf(ledger: Ledger, entry: RegistryEntry): SourceLine[] {
  const results = resultsOf(ledger, entry);
  const sources = [...new Set(results.flatMap((r) => (r.source === undefined ? [] : [r.source.of])))].sort((a, b) => sourceRank(a) - sourceRank(b));
  return sources.map((source) => {
    const of = (part: RowPart['part']) => results.filter((r) => r.source?.of === source && r.source.part === part);
    const site = of('site');
    if (of('address').length === 0) throw new Error(`${entry.name}: source ${source} has a site result but none for its address`);
    return { ...judged(of('address')), source, site: site.length === 0 ? undefined : judged(site), shared: of('address').find((r) => r.shared !== undefined)?.shared };
  });
}

/** A documentation page's results, the function on the page, its site and a GitHub page's commit, judged as one. */
export const docOf = (ledger: Ledger, doc: DocLink): Judged => judged(ledger.results.filter((r) => r.id.startsWith(`${doc.contract.name}/doc.${doc.fn.selector}.`)));
