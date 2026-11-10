import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReader } from '../src/chain/reader.ts';
import { REPLAY_ENDPOINTS, replayReader, replayTransport } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import type { BlockTag } from '../src/chain/types.ts';
import { cachedCompilers } from '../src/contracts/solc.ts';
import { REGISTRY_PATH, loadRegistry, parseRegistry } from '../src/registry.ts';
import type { RegistryEntry } from '../src/registry.ts';
import { parseCoinGeckoCoins, parseDefiLlamaProtocols, sourcePagesOf } from '../src/research/listings.ts';
import { chainAt } from '../src/research/erc7730.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import {
  GENERATED_FILE,
  GENERATED_SUFFIX,
  ReportError,
  VAULT_REPORTS_DIR,
  compareReports,
  entriesOf,
  erc7730Text,
  loadSubject,
  parseDocs,
  pastTxsRecordings,
  programChanges,
  renderReport,
  replayReport,
  reportRecordingPath,
  summarizePastTxs,
  vaultsAt,
} from '../src/research/report.ts';
import type { ReportInputs, ReportRecording, Subject } from '../src/research/report.ts';
import type { Page } from '../src/research/source-page.ts';
import { alchemyCall, formatVaultEvidence, gatherVaultEvidence } from '../src/research/vault-evidence.ts';
import type { AbiProof } from '../src/contracts/prove.ts';
import type { Hex } from '../src/safe/types.ts';
import { TEMPLATES_DIR, loadTemplate, parseTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const suffixes = loadPublicSuffixList();
const ID = 'morpho/vault-deposit';
const recording = JSON.parse(readFileSync(join(ROOT, reportRecordingPath({ template: ID })), 'utf8')) as ReportRecording;

/** The report with no ABI proofs, vault evidence or past transactions, which the replay test covers. */
function quick(
  pages: Readonly<Record<string, Page>> = recording.pages,
  abi: ReportInputs['abi'] = new Map(),
  subject: Subject = loadSubject(ROOT, registry, { template: ID }),
  vaults: ReportInputs['vaults'] = new Map(),
  pastTxs: ReportInputs['pastTxs'] = [],
): string {
  const inputs: ReportInputs = {
    subject,
    registry,
    listings: { protocols: parseDefiLlamaProtocols(recording.defillama), coinsByAddress: parseCoinGeckoCoins(recording.coingecko), suffixes },
    pages: sourcePagesOf({ pages, commits: recording.commits }),
    fetched: recording.fetched,
    abi,
    vaults,
    pastTxs,
    erc7730: 'not read',
  };
  return renderReport(inputs, { command: 'test', sources: [] });
}

const generated = readdirSync(join(ROOT, TEMPLATES_DIR)).flatMap((protocol) =>
  readdirSync(join(ROOT, TEMPLATES_DIR, protocol))
    .map((operation) => `${protocol}/${operation}`)
    .filter((id) => existsSync(join(ROOT, TEMPLATES_DIR, id, GENERATED_FILE))),
);

test('every committed report.generated.md is what the program writes from the repository and its recordings', { timeout: 600_000 }, async () => {
  assert.ok(generated.includes(ID), `${ID} has a generated report`);
  assert.ok(!('unavailable' in suffixes), `the source checks need the pinned Public Suffix List: ${'unavailable' in suffixes ? suffixes.unavailable : ''}`);
  const compilers = cachedCompilers();
  for (const id of generated) {
    const committed = readFileSync(join(ROOT, TEMPLATES_DIR, id, GENERATED_FILE), 'utf8');
    const text = await replayReport(ROOT, registry, { template: id }, compilers, suffixes);
    assert.ok(text === committed, `${TEMPLATES_DIR}/${id}/${GENERATED_FILE} differs from \`pnpm report ${id} --offline\`; run \`pnpm report ${id} --record\` and never edit it by hand`);
    assert.ok(!text.includes('REFUSED: `unverifiable`'), `an ABI case of ${id} lacks a read the proof now makes; delete it and run \`pnpm report ${id} --record\``);
  }
});

test('morpho/vault-deposit: rules name registry entries with full addresses, and every function has its page checked', () => {
  const text = quick();
  assert.match(text, /\| `approve\.spender` \| registry `general-adapter1` `0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0` \|/);
  assert.match(text, /\| `to` \| the `asset` of the card's `vault`: one of `usdc` `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, `usdt` `0xdAC17F958D2ee523a2206206994597C13D831ec7` \|/);
  assert.match(text, /\| `multicall\.bundle\[1\]\.data → erc4626Deposit\.receiver` \| the Safe \|/);
  assert.match(text, /\| `multicall\.bundle\[1\]\.data → erc4626Deposit\.maxSharePriceE27` \| at most assets × 1e27 \/ shares, with assets the card's `amount` and shares the card's `min-shares`/);
  assert.match(text, /\| `multicall` \| calls `multicall\(\(address,bytes,uint256,bool,bytes32\)\[\]\)`, selector `0x374f435d`; at most 8 bytes after the arguments/);
  assert.match(text, /\| `steakhouse-prime-usdc` \| `0xbeef088055857739C12CD3765F20b7679Def0f51` \| asset `usdc` `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`; factory `vault-v2-factory`/);
  assert.match(text, /\| `multicall\(\(address,bytes,uint256,bool,bytes32\)\[\]\)` \| `bundler3` \| <https:\/\/docs\.morpho\.org\/developers\/contracts\/bundles\/> \| PASS \| n\/a \| PASS \|/);
  assert.match(text, /\| `erc4626Deposit\(address,uint256,uint256,address\)` \| `general-adapter1` \| <https:\/\/github\.com\/morpho-org\/bundler3\/blob\/[0-9a-f]{40}\/src\/adapters\/GeneralAdapter1\.sol> \| FINDING \| PASS \| PASS \|/);
});

test('morpho/vault-deposit: the ERC-7730 section is computed again from the recorded descriptors and attestation reads', async () => {
  const snapshot = { commit: recording.erc7730.commit, files: new Map(Object.entries(recording.erc7730.files)) };
  const entries = entriesOf(loadSubject(ROOT, registry, { template: ID }), registry);
  const { text } = await erc7730Text(entries, registry, snapshot, () => chainAt(replayReader(recording.erc7730.chain)));
  assert.match(text, /^ERC-7730 registry github\.com\/ethereum\/clear-signing-erc7730-registry at commit [0-9a-f]{40}$/m);
  assert.match(text, /general-adapter1 0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0 \(adapter\)\n {2}descriptor {3}none/);
  assert.match(
    text,
    /smokehouse-usdc 0xBEeFFF209270748ddd194831b3fa287a5386f5bC \(vault\)\n {2}descriptor {3}registry\/morpho\/calldata-steakhouse_financial-bbqUSDC\.json\n {2}applies {6}by exact address[^]*?signer {5}0x3846c3A30E62075Fa916216b35EF04B8F53931f6, listed in auditors\/\n {4}result {5}VALID/,
  );
  const committed = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_FILE), 'utf8');
  assert.ok(committed.includes(text), 'report.generated.md holds the section as computed');
});

