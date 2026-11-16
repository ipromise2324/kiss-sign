import { join } from 'node:path';
import { openMainnetReader } from '../src/chain/reader.ts';
import { describeRefusal, proveAbi } from '../src/contracts/prove.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import { sourcifyHttps } from '../src/contracts/sourcify.ts';
import { loadRegistry } from '../src/registry.ts';
import { checksumAddress, parseAddress } from '../src/safe/types.ts';
import { ensureVendored } from '../src/vendor.ts';

const [addressArg] = process.argv.slice(2);
if (addressArg === undefined) throw new Error('usage: ALCHEMY_API_KEY=... node scripts/prove-abi.ts <address>');
const address = parseAddress('address', addressArg);

const routed = loadRegistry(join(import.meta.dirname, '..')).byAddress.get(address);
if (routed?.routes !== undefined) {
  console.log(`NOT PROVABLE ${checksumAddress(address)}: ${routed.name} is a selector-routed proxy, whose calls run in the implementations its routes reach; its routes are pinned, see pnpm pin-code ${routed.name}`);
  process.exit(1);
}

if (!(await ensureVendored(['solc']))) process.exit(1);
const reader = openMainnetReader(process.env);
const block = await reader.block('latest');
if (block.kind === 'unverifiable') throw new Error(block.reason);

const started = performance.now();
const proof = await proveAbi(reader, address, block.value, { sourcify: sourcifyHttps, compilers: pinnedCompilers() });
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
  `functions      ${proof.abi.filter((entry) => entry.type === 'function').length}`,
  `codeHash       ${proof.codeHash}`,
  `masked         ${proof.immutablesMasked} immutable spans, ${proof.librariesMasked} library spans${proof.metadataHashMasked ? ', the metadata hash (Sourcify holds a partial match)' : ''}`,
  `took           ${seconds}s`,
];
console.log(lines.join('\n'));
