import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReader } from '../src/chain/reader.ts';
import { REPLAY_ENDPOINTS, recordingTransport, replayReader } from '../src/chain/recording.ts';
import type { Reader } from '../src/chain/reader.ts';
import type { Transport } from '../src/chain/rpc.ts';
import type { BlockRef, BlockTag } from '../src/chain/types.ts';
import { keccakCode } from '../src/contracts/code.ts';
import { MARKETS_PATH, REGISTRY_PATH, loadRegistry } from '../src/registry.ts';
import type { Registry } from '../src/registry.ts';
import { parseCoinGeckoCoins, parseDefiLlamaProtocols, sourcePagesOf } from '../src/research/listings.ts';
import { chainAt } from '../src/research/erc7730.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import {
  GENERATED_FILE,
  checkSpans,
  ReportError,
  entriesOf,
  signedEntryNames,
  erc7730Text,
  generatedPath,
  docsPaths,
  loadReport,
  reportDir,
  parseDocs,
  readDocs,
  pastTxsRecordings,
  readInstances,
  readToday,
  renderReport,
  reportFixtures,
  reportRecordingPath,
  summarizePastTxs,
} from '../src/research/report.ts';
import type { ReportInputs, ReportRecording, Subject } from '../src/research/report.ts';
import type { Page } from '../src/research/source-page.ts';
import { parseFunctionSignature } from '../src/decode/abi.ts';
import { STANDARDS } from '../src/research/standards.ts';
import { notesPath } from '../src/research/notes.ts';
import type { AbiProof } from '../src/contracts/prove.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { TEMPLATES_DIR, loadTemplate, parseTemplate } from '../src/template/template.ts';
import { reportedInstancesIn } from '../src/template/vault-reports.ts';
import { PREDATE_REPORT } from './predate-report.ts';
import { readRecording } from '../src/chain/bytecode.ts';
import { NO_SITE_LISTINGS } from '../src/research/site-listings.ts';
import { studyRecording } from '../src/research/past-txs-summary.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { repoWithBundler3Deposit } from './bundler3-deposit.ts';
import { FROZEN_REPORTS, repoWithFrozenReports } from './frozen-reports.ts';
import { BASE_DIR } from './repo-with-test-fixtures.ts';
import { parseRegistryAt } from './registry-at.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const suffixes = loadPublicSuffixList();
const ID = 'morpho/vault-deposit';
const TARGET = { template: ID, instance: 'steakhouse-prime-usdc-v2-0f51' };
const committed = loadReport(ROOT, registry, TARGET);
const committedRecording = readRecording(join(ROOT, reportRecordingPath(TARGET))) as ReportRecording;

/** The frozen deposit report, whose template nests calls in a Bundler3 bundle. */
const FROZEN = repoWithFrozenReports();
const FROZEN_TARGET = FROZEN_REPORTS[0];
const scoped = loadReport(FROZEN, loadRegistry(FROZEN), FROZEN_TARGET);
const recording = readRecording(join(FROZEN, reportRecordingPath(FROZEN_TARGET))) as ReportRecording;

/** The report with no ABI proofs, vault evidence or past transactions, which the replay test covers. */
function quick(
  pages: Readonly<Record<string, Page>> = recording.pages,
  abi: ReportInputs['abi'] = new Map(),
  subject: Subject = scoped.subject,
  vaults: ReportInputs['vaults'] = new Map(),
  pastTxs: ReportInputs['pastTxs'] = [],
  spans: ReportInputs['spans'] = new Map(),
  reg: Registry = scoped.registry,
  commits: ReportRecording['commits'] = recording.commits,
  today: ReportInputs['today'] = undefined,
  instances: ReportInputs['instances'] = undefined,
  fixtures: ReportInputs['fixtures'] = [],
): string {
  const inputs: ReportInputs = {
    subject,
    registry: reg,
    listings: { protocols: parseDefiLlamaProtocols(recording.defillama), coinsByAddress: parseCoinGeckoCoins(recording.coingecko), suffixes, sites: NO_SITE_LISTINGS },
    pages: sourcePagesOf({ pages, commits }),
    fetched: recording.fetched,
    abi,
    vaults,
    pastTxs,
    spans,
    today,
    instances,
    erc7730: { text: 'not read', reports: [] },
    facts: undefined,
    fixtures,
  };
  return renderReport(inputs, { command: 'test', sources: [] });
}

test('morpho/vault-deposit: rules name registry entries with full addresses, and every function has its page checked', () => {
  const text = quick();
  assert.match(text, /\| `approve\.spender` \| registry `general-adapter-1` `0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0` \|/);
  assert.match(text, /\| `to` \| the `asset` of the card's `vault`: one of `usdc` `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` \|/);
  assert.match(text, /\| `multicall\.bundle\[1\]\.data → erc4626Deposit\.receiver` \| the Safe \|/);
  assert.match(text, /\| `multicall\.bundle\[1\]\.data → erc4626Deposit\.maxSharePriceE27` \| at most assets × 1e27 \/ shares, with assets the card's `amount` and shares the card's `min-shares`/);
  assert.match(text, /\| `multicall` \| calls `multicall\(\(address,bytes,uint256,bool,bytes32\)\[\]\)`, selector `0x374f435d`; at most 12 bytes after the arguments/);
  assert.match(text, /\| `hyperithm-usdc-apex-v2-9e2f` \| `0x093272C07700d3cA5301C3Bf9B3A392624179E2F` \| asset `usdc` `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`; factory `vault-v2-factory`/);
  assert.match(text, /\| `multicall\(\(address,bytes,uint256,bool,bytes32\)\[\]\)` \| `bundler3` \| <https:\/\/github\.com\/morpho-org\/bundler3\/blob\/[0-9a-f]{40}\/src\/Bundler3\.sol> \| FINDING \| PASS \| PASS \|/);
  assert.match(text, /\| `erc4626Deposit\(address,uint256,uint256,address\)` \| `general-adapter-1` \| <https:\/\/github\.com\/morpho-org\/bundler3\/blob\/[0-9a-f]{40}\/src\/adapters\/GeneralAdapter1\.sol> \| FINDING \| PASS \| PASS \|/);
});

test('morpho/vault-deposit: the committed template approves VaultBundlesV1 the amount and deposits through it, with no permit, no fee and a price bound', () => {
  const text = quick(committedRecording.pages, new Map(), committed.subject, undefined, undefined, undefined, committed.registry, committedRecording.commits);
  assert.match(text, /\| `approve\.spender` \| registry `vault-bundles-v1` `0x02912516d49dE997db75B9D7858faAE59209650B` \|/);
  assert.match(text, /\| `approve\.value` \| the card's `amount`/);
  assert.match(text, /\| `vaultBundlesV1Deposit\.vault` \| the card's `vault`/);
  assert.match(text, /\| `vaultBundlesV1Deposit\.maxSharePriceE27` \| at most assets × 1e27 \/ shares, with assets the card's `amount` and shares the card's `min-shares`/);
  assert.match(text, /\| `vaultBundlesV1Deposit\.assetPermit\.kind` \| constant `0`/);
  assert.match(text, /\| `vaultBundlesV1Deposit\.referralFeePct` \| constant `0`/);
});

test('the report says what a computed field reads: the registry contract it calls, each argument, and the number it picks', () => {
  const raw = JSON.parse(readFileSync(join(FROZEN, TEMPLATES_DIR, ID, 'template.json'), 'utf8'));
  raw.card['min-shares'].computed.read = {
    to: { contract: 'fluid-fusdc' },
    function: 'quote(int128 i, uint256 dx, address who) returns (uint256 low, (uint256 shares, uint128 fee) best)',
    args: { i: { const: '-1' }, dx: { card: 'amount' }, who: { safe: true } },
    output: 'best.shares',
  };
  const subject: Subject = { ...scoped.subject, template: parseTemplate(raw, registry, 'committed') } as Subject;
  const text = quick(recording.pages, new Map(), subject);
  assert.match(text, /\| `min-shares` \| nothing: computed by `card new` in base units of the card's `vault`, `quote\(int128,uint256,address\)` on registry `fluid-fusdc` `0x[0-9a-fA-F]{40}` of constant `-1`, the card's `amount`, the Safe, its `best\.shares`, less 10 bps/);
  const named = (s: Subject) => entriesOf(s, registry).map((entry) => entry.name);
  assert.ok(!named(scoped.subject).includes('fluid-fusdc') && named(subject).includes('fluid-fusdc'), 'the contract the read calls is an entry the report checks');
  assert.ok(subject.kind === 'template' && !signedEntryNames(subject.template, registry).has('fluid-fusdc'), 'verify, which never makes the read, claims no code pin for it');
});

test('a contract field that names its protocol puts only that protocol\'s entries in the report', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, 'fluid', 'vault-deposit', 'template.json'), 'utf8'));
  const template = parseTemplate({ ...raw, card: { ...raw.card, vault: { kind: 'contract', registryKind: 'vault', defillama: 'fluid-lending' } } }, registry, 'committed');
  const subject: Subject = { kind: 'template', template, docs: [], vault: undefined, shared: new Set(), dir: join(TEMPLATES_DIR, template.id) };
  const vaults = entriesOf(subject, registry).filter((entry) => entry.kind === 'vault').map((entry) => entry.name);
  assert.deepEqual(vaults, ['fluid-fusdc', 'fluid-fusdt']);
  const text = quick(recording.pages, new Map(), subject, undefined, undefined, undefined, registry);
  assert.match(text, /\| `vault` \| a registry `vault` of the DefiLlama protocol `fluid-lending`, picked by number from the list below \|/);
  assert.ok(!text.includes('steakhouse-prime-usdc-v2-0f51'), 'no Morpho vault is listed');
});