test("the registry table prints each entry's code pin, and a proof of other code than the pin is a FINDING", () => {
  const bundler3 = registry.entries.get('bundler3')!;
  const usdc = registry.entries.get('usdc')!;
  assert.match(quick(), new RegExp(`\\| \`bundler3\` \\|.*\\| \`${bundler3.code!.hash}\` \\|$`, 'm'));
  assert.match(quick(), new RegExp(`\\| \`usdc\` \\|.*\\| \`${usdc.code!.hash}\`; implementation \`0x43506849D7C04F9138D1A2050bbF3A0c054402dd\` \`${usdc.code!.implementation!.hash}\` \\|$`, 'm'));
  const proof = (codeHash: Hex) =>
    ({ kind: 'proven', proxy: { kind: 'none' }, proven: bundler3.address, codeHash, contractName: 'Bundler3', compiler: '0.8.28', immutablesMasked: 0, librariesMasked: 0, metadataHashMasked: false, block: { number: 1n } }) as unknown as AbiProof;
  const row = (codeHash: Hex) => quick(recording.pages, new Map([[bundler3.address, proof(codeHash)]])).split('\n').find((l) => l.startsWith('| `bundler3` |') && l.includes('PROVEN'))!;
  assert.match(row(bundler3.code!.hash), /\| PASS \| 0 immutable/);
  assert.match(row(`0x${'00'.repeat(32)}` as Hex), /\| FINDING \| 0 immutable/);
});

