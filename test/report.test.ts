import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReader } from '../src/chain/reader.ts';
import { REPLAY_ENDPOINTS, recordingTransport, replayReader, replayTransport } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import type { Reader } from '../src/chain/reader.ts';
import type { Transport } from '../src/chain/rpc.ts';
import type { BlockRef, BlockTag } from '../src/chain/types.ts';
import { keccakCode } from '../src/contracts/code.ts';
import { REGISTRY_PATH, loadRegistry, parseRegistry } from '../src/registry.ts';
import type { Registry, RegistryEntry } from '../src/registry.ts';
import { parseCoinGeckoCoins, parseDefiLlamaProtocols, sourcePagesOf } from '../src/research/listings.ts';
import { chainAt } from '../src/research/erc7730.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import {
  GENERATED_FILE,
  checkSpans,
  ReportError,
  compareReports,
  entriesOf,
  erc7730Text,
  generatedPath,
  loadReport,
  parseDocs,
  readDocs,
  pastTxsRecordings,
  programChanges,
  readToday,
  renderReport,
  reportRecordingPath,
  summarizePastTxs,
  vaultsAt,
} from '../src/research/report.ts';
import type { ReportInputs, ReportRecording, Subject } from '../src/research/report.ts';
import type { Page } from '../src/research/source-page.ts';
import { STANDARDS } from '../src/research/standards.ts';
import { alchemyCall, formatVaultEvidence, gatherVaultEvidence } from '../src/research/vault-evidence.ts';
import type { AbiProof } from '../src/contracts/prove.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { TEMPLATES_DIR, loadTemplate, parseTemplate } from '../src/template/template.ts';
import { reportedVaultsIn } from '../src/template/vault-reports.ts';
import { PREDATE_REPORT } from './predate-report.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const suffixes = loadPublicSuffixList();
const ID = 'morpho/vault-deposit';
const TARGET = { template: ID, cardVault: 'steakhouse-prime-usdc-v2-0f51' };
const scoped = loadReport(ROOT, registry, TARGET);
const recording = readRecording(join(ROOT, reportRecordingPath(TARGET))) as ReportRecording;

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
): string {
  const inputs: ReportInputs = {
    subject,
    registry: reg,
    listings: { protocols: parseDefiLlamaProtocols(recording.defillama), coinsByAddress: parseCoinGeckoCoins(recording.coingecko), suffixes },
    pages: sourcePagesOf({ pages, commits }),
    fetched: recording.fetched,
    abi,
    vaults,
    pastTxs,
    spans,
    today,
    erc7730: { text: 'not read', reports: [] },
    facts: undefined,
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
  assert.match(text, /\| `steakhouse-prime-usdc-v2-0f51` \| `0xbeef088055857739C12CD3765F20b7679Def0f51` \| asset `usdc` `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`; factory `vault-v2-factory`/);
  assert.match(text, /\| `multicall\(\(address,bytes,uint256,bool,bytes32\)\[\]\)` \| `bundler3` \| <https:\/\/github\.com\/morpho-org\/bundler3\/blob\/[0-9a-f]{40}\/src\/Bundler3\.sol> \| FINDING \| PASS \| PASS \|/);
  assert.match(text, /\| `erc4626Deposit\(address,uint256,uint256,address\)` \| `general-adapter-1` \| <https:\/\/github\.com\/morpho-org\/bundler3\/blob\/[0-9a-f]{40}\/src\/adapters\/GeneralAdapter1\.sol> \| FINDING \| PASS \| PASS \|/);
});

test('a contract field that names its protocol puts only that protocol\'s entries in the report', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, 'fluid', 'vault-deposit', 'template.json'), 'utf8'));
  const template = parseTemplate({ ...raw, card: { ...raw.card, vault: { kind: 'contract', registryKind: 'vault', defillama: 'fluid-lending' } } }, registry);
  const subject: Subject = { ...loadReport(ROOT, registry, { template: 'fluid/vault-deposit' }).subject, template } as Subject;
  const vaults = entriesOf(subject, registry).filter((entry) => entry.kind === 'vault').map((entry) => entry.name);
  assert.deepEqual(vaults, ['fluid-fusdc', 'fluid-fusdt']);
  const text = quick(recording.pages, new Map(), subject, undefined, undefined, undefined, registry);
  assert.match(text, /\| `vault` \| a registry `vault` of the DefiLlama protocol `fluid-lending`, picked by number from the list below \|/);
  assert.ok(!text.includes('steakhouse-prime-usdc-v2-0f51'), 'no Morpho vault is listed');
});

