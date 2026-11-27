import { join } from 'node:path';
import { openMainnetReader } from '../src/chain/reader.ts';
import { describeRefusal, proveAbi } from '../src/contracts/prove.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import { etherscanFromEnv } from '../src/contracts/etherscan.ts';
import { loadRegistry } from '../src/registry.ts';
import { checksumAddress, parseAddress } from '../src/safe/types.ts';
import { ensureVendored } from '../src/vendor.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = 'usage: pnpm prove-abi <address>';
const HELP = `${USAGE}

Proves a contract's ABI live and prints the proof. Etherscan's verified source, compiled with a
pinned solc, must give the code both providers read at the latest block; behind a proxy it proves
the implementation. An implementation that hands a call it has no function for to one constant
address, its extension, has that extension's source proven the same way, and the extension's
functions join the ABI; one with a selector of the implementation's own is refused. A masked
metadata hash prints as FINDING. A solc that is not pinned is refused,
naming pnpm pin-solc. A registry entry with routes prints NOT PROVABLE, since its calls run in the
implementations its routes reach (pnpm pin-code pins those). For an entry with implementationRead
it finds the implementation through those views and accepts it only when a call to the proxy's
fallback, with that implementation's code replaced by a probe, answers the probe's word. A missing
or changed pinned solc is downloaded first, as pnpm fetch-solc does. NOT PROVABLE and REFUSED
exit 1.

Writes: nothing, except vendor/solc/ when a pinned solc is missing or differs from its pin.
Keys: ALCHEMY_API_KEY, DRPC_API_KEY and ETHERSCAN_API_KEY, from the environment or
  $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 3,
Establish the ABI; step 2, Pin the routes and Declare the implementation read).`;

exitOnHelp(HELP);

const [addressArg] = process.argv.slice(2);
if (addressArg === undefined) throw new Error(`${USAGE}, with ALCHEMY_API_KEY and ETHERSCAN_API_KEY`);
const address = parseAddress('address', addressArg);

const entry = loadRegistry(join(import.meta.dirname, '..')).byAddress.get(address);
if (entry?.routes !== undefined) {
  console.log(`NOT PROVABLE ${checksumAddress(address)}: ${entry.name} is a selector-routed proxy, whose calls run in the implementations its routes reach; its routes are pinned, see pnpm pin-code ${entry.name}`);
  process.exit(1);
}

if (!(await ensureVendored(['solc']))) process.exit(1);
const etherscan = etherscanFromEnv(process.env);
const reader = openMainnetReader(process.env);
const block = await reader.block('latest');
if (block.kind === 'unverifiable') throw new Error(block.reason);

const started = performance.now();
const proof = await proveAbi(reader, address, block.value, { etherscan, compilers: pinnedCompilers() }, entry);
const seconds = ((performance.now() - started) / 1000).toFixed(1);

if (proof.kind === 'refused') {
  console.log(`REFUSED ${checksumAddress(address)} at block ${block.value.number}: ${describeRefusal(proof.refusal)}`);
  process.exit(1);
}
const proxyNote =
  proof.proxy.kind === 'eip1967-beacon'
    ? ` (beacon ${checksumAddress(proof.proxy.beacon)})`
    : proof.proxy.kind === 'safe'
      ? ` (${proof.proxy.factory})`
      : '';
const lines = [
  `address        ${checksumAddress(proof.address)}`,
  `block          ${proof.block.number} ${proof.block.hash}`,
  `providers      ${proof.providers.join(', ')}`,
  `proxy          ${proof.proxy.kind}${proxyNote}`,
  ...(proof.proxy.kind === 'none' ? [] : [`implementation ${checksumAddress(proof.proven)}`, `proxyCodeHash  ${proof.proxyCodeHash}`]),
  `compiler       solc ${proof.compiler}`,
  `contract       ${proof.contractPath}:${proof.contractName}`,
  `functions      ${proof.abi.filter((entry) => entry.type === 'function').length}${proof.extension === undefined ? '' : ', the extension\'s included'}`,
  `codeHash       ${proof.codeHash}`,
  `masked         ${proof.immutablesMasked} immutable spans, ${proof.librariesMasked} library spans${proof.metadataHashMasked ? ', the metadata hash' : ''}`,
  ...(proof.metadataHashMasked ? ['FINDING        the metadata hash differs: the verified source is not the deployed text, so its parameter names are not proven'] : []),
  ...(proof.extension === undefined
    ? []
    : [
        `extension      ${checksumAddress(proof.extension.address)}`,
        `  compiler     solc ${proof.extension.compiler}`,
        `  contract     ${proof.extension.contractPath}:${proof.extension.contractName}`,
        `  codeHash     ${proof.extension.codeHash}`,
        `  masked       ${proof.extension.immutablesMasked} immutable spans, ${proof.extension.librariesMasked} library spans${proof.extension.metadataHashMasked ? ', the metadata hash' : ''}`,
        ...(proof.extension.metadataHashMasked ? ["FINDING        the extension's metadata hash differs: its verified source is not the deployed text, so its parameter names are not proven"] : []),
      ]),
  `took           ${seconds}s`,
];
console.log(lines.join('\n'));
