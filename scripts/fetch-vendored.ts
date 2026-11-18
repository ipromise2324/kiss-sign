import { parseArgs } from 'node:util';
import { ensureVendored, fetchVendored, isVendoredKind, nodeVendorIoWith, VENDORED } from '../src/vendor.ts';
import { readGithubToken } from '../src/research/github-token.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = `usage: pnpm fetch-solc [--missing]
usage: pnpm fetch-psl [--missing]
usage: pnpm fetch-erc7730 [--missing]
usage: node scripts/fetch-vendored.ts [--missing] <${Object.keys(VENDORED).join('|')}>...`;
const HELP = `${USAGE}

Downloads each pinned file of a kind into vendor/ and refuses one whose sha256 differs from its pin;
a file that already matches is kept. solc is every compiler src/contracts/solc-pins.ts pins, into
vendor/solc/. psl is the Public Suffix List src/research/public-suffix.ts pins, into
vendor/publicsuffix/. erc7730 is the archive of the ERC-7730 registry src/research/erc7730.ts pins,
into vendor/erc7730/, downloaded only after GitHub's compare API says the pinned commit is on the
default branch. Progress and refusals print on stderr, and it exits 1 when a file does not match.
Other commands run it on demand, printing one line first, when a file they need is missing or
differs from its pin: pnpm test (solc, psl), prove-abi and record-abi-case (solc), check-sources
(psl), erc7730 (erc7730) and report (all three).

Options:
  --missing   Touch only a kind with a file missing or differing from its pin.

Writes: vendor/solc/, vendor/publicsuffix/ or vendor/erc7730/.
Keys: GITHUB_TOKEN, optional, from the environment or $KISS_SIGN_HOME/.env, sent only to
api.github.com, which only erc7730 asks; it raises GitHub's limit from 60 to 5,000 requests an hour
and changes no answer.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 3,
Establish the ABI, for solc; step 2, ERC-7730); docs/design/engine-and-chain.md, "Research
services".`;

exitOnHelp(HELP, process.argv.slice(2).filter((arg) => !isVendoredKind(arg)));

const { values, positionals } = parseArgs({ options: { missing: { type: 'boolean' } }, allowPositionals: true });
const kinds = positionals.filter(isVendoredKind);
if (positionals.length === 0 || kinds.length !== positionals.length) {
  console.error(USAGE);
  process.exit(2);
}
const io = nodeVendorIoWith(readGithubToken(process.env));
let ok = true;
if (values.missing) ok = await ensureVendored(kinds, io);
else for (const kind of kinds) ok = (await fetchVendored(kind, io)) && ok;
if (!ok) process.exit(1);