test('a per-vault report joins its vault\'s docs.json with the template\'s, and refuses a function both name', () => {
  const { subject } = loadReport(ROOT, registry, { template: 'fluid/vault-deposit', instance: 'fluid-fusdt' });
  assert.deepEqual(subject.kind === 'template' ? subject.docs.map((d) => `${d.fn.signature} ${d.contract.name}`) : [], ['approve(address,uint256) usdt', 'deposit(uint256,address) fluid-fusdt']);
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-docs-'));
  const folder = join(root, TEMPLATES_DIR, 'fluid/vault-deposit');
  mkdirSync(join(folder, 'instances', 'fluid-fusdt'), { recursive: true });
  const page = { contract: 'fluid-fusdt', url: 'https://docs.fluid.io/' };
  const approve = { contract: 'usdt', url: 'https://etherscan.io/' };
  writeFileSync(join(folder, 'docs.json'), JSON.stringify({ 'deposit(uint256,address)': page }));
  writeFileSync(join(folder, 'instances', 'fluid-fusdt', 'docs.json'), JSON.stringify({ 'approve(address,uint256)': approve }));
  assert.deepEqual(readDocs(root, 'fluid/vault-deposit', 'fluid-fusdt'), { 'deposit(uint256,address)': page, 'approve(address,uint256)': approve });
  assert.deepEqual(readDocs(root, 'fluid/vault-deposit', 'fluid-fusdc'), { 'deposit(uint256,address)': page });
  writeFileSync(join(folder, 'instances', 'fluid-fusdt', 'docs.json'), JSON.stringify({ 'deposit(uint256,address)': page }));
  assert.throws(() => readDocs(root, 'fluid/vault-deposit', 'fluid-fusdt'), /instances\/fluid-fusdt\/docs\.json: "deposit\(uint256,address\)" is in the template's docs\.json too/);
  rmSync(join(folder, 'instances', 'fluid-fusdt', 'docs.json'));
  symlinkSync(join(folder, 'docs.json'), join(folder, 'instances', 'fluid-fusdt', 'docs.json'));
  assert.throws(() => readDocs(root, 'fluid/vault-deposit', 'fluid-fusdt'), /instances\/fluid-fusdt\/docs\.json: not a regular file/);
});

test('morpho/vault-deposit: the ERC-7730 section is computed again from the recorded descriptors and attestation reads', async () => {
  const snapshot = { commit: committedRecording.erc7730.commit, files: new Map(Object.entries(committedRecording.erc7730.files)) };
  const entries = entriesOf(committed.subject, committed.registry);
  const { text } = await erc7730Text(entries, committed.registry, snapshot, () => chainAt(replayReader(committedRecording.erc7730.chain)));
  assert.match(text, /^ERC-7730 registry github\.com\/ethereum\/clear-signing-erc7730-registry at commit [0-9a-f]{40}$/m);
  assert.match(text, /vault-bundles-v1 0x02912516d49dE997db75B9D7858faAE59209650B \(router\)\n {2}descriptor {3}registry\/morpho\/calldata-VaultBundlesV1\.json\n {2}applies {6}by exact address/);
  assert.match(
    text,
    /steakhouse-prime-usdc-v2-0f51 0xbeef088055857739C12CD3765F20b7679Def0f51 \(vault\)\n {2}descriptor {3}registry\/morpho\/calldata-steakhouse_financial-steakUSDC-v2-1\.json\n {2}applies {6}by exact address/,
  );
  const written = readFileSync(join(ROOT, generatedPath(ROOT, TARGET)), 'utf8');
  assert.ok(written.includes(text), `the shipped report.generated.md does not hold the section as computed; record it again with pnpm report ${ID} --instance-of ${TARGET.instance} --record`);
});

test("each entry's code pin prints with its implementation, and a proof of other code than the pin is a FINDING", async () => {
  const bundler3 = registry.entries.get('bundler3')!;
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  raw['usdc'].code = { hash: raw['usdc'].code.hash, implementation: raw['usdc'].code.implementation };
  const reg = parseRegistryAt(ROOT, raw);
  const usdc = reg.entries.get('usdc')!;
  const spans = await checkSpans(replayReader([]), [usdc]);
  const unranged = loadReport(FROZEN, reg, FROZEN_TARGET);
  assert.match(quick(recording.pages, new Map(), unranged.subject, undefined, undefined, spans, unranged.registry), new RegExp(`^\\| \`usdc\` \\| 0 \\| \`${usdc.code!.current.pin.hash}\` \\| \`0x43506849D7C04F9138D1A2050bbF3A0c054402dd\` \`${usdc.code!.current.pin.implementation!.hash}\` \\| pinned before ranges, not read \\|$`, 'm'));
  const bundle = { name: 'bundle', type: 'tuple[]', components: ['address to', 'bytes data', 'uint256 value', 'bool skipRevert', 'bytes32 callbackHash'].map((p) => ({ type: p.split(' ')[0], name: p.split(' ')[1] })) };
  const multicall = { type: 'function', name: 'multicall', inputs: [bundle] };
  const proof = (codeHash: Hex, abi: readonly object[] = [multicall]) =>
    ({ kind: 'proven', proxy: { kind: 'none' }, proven: bundler3.address, codeHash, contractName: 'Bundler3', compiler: '0.8.28', abi, immutablesMasked: 0, librariesMasked: 0, metadataHashMasked: false, block: { number: 1n } }) as unknown as AbiProof;
  const row = (codeHash: Hex, abi?: readonly object[]) => quick(recording.pages, new Map([[bundler3.address, proof(codeHash, abi)]])).split('\n').find((l) => l.startsWith('| `bundler3` |') && l.includes('PROVEN'))!;
  assert.match(row(bundler3.code!.current.pin.hash), /\| PASS \| PASS, all 1 \| 0 immutable/);
  assert.match(row(`0x${'00'.repeat(32)}` as Hex), /\| FINDING \| PASS, all 1 \| 0 immutable/);
  assert.match(row(bundler3.code!.current.pin.hash, []), /\| PASS \| FINDING: not in the ABI: `multicall\(\(address,bytes,uint256,bool,bytes32\)\[\]\)` \| 0 immutable/);
});

/** A chain where every registry address has no code before block 100, `early` from 100, and 0x6002 from 250 on. */
function chainReader(early: Hex): Reader {
  const codeAt = (n: bigint): Hex => (n < 100n ? '0x' : n < 250n ? early : '0x6002') as Hex;
  const agreed = <T>(value: T) => ({ kind: 'agreed', value, providers: ['alchemy', 'drpc'] }) as const;
  return {
    providers: ['alchemy', 'drpc'],
    block: async (tag: BlockTag) => agreed({ number: tag, hash: `0x${'00'.repeat(32)}` as Hex }),
    getCode: async (_address: Address, at: BlockRef) => agreed(codeAt(at.number)),
    getStorageAt: async () => agreed(`0x${'00'.repeat(32)}` as Hex),
  } as unknown as Reader;
}

test('the report prints every code span, and an earlier span whose code the chain did not run is a key finding', async () => {
  const forged = keccakCode('0x6066' as Hex);
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  raw['bundler3'].code = { hash: keccakCode('0x6002' as Hex), from: 250, earlier: [{ from: 100, hash: forged }] };
  const reg = parseRegistryAt(ROOT, raw);
  const { subject, registry: seen } = loadReport(FROZEN, reg, FROZEN_TARGET);
  const bundler3 = [reg.entries.get('bundler3')!];
  const report = async (early: Hex) => quick(recording.pages, new Map(), subject, undefined, undefined, await checkSpans(chainReader(early), bundler3), seen);
  const committed = await report('0x6066' as Hex);
  assert.match(committed, new RegExp(`^\\| \`bundler3\` \\| 100 \\| \`${forged}\` \\| none \\| PASS \\|\n\\| \`bundler3\` \\| 250 \\| \`${keccakCode('0x6002' as Hex)}\` \\| none \\| PASS \\|$`, 'm'));
  const forgedRun = await report('0x6001' as Hex);
  assert.match(forgedRun, new RegExp(`^\\| \`bundler3\` \\| 100 \\| .*\\| FINDING: block 100 runs \`${keccakCode('0x6001' as Hex)}\` \\|$`, 'm'));
  assert.match(forgedRun, new RegExp(`^\\| \`bundler3\` \\| 250 \\| .*\\| FINDING: block 249 runs \`${keccakCode('0x6001' as Hex)}\` \\|$`, 'm'));
  assertKeyFindings(committed, forgedRun, [
    ['bundler3/code.1', 'the chain ran other code than the registered code'],
    ['bundler3/code.2', 'the chain ran other code than the registered code'],
  ]);
});

/** `after` holds a key finding row for each of `found`, which `before` does not, and counts that many key findings more. */
function assertKeyFindings(before: string, after: string, found: readonly (readonly [string, string])[]): void {
  const count = (text: string) => Number(/^(\d+) key and \d+ reference findings?\.$/m.exec(text)?.[1]);
  assert.equal(count(after), count(before) + found.length);
  for (const [id, title] of found) {
    const row = `| \`${id}\` | key | ${title} |`;
    assert.ok(!before.split('\n').includes(row) && after.split('\n').includes(row), row);
  }
}

function withDependency(): Registry {
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  raw['liquidity'] = { address: `0x${'52'.repeat(20)}`, kind: 'lending', source: 'https://docs.example.org/liquidity', code: { hash: keccakCode('0x6002' as Hex), from: 250 } };
  raw['bundler3'] = { ...raw['bundler3'], dependsOn: ['liquidity'] };
  return parseRegistryAt(ROOT, raw);
}

const serving =
  (code: Hex): Transport =>
  async (_url, body) => {
    const { method } = JSON.parse(body) as { method: string };
    const result = method === 'eth_getCode' ? code : method === 'eth_getStorageAt' ? `0x${'00'.repeat(32)}` : undefined;
    return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
  };

test("the report reads at its latest block the code of an entry no ABI proof covers, from its recording too, and code the chain no longer runs is a key finding", async () => {
  const { subject, registry: seen } = loadReport(FROZEN, withDependency(), FROZEN_TARGET);
  const block: BlockRef = { number: 300n, hash: `0x${'30'.repeat(32)}` as Hex };
  const recorded = recordingTransport(serving('0x6002' as Hex), REPLAY_ENDPOINTS);
  const live = await readToday(createReader(REPLAY_ENDPOINTS, recorded.transport, { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] }), subject, seen, block);
  assert.deepEqual(await readToday(replayReader(recorded.exchanges()), subject, seen, block), live, 'the recorded reads give the same result');
  const committed = quick(recording.pages, new Map(), subject, undefined, undefined, undefined, seen, undefined, live);
  assert.match(committed, /^\| `liquidity` \| PASS \| 300 \|$/m);
  assert.match(committed, /^\| `liquidity` \| `0x5252525252525252525252525252525252525252` \| not proved: no call targets it and nothing the program reads is decoded with its ABI/m);
  const other = await readToday(createReader(REPLAY_ENDPOINTS, serving('0x6003' as Hex), { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] }), subject, seen, { ...block, number: 400n });
  const changed = quick(recording.pages, new Map(), subject, undefined, undefined, undefined, seen, undefined, other);
  assert.match(changed, new RegExp(`^\\| \`liquidity\` \\| FINDING: runs \`${keccakCode('0x6003' as Hex)}\` \\| 400 \\|$`, 'm'));
  assertKeyFindings(committed, changed, [['liquidity/code.today', 'the chain ran other code than the registered code']]);
  assert.equal(await readToday(replayReader([]), scoped.subject, scoped.registry, block), undefined, 'a report with no such entry reads nothing');
});

