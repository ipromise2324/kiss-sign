import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packagePinsText, readPackagePin } from '../src/research/package-pin.ts';
import { PACKAGE_PINS } from '../src/verify/package-pins.ts';
import { lockedPackages } from '../src/verify/packages.ts';
import type { LockedPackage } from '../src/verify/packages.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = 'usage: node scripts/pin-packages.ts [<name>@<version>...]';
const HELP = `${USAGE}

Pins, in src/verify/package-pins.ts, the sha256 of every file of each package's npm tarball, keyed
by the tarball's sha512. It downloads the tarball from registry.npmjs.org and requires that sha512
to be the integrity pnpm-lock.yaml gives it, or npm's dist.integrity for a version the lockfile does
not hold yet. With no names it pins every package the lockfile's dependencies reach. It prints
pinned or unchanged per package, and REFUSED, exiting 1, for any other answer. Every bin/kiss-sign
command checks the installed packages against these pins before it loads one. A dependency update
pins the new version first, in a program pull request, then changes the lockfile.

Writes: src/verify/package-pins.ts.
Keys: none.
Rules: docs/design/program-ownership.md, "The installed packages".`;

exitOnHelp(HELP);

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
    console.error(`${USAGE}, not ${key}`);
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