test('a per-vault report joins its vault\'s docs.json with the template\'s, and refuses a function both name', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-docs-'));
  const folder = join(root, TEMPLATES_DIR, 'fluid/vault-deposit');
  mkdirSync(join(folder, 'vaults', 'fluid-fusdt'), { recursive: true });
  const page = { contract: 'fluid-fusdt', url: 'https://docs.fluid.io/' };
  const approve = { contract: 'usdt', url: 'https://etherscan.io/' };
  writeFileSync(join(folder, 'docs.json'), JSON.stringify({ 'deposit(uint256,address)': page }));
  writeFileSync(join(folder, 'vaults', 'fluid-fusdt', 'docs.json'), JSON.stringify({ 'approve(address,uint256)': approve }));
  assert.deepEqual(readDocs(root, 'fluid/vault-deposit', 'fluid-fusdt'), { 'deposit(uint256,address)': page, 'approve(address,uint256)': approve });
  assert.deepEqual(readDocs(root, 'fluid/vault-deposit', 'fluid-fusdc'), { 'deposit(uint256,address)': page });
  writeFileSync(join(folder, 'vaults', 'fluid-fusdt', 'docs.json'), JSON.stringify({ 'deposit(uint256,address)': page }));
  assert.throws(() => readDocs(root, 'fluid/vault-deposit', 'fluid-fusdt'), /vaults\/fluid-fusdt\/docs\.json: "deposit\(uint256,address\)" is in the template's docs\.json too/);
  rmSync(join(folder, 'vaults', 'fluid-fusdt', 'docs.json'));
  symlinkSync(join(folder, 'docs.json'), join(folder, 'vaults', 'fluid-fusdt', 'docs.json'));
  assert.throws(() => readDocs(root, 'fluid/vault-deposit', 'fluid-fusdt'), /vaults\/fluid-fusdt\/docs\.json: not a regular file/);
});

test('morpho/vault-deposit: the ERC-7730 section is computed again from the recorded descriptors and attestation reads', async () => {
  const snapshot = { commit: recording.erc7730.commit, files: new Map(Object.entries(recording.erc7730.files)) };
  const entries = entriesOf(scoped.subject, scoped.registry);
  const { text } = await erc7730Text(entries, scoped.registry, snapshot, () => chainAt(replayReader(recording.erc7730.chain)));
  assert.match(text, /^ERC-7730 registry github\.com\/ethereum\/clear-signing-erc7730-registry at commit [0-9a-f]{40}$/m);
  assert.match(text, /general-adapter-1 0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0 \(adapter\)\n {2}descriptor {3}none/);
  assert.match(
    text,
    /steakhouse-prime-usdc-v2-0f51 0xbeef088055857739C12CD3765F20b7679Def0f51 \(vault\)\n {2}descriptor {3}registry\/morpho\/calldata-steakhouse_financial-steakUSDC-v2-1\.json\n {2}applies {6}by exact address/,
  );
  const committed = readFileSync(join(ROOT, generatedPath(TARGET)), 'utf8');
  assert.ok(committed.includes(text), 'report.generated.md holds the section as computed');
});