const IS_ADAPTER = '0x68c18beb';

/** Answers each `eth_call` true, but `isAdapter(address)` with `isAdapter`. */
const answering =
  (isAdapter: Hex): Transport =>
  async (_url, body) => {
    const { params } = JSON.parse(body) as { params: [{ data: string }] };
    const result = params[0].data.startsWith(IS_ADAPTER) ? isAdapter : `0x${'00'.repeat(31)}01`;
    return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
  };

test("the report asks an adapter's factory and the vault naming it, from its recording too, and a vault that no longer allocates through it is a key finding", async () => {
  const { subject, registry: seen } = loadReport(ROOT, registry, { template: 'morpho/vault-v2-revoke', instance: 'acuto-usdc-v2-4a57' });
  const block: BlockRef = { number: 300n, hash: `0x${'30'.repeat(32)}` as Hex };
  const options = { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] };
  const recorded = recordingTransport(answering(`0x${'00'.repeat(31)}01` as Hex), REPLAY_ENDPOINTS);
  const live = await readInstances(createReader(REPLAY_ENDPOINTS, recorded.transport, options), subject, seen, block);
  assert.deepEqual(await readInstances(replayReader(recorded.exchanges()), subject, seen, block), live, 'the recorded reads give the same result');
  const render = (instances: ReportInputs['instances']) => quick(recording.pages, new Map(), subject, undefined, undefined, undefined, seen, undefined, undefined, instances);
  const committed = render(live);
  assert.match(committed, /^\| `acuto-usdc-v2-4a57-market-adapter` \| `morpho-market-v1-adapter-v2-factory` `isMorphoMarketV1AdapterV2\(address\)` \| true \| 300 \|$/m);
  assert.match(committed, /^\| `acuto-usdc-v2-4a57-market-adapter` \| `acuto-usdc-v2-4a57` `isAdapter\(address\)` \| true \| 300 \|$/m);
  const removed = await readInstances(createReader(REPLAY_ENDPOINTS, answering(`0x${'00'.repeat(32)}` as Hex), options), subject, seen, { ...block, number: 400n });
  const denied = render(removed);
  assert.match(denied, /^\| `acuto-usdc-v2-4a57-market-adapter` \| `acuto-usdc-v2-4a57` `isAdapter\(address\)` \| REFUSED: acuto-usdc-v2-4a57 answered isAdapter\(address\) false for acuto-usdc-v2-4a57-market-adapter: it does not vouch for it \| 400 \|$/m);
  assertKeyFindings(committed, denied, [['acuto-usdc-v2-4a57-market-adapter/factory.1.isAdapter.acuto-usdc-v2-4a57', 'a check the factory declares says no']]);
  assert.doesNotMatch(render(undefined), /isAdapter/, 'a recording that predates the answers prints them as not read');
  assert.equal(await readInstances(replayReader([]), scoped.subject, scoped.registry, block), undefined, 'a report with no such entry reads nothing');
});

test('a selector-routed proxy a call targets is not provable, and the report reads its code and routes at the latest block', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  const implementation = `0x${'0a'.repeat(20)}`;
  raw['bundler3'] = {
    ...raw['bundler3'],
    routes: { implementationOf: 'getSigsImplementation(bytes4)', selectorsOf: 'getImplementationSigs(address)', seeds: ['0x00000001'] },
    code: { hash: raw['bundler3'].code.hash, routes: [{ address: implementation, hash: `0x${'0a'.repeat(32)}`, selectors: ['0x00000001'] }], from: 100 },
  };
  const { subject, registry: seen } = loadReport(FROZEN, parseRegistryAt(ROOT, raw), FROZEN_TARGET);
  const text = quick(recording.pages, new Map(), subject, undefined, undefined, undefined, seen);
  assert.match(text, /^\| `bundler3` \| `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` \| not provable: a selector-routed proxy, whose calls run in the implementations its routes reach; its routes are pinned above \|/m);
  assert.match(text, /^\| `bundler3` \| not read \| {2}\|$/m);
  assert.match(text, /^`bundler3` seeds: `0x00000001`\.$/m);
});