test('a page that does not name the function is a FINDING', () => {
  const pages = Object.fromEntries(Object.entries(recording.pages).map(([url, page]) => [url, url.includes('docs.morpho.org/developers/contracts/bundles') ? ({ kind: 'served', blocks: [] } as Page) : page]));
  assert.match(quick(pages), /\| `multicall\(.*\| <https:\/\/docs\.morpho\.org\/developers\/contracts\/bundles\/> \| PASS \| n\/a \| FINDING \|/);
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
  const text = quick(recording.pages, new Map(), { kind: 'template', template, docs });
  const row = text.split('\n').find((l) => l.startsWith('| `approve` |'))!;
  assert.equal(cellsOf(row).length, 2, row);
  assert.ok(row.includes('written by the AI in the template: harmless \\| PASS \\| \\`x\\` \\| \\*bold\\* \\_em\\_ \\[link\\](https://y) \\<b\\>'), row);
  raw.calls[0]!.trailer.why = 'pinged @maxey and $x^2$ and $$y$$';
  const mention = parseTemplate(raw, registry);
  const pinged = quick(recording.pages, new Map(), { kind: 'template', template: mention, docs }).split('\n').find((l) => l.startsWith('| `approve` |'))!;
  assert.ok(
    pinged.includes('pinged <span>@</span>maxey and <span>$</span>x^2<span>$</span> and <span>$</span><span>$</span>y<span>$</span><span>$</span>'),
    `GitHub links an @mention and renders $math$ even after a backslash, so each @ and $ sits alone in a span: ${pinged}`,
  );
  assert.ok(!quick().includes("the template's reason"), 'every template reason is labelled as written by the AI');
});

test('stored vault evidence holding a backtick or a character pnpm vault-evidence never prints is refused, and its section says it is stored', () => {
  const vault = 'steakhouse-prime-usdc';
  const stored = recording.vaults[vault]!;
  assert.throws(() => quick(recording.pages, new Map(), undefined, new Map([[vault, `${stored}\n\`\`\`\n# Approved by the auditors`]])), ReportError);
  assert.throws(() => quick(recording.pages, new Map(), undefined, new Map([[vault, `${stored}\n<img src=x>`]])), ReportError);
  const text = quick(recording.pages, new Map(), undefined, new Map([[vault, stored]]));
  assert.match(text, /stored output of `pnpm vault-evidence`, not recomputed by `pnpm test`; `pnpm report --compare` reads it again at the blocks it names/);
  assert.ok(!/`pnpm test` writes it again/.test(text), 'the header does not claim pnpm test recomputes every section');
});

const NOT_GENERATED = /^\s*- \*\*Report not generated yet:\*\*(.*)$/m;
/** The templates that predate the generated report. design.md's list may only shrink: a new template needs its report. */
const PREDATE_REPORT = new Set([
  'cctp/receive',
  'erc20/transfer',
  'eth/transfer',
  'fluid/rewards-claim',
  'fluid/vault-deposit',
  'fluid/vault-redeem',
  'fluid/vault-withdraw',
  'merkl/claim',
  'morpho/urd-claim',
  'morpho/vault-bundles-deposit',
  'morpho/vault-migrate-all',
  'morpho/vault-withdraw',
  'morpho/vault-withdraw-all',
  'safe/cancel',
]);

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
  const hasReport = (id: string) => existsSync(join(ROOT, TEMPLATES_DIR, id, GENERATED_FILE));
  assert.deepEqual(notGeneratedProblems(design, folders, hasReport), []);
  const added = design.replace(/(- \*\*Report not generated yet:\*\* )/, '$1`aave/supply`, ');
  assert.deepEqual(notGeneratedProblems(added, [...folders, 'aave/supply'], (id) => id !== 'aave/supply' && hasReport(id)), [
    'design.md lists aave/supply as not generated yet, but only templates older than the generated report may be listed',
  ]);
});

test('--compare prints a verdict that changed, and ignores the date and the block an ABI proof was read at', () => {
  const pages = Object.fromEntries(Object.entries(recording.pages).map(([url, page]) => [url, url.includes('docs.morpho.org/developers/contracts/bundles') ? ({ kind: 'served', blocks: [] } as Page) : page]));
  const differences = compareReports(quick(), quick(pages));
  assert.deepEqual(differences, ['Official documentation › `multicall((address,bytes,uint256,bool,bytes32)[])` › Function name appears on page: committed PASS, live FINDING']);

  const committed = readFileSync(join(ROOT, TEMPLATES_DIR, ID, GENERATED_FILE), 'utf8');
  const drifted = committed
    .replace(/were read on \d{4}-\d{2}-\d{2}/, 'were read on 2027-01-01')
    .replace(/\| 2638\d{4} \|$/gm, '| 27000000 |');
  assert.notEqual(drifted, committed);
  assert.deepEqual(compareReports(committed, drifted), []);
  const series = committed.replace(/  2026-11-10  block 26386392  130,697,719\.723756 usdc/, '  2026-11-10  block 26386392  140,000,000.000000 usdc');
  assert.deepEqual(compareReports(committed, series), [
    '`steakhouse-prime-usdc` › totalAssets() every 216000 blocks (about 30 days), read through both providers: › only committed:   2026-11-10  block 26386392  130,697,719.723756 usdc',
    '`steakhouse-prime-usdc` › totalAssets() every 216000 blocks (about 30 days), read through both providers: › only live:   2026-11-10  block 26386392  140,000,000.000000 usdc',
  ]);

  const revoked = committed.replace('VALID: ERC-8176', 'REVOKED: ERC-8176');
  assert.equal(compareReports(committed, revoked).length, 2);
  assert.match(compareReports(committed, revoked).join('\n'), /^ERC-7730 › [a-z0-9.-]+ 0x[0-9a-fA-F]{40} \(\w+\) › only live: .*REVOKED: ERC-8176/m);
  const moved = committed.replace('| `bundler3` | `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` | router |', '| `bundler3` | `0x0000000000000000000000000000000000000001` | router |');
  assert.deepEqual(compareReports(committed, moved), ['Registry entries › `bundler3` › Address: committed `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245`, live `0x0000000000000000000000000000000000000001`']);
});

