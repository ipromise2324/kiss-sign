import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addSolcPin, nodePinSolcIo, resolveSolcPin } from '../src/contracts/pin-solc.ts';
import { SOLC_PINS } from '../src/contracts/solc-pins.ts';

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('usage: node scripts/pin-solc.ts <version>, such as 0.4.18+commit.9cf6e910');
  process.exit(2);
}
const [version] = args as [string];

const resolution = await resolveSolcPin(version, nodePinSolcIo);
for (const read of resolution.reads) console.log(`read ${read}`);
if (resolution.kind === 'refused') {
  console.log(`REFUSED solc ${version}: ${resolution.why}`);
  process.exit(1);
}

const path = join(import.meta.dirname, '..', 'src', 'contracts', 'solc-pins.ts');
const change = addSolcPin(readFileSync(path, 'utf8'), SOLC_PINS, version, resolution.pin);
switch (change.kind) {
  case 'conflict':
    console.log(`REFUSED solc ${version}: already pinned as ${change.pinned.file} sha256 ${change.pinned.sha256}; the sources agree on ${resolution.pin.file} sha256 ${resolution.pin.sha256}`);
    process.exit(1);
  case 'unchanged':
    console.log(`unchanged solc ${version}: already pinned as ${resolution.pin.file} sha256 ${resolution.pin.sha256}`);
    break;
  case 'written':
    writeFileSync(path, change.text);
    console.log(`pinned solc ${version} in src/contracts/solc-pins.ts: ${resolution.pin.file} sha256 ${resolution.pin.sha256}`);
    break;
}