test('the report opens with every finding, key before reference, and a deployer no confirmed entry shares is n/a, not a finding', () => {
  const text = renderReport(
    {
      subject: scoped.subject,
      registry: scoped.registry,
      listings: { protocols: parseDefiLlamaProtocols(recording.defillama), coinsByAddress: parseCoinGeckoCoins(recording.coingecko), suffixes, sites: NO_SITE_LISTINGS },
      pages: sourcePagesOf(recording),
      fetched: recording.fetched,
      abi: new Map(),
      vaults: new Map(),
      pastTxs: [],
      spans: new Map(),
      today: undefined,
      instances: undefined,
      erc7730: { text: 'not read', reports: [] },
      facts: undefined,
      fixtures: [],
    },
    { command: 'test', sources: [] },
  );
  assert.match(text, /\| `usdc` \|[^\n]*\| n\/a: no confirmed entry shares `0x95Ba4cF87D6723ad9C0Db21737D862bE80e93911` \|\n/);
  const findings = text.slice(text.indexOf('## Findings'), text.indexOf('## Card'));
  const rows = [...findings.matchAll(/^\| `([^`]+)` \| (key|reference) \|/gm)].map((m) => [m[2], m[1]]);
  assert.ok(!rows.some(([, id]) => id === 'usdc/source.deployer'), 'a lone deployer is no finding');
  assert.ok(rows.some(([grade, id]) => grade === 'key' && id === 'usdc/abi'), 'a missing ABI proof is key');
  assert.ok(rows.some(([grade, id]) => grade === 'reference' && id === 'bundler3/source.deployer'), 'an unproven deployer is reference');
  assert.deepEqual(rows.map(([grade]) => grade), [...rows.map(([grade]) => grade)].sort(), 'key rows first');
  const count = (grade: string) => rows.filter(([g]) => g === grade).length;
  assert.match(findings, new RegExp(`^${count('key')} key and ${count('reference')} reference findings\\.`, 'm'));
  assert.ok(text.indexOf('## Findings') < text.indexOf('## Card'), 'the findings come before the card');
});

test('a page that does not name the function is a FINDING', () => {
  const pages = Object.fromEntries(Object.entries(recording.pages).map(([url, page]) => [url, url.endsWith('/src/Bundler3.sol') ? ({ kind: 'served', blocks: [] } as Page) : page]));
  assert.match(quick(pages), /\| `multicall\(.*\| <https:\/\/github\.com\/morpho-org\/bundler3\/blob\/[0-9a-f]{40}\/src\/Bundler3\.sol> \| FINDING \| PASS \| FINDING \|/);
});

test('a page that got no answer is UNVERIFIABLE, never a FINDING', () => {
  const pages = Object.fromEntries(Object.entries(recording.pages).map(([url, page]) => [url, url.endsWith('/src/Bundler3.sol') ? ({ kind: 'unread', why: `${url} answered HTTP 503` } as Page) : page]));
  assert.match(quick(pages), /\| `multicall\(.*\| <https:\/\/github\.com\/morpho-org\/bundler3\/blob\/[0-9a-f]{40}\/src\/Bundler3\.sol> \| FINDING \| PASS \| UNVERIFIABLE \|/);
});

test('the report prints no text from a page or a listing', () => {
  const text = quick();
  const foreign = [...recording.coingecko.flatMap((c) => [c.name, c.symbol]), ...recording.defillama.map((p) => p.name)].filter((t) => t.length > 0 && !/^[a-z0-9-]+$/.test(t));
  for (const t of foreign) assert.ok(!text.includes(t), `the report prints ${JSON.stringify(t)} from a listing`);
  const blocks = Object.values(recording.pages).flatMap((page) => (page.kind === 'served' ? page.blocks.map((b) => b.text) : []));
  for (const block of blocks) assert.ok(block.length < 40 || !text.includes(block), `the report prints page text ${JSON.stringify(block.slice(0, 60))}`);
});

test('docs.json names exactly the template\'s functions, each with a registry contract and an https URL, and nothing else', () => {
  const template = loadTemplate(FROZEN, ID, registry);
  const valid = JSON.parse(readFileSync(join(FROZEN, TEMPLATES_DIR, ID, 'docs.json'), 'utf8')) as Record<string, { contract: string; url: string }>;
  const refused = (raw: unknown) => assert.throws(() => parseDocs(raw, template, registry), ReportError);
  const without = Object.fromEntries(Object.entries(valid).slice(1));
  assert.throws(() => parseDocs(without, template, registry), /no page for approve\(address,uint256\)/);
  assert.throws(() => parseDocs({ ...valid, 'transfer(address,uint256)': valid['approve(address,uint256)'] }, template, registry), /"transfer\(address,uint256\)" is not a function the template calls/);
  const approve = valid['approve(address,uint256)']!;
  refused({ ...valid, 'approve(address,uint256)': { ...approve, note: 'trust this page' } });
  refused({ ...valid, 'approve(address,uint256)': { ...approve, url: 'http://example.org/approve' } });
  refused({ ...valid, 'approve(address,uint256)': { ...approve, contract: 'circle' } });
  assert.equal(parseDocs(valid, template, registry).length, 4);
});

const EVIL_URL = 'https://evil.example/approve>|PASS|n/a|PASS|<https://x';
/** The cells of a Markdown table row, split where GitHub splits them: at each `|` no backslash escapes. */
const cellsOf = (row: string): string[] => row.split(/(?<!\\)\|/).slice(1, -1);

test('a docs.json or registry URL holding a character outside RFC 3986, or one Markdown reads, is refused', () => {
  const template = loadTemplate(FROZEN, ID, registry);
  const valid = JSON.parse(readFileSync(join(FROZEN, TEMPLATES_DIR, ID, 'docs.json'), 'utf8')) as Record<string, { contract: string; url: string }>;
  const approve = valid['approve(address,uint256)']!;
  for (const url of [EVIL_URL, 'https://docs.example/`code`', 'https://docs.example/a b', 'https://docs.example/[x](https://y)', 'https://docs.example/a\\b']) {
    assert.throws(() => parseDocs({ ...valid, 'approve(address,uint256)': { ...approve, url } }, template, registry), /approve\(address,uint256\)\.url is not an https URL/, url);
  }
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8')) as Record<string, Record<string, unknown>>;
  assert.throws(() => parseRegistryAt(ROOT, { ...raw, usdc: { ...raw.usdc, source: EVIL_URL } }), /usdc\.source: not an https URL/);
  assert.equal(parseRegistryAt(ROOT, raw).entries.size, registry.entries.size);
});

test('text the AI wrote in the template prints escaped and labelled as written by the AI in the template', () => {
  const raw = JSON.parse(readFileSync(join(FROZEN, TEMPLATES_DIR, ID, 'template.json'), 'utf8')) as { calls: { trailer: { why: Record<string, string> } }[] };
  raw.calls[0]!.trailer.why = { en: 'harmless | PASS | `x` | *bold* _em_ [link](https://y) <b>', 'zh-TW': '無害' };
  const template = parseTemplate(raw, registry, 'committed');
  const docs = parseDocs(JSON.parse(readFileSync(join(FROZEN, TEMPLATES_DIR, ID, 'docs.json'), 'utf8')), template, registry);
  const text = quick(recording.pages, new Map(), { kind: 'template', template, docs, vault: undefined, shared: new Set(), dir: join(TEMPLATES_DIR, template.id) });
  const row = text.split('\n').find((l) => l.startsWith('| `approve` |'))!;
  assert.equal(cellsOf(row).length, 2, row);
  assert.ok(row.includes('written by the AI in the template: harmless \\| PASS \\| \\`x\\` \\| \\*bold\\* \\_em\\_ \\[link\\](https://y) \\<b\\>'), row);
  raw.calls[0]!.trailer.why = { en: 'pinged @maxey and $x^2$ and $$y$$', 'zh-TW': '無害' };
  const mention = parseTemplate(raw, registry, 'committed');
  const pinged = quick(recording.pages, new Map(), { kind: 'template', template: mention, docs, vault: undefined, shared: new Set(), dir: join(TEMPLATES_DIR, mention.id) }).split('\n').find((l) => l.startsWith('| `approve` |'))!;
  assert.ok(
    pinged.includes('pinged <span>@</span>maxey and <span>$</span>x^2<span>$</span> and <span>$</span><span>$</span>y<span>$</span><span>$</span>'),
    `GitHub links an @mention and renders $math$ even after a backslash, so each @ and $ sits alone in a span: ${pinged}`,
  );
  assert.ok(!quick().includes("the template's reason"), 'every template reason is labelled as written by the AI');
});

test('stored vault evidence holding a backtick or a character pnpm instance-evidence never prints is refused, and its section says it is stored', () => {
  const vault = FROZEN_TARGET.instance;
  const stored = recording.vaults[vault]!;
  assert.throws(() => quick(recording.pages, new Map(), undefined, new Map([[vault, `${stored}\n\`\`\`\n# Approved by the auditors`]])), ReportError);
  assert.throws(() => quick(recording.pages, new Map(), undefined, new Map([[vault, `${stored}\n<img src=x>`]])), ReportError);
  const text = quick(recording.pages, new Map(), undefined, new Map([[vault, stored]]));
  assert.match(text, /stored output of `pnpm instance-evidence`, not recomputed by `pnpm test`\.$/m);
  assert.ok(!/`pnpm test` writes it again/.test(text), 'the header does not claim pnpm test recomputes every section');
});

