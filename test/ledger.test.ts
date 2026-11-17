import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AdapterAnswer, AdapterCause, InstanceProof, ParentAnswer, ParentCause, RefusalCause } from '../src/contracts/instance.ts';
import type { AbiProof, AbiRefusal } from '../src/contracts/prove.ts';
import { canonicalType, parseFunctionSignature } from '../src/decode/abi.ts';
import type { AbiFunction } from '../src/decode/abi.ts';
import { loadRegistry } from '../src/registry.ts';
import type { HttpsUrl, Registry, RegistryEntry } from '../src/registry.ts';
import type { ApiAnswer } from '../src/research/api-source.ts';
import { STATE_OF, addressRows, confidence, confirmations, forSigner, judge, sourcesOf, stateOf, strip } from '../src/research/ledger.ts';
import type { FindingKind, Ledger, State } from '../src/research/ledger.ts';
import type { CoinGeckoCoin, DefiLlamaProtocol, SiteOwner } from '../src/research/listings.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import type { Creation, Creations } from '../src/research/deployer.ts';
import type { PackageRead, PackageReads } from '../src/research/npm-package.ts';
import { NO_SITE_LISTINGS } from '../src/research/site-listings.ts';
import type { SiteListings } from '../src/research/site-listings.ts';
import { replayInputs } from '../src/research/report.ts';
import type { InstanceAnswers, ReportInputs, SpanCheck, TodayCheck } from '../src/research/report.ts';
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
const MORE = { url: GITHUB, label: 'Vault' };
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
const evidence = (text: string) => ({ entry: VAULT, vaults: new Map([['vault', text]]) });
const COMPUTING_FACTORY: RegistryEntry = {
  ...ENTRY,
  name: 'vault-factory',
  address: `0x${'fa'.repeat(20)}` as Address,
  kind: 'factory',
  instanceCheck: { kind: 'computes-address', fn: parseFunctionSignature('computeToken(address,string)'), args: [{ kind: 'attribute', attribute: 'asset' }, { kind: 'string', value: 'fToken' }] },
};
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
  readonly api: ApiAnswer | undefined;
  readonly doc: Page | undefined;
  readonly abi: AbiProof | AbiRefusal | undefined;
  readonly spans: readonly SpanCheck[] | undefined;
  readonly today: TodayCheck | undefined;
  readonly documented: boolean;
  readonly approveStandard: Standard | undefined;
  readonly docPublisher: SiteOwner | undefined;
  readonly fixtures: readonly FixtureJudgement[];
  readonly vaults: ReadonlyMap<string, string>;
  /** What the entry's factory, and for an adapter each vault naming it, answered; undefined when not read. */
  readonly instances: InstanceAnswers | undefined;
  readonly reachedThrough: RegistryEntry | undefined;
  readonly factory: RegistryEntry | undefined;
  readonly sites: SiteListings;
  readonly packages: PackageReads;
  readonly creations: Creations | undefined;
  /** Another entry of the protocol the entry depends on, confirmed by its own page and coin when `confirmed`. */
  readonly sibling: { readonly confirmed: boolean } | undefined;
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
  api: { kind: 'answered', json: { address: ADDRESS } },
  doc: { kind: 'served', blocks: [{ text: 'function approve(address spender, uint256 value)' }] },
  abi: { kind: 'proven', proxy: { kind: 'none' }, codeHash: PIN } as unknown as AbiProof,
  spans: [{ kind: 'pass', text: '' }],
  today: undefined,
  documented: true,
  approveStandard: undefined,
  docPublisher: undefined,
  fixtures: [],
  vaults: new Map(),
  instances: undefined,
  reachedThrough: undefined,
  factory: undefined,
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
  packages: new Map([[SDK_KEY, { kind: 'read', sha256: PIN, integrity: true, provenance: BUILT, file: { kind: 'served', blocks: [{ text: `VAULT = "${ADDRESS}"` }] }, ...change }]]),
});
const program = (addresses: readonly Address[], github?: string, website = 'https://example.org'): SiteListings => ({
  ...NO_SITE_LISTINGS,
  programs: new Map([['proto', { slug: 'proto', website: new URL(website), github: github === undefined ? undefined : new URL(github), addresses: new Set(addresses) }]]),
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
const ROUTED: RegistryEntry = {
  ...ENTRY,
  routes: { implementationOf: parseFunctionSignature('getSigsImplementation(bytes4)'), selectorsOf: parseFunctionSignature('getImplementationSigs(address)'), seeds: ['0x00000001' as Hex] },
  code: { earlier: [], current: { from: 100n, pin: { hash: PIN, routes: [{ address: OTHER, hash: PIN, selectors: ['0x00000001' as Hex] }] } } },
};
const today = (kind: TodayCheck['kind']): Partial<Setup> => ({ today: { kind, text: '' } });

const ADAPTER: RegistryEntry = { ...ENTRY, kind: 'adapter', attributes: { factory: 'vault-factory' } };
const CREATED = { kind: 'created', asked: 'isVaultAdapter(address)', answered: 'true' } as unknown as InstanceProof;
const factoryRefusal = (cause: RefusalCause): InstanceAnswers['factory'] => ({ kind: 'refused', cause, why: '' });
const USES: AdapterAnswer = { vault: ADAPTED, asked: 'isAdapter(address)', block: { number: 200n, hash: PIN }, kind: 'uses', providers: ['alchemy', 'drpc'] };
const vaultRefusal = (cause: AdapterCause): AdapterAnswer => ({ vault: ADAPTED, asked: 'isAdapter(address)', block: { number: 200n, hash: PIN }, kind: 'refused', cause, why: '' });
const MADE_FOR: ParentAnswer = { vault: ADAPTED, asked: 'parentVault()', block: { number: 200n, hash: PIN }, kind: 'made-for', providers: ['alchemy', 'drpc'] };
const parentRefusal = (cause: ParentCause): ParentAnswer => ({ vault: ADAPTED, asked: 'parentVault()', block: { number: 200n, hash: PIN }, kind: 'refused', cause, why: '' });
const adapterAsked = (factory: InstanceAnswers['factory'], vaults: readonly AdapterAnswer[], parents: readonly ParentAnswer[] = vaults.map(({ vault }) => ({ ...MADE_FOR, vault }))): Partial<Setup> => ({
  entry: ADAPTER,
  instances: { factory, vaults, parents },
});

const proven = (codeHash: Hex): AbiProof => ({ kind: 'proven', proxy: { kind: 'none' }, codeHash }) as unknown as AbiProof;
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
 * `reachedThrough`, a report of that vault alone, which reaches the entry only through its `dependsOn`.
 */
function ledgerOf(change: Partial<Setup>): Ledger {
  const s = { ...BASE, ...change };
  const all = [s.entry, ...(s.reachedThrough === undefined ? [] : [s.reachedThrough]), ...(s.factory === undefined ? [] : [s.factory]), ...(s.sibling === undefined ? [] : [SIBLING])];
  const siblingConfirmed = s.sibling?.confirmed === true;
  const registry: Registry = { entries: new Map(all.map((e) => [e.name, e])), byAddress: new Map(all.map((e) => [e.address, e])), markets: new Map() };
  const template = { id: 'test/op', card: new Map(), nonce: undefined, same: [], calls: [], effects: { gives: [], gets: [], views: [], safe: undefined, approves: [], touches: [] }, facts: s.read === undefined ? [] : [{ to: s.entry.name, fn: s.read, args: [], returns: [] } as never] } as Template;
  const inputs = {
    subject:
      s.reachedThrough !== undefined
        ? { kind: 'vault', vault: s.reachedThrough }
        : s.documented
          ? { kind: 'template', template, docs: [{ fn: APPROVE, contract: s.entry, publisher: s.docPublisher ?? s.entry, url: s.approveStandard?.page ?? DOC, standard: s.approveStandard }] }
          : { kind: 'vault', vault: s.entry },
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
  } as unknown as ReportInputs;
  return judge(inputs, s.fixtures);
}

const resultOf = (ledger: Ledger, id: string) => ledger.results.find((r) => r.id === id) ?? assert.fail(`no result ${id}: ${ledger.results.map((r) => r.id).join(', ')}`);

type Row = { readonly what: string; readonly change: Partial<Setup>; readonly id: string; readonly kind: FindingKind; readonly state: State };

const ROWS: readonly Row[] = [
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
  { what: 'a proof refused for a reason other than its compiler', change: { abi: refused({ why: 'bytecode-mismatch' }) }, id: 'vault/abi', kind: 'refused', state: 'bad' },
  { what: 'a vault its factory created', change: evidence(ADMITTED), id: 'vault/factory.admitted', kind: 'agrees', state: 'ok' },
  { what: 'a vault its factory answered it did not create', change: evidence("REFUSED vault-factory answered isVault(address) false for vault: it did not create it; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'not-created', state: 'bad' },
  { what: 'a vault whose factory answered neither true nor false', change: evidence("REFUSED vault-factory answered isVault(address) with a revert, not true or false; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'factory-other-answer', state: 'bad' },
  { what: 'a vault whose address its factory computed', change: { ...evidence(`admitted     vault-factory answered computeToken(usdc,"fToken") = ${checksumAddress(ADDRESS)} at block 100\nvault        vault 0x`), factory: COMPUTING_FACTORY }, id: 'vault/factory.admitted', kind: 'agrees', state: 'ok' },
  { what: 'a vault its factory computed another address for', change: evidence("REFUSED vault-factory answered computeToken(usdc,\"fToken\") = 0x5C20B550819128074FD538Edf79791733ccEdd18, not vault: its official contract is another; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'not-created', state: 'bad' },
  { what: 'a vault whose factory computed no address', change: evidence("REFUSED vault-factory answered computeToken(usdc,\"fToken\") with a revert, not an address; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'factory-other-answer', state: 'bad' },
  { what: "a vault lacking an attribute its factory's check binds", change: evidence("REFUSED vault has no asset attribute, which vault-factory's instanceCheck computeToken(address,string) binds; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: 'a vault another factory admitted', change: evidence(ADMITTED.replace('vault-factory', 'other-factory')), id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: "a vault whose factory's answer got no reply", change: evidence("REFUSED the providers disagree; the vault's code is not read"), id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: 'a vault whose block was not read', change: evidence('UNVERIFIABLE no block'), id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: 'a vault with no stored evidence', change: { entry: VAULT }, id: 'vault/factory.admitted', kind: 'factory-unread', state: 'warn' },
  { what: 'an adapter its factory created', change: adapterAsked(CREATED, [USES]), id: 'vault/factory.admitted', kind: 'agrees', state: 'ok' },
  { what: 'an adapter the vault naming it uses', change: adapterAsked(CREATED, [USES]), id: 'vault/vault.adapted.adapter', kind: 'agrees', state: 'ok' },
  { what: 'an adapter its factory answered it did not create', change: adapterAsked(factoryRefusal('not-created'), [USES]), id: 'vault/factory.admitted', kind: 'not-created', state: 'bad' },
  { what: "an adapter whose factory's answer got no reply", change: adapterAsked(factoryRefusal('no-answer'), [USES]), id: 'vault/factory.admitted', kind: 'no-answer', state: 'warn' },
  { what: 'an adapter the vault naming it answered false for', change: adapterAsked(CREATED, [vaultRefusal('not-used')]), id: 'vault/vault.adapted.adapter', kind: 'not-adapter', state: 'bad' },
  { what: 'an adapter the vault naming it answered neither true nor false for', change: adapterAsked(CREATED, [vaultRefusal('other-answer')]), id: 'vault/vault.adapted.adapter', kind: 'adapter-other-answer', state: 'bad' },
  { what: "an adapter whose vault's factory has no adapterCheck", change: adapterAsked(CREATED, [vaultRefusal('unaskable')]), id: 'vault/vault.adapted.adapter', kind: 'adapter-unread', state: 'warn' },
  { what: 'an adapter no registry vault names', change: adapterAsked(CREATED, []), id: 'vault/vault.adapter', kind: 'adapter-unread', state: 'warn' },
  { what: 'an adapter made for the vault naming it', change: adapterAsked(CREATED, [USES]), id: 'vault/vault.adapted.parent', kind: 'agrees', state: 'ok' },
  { what: 'an adapter made for another vault', change: adapterAsked(CREATED, [USES], [parentRefusal('other-parent')]), id: 'vault/vault.adapted.parent', kind: 'not-parent', state: 'bad' },
  { what: 'an adapter that answered no address for its parent', change: adapterAsked(CREATED, [USES], [parentRefusal('other-answer')]), id: 'vault/vault.adapted.parent', kind: 'parent-other-answer', state: 'bad' },
  { what: "an adapter whose factory has no parentCheck", change: adapterAsked(CREATED, [USES], [parentRefusal('unaskable')]), id: 'vault/vault.adapted.parent', kind: 'parent-unread', state: 'warn' },
  { what: 'an adapter in a recording that predates the parent answer', change: adapterAsked(CREATED, [USES], []), id: 'vault/vault.adapted.parent', kind: 'parent-unread', state: 'warn' },
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
  { what: 'an entry reached only through dependsOn, with no ABI case', change: { reachedThrough: DEPENDENT, abi: undefined }, id: 'vault/abi', kind: 'not-called', state: 'na' },
  { what: 'an entry reached only through dependsOn that runs its pin at the latest block', change: { reachedThrough: DEPENDENT, ...today('pass') }, id: 'vault/code.today', kind: 'agrees', state: 'ok' },
  { what: 'an entry reached only through dependsOn that runs other code at the latest block', change: { reachedThrough: DEPENDENT, ...today('finding') }, id: 'vault/code.today', kind: 'pin-not-run', state: 'bad' },
  { what: "an entry reached only through dependsOn whose code at the latest block got no answer", change: { reachedThrough: DEPENDENT, ...today('unverifiable') }, id: 'vault/code.today', kind: 'no-answer', state: 'warn' },
  { what: 'an entry reached only through dependsOn with no read at the latest block', change: { reachedThrough: DEPENDENT }, id: 'vault/code.today', kind: 'no-chain-result', state: 'warn' },
  { what: "a vault's adapter, whose address only goes into an argument, with its proof refused", change: { reachedThrough: ADAPTED, abi: refused({ why: 'not-on-etherscan' }) }, id: 'vault/abi', kind: 'not-called', state: 'na' },
  { what: 'a selector-routed proxy a call targets', change: { entry: ROUTED }, id: 'vault/abi', kind: 'routed-proxy', state: 'na' },
  { what: 'a selector-routed proxy that runs its pin and routes at the latest block', change: { entry: ROUTED, ...today('pass') }, id: 'vault/code.today', kind: 'agrees', state: 'ok' },
  { what: 'a bounty program with the address in scope', change: { entry: { ...ENTRY, immunefi: 'proto' }, sites: program([ADDRESS]) }, id: 'vault/source.bounty', kind: 'agrees', state: 'ok' },
  { what: 'a bounty program without the address in scope', change: { entry: { ...ENTRY, immunefi: 'proto' }, sites: program([OTHER]) }, id: 'vault/source.bounty', kind: 'not-listed', state: 'na' },
  { what: "a bounty program that lists none of the protocol's sites", change: { entry: { ...ENTRY, immunefi: 'proto' }, sites: program([ADDRESS], 'https://github.com/other', 'https://other.org') }, id: 'vault/source.bounty', kind: 'site-differs', state: 'bad' },
  { what: 'a bounty program Immunefi does not list', change: { entry: { ...ENTRY, immunefi: 'proto' } }, id: 'vault/source.bounty', kind: 'not-listed', state: 'na' },
  { what: 'an SDK file with the address next to its label', change: packageRead(), id: 'vault/source.sdk', kind: 'agrees', state: 'ok' },
  { what: "an SDK built from the protocol's GitHub org", change: packageRead(), id: 'vault/source.sdk.site', kind: 'agrees', state: 'ok' },
  { what: 'an SDK file without the address by its label', change: packageRead({ file: { kind: 'served', blocks: [{ text: `OTHER = "${ADDRESS}"` }] } }), id: 'vault/source.sdk', kind: 'not-listed', state: 'na' },
  { what: 'an SDK tarball that is not the pinned one', change: packageRead({ sha256: `0x${'22'.repeat(32)}` as Hex }), id: 'vault/source.sdk', kind: 'package-differs', state: 'bad' },
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
];

for (const row of ROWS) {
  test(`${row.what}: ${row.id} is ${row.kind}, ${row.state}`, () => {
    const result = resultOf(ledgerOf(row.change), row.id);
    assert.equal(result.finding.kind, row.kind);
    assert.equal(stateOf(result), row.state);
  });
}

test('two entries that share a deployer and are confirmed nowhere else never confirm each other through it', () => {
  const ledger = ledgerOf({ ...sharing(false), coins: [] });
  assert.equal(resultOf(ledger, 'vault/address').finding.kind, 'few-confirmations');
  assert.equal(resultOf(ledger, 'sibling/address').finding.kind, 'few-confirmations');
  const confirmed = ledgerOf({ ...sharing(true), coins: [] });
  assert.deepEqual(confirmations(confirmed, ENTRY), ['page', 'deployer']);
  assert.deepEqual(resultOf(confirmed, 'vault/source.deployer').shared, { deployer: DEPLOYER, siblings: ['sibling'] });
});

test('an SDK whose publisher nothing ties to the protocol confirms nothing, though its file shows the address', () => {
  const ledger = ledgerOf({ ...packageRead({ provenance: { kind: 'none' } }), coins: [] });
  assert.equal(resultOf(ledger, 'vault/source.sdk').finding.kind, 'agrees');
  assert.deepEqual(confirmations(ledger, { ...ENTRY, sdk: SDK }), ['page']);
  assert.equal(resultOf(ledger, 'vault/address').finding.kind, 'few-confirmations');
  assert.deepEqual(confirmations(ledgerOf({ ...packageRead(), coins: [] }), { ...ENTRY, sdk: SDK }), ['page', 'sdk']);
});

test('every finding kind has a row', () => {
  assert.deepEqual(new Set(ROWS.map((row) => row.kind)), new Set(Object.keys(STATE_OF)));
});

test('only an entry no ABI proof compares with the chain has a result for its code at the latest block', () => {
  assert.ok(!ledgerOf(today('pass')).results.some((r) => r.id.endsWith('/code.today')));
  assert.ok(!ledgerOf({ reachedThrough: DEPENDENT, entry: without('code'), ...today('pass') }).results.some((r) => r.id.endsWith('/code.today')), 'an entry with no pin has only its not-pinned result');
});

test('only an entry that names a factory has a factory result', () => {
  const ids = (entry: RegistryEntry) => ledgerOf({ entry, vaults: new Map([['vault', ADMITTED]]) }).results.map((r) => r.id);
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
    return [confirmations(ledger, entry), resultOf(ledger, `${entry.name}/address`).finding.kind];
  };
  assert.deepEqual(by({}), [['page', 'coingecko'], 'agrees']);
  assert.deepEqual(by({ entry: { ...ENTRY, moreSources: [MORE], apiSource: API } }), [['page', 'more.1', 'api', 'coingecko'], 'agrees']);
  assert.deepEqual(by({ entry: { ...ENTRY, moreSources: [MORE] }, commit: { kind: 'off-default', branch: 'main', status: 'diverged' }, coins: [] }), [['page'], 'few-confirmations']);
  const echoing = { ...VAULT, source: `${SOURCE}/${ADDRESS}` as HttpsUrl };
  assert.deepEqual(by({ entry: echoing, vaults: new Map([['vault', ADMITTED]]), coins: [] }), [['factory'], 'few-confirmations']);
  assert.deepEqual(by({ entry: echoing, vaults: new Map([['vault', ADMITTED]]) }), [['coingecko', 'factory'], 'agrees']);
  assert.deepEqual(by({ protocol: { ...BASE.protocol!, url: undefined }, coins: [] }), [['page'], 'few-confirmations']);
});

test("an adapter's factory, the vault naming it and the adapter's own answer are one place, counted only when every answer passes", () => {
  const by = (change: Partial<Setup>) => {
    const ledger = ledgerOf({ coins: [], ...change });
    return [confirmations(ledger, ADAPTER), resultOf(ledger, 'vault/address').finding.kind];
  };
  assert.deepEqual(by(adapterAsked(CREATED, [USES])), [['page', 'factory'], 'agrees']);
  assert.deepEqual(by(adapterAsked(CREATED, [USES, { ...USES, vault: { ...ADAPTED, name: 'second' } }])), [['page', 'factory'], 'agrees'], 'two vaults naming it are still one place');
  assert.deepEqual(by(adapterAsked(CREATED, [USES, vaultRefusal('not-used')])), [['page'], 'few-confirmations']);
  assert.deepEqual(by(adapterAsked(CREATED, [])), [['page'], 'few-confirmations'], 'the factory alone does not say whose adapter it is');
  assert.deepEqual(by(adapterAsked(CREATED, [USES], [parentRefusal('other-parent')])), [['page'], 'few-confirmations'], "another vault's official adapter is no confirmation");
  assert.deepEqual(by(adapterAsked(factoryRefusal('not-created'), [USES])), [['page'], 'few-confirmations'], 'the vault alone does not say it is an official adapter');
  assert.deepEqual(by({ entry: ADAPTER }), [['page'], 'few-confirmations']);
});

test('an empty address source is grey; the address result alone puts the entry in 待確認', () => {
  const ledger = ledgerOf({ entry: { ...ENTRY, apiSource: API }, page: { kind: 'served', blocks: [{ text: 'Vault' }] } });
  assert.equal(stateOf(resultOf(ledger, 'vault/source.page')), 'na');
  assert.deepEqual(forSigner(ledger), []);
  assert.equal(confidence(ledger, ENTRY), 'medium', 'no official page among the confirmations');
  assert.deepEqual(
    sourcesOf(ledger, ENTRY).map((s) => [s.source, s.state, s.phrase, s.link, s.site]),
    [
      ['page', 'na', 'unread', SOURCE, { state: 'ok', phrase: undefined, link: 'https://defillama.com/protocol/proto', places: [{ kind: 'defillama', id: 'proto' }] }],
      ['api', 'ok', undefined, API.url, { state: 'ok', phrase: undefined, link: 'https://defillama.com/protocol/proto', places: [{ kind: 'defillama', id: 'proto' }] }],
      ['coingecko', 'ok', undefined, 'https://www.coingecko.com/en/coins/vault-coin', undefined],
    ],
  );
  const alone = ledgerOf({ page: { kind: 'served', blocks: [{ text: 'Vault' }] } });
  assert.deepEqual(forSigner(alone).map((r) => [r.id, r.finding]), [['vault/address', { kind: 'few-confirmations', by: ['coingecko'] }]]);
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
  const ledger = ledgerOf({ entry: VAULT, vaults: new Map([['vault', ADMITTED]]), protocol: { ...BASE.protocol!, url: undefined }, coins: [] });
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
  assert.deepEqual(confirmations(ledger, entry), ['page']);
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
  ]);
});

test('待確認 lists red before amber, and an entry with no result for the signer folds', () => {
  const ledger = ledgerOf({ page: { kind: 'unread', why: 'timeout' }, spans: [{ kind: 'finding', text: '' }] });
  assert.deepEqual(forSigner(ledger).map((r) => r.id), ['vault/code.1', 'vault/address']);
  assert.deepEqual(addressRows(ledger).open.map((e) => e.name), ['vault']);
  assert.deepEqual(addressRows(ledgerOf({})).folded.map((e) => e.name), ['vault']);
  assert.deepEqual(forSigner(ledgerOf({})), []);
});

test('morpho/market-supply from its recordings: the three oracles confirmed in one place each for the signer, the rest folded', { timeout: 600_000 }, async () => {
  const registry = loadRegistry(ROOT);
  const target = { template: 'morpho/market-supply' };
  const compilers = await warmCompilers(reportCases(ROOT, registry, [target]));
  const { inputs } = await replayInputs(ROOT, registry, target, compilers, suffixes);
  const template = inputs.subject.kind === 'template' ? inputs.subject.template : assert.fail('a template report');
  const ledger = judge(inputs, await judgeFixtures(ROOT, template, registry));
  assert.deepEqual(forSigner(ledger).map((r) => [r.id, r.finding]), [
    ['morpho-oracle-cbbtc-usdc-86/address', { kind: 'few-confirmations', by: ['api'] }],
    ['morpho-oracle-usp-usdc/address', { kind: 'few-confirmations', by: ['api'] }],
    ['morpho-oracle-weeth-usdc-86/address', { kind: 'few-confirmations', by: ['api'] }],
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
  ]);
  const rows = addressRows(ledger);
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
