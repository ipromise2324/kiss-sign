import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openMainnetReader } from '../src/chain/reader.ts';
import { pinOf, readRunningCode } from '../src/contracts/code.ts';
import { describeRefusal } from '../src/contracts/prove.ts';
import { mergeRegistry } from '../src/history/load.ts';
import { kissSignHome } from '../src/keys.ts';
import { REGISTRY_PATH, parseRegistry } from '../src/registry.ts';
import { checksumAddress, parseAddress } from '../src/safe/types.ts';

const USAGE = `usage: ALCHEMY_API_KEY=... node scripts/pin-code.ts [<registry name>...] [--history]

Reads, through both providers at one agreed block, the code at each entry's address and, behind a proxy, the
implementation and its code, and writes their keccak256 into the entry's "code". With no names it pins every entry.
--history pins the local entries in $KISS_SIGN_HOME/history/registry.json instead of registry/contracts.json.`;

const { values: flags, positionals: names } = parseArgs({ options: { history: { type: 'boolean', default: false } }, allowPositionals: true });
const root = join(import.meta.dirname, '..');
const repoPath = join(root, REGISTRY_PATH);
const path = flags.history ? join(kissSignHome(process.env), 'history', 'registry.json') : repoPath;
const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
const unknown = names.filter((name) => !Object.hasOwn(file, name));
if (unknown.length > 0) {
  console.error(`not in ${path}: ${unknown.join(', ')}\n\n${USAGE}`);
  process.exit(1);
}

const reader = openMainnetReader(process.env);
const block = await reader.block('latest');
if (block.kind === 'unverifiable') throw new Error(block.reason);
console.log(`block ${block.value.number} ${block.value.hash}, providers ${reader.providers.join(', ')}\n`);

let refused = false;
for (const name of names.length > 0 ? names : Object.keys(file)) {
  const entry = file[name] as Record<string, unknown>;
  const address = parseAddress(`${name}.address`, entry.address);
  const read = await readRunningCode(reader, address, block.value);
  if (read.kind === 'refused') {
    console.log(`REFUSED ${name} ${checksumAddress(address)}: ${describeRefusal(read.refusal)}`);
    refused = true;
    continue;
  }
  const pin = pinOf(read.code);
  const before = JSON.stringify(entry.code);
  entry.code = pin.implementation === undefined ? pin : { hash: pin.hash, implementation: { address: checksumAddress(pin.implementation.address), hash: pin.implementation.hash } };
  const status = before === undefined ? 'new' : before === JSON.stringify(entry.code) ? 'unchanged' : `CHANGED, was ${before}`;
  const behind = pin.implementation === undefined ? '' : `, ${read.code.proxy.kind} proxy for ${checksumAddress(pin.implementation.address)} ${pin.implementation.hash}`;
  console.log(`${name} ${checksumAddress(address)} ${pin.hash}${behind} (${status})`);
}

const text = `${JSON.stringify(file, null, 2)}\n`;
if (flags.history) mergeRegistry(readFileSync(repoPath, 'utf8'), file);
else parseRegistry(file);
writeFileSync(`${path}.tmp`, text, { mode: flags.history ? 0o600 : 0o644 });
renameSync(`${path}.tmp`, path);
console.log(`\nWrote ${path}`);
if (refused) process.exit(1);
