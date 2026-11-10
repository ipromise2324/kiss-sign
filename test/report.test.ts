import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { replayReader } from '../src/chain/recording.ts';
import { cachedCompilers } from '../src/contracts/solc.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseCoinGeckoCoins, parseDefiLlamaProtocols, sourcePagesOf } from '../src/research/listings.ts';
import { chainAt } from '../src/research/erc7730.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { ReportError, GENERATED_FILE, entriesOf, erc7730Text, loadSubject, parseDocs, renderReport, replayTemplateReport, reportRecordingPath } from '../src/research/report.ts';
import type { ReportInputs, ReportRecording } from '../src/research/report.ts';
import type { Page } from '../src/research/source-page.ts';
import type { AbiProof } from '../src/contracts/prove.ts';
import type { Hex } from '../src/safe/types.ts';
import { TEMPLATES_DIR, loadTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const suffixes = loadPublicSuffixList();
const ID = 'morpho/vault-deposit';
const recording = JSON.parse(readFileSync(join(ROOT, reportRecordingPath(ID)), 'utf8')) as ReportRecording;

/** The report with no ABI proofs, vault evidence or past transactions, which the replay test covers. */
function quick(pages: Readonly<Record<string, Page>> = recording.pages, abi: ReportInputs['abi'] = new Map()): string {
  const inputs: ReportInputs = {
    subject: loadSubject(ROOT, registry, { template: ID }),
    registry,
    listings: { protocols: parseDefiLlamaProtocols(recording.defillama), coinsByAddress: parseCoinGeckoCoins(recording.coingecko), suffixes },
    pages: sourcePagesOf({ pages, commits: recording.commits }),
    fetched: recording.fetched,
    abi,
    vaults: new Map(),
    pastTxs: [],
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
    const text = await replayTemplateReport(ROOT, registry, id, compilers, suffixes);
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
