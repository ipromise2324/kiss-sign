import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadStoredConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { safeProxyCreated } from '../src/safe/deployments.ts';
import { parseHex } from '../src/safe/types.ts';
import { recordingText } from '../src/chain/bytecode.ts';

const USAGE = 'usage: ALCHEMY_API_KEY=... node scripts/record-safe-proxy.ts <name> <transaction hash>';

const [name, hashArg] = process.argv.slice(2);
if (name === undefined || hashArg === undefined || !/^[a-z0-9-]+$/.test(name)) throw new Error(USAGE);
const hash = parseHex('transaction hash', hashArg);

const endpoints = mainnetEndpoints(process.env);
const chain = recordingTransport(httpsTransport(), endpoints);
const reader = createReader(endpoints, chain.transport);

const receipt = await reader.getTransactionReceipt(hash);
if (receipt.kind === 'unverifiable') throw new Error(receipt.reason);
if (receipt.value === null) throw new Error('neither provider knows the transaction');
const created = safeProxyCreated(receipt.value.logs);
if (created === undefined) throw new Error('the transaction has no ProxyCreation from an official Safe proxy factory');
const block = await reader.block(receipt.value.blockNumber);
if (block.kind === 'unverifiable') throw new Error(block.reason);
const code = await reader.getCode(created.proxy, block.value);
if (code.kind === 'unverifiable') throw new Error(code.reason);

const fixture = { transaction: hash, exchanges: chain.exchanges() };
const safe = loadStoredConfig(kissSignHome(process.env))?.safe;
if (safe !== undefined && JSON.stringify(fixture).toLowerCase().includes(safe.slice(2))) throw new Error('the recording mentions the configured Safe; nothing written');
const out = join(import.meta.dirname, '..', 'testdata', 'safe-proxy', `${name}.json`);
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, recordingText(fixture, 1));
console.log(`wrote ${out}: the ${created.version} factory ${created.factory} created ${created.proxy} in block ${block.value.number}, ${(code.value.length - 2) / 2} bytes of code`);