test("each entry's code pin prints with its implementation, and a proof of other code than the pin is a FINDING", async () => {
  const bundler3 = registry.entries.get('bundler3')!;
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  raw['usdc'].code = { hash: raw['usdc'].code.hash, implementation: raw['usdc'].code.implementation };
  const reg = parseRegistry(raw);
  const usdc = reg.entries.get('usdc')!;
  const spans = await checkSpans(replayReader([]), [usdc]);
  const unranged = loadReport(ROOT, reg, TARGET);
  assert.match(quick(recording.pages, new Map(), unranged.subject, undefined, undefined, spans, unranged.registry), new RegExp(`^\\| \`usdc\` \\| 0 \\| \`${usdc.code!.current.pin.hash}\` \\| \`0x43506849D7C04F9138D1A2050bbF3A0c054402dd\` \`${usdc.code!.current.pin.implementation!.hash}\` \\| pinned before ranges, not read \\|$`, 'm'));
  const proof = (codeHash: Hex) =>
    ({ kind: 'proven', proxy: { kind: 'none' }, proven: bundler3.address, codeHash, contractName: 'Bundler3', compiler: '0.8.28', immutablesMasked: 0, librariesMasked: 0, metadataHashMasked: false, block: { number: 1n } }) as unknown as AbiProof;
  const row = (codeHash: Hex) => quick(recording.pages, new Map([[bundler3.address, proof(codeHash)]])).split('\n').find((l) => l.startsWith('| `bundler3` |') && l.includes('PROVEN'))!;
  assert.match(row(bundler3.code!.current.pin.hash), /\| PASS \| 0 immutable/);
  assert.match(row(`0x${'00'.repeat(32)}` as Hex), /\| FINDING \| 0 immutable/);
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

test('the report prints every code span, and --compare flags an earlier span whose code the chain did not run', async () => {
  const forged = keccakCode('0x6066' as Hex);
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  raw['bundler3'].code = { hash: keccakCode('0x6002' as Hex), from: 250, earlier: [{ from: 100, hash: forged }] };
  const reg = parseRegistry(raw);
  const { subject, registry: seen } = loadReport(ROOT, reg, TARGET);
  const bundler3 = [reg.entries.get('bundler3')!];
  const report = async (early: Hex) => quick(recording.pages, new Map(), subject, undefined, undefined, await checkSpans(chainReader(early), bundler3), seen);
  const committed = await report('0x6066' as Hex);
  assert.match(committed, new RegExp(`^\\| \`bundler3\` \\| 100 \\| \`${forged}\` \\| none \\| PASS \\|\n\\| \`bundler3\` \\| 250 \\| \`${keccakCode('0x6002' as Hex)}\` \\| none \\| PASS \\|$`, 'm'));
  assert.deepEqual(compareReports(committed, await report('0x6001' as Hex)), [
    `Code pins › \`bundler3\` › Chain: committed PASS, live FINDING: block 100 runs \`${keccakCode('0x6001' as Hex)}\``,
    `Code pins › \`bundler3\` (2) › Chain: committed PASS, live FINDING: block 249 runs \`${keccakCode('0x6001' as Hex)}\``,
  ]);
});

function withDependency(): Registry {
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  raw['liquidity'] = { address: `0x${'52'.repeat(20)}`, kind: 'lending', source: 'https://docs.example.org/liquidity', code: { hash: keccakCode('0x6002' as Hex), from: 250 } };
  raw['bundler3'] = { ...raw['bundler3'], dependsOn: ['liquidity'] };
  return parseRegistry(raw);
}

const serving =
  (code: Hex): Transport =>
  async (_url, body) => {
    const { method } = JSON.parse(body) as { method: string };
    const result = method === 'eth_getCode' ? code : method === 'eth_getStorageAt' ? `0x${'00'.repeat(32)}` : undefined;
    return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
  };

test("the report reads at its latest block the code of an entry no ABI proof covers, from its recording too, and --compare flags code the chain no longer runs", async () => {
  const { subject, registry: seen } = loadReport(ROOT, withDependency(), TARGET);
  const block: BlockRef = { number: 300n, hash: `0x${'30'.repeat(32)}` as Hex };
  const recorded = recordingTransport(serving('0x6002' as Hex), REPLAY_ENDPOINTS);
  const live = await readToday(createReader(REPLAY_ENDPOINTS, recorded.transport, { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] }), subject, seen, block);
  assert.deepEqual(await readToday(replayReader(recorded.exchanges()), subject, seen, block), live, 'the recorded reads give the same result');
  const committed = quick(recording.pages, new Map(), subject, undefined, undefined, undefined, seen, undefined, live);
  assert.match(committed, /^\| `liquidity` \| PASS \| 300 \|$/m);
  assert.match(committed, /^\| `liquidity` \| `0x5252525252525252525252525252525252525252` \| not proved: the operation reaches it only through `dependsOn`/m);
  const other = await readToday(createReader(REPLAY_ENDPOINTS, serving('0x6003' as Hex), { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] }), subject, seen, { ...block, number: 400n });
  assert.deepEqual(compareReports(committed, quick(recording.pages, new Map(), subject, undefined, undefined, undefined, seen, undefined, other)), [
    `Today's code › \`liquidity\` › Today: committed PASS, live FINDING: runs \`${keccakCode('0x6003' as Hex)}\``,
  ]);
  assert.equal(await readToday(replayReader([]), scoped.subject, scoped.registry, block), undefined, 'a report with no such entry reads nothing');
});

