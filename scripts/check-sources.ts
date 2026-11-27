import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { colorWanted, markWords, paint } from '../src/cli/format.ts';
import { join } from 'node:path';
import { unreadRefusal } from '../src/chain/https.ts';
import { MARKETS_PATH, REGISTRY_PATH, attributesText, loadRegistry, pageUrlsOf, registryFromTexts } from '../src/registry.ts';
import { gatherApiAnswers, httpsApi, retryingSend } from '../src/research/api-source.ts';
import { askedOnce, checkSources, formatResults, listingsFor, liveListingReads, mergedRecording, trimForRecording } from '../src/research/listings.ts';
import type { ListingsRecording } from '../src/research/listings.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { gatherSourcePages, httpsGet, retryingGet } from '../src/research/source-page.ts';
import { readGithubToken } from '../src/research/github-token.ts';
import { ensureVendored } from '../src/vendor.ts';
import { openMainnetReader } from '../src/chain/reader.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { liveCreations } from '../src/research/deployer.ts';
import { gatherPackages, provenanceRepositories } from '../src/research/npm-package.ts';
import { parseFlags } from '../src/cli/flags.ts';
import { UsageError } from '../src/cli/io.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';

const USAGE = 'usage: pnpm check-sources [<registry name>...] [--record <name>]';
const HELP = `${USAGE}

Checks where each registry entry's address is published and prints each comparison. It compares
the site of the entry's source with the protocol its defillama slug names (registrable domain by
the Public Suffix List, or a github.com source's org); DefiLlama's parent protocol, CoinGecko's
coin links, the Immunefi program the entry names and GitHub's verified domains add sites, and only
DefiLlama's can make one differ. It requires the address next to sourceLabel (under sourceHeading)
on the source page as served without scripts, and the same for each of moreSources; a github.com
page must be pinned to a commit on the default branch. It checks CoinGecko's coin at each token's
and vault's address, an apiSource's JSON answer, the scope of the Immunefi programs tied to the
protocol, an sdk tarball's file and provenance, and what the same label binds in the newest version
of each pinned place. With ALCHEMY_API_KEY and ETHERSCAN_API_KEY it also proves each entry's
creation and names other entries of the protocol the same sender deployed. It ends with the sites
each protocol's sources use. With no names it checks every entry. Each disagreement, missing
listing, or missing Public Suffix List prints as FINDING for the signer to judge, and a place the
program reads that lists nothing to compare prints as not listed, neither evidence nor a
disagreement; nothing fails. A read with no answer is asked again after each pause and prints as
UNVERIFIABLE if it never answers, and then --record writes nothing and exits 1.
It downloads a missing or changed Public Suffix List first, as pnpm fetch-psl does.

Options:
  --record <name>   Write testdata/sources/<name>.json; refused, writing nothing, when a read got
                    no answer. <name> takes lowercase letters, digits and -. With registry names,
                    each read those entries make replaces the file's, a list or page other entries
                    share included, since it is current for them too; the file keeps every read
                    only other entries make and drops one no entry makes any more, counting the
                    entries of test/fixtures/registry, which the tests read the file with. It is
                    refused when an Immunefi, CoinGecko coin or GitHub organization read of this
                    run got no answer, and says which. With no names, the file is written anew
                    from every entry.

A new or changed registry entry needs its reads in the recording the tests read:
  pnpm check-sources <name>... --record registry

Writes: testdata/sources/<name>.json with --record, otherwise nothing.
Keys: ALCHEMY_API_KEY, DRPC_API_KEY and ETHERSCAN_API_KEY, optional, from the environment or
$KISS_SIGN_HOME/.env;
without them the deployer check is skipped with a NOTE. GITHUB_TOKEN, optional, sent only to
api.github.com; it raises GitHub's limit from 60 to 5,000 requests an hour and changes no answer.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 2, Check
the sources against public listings through How the places count);
docs/design/engine-and-chain.md, "Research services".`;

exitOnHelp(HELP);
refuseReadableErrors();

const { values: flags, positionals: names } = parseFlags({ options: { record: { type: 'string' } }, allowPositionals: true });
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new UsageError('--record takes a name of lowercase letters, digits and -');

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
const unknown = names.filter((name) => !registry.entries.has(name));
if (unknown.length > 0) {
  console.error(`not in the registry: ${unknown.join(', ')}\n\n${USAGE}`);
  process.exit(2);
}
const entries = names.length === 0 ? [...registry.entries.values()] : names.map((name) => registry.entries.get(name)!);

if (!(await ensureVendored(['psl']))) process.exit(1);
const unread: string[] = [];
const note = (read: string) => void unread.push(read);
const githubToken = readGithubToken(process.env);
const get = retryingGet(httpsGet(githubToken), note);
const packages = await gatherPackages(entries, get);
const suffixes = loadPublicSuffixList();
const reads = askedOnce(liveListingReads(note, githubToken));
const listings = await listingsFor(entries, suffixes, reads, [...entries.flatMap(pageUrlsOf), ...provenanceRepositories(packages)]);
const apis = await gatherApiAnswers(entries, retryingSend(httpsApi, note));
const creations = await liveCreations(entries, process.env, note, () => openMainnetReader(process.env, httpsTransport(), { note }));
if ('missing' in creations) console.error(`NOTE  who deployed each entry is not checked: ${creations.missing}`);
const pages = {
  ...(await gatherSourcePages(entries.flatMap(pageUrlsOf), get, apis)),
  packages,
  ...('missing' in creations ? {} : { creations }),
};
console.log(markWords(formatResults(checkSources(entries, listings, pages)), paint(colorWanted(process.stdout.isTTY, process.env))));

/** The registry the tests read a recording with: this one and the entries and markets of test/fixtures/registry, as test/repo-with-test-fixtures.ts adds them. */
function withTestFixtures() {
  const both = (path: string): string => {
    const fixture = join(root, 'test', 'fixtures', path);
    const own = existsSync(join(root, path)) ? JSON.parse(readFileSync(join(root, path), 'utf8')) : {};
    return JSON.stringify({ ...own, ...(existsSync(fixture) ? JSON.parse(readFileSync(fixture, 'utf8')) : {}) });
  };
  return registryFromTexts(both(REGISTRY_PATH), both(MARKETS_PATH), attributesText(root));
}

if (flags.record !== undefined) {
  const dir = join(root, 'testdata', 'sources');
  const path = join(dir, `${flags.record}.json`);
  const merging = names.length > 0 && existsSync(path);
  const written = merging
    ? await mergedRecording([...withTestFixtures().entries.values()], JSON.parse(readFileSync(path, 'utf8')) as ListingsRecording, reads, pages, suffixes, new Date())
    : trimForRecording(entries, listings, pages, new Date());
  const refusal = 'refused' in written ? written.refused : unreadRefusal(unread);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
  console.log(`recorded ${path}${merging ? `: the reads of ${names.join(', ')} and each shared read they made replaced, every read only other entries make kept` : ''}`);
}