const NOT_GENERATED = /^\s*- \*\*Report not generated yet:\*\*(.*)$/m;

/** What is wrong with design.md's not-generated list, given the template folders and which hold a generated report. */
function notGeneratedProblems(design: string, folders: readonly string[], hasReport: (id: string) => boolean): string[] {
  const listed = [...(design.match(NOT_GENERATED)?.[1] ?? '').matchAll(/`([a-z0-9-]+\/[a-z0-9-]+)`/g)].map((m) => m[1]!);
  return [
    ...folders.flatMap((id) => {
      const has = hasReport(id);
      if (has === listed.includes(id)) return [has ? `${id} has ${GENERATED_FILE}; take it off design.md's not-generated list` : `${id} has no ${GENERATED_FILE}; run \`pnpm report ${id} --record\``];
      return [];
    }),
    ...listed.flatMap((id) => (folders.includes(id) ? [] : [`design.md lists ${id}, which is not a template folder`])),
    ...listed.flatMap((id) => (PREDATE_REPORT.has(id) ? [] : [`design.md lists ${id} as not generated yet, but only templates older than the generated report may be listed`])),
  ];
}

test('every template folder holds report.generated.md, or design.md lists it among the templates that predate the report', () => {
  const design = readFileSync(join(ROOT, 'docs', 'design', 'flow.md'), 'utf8');
  const folders = readdirSync(join(ROOT, TEMPLATES_DIR)).flatMap((protocol) => readdirSync(join(ROOT, TEMPLATES_DIR, protocol)).map((operation) => `${protocol}/${operation}`));
  const hasReport = (id: string) => existsSync(join(ROOT, TEMPLATES_DIR, id, GENERATED_FILE)) || reportedInstancesIn(ROOT, id).size > 0;
  assert.deepEqual(notGeneratedProblems(design, folders, hasReport), []);
  const added = design.replace(/(- \*\*Report not generated yet:\*\* )/, '$1`aave/supply`, ');
  assert.deepEqual(notGeneratedProblems(added, [...folders, 'aave/supply'], (id) => id !== 'aave/supply' && hasReport(id)), [
    'design.md lists aave/supply as not generated yet, but only templates older than the generated report may be listed',
  ]);
});

test('a test transaction the template no longer matches is a key row of the Findings', async () => {
  const raw = JSON.parse(readFileSync(join(FROZEN, TEMPLATES_DIR, ID, 'template.json'), 'utf8'));
  raw.calls[0].args.value = { const: '1' };
  const subject = { ...scoped.subject, template: parseTemplate(raw, registry, 'committed') } as Subject;
  const fixtures = await reportFixtures(FROZEN, subject, registry);
  const text = quick(recording.pages, new Map(), subject, new Map(), [], new Map(), scoped.registry, recording.commits, undefined, undefined, fixtures);
  const rows = text.split('\n').filter((line) => line.startsWith('| `fixture.'));
  assert.ok(fixtures.length > 0, 'the template has recorded test transactions');
  assert.deepEqual(rows, fixtures.map((f) => `| \`fixture.${f.name}\` | key | the test transaction is judged differently now |`));
});

test('a function its official page no longer shows is a key finding', () => {
  const pages = Object.fromEntries(Object.entries(recording.pages).map(([url, page]) => [url, url.endsWith('/src/Bundler3.sol') ? ({ kind: 'served', blocks: [] } as Page) : page]));
  const [before, after] = [quick(), quick(pages)];
  assert.match(after, /^\| `multicall\(\(address,bytes,uint256,bool,bytes32\)\[\]\)` \|.*\| FINDING \|/m);
  assertKeyFindings(before, after, [['bundler3/doc.0x374f435d.page', 'function not found on the docs page']]);
});

test("docs.json's contract must be the call's target when the template binds the target", () => {
  const template = loadTemplate(FROZEN, ID, registry);
  const valid = JSON.parse(readFileSync(join(FROZEN, TEMPLATES_DIR, ID, 'docs.json'), 'utf8')) as Record<string, { contract: string; url: string }>;
  const swap = (sig: string, contract: string) => ({ ...valid, [sig]: { ...valid[sig]!, contract } });
  assert.throws(() => parseDocs(swap('erc4626Deposit(address,uint256,uint256,address)', 'bundler3'), template, registry), /erc4626Deposit\(address,uint256,uint256,address\)\.contract is bundler3, but the template calls it on general-adapter-1/);
  assert.throws(() => parseDocs(swap('multicall((address,bytes,uint256,bool,bytes32)[])', 'general-adapter-1'), template, registry), /calls it on bundler3/);
  assert.throws(() => parseDocs(swap('approve(address,uint256)', 'bundler3'), template, registry), /calls it on one of usdc, usdt/);
  assert.equal(parseDocs(swap('approve(address,uint256)', 'usdt'), template, registry).length, 4);
  assert.match(quick(), /\| Function \| Contract \| Page \| Site \| GitHub commit \| Function on page \|/);
});

test('docs.json may name the ERC-20 standard for a function it defines on a token, and the report names the standard page', () => {
  const template = loadTemplate(FROZEN, ID, registry);
  const valid = JSON.parse(readFileSync(join(FROZEN, TEMPLATES_DIR, ID, 'docs.json'), 'utf8')) as Record<string, unknown>;
  const standard = (sig: string, value: object) => parseDocs({ ...valid, [sig]: value }, template, registry);
  const docs = standard('approve(address,uint256)', { contract: 'usdt', standard: 'erc-20' });
  const approve = docs.find((d) => d.fn.signature === 'approve(address,uint256)')!;
  assert.equal(approve.url, 'https://github.com/ethereum/ERCs/blob/ae65e89408f387ffb47d220879925c4ab384dfc2/ERCS/erc-20.md');
  assert.throws(() => standard('approve(address,uint256)', { contract: 'usdt', standard: 'erc-20', url: 'https://tether.to/' }), /must hold exactly contract and url, or contract and standard/);
  for (const name of ['erc-777', '__proto__', 'toString', 42, ['erc-20']]) {
    assert.throws(() => standard('approve(address,uint256)', { contract: 'usdt', standard: name }), /approve\(address,uint256\)\.standard is not one of erc-20/, String(name));
  }
  assert.throws(() => standard('approve(address,uint256)', { contract: 'bundler3', standard: 'erc-20' }), /contract bundler3 is a router; ERC-20 applies to token and vault entries/);
  assert.throws(() => standard('erc20TransferFrom(address,address,uint256)', { contract: 'general-adapter-1', standard: 'erc-20' }), /contract general-adapter-1 is a adapter; ERC-20 applies to token and vault entries/);
  assert.throws(() => standard('approve(address,uint256)', { contract: 'steakhouse-prime-usdc-v2-0f51', standard: 'erc-20' }), /calls it on one of usdc, usdt/);

  const page = { kind: 'served', blocks: [{ text: 'function approve(address _spender, uint256 _value) public returns (bool success)' }] } as Page;
  const pages = { ...recording.pages, 'https://raw.githubusercontent.com/ethereum/ERCs/ae65e89408f387ffb47d220879925c4ab384dfc2/ERCS/erc-20.md': page };
  const commits = { ...recording.commits, 'ethereum/ercs@ae65e89408f387ffb47d220879925c4ab384dfc2': { kind: 'on-default', branch: 'master', status: 'identical' } } as const;
  const text = quick(pages, new Map(), { kind: 'template', template, docs, vault: undefined, shared: new Set(), dir: join(TEMPLATES_DIR, template.id) }, new Map(), [], new Map(), scoped.registry, commits);
  const row = text.split('\n').find((l) => l.startsWith('| `approve(address,uint256)` |'))!;
  assert.deepEqual(cellsOf(row).map((c) => c.trim()), [
    '`approve(address,uint256)`',
    '`usdt`',
    'ERC-20 standard page <https://github.com/ethereum/ERCs/blob/ae65e89408f387ffb47d220879925c4ab384dfc2/ERCS/erc-20.md>',
    'PASS',
    'PASS',
    'PASS',
  ]);
  assert.match(text, /^`approve\(address,uint256\)` on `usdt`: the ERC-20 standard defines this function, as `function approve\(address _spender, uint256 _value\)`; this does not show that the contract follows the standard\.$/m);
});

