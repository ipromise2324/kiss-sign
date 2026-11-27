import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { InstanceAnswers, InstanceUnasked, RefusalCause, ViewAnswer } from '../src/contracts/instance.ts';
import type { AbiProof, AbiRefusal } from '../src/contracts/prove.ts';
import { canonicalType, parseFunctionSignature } from '../src/decode/abi.ts';
import type { AbiFunction } from '../src/decode/abi.ts';
import { loadRegistry } from '../src/registry.ts';
import type { HttpsUrl, InstanceView, Registry, RegistryEntry } from '../src/registry.ts';
import type { ApiAnswer } from '../src/research/api-source.ts';
import { STATE_OF, addressRows, confidence, confirmations, flowResults, forSigner, judge, sourcesOf, stateOf, strip } from '../src/research/ledger.ts';
import type { FindingKind, Ledger, Place, State } from '../src/research/ledger.ts';
import type { FlowComparison } from '../src/research/trace.ts';
import type { CoinGeckoCoin, DefiLlamaProtocol, SiteOwner } from '../src/research/listings.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import type { Creation, Creations } from '../src/research/deployer.ts';
import type { PackageRead, PackageReads } from '../src/research/npm-package.ts';
import { NO_SITE_LISTINGS, parseImmunefiPrograms } from '../src/research/site-listings.ts';
import type { SiteListings } from '../src/research/site-listings.ts';
import { renderReport, replayInputs } from '../src/research/report.ts';
import { notesScope } from '../src/research/notes.ts';
import { buildPage } from '../src/research/report-page.ts';
import type { HtmlInputs } from '../src/research/report-page.ts';
import { renderPage } from '../src/research/report-html.ts';
import { pageText } from '../src/research/page-text.ts';
import { WEIGHT_OF, gradedFindings, weightOf } from '../src/research/grades.ts';
import type { ReportInputs, SpanCheck, TodayCheck } from '../src/research/report.ts';
import { pageUrlOf } from '../src/research/source-page.ts';
import { STANDARDS } from '../src/research/standards.ts';
import type { Standard } from '../src/research/standards.ts';
import type { CommitCheck, Page } from '../src/research/source-page.ts';
import { checksumAddress } from '../src/safe/types.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { judgeFixtures } from '../src/template/perturb.ts';
import type { FixtureJudgement, PerturbationReport, Run } from '../src/template/perturb.ts';
import { loadTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { reportCases, warmCompilers } from './solc-pool.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const suffixes = loadPublicSuffixList();
const ADDRESS = `0x${'ab'.repeat(20)}` as Address;
const OTHER = `0x${'cd'.repeat(20)}` as Address;
const PIN = `0x${'11'.repeat(32)}` as Hex;
const SOURCE = 'https://docs.example.org/addresses' as HttpsUrl;
const GITHUB = `https://github.com/example/repo/blob/${'a'.repeat(40)}/addresses.md` as HttpsUrl;
const API = { url: 'https://api.example.org/vault' as HttpsUrl, method: 'GET', path: ['address'] } as const;
const APPROVE = (loadTemplate(ROOT, 'morpho/market-supply', loadRegistry(ROOT)).calls[0]?.data as Exclude<Template['calls'][number]['data'], 'empty'>).fn;
const DOC = 'https://docs.example.org/approve' as HttpsUrl;
const APPROVE_ABI = [{ type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }] }];
const MORE = { url: GITHUB, label: 'Vault' };
const TIP = 'https://raw.githubusercontent.com/example/repo/refs/heads/main/addresses.md';
const ERC20 = STANDARDS.get('erc-20')!;
const DECLARED = { kind: 'served', blocks: [{ text: 'function approve(address _spender, uint256 _value) public returns (bool success)' }] } as const;

const ENTRY: RegistryEntry = {
  name: 'vault',
  address: ADDRESS,
  kind: 'token',
  source: SOURCE,
  sourceLabel: 'Vault',
  attributes: {},
  defillama: 'proto',
  coingecko: 'vault-coin',
  code: { earlier: [], current: { from: 100n, pin: { hash: PIN } } },
};

const VAULT: RegistryEntry = { ...ENTRY, kind: 'vault', attributes: { factory: 'vault-factory' } };
const INSTANCE = { kind: 'party', party: { kind: 'instance' } } as const;
const factoryOf = (...views: [InstanceView, ...InstanceView[]]): RegistryEntry => ({ ...ENTRY, name: 'vault-factory', address: `0x${'fa'.repeat(20)}` as Address, kind: 'factory', attributes: {}, instanceCheck: views });
const asksFactory = (signature: string): InstanceView => ({ ask: { kind: 'factory' }, fn: parseFunctionSignature(signature), args: [INSTANCE], answers: { kind: 'true' }, word: undefined });
const TRUE_FACTORY = factoryOf(asksFactory('isVault(address)'));
const evidence = (text: string) => ({ entry: VAULT, vaults: new Map([['vault', text]]), factory: TRUE_FACTORY });
const USDC: RegistryEntry = { ...ENTRY, name: 'usdc', address: `0x${'cc'.repeat(20)}` as Address, attributes: {} };
const COMPUTING_FACTORY = factoryOf({
  ask: { kind: 'factory' },
  fn: parseFunctionSignature('computeToken(address,string)'),
  args: [{ kind: 'party', party: { kind: 'attribute', attribute: 'asset' } }, { kind: 'string', value: 'fToken' }],
  answers: { kind: 'party', party: { kind: 'instance' } },
  word: undefined,
});
const ADMITTED = 'admitted     vault-factory answered isVault(address) = true at block 100\nvault        vault 0x';

const without = (key: 'sourceLabel' | 'code' | 'coingecko', entry: RegistryEntry = ENTRY): RegistryEntry => {
  const { [key]: _, ...rest } = entry;
  return rest;
};

type Setup = {
  readonly entry: RegistryEntry;
  readonly protocol: DefiLlamaProtocol | undefined;
  readonly coins: readonly CoinGeckoCoin[];
  readonly page: Page | undefined;
  /** What the entry's first `moreSources` page serves. */
  readonly more: Page | undefined;
  readonly commit: CommitCheck | undefined;
  /** What a pinned GitHub page's file serves at the tip of its default branch. */
  readonly tip: Page | undefined;
  readonly api: ApiAnswer | undefined;
  readonly doc: Page | undefined;
  readonly abi: AbiProof | AbiRefusal | undefined;
  readonly spans: readonly SpanCheck[] | undefined;
  readonly today: TodayCheck | undefined;
  readonly approveStandard: Standard | undefined;
  readonly docPublisher: SiteOwner | undefined;
  readonly fixtures: readonly FixtureJudgement[];
  readonly vaults: ReadonlyMap<string, string>;
  /** What the entry's factory, and for an adapter each vault naming it, answered; undefined when not read. */
  readonly instances: InstanceAnswers | InstanceUnasked | undefined;
  readonly reachedThrough: RegistryEntry | undefined;
  readonly factory: RegistryEntry | undefined;
  readonly sites: SiteListings;
  readonly packages: PackageReads;
  readonly creations: Creations | undefined;
  /** Another entry of the protocol the entry depends on, confirmed by its own page and coin when `confirmed`. */
  readonly sibling: { readonly confirmed: boolean } | undefined;
  /** More registry entries, such as a vault's asset. */
  readonly others: readonly RegistryEntry[];
  /** A view the template's `facts` read on the entry. */
  readonly read: AbiFunction | undefined;
};

const BASE: Setup = {
  entry: ENTRY,
  protocol: { slug: 'proto', name: 'Proto', url: new URL('https://example.org'), github: ['example'], gecko: undefined, parent: undefined },
  coins: [{ id: 'vault-coin', symbol: 'v', name: 'Vault', ethereum: ADDRESS }],
  page: { kind: 'served', blocks: [{ text: `Vault ${ADDRESS}` }] },
  more: { kind: 'served', blocks: [{ text: `Vault ${ADDRESS}` }] },
  commit: { kind: 'on-default', branch: 'main', status: 'behind' },
  tip: { kind: 'served', blocks: [{ text: `Vault ${ADDRESS}` }] },
  api: { kind: 'answered', json: { address: ADDRESS } },
  doc: { kind: 'served', blocks: [{ text: 'function approve(address spender, uint256 value)' }] },
  abi: { kind: 'proven', proxy: { kind: 'none' }, codeHash: PIN, abi: APPROVE_ABI } as unknown as AbiProof,
  spans: [{ kind: 'pass', text: '' }],
  today: undefined,
  approveStandard: undefined,
  docPublisher: undefined,
  fixtures: [],
  vaults: new Map(),
  instances: undefined,
  reachedThrough: undefined,
  factory: undefined,
  others: [],
  sites: NO_SITE_LISTINGS,
  packages: new Map(),
  creations: undefined,
  sibling: undefined,
  read: undefined,
};

const SIBLING: RegistryEntry = { ...ENTRY, name: 'sibling', address: OTHER, source: 'https://docs.example.org/sibling' as HttpsUrl, coingecko: 'sibling-coin' };
const SDK = { package: '@example/sdk', version: '1.0.0', sha256: PIN, file: 'dist/addresses.js', label: 'VAULT' };
const SDK_KEY = '@example/sdk@1.0.0';
const BUILT = { kind: 'built', repository: 'https://github.com/example/sdk', sameTarball: true } as const;
const packageRead = (change: Partial<Extract<PackageRead, { kind: 'read' }>> = {}): Partial<Setup> => ({
  entry: { ...ENTRY, sdk: SDK },
  packages: new Map([[SDK_KEY, { kind: 'read', version: '1.0.0', sha256: PIN, integrity: true, provenance: BUILT, file: { kind: 'served', blocks: [{ text: `VAULT = "${ADDRESS}"` }] }, ...change }]]),
});
const LATEST_KEY = '@example/sdk@latest';
const latestRead = (bound: Address): Partial<Setup> => {
  const pinned = packageRead().packages as PackageReads;
  const read: PackageRead = { kind: 'read', version: '1.1.0', sha256: PIN, integrity: true, provenance: BUILT, file: { kind: 'served', blocks: [{ text: `VAULT = "${bound}"` }] } };
  return { entry: { ...ENTRY, sdk: SDK }, packages: new Map([...pinned, [LATEST_KEY, read]]) };
};
const program = (addresses: readonly Address[], github?: string, website: string | null = 'https://example.org', scope: readonly string[] = []): SiteListings => ({
  ...NO_SITE_LISTINGS,
  programs: parseImmunefiPrograms([
    {
      slug: 'proto',
      websiteUrl: website,
      githubUrl: github ?? null,
      assets: scope.map((url) => ({ type: 'websites_and_applications', url })),
      assetsBodyV2: addresses.map((a) => `https://etherscan.io/address/${a}`).join('\n'),
    },
  ]),
});
const coinLinks = (homepages: readonly string[], github: readonly string[]): SiteListings => ({
  ...NO_SITE_LISTINGS,
  coins: new Map([['proto-coin', { kind: 'links', homepages: homepages.map((u) => new URL(u)), github: github.map((u) => new URL(u)) }]]),
});
const DEPLOYER = `0x${'de'.repeat(20)}` as Address;
const made = (sender: Address = DEPLOYER): Creation => ({ kind: 'proven', tx: PIN, block: 100n, sender, via: { kind: 'transaction' } });
const sharing = (confirmed: boolean): Partial<Setup> => ({
  entry: { ...ENTRY, dependsOn: ['sibling'] },
  sibling: { confirmed },
  creations: new Map([
    [ADDRESS, made()],
    [OTHER, made()],
  ]),
});

const DEPENDENT: RegistryEntry = { ...ENTRY, name: 'dependent', address: OTHER, kind: 'vault', dependsOn: ['vault'] };
const ADAPTED: RegistryEntry = { ...ENTRY, name: 'adapted', address: OTHER, kind: 'vault', attributes: { adapter: 'vault' } };
/** A contract a vault depends on that is no token, so the vault's report decodes nothing with its ABI. */
const LENDING: RegistryEntry = { ...ENTRY, kind: 'lending' };
const ROUTED: RegistryEntry = {
  ...ENTRY,
  routes: { implementationOf: parseFunctionSignature('getSigsImplementation(bytes4)'), selectorsOf: parseFunctionSignature('getImplementationSigs(address)'), seeds: ['0x00000001' as Hex] },
  code: { earlier: [], current: { from: 100n, pin: { hash: PIN, routes: [{ address: OTHER, hash: PIN, selectors: ['0x00000001' as Hex] }] } } },
};
const today = (kind: TodayCheck['kind']): Partial<Setup> => ({ today: { kind, text: '' } });

