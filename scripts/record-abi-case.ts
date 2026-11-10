import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMainnetReader } from '../src/chain/reader.ts';
import type { Read, Reader } from '../src/chain/reader.ts';
import { describeRefusal, proveAbi } from '../src/contracts/prove.ts';
import { pinnedCompilers } from '../src/contracts/solc.ts';
import { sourcifyHttps } from '../src/contracts/sourcify.ts';
import type { SourcifyAnswer } from '../src/contracts/sourcify.ts';
import { parseAddress, parseUint256 } from '../src/safe/types.ts';

const USAGE = 'usage: ALCHEMY_API_KEY=... node scripts/record-abi-case.ts <name> <address> [block]';

const [name, addressArg, blockArg] = process.argv.slice(2);
if (name === undefined || addressArg === undefined || !/^[a-z0-9-]+$/.test(name)) throw new Error(USAGE);
const address = parseAddress('address', addressArg);

const live = openMainnetReader(process.env);
const block = await live.block(blockArg === undefined ? 'latest' : parseUint256('block', blockArg));
if (block.kind === 'unverifiable') throw new Error(block.reason);

type Recorded = { method: string; args: unknown[]; value: unknown };
const reads: Recorded[] = [];
const hex = (n: bigint) => `0x${n.toString(16)}`;

async function kept<T>(method: string, args: unknown[], read: Promise<Read<T>>): Promise<Read<T>> {
  const answer = await read;
  if (answer.kind === 'unverifiable') throw new Error(`${method}: ${answer.reason}`);
  reads.push({ method, args, value: answer.value });
  return answer;
}

const recorder: Reader = {
  ...live,
  getCode: (at, ref) => kept('getCode', [at], live.getCode(at, ref)),
  getStorageAt: (at, slot, ref) => kept('getStorageAt', [at, hex(slot)], live.getStorageAt(at, slot, ref)),
  call: (request, ref) => kept('call', [request.to, request.data], live.call(request, ref)),
};

const sourcify: Record<string, SourcifyAnswer> = {};
const proof = await proveAbi(recorder, address, block.value, {
  compilers: pinnedCompilers(),
  sourcify: async (at) => {
    const answer = await sourcifyHttps(at);
    sourcify[at] = answer;
    return answer;
  },
});

const fixture = {
  address,
  block: { number: block.value.number.toString(), hash: block.value.hash },
  providers: block.providers,
  reads,
  sourcify,
};
const out = join(import.meta.dirname, '..', 'testdata', 'abi', `${name}.json`);
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
const verdict = proof.kind === 'proven' ? `proven ${proof.contractName} at ${proof.proven}` : `refused: ${describeRefusal(proof.refusal)}`;
console.log(`wrote ${out}: block ${fixture.block.number}, agreed by ${fixture.providers.join(' and ')}, ${verdict}`);