test("each declaration the program holds names the function's canonical signature, or for a YAML entry its name", () => {
  for (const standard of STANDARDS.values()) {
    for (const [signature, declaration] of standard.declarations) {
      const yaml = /^- name: (\w+)$/.exec(declaration);
      if (yaml !== null) assert.equal(yaml[1], signature.slice(0, signature.indexOf('(')), declaration);
      else assert.equal(parseFunctionSignature(declaration.replace(/^function /, '')).signature, signature, declaration);
    }
  }
});

test('docs.json may name ERC-4626 for a vault function, and WETH9 only for WETH itself, each checked against its own page and org', () => {
  const fluid = loadTemplate(ROOT, 'fluid/vault-deposit', registry);
  const valid = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, 'fluid/vault-deposit', 'instances', 'fluid-fusdt', 'docs.json'), 'utf8')) as Record<string, unknown>;
  const named = (standard: string, contract = 'fluid-fusdt') => parseDocs({ ...valid, 'deposit(uint256,address)': { contract, standard } }, fluid, registry);
  const docs = named('erc-4626');
  const deposit = docs.find((d) => d.fn.signature === 'deposit(uint256,address)')!;
  assert.equal(deposit.url, 'https://github.com/ethereum/ERCs/blob/ae65e89408f387ffb47d220879925c4ab384dfc2/ERCS/erc-4626.md');
  assert.throws(() => named('weth9'), /contract fluid-fusdt is not WETH9, which is the one contract at 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2/);
  assert.throws(() => parseDocs({ ...valid, 'approve(address,uint256)': { contract: 'usdt', standard: 'erc-4626' } }, fluid, registry), /contract usdt is a token; ERC-4626 applies to vault entries/);
  assert.throws(() => parseDocs({ ...valid, 'approve(address,uint256)': { contract: 'usdt', standard: 'weth9' } }, fluid, registry), /contract usdt is not WETH9/);

  const raw = 'https://raw.githubusercontent.com/ethereum/ERCs/ae65e89408f387ffb47d220879925c4ab384dfc2/ERCS/erc-4626.md';
  const commits = { ...recording.commits, 'ethereum/ercs@ae65e89408f387ffb47d220879925c4ab384dfc2': { kind: 'on-default', branch: 'master', status: 'identical' } } as const;
  const onPage = (blocks: Extract<Page, { kind: 'served' }>['blocks']) => {
    const text = quick({ ...recording.pages, [raw]: { kind: 'served', blocks } as Page }, new Map(), { kind: 'template', template: fluid, docs, vault: undefined, shared: new Set(), dir: join(TEMPLATES_DIR, fluid.id) }, new Map(), [], new Map(), registry, commits);
    return cellsOf(text.split('\n').find((l) => l.startsWith('| `deposit(uint256,address)` |'))!).map((c) => c.trim());
  };
  assert.deepEqual(onPage([{ text: '#### deposit' }, { text: '- name: deposit', heading: 'deposit' }]), [
    '`deposit(uint256,address)`',
    '`fluid-fusdt`',
    `ERC-4626 standard page <${deposit.url}>`,
    'PASS',
    'PASS',
    'PASS',
  ]);
  assert.equal(onPage([{ text: '#### deposit' }, { text: 'deposit(uint256 assets, address receiver)' }]).at(-1), 'FINDING');
  assert.equal(onPage([{ text: '- name: deposits' }]).at(-1), 'FINDING', 'a declaration is not found inside a longer name');
});