test('a selector-routed proxy a call targets is not provable, and the report reads its code and routes at the latest block', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  const implementation = `0x${'0a'.repeat(20)}`;
  raw['bundler3'] = {
    ...raw['bundler3'],
    routes: { implementationOf: 'getSigsImplementation(bytes4)', selectorsOf: 'getImplementationSigs(address)', seeds: ['0x00000001'] },
    code: { hash: raw['bundler3'].code.hash, routes: [{ address: implementation, hash: `0x${'0a'.repeat(32)}`, selectors: ['0x00000001'] }], from: 100 },
  };
  const { subject, registry: seen } = loadReport(ROOT, parseRegistry(raw), TARGET);
  const text = quick(recording.pages, new Map(), subject, undefined, undefined, undefined, seen);
  assert.match(text, /^\| `bundler3` \| `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` \| not provable: a selector-routed proxy, whose calls run in the implementations its routes reach; its routes are pinned above \|/m);
  assert.match(text, /^\| `bundler3` \| not read \| {2}\|$/m);
  assert.match(text, /^`bundler3` seeds: `0x00000001`\.$/m);
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
  const template = loadTemplate(ROOT, ID, registry);
  const valid = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, ID, 'docs.json'), 'utf8')) as Record<string, { contract: string; url: string }>;
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
  const template = loadTemplate(ROOT, ID, registry);
  const valid = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, ID, 'docs.json'), 'utf8')) as Record<string, { contract: string; url: string }>;
  const approve = valid['approve(address,uint256)']!;
  for (const url of [EVIL_URL, 'https://docs.example/`code`', 'https://docs.example/a b', 'https://docs.example/[x](https://y)', 'https://docs.example/a\\b']) {
    assert.throws(() => parseDocs({ ...valid, 'approve(address,uint256)': { ...approve, url } }, template, registry), /approve\(address,uint256\)\.url is not an https URL/, url);
  }
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8')) as Record<string, Record<string, unknown>>;
  assert.throws(() => parseRegistry({ ...raw, usdc: { ...raw.usdc, source: EVIL_URL } }), /usdc\.source: not an https URL/);
  assert.equal(parseRegistry(raw).entries.size, registry.entries.size);
});

test('text the AI wrote in the template prints escaped and labelled as written by the AI in the template', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, ID, 'template.json'), 'utf8')) as { calls: { trailer: { why: string } }[] };
  raw.calls[0]!.trailer.why = 'harmless | PASS | `x` | *bold* _em_ [link](https://y) <b>';
  const template = parseTemplate(raw, registry);
  const docs = parseDocs(JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, ID, 'docs.json'), 'utf8')), template, registry);
  const text = quick(recording.pages, new Map(), { kind: 'template', template, docs, vault: undefined });
  const row = text.split('\n').find((l) => l.startsWith('| `approve` |'))!;
  assert.equal(cellsOf(row).length, 2, row);
  assert.ok(row.includes('written by the AI in the template: harmless \\| PASS \\| \\`x\\` \\| \\*bold\\* \\_em\\_ \\[link\\](https://y) \\<b\\>'), row);
  raw.calls[0]!.trailer.why = 'pinged @maxey and $x^2$ and $$y$$';
  const mention = parseTemplate(raw, registry);
  const pinged = quick(recording.pages, new Map(), { kind: 'template', template: mention, docs, vault: undefined }).split('\n').find((l) => l.startsWith('| `approve` |'))!;
  assert.ok(
    pinged.includes('pinged <span>@</span>maxey and <span>$</span>x^2<span>$</span> and <span>$</span><span>$</span>y<span>$</span><span>$</span>'),
    `GitHub links an @mention and renders $math$ even after a backslash, so each @ and $ sits alone in a span: ${pinged}`,
  );
  assert.ok(!quick().includes("the template's reason"), 'every template reason is labelled as written by the AI');
});

