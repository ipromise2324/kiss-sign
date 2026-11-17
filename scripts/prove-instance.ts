import { join } from 'node:path';
import { openMainnetReader } from '../src/chain/reader.ts';
import { proveAdapterOf, proveInstance, proveParentOf } from '../src/contracts/instance.ts';
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
    `answered   ${proof.asked} = ${proof.answered}`,
    `block      ${proof.block.number} ${proof.block.hash}`,
    `providers  ${proof.providers.join(', ')}`,
  ].join('\n'),
);
if (proof.entry.kind === 'adapter') {
  const answers = await proveAdapterOf(reader, registry, proof.entry, block.value);
  if (answers.length === 0) console.log(`REFUSED no registry vault names ${name} as its adapter`);
  for (const answer of answers) {
    const vault = `vault      ${answer.vault.name} ${checksumAddress(answer.vault.address)}`;
    console.log(answer.kind === 'uses' ? `${vault}\nanswered   ${answer.asked} = true\nproviders  ${answer.providers.join(', ')}` : `${vault}\nREFUSED    ${answer.why}`);
  }
  const parents = await proveParentOf(reader, registry, proof.entry, block.value);
  for (const parent of parents) {
    const vault = `made for   ${parent.vault.name} ${checksumAddress(parent.vault.address)}`;
    console.log(parent.kind === 'made-for' ? `${vault}\nanswered   ${parent.asked} = ${checksumAddress(parent.vault.address)}\nproviders  ${parent.providers.join(', ')}` : `${vault}\nREFUSED    ${parent.why}`);
  }
  if (answers.length === 0 || [...answers, ...parents].some((answer) => answer.kind === 'refused')) process.exit(1);
}