test('a recorded trace drpc gave no readable answer for counts the transaction as not checked', async () => {
  const BUNDLER3 = repoWithBundler3Deposit();
  const file = 'testdata/research/morpho-vault-deposit.json';
  const past = readRecording<PastTxsRecording>(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit.json'));
  const plain = summarizePastTxs(BUNDLER3, registry, file, await studyRecording(BUNDLER3, past, registry));
  const exact = plain.run.studies.find((s) => s.kind === 'fit' && s.outside.length === 0) ?? assert.fail('a transaction exactly the template');
  const traced = { ...past, traces: [{ hash: exact.hash, unreadable: 'recorded' }] };
  const recorded = summarizePastTxs(BUNDLER3, registry, file, await studyRecording(BUNDLER3, traced, registry));
  assert.match(recorded.text, /call traces, from drpc, of the transactions exactly the template: 1 transaction, 0 checked/);
});

test('a recording that keeps its head block is studied again from it, and the command the report prints searches its windows again with --same-windows-as', async () => {
  const BUNDLER3 = repoWithBundler3Deposit();
  const { subject } = scoped;
  const file = 'testdata/research/morpho-vault-deposit-windows.json';
  const past = readRecording<PastTxsRecording>(join(ROOT, 'testdata', 'past-txs', 'morpho-vault-deposit-windows.json'));
  const head = await replayReader(past.exchanges).blockNumber();
  assert.equal(head.kind, 'agreed');
  const kept = { ...past, query: { ...past.query, head: String(head.kind === 'agreed' ? head.value : '') }, exchanges: past.exchanges.filter((e) => e.method !== 'eth_blockNumber') };
  const before = summarizePastTxs(BUNDLER3, registry, file, await studyRecording(BUNDLER3, past, registry));
  const after = summarizePastTxs(BUNDLER3, registry, file, await studyRecording(BUNDLER3, kept, registry));
  assert.equal(after.text, before.text);
  const command = (text: string) => text.split('\n').find((line) => line.includes(`--record ${file.replace(/^.*\//, '').replace(/\.json$/, '')}`));
  const name = file.replace(/^.*\//, '').replace(/\.json$/, '');
  assert.doesNotMatch(command(quick(undefined, undefined, subject, undefined, [before])) ?? '', /--same-windows-as/);
  assert.match(command(quick(undefined, undefined, subject, undefined, [after])) ?? '', new RegExp(` --max-txs ${past.query.maxTxs} --same-windows-as ${name} --record ${name}`));
});

test('a market field lists every market with its id, lltv and parts, binds each MarketParams part, and prints the views read', () => {
  const contracts = JSON.parse(readFileSync(join(BASE_DIR, REGISTRY_PATH), 'utf8'));
  const source = 'https://docs.morpho.org/get-started/resources/addresses';
  const added = {
    'morpho-blue': { address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', kind: 'lending', source },
    cbbtc: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', kind: 'token', source },
    'morpho-oracle-cbbtc-usdc-86': { address: '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a', kind: 'oracle', source },
    'adaptive-curve-irm': { address: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', kind: 'irm', source },
  };
  const id = '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64';
  const reg = parseRegistryAt(BASE_DIR, { ...contracts, ...added }, {
    'usdc-cbbtc-86': { lending: 'morpho-blue', loanToken: 'usdc', collateralToken: 'cbbtc', oracle: 'morpho-oracle-cbbtc-usdc-86', irm: 'adaptive-curve-irm', lltv: '860000000000000000', id },
  });
  const template = parseTemplate(
    {
      id: 'morpho/market-supply',
      card: { market: { kind: 'market' }, amount: { kind: 'amount', of: 'market.loanToken' } },
      calls: [
        {
          to: { card: 'market.lending' },
          value: { const: '0' },
          function: 'supply((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data)',
          args: { marketParams: { card: 'market' }, assets: { card: 'amount' }, shares: { const: '0' }, onBehalf: { safe: true }, data: { const: '0x' } },
        },
      ],
      effects: {
        gives: [{ token: 'card.market.loanToken', amount: 'card.amount' }],
        gets: [],
        views: [
          {
            to: { contract: 'morpho-blue' },
            function: 'position(bytes32 id, address user) returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
            args: { id: { card: 'market.id' }, user: { safe: true } },
            change: { supplyShares: 'increases', borrowShares: 'same' },
          },
        ],
      },
    },
    reg,
    'committed',
  );
  const subject: Subject = { kind: 'template', template, docs: [], vault: undefined, shared: new Set(), dir: join(TEMPLATES_DIR, template.id) };
  const text = quick(recording.pages, new Map(), subject, new Map(), [], new Map(), reg);
  const full = (name: keyof typeof added) => `\`${name}\` \`${added[name].address}\``;
  const usdc = '`usdc` `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`';
  assert.ok(text.includes('| `market` | a market from `registry/markets.json`, picked by number from the list below |'));
  assert.ok(
    text.includes(
      `| \`usdc-cbbtc-86\` | \`${id}\` | 860000000000000000 | lending ${full('morpho-blue')}; loanToken ${usdc}; collateralToken ${full('cbbtc')}; oracle ${full('morpho-oracle-cbbtc-usdc-86')}; irm ${full('adaptive-curve-irm')} |`,
    ),
  );
  assert.ok(text.includes(`| \`supply.marketParams.oracle\` | the \`oracle\` of the card's \`market\`: one of ${full('morpho-oracle-cbbtc-usdc-86')} |`));
  assert.ok(text.includes("| `supply.marketParams.lltv` | the `lltv` of the card's `market` |"));
  assert.ok(
    text.includes(
      `| registry ${full('morpho-blue')} | \`position(bytes32,address)\`, selector \`0x93c52062\`, returns \`(uint256 supplyShares, uint128 borrowShares, uint128 collateral)\` | \`id\` the \`id\` of the card's \`market\`; \`user\` the Safe | \`supplyShares\` increases; \`borrowShares\` same |`,
    ),
  );
  assert.deepEqual(
    entriesOf(subject, reg).map((e) => e.name),
    ['usdc', 'cbbtc', 'morpho-blue', 'adaptive-curve-irm', 'morpho-oracle-cbbtc-usdc-86'],
  );
});

test('a template whose card names a vault is reported per vault: without the vault, with another template, or with a vault the field refuses, it is refused', () => {
  const refused = (target: Parameters<typeof loadReport>[2], message: string) => assert.throws(() => loadReport(ROOT, registry, target), (e: unknown) => e instanceof ReportError && e.message === message);
  refused({ template: ID }, 'morpho/vault-deposit is reported per vault; name the vault (reports exist for hyperithm-usdc-apex-v2-9e2f, steakhouse-prime-usdc-v2-0f51)');
  refused({ template: 'eth/transfer', instance: 'steakhouse-prime-usdc-v2-0f51' }, 'eth/transfer has one report, not one per vault; leave out the vault');
  refused({ template: ID, instance: 'fluid-fusdc' }, "fluid-fusdc is not a vault the card's vault of morpho/vault-deposit accepts");
  refused({ template: ID, instance: 'bundler3' }, "bundler3 is not a vault the card's vault of morpho/vault-deposit accepts");
});

test('--instance-of writes a new instance\'s report to instances/, and its notes and docs are read from there', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-instances-'));
  try {
    const target = { template: 'fluid/vault-deposit', instance: 'fluid-fusdt' };
    const folder = join(TEMPLATES_DIR, 'fluid/vault-deposit', 'instances', 'fluid-fusdt');
    assert.equal(reportDir(root, target), folder);
    assert.equal(generatedPath(root, target), join(folder, GENERATED_FILE));
    assert.equal(notesPath(root, target.template, target.instance), join(folder, 'notes.json'));
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'docs.json'), '{}');
    assert.deepEqual(docsPaths(root, target.template, target.instance), [join(TEMPLATES_DIR, 'fluid/vault-deposit', 'docs.json'), join(folder, 'docs.json')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const text = quick(committedRecording.pages, new Map(), committed.subject, new Map([[TARGET.instance, committedRecording.vaults[TARGET.instance]!]]));
  assert.match(text, /stored as `pnpm instance-evidence` printed it/);
  assert.match(text, /the stored output of `pnpm instance-evidence`/);
});

test('an instance whose committed report is in instances/ is found there, with its notes beside it', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-instances-'));
  try {
    const target = { template: 'fluid/vault-deposit', instance: 'fluid-fusdt' };
    const folder = join(TEMPLATES_DIR, 'fluid/vault-deposit', 'instances', 'fluid-fusdt');
    mkdirSync(join(root, folder), { recursive: true });
    assert.deepEqual([...reportedInstancesIn(root, target.template).keys()], [], 'a folder with no report holds no report');
    writeFileSync(join(root, folder, GENERATED_FILE), '# report\n');
    assert.deepEqual([...reportedInstancesIn(root, target.template).keys()], [target.instance]);
    assert.equal(reportDir(root, target), folder);
    assert.equal(generatedPath(root, target), join(folder, GENERATED_FILE));
    assert.equal(notesPath(root, target.template, target.instance), join(folder, 'notes.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(generatedPath(ROOT, TARGET), join(TEMPLATES_DIR, ID, 'instances', TARGET.instance, GENERATED_FILE));
  assert.equal(committed.subject.dir, join(TEMPLATES_DIR, ID, 'instances', TARGET.instance));
});

test('pnpm report refuses --vault-of and --vault, naming --instance-of', () => {
  for (const [flag, value] of [['--vault-of', TARGET.instance], ['--vault', 'steakhouse-high-yield-usdc-v2-a757']] as const) {
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'report.ts'), ...(flag === '--vault' ? [] : [ID]), flag, value, '--offline'], { encoding: 'utf8' });
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stderr.trim(), `REFUSED  ${flag} was removed; name an instance's report with <protocol>/<operation> --instance-of <instance>`);
  }
});

test('pnpm report --render and --offline print why a report is refused, not a stack trace', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'kiss-sign-refused-'));
  try {
    const copied = ['src', 'scripts', 'registry', 'templates'];
    for (const name of readdirSync(ROOT)) if (!['.git', '.cache', 'testdata', ...copied].includes(name)) symlinkSync(join(ROOT, name), join(sandbox, name));
    for (const name of copied) cpSync(join(ROOT, name), join(sandbox, name), { recursive: true });
    cpSync(join(ROOT, 'testdata', 'report', 'eth-transfer.json'), join(sandbox, 'testdata', 'report', 'eth-transfer.json'));
    for (const name of readdirSync(join(ROOT, 'testdata'))) if (name !== 'report') symlinkSync(join(ROOT, 'testdata', name), join(sandbox, 'testdata', name));
    const folder = join(sandbox, TEMPLATES_DIR, 'eth', 'transfer');
    rmSync(join(folder, 'trace-addresses.json'), { force: true });
    const rewrite = (path: string, change: object) => writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...change }));
    const report = (mode: string) => spawnSync(process.execPath, [join(sandbox, 'scripts', 'report.ts'), 'eth/transfer', mode], { cwd: sandbox, encoding: 'utf8' });

    const recording = join(sandbox, 'testdata', 'report', 'eth-transfer.json');
    rewrite(recording, { fetched: '2026-11-25' });
    rewrite(join(folder, 'notes.json'), { summary: undefined });
    const notes = report('--render');
    assert.deepEqual([notes.status, notes.stderr.trim()], [2, 'REFUSED  notes.json: summary is missing']);

    rewrite(recording, { fetched: '2026-11-26' });
    for (const mode of ['--render', '--offline']) {
      const traces = report(mode);
      assert.equal(traces.status, 2, traces.stderr);
      assert.match(traces.stderr, /^REFUSED  no call trace counts \(0 traced[^\n]*\n$/);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('a per-vault report refuses a registry whose kept entry depends on another vault the field accepts', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  raw['vault-bundles-v1'] = { ...raw['vault-bundles-v1'], dependsOn: ['hyperithm-usdc-apex-v2-9e2f'] };
  assert.throws(
    () => loadReport(ROOT, parseRegistryAt(ROOT, raw), TARGET),
    (e: unknown) => e instanceof ReportError && e.message === 'hyperithm-usdc-apex-v2-9e2f is another vault the field accepts, but a registry entry the report keeps names it',
  );
});

test("a per-vault report shows that vault alone: no other vault, no asset or factory only another vault names, and only past searches anchored on its token", () => {
  const kept = ['usdc', 'bundler3', 'vault-v2-factory', 'general-adapter-1', FROZEN_TARGET.instance];
  assert.deepEqual(entriesOf(scoped.subject, scoped.registry).map((e) => e.name), kept);
  const frozen = loadRegistry(FROZEN);
  const others = [...frozen.entries.values()].filter((e) => e.kind === 'vault' && e.name !== FROZEN_TARGET.instance && e.defillama !== 'fluid-lending');
  const onlyOthers = [...new Set(others.flatMap((vault) => Object.values(vault.attributes)))].filter((name) => !kept.includes(name)).map((name) => frozen.entries.get(name)!);
  assert.ok(onlyOthers.some((e) => e.name === 'usdt') && onlyOthers.some((e) => e.name === 'metamorpho-factory-v1-0'), 'an asset and a factory only another vault names');
  const text = quick();
  for (const entry of [...others, ...onlyOthers]) assert.ok(!text.includes(`\`${entry.name}\``) && !text.toLowerCase().includes(entry.address), `${entry.name} appears in the report`);

  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-anchored-'));
  try {
    for (const dir of [TEMPLATES_DIR, 'registry', ...readdirSync(join(FROZEN, 'testdata')).map((name) => join('testdata', name))]) cpSync(join(FROZEN, dir), join(root, dir), { recursive: true, dereference: true });
    const elsewhere = join(root, 'testdata', 'research', 'morpho-vault-deposit-other-vault.json');
    const recordingOf = JSON.parse(readFileSync(join(root, 'testdata', 'research', 'morpho-vault-deposit-v2.json'), 'utf8'));
    writeFileSync(elsewhere, JSON.stringify({ ...recordingOf, query: { ...recordingOf.query, token: others[0]!.address } }));
    const anchored = pastTxsRecordings(root, scoped.subject).map((r) => r.file);
    assert.deepEqual(anchored, ['testdata/research/morpho-vault-deposit-v2-early.json', 'testdata/research/morpho-vault-deposit-v2.json']);
    assert.ok(pastTxsRecordings(root, { ...scoped.subject, vault: undefined }).some((r) => r.file === 'testdata/research/morpho-vault-deposit-other-vault.json'), 'the template has a search anchored on another vault');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the shipped steakhouse-prime-usdc-v2-0f51 deposit report names its own vault and parts alone', () => {
  const command = `pnpm report ${ID} --instance-of ${TARGET.instance} --record`;
  const kept = ['usdc', TARGET.instance, 'vault-v2-factory', 'vault-bundles-v1'];
  const text = readFileSync(join(ROOT, generatedPath(ROOT, TARGET)), 'utf8');
  for (const name of kept) assert.ok(text.includes(`\`${name}\``), `${name} is not in the shipped report; record it again with ${command}`);
  const others = [...registry.entries.values()].filter((e) => e.kind === 'vault' && e.name !== TARGET.instance && e.defillama !== 'fluid-lending');
  const onlyOthers = [...new Set(others.flatMap((vault) => Object.values(vault.attributes)))].filter((name) => !kept.includes(name)).map((name) => registry.entries.get(name)!);
  for (const entry of [...others, ...onlyOthers]) {
    assert.ok(!text.includes(`\`${entry.name}\``) && !text.toLowerCase().includes(entry.address), `${entry.name} appears in the shipped report; record it again with ${command}`);
  }
  assert.match(text, /^\| `vault` \| a registry `vault` of the DefiLlama protocol `morpho-blue`, picked by number from the list below \|$/m);
  assert.deepEqual(pastTxsRecordings(ROOT, committed.subject).map((r) => r.file), ['testdata/research/morpho-vault-deposit-steakhouse-prime-usdc-v2-0f51.json'], `the shipped report studies these searches; record it again with ${command}`);
  assert.match(text, /^Written by `pnpm report morpho\/vault-deposit --instance-of steakhouse-prime-usdc-v2-0f51 --record` /m);
});

test("a signed message's answer is shown on its digest's row: where the message sits, and each member read elsewhere or in hex", () => {
  const cow = loadReport(ROOT, registry, { template: 'cow/swap' });
  assert.equal(cow.subject.kind, 'template');
  const raw = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, 'cow/swap', 'template.json'), 'utf8'));
  const rule = raw.calls.at(-1).args.orderUid.packed[0].rule.eip712;
  const plain = quick(recording.pages, new Map(), cow.subject, new Map(), [], new Map(), cow.registry);
  assert.match(plain, /the message is read from https:\/\/api\.cow\.fi\/mainnet\/api\/v1\/orders\/<argument> and must hash to this digest/);
  rule.answer = { path: ['data', 'order'], members: { sellAmount: { path: ['amounts', 'sell'], encoding: 'hex' } } };
  const subject = { ...(cow.subject as Extract<Subject, { kind: 'template' }>), template: parseTemplate(raw, cow.registry, 'committed') };
  const nested = quick(recording.pages, new Map(), subject, new Map(), [], new Map(), cow.registry);
  assert.match(nested, /the message is read from https:\/\/api\.cow\.fi\/mainnet\/api\/v1\/orders\/<argument> under `data\.order`, `sellAmount` at `data\.order\.amounts\.sell` in hex and must hash to this digest/);
});

