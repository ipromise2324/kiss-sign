import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_SUFFIX_DIR, PUBLIC_SUFFIX_PIN } from '../src/research/public-suffix.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const path = join(PUBLIC_SUFFIX_DIR, PUBLIC_SUFFIX_PIN.file);
if (existsSync(path) && sha256(readFileSync(path)) === PUBLIC_SUFFIX_PIN.sha256) {
  console.log(`${path} already matches the pin`);
  process.exit(0);
}
const response = await fetch(PUBLIC_SUFFIX_PIN.url, { redirect: 'error' });
if (!response.ok) {
  console.error(`download failed with status ${response.status}`);
  process.exit(1);
}
const bytes = new Uint8Array(await response.arrayBuffer());
const actual = sha256(bytes);
if (actual !== PUBLIC_SUFFIX_PIN.sha256) {
  console.error(`refused, sha256 ${actual} is not the pinned ${PUBLIC_SUFFIX_PIN.sha256}`);
  process.exit(1);
}
mkdirSync(PUBLIC_SUFFIX_DIR, { recursive: true });
writeFileSync(`${path}.partial`, bytes);
renameSync(`${path}.partial`, path);
console.log(`wrote ${path} (${bytes.length} bytes, sha256 ${actual})`);
