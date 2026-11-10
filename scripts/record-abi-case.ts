import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMainnetReader } from '../src/chain/reader.ts';
import { recordAbiCase } from '../src/contracts/abi-case.ts';
import { describeRefusal } from '../src/contracts/prove.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import { sourcifyHttps } from '../src/contracts/sourcify.ts';
import { parseAddress, parseUint256 } from '../src/safe/types.ts';

const USAGE = 'usage: ALCHEMY_API_KEY=... node scripts/record-abi-case.ts <name> <address> [block]';

const [name, addressArg, blockArg] = process.argv.slice(2);
if (name === undefined || addressArg === undefined || !/^[a-z0-9-]+$/.test(name)) throw new Error(USAGE);
const address = parseAddress('address', addressArg);

const live = openMainnetReader(process.env);
const block = await live.block(blockArg === undefined ? 'latest' : parseUint256('block', blockArg));
if (block.kind === 'unverifiable') throw new Error(block.reason);

const { proof, fixture } = await recordAbiCase(live, address, block.value, block.providers, { compilers: pinnedCompilers(), sourcify: sourcifyHttps });
const out = join(import.meta.dirname, '..', 'testdata', 'abi', `${name}.json`);
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
const verdict = proof.kind === 'proven' ? `proven ${proof.contractName} at ${proof.proven}` : `refused: ${describeRefusal(proof.refusal)}`;
console.log(`wrote ${out}: block ${fixture.block.number}, agreed by ${fixture.providers.join(' and ')}, ${verdict}`);