test('stored vault evidence holding a backtick or a character pnpm vault-evidence never prints is refused, and its section says it is stored', () => {
  const vault = 'steakhouse-prime-usdc-v2-0f51';
  const stored = recording.vaults[vault]!;
  assert.throws(() => quick(recording.pages, new Map(), undefined, new Map([[vault, `${stored}\n\`\`\`\n# Approved by the auditors`]])), ReportError);
  assert.throws(() => quick(recording.pages, new Map(), undefined, new Map([[vault, `${stored}\n<img src=x>`]])), ReportError);
  const text = quick(recording.pages, new Map(), undefined, new Map([[vault, stored]]));
  assert.match(text, /stored output of `pnpm vault-evidence`, not recomputed by `pnpm test`; `pnpm report --compare` reads it again at the blocks it names/);
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
  const design = readFileSync(join(ROOT, 'docs', 'design.md'), 'utf8');
  const folders = readdirSync(join(ROOT, TEMPLATES_DIR)).flatMap((protocol) => readdirSync(join(ROOT, TEMPLATES_DIR, protocol)).map((operation) => `${protocol}/${operation}`));
  const hasReport = (id: string) => existsSync(join(ROOT, TEMPLATES_DIR, id, GENERATED_FILE)) || reportedVaultsIn(ROOT, id).size > 0;
  assert.deepEqual(notGeneratedProblems(design, folders, hasReport), []);
  const added = design.replace(/(- \*\*Report not generated yet:\*\* )/, '$1`aave/supply`, ');
  assert.deepEqual(notGeneratedProblems(added, [...folders, 'aave/supply'], (id) => id !== 'aave/supply' && hasReport(id)), [
    'design.md lists aave/supply as not generated yet, but only templates older than the generated report may be listed',
  ]);
});

test('--compare prints a verdict that changed, and ignores the date and the block an ABI proof was read at', () => {
  const pages = Object.fromEntries(Object.entries(recording.pages).map(([url, page]) => [url, url.endsWith('/src/Bundler3.sol') ? ({ kind: 'served', blocks: [] } as Page) : page]));
  const differences = compareReports(quick(), quick(pages));
  assert.deepEqual(differences, ['Official documentation › `multicall((address,bytes,uint256,bool,bytes32)[])` › Function on page: committed PASS, live FINDING']);

  const committed = readFileSync(join(ROOT, generatedPath(TARGET)), 'utf8');
  const drifted = committed
    .replace(/were read on \d{4}-\d{2}-\d{2}/, 'were read on 2027-01-01')
    .replace(/\| 2638\d{4} \|$/gm, '| 27000000 |');
  assert.notEqual(drifted, committed);
  assert.deepEqual(compareReports(committed, drifted), []);
  const point = /^  \d{4}-\d{2}-\d{2}  block \d+  [\d,.]+ usdc$/m.exec(committed)![0];
  const raised = point.replace(/[\d,.]+ usdc$/, '140,000,000.000000 usdc');
  const series = committed.replace(point, raised);
  assert.deepEqual(compareReports(committed, series), [
    `\`steakhouse-prime-usdc-v2-0f51\` › totalAssets() every 216000 blocks (about 30 days), read through both providers: › only committed: ${point}`,
    `\`steakhouse-prime-usdc-v2-0f51\` › totalAssets() every 216000 blocks (about 30 days), read through both providers: › only live: ${raised}`,
  ]);

  const attested = readFileSync(join(ROOT, TEMPLATES_DIR, 'fluid/vault-deposit', GENERATED_FILE), 'utf8');
  const revoked = attested.replace('VALID: ERC-8176', 'REVOKED: ERC-8176');
  assert.equal(compareReports(attested, revoked).length, 2);
  assert.match(compareReports(attested, revoked).join('\n'), /^ERC-7730 › [a-z0-9.-]+ 0x[0-9a-fA-F]{40} \(\w+\) › only live: .*REVOKED: ERC-8176/m);
  const moved = committed.replace('| `bundler3` | `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` | router |', '| `bundler3` | `0x0000000000000000000000000000000000000001` | router |');
  assert.deepEqual(compareReports(committed, moved), ['Registry entries › `bundler3` › Address: committed `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245`, live `0x0000000000000000000000000000000000000001`']);
});

test("docs.json's contract must be the call's target when the template binds the target", () => {
  const template = loadTemplate(ROOT, ID, registry);
  const valid = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, ID, 'docs.json'), 'utf8')) as Record<string, { contract: string; url: string }>;
  const swap = (sig: string, contract: string) => ({ ...valid, [sig]: { ...valid[sig]!, contract } });
  assert.throws(() => parseDocs(swap('erc4626Deposit(address,uint256,uint256,address)', 'bundler3'), template, registry), /erc4626Deposit\(address,uint256,uint256,address\)\.contract is bundler3, but the template calls it on general-adapter-1/);
  assert.throws(() => parseDocs(swap('multicall((address,bytes,uint256,bool,bytes32)[])', 'general-adapter-1'), template, registry), /calls it on bundler3/);
  assert.throws(() => parseDocs(swap('approve(address,uint256)', 'bundler3'), template, registry), /calls it on one of usdc, usdt/);
  assert.equal(parseDocs(swap('approve(address,uint256)', 'usdt'), template, registry).length, 4);
  assert.match(quick(), /\| Function \| Contract \| Page \| Site \| GitHub commit \| Function on page \|/);
});

