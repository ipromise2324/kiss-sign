import type { Reader } from '../chain/reader.ts';
import type { BlockRef } from '../chain/types.ts';
import { readRunningCode, readRunningCodeAt } from '../contracts/code.ts';
import type { EtherscanGet } from '../contracts/etherscan.ts';
import { proveInstance } from '../contracts/instance.ts';
import { proveAbi } from '../contracts/prove.ts';
import type { compilersAhead } from '../contracts/solc.ts';
import { pageUrlsOf } from '../registry.ts';
import type { Registry, RegistryEntry } from '../registry.ts';
import { gatherApiAnswers } from './api-source.ts';
import type { ApiSend } from './api-source.ts';
import type { liveCreations } from './deployer.ts';
import { vaultEvidenceText } from './instance-evidence.ts';
import type { AlchemyCall } from './instance-evidence.ts';
import { listingsFor } from './listings.ts';
import type { ListingReads, Listings } from './listings.ts';
import { gatherPackages, provenanceRepositories } from './npm-package.ts';
import { inPool } from './pool.ts';
import { factsScope, protocolFacts } from './protocol-facts.ts';
import { entriesOf, evidenceEntries, instanceEntries, provedEntries } from './report.ts';
import type { Subject } from './report.ts';
import { gatherSourcePages } from './source-page.ts';
import type { HttpGet } from './source-page.ts';

const CODE_WIDTH = 8;
const PAGE_WIDTH = 6;
const FACT_WIDTH = 8;
const ABI_WIDTH = 4;

/** Where a report's reads go: each keeps its answers (`kept`), so a read made here is not made again. */
export type ReportSources = {
  readonly reader: Reader;
  readonly get: HttpGet;
  readonly send: ApiSend;
  readonly listings: ListingReads;
  readonly etherscan: EtherscanGet;
  readonly alchemy: AlchemyCall;
  readonly creations: () => ReturnType<typeof liveCreations>;
};

/**
 * Makes the reads of a report's sections several at a time, for their kept answers alone: every result is dropped and no
 * failure counts, since the sections then run in order, find the answers kept, and ask themselves for any read that got none.
 */
export async function warmReport(
  sources: ReportSources,
  subject: Subject,
  registry: Registry,
  suffixes: Listings['suffixes'],
  blocks: { readonly settled: BlockRef; readonly head: BlockRef },
  ahead: ReturnType<typeof compilersAhead>['ahead'],
): Promise<void> {
  const { reader, get, send, etherscan, alchemy } = sources;
  const entries = entriesOf(subject, registry);
  const pageUrls = [...new Set([...entries.flatMap(pageUrlsOf), ...subject.docs.map((d) => d.url)])];
  const drop = () => undefined;

  const listed = async () => {
    const packages = await gatherPackages(entries, get);
    await listingsFor(entries, suffixes, sources.listings, [...pageUrls, ...provenanceRepositories(packages)]);
  };
  const pages = () => inPool(pageUrls, PAGE_WIDTH, (url) => gatherSourcePages([url], get).catch(drop));
  const apis = () => inPool(entries, PAGE_WIDTH, (entry) => gatherApiAnswers([entry], send).catch(drop));

  const code = () => {
    const spans = entries.flatMap((entry) => {
      const pins = entry.code === undefined ? [] : [...entry.code.earlier, entry.code.current];
      return pins.flatMap(({ from }) => (from === 0n ? [] : [from, from - 1n])).map((number) => ({ entry, number }));
    });
    const now = entries.map((entry) => ({ entry, number: undefined }));
    return inPool([...now, ...spans], CODE_WIDTH, ({ entry, number }) =>
      (number === undefined ? readRunningCode(reader, entry.address, blocks.settled, entry) : readRunningCodeAt(reader, entry.address, number, entry)).catch(drop),
    );
  };
  const instances = () => inPool(instanceEntries(subject, registry), CODE_WIDTH, (entry) => proveInstance(reader, registry, entry.name, blocks.settled).catch(drop));
  const proved = provedEntries(subject, registry);
  const prove = (entry: RegistryEntry) => ahead((compilers) => proveAbi(reader, entry.address, blocks.settled, { etherscan, compilers }, entry));
  const abi = () => inPool(proved, ABI_WIDTH, (entry) => prove(entry).catch(drop));
  const evidence = () => inPool(evidenceEntries(subject), 1, (vault) => vaultEvidenceText(reader, alchemy, registry, vault, blocks.head.number).catch(drop));

  const facts = () => {
    if (subject.kind !== 'template') return Promise.resolve([]);
    const scope = factsScope(subject.template, registry, entries);
    const parts = [...scope.reads.map((read) => ({ ...scope, reads: [read], tokens: [] })), ...scope.tokens.map((token) => ({ ...scope, reads: [], tokens: [token] }))];
    return inPool(parts, FACT_WIDTH, (part) => protocolFacts(part, registry, { defillama: sources.listings.list, reader, block: blocks.settled }).catch(drop));
  };

  await Promise.allSettled([listed(), pages(), apis(), sources.creations(), code(), instances(), abi(), evidence(), facts()]);
}
