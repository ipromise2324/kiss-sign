import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadAbiCases, recordAbiCase } from '../src/contracts/abi-case.ts';
import { proveAbi } from '../src/contracts/prove.ts';
import type { AbiProof, AbiRefusal } from '../src/contracts/prove.ts';
import { cachedCompilers } from '../src/contracts/solc.ts';
import { sourcifyHttps } from '../src/contracts/sourcify.ts';
import { loadRegistry } from '../src/registry.ts';
import { COINGECKO_COINS, DEFILLAMA_PROTOCOLS, fetchListing, parseCoinGeckoCoins, parseDefiLlamaProtocols } from '../src/research/listings.ts';
import { chainAt, loadSnapshot, trimForRecording as trimErc7730 } from '../src/research/erc7730.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import {
  compareReports,
  entriesOf,
  erc7730Text,
  generatedPath,
  loadSubject,
  pastTxsRecordings,
  renderReport,
  replayReport,
  reportRecordingPath,
  summarizePastTxs,
  trimReportRecording,
  vaultsOf,
} from '../src/research/report.ts';
import type { Target } from '../src/research/report.ts';
import { gatherSourcePages, httpsGet } from '../src/research/source-page.ts';
import { alchemyCall, vaultEvidenceText } from '../src/research/vault-evidence.ts';
import type { Address } from '../src/safe/types.ts';

const USAGE = `usage: ALCHEMY_API_KEY=... node scripts/report.ts (<protocol>/<operation> | --vault <registry vault name>) [--record | --compare]
       node scripts/report.ts (<protocol>/<operation> | --vault <registry vault name>) --offline

Prints the generated report of a template, read live: each field's rule from template.json, each function's page from
docs.json checked against DefiLlama and the page itself, pnpm check-sources and pnpm prove-abi for every registry entry
the operation can touch with its code pin, pnpm vault-evidence for every vault its card can name, the past-txs
recordings of the template studied again, and pnpm erc7730 for every such entry (pnpm fetch-erc7730 first). --vault
prints the same for one vault, for a pull request that adds it.

--record also writes the live answers to testdata/report/, records an ABI case for each entry testdata/abi/ lacks, and
writes the committed report from those recordings alone: templates/<protocol>/<operation>/report.generated.md, or
registry/reports/<vault>.generated.md. --offline prints that file's text from the recordings, reading nothing live.
--compare reads everything live and prints each fact that differs from the committed report; it exits 1 on any.`;

const { values: flags, positionals } = parseArgs({
  options: { vault: { type: 'string' }, record: { type: 'boolean' }, offline: { type: 'boolean' }, compare: { type: 'boolean' } },
  allowPositionals: true,
});
const [id] = positionals;
if ((id === undefined) === (flags.vault === undefined) || positionals.length > 1 || [flags.record, flags.offline, flags.compare].filter(Boolean).length > 1) {
  console.error(USAGE);
  process.exit(2);
}
const target: Target = id === undefined ? { vault: flags.vault! } : { template: id };

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
const suffixes = loadPublicSuffixList();
const compilers = cachedCompilers();

if (flags.offline) {
  process.stdout.write(await replayReport(root, registry, target, compilers, suffixes));
  process.exit(0);
}

const subject = loadSubject(root, registry, target);
const committedPath = join(root, generatedPath(target));
if (flags.compare && !existsSync(committedPath)) {
  console.error(`${generatedPath(target)} does not exist; there is nothing to compare with`);
  process.exit(2);
}
const entries = entriesOf(subject, registry);
const endpoints = mainnetEndpoints(process.env);
const reader = createReader(endpoints, httpsTransport());
const latest = await reader.block('latest');
if (latest.kind === 'unverifiable') throw new Error(latest.reason);

const [defillama, coingecko] = await Promise.all([fetchListing(DEFILLAMA_PROTOCOLS), fetchListing(COINGECKO_COINS)]);
const listings = { protocols: parseDefiLlamaProtocols(defillama), coinsByAddress: parseCoinGeckoCoins(coingecko), suffixes };
const docs = subject.kind === 'template' ? subject.docs.map((d) => d.url) : [];
const pages = await gatherSourcePages([...entries.map((e) => e.source), ...docs], httpsGet);

const recorded = loadAbiCases(root);
const abi = new Map<Address, AbiProof | AbiRefusal>();
for (const entry of entries) {
  const deps = { sourcify: sourcifyHttps, compilers };
  if (flags.record && !recorded.has(entry.address)) {
    const { proof, fixture } = await recordAbiCase(reader, entry.address, latest.value, latest.providers, deps);
    writeFileSync(join(root, 'testdata', 'abi', `${entry.name.replace(/\./g, '-')}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    abi.set(entry.address, proof);
  } else abi.set(entry.address, await proveAbi(reader, entry.address, latest.value, deps));
}

const alchemy = alchemyCall(httpsTransport(), endpoints[0].url);
const vaults = new Map<string, string>();
for (const vault of vaultsOf(subject, registry)) {
  console.error(`reading ${vault.name}`);
  vaults.set(vault.name, (await vaultEvidenceText(reader, alchemy, registry, vault)).text);
}

const snapshot = loadSnapshot();
if ('unavailable' in snapshot) {
  console.error(snapshot.unavailable);
  process.exit(1);
}
const erc7730Chain = recordingTransport(httpsTransport(), endpoints);
const erc7730 = await erc7730Text(entries, registry, snapshot, () => chainAt(createReader(endpoints, erc7730Chain.transport)));

const pastTxs = await Promise.all(pastTxsRecordings(root, subject).map(({ file, recording }) => summarizePastTxs(root, registry, file, recording)));
const fetched = new Date();
const live = { subject, registry, listings, pages, fetched: fetched.toISOString().slice(0, 10), abi, vaults, pastTxs, erc7730: erc7730.text };
const command = id === undefined ? `pnpm report --vault ${flags.vault}` : `pnpm report ${id}`;
const text = renderReport(live, { command, sources: ['live reads at the time it ran', ...pastTxs.map((p) => p.file)] });

if (flags.compare) {
  const differences = compareReports(readFileSync(committedPath, 'utf8'), text);
  for (const line of differences) console.log(`DIFFERS  ${line}`);
  console.log(
    differences.length === 0
      ? `${generatedPath(target)}: every fact read live equals the committed report (dates, block numbers and vault time series not compared)`
      : `${generatedPath(target)}: ${differences.length} fact(s) differ from what was read live`,
  );
  process.exit(differences.length === 0 ? 0 : 1);
}
console.log(text);

if (flags.record) {
  const erc7730Section = { commit: snapshot.commit, files: Object.fromEntries(trimErc7730(snapshot, erc7730.reports)), chain: erc7730Chain.exchanges() };
  const recording = JSON.stringify(trimReportRecording(subject, entries, listings, pages, fetched, vaults, erc7730Section), null, 2);
  const safe = loadConfig(kissSignHome(process.env))?.safe;
  if (safe !== undefined && recording.toLowerCase().includes(safe.slice(2))) {
    console.error('the recording would name the configured Safe; nothing written');
    process.exit(1);
  }
  mkdirSync(dirname(join(root, reportRecordingPath(target))), { recursive: true });
  writeFileSync(join(root, reportRecordingPath(target)), `${recording}\n`);
  mkdirSync(dirname(committedPath), { recursive: true });
  writeFileSync(committedPath, await replayReport(root, registry, target, compilers, suffixes));
  console.error(`recorded ${reportRecordingPath(target)} and wrote ${generatedPath(target)}`);
}
