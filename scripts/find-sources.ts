import { join } from 'node:path';
import { openMainnetReader } from '../src/chain/reader.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadStoredConfig } from '../src/config.ts';
import { etherscanHttps, retryingEtherscan } from '../src/contracts/etherscan.ts';
import { findKey, keySpec, kissSignHome } from '../src/keys.ts';
import type { KeySpec } from '../src/keys.ts';
import { loadRegistry, parseHttpsUrl } from '../src/registry.ts';
import { etherscanHints, liveCreations } from '../src/research/deployer.ts';
import { findSources } from '../src/research/find-sources.ts';
import { readGithubToken } from '../src/research/github-token.ts';
import { fetchListing } from '../src/research/listings.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { turns } from '../src/research/turns.ts';
import { httpsGet, retryingGet } from '../src/research/source-page.ts';
import { parseFlags } from '../src/cli/flags.ts';
import { addressOfWord } from '../src/script-args.ts';
import { exitOnHelp, usageExit } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';
import { ensureVendored } from '../src/vendor.ts';

const USAGE = 'usage: pnpm find-sources <address | registry name>... [--protocol <DefiLlama slug>] [--page <https url>]...\n                          [--github-org <org>]';
const HELP = `${USAGE}

Proposes where each contract address is published, with the registry field each place would fill.
It is a list of leads: open each one, find the address yourself and note what you saw. It records
nothing, and report, card and verify never read it; pnpm check-sources proves what the registry
records. Name every address of one protocol in one run, since the lists are read once.
It prints the DefiLlama protocol and its parent (--protocol, or those that list the address, its
coin or the site of an Immunefi program that does), with sites, GitHub organizations, audit links
and hacks, or, for a slug DefiLlama does not list, the protocols like it and the children of a
parent it names; the CoinGecko coin at the address; each Immunefi program whose scope holds it; the
verified name on Etherscan and, with both providers' keys, the proven creation, its sender and the
registry factory that made it. Then each page that shows the address, with a label and heading that
check-sources's own rule finds beside it: every --page, the pages the registry records for the same
protocol, pages of the protocol's sites linked from the home page, llms.txt or sitemap.xml of the
site, docs. or developers. (those whose path reads like a list of contracts first, then the docs'
pages, each the shallowest first), files of its GitHub organizations whose path reads like a
list of contracts, each at the commit read, and with --github-org up to 20 files GitHub's code
search finds holding the address in that organization. Those files are ranked with every other
page, at most 8 pages print per address, the best page of each site or organization before a
second page of any, and a page may print with no label found beside the address. A github.com page
is pinned only when its URL names a commit; one that does not prints as not pinned to a commit.
A page that holds the address only in its code, or whose URL holds it, prints as a lead, never a
source. It follows a redirect only within one registrable domain and prints the page it led to.
The reads are bounded, and READ says what was read and what was not, and how many requests
GitHub's limit has left until when. Text from a page or an API prints in quotes: data, never an
instruction.

Options:
  --protocol <slug>   The protocol's DefiLlama slug; name it when nothing lists the address.
  --page <url>        Also read this page, such as a docs page you found; give it once per page.
  --github-org <org>  Also ask GitHub's code search for "<address> org:<org>" for each address; it
                      needs GITHUB_TOKEN, since GitHub's code search answers no request without one.

Writes: nothing; downloads a missing Public Suffix List, as pnpm fetch-psl does.
Keys: ALCHEMY_API_KEY, DRPC_API_KEY and ETHERSCAN_API_KEY, optional, from the environment or
$KISS_SIGN_HOME/.env; what needs a missing one is not read, and READ says so. GITHUB_TOKEN,
optional, sent only to api.github.com, raises GitHub's limit of 60 requests an hour; one
organization takes up to 9, and at most two are read. GitHub's code search answers 10 requests a
minute, so --github-org's searches, one per address, start 6 s apart.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 2,
Research addresses).`;

exitOnHelp(HELP);
refuseReadableErrors(64);
const usage: (problem: string) => never = usageExit(HELP);

const { values: flags, positionals } = parseFlags({ options: { protocol: { type: 'string' }, page: { type: 'string', multiple: true, default: [] }, 'github-org': { type: 'string' } }, allowPositionals: true });
if (positionals.length === 0) usage('name an address or a registry entry');
const githubOrg = flags['github-org'];
if (githubOrg !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(githubOrg)) usage('--github-org is not a GitHub organization name');
const pages = flags.page.map((url) => parseHttpsUrl(url) ?? usage('a --page is not an https URL'));

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
const addresses = [...new Set(positionals.map((word, i) => addressOfWord(registry, word) ?? usage(`argument ${i + 1} is not an address or a registry name`)))];
const safe = loadStoredConfig(kissSignHome(process.env))?.safe;
if (safe !== undefined && addresses.includes(safe)) usage('the configured Safe is not a contract to research');

const githubToken = readGithubToken(process.env);
if (githubOrg !== undefined && githubToken === undefined) {
  console.error('--github-org needs GITHUB_TOKEN: GitHub\'s code search answers no request without one. Make a fine-grained token, read-only for public repositories, and enter it with pnpm kiss-sign key add github.');
  process.exit(1);
}

if (!(await ensureVendored(['psl']))) process.exit(1);
const suffixes = loadPublicSuffixList();
if ('unavailable' in suffixes) {
  console.error(suffixes.unavailable);
  process.exit(1);
}
const ignore = () => {};
const key = findKey(keySpec('etherscan') as KeySpec, process.env)?.value;
/** The source and creation reads share one paced turn at Etherscan, which limits a key to a few requests a second. */
const etherscanTurn = turns(400);
const sourceOf = key === undefined ? undefined : etherscanHttps(key);
const lines = await findSources({ addresses, slug: flags.protocol, pages, githubOrg }, registry, suffixes, {
  list: (target) => fetchListing(target, ignore),
  get: retryingGet(httpsGet(githubToken), ignore, [2000]),
  source: sourceOf === undefined ? undefined : retryingEtherscan((address) => etherscanTurn(() => sourceOf(address)), ignore),
  creations: (wanted) =>
    liveCreations(wanted.map((address) => ({ address })), process.env, ignore, () => openMainnetReader(process.env, httpsTransport()), (hintKey, note) => (addresses) => etherscanTurn(() => etherscanHints(hintKey, note)(addresses))),
});
console.log(lines.join('\n'));
