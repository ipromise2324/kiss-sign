import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadRegistry } from '../src/registry.ts';
import { readContractOrigin, renderContractOrigins, trimEtherscanAnswer } from '../src/research/etherscan-contract.ts';
import { etherscanAsk, recordingAsk } from '../src/research/sources.ts';
import { parseAddress } from '../src/safe/types.ts';

const USAGE = `usage: ETHERSCAN_API_KEY=... node scripts/contract-origin.ts <registry name | address>... [--record <name>]

Reads each contract's verified name, creator, factory and creation transaction from the Etherscan API and prints them.
A name that is not an identifier of at most 64 characters is refused, not printed. Source code and comments are never read.`;

const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: { record: { type: 'string' } } });
if (positionals.length === 0) {
  console.error(USAGE);
  process.exit(64);
}
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new Error('--record takes a name of lowercase letters, digits and -');

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
const addresses = positionals.map((arg) => registry.entries.get(arg)?.address ?? parseAddress(arg, arg));
const etherscan = etherscanAsk(process.env);
const sources = recordingAsk(async (req) => trimEtherscanAnswer(await etherscan(req.source === 'etherscan' ? req.query : {})));
const origins = [];
for (const address of addresses) origins.push(await readContractOrigin(address, sources.ask));
process.stdout.write(renderContractOrigins(origins, registry));

if (flags.record !== undefined) {
  const out = join(root, 'testdata', 'etherscan', `${flags.record}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ addresses, sources: sources.exchanges() }, null, 1)}\n`);
  console.log(`wrote ${out}`);
}