const RLUSD_ENTRIES = {
  rlusd: { address: '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD', kind: 'token', source: 'https://docs.ripple.com/products/stablecoin/overview/token-addresses' },
  kbtc: { address: '0x73E0C0d45E048D25Fc26Fa3159b0aA04BfA4Db98', kind: 'token', source: 'https://support.kraken.com/articles/what-is-kbtc' },
  'morpho-oracle-kbtc-rlusd-86': { address: '0xBCC3D9834b84B32Cf540DBE948DEd4B47bec5ddb', kind: 'oracle', source: 'https://app.morpho.org/ethereum/variable' },
};
const RLUSD_MARKET = {
  'rlusd-kbtc-86': {
    lending: 'morpho-blue',
    loanToken: 'rlusd',
    collateralToken: 'kbtc',
    oracle: 'morpho-oracle-kbtc-rlusd-86',
    irm: 'adaptive-curve-irm',
    lltv: '860000000000000000',
    id: '0x15bb2a6af0c909eed19fb1f2ceeead34ecbdcba626de752c6b09389ee14eec32',
  },
};

test("a per-instance report names only the markets that can share the address same asks of its instance; the template's own report names every market", () => {
  const contracts = { ...JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8')), ...RLUSD_ENTRIES };
  const usdcMarkets = JSON.parse(readFileSync(join(ROOT, MARKETS_PATH), 'utf8'));
  const both = parseRegistryAt(ROOT, contracts, { ...usdcMarkets, ...RLUSD_MARKET });
  const target = { template: 'morpho/vault-v2-cap-submit', instance: 'kpk-usdc-prime-v2-9ee6' };
  const { subject, registry: seen } = loadReport(ROOT, both, target);
  const text = quick(recording.pages, new Map(), subject, new Map(), [], new Map(), seen);
  for (const name of Object.keys(usdcMarkets)) assert.ok(text.includes(`| \`${name}\` |`), `${name} is not listed`);
  for (const name of ['rlusd-kbtc-86', 'rlusd', 'kbtc', 'morpho-oracle-kbtc-rlusd-86']) assert.ok(!text.includes(`\`${name}\``), `${name} appears in the report`);
  assert.ok(!entriesOf(subject, seen).some((entry) => entry.name === 'morpho-oracle-kbtc-rlusd-86'));
  assert.ok(!signedEntryNames(subject.template, seen).has('morpho-oracle-kbtc-rlusd-86'));

  const whole = quick(recording.pages, new Map(), { ...subject, vault: undefined }, new Map(), [], new Map(), both);
  assert.ok(whole.includes('| `rlusd-kbtc-86` |') && whole.includes('| `usdc-cbbtc-86` |'));

  assert.throws(
    () => loadReport(ROOT, parseRegistryAt(ROOT, contracts, RLUSD_MARKET), target),
    (e: unknown) => e instanceof ReportError && e.message === 'market: no market in registry/markets.json names one address for vault.asset and market.loanToken with vault kpk-usdc-prime-v2-9ee6',
  );
});

test('a per-vault report refuses a template whose computed read names another vault the field accepts', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'kiss-sign-sibling-read-'));
  try {
    cpSync(join(ROOT, 'templates', ID), join(sandbox, 'templates', ID), { recursive: true });
    const file = join(sandbox, 'templates', ID, 'template.json');
    const template = JSON.parse(readFileSync(file, 'utf8'));
    template.card['min-shares'].computed.read.to = { contract: 'hyperithm-usdc-apex-v2-9e2f' };
    writeFileSync(file, JSON.stringify(template));
    assert.throws(
      () => loadReport(sandbox, registry, TARGET),
      (e: unknown) => e instanceof ReportError && e.message === 'hyperithm-usdc-apex-v2-9e2f is another vault the field accepts, but the template names it, so a per-vault report cannot leave it out',
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
