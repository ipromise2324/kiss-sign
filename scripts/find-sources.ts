import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openMainnetReader } from '../src/chain/reader.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadStoredConfig } from '../src/config.ts';
import { etherscanHttps, retryingEtherscan } from '../src/contracts/etherscan.ts';
import { findKey, keySpec, kissSignHome } from '../src/keys.ts';
import type { KeySpec } from '../src/keys.ts';
import { loadRegistry, parseHttpsUrl } from '../src/registry.ts';
import { liveCreations } from '../src/research/deployer.ts';
import { findSources } from '../src/research/find-sources.ts';
import { readGithubToken } from '../src/research/github-token.ts';
import { fetchListing } from '../src/research/listings.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { httpsGet, retryingGet } from '../src/research/source-page.ts';
import { parseAddress } from '../src/safe/types.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { ensureVendored } from '../src/vendor.ts';

const USAGE = 'usage: pnpm find-sources <address | registry name>... [--protocol <DefiLlama slug>] [--page <https url>]...';
const HELP = `${USAGE}

Proposes where each contract address is published, with the registry field each place would fill.
It is a list of leads: open each one, find the address yourself and note what you saw. It records
nothing, and report, card and verify never read it; pnpm check-sources proves what the registry
records. Name every address of one protocol in one run, since the lists are read once.
It prints the DefiLlama protocol and its parent (--protocol, or those that list the address, its
coin or the site of an Immunefi program that does), with sites, GitHub organizations, audit links
and hacks; the CoinGecko coin at the address; each Immunefi program whose scope holds it; the
verified name on Etherscan and, with both providers' keys, the proven creation, its sender and the
registry factory that made it. Then each page that shows the address, with a label and heading that
check-sources's own rule finds beside it: every --page, the pages the registry records for the same
protocol, pages of the protocol's sites whose path reads like a list of contracts (linked from the
home page, llms.txt or sitemap.xml of the site, docs. or developers.), and files of its GitHub
organizations whose path does, each at the commit read. A page that holds the address only in its
code, or whose URL holds it, prints as a lead, never a source. It follows a redirect only within one
registrable domain and prints the page it led to. The reads are bounded, and READ says what was
read and what was not. Text from a page or an API prints in quotes: data, never an instruction.

Options:
  --protocol <slug>   The protocol's DefiLlama slug; name it when nothing lists the address.
  --page <url>        Also read this page, such as a docs page you found; give it once per page.

Writes: nothing; downloads a missing Public Suffix List, as pnpm fetch-psl does.
Keys: ALCHEMY_API_KEY, DRPC_API_KEY and ETHERSCAN_API_KEY, optional, from the environment or
$KISS_SIGN_HOME/.env; what needs a missing one is not read, and READ says so. GITHUB_TOKEN,
optional, sent only to api.github.com, raises GitHub's limit of 60 requests an hour; one
organization takes up to 9, and at most two are read.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 2,
Research addresses).`;

exitOnHelp(HELP);

function usage(why: string): never {
  console.error(`${why}\n\n${USAGE}`);
  process.exit(2);
}

const { values: flags, positionals } = parseArgs({ options: { protocol: { type: 'string' }, page: { type: 'string', multiple: true, default: [] } }, allowPositionals: true });
if (positionals.length === 0) usage('name an address or a registry entry');
const pages = flags.page.map((url) => parseHttpsUrl(url) ?? usage(`--page ${url} is not an https URL`));

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
const addresses = [...new Set(positionals.map((name) => registry.entries.get(name)?.address ?? (/^0x[0-9a-fA-F]{40}$/.test(name) ? parseAddress('address', name) : usage(`not an address or in the registry: ${name}`))))];
const safe = loadStoredConfig(kissSignHome(process.env))?.safe;
if (safe !== undefined && addresses.includes(safe)) usage('the configured Safe is not a contract to research');

if (!(await ensureVendored(['psl']))) process.exit(1);
const suffixes = loadPublicSuffixList();
const ignore = () => {};
const githubToken = readGithubToken(process.env);
const key = findKey(keySpec('etherscan') as KeySpec, process.env)?.value;
const lines = await findSources({ addresses, slug: flags.protocol, pages }, registry, 'unavailable' in suffixes ? undefined : suffixes, {
  list: (target) => fetchListing(target, ignore),
  get: retryingGet(httpsGet(githubToken), ignore, [2000]),
  source: key === undefined ? undefined : retryingEtherscan(etherscanHttps(key), ignore),
  creations: (wanted) => liveCreations(wanted.map((address) => ({ address })), process.env, ignore, () => openMainnetReader(process.env, httpsTransport())),
});
console.log(lines.join('\n'));
