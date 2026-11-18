import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packagePinsText, readPackagePin } from '../src/research/package-pin.ts';
import { PACKAGE_PINS } from '../src/verify/package-pins.ts';
import { lockedPackages } from '../src/verify/packages.ts';
import type { LockedPackage } from '../src/verify/packages.ts';

const root = join(import.meta.dirname, '..');
const locked = new Map<string, string>();
const walk = (pkg: LockedPackage): void => {
  const key = `${pkg.name}@${pkg.version.replace(/\(.*$/, '')}`;
  if (locked.has(key)) return;
  locked.set(key, pkg.integrity);
  pkg.dependencies.forEach(walk);
};
lockedPackages(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).forEach(walk);

const args = process.argv.slice(2);
const wanted = args.length === 0 ? [...locked.keys()] : args;
const get = async (url: string) => {
  const response = await fetch(url, { redirect: 'error' });
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
};

const pins = { ...PACKAGE_PINS };
let refused = false;
for (const key of wanted) {
  const at = key.lastIndexOf('@');
  if (at <= 0) {
    console.error(`usage: node scripts/pin-packages.ts [<name>@<version>...], not ${key}`);
    process.exit(2);
  }
  const read = await readPackagePin(key.slice(0, at), key.slice(at + 1), locked.get(key), get);
  if (read.kind === 'refused') {
    console.log(`REFUSED ${key}: ${read.why}`);
    refused = true;
    continue;
  }
  const before = pins[read.integrity];
  if (before !== undefined && JSON.stringify(before) !== JSON.stringify(read.pin)) {
    console.log(`REFUSED ${key}: ${read.integrity} is pinned with other files, as ${before.package}`);
    refused = true;
    continue;
  }
  console.log(`${before === undefined ? 'pinned' : 'unchanged'} ${key}: ${read.integrity}, ${Object.keys(read.pin.files).length} files`);
  pins[read.integrity] = read.pin;
}
writeFileSync(join(root, 'src', 'verify', 'package-pins.ts'), packagePinsText(pins));
if (refused) process.exitCode = 1;
