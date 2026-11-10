import { join } from 'node:path';
import { openMainnetReader } from '../src/chain/reader.ts';
import { proveInstance } from '../src/contracts/instance.ts';
import { loadRegistry } from '../src/registry.ts';
import { checksumAddress } from '../src/safe/types.ts';

const [name] = process.argv.slice(2);
if (name === undefined) throw new Error('usage: ALCHEMY_API_KEY=... node scripts/prove-instance.ts <registry name>');

const registry = loadRegistry(join(import.meta.dirname, '..'));
const reader = openMainnetReader(process.env);
const block = await reader.block('latest');
if (block.kind === 'unverifiable') throw new Error(block.reason);

const proof = await proveInstance(reader, registry, name, block.value);
if (proof.kind === 'refused') {
  console.log(`REFUSED ${name} at block ${block.value.number}: ${proof.why}`);
  process.exit(1);
}
console.log(
  [
    `contract   ${name} ${checksumAddress(proof.entry.address)}`,
    `factory    ${proof.factory.name} ${checksumAddress(proof.factory.address)}`,
    `answered   ${proof.factory.instanceCheck?.signature} = true`,
    `block      ${proof.block.number} ${proof.block.hash}`,
    `providers  ${proof.providers.join(', ')}`,
  ].join('\n'),
);
