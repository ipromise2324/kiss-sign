import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addSolcPin, nodePinSolcIo, resolveSolcPin } from '../src/contracts/pin-solc.ts';
import { SOLC_PINS } from '../src/contracts/solc-pins.ts';
import { readGithubToken } from '../src/research/github-token.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = 'usage: pnpm pin-solc <version>, such as 0.4.18+commit.9cf6e910';
const HELP = `${USAGE}

Pins a solc build in src/contracts/solc-pins.ts, kept sorted by version, only when these sha256
agree: the one soliditylang's bin/list.json gives; that of the soljson.js asset of the GitHub
release v<semver> of argotorg/solidity, downloaded and hashed on its own; and, from 0.6.2 on, the
one wasm/list.json, on the same host as bin/list.json, gives. It prints each URL it read with what
it found, then pinned, or unchanged for a version already pinned with that hash. It prints REFUSED
and exits 1 for a version not in the list or not its release, a missing release or asset, an asset
larger than 64 MiB, any disagreement, and a version pinned with another hash, printing both.
pnpm prove-abi names this command when it refuses an unpinned compiler. A new pin is a program
change, so the pull request that needs it says so to the signer.

Writes: src/contracts/solc-pins.ts.
Keys: GITHUB_TOKEN, optional, from the environment or $KISS_SIGN_HOME/.env, sent only to
api.github.com; it raises GitHub's limit from 60 to 5,000 requests an hour and changes no answer.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 3,
Establish the ABI); docs/design/known-limits.md, "Known limits".`;

exitOnHelp(HELP);

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error(USAGE);
  process.exit(2);
}
const [version] = args as [string];

const resolution = await resolveSolcPin(version, nodePinSolcIo(readGithubToken(process.env)));
for (const read of resolution.reads) console.log(`read ${read}`);
if (resolution.kind === 'refused') {
  console.log(`REFUSED solc ${version}: ${resolution.why}`);
  process.exit(1);
}

const path = join(import.meta.dirname, '..', 'src', 'contracts', 'solc-pins.ts');
const change = addSolcPin(readFileSync(path, 'utf8'), SOLC_PINS, version, resolution.pin);
switch (change.kind) {
  case 'conflict':
    console.log(`REFUSED solc ${version}: already pinned as ${change.pinned.file} sha256 ${change.pinned.sha256}; the sources agree on ${resolution.pin.file} sha256 ${resolution.pin.sha256}`);
    process.exit(1);
  case 'unchanged':
    console.log(`unchanged solc ${version}: already pinned as ${resolution.pin.file} sha256 ${resolution.pin.sha256}`);
    break;
  case 'written':
    writeFileSync(path, change.text);
    console.log(`pinned solc ${version} in src/contracts/solc-pins.ts: ${resolution.pin.file} sha256 ${resolution.pin.sha256}`);
    break;
}
