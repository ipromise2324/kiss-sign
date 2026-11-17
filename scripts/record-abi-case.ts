import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMainnetReader } from '../src/chain/reader.ts';
import { recordAbiCase } from '../src/contracts/abi-case.ts';
import { describeRefusal } from '../src/contracts/prove.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { retryingSourcify, sourcifyHttps } from '../src/contracts/sourcify.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseAddress, parseUint256 } from '../src/safe/types.ts';
import { ensureVendored } from '../src/vendor.ts';
import { recordingText } from '../src/chain/bytecode.ts';

const USAGE = 'usage: ALCHEMY_API_KEY=... node scripts/record-abi-case.ts <name> <address> [block]';

const [name, addressArg, blockArg] = process.argv.slice(2);
if (name === undefined || addressArg === undefined || !/^[a-z0-9-]+$/.test(name)) throw new Error(USAGE);
const address = parseAddress('address', addressArg);

if (!(await ensureVendored(['solc']))) process.exit(1);
const live = openMainnetReader(process.env);
const block = await live.block(blockArg === undefined ? 'latest' : parseUint256('block', blockArg));
if (block.kind === 'unverifiable') throw new Error(block.reason);

const unread: string[] = [];
const sourcify = retryingSourcify(sourcifyHttps, (read) => void unread.push(read));
const entry = loadRegistry(join(import.meta.dirname, '..')).byAddress.get(address);
const { proof, fixture } = await recordAbiCase(live, address, block.value, block.providers, { compilers: pinnedCompilers(), sourcify }, entry);
const refusal = unreadRefusal(unread);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(1);
}
const out = join(import.meta.dirname, '..', 'testdata', 'abi', `${name}.json`);
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, recordingText(fixture, 2));
const verdict = proof.kind === 'proven' ? `proven ${proof.contractName} at ${proof.proven}` : `refused: ${describeRefusal(proof.refusal)}`;
console.log(`wrote ${out}: block ${fixture.block.number}, agreed by ${fixture.providers.join(' and ')}, ${verdict}`);
