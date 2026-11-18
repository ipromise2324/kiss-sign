import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMainnetReader } from '../src/chain/reader.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { abiCaseDeclaration, recordAbiCase } from '../src/contracts/abi-case.ts';
import type { AbiCase } from '../src/contracts/abi-case.ts';
import { describeRefusal } from '../src/contracts/prove.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { etherscanFromEnv, retryingEtherscan } from '../src/contracts/etherscan.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseAddress, parseUint256 } from '../src/safe/types.ts';
import { ensureVendored } from '../src/vendor.ts';
import { readRecording, recordingText } from '../src/chain/bytecode.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = 'usage: pnpm record-abi-case <name> <address> [<block>]';
const HELP = `${USAGE}

Records an ABI-proof fixture for the contract at <address> into testdata/abi/<name>.json, which
the tests replay offline. It reads the latest block, or <block>, through both providers and proves
the ABI as prove-abi does: Etherscan's verified source, compiled with a pinned solc, must give the
code on chain. Behind a proxy it follows the registry entry's implementationRead for the address
or, when the registry has none, the one testdata/abi/<name>.json was recorded with for the same
address. It writes the fixture whether the proof passes or is refused, and prints which. It writes
nothing when a read got no answer. <name> is lowercase letters, digits and hyphens.

Writes: testdata/abi/<name>.json; vendor/solc/ when a pinned compiler is missing or differs from
its pin.
Keys: ALCHEMY_API_KEY and ETHERSCAN_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 3,
  Establish the ABI).`;

exitOnHelp(HELP);

const [name, addressArg, blockArg] = process.argv.slice(2);
if (name === undefined || addressArg === undefined || !/^[a-z0-9-]+$/.test(name)) throw new Error(USAGE);
const address = parseAddress('address', addressArg);

if (!(await ensureVendored(['solc']))) process.exit(1);
const unread: string[] = [];
const note = (read: string) => void unread.push(read);
const live = openMainnetReader(process.env, httpsTransport(), { note });
const block = await live.block(blockArg === undefined ? 'latest' : parseUint256('block', blockArg));
if (block.kind === 'unverifiable') throw new Error(block.reason);

const etherscan = retryingEtherscan(etherscanFromEnv(process.env), note);
const out = join(import.meta.dirname, '..', 'testdata', 'abi', `${name}.json`);
const earlier = existsSync(out) ? (readRecording(out) as AbiCase) : undefined;
const kept = earlier?.address === address ? abiCaseDeclaration(earlier) : {};
const declared = loadRegistry(join(import.meta.dirname, '..')).byAddress.get(address) ?? kept;
const { proof, fixture } = await recordAbiCase(live, address, block.value, block.providers, { compilers: pinnedCompilers(), etherscan }, declared);
const refusal = unreadRefusal(unread);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(1);
}
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, recordingText(fixture, 2));
const verdict = proof.kind === 'proven' ? `proven ${proof.contractName} at ${proof.proven}` : `refused: ${describeRefusal(proof.refusal)}`;
console.log(`wrote ${out}: block ${fixture.block.number}, agreed by ${fixture.providers.join(' and ')}, ${verdict}`);