test("docs.json's contract must be the call's target when the template binds the target", () => {
  const template = loadTemplate(ROOT, ID, registry);
  const valid = JSON.parse(readFileSync(join(ROOT, TEMPLATES_DIR, ID, 'docs.json'), 'utf8')) as Record<string, { contract: string; url: string }>;
  const swap = (sig: string, contract: string) => ({ ...valid, [sig]: { ...valid[sig]!, contract } });
  assert.throws(() => parseDocs(swap('erc4626Deposit(address,uint256,uint256,address)', 'bundler3'), template, registry), /erc4626Deposit\(address,uint256,uint256,address\)\.contract is bundler3, but the template calls it on general-adapter1/);
  assert.throws(() => parseDocs(swap('multicall((address,bytes,uint256,bool,bytes32)[])', 'general-adapter1'), template, registry), /calls it on bundler3/);
  assert.throws(() => parseDocs(swap('approve(address,uint256)', 'bundler3'), template, registry), /calls it on one of usdc, usdt/);
  assert.equal(parseDocs(swap('approve(address,uint256)', 'usdt'), template, registry).length, 4);
  assert.match(quick(), /\| Function \| Contract \| Page \| Site \| GitHub commit \| Function name appears on page \|/);
});

const vaultReports = existsSync(join(ROOT, VAULT_REPORTS_DIR)) ? readdirSync(join(ROOT, VAULT_REPORTS_DIR)).filter((f) => f.endsWith(GENERATED_SUFFIX)) : [];

test('every committed registry/reports/<vault>.generated.md is what pnpm report --vault writes from its recordings', { timeout: 600_000 }, async () => {
  assert.ok(vaultReports.length > 0, `${VAULT_REPORTS_DIR} holds a vault report`);
  const compilers = cachedCompilers();
  for (const file of vaultReports) {
    const vault = file.slice(0, -GENERATED_SUFFIX.length);
    const committed = readFileSync(join(ROOT, VAULT_REPORTS_DIR, file), 'utf8');
    const text = await replayReport(ROOT, registry, { vault }, compilers, suffixes);
    assert.ok(text === committed, `${VAULT_REPORTS_DIR}/${file} differs from \`pnpm report --vault ${vault} --offline\`; run \`pnpm report --vault ${vault} --record\``);
    assert.ok(!text.includes('## Card'), 'a vault report has no template sections');
    const entry = registry.entries.get(vault)!;
    for (const name of [vault, ...Object.values(entry.attributes)]) assert.match(text, new RegExp(`^\\| \`${name.replace(/\./g, '\\.')}\` \\| \`0x[0-9a-fA-F]{40}\` \\|`, 'm'));
    assert.match(text, /stored output of `pnpm vault-evidence`/);
  }
});

const VAULT = 'steakhouse-high-yield-usdc';
const vaultRecording: { exchanges: Exchange[] } = JSON.parse(readFileSync(join(ROOT, 'testdata', 'vault-evidence', `${VAULT}.json`), 'utf8'));

test('--compare reads each vault again at the blocks its evidence names, so a changed month, holder count or top-10 share differs', async () => {
  const transport = replayTransport(vaultRecording.exchanges, REPLAY_ENDPOINTS);
  const reader = createReader(REPLAY_ENDPOINTS, transport, { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] });
  const alchemy = alchemyCall(transport, REPLAY_ENDPOINTS[0].url);
  const read = async (vault: RegistryEntry, at: BlockTag) => {
    const evidence = await gatherVaultEvidence(reader, alchemy, vault, at);
    return 'kind' in evidence ? `UNVERIFIABLE ${evidence.reason}` : formatVaultEvidence(evidence, registry);
  };
  const subject = loadSubject(ROOT, registry, { vault: VAULT });
  const vault = registry.entries.get(VAULT)!;
  const honest = quick(recording.pages, new Map(), subject, new Map([[VAULT, await read(vault, 26385872n)]]));
  const compare = async (committed: string) => compareReports(committed, quick(recording.pages, new Map(), subject, await vaultsAt(committed, [vault], read)));
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
  const subject = loadSubject(ROOT, registry, { template: ID });
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