test('docs.json may name the ERC-20 standard for a function it defines on a token, and the report names the standard page', () => {
  const template = loadTemplate(ROOT, ID, registry);
  const valid = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, ID, 'docs.json'), 'utf8')) as Record<string, unknown>;
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
  const text = quick(pages, new Map(), { kind: 'template', template, docs, vault: undefined }, new Map(), [], new Map(), scoped.registry, commits);
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

test("each ERC-20 declaration the program holds names the function's canonical signature", () => {
  for (const standard of STANDARDS.values()) {
    for (const [signature, declaration] of standard.declarations) {
      const [, name, params] = /^function (\w+)\((.*)\)$/.exec(declaration)!;
      assert.equal(`${name}(${params!.split(', ').map((p) => p.split(' ')[0]).join(',')})`, signature);
    }
  }
});

const VAULT = 'steakhouse-high-yield-usdc-v2-a757';
const vaultRecording: { exchanges: Exchange[] } = readRecording(join(ROOT, 'testdata', 'vault-evidence', `${VAULT}.json`));

test('--compare reads each vault again at the blocks its evidence names, so a changed month, holder count or top-10 share differs', async () => {
  const transport = replayTransport(vaultRecording.exchanges, REPLAY_ENDPOINTS);
  const reader = createReader(REPLAY_ENDPOINTS, transport, { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] });
  const alchemy = alchemyCall(transport, REPLAY_ENDPOINTS[0].url, () => {}, []);
  const read = async (vault: RegistryEntry, at: BlockTag) => {
    const evidence = await gatherVaultEvidence(reader, alchemy, vault, at);
    return 'kind' in evidence ? `UNVERIFIABLE ${evidence.reason}` : formatVaultEvidence(evidence, registry);
  };
  const { subject } = loadReport(ROOT, registry, { vault: VAULT });
  const vault = registry.entries.get(VAULT)!;
  const honest = quick(recording.pages, new Map(), subject, new Map([[VAULT, await read(vault, 26385872n)]]), [], new Map(), registry);
  const compare = async (committed: string) => compareReports(committed, quick(recording.pages, new Map(), subject, await vaultsAt(committed, [vault], read), [], new Map(), registry));
  assert.deepEqual(await compare(honest), []);
  for (const [was, now] of [
    ['  2026-11-10  block 26385872  43,152,031.442033 usdc', '  2026-11-10  block 26385872  943,152,031.442033 usdc'],
    ['holders      452 addresses', 'holders      45200 addresses'],
    ['top 10       hold 53.52% of the shares', 'top 10       hold 5.35% of the shares'],
  ] as const) {
    const faked = honest.replace(was, now);
    assert.notEqual(faked, honest, was);
    const differences = await compare(faked);
    assert.ok(differences.some((d) => d.startsWith(`\`${VAULT}\``) && d.includes(`only committed: ${now}`)), differences.join('\n'));
    assert.ok(differences.some((d) => d.includes(`only live: ${was}`)), differences.join('\n'));
  }
});

test('--compare fetches each recorded past transaction again by hash, so one the chain does not know differs', async () => {
  const { subject } = scoped;
  const { file, recording: past } = pastTxsRecordings(ROOT, subject).find((r) => r.recording.query.fromBlock !== undefined)!;
  const committed = await summarizePastTxs(ROOT, registry, file, past);
  assert.equal((await summarizePastTxs(ROOT, registry, file, past, replayReader(past.exchanges))).text, committed.text);
  const first = past.exchanges.findIndex((e) => e.method === 'eth_getTransactionByHash');
  const unknown = past.exchanges.map((e, i) => (i === first ? { ...e, answers: { alchemy: null, drpc: null } } : e));
  const live = await summarizePastTxs(ROOT, registry, file, past, replayReader(unknown));
  const differences = compareReports(quick(undefined, undefined, subject, undefined, [committed]), quick(undefined, undefined, subject, undefined, [live]));
  assert.ok(differences.some((d) => d.startsWith(`\`${file}\``)), differences.join('\n'));
});

