import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  GENERATED_FILE,
  entriesOf,
  erc7730Text,
  loadSubject,
  pastTxsRecordings,
  renderReport,
  replayTemplateReport,
  reportRecordingPath,
  summarizePastTxs,
  trimReportRecording,
  vaultsOf,
} from '../src/research/report.ts';
import { gatherSourcePages, httpsGet } from '../src/research/source-page.ts';
import { alchemyCall, vaultEvidenceText } from '../src/research/vault-evidence.ts';
import type { Address } from '../src/safe/types.ts';
import { TEMPLATES_DIR } from '../src/template/template.ts';

const USAGE = `usage: ALCHEMY_API_KEY=... node scripts/report.ts <protocol>/<operation> [--record]
       node scripts/report.ts <protocol>/<operation> --offline
       ALCHEMY_API_KEY=... node scripts/report.ts --vault <registry vault name>

Prints the generated part of a template's report, read live: each field's rule from template.json, each function's
page from docs.json checked against DefiLlama and the page itself, pnpm check-sources and pnpm prove-abi for every
registry entry the operation can touch with its code pin, pnpm vault-evidence for every vault its card can name, the
past-txs recordings of the template studied again, and pnpm erc7730 for every such entry (pnpm fetch-erc7730 first).
--vault prints the same for one vault, for a pull request that adds it.

--record also writes the live answers to testdata/report/<protocol>-<operation>.json, records an ABI case for each
entry testdata/abi/ lacks, and writes templates/<protocol>/<operation>/${GENERATED_FILE} from those recordings alone.
--offline prints that file's text from the recordings, reading nothing live.`;

const { values: flags, positionals } = parseArgs({
  options: { vault: { type: 'string' }, record: { type: 'boolean' }, offline: { type: 'boolean' } },
  allowPositionals: true,
});
const [id] = positionals;
if ((id === undefined) === (flags.vault === undefined) || positionals.length > 1 || (flags.vault !== undefined && (flags.record || flags.offline)) || (flags.record && flags.offline)) {
  console.error(USAGE);
  process.exit(2);
}

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
const suffixes = loadPublicSuffixList();
const compilers = cachedCompilers();

if (flags.offline) {
  process.stdout.write(await replayTemplateReport(root, registry, id!, compilers, suffixes));
  process.exit(0);
}

const subject = loadSubject(root, registry, id === undefined ? { vault: flags.vault! } : { template: id });
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
console.log(renderReport(live, { command, sources: ['live reads at the time it ran', ...pastTxs.map((p) => p.file)] }));

if (flags.record && subject.kind === 'template') {
  const erc7730Section = { commit: snapshot.commit, files: Object.fromEntries(trimErc7730(snapshot, erc7730.reports)), chain: erc7730Chain.exchanges() };
  const recording = JSON.stringify(trimReportRecording(subject, entries, listings, pages, fetched, vaults, erc7730Section), null, 2);
  const safe = loadConfig(kissSignHome(process.env))?.safe;
  if (safe !== undefined && recording.toLowerCase().includes(safe.slice(2))) {
    console.error('the recording would name the configured Safe; nothing written');
    process.exit(1);
  }
  mkdirSync(join(root, 'testdata', 'report'), { recursive: true });
  writeFileSync(join(root, reportRecordingPath(subject.template.id)), `${recording}\n`);
  const generated = join(root, TEMPLATES_DIR, subject.template.id, GENERATED_FILE);
  writeFileSync(generated, await replayTemplateReport(root, registry, subject.template.id, compilers, suffixes));
  console.error(`recorded ${reportRecordingPath(subject.template.id)} and wrote ${join(TEMPLATES_DIR, subject.template.id, GENERATED_FILE)}`);
}