const ADAPTER: RegistryEntry = { ...ENTRY, kind: 'adapter', attributes: { factory: 'vault-factory' } };
const ADAPTER_FACTORY = factoryOf(
  asksFactory('isVaultAdapter(address)'),
  { ask: { kind: 'named-by', attribute: 'adapter' }, fn: parseFunctionSignature('isAdapter(address)'), args: [INSTANCE], answers: { kind: 'true' }, word: undefined },
  { ask: { kind: 'instance' }, fn: parseFunctionSignature('parentVault()'), args: [], answers: { kind: 'party', party: { kind: 'named-by', attribute: 'adapter' } }, word: undefined },
);
type Said = 'yes' | RefusalCause;
/** The adapter factory's three views answered: its own, then the vault naming the adapter (`ADAPTED`, or each of `namers`), then the adapter's parent. */
const adapterAsked = (factory: Said, vault: Said | readonly Said[] = 'yes', parent: Said = 'yes', namers: readonly RegistryEntry[] = [ADAPTED]): Partial<Setup> => {
  const view = (index: number, namer: RegistryEntry | undefined, said: Said): ViewAnswer => {
    const base = { view: ADAPTER_FACTORY.instanceCheck![index]!, index, asker: undefined, namer, asked: '' };
    return said === 'yes' ? { ...base, kind: 'vouched', answered: 'true', providers: ['alchemy', 'drpc'] } : { ...base, kind: 'refused', cause: said, why: '' };
  };
  const vaults = Array.isArray(vault) ? vault : namers.map(() => vault as Said);
  const answers = [
    view(0, undefined, factory),
    ...(namers.length === 0 ? [view(1, undefined, 'unaskable'), view(2, undefined, 'unaskable')] : [...namers.map((n, i) => view(1, n, vaults[i]!)), ...namers.map((n) => view(2, n, parent))]),
  ];
  return { entry: ADAPTER, factory: ADAPTER_FACTORY, instances: { kind: 'asked', entry: ADAPTER, factory: ADAPTER_FACTORY, block: { number: 200n, hash: PIN }, answers } };
};

const proven = (codeHash: Hex): AbiProof => ({ kind: 'proven', proxy: { kind: 'none' }, codeHash, abi: APPROVE_ABI }) as unknown as AbiProof;
const withAbi = (signatures: readonly string[]): AbiProof =>
  ({ ...proven(PIN), abi: signatures.map((text) => ({ type: 'function', name: parseFunctionSignature(text).name, inputs: parseFunctionSignature(text).params.map((p) => ({ name: p.name, type: canonicalType(p.type) })) })) }) as AbiProof;
const refused = (refusal: object): AbiRefusal => ({ kind: 'refused', refusal }) as unknown as AbiRefusal;
const judged = (mutations: object, perturbation: PerturbationReport): FixtureJudgement => ({
  name: 'safe-tx-1',
  outcome: { kind: 'judged', mutations: mutations as never, perturbation },
});
const MUTATIONS_PASS = { kind: 'pass', bound: 3, free: 1 };
const PERTURB_PASS: PerturbationReport = { kind: 'pass', runs: [] };
const failedRuns = (...outcomes: Run['outcome'][]): PerturbationReport => {
  const runs = outcomes.map((outcome) => ({ outcome, leaf: { rule: { kind: 'free', claim: 'scalar' } }, value: '1', detail: '' }) as unknown as Run);
  return { kind: 'fail', runs, failed: runs };
};

/**
 * A one-entry report: the entry, documented by one page for `approve`, as the template's only contract. With
 * `reachedThrough`, the report of that instance, the one vault its card accepts, which reaches the entry only through
 * the instance.
 */
function inputsOf(change: Partial<Setup>): ReportInputs {
  const s = { ...BASE, ...change };
  const all = [s.entry, ...(s.reachedThrough === undefined ? [] : [s.reachedThrough]), ...(s.factory === undefined ? [] : [s.factory]), ...(s.sibling === undefined ? [] : [SIBLING]), ...s.others];
  const siblingConfirmed = s.sibling?.confirmed === true;
  const registry: Registry = { attributes: new Map([['asset', 'token'], ['factory', 'factory'], ['adapter', 'adapter']]), entries: new Map(all.map((e) => [e.name, e])), byAddress: new Map(all.map((e) => [e.address, e])), markets: new Map() };
  const card = new Map(s.reachedThrough === undefined ? [] : [['vault', { kind: 'contract', scope: { registryKind: 'vault', protocol: undefined, marketPart: undefined } }]]);
  const template = { id: 'test/op', card, nonce: undefined, same: [], calls: [], effects: { gives: [], gets: [], views: [], safe: undefined, approves: [], touches: [] }, facts: s.read === undefined ? [] : [{ to: s.entry.name, fn: s.read, args: [], returns: [] } as never], instanceField: undefined } as Template;
  const inputs = {
    subject:
      s.reachedThrough !== undefined
        ? { kind: 'template', template, docs: [], vault: s.reachedThrough, dir: 'templates/test/op/instances/dependent' }
        : { kind: 'template', template, docs: [{ fn: APPROVE, contract: s.entry, publisher: s.docPublisher ?? s.entry, url: s.approveStandard?.page ?? DOC, standard: s.approveStandard }], dir: 'templates/test/op' },
    registry,
    listings: {
      protocols: new Map(s.protocol === undefined ? [] : [['proto', [s.protocol]]]),
      coinsByAddress: new Map([[ADDRESS, s.coins], ...(siblingConfirmed ? [[OTHER, [{ id: 'sibling-coin', symbol: 's', name: 'Sibling', ethereum: OTHER }]] as const] : [])]),
      suffixes,
      sites: s.sites,
    },
    pages: {
      pages: new Map([
        ...(s.page === undefined ? [] : [[pageUrlOf(s.entry.source), s.page] as const]),
        ...(s.more === undefined || s.entry.moreSources === undefined ? [] : [[pageUrlOf(s.entry.moreSources[0]!.url), s.more] as const]),
        ...(s.doc === undefined ? [] : [[pageUrlOf(s.approveStandard?.page ?? DOC), s.doc] as const]),
        ...(s.tip === undefined ? [] : [[TIP, s.tip] as const]),
        ...(siblingConfirmed ? [[pageUrlOf(SIBLING.source), { kind: 'served', blocks: [{ text: `Vault ${OTHER}` }] }] as const] : []),
      ]),
      commits: new Map(s.commit === undefined ? [] : [[`example/repo@${'a'.repeat(40)}`, s.commit], ['ethereum/ercs@ae65e89408f387ffb47d220879925c4ab384dfc2', s.commit]]),
      apis: new Map(s.api === undefined ? [] : [[`GET ${API.url}`, s.api]]),
      packages: s.packages,
      ...(s.creations === undefined ? {} : { creations: s.creations }),
    },
    abi: new Map(s.abi === undefined ? [] : [[ADDRESS, s.abi]]),
    spans: new Map(s.spans === undefined ? [] : [[ADDRESS, s.spans]]),
    today: s.today === undefined ? undefined : { block: { number: 200n, hash: PIN }, checks: new Map([[ADDRESS, s.today]]) },
    vaults: s.vaults,
    instances: s.instances === undefined ? undefined : { block: { number: 200n, hash: PIN }, answers: new Map([[s.entry.name, s.instances]]) },
    fixtures: s.fixtures,
    fetched: '2026-01-01',
    pastTxs: [],
    erc7730: { text: 'not read', reports: [] },
    facts: undefined,
  } as unknown as ReportInputs;
  return inputs;
}

/** Each place as its sources joined by `+`. */
const named = (places: readonly Place[]): string[] => places.map((place) => place.sources.join('+'));

const ledgerOf = (change: Partial<Setup>): Ledger => {
  const inputs = inputsOf(change);
  return judge(inputs, inputs.fixtures);
};

const resultOf = (ledger: Ledger, id: string) => ledger.results.find((r) => r.id === id) ?? assert.fail(`no result ${id}: ${ledger.results.map((r) => r.id).join(', ')}`);

/** `traced`, for a call traces' result, is the comparison of the flow lines with the traces, which `judge` does not read. */
type Row = { readonly what: string; readonly change: Partial<Setup>; readonly traced?: FlowComparison; readonly id: string; readonly kind: FindingKind; readonly state: State };

const UNCOVERED = { call: 2, from: 'morpho-blue', to: 'usdc', kind: 'transferFrom', pays: [], sides: {}, transactions: 1, others: [] } as const;