test('--compare names each file a pull request changes outside templates/, registry/ and testdata/', () => {
  const changed = ['templates/morpho/vault-deposit/template.json', 'registry/contracts.json', 'testdata/report/x.json', 'src/research/report.ts', 'scripts/report.ts', 'templates-x/a.json', 'docs/design.md', 'package.json'];
  assert.deepEqual(programChanges(changed), ['src/research/report.ts', 'scripts/report.ts', 'templates-x/a.json', 'docs/design.md', 'package.json']);
});

test('a market field lists every market with its id, lltv and parts, binds each MarketParams part, and prints the views read', () => {
  const contracts = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  const source = 'https://docs.morpho.org/get-started/resources/addresses';
  const added = {
    'morpho-blue': { address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', kind: 'lending', source },
    cbbtc: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', kind: 'token', source },
    'morpho-oracle-cbbtc-usdc-86': { address: '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a', kind: 'oracle', source },
    'adaptive-curve-irm': { address: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', kind: 'irm', source },
  };
  const id = '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64';
  const reg = parseRegistry({ ...contracts, ...added }, {
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
  );
  const subject: Subject = { kind: 'template', template, docs: [], vault: undefined };
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
    ['usdc', 'cbbtc', 'morpho-blue', 'morpho-oracle-cbbtc-usdc-86', 'adaptive-curve-irm'],
  );
});

test('a template whose card names a vault is reported per vault: without the vault, with another template, or with a vault the field refuses, it is refused', () => {
  const refused = (target: Parameters<typeof loadReport>[2], message: string) => assert.throws(() => loadReport(ROOT, registry, target), (e: unknown) => e instanceof ReportError && e.message === message);
  refused({ template: ID }, 'morpho/vault-deposit is reported per vault; name the vault (reports exist for hyperithm-usdc-apex-v2-9e2f, steakhouse-prime-usdc-v2-0f51)');
  refused({ template: 'eth/transfer', cardVault: 'steakhouse-prime-usdc-v2-0f51' }, 'eth/transfer has one report, not one per vault; leave out the vault');
  refused({ template: ID, cardVault: 'fluid-fusdc' }, "fluid-fusdc is not a vault the card's vault of morpho/vault-deposit accepts");
  refused({ template: ID, cardVault: 'bundler3' }, "bundler3 is not a vault the card's vault of morpho/vault-deposit accepts");
});

test('a per-vault report refuses a registry whose kept entry depends on another vault the field accepts', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));
  raw['bundler3'] = { ...raw['bundler3'], dependsOn: ['hyperithm-usdc-apex-v2-9e2f'] };
  assert.throws(
    () => loadReport(ROOT, parseRegistry(raw), TARGET),
    (e: unknown) => e instanceof ReportError && e.message === 'hyperithm-usdc-apex-v2-9e2f is another vault the field accepts, but a registry entry the report keeps names it',
  );
});

test("a per-vault report shows that vault alone: no other vault, no asset or factory only another vault names, and only past searches anchored on its token", () => {
  const others = [...registry.entries.values()].filter((e) => e.kind === 'vault' && e.name !== TARGET.cardVault && e.defillama !== 'fluid-lending');
  const text = readFileSync(join(ROOT, generatedPath(TARGET)), 'utf8');
  for (const entry of [...others, registry.entries.get('usdt')!, registry.entries.get('metamorpho-factory-v1-0')!]) {
    assert.ok(!text.includes(`\`${entry.name}\``) && !text.toLowerCase().includes(entry.address), `${entry.name} appears in the report`);
  }
  assert.match(text, /^\| `vault` \| a registry `vault` of the DefiLlama protocol `morpho-blue`, picked by number from the list below \|$/m);
  assert.deepEqual(entriesOf(scoped.subject, scoped.registry).map((e) => e.name), ['usdc', 'bundler3', 'steakhouse-prime-usdc-v2-0f51', 'vault-v2-factory', 'general-adapter-1']);
  const anchored = pastTxsRecordings(ROOT, scoped.subject).map((r) => r.file);
  assert.deepEqual(anchored, ['testdata/research/morpho-vault-deposit-windows.json', 'testdata/research/morpho-vault-deposit.json']);
  assert.match(text, /^Written by `pnpm report morpho\/vault-deposit --vault-of steakhouse-prime-usdc-v2-0f51 --record` /m);
});
