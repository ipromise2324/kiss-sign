import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS, findKey } from '../src/keys.ts';
import { checksumAddress, parseAddress, parseHex, parseOperation, parseUint256 } from '../src/safe/types.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = 'usage: pnpm record-safe-tx <name> <safe> <safeTxHash | nonce>';
const HELP = `${USAGE}

Records a Safe transaction fixture into testdata/safe-tx/<name>.json, which simulate, perturb and
the tests read. It asks the Safe Transaction Service for the transaction of <safe> with that
safeTxHash, or for the executed one at that nonce, and requires exactly one. At the block it ran
in, or at the latest block when it has not run, it reads the Safe's VERSION(), domainSeparator()
and getTransactionHash(...) of the service's fields from Alchemy and drpc, which must agree. The
fixture holds those answers and the service's record. It does not check that <safe> is not the
configured Safe: record only other Safes' transactions. <name> is lowercase letters, digits and
hyphens.

Writes: testdata/safe-tx/<name>.json.
Keys: ALCHEMY_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 7,
  Write the template).`;

exitOnHelp(HELP);

const SERVICE = 'https://api.safe.global/tx-service/eth/api/v2';

const [name, safeArg, which] = process.argv.slice(2);
const alchemyKey = findKey(KEYS[0], process.env)?.value;
if (name === undefined || safeArg === undefined || which === undefined || !/^[a-z0-9-]+$/.test(name)) {
  throw new Error(USAGE);
}
if (alchemyKey === undefined || alchemyKey === '') throw new Error(`ALCHEMY_API_KEY is not set, in the environment or in $KISS_SIGN_HOME/.env\n${USAGE}`);

const providers = [
  { name: 'alchemy', url: `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}` },
  { name: 'drpc', url: 'https://eth.drpc.org' },
];

async function rpc(provider: { name: string; url: string }, method: string, params: unknown[]): Promise<string> {
  let body: { result?: unknown; error?: { message?: string } };
  try {
    const response = await fetch(provider.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    body = (await response.json()) as typeof body;
  } catch {
    throw new Error(`${provider.name}: ${method} failed`);
  }
  if (typeof body.result !== 'string') throw new Error(`${provider.name}: ${method} gave ${body.error?.message ?? 'no result'}`);
  return body.result;
}

async function agreed(method: string, params: unknown[]): Promise<string> {
  const answers = await Promise.all(providers.map((provider) => rpc(provider, method, params)));
  if (answers.some((answer) => answer !== answers[0])) {
    throw new Error(`providers disagree on ${method}: ${providers.map((p, i) => `${p.name}=${answers[i]}`).join(' ')}`);
  }
  return answers[0] as string;
}

function selector(signature: string): string {
  return bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8);
}

function word(value: bigint | string): string {
  return (typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '')).padStart(64, '0');
}

function decodeString(result: string): string {
  const length = Number(BigInt(`0x${result.slice(66, 130)}`));
  return Buffer.from(result.slice(130, 130 + length * 2), 'hex').toString('utf8');
}

const safe = parseAddress('safe', safeArg);
const filter = /^0x[0-9a-fA-F]{64}$/.test(which) ? `safe_tx_hash=${which}` : `nonce=${parseUint256('nonce', which)}&executed=true`;
const listing = (await (await fetch(`${SERVICE}/safes/${checksumAddress(safe)}/multisig-transactions/?${filter}`)).json()) as {
  count?: number;
  results?: Record<string, unknown>[];
};
const service = listing.results?.[0];
if (listing.count !== 1 || service === undefined) throw new Error(`expected one transaction, the service listed ${listing.count}`);

const data = parseHex('data', service.data ?? '0x').slice(2);
const getTransactionHash =
  '0x' +
  selector('getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)') +
  word(parseAddress('to', service.to)) +
  word(parseUint256('value', service.value)) +
  word(10n * 32n) +
  word(BigInt(parseOperation(service.operation))) +
  word(parseUint256('safeTxGas', service.safeTxGas)) +
  word(parseUint256('baseGas', service.baseGas)) +
  word(parseUint256('gasPrice', service.gasPrice)) +
  word(parseAddress('gasToken', service.gasToken)) +
  word(parseAddress('refundReceiver', service.refundReceiver)) +
  word(parseUint256('nonce', service.nonce)) +
  word(BigInt(data.length / 2)) +
  data.padEnd(Math.ceil(data.length / 64) * 64, '0');

const block =
  typeof service.blockNumber === 'number' ? BigInt(service.blockNumber) : BigInt(await agreed('eth_blockNumber', []));
const tag = `0x${block.toString(16)}`;
const call = (input: string) => agreed('eth_call', [{ to: safe, data: input }, tag]);

const fixture = {
  chainId: 1,
  safe,
  block: Number(block),
  providers: providers.map((provider) => provider.name),
  chain: {
    version: decodeString(await call(`0x${selector('VERSION()')}`)),
    domainSeparator: await call(`0x${selector('domainSeparator()')}`),
    transactionHash: await call(getTransactionHash),
  },
  service,
};

const out = join(import.meta.dirname, '..', 'testdata', 'safe-tx', `${name}.json`);
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${out}: Safe ${fixture.chain.version} at block ${fixture.block}, agreed by ${fixture.providers.join(' and ')}`);