const ROWS: readonly Row[] = [
  { what: 'a flow line every traced transaction shows', change: {}, traced: { lines: [{ seen: 2, of: 2, fields: [] }], uncovered: [] }, id: 'flow.1', kind: 'agrees', state: 'ok' },
  { what: 'a flow line no traced transaction shows', change: {}, traced: { lines: [{ seen: 0, of: 2, fields: [] }], uncovered: [] }, id: 'flow.1', kind: 'line-not-every', state: 'bad' },
  { what: 'a flow line only some traced transactions show', change: {}, traced: { lines: [{ seen: 1, of: 2, fields: [] }], uncovered: [] }, id: 'flow.1', kind: 'line-not-every', state: 'bad' },
  { what: 'a flow line no traced transaction tested with one of the tokens its card field can name', change: {}, traced: { lines: [{ seen: 2, of: 2, fields: [{ field: 'sell-token', tokens: [{ name: 'usdc', seen: 2, of: 2 }, { name: 'usdt', seen: 0, of: 0 }] }] }], uncovered: [] }, id: 'flow.1', kind: 'line-token-untested', state: 'na' },
  { what: 'a money call in a trace no line covers', change: {}, traced: { lines: [], uncovered: [UNCOVERED] }, id: 'trace.2.morpho-blue.usdc.transferFrom', kind: 'money-uncovered', state: 'warn' },
  { what: 'the address next to its label', change: {}, id: 'vault/source.page', kind: 'agrees', state: 'ok' },
  { what: 'a source domain DefiLlama lists another site for', change: { protocol: { ...BASE.protocol!, url: new URL('https://other.org') } }, id: 'vault/source.site', kind: 'site-differs', state: 'bad' },
  { what: 'a GitHub org DefiLlama does not name', change: { entry: { ...ENTRY, source: GITHUB }, protocol: { ...BASE.protocol!, github: ['someone'] } }, id: 'vault/source.site', kind: 'site-differs', state: 'bad' },
  { what: 'another coin at the address', change: { coins: [{ id: 'other-coin', symbol: 'o', name: 'Other', ethereum: ADDRESS }] }, id: 'vault/source.coingecko', kind: 'other-coin', state: 'bad' },
  { what: 'an API answering another address', change: { entry: { ...ENTRY, apiSource: API }, api: { kind: 'answered', json: { address: OTHER } } }, id: 'vault/source.api', kind: 'other-answer', state: 'bad' },
  { what: 'an API answering nothing at its path', change: { entry: { ...ENTRY, apiSource: API }, api: { kind: 'answered', json: {} } }, id: 'vault/source.api', kind: 'other-answer', state: 'bad' },
  { what: 'an API answering a 404', change: { entry: { ...ENTRY, apiSource: API }, api: { kind: 'failed', why: 'HTTP 404' } }, id: 'vault/source.api', kind: 'other-answer', state: 'bad' },
  { what: 'an API with no answer', change: { entry: { ...ENTRY, apiSource: API }, api: { kind: 'unread', why: 'timeout' } }, id: 'vault/source.api', kind: 'source-no-answer', state: 'na' },
  { what: 'an address its page and CoinGecko confirm', change: {}, id: 'vault/address', kind: 'agrees', state: 'ok' },
  { what: 'an address only its page confirms', change: { coins: [] }, id: 'vault/address', kind: 'few-confirmations', state: 'warn' },
  { what: 'a second page showing the address by its label', change: { entry: { ...ENTRY, moreSources: [MORE] } }, id: 'vault/source.more.1.page', kind: 'agrees', state: 'ok' },
  { what: 'a second page without the address', change: { entry: { ...ENTRY, moreSources: [MORE] }, more: { kind: 'served', blocks: [{ text: 'Vault' }] } }, id: 'vault/source.more.1.page', kind: 'page-unread', state: 'na' },
  { what: 'a second page whose commit is off the default branch', change: { entry: { ...ENTRY, moreSources: [MORE] }, commit: { kind: 'off-default', branch: 'main', status: 'diverged' } }, id: 'vault/source.more.1.commit', kind: 'commit-unconfirmed', state: 'warn' },
  { what: "a second page's GitHub org DefiLlama does not name", change: { entry: { ...ENTRY, moreSources: [MORE] }, protocol: { ...BASE.protocol!, github: ['someone'] } }, id: 'vault/source.more.1.site', kind: 'site-differs', state: 'bad' },
  { what: 'a code pin the chain did not run', change: { spans: [{ kind: 'finding', text: '' }] }, id: 'vault/code.1', kind: 'pin-not-run', state: 'bad' },
  { what: 'a proof of code other than the pin', change: { abi: proven(`0x${'22'.repeat(32)}` as Hex) }, id: 'vault/abi', kind: 'proof-not-pin', state: 'bad' },
  { what: "a view the template reads that the proof's ABI lacks", change: { read: APPROVE, abi: withAbi(['transfer(address to,uint256 value)']) }, id: 'vault/abi', kind: 'fn-not-in-abi', state: 'bad' },
  { what: "a view the template reads that the proof's ABI holds", change: { read: APPROVE, abi: withAbi(['approve(address spender,uint256 value)']) }, id: 'vault/abi', kind: 'agrees', state: 'ok' },
  { what: 'a proof that masked the metadata hash', change: { abi: { ...proven(PIN), metadataHashMasked: true } }, id: 'vault/abi', kind: 'metadata-differs', state: 'na' },
  { what: 'a proof that masked the metadata hash still proves every other byte', change: { abi: { ...proven(PIN), metadataHashMasked: true } }, id: 'vault/abi.proof', kind: 'agrees', state: 'ok' },
  { what: 'a proof refused for a reason other than its compiler', change: { abi: refused({ why: 'bytecode-mismatch' }) }, id: 'vault/abi', kind: 'refused', state: 'bad' },
  { what: 'a vault its factory created', change: evidence(ADMITTED), id: 'vault/factory.admitted', kind: 'agrees', state: 'ok' },
  { what: 'a vault its factory answered it did not create', change: evidence("REFUSED vault-factory answered isVault(address) false for vault: it did not create it; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'not-created', state: 'bad' },
  { what: 'a vault whose factory answered neither true nor false', change: evidence("REFUSED vault-factory answered isVault(address) with a revert, not true or false; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'factory-other-answer', state: 'bad' },
  { what: 'a vault whose address its factory computed', change: { ...evidence(`admitted     vault-factory answered computeToken(usdc,"fToken") = ${checksumAddress(ADDRESS)} at block 100\nvault        vault 0x`), entry: { ...VAULT, attributes: { factory: 'vault-factory', asset: 'usdc' } }, factory: COMPUTING_FACTORY, others: [USDC] }, id: 'vault/factory.admitted', kind: 'agrees', state: 'ok' },
  { what: 'a vault its factory computed another address for', change: evidence("REFUSED vault-factory answered computeToken(usdc,\"fToken\") = 0x5C20B550819128074FD538Edf79791733ccEdd18, not vault: its official contract is another; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'not-created', state: 'bad' },
  { what: 'a vault whose factory computed no address', change: evidence("REFUSED vault-factory answered computeToken(usdc,\"fToken\") with a revert, not an address; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'factory-other-answer', state: 'bad' },
  { what: "a vault lacking an attribute its factory's check binds", change: evidence("REFUSED vault has no asset attribute, which vault-factory's instanceCheck computeToken(address,string) binds; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: 'a vault another factory admitted', change: evidence(ADMITTED.replace('vault-factory', 'other-factory')), id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: "a vault whose factory's answer got no reply", change: evidence("REFUSED the providers disagree; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: 'a vault whose block was not read', change: evidence('UNVERIFIABLE no block'), id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: 'a vault with no stored evidence', change: { entry: VAULT }, id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: 'an adapter its factory created', change: adapterAsked('yes'), id: 'vault/factory.admitted', kind: 'agrees', state: 'ok' },
  { what: 'an adapter the vault naming it uses', change: adapterAsked('yes'), id: 'vault/factory.1.isAdapter.adapted', kind: 'agrees', state: 'ok' },
  { what: 'an adapter its factory answered it did not create', change: adapterAsked('denied'), id: 'vault/factory.admitted', kind: 'not-created', state: 'bad' },
  { what: "an adapter whose factory's answer got no reply", change: adapterAsked('no-answer'), id: 'vault/factory.admitted', kind: 'no-answer', state: 'warn' },
  { what: 'an adapter the vault naming it answered false for', change: adapterAsked('yes', 'denied'), id: 'vault/factory.1.isAdapter.adapted', kind: 'check-denied', state: 'bad' },
  { what: 'an adapter the vault naming it answered neither true nor false for', change: adapterAsked('yes', 'other-answer'), id: 'vault/factory.1.isAdapter.adapted', kind: 'check-other-answer', state: 'bad' },
  { what: 'an adapter no registry vault names', change: adapterAsked('yes', [], 'yes', []), id: 'vault/factory.1.isAdapter', kind: 'check-unread', state: 'warn' },
  { what: 'an adapter made for the vault naming it', change: adapterAsked('yes'), id: 'vault/factory.2.parentVault.adapted', kind: 'agrees', state: 'ok' },
  { what: 'an adapter made for another vault', change: adapterAsked('yes', 'yes', 'denied'), id: 'vault/factory.2.parentVault.adapted', kind: 'check-denied', state: 'bad' },
  { what: 'an adapter that answered no address for its parent', change: adapterAsked('yes', 'yes', 'other-answer'), id: 'vault/factory.2.parentVault.adapted', kind: 'check-other-answer', state: 'bad' },
  { what: 'an adapter whose factory has no instanceCheck to ask', change: { entry: ADAPTER, factory: TRUE_FACTORY, instances: { kind: 'unasked', why: 'vault-factory has no instanceCheck' } }, id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: 'an adapter in a recording that predates the answers', change: { entry: ADAPTER }, id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: 'a card the template now refuses', change: { fixtures: [{ name: 'safe-tx-1', outcome: { kind: 'card-refused', why: 'wrong-kind' } }] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'fields that no longer match', change: { fixtures: [judged({ kind: 'not-run', check: { kind: 'mismatch' } }, PERTURB_PASS)] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'fields the template or registry leaves UNVERIFIABLE', change: { fixtures: [judged({ kind: 'not-run', check: { kind: 'unverifiable', reasons: ['the registry has no usdc'] } }, PERTURB_PASS)] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'a bound field changed and not caught', change: { fixtures: [judged({ kind: 'weak-template', bound: 3, free: 1, uncaught: [{}] }, PERTURB_PASS)] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'a perturbation its claim forbids', change: { fixtures: [judged(MUTATIONS_PASS, failedRuns('changed', 'unverifiable'))] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'a perturbation whose transaction no longer executes', change: { fixtures: [judged(MUTATIONS_PASS, { kind: 'not-run', cause: 'not-executed', reason: 'reverted' })] }, id: 'fixture.safe-tx-1', kind: 'judged-otherwise', state: 'bad' },
  { what: 'a perturbation whose transaction as recorded got no answer', change: { fixtures: [judged(MUTATIONS_PASS, { kind: 'not-run', cause: 'unverifiable', reason: 'providers disagree' })] }, id: 'fixture.safe-tx-1', kind: 'no-answer', state: 'warn' },
  { what: 'perturbations failed only for want of an answer', change: { fixtures: [judged(MUTATIONS_PASS, failedRuns('unverifiable'))] }, id: 'fixture.safe-tx-1', kind: 'no-answer', state: 'warn' },
  { what: 'a recorded transaction judged as before', change: { fixtures: [judged(MUTATIONS_PASS, PERTURB_PASS)] }, id: 'fixture.safe-tx-1', kind: 'agrees', state: 'ok' },
  { what: 'a source page with no answer', change: { page: { kind: 'unread', why: 'timeout' } }, id: 'vault/source.page', kind: 'source-no-answer', state: 'na' },
  { what: 'a page served without the address', change: { page: { kind: 'served', blocks: [{ text: 'Vault' }] } }, id: 'vault/source.page', kind: 'page-unread', state: 'na' },
  { what: 'a page with the address away from its label, the label next to no address', change: { page: { kind: 'served', blocks: [{ text: 'Vault overview' }, { text: ADDRESS }] } }, id: 'vault/source.page', kind: 'page-unread', state: 'na' },
  { what: 'a page with the address, its label next to another address', change: { page: { kind: 'served', blocks: [{ text: `Vault ${OTHER}` }, { text: `Router ${ADDRESS}` }] } }, id: 'vault/source.page', kind: 'label-differs', state: 'bad' },
  { what: 'a page without the address, its label next to another address', change: { page: { kind: 'served', blocks: [{ text: `Vault ${OTHER}` }] } }, id: 'vault/source.page', kind: 'label-differs', state: 'bad' },
  { what: 'a second page whose label binds another address', change: { entry: { ...ENTRY, moreSources: [MORE] }, more: { kind: 'served', blocks: [{ text: `Vault ${OTHER}` }] } }, id: 'vault/source.more.1.page', kind: 'label-differs', state: 'bad' },
  { what: 'a page that answered a 404', change: { page: { kind: 'failed', why: 'HTTP 404' } }, id: 'vault/source.page', kind: 'page-unread', state: 'na' },
  { what: 'an entry with no label', change: { entry: without('sourceLabel') }, id: 'vault/source.page', kind: 'page-unread', state: 'na' },
  { what: 'a source URL holding the address', change: { entry: { ...ENTRY, source: `${SOURCE}/${ADDRESS}` as HttpsUrl } }, id: 'vault/source.url', kind: 'url-holds-address', state: 'na' },
  { what: 'a slug DefiLlama does not list', change: { protocol: undefined }, id: 'vault/source.site', kind: 'site-not-compared', state: 'warn' },
  { what: 'no coin at the address', change: { coins: [] }, id: 'vault/source.coingecko', kind: 'no-coin', state: 'na' },
  { what: 'a commit off the default branch', change: { entry: { ...ENTRY, source: GITHUB }, commit: { kind: 'off-default', branch: 'main', status: 'diverged' } }, id: 'vault/source.commit', kind: 'commit-unconfirmed', state: 'warn' },
  { what: 'a documentation page not fetched', change: { doc: undefined }, id: 'vault/doc.0x095ea7b3.page', kind: 'page-not-fetched', state: 'warn' },
  { what: 'a documentation page without the name', change: { doc: { kind: 'served', blocks: [{ text: 'transfer' }] } }, id: 'vault/doc.0x095ea7b3.page', kind: 'name-not-on-page', state: 'warn' },
  { what: 'a documentation page naming the function', change: {}, id: 'vault/doc.0x095ea7b3.page', kind: 'agrees', state: 'ok' },
  { what: "a documentation page of a contract a factory deploys, on the factory's protocol's site though the contract names its curator's", change: { entry: { ...ENTRY, defillama: 'curator' }, docPublisher: { defillama: 'proto' } }, id: 'vault/doc.0x095ea7b3.site', kind: 'agrees', state: 'ok' },
  { what: 'a documentation page with the name only in prose', change: { doc: { kind: 'served', blocks: [{ text: 'You approve these terms by using the Site' }] } }, id: 'vault/doc.0x095ea7b3.page', kind: 'name-not-on-page', state: 'warn' },
  { what: 'a documentation page with the name before a numbered clause', change: { doc: { kind: 'served', blocks: [{ text: 'You approve (i) these Terms' }] } }, id: 'vault/doc.0x095ea7b3.page', kind: 'name-not-on-page', state: 'warn' },
  { what: 'a documentation page with the name as a Markdown heading', change: { doc: { kind: 'served', blocks: [{ text: '### approve' }] } }, id: 'vault/doc.0x095ea7b3.page', kind: 'agrees', state: 'ok' },
  { what: 'a documentation page with the name in a code span', change: { doc: { kind: 'served', blocks: [{ text: 'Call `approve` first' }] } }, id: 'vault/doc.0x095ea7b3.page', kind: 'agrees', state: 'ok' },
  { what: 'a documentation page with the name as a heading', change: { doc: { kind: 'served', blocks: [{ text: 'approve' }] } }, id: 'vault/doc.0x095ea7b3.page', kind: 'agrees', state: 'ok' },
  { what: 'a standard page holding the declaration', change: { approveStandard: ERC20, doc: DECLARED }, id: 'vault/doc.0x095ea7b3.page', kind: 'agrees', state: 'ok' },
  { what: 'a standard page calling the function without its declaration', change: { approveStandard: ERC20 }, id: 'vault/doc.0x095ea7b3.page', kind: 'name-not-on-page', state: 'warn' },
  { what: "a standard page, whose site is the standard's org whatever DefiLlama lists", change: { approveStandard: ERC20, doc: DECLARED, protocol: { ...BASE.protocol!, github: ['tether'] } }, id: 'vault/doc.0x095ea7b3.site', kind: 'agrees', state: 'ok' },
  { what: "a standard page's commit off the default branch", change: { approveStandard: ERC20, doc: DECLARED, commit: { kind: 'off-default', branch: 'master', status: 'diverged' } }, id: 'vault/doc.0x095ea7b3.commit', kind: 'commit-unconfirmed', state: 'warn' },
  { what: 'a span with no chain result', change: { spans: undefined }, id: 'vault/code.1', kind: 'no-chain-result', state: 'warn' },
  { what: 'a span with no answer', change: { spans: [{ kind: 'unverifiable', text: '' }] }, id: 'vault/code.1', kind: 'no-answer', state: 'warn' },
  { what: 'no ABI case', change: { abi: undefined }, id: 'vault/abi', kind: 'no-abi-case', state: 'warn' },
  { what: 'an entry with no code pin', change: { entry: without('code'), abi: undefined }, id: 'vault/code', kind: 'not-pinned', state: 'warn' },
  { what: 'a proof of an entry with no pin', change: { entry: without('code') }, id: 'vault/abi', kind: 'not-pinned', state: 'warn' },
  { what: 'no site listed, and CoinGecko vouches', change: { protocol: { ...BASE.protocol!, url: undefined } }, id: 'vault/source.site', kind: 'unlisted', state: 'na' },
  { what: 'no site listed and no coin to vouch', change: { protocol: { ...BASE.protocol!, url: undefined }, coins: [] }, id: 'vault/source.site', kind: 'no-second-source', state: 'warn' },
  { what: 'a coin at the address the entry names no id for', change: { entry: without('coingecko') }, id: 'vault/source.coingecko', kind: 'unexplained-coin', state: 'warn' },
  { what: 'a compiler not pinned', change: { abi: refused({ why: 'compiler-not-pinned', version: '0.8.99' }) }, id: 'vault/abi', kind: 'compiler-not-pinned', state: 'warn' },
  { what: 'a pin recorded before spans', change: { spans: [{ kind: 'not-read', text: '' }] }, id: 'vault/code.1', kind: 'pinned-before-spans', state: 'warn' },
  { what: 'an entry reached only through dependsOn, with no ABI case', change: { reachedThrough: DEPENDENT, entry: LENDING, abi: undefined }, id: 'vault/abi', kind: 'not-called', state: 'na' },
  { what: 'an entry reached only through dependsOn that runs its pin at the latest block', change: { reachedThrough: DEPENDENT, entry: LENDING, ...today('pass') }, id: 'vault/code.today', kind: 'agrees', state: 'ok' },
  { what: 'an entry reached only through dependsOn that runs other code at the latest block', change: { reachedThrough: DEPENDENT, entry: LENDING, ...today('finding') }, id: 'vault/code.today', kind: 'pin-not-run', state: 'bad' },
  { what: "an entry reached only through dependsOn whose code at the latest block got no answer", change: { reachedThrough: DEPENDENT, entry: LENDING, ...today('unverifiable') }, id: 'vault/code.today', kind: 'no-answer', state: 'warn' },
  { what: 'an entry reached only through dependsOn with no read at the latest block', change: { reachedThrough: DEPENDENT, entry: LENDING }, id: 'vault/code.today', kind: 'no-chain-result', state: 'warn' },
  { what: "a vault's adapter, whose address only goes into an argument, with its proof refused", change: { reachedThrough: ADAPTED, entry: { ...ENTRY, kind: 'adapter' }, abi: refused({ why: 'not-on-etherscan' }) }, id: 'vault/abi', kind: 'not-called', state: 'na' },
  { what: 'a selector-routed proxy a call targets', change: { entry: ROUTED }, id: 'vault/abi', kind: 'routed-proxy', state: 'na' },
  { what: 'a selector-routed proxy that runs its pin and routes at the latest block', change: { entry: ROUTED, ...today('pass') }, id: 'vault/code.today', kind: 'agrees', state: 'ok' },
  { what: 'a bounty program with the address in scope', change: { entry: { ...ENTRY, immunefi: 'proto' }, sites: program([ADDRESS]) }, id: 'vault/source.bounty', kind: 'agrees', state: 'ok' },
  { what: 'a bounty program without the address in scope', change: { entry: { ...ENTRY, immunefi: 'proto' }, sites: program([OTHER]) }, id: 'vault/source.bounty', kind: 'not-listed', state: 'na' },
  { what: "a bounty program that lists none of the protocol's sites", change: { entry: { ...ENTRY, immunefi: 'proto' }, sites: program([ADDRESS], 'https://github.com/other', 'https://other.org') }, id: 'vault/source.bounty', kind: 'site-differs', state: 'bad' },
  { what: 'a bounty program Immunefi does not list', change: { entry: { ...ENTRY, immunefi: 'proto' } }, id: 'vault/source.bounty', kind: 'no-such-program', state: 'na' },
  { what: "a bounty program named for a protocol whose sites are not known", change: { entry: { ...ENTRY, immunefi: 'proto' }, protocol: undefined, sites: program([ADDRESS]) }, id: 'vault/source.bounty', kind: 'bounty-not-tied', state: 'na' },
  { what: 'an SDK file with the address next to its label', change: packageRead(), id: 'vault/source.sdk', kind: 'agrees', state: 'ok' },
  { what: "an SDK built from the protocol's GitHub org", change: packageRead(), id: 'vault/source.sdk.site', kind: 'agrees', state: 'ok' },
  { what: 'an SDK file with the address, but not by its label', change: packageRead({ file: { kind: 'served', blocks: [{ text: `OTHER = "${ADDRESS}"` }] } }), id: 'vault/source.sdk', kind: 'page-unread', state: 'na' },
  { what: 'an SDK file without the address, its label next to no address', change: packageRead({ file: { kind: 'served', blocks: [{ text: `OTHER = "${OTHER}"` }] } }), id: 'vault/source.sdk', kind: 'not-listed', state: 'na' },
  { what: 'an SDK file whose label binds only another address', change: packageRead({ file: { kind: 'served', blocks: [{ text: `VAULT = "${OTHER}"` }, { text: `OTHER = "${ADDRESS}"` }] } }), id: 'vault/source.sdk', kind: 'label-differs', state: 'bad' },
  { what: 'an SDK tarball that is not the pinned one', change: packageRead({ sha256: `0x${'22'.repeat(32)}` as Hex }), id: 'vault/source.sdk', kind: 'package-differs', state: 'bad' },
  { what: "an SDK whose npm provenance names another tarball", change: packageRead({ provenance: { ...BUILT, sameTarball: false } }), id: 'vault/source.sdk.site', kind: 'provenance-other-tarball', state: 'bad' },
  { what: 'an SDK version npm holds no provenance for', change: packageRead({ provenance: { kind: 'none' } }), id: 'vault/source.sdk.site', kind: 'no-provenance', state: 'na' },
  { what: 'an SDK built from another GitHub org', change: packageRead({ provenance: { ...BUILT, repository: 'https://github.com/someone/sdk' } }), id: 'vault/source.sdk.site', kind: 'site-differs', state: 'bad' },
  { what: 'a creation the program cannot prove', change: { creations: new Map([[ADDRESS, { kind: 'unproven', why: 'a CREATE2 from a factory' }]]) }, id: 'vault/source.deployer', kind: 'creation-unproven', state: 'na' },
  { what: 'a creation read with no answer', change: { creations: new Map([[ADDRESS, { kind: 'unread', why: 'timeout' }]]) }, id: 'vault/source.deployer', kind: 'source-no-answer', state: 'na' },
  { what: 'a deployer shared with an entry confirmed elsewhere', change: sharing(true), id: 'vault/source.deployer', kind: 'agrees', state: 'ok' },
  { what: 'a deployer shared only with an entry confirmed nowhere else', change: sharing(false), id: 'vault/source.deployer', kind: 'deployer-alone', state: 'na' },
  { what: 'a website only the protocol coin on CoinGecko lists', change: { protocol: { ...BASE.protocol!, url: undefined, gecko: 'proto-coin' }, sites: coinLinks(['https://example.org'], []) }, id: 'vault/source.site', kind: 'agrees', state: 'ok' },
  { what: 'a GitHub org only the Immunefi program names', change: { entry: { ...ENTRY, source: GITHUB, immunefi: 'proto' }, protocol: { ...BASE.protocol!, github: [] }, sites: program([], 'https://github.com/example') }, id: 'vault/source.site', kind: 'agrees', state: 'ok' },
  { what: "a GitHub org GitHub verified controls the protocol's website", change: { entry: { ...ENTRY, source: GITHUB }, protocol: { ...BASE.protocol!, github: [] }, sites: { ...NO_SITE_LISTINGS, orgs: new Map([['example', { kind: 'domains', domains: ['example.org'] }]]) } }, id: 'vault/source.site', kind: 'agrees', state: 'ok' },
  { what: 'a GitHub org GitHub verified controls another website', change: { entry: { ...ENTRY, source: GITHUB }, protocol: { ...BASE.protocol!, github: [] }, sites: { ...NO_SITE_LISTINGS, orgs: new Map([['example', { kind: 'domains', domains: ['other.org'] }]]) } }, id: 'vault/source.site', kind: 'unlisted', state: 'na' },
  { what: "a GitHub org other than the one the coin's repositories are on, with none DefiLlama names", change: { entry: { ...ENTRY, source: GITHUB }, protocol: { ...BASE.protocol!, github: [], gecko: 'proto-coin' }, sites: coinLinks([], ['https://github.com/someone/token']) }, id: 'vault/source.site', kind: 'unlisted', state: 'na' },
  { what: 'an Immunefi program the entry does not name, tied to the protocol by its website, with the address in scope', change: { sites: program([ADDRESS]) }, id: 'vault/source.bounty', kind: 'agrees', state: 'ok' },
  { what: 'an Immunefi program not tied to the protocol with the address in scope', change: { sites: program([ADDRESS], undefined, 'https://other.org') }, id: 'vault/source.bounty', kind: 'not-listed', state: 'na' },
  { what: 'a pinned GitHub page whose file at the tip of its branch binds the label to the address too', change: { entry: { ...ENTRY, source: GITHUB } }, id: 'vault/source.tip', kind: 'agrees', state: 'ok' },
  { what: 'a pinned GitHub page whose file at the tip of its branch binds the label to another address', change: { entry: { ...ENTRY, source: GITHUB }, tip: { kind: 'served', blocks: [{ text: `Vault ${OTHER}` }] } }, id: 'vault/source.tip', kind: 'newer-differs', state: 'bad' },
  { what: 'a pinned GitHub page whose file is gone at the tip of its branch', change: { entry: { ...ENTRY, source: GITHUB }, tip: { kind: 'failed', why: 'HTTP 404' } }, id: 'vault/source.tip', kind: 'not-listed', state: 'na' },
  { what: "an SDK whose npm latest version binds the label to another address", change: latestRead(OTHER), id: 'vault/source.sdk.latest', kind: 'newer-differs', state: 'bad' },
];

for (const row of ROWS) {
  test(`${row.what}: ${row.id} is ${row.kind}, ${row.state}`, () => {
    const result = resultOf(row.traced === undefined ? ledgerOf(row.change) : { entries: [], results: flowResults(row.traced) }, row.id);
    assert.equal(result.finding.kind, row.kind);
    assert.equal(stateOf(result), row.state);
  });
}

test('a proof of code other than the pin still says which functions the template uses are missing from its ABI', () => {
  const other = { ...withAbi(['transfer(address to,uint256 value)']), codeHash: `0x${'22'.repeat(32)}` as Hex };
  const unpinned = withAbi(['transfer(address to,uint256 value)']);
  for (const [change, first] of [
    [{ read: APPROVE, abi: other }, 'proof-not-pin'],
    [{ read: APPROVE, abi: unpinned, entry: without('code') }, 'not-pinned'],
  ] as const) {
    const abi = ledgerOf(change).results.filter((r) => r.line === 'abi');
    assert.deepEqual(abi.map((r) => [r.id, r.finding.kind, stateOf(r)]), [
      ['vault/abi', first, first === 'proof-not-pin' ? 'bad' : 'warn'],
      ['vault/abi.calls', 'fn-not-in-abi', 'bad'],
    ]);
  }
  assert.deepEqual(ledgerOf({ read: APPROVE, abi: proven(`0x${'22'.repeat(32)}` as Hex) }).results.filter((r) => r.line === 'abi').map((r) => r.id), ['vault/abi']);
});

test('two entries that share a deployer and are confirmed nowhere else never confirm each other through it', () => {
  const ledger = ledgerOf({ ...sharing(false), coins: [] });
  assert.equal(resultOf(ledger, 'vault/address').finding.kind, 'few-confirmations');
  assert.equal(resultOf(ledger, 'sibling/address').finding.kind, 'few-confirmations');
  const confirmed = ledgerOf({ ...sharing(true), coins: [] });
  assert.deepEqual(named(confirmations(confirmed, ENTRY)), ['page', 'deployer']);
  assert.deepEqual(resultOf(confirmed, 'vault/source.deployer').shared, { deployer: DEPLOYER, siblings: ['sibling'] });
});

test('an SDK whose publisher nothing ties to the protocol confirms nothing, though its file shows the address', () => {
  const ledger = ledgerOf({ ...packageRead({ provenance: { kind: 'none' } }), coins: [] });
  assert.equal(resultOf(ledger, 'vault/source.sdk').finding.kind, 'agrees');
  assert.deepEqual(named(confirmations(ledger, { ...ENTRY, sdk: SDK })), ['page']);
  assert.equal(resultOf(ledger, 'vault/address').finding.kind, 'few-confirmations');
  assert.deepEqual(named(confirmations(ledgerOf({ ...packageRead(), coins: [] }), { ...ENTRY, sdk: SDK })), ['page', 'sdk']);
});

test('a bounty program is tied through a website its scope lists, and never through a shared host such as linktr.ee', () => {
  assert.deepEqual(named(confirmations(ledgerOf({ sites: program([ADDRESS], undefined, null, ['https://app.example.org/']), coins: [] }), ENTRY)), ['page', 'bounty']);
  const shared = ledgerOf({
    protocol: { ...BASE.protocol!, url: new URL('https://linktr.ee/proto'), github: [] },
    sites: program([ADDRESS], undefined, 'https://linktr.ee/other', ['https://github.com/other']),
    coins: [],
  });
  assert.equal(resultOf(shared, 'vault/source.bounty').finding.kind, 'not-listed');
  assert.ok(!named(confirmations(shared, ENTRY)).includes('bounty'), 'a program on the same shared host confirms nothing');
});

test('every finding kind has a row', () => {
  assert.deepEqual(new Set(ROWS.map((row) => row.kind)), new Set(Object.keys(STATE_OF)));
});

test('only an entry no ABI proof compares with the chain has a result for its code at the latest block', () => {
  assert.ok(!ledgerOf(today('pass')).results.some((r) => r.id.endsWith('/code.today')));
  assert.ok(!ledgerOf({ reachedThrough: DEPENDENT, entry: without('code', LENDING), ...today('pass') }).results.some((r) => r.id.endsWith('/code.today')), 'an entry with no pin has only its not-pinned result');
});

test('only an entry that names a factory has a factory result', () => {
  const ids = (entry: RegistryEntry) => ledgerOf({ entry, vaults: new Map([['vault', ADMITTED]]), factory: TRUE_FACTORY }).results.map((r) => r.id);
  assert.ok(ids(VAULT).includes('vault/factory.admitted'));
  assert.ok(ids(ADAPTER).includes('vault/factory.admitted'));
  assert.ok(!ids({ ...ADAPTER, kind: 'router', attributes: {} }).some((id) => id.endsWith('/factory.admitted')));
  assert.ok(!ids({ ...VAULT, attributes: {} }).some((id) => id.endsWith('/factory.admitted')));
  assert.ok(!ids(ENTRY).some((id) => id.endsWith('/factory.admitted')));
});

test('the address needs two confirmations: a page by its label, the API, CoinGecko, or the factory; never a site or a page whose URL holds it', () => {
  const by = (change: Partial<Setup>) => {
    const ledger = ledgerOf(change);
    const entry = change.entry ?? ENTRY;
    return [named(confirmations(ledger, entry)), resultOf(ledger, `${entry.name}/address`).finding.kind];
  };
  assert.deepEqual(by({}), [['page', 'coingecko'], 'agrees']);
  assert.deepEqual(by({ entry: { ...ENTRY, moreSources: [MORE], apiSource: API } }), [['page+api', 'more.1', 'coingecko'], 'agrees']);
  assert.deepEqual(by({ entry: { ...ENTRY, moreSources: [MORE] }, commit: { kind: 'off-default', branch: 'main', status: 'diverged' }, coins: [] }), [['page'], 'few-confirmations']);
  const echoing = { ...VAULT, source: `${SOURCE}/${ADDRESS}` as HttpsUrl };
  assert.deepEqual(by({ entry: echoing, vaults: new Map([['vault', ADMITTED]]), factory: TRUE_FACTORY, coins: [] }), [['factory'], 'few-confirmations']);
  assert.deepEqual(by({ entry: echoing, vaults: new Map([['vault', ADMITTED]]), factory: TRUE_FACTORY }), [['coingecko', 'factory'], 'agrees']);
  assert.deepEqual(by({ protocol: { ...BASE.protocol!, url: undefined }, coins: [] }), [['page'], 'few-confirmations']);
});

test('a page and the API on one registrable domain are one place, and CoinGecko listing the coin a second', () => {
  const entry = { ...ENTRY, apiSource: API };
  const alone = ledgerOf({ entry, coins: [] });
  assert.deepEqual(named(confirmations(alone, entry)), ['page+api'], 'docs.example.org and api.example.org');
  assert.deepEqual(resultOf(alone, 'vault/address').finding, { kind: 'few-confirmations', by: [{ owner: 'example.org', sources: ['page', 'api'] }], needs: 2 });
  const listed = ledgerOf({ entry });
  assert.deepEqual(named(confirmations(listed, entry)), ['page+api', 'coingecko']);
  assert.equal(resultOf(listed, 'vault/address').finding.kind, 'agrees');
});

test('a source page whose URL holds the address says so, not that it could not be read', () => {
  const echoing = { ...VAULT, source: `${SOURCE}/${ADDRESS}` as HttpsUrl };
  const line = sourcesOf(ledgerOf({ entry: echoing, vaults: new Map([['vault', ADMITTED]]), factory: TRUE_FACTORY }), echoing).find((l) => l.source === 'page');
  assert.deepEqual([line?.state, line?.phrase], ['na', 'url-holds-address']);
});

test('the Markdown findings name each place that confirmed an address too few times, by its sources and owner', () => {
  assert.ok(findingsOf(markdownOf({ entry: { ...ENTRY, apiSource: API }, coins: [] })).includes('vault/address key: address confirmed in 1 place, `page` + `api` (example.org); it needs 2'));
  const echoing = { ...VAULT, source: `${SOURCE}/${ADDRESS}` as HttpsUrl };
  assert.ok(findingsOf(markdownOf({ entry: echoing, vaults: new Map([['vault', ADMITTED]]), factory: TRUE_FACTORY, coins: [] })).includes('vault/address key: address confirmed in 1 place, `factory`; it needs 2'));
});

test('pages of one GitHub organization are one place, and it stays apart from a domain GitHub verified it controls', () => {
  const second = { url: `https://github.com/example/repo/blob/${'a'.repeat(40)}/other.md` as HttpsUrl, label: 'Vault' };
  const entry = { ...ENTRY, source: GITHUB, moreSources: [second] };
  const ledger = ledgerOf({ entry, coins: [] });
  assert.deepEqual(resultOf(ledger, 'vault/address').finding, { kind: 'few-confirmations', by: [{ owner: 'github.com/example', sources: ['page', 'more.1'] }], needs: 2 });
  const verified = { ...NO_SITE_LISTINGS, orgs: new Map([['example', { kind: 'domains', domains: ['example.org'] } as const]]) };
  const both = { ...ENTRY, moreSources: [MORE] };
  const apart = ledgerOf({ entry: both, coins: [], sites: verified });
  assert.deepEqual(named(confirmations(apart, both)), ['page', 'more.1'], 'docs.example.org and github.com/example');
  assert.equal(resultOf(apart, 'vault/address').finding.kind, 'agrees');
});

test("an SDK is the same place as the GitHub organization npm's provenance names as its publisher", () => {
  const entry = { ...ENTRY, moreSources: [MORE], sdk: SDK };
  const ledger = ledgerOf({ ...packageRead(), entry, coins: [] });
  assert.deepEqual(named(confirmations(ledger, entry)), ['page', 'more.1+sdk']);
  assert.deepEqual(resultOf(ledger, 'vault/address').finding.kind, 'agrees');
  const page = { ...ENTRY, source: GITHUB, sdk: SDK };
  assert.deepEqual(resultOf(ledgerOf({ ...packageRead(), entry: page, coins: [] }), 'vault/address').finding, { kind: 'few-confirmations', by: [{ owner: 'github.com/example', sources: ['page', 'sdk'] }], needs: 2 });
});

test('the newest version of a pinned page or SDK never counts as a place, and never keeps the pinned one from counting', () => {
  const github = { ...ENTRY, source: GITHUB };
  const differing = ledgerOf({ entry: github, tip: { kind: 'served', blocks: [{ text: `Vault ${OTHER}` }] } });
  assert.deepEqual(named(confirmations(differing, github)), ['page', 'coingecko']);
  assert.deepEqual(forSigner(differing).map((r) => r.id), ['vault/source.tip']);
  const newest = sourcesOf(differing, github).find((line) => line.source === 'page')?.newest;
  assert.deepEqual([newest?.state, newest?.phrase, newest?.others], ['bad', 'other-address', [OTHER]], 'the row names the other address');
  assert.deepEqual(named(confirmations(ledgerOf({ entry: github, tip: { kind: 'failed', why: 'HTTP 404' } }), github)), ['page', 'coingecko']);
  assert.deepEqual(named(confirmations(ledgerOf({ ...latestRead(ADDRESS), coins: [] }), { ...ENTRY, sdk: SDK })), ['page', 'sdk']);
  assert.deepEqual(named(confirmations(ledgerOf({ ...latestRead(OTHER), coins: [] }), { ...ENTRY, sdk: SDK })), ['page', 'sdk']);
  assert.deepEqual(named(confirmations(ledgerOf({ sites: program([ADDRESS], undefined, 'https://other.org'), coins: [] }), ENTRY)), ['page'], 'a program not tied to the protocol confirms nothing');
  assert.deepEqual(named(confirmations(ledgerOf({ sites: program([ADDRESS]), coins: [] }), ENTRY)), ['page', 'bounty']);
});

test("an adapter's factory, the vault naming it and the adapter's own answer are one place, counted only when every answer passes", () => {
  const by = (change: Partial<Setup>) => {
    const ledger = ledgerOf({ coins: [], ...change });
    return [named(confirmations(ledger, ADAPTER)), resultOf(ledger, 'vault/address').finding.kind];
  };
  const second = { ...ADAPTED, name: 'second' };
  assert.deepEqual(by(adapterAsked('yes')), [['page', 'factory'], 'agrees']);
  assert.deepEqual(by(adapterAsked('yes', 'yes', 'yes', [ADAPTED, second])), [['page', 'factory'], 'agrees'], 'two vaults naming it are still one place');
  assert.deepEqual(by(adapterAsked('yes', ['yes', 'denied'], 'yes', [ADAPTED, second])), [['page'], 'few-confirmations']);
  assert.deepEqual(by(adapterAsked('yes', [], 'yes', [])), [['page'], 'few-confirmations'], 'the factory alone does not say whose adapter it is');
  assert.deepEqual(by(adapterAsked('yes', 'yes', 'denied')), [['page'], 'few-confirmations'], "another vault's official adapter is no confirmation");
  assert.deepEqual(by(adapterAsked('denied')), [['page'], 'few-confirmations'], 'the vault alone does not say it is an official adapter');
  assert.deepEqual(by({ entry: ADAPTER }), [['page'], 'few-confirmations']);
});

test('an empty address source is grey; the address result alone puts the entry in 待確認', () => {
  const ledger = ledgerOf({ entry: { ...ENTRY, apiSource: API }, page: { kind: 'served', blocks: [{ text: 'Vault' }] } });
  assert.equal(stateOf(resultOf(ledger, 'vault/source.page')), 'na');
  assert.deepEqual(forSigner(ledger), []);
  assert.equal(confidence(ledger, ENTRY), 'medium', 'no official page among the confirmations');
  assert.deepEqual(
    sourcesOf(ledger, ENTRY).map((s) => [s.source, s.state, s.phrase, s.link, s.site === undefined ? undefined : { state: s.site.state, phrase: s.site.phrase, link: s.site.link, places: s.site.places }]),
    [
      ['page', 'na', 'unread', SOURCE, { state: 'ok', phrase: undefined, link: 'https://defillama.com/protocol/proto', places: [{ kind: 'defillama', id: 'proto' }] }],
      ['api', 'ok', undefined, API.url, { state: 'ok', phrase: undefined, link: 'https://defillama.com/protocol/proto', places: [{ kind: 'defillama', id: 'proto' }] }],
      ['coingecko', 'ok', undefined, 'https://www.coingecko.com/en/coins/vault-coin', undefined],
      ['bounty', 'na', 'not-listed', undefined, undefined],
    ],
  );
  const alone = ledgerOf({ page: { kind: 'served', blocks: [{ text: 'Vault' }] } });
  assert.deepEqual(forSigner(alone).map((r) => [r.id, r.finding]), [['vault/address', { kind: 'few-confirmations', by: [{ owner: 'coingecko.com', sources: ['coingecko'] }], needs: 2 }]]);
});

test('a site DefiLlama lists nothing for is vouched by CoinGecko or by another official page, never by a documentation page or the API site', () => {
  const github = { entry: { ...ENTRY, source: GITHUB, apiSource: API }, protocol: { ...BASE.protocol!, github: [] } } as const;
  const unvouched = ledgerOf({ ...github, coins: [] });
  assert.equal(resultOf(unvouched, 'vault/doc.0x095ea7b3.site').finding.kind, 'agrees');
  assert.equal(resultOf(unvouched, 'vault/source.api.site').finding.kind, 'agrees');
  assert.ok(forSigner(unvouched).some((r) => r.id === 'vault/source.site' && r.finding.kind === 'no-second-source'));
  assert.ok(!forSigner(ledgerOf(github)).some((r) => r.id === 'vault/source.site'), 'CoinGecko lists the coin at the address');
  const second = ledgerOf({ ...github, entry: { ...ENTRY, source: GITHUB, moreSources: [{ url: SOURCE, label: 'Vault' }] }, coins: [] });
  assert.equal(resultOf(second, 'vault/source.more.1.site').finding.kind, 'agrees');
  assert.ok(!forSigner(second).some((r) => r.id === 'vault/source.site'), "the second page's site is the protocol's website");
});

test('a lookalike vault the factory made, on one page of a site no one vouches for, has two confirmations and still stays for the signer', () => {
  const ledger = ledgerOf({ entry: VAULT, vaults: new Map([['vault', ADMITTED]]), factory: TRUE_FACTORY, protocol: { ...BASE.protocol!, url: undefined }, coins: [] });
  assert.equal(resultOf(ledger, 'vault/address').finding.kind, 'agrees');
  assert.deepEqual(forSigner(ledger).map((r) => [r.id, r.finding.kind]), [
    ['vault/source.site', 'no-second-source'],
    ['vault/doc.0x095ea7b3.site', 'no-second-source'],
  ]);
});

test('a coin CoinGecko lists at an address the entry names no coin for stays for the signer and confirms nothing', () => {
  const entry = without('coingecko');
  const ledger = ledgerOf({ entry });
  assert.deepEqual(forSigner(ledger).map((r) => [r.id, r.finding.kind]), [
    ['vault/address', 'few-confirmations'],
    ['vault/source.coingecko', 'unexplained-coin'],
  ]);
  assert.deepEqual(named(confirmations(ledger, entry)), ['page']);
});

test('a second page is its own row, each page with its own site under it, and no site is a source of its own', () => {
  const entry = { ...ENTRY, moreSources: [MORE] };
  const other = { ...BASE.protocol!, url: new URL('https://other.org') };
  assert.deepEqual(
    sourcesOf(ledgerOf({ entry, protocol: other }), entry).map((s) => [s.source, s.state, s.link, s.site?.state, s.site?.phrase]),
    [
      ['page', 'ok', SOURCE, 'bad', 'other-site'],
      ['more.1', 'ok', GITHUB, 'ok', undefined],
      ['coingecko', 'ok', 'https://www.coingecko.com/en/coins/vault-coin', undefined, undefined],
      ['bounty', 'na', undefined, undefined, undefined],
    ],
  );
});

test('an address source line names another address, and the site under it a differing site or nothing to compare', () => {
  const line = (change: Partial<Setup>, source: string) => sourcesOf(ledgerOf(change), change.entry ?? ENTRY).find((s) => s.source === source);
  assert.equal(line({ protocol: { ...BASE.protocol!, url: new URL('https://other.org') } }, 'page')?.site?.phrase, 'other-site');
  assert.equal(line({ protocol: { ...BASE.protocol!, url: new URL('https://other.org') } }, 'page')?.phrase, undefined, 'the page still showed the address');
  assert.equal(line({ entry: { ...ENTRY, apiSource: API }, api: { kind: 'answered', json: { address: OTHER } } }, 'api')?.phrase, 'other-address');
  assert.equal(line({ protocol: { ...BASE.protocol!, url: undefined } }, 'page')?.site?.phrase, 'nothing-to-compare');
  const api = line({ entry: { ...ENTRY, apiSource: API }, protocol: { ...BASE.protocol!, url: new URL('https://other.org') } }, 'api');
  assert.deepEqual([api?.state, api?.site?.state, api?.site?.phrase], ['ok', 'bad', 'other-site'], "the API still answered the address on a site that is not the protocol's");
});

test('confidence: high with an official page among two confirmations and a span, medium without the page, low for the signer', () => {
  assert.equal(confidence(ledgerOf({}), ENTRY), 'high');
  assert.equal(confidence(ledgerOf({ protocol: { ...BASE.protocol!, url: undefined } }), ENTRY), 'high', 'a site with nothing to compare moves nothing');
  assert.equal(confidence(ledgerOf({ entry: { ...ENTRY, apiSource: API }, page: { kind: 'served', blocks: [{ text: 'Vault' }] } }), ENTRY), 'medium');
  assert.equal(confidence(ledgerOf({ coins: [] }), ENTRY), 'low');
  assert.equal(confidence(ledgerOf({ abi: refused({ why: 'compiler-not-pinned', version: '0.8.99' }) }), ENTRY), 'low');
  assert.equal(confidence(ledgerOf({ spans: [{ kind: 'not-read', text: '' }] }), ENTRY), 'low');
  assert.equal(confidence(ledgerOf({ spans: [{ kind: 'unverifiable', text: '' }] }), ENTRY), 'low');
});

test('the strip counts addresses and recorded transactions, each by the worst of its results on that line', () => {
  const ledger = ledgerOf({ protocol: { ...BASE.protocol!, url: new URL('https://other.org') }, abi: refused({ why: 'compiler-not-pinned', version: '0.8.99' }), fixtures: [judged(MUTATIONS_PASS, PERTURB_PASS)] });
  assert.deepEqual(strip(ledger), [
    { line: 'sources', state: 'bad', passed: 0, counted: 1 },
    { line: 'abi', state: 'warn', passed: 0, counted: 1 },
    { line: 'code', state: 'ok', passed: 1, counted: 1 },
    { line: 'params', state: 'ok', passed: 1, counted: 1 },
    { line: 'trace', state: 'na', passed: 0, counted: 0 },
  ]);
});

test('待確認 lists red before amber, and an entry with no result for the signer folds', () => {
  const ledger = ledgerOf({ page: { kind: 'unread', why: 'timeout' }, spans: [{ kind: 'finding', text: '' }] });
  assert.deepEqual(forSigner(ledger).map((r) => r.id), ['vault/code.1', 'vault/address']);
  assert.deepEqual(addressRows(ledger, () => false).open.map((e) => e.name), ['vault']);
  assert.deepEqual(addressRows(ledgerOf({}), () => false).folded.map((e) => e.name), ['vault']);
  assert.deepEqual(forSigner(ledgerOf({})), []);
});

test('morpho/market-supply from its recordings: the three oracles confirmed in one place each for the signer, the rest folded', { timeout: 600_000 }, async () => {
  const registry = loadRegistry(ROOT);
  const target = { template: 'morpho/market-supply' };
  const compilers = await warmCompilers(reportCases(ROOT, registry, [target]));
  const { inputs } = await replayInputs(ROOT, registry, target, compilers, suffixes);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail('a template report');
  const ledger = judge(inputs, await judgeFixtures(ROOT, template, registry));
  const apiAlone = { kind: 'few-confirmations', by: [{ owner: 'morpho.org', sources: ['api'] }], needs: 2 };
  assert.deepEqual(forSigner(ledger).map((r) => [r.id, r.finding]), [
    ['morpho-oracle-cbbtc-usdc-86/address', apiAlone],
    ['morpho-oracle-usp-usdc/address', apiAlone],
    ['morpho-oracle-weeth-usdc-86/address', apiAlone],
  ]);
  assert.equal(stateOf(resultOf(ledger, 'morpho-oracle-cbbtc-usdc-86/source.page')), 'na');
  assert.equal(stateOf(resultOf(ledger, 'morpho-oracle-cbbtc-usdc-86/source.api')), 'ok');
  assert.equal(stateOf(resultOf(ledger, 'fixture.morpho-market-supply')), 'ok');
  assert.equal(resultOf(ledger, 'cbbtc/source.site').finding.kind, 'unlisted');
  assert.deepEqual(strip(ledger).map((s) => [s.line, s.state, `${s.passed}/${s.counted}`]), [
    ['sources', 'warn', '7/10'],
    ['abi', 'ok', '6/6'],
    ['code', 'ok', '10/10'],
    ['params', 'ok', '1/1'],
    ['trace', 'na', '0/0'],
  ]);
  assert.deepEqual(['usdc/abi', 'morpho-blue/abi'].map((id) => [resultOf(ledger, id).finding.kind, stateOf(resultOf(ledger, id))]), [
    ['metadata-differs', 'na'],
    ['metadata-differs', 'na'],
  ]);
  const rows = addressRows(ledger, () => false);
  assert.deepEqual(rows.open.map((e) => e.name), ['morpho-oracle-cbbtc-usdc-86', 'morpho-oracle-usp-usdc', 'morpho-oracle-weeth-usdc-86']);
  assert.equal(rows.folded.length, 7);
  assert.deepEqual(
    ledger.entries.map((e) => [e.name, confidence(ledger, e)]),
    [
      ['usdc', 'high'],
      ['cbbtc', 'high'],
      ['morpho-blue', 'high'],
      ['adaptive-curve-irm', 'high'],
      ['morpho-oracle-cbbtc-usdc-86', 'low'],
      ['usp', 'high'],
      ['morpho-oracle-usp-usdc', 'low'],
      ['weeth', 'high'],
      ['morpho-oracle-weeth-usdc-86', 'low'],
      ['blue-bundles-v1', 'high'],
    ],
  );
});

/** The generated report's Markdown for a one-entry report, from the same inputs as `ledgerOf`. */
const markdownOf = (change: Partial<Setup>): string => renderReport(inputsOf({ abi: undefined, ...change }), { command: 'test', sources: [] });
/** The `## Findings` index of a report: each row's result id with its grade and what it found. */
const findingsOf = (markdown: string): string[] =>
  [...markdown.slice(markdown.indexOf('## Findings'), markdown.indexOf('\n## ', markdown.indexOf('## Findings') + 1)).matchAll(/^\| `([^`]+)` \| (key|reference) \| (.+) \|$/gm)].map((m) => `${m[1]} ${m[2]}: ${m[3]}`);
const placesRow = (markdown: string): string => /^\| `vault` \|[^\n]*$/m.exec(markdown.slice(markdown.indexOf('| Entry | Bounty scope |')))?.[0] ?? assert.fail('no row for the bounty and SDK places');

test('a bounty or SDK place that was never compared, or holds the address apart from its label, prints FINDING graded reference; only one without the address prints NOT LISTED', () => {
  const unnamed = markdownOf({ entry: { ...ENTRY, immunefi: 'proto' } });
  assert.match(placesRow(unnamed), /^\| `vault` \| FINDING \|/);
  assert.ok(findingsOf(unnamed).includes('vault/source.bounty reference: Immunefi lists no program of the name the entry gives'));
  const untied = markdownOf({ entry: { ...ENTRY, immunefi: 'proto' }, protocol: undefined, sites: program([ADDRESS]) });
  assert.match(placesRow(untied), /^\| `vault` \| FINDING \|/);
  assert.ok(findingsOf(untied).includes("vault/source.bounty reference: the protocol's sites are not known, so nothing ties the Immunefi program the entry names to it"));
  const apart = markdownOf(packageRead({ file: { kind: 'served', blocks: [{ text: `OTHER = "${ADDRESS}"` }] } }));
  assert.match(placesRow(apart), /^\| `vault` \| [^|]+ \| FINDING \|/);
  assert.ok(findingsOf(apart).includes('vault/source.sdk reference: the address was not read on the page'));

  const outOfScope = markdownOf({ entry: { ...ENTRY, immunefi: 'proto' }, sites: program([OTHER]) });
  assert.match(placesRow(outOfScope), /^\| `vault` \| NOT LISTED \|/);
  assert.ok(!findingsOf(outOfScope).some((row) => row.startsWith('vault/source.bounty ')), 'a scope without the address is no finding');
  const absent = markdownOf(packageRead({ file: { kind: 'served', blocks: [{ text: `OTHER = "${OTHER}"` }] } }));
  assert.match(placesRow(absent), /^\| `vault` \| [^|]+ \| NOT LISTED \|/);
  assert.ok(!findingsOf(absent).some((row) => row.startsWith('vault/source.sdk ')), 'a file without the address is no finding');
});

test('a page or SDK file whose label binds only another address is a key finding for the signer that names that address in full; one away from a bare label stays reference', () => {
  const page = ledgerOf({ page: { kind: 'served', blocks: [{ text: `Vault ${OTHER}` }, { text: `Router ${ADDRESS}` }] } });
  assert.ok(forSigner(page).some((r) => r.id === 'vault/source.page'), 'it goes to 待確認');
  assert.deepEqual(gradedFindings(page).filter((r) => r.id === 'vault/source.page').map(weightOf), ['key']);
  const line = sourcesOf(page, ENTRY).find((l) => l.source === 'page');
  assert.deepEqual([line?.state, line?.phrase, line?.others], ['bad', 'other-address', [OTHER]], 'the row names the other address');
  const markdown = markdownOf({ page: { kind: 'served', blocks: [{ text: `Vault ${OTHER}` }, { text: `Router ${ADDRESS}` }] } });
  assert.ok(findingsOf(markdown).includes('vault/source.page key: the label lists another address'));
  assert.ok(markdown.includes(`FINDING: lists \`${checksumAddress(OTHER)}\` under the label`), 'the page cell names the other address checksummed');
  const sdk = markdownOf(packageRead({ file: { kind: 'served', blocks: [{ text: `VAULT = "${OTHER}"` }] } }));
  assert.match(placesRow(sdk), new RegExp(`^\\| \`vault\` \\| [^|]+ \\| FINDING: lists \`${checksumAddress(OTHER)}\` under the label \\|`));
  assert.ok(findingsOf(sdk).includes('vault/source.sdk key: the label lists another address'));

  const apart = ledgerOf({ page: { kind: 'served', blocks: [{ text: 'Vault overview' }, { text: ADDRESS }] } });
  assert.ok(!forSigner(apart).some((r) => r.id === 'vault/source.page'), 'an address away from a bare label stays outside 待確認');
  assert.deepEqual(gradedFindings(apart).filter((r) => r.id === 'vault/source.page').map(weightOf), ['reference']);
});

test("the Markdown findings index holds each recorded test transaction the HTML page judges, as the page's ledger does", () => {
  const fixtures = [judged({ kind: 'weak-template', uncaught: [{}] }, PERTURB_PASS)];
  const inputs = inputsOf({ abi: undefined, fixtures });
  const rows = findingsOf(markdownOf({ fixtures }));
  assert.ok(rows.some((row) => row.startsWith('fixture.safe-tx-1 key: ')), rows.join('\n'));
  const graded = gradedFindings(judge(inputs, fixtures)).map((r) => r.id);
  assert.deepEqual(rows.map((row) => row.slice(0, row.indexOf(' '))), graded);
});

/** `inputsOf`'s report, the entry read by a computed field of the card, and with `called` also documented as called, else not. */
function readInputs(change: Partial<Setup>, called = false): ReportInputs {
  const inputs = inputsOf({ abi: undefined, ...change });
  const read = { to: { kind: 'contract', name: ENTRY.name }, fn: parseFunctionSignature('latestAnswer()'), args: [], returns: [{ name: '', type: { kind: 'int', bits: 256 } }], output: [0] };
  const computed = { read, bound: 'floor', default: { bps: 0, source: DOC }, margin: undefined };
  const card = new Map([['min-buy', { kind: 'amount', of: 'eth', computed, max: undefined }]]);
  const template = { ...inputs.subject.template, card } as unknown as Template;
  return { ...inputs, subject: { ...inputs.subject, template, docs: called ? inputs.subject.docs : [] } } as ReportInputs;
}

test('an entry the card only reads needs one place, and its site differing is a reference finding outside 待確認 that says why the entry is there', () => {
  const read = (change: Partial<Setup>) => judge(readInputs(change), []);
  assert.equal(resultOf(read({ coins: [] }), 'vault/address').finding.kind, 'agrees', 'its page alone confirms it');
  assert.deepEqual(resultOf(read({ coins: [], page: { kind: 'served', blocks: [{ text: 'Vault' }] } }), 'vault/address').finding, { kind: 'few-confirmations', by: [], needs: 1 });
  const otherSite = { protocol: { ...BASE.protocol!, url: new URL('https://other.org') }, coins: [] };
  const ledger = read(otherSite);
  const site = resultOf(ledger, 'vault/source.site');
  assert.deepEqual([site.finding.kind, stateOf(site), weightOf(site)], ['site-differs', 'bad', 'reference'], 'red in its table, graded reference');
  assert.ok(!forSigner(ledger).some((r) => r.id === site.id), 'not for the signer');
  const markdown = renderReport(readInputs(otherSite), { command: 'test', sources: [] });
  const because = 'needs 1 place, not 2: it is in the report only because `card new` reads it, as the read for the minimum to receive (`min-buy`), and the signer confirms the number `card new` prints; its site results (a site that differs, cannot be compared, or has no second source) are reference and not under To review. A wrong read changes that number, and only the signer checking what `card new` prints catches it';
  assert.ok(findingsOf(markdown).includes('vault/source.site reference: site differs from the one DefiLlama lists; only read by `card new`, as the read for the minimum to receive (`min-buy`)'));
  assert.ok(markdown.includes(`- \`vault\`: ${because}.`));
});

test('an entry the card reads that the template also documents as called keeps the two-place rule and key site findings', () => {
  const ledger = judge(readInputs({ coins: [], protocol: { ...BASE.protocol!, url: new URL('https://other.org') } }, true), []);
  assert.equal(resultOf(ledger, 'vault/address').finding.kind, 'few-confirmations');
  assert.equal(weightOf(resultOf(ledger, 'vault/source.site')), 'key');
  assert.ok(!renderReport(readInputs({ coins: [] }, true), { command: 'test', sources: [] }).includes('only because `card new` reads it'));
});

test("the HTML page lists an entry the card only reads as a reference address, says beside it and under each of its findings in 待確認 why one place is enough, and words its site finding in its row", () => {
  const inputs = { ...readInputs({ coins: [], page: { kind: 'served', blocks: [{ text: 'Vault' }] }, protocol: { ...BASE.protocol!, url: new URL('https://other.org') } }), fixtures: [] } as HtmlInputs;
  const template = inputs.subject.template;
  const scope = notesScope(inputs, judge(inputs, []), template, 'en');
  assert.ok(scope.reviews.includes('vault/address') && !scope.reviews.includes('vault/source.site'), 'the address confirmed nowhere needs a review, the site that differs none');
  const both = (text: string) => ({ en: text, 'zh-TW': text });
  const notes = {
    title: both('title'),
    summary: both('summary'),
    verdict: { status: 'caution', text: both('verdict') },
    flow: [],
    protocols: Object.fromEntries([...scope.protocols].map(([slug]) => [slug, { intro: both('intro'), audits: { text: both('audits') }, incidents: [] }])),
    judgments: [],
    reviews: Object.fromEntries(scope.reviews.map((id) => [id, { status: 'confirmed', text: both('review'), recommendation: both('look') }])),
    fields: Object.fromEntries(scope.fields.map((key) => [key, both(`field ${key}`)])),
  };
  const because = 'Needs 1 place: it is the read for the minimum to receive, and you confirm the number card new prints.';
  const page = (language: 'en' | 'zh-TW') => pageText(renderPage(buildPage(inputs, notes, { command: 'test', sources: [] }, language)));
  const en = page('en');
  assert.match(en, /^Reference addresses 1 \(not in the transaction\)\nWhen you fill in the card, the program reads the numbers the card needs from these addresses\. The transaction never touches them\.$/m, 'its group, worded for a read that is not a price');
  assert.doesNotMatch(en, /^Addresses the transaction touches/m, 'no empty group');
  assert.match(en, new RegExp(`^${because.replaceAll('.', '\\.')}$`, 'm'), 'in its address row');
  assert.ok(en.includes(`place is needed. ${because}`), 'under its address finding');
  assert.ok(!en.includes('not one DefiLlama lists for this protocol.'), 'its site finding is not under To review');
  assert.match(en, /another site \(compared with DefiLlama \S+\) The site is example\.org; DefiLlama lists other\.org\. A reference address's site results are for reference only, not under To review\.$/m, 'its site finding stays in its row, with what was compared');
  const zh = page('zh-TW');
  assert.match(zh, /^參考地址 1 個（不在交易裡）\n填卡片時，程式從這些地址讀卡片要用的數字。交易不會碰到它們。$/m);
  assert.match(zh, /^只需 1 個地方確認：它是最少收到的數量的讀取對象，card new 印出的數字由你確認。$/m);
  assert.match(zh, /對照） 網站是 example\.org，DefiLlama 列的是 other\.org。參考地址的網站結果只供參考，不列入「待確認」。$/m);
});

test("a read-only entry whose only finding is its site: nothing under To review, medium confidence, an open row, and the strip and verdict say so", () => {
  const inputs = { ...readInputs({ coins: [], abi: withAbi(['latestAnswer()']), protocol: { ...BASE.protocol!, url: new URL('https://other.org') } }), fixtures: [] } as HtmlInputs;
  const ledger = judge(inputs, []);
  assert.deepEqual(ledger.results.filter((r) => stateOf(r) === 'bad' || stateOf(r) === 'warn').map((r) => r.id), ['vault/source.site'], 'its site is its only finding');
  const scope = notesScope(inputs, ledger, inputs.subject.template, 'en');
  assert.deepEqual(scope.reviews, [], 'no review to write');
  assert.equal(confidence(judge(readInputs({ coins: [], abi: withAbi(['latestAnswer()']) }), []), ENTRY), 'high', 'high with its own site');
  assert.equal(confidence(ledger, ENTRY), 'medium');
  assert.deepEqual(addressRows(ledger, () => false).open.map((entry) => entry.name), ['vault'], 'its row stays open while its site icon is red');
  const both = (text: string) => ({ en: text, 'zh-TW': text });
  const notes = {
    title: both('title'),
    summary: both('summary'),
    verdict: { status: 'caution', text: both('verdict') },
    flow: [],
    protocols: Object.fromEntries([...scope.protocols].map(([slug]) => [slug, { intro: both('intro'), audits: { text: both('audits') }, incidents: [] }])),
    judgments: [],
    reviews: {},
    fields: Object.fromEntries(scope.fields.map((key) => [key, both(`field ${key}`)])),
  };
  const { header } = buildPage(inputs, notes, { command: 'test', sources: [] }, 'en');
  assert.deepEqual([header.strip[0]?.name, header.strip.some((item) => item.line === 'sources')], ['Reference addresses', false], 'no transaction address line when the transaction touches none');
  const reference = header.strip.find((item) => item.line === 'reference') ?? assert.fail('no reference line');
  assert.equal(reference.state, 'bad', 'the source checks keep their red');
  assert.doesNotMatch(reference.explain, /results for you to review/);
  assert.match(reference.explain, /^This reference address needs 1 place: the transaction never touches it, and card new only reads a number from it, which you confirm\. .* The site results of vault are for reference: they stay under "Addresses", not under "To review"\.$/);
  assert.notEqual(header.verdict.state, 'bad', 'the verdict icon is not red for it');
});

/** The rendered page of `inputs` as plain text, with notes that hold every review and protocol its scope asks for. */
function pageTextOf(inputs: HtmlInputs, language: 'en' | 'zh-TW'): string {
  const scope = notesScope(inputs, judge(inputs, inputs.fixtures), inputs.subject.template, 'en');
  const both = (text: string) => ({ en: text, 'zh-TW': text });
  const notes = {
    title: both('title'),
    summary: both('summary'),
    verdict: { status: 'caution', text: both('verdict') },
    flow: [],
    protocols: Object.fromEntries([...scope.protocols].map(([slug]) => [slug, { intro: both('intro'), audits: { text: both('audits') }, incidents: [] }])),
    judgments: [],
    reviews: Object.fromEntries(scope.reviews.map((id) => [id, { status: 'confirmed', text: both('review'), recommendation: both('look') }])),
    fields: Object.fromEntries(scope.fields.map((key) => [key, both(`field ${key}`)])),
  };
  return pageText(renderPage(buildPage(inputs, notes, { command: 'test', sources: [] }, language)));
}

test('地址 puts the addresses the transaction touches first and the reference addresses card new only reads second, and the strip and contents count each group', () => {
  const feed: RegistryEntry = { ...SIBLING, name: 'feed' };
  const base = inputsOf({ others: [feed] });
  const read = { to: { kind: 'contract', name: feed.name }, fn: parseFunctionSignature('latestAnswer()'), args: [], returns: [{ name: '', type: { kind: 'int', bits: 256 } }], output: [0] };
  const card = new Map([['min-buy', { kind: 'amount', of: 'eth', computed: { read, bound: 'floor', default: { bps: 0, source: DOC }, margin: undefined }, max: undefined }]]);
  const inputs = { ...base, subject: { ...base.subject, template: { ...base.subject.template, card } as unknown as Template }, fixtures: [] } as HtmlInputs;
  const en = pageTextOf(inputs, 'en');
  const touched = en.indexOf('\nAddresses the transaction touches 1\n');
  const reference = en.indexOf('\nReference addresses 1 (not in the transaction)\n');
  assert.ok(touched > 0 && reference > touched, 'the touched group first, then the reference group');
  assert.ok(en.slice(touched, reference).includes('\nvault'), 'the contract the docs say the transaction calls');
  assert.ok(en.slice(reference).includes('\nfeed'), 'the entry card new reads');
  assert.match(en, /^Addresses 1 \+ 1$/m, 'the contents count each group');
  assert.match(en, /^\[[\w ]+\] Transaction addresses 1 \/ 1\n[^\n]*\n\[[\w ]+\] Reference addresses \d \/ 1$/m, 'one strip line per group, transaction addresses first');
  const zh = pageTextOf(inputs, 'zh-TW');
  assert.ok(zh.indexOf('\n交易會碰到的地址 1 個\n') < zh.indexOf('\n參考地址 1 個（不在交易裡）\n'));
  assert.match(zh, /\] 交易地址 1 \/ 1$/m);
  assert.match(zh, /\] 參考地址 \d \/ 1$/m);
  const alone = pageTextOf({ ...inputsOf({}), fixtures: [] } as HtmlInputs, 'zh-TW');
  assert.match(alone, /^交易會碰到的地址 1 個$/m, 'a report with no reference address keeps the first group');
  assert.doesNotMatch(alone, /參考地址/, 'and has no empty second group');
});

test('a source row that fails or needs a look links its page and says in one line which site or coin and why, pointing to 待確認 when the result is there', () => {
  const row = (change: Partial<Setup>, language: 'en' | 'zh-TW' = 'en') => pageTextOf({ ...inputsOf(change), fixtures: [] } as HtmlInputs, language);
  const untied = { entry: { ...ENTRY, immunefi: 'proto' }, sites: program([ADDRESS], 'https://github.com/other', 'https://other.org') };
  assert.match(row(untied), /^\[fail\] Immunefi bug bounty scope \(https:\/\/immunefi\.com\/bug-bounty\/proto\/\) another site The page links to other\.org; DefiLlama lists example\.org\. See "To review"\.$/m);
  assert.match(row(untied, 'zh-TW'), /^\[不通過\] Immunefi 漏洞賞金範圍 \(https:\/\/immunefi\.com\/bug-bounty\/proto\/\) 是另一個網站 頁面連到 other\.org，DefiLlama 列的是 example\.org。見「待確認」。$/m);
  const siteless = { entry: { ...ENTRY, immunefi: 'proto' }, sites: program([ADDRESS], undefined, null) };
  assert.match(row(siteless), /Immunefi gives this program no website or GitHub organization to match example\.org, github\.com\/example, which DefiLlama lists\. See "To review"\.$/m, 'a program with no site of its own');
  assert.match(row({ protocol: { ...BASE.protocol!, url: new URL('https://other.org') } }), /another site \(compared with DefiLlama \S+\) The site is example\.org; DefiLlama lists other\.org\. See "To review"\.$/m);
  assert.match(row({ coins: [{ id: 'other-coin', symbol: 'o', name: 'Other', ethereum: ADDRESS }] }), /CoinGecko lists other-coin at this address; the entry names vault-coin\. See "To review"\.$/m);
  assert.match(row({ coins: [], protocol: { ...BASE.protocol!, url: undefined, github: [] } }), /The site is example\.org; DefiLlama lists no website to compare, and nothing else shows it is the protocol's\. See "To review"\.$/m);
  const { defillama: _slug, ...unslugged } = ENTRY;
  assert.match(row({ entry: unslugged }, 'zh-TW'), /登記沒有寫 DefiLlama 協議，沒辦法比對網站。見「待確認」。$/m);
});

test('a feed the transaction itself reads in a recorded trace, by a STATICCALL with no value, is an address the transaction touches, not a reference address', () => {
  const feed: RegistryEntry = { ...SIBLING, name: 'feed' };
  const base = inputsOf({ others: [feed] });
  const read = { to: { kind: 'contract', name: feed.name }, fn: parseFunctionSignature('latestAnswer()'), args: [], returns: [{ name: '', type: { kind: 'int', bits: 256 } }], output: [0] };
  const card = new Map([['min-buy', { kind: 'amount', of: 'eth', computed: { read, bound: 'floor', default: { bps: 0, source: DOC }, margin: undefined }, max: undefined }]]);
  const subject = { ...base.subject, template: { ...base.subject.template, card } as unknown as Template };
  const calls = [
    { depth: 0, type: 'CALL', from: DEPLOYER, to: ADDRESS, selector: '0x095ea7b3', args: [DEPLOYER] },
    { depth: 1, type: 'STATICCALL', from: ADDRESS, to: OTHER, selector: '0x50d25bcd' },
  ];
  const run = { studies: [], measurements: [], effects: [], found: { total: 1, both: 1, only: { alchemy: [], etherscan: [] } }, search: { kind: 'windows' }, traces: [{ kind: 'traced', hash: PIN, sender: { address: DEPLOYER }, calls }] };
  const inputs = { ...base, subject, pastTxs: [{ query: { template: 'test/op' }, run }], fixtures: [] } as unknown as HtmlInputs;
  const feedNeeds = resultOf(judge(inputs, []), 'feed/address').finding;
  assert.equal(feedNeeds.kind === 'few-confirmations' ? feedNeeds.needs : 2, 2, 'it needs two places');
  const en = pageTextOf(inputs, 'en');
  assert.match(en, /^Addresses the transaction touches 2$/m);
  assert.doesNotMatch(en, /Reference addresses|never touches/);
  const zh = pageTextOf(inputs, 'zh-TW');
  assert.match(zh, /^交易會碰到的地址 2 個$/m);
  assert.doesNotMatch(zh, /參考地址|交易不會碰到/);
});

test('a source row says what each check saw: a bounty site against an empty DefiLlama list or a host with no registrable domain, a commit the check could not place, an SDK provenance for another tarball, and the coin CoinGecko lists, linked', () => {
  const row = (change: Partial<Setup>, language: 'en' | 'zh-TW' = 'en') => pageTextOf({ ...inputsOf(change), fixtures: [] } as HtmlInputs, language);
  const bare = { ...BASE.protocol!, url: undefined, github: [] };
  const lonely = { entry: { ...ENTRY, immunefi: 'proto' }, protocol: bare, sites: program([ADDRESS], undefined, 'https://other.org') };
  assert.match(row(lonely), /The page links to other\.org; DefiLlama lists no website for the protocol\. See "To review"\.$/m);
  assert.match(row(lonely, 'zh-TW'), /頁面連到 other\.org，DefiLlama 沒有列這個協議的網站。見「待確認」。$/m);
  assert.doesNotMatch(row(lonely), /DefiLlama lists \./);
  const nothing = { entry: { ...ENTRY, immunefi: 'proto' }, protocol: bare, sites: program([ADDRESS], undefined, null) };
  assert.match(row(nothing), /Immunefi gives this program no website or GitHub organization, and DefiLlama lists none for the protocol\. See "To review"\.$/m);
  assert.match(row(nothing, 'zh-TW'), /Immunefi 沒有給這個計畫網站或 GitHub 組織，DefiLlama 也沒有列這個協議的網站或 GitHub 組織。見「待確認」。$/m);
  const shared = { entry: { ...ENTRY, immunefi: 'proto' }, sites: program([ADDRESS], undefined, 'https://gitbook.io') };
  assert.match(row(shared), /The website Immunefi gives, gitbook\.io, has no registrable domain or is a shared host, so it matches none of example\.org, github\.com\/example, which DefiLlama lists\. See "To review"\.$/m);
  assert.match(row(shared, 'zh-TW'), /Immunefi 給的網站 gitbook\.io 沒有可登記的網域，或是共用的主機，對不到 DefiLlama 列的 example\.org、github\.com\/example。見「待確認」。$/m);
  assert.doesNotMatch(row(shared), /no website or GitHub organization/);
  const unknown = { entry: { ...ENTRY, source: GITHUB }, page: { kind: 'served', blocks: [{ text: `Vault ${ADDRESS}` }] } as Page, commit: { kind: 'unknown', why: 'GitHub compare answered 404' } as CommitCheck };
  assert.match(row(unknown), /The check could not tell whether commit aaaaaaaaaaaa is on the default branch\. See "To review"\./m);
  assert.match(row(unknown, 'zh-TW'), /程式查不出 commit aaaaaaaaaaaa 在不在預設分支上。見「待確認」。/m);
  assert.doesNotMatch(row(unknown), /is not pinned to a commit/);
  const offDefault = { ...unknown, commit: { kind: 'off-default', branch: 'main', status: 'diverged' } as CommitCheck };
  assert.match(row(offDefault), /Commit aaaaaaaaaaaa is not on the default branch main\. See "To review"\./m);
  const otherTarball = packageRead({ provenance: { ...BUILT, sameTarball: false } });
  assert.match(row(otherTarball), /npm's provenance for this SDK version names another tarball than the one downloaded, so nothing ties this tarball to its build\. See "To review"\./m);
  assert.match(row(otherTarball, 'zh-TW'), /npm 對這個 SDK 版本的建置證明指向另一個 tarball，不是下載的這一份，所以沒有東西證明這份 tarball 是從那個建置來的。見「待確認」。/m);
  assert.doesNotMatch(row(otherTarball), /DefiLlama lists for this protocol/);
  const other = row({ coins: [{ id: 'other-coin', symbol: 'o', name: 'Other', ethereum: ADDRESS }] });
  assert.match(other, /^\[fail\] CoinGecko \(https:\/\/www\.coingecko\.com\/en\/coins\/other-coin\)/m, 'links the coin CoinGecko lists at the address');
  assert.doesNotMatch(other, /coins\/vault-coin/, 'not the coin the entry names, which the check did not find there');
  assert.match(row({ coins: [] }), /^\[nothing to compare\] CoinGecko nothing to compare$/m, 'no link when CoinGecko lists no coin there');
});

test('an entry the card reads keeps two places when anything else reaches it: a spender that depends on it, or a money call in a recorded trace', () => {
  const needs = (inputs: ReportInputs): unknown => {
    const finding = resultOf(judge(inputs, []), 'vault/address').finding;
    return finding.kind === 'few-confirmations' ? finding.needs : finding.kind;
  };
  assert.equal(needs(readInputs({ coins: [] })), 'agrees');
  const { coingecko: _, ...uncoined } = SIBLING;
  const helper: RegistryEntry = { ...uncoined, name: 'helper', dependsOn: ['vault'] };
  const approving = readInputs({ coins: [], others: [helper] });
  const template = { ...approving.subject.template, effects: { ...approving.subject.template.effects, approves: [{ token: { field: 'min-buy', attribute: undefined }, spender: 'helper', via: 'erc20', amount: { kind: 'unlimited' } }] } } as unknown as Template;
  assert.equal(needs({ ...approving, subject: { ...approving.subject, template } } as ReportInputs), 2, 'an allowance spender that depends on it');
  const call = { depth: 1, type: 'CALL', from: OTHER, to: ADDRESS, selector: '0xa9059cbb', args: [OTHER] };
  const traced = { ...readInputs({ coins: [] }), pastTxs: [{ run: { traces: [{ kind: 'traced', hash: PIN, sender: { address: OTHER }, calls: [call] }] } }] } as unknown as ReportInputs;
  assert.equal(needs(traced), 2, 'a money call to it in a recorded trace');
});

test('an entry the card only reads and nothing confirms stays a key finding, and its ABI finding keeps its grade', () => {
  const ledger = judge(readInputs({ coins: [], page: { kind: 'served', blocks: [{ text: 'Vault' }] } }), []);
  assert.equal(weightOf(resultOf(ledger, 'vault/address')), 'key');
  const abi = ledger.results.find((r) => r.id === 'vault/abi');
  assert.ok(abi !== undefined);
  assert.equal(weightOf(abi), WEIGHT_OF[abi.finding.kind]);
});
