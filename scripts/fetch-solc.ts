import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOLC_DIR, sha256Hex } from '../src/contracts/solc.ts';
import { SOLC_DOWNLOAD_BASE, SOLC_PINS } from '../src/contracts/solc-pins.ts';

const asked = process.argv.slice(2);
const versions = asked.length > 0 ? asked : Object.keys(SOLC_PINS);
mkdirSync(SOLC_DIR, { recursive: true });

let failed = false;
for (const version of versions) {
  const pin = SOLC_PINS[version];
  if (pin === undefined) {
    console.error(`${version}: not pinned in src/contracts/solc-pins.ts`);
    failed = true;
    continue;
  }
  const path = join(SOLC_DIR, pin.file);
  if (existsSync(path) && sha256Hex(readFileSync(path)) === pin.sha256) {
    console.log(`${version}: ${path} already matches the pin`);
    continue;
  }
  const response = await fetch(`${SOLC_DOWNLOAD_BASE}${encodeURIComponent(pin.file)}`, { redirect: 'error' });
  if (!response.ok) {
    console.error(`${version}: download failed with status ${response.status}`);
    failed = true;
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256Hex(bytes);
  if (actual !== pin.sha256) {
    console.error(`${version}: refused, sha256 ${actual} is not the pinned ${pin.sha256}`);
    failed = true;
    continue;
  }
  writeFileSync(`${path}.partial`, bytes);
  renameSync(`${path}.partial`, path);
  console.log(`${version}: wrote ${path} (${bytes.length} bytes, sha256 ${actual})`);
}
if (failed) process.exit(1);
