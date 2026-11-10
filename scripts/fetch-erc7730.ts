import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERC7730_ARCHIVE, ERC7730_DIR, ERC7730_REGISTRY_PIN } from '../src/research/erc7730.ts';
import { checkCommit, httpsGet } from '../src/research/source-page.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const [owner, repo] = ERC7730_REGISTRY_PIN.repository.split('/').slice(1) as [string, string];
const onBranch = await checkCommit({ kind: 'pinned', owner, repo, commit: ERC7730_REGISTRY_PIN.commit, path: '' }, httpsGet, new Map());
if (onBranch.kind !== 'on-default') {
  console.error(`refused, commit ${ERC7730_REGISTRY_PIN.commit}: ${onBranch.kind === 'unknown' ? onBranch.why : `not on the default branch ${onBranch.branch} (${onBranch.status})`}`);
  process.exit(1);
}
console.log(`commit ${ERC7730_REGISTRY_PIN.commit} is on the default branch ${onBranch.branch} of ${owner}/${repo} (GitHub compare: ${onBranch.status})`);
const path = join(ERC7730_DIR, ERC7730_ARCHIVE);
if (existsSync(path) && sha256(readFileSync(path)) === ERC7730_REGISTRY_PIN.sha256) {
  console.log(`${path} already matches the pin`);
  process.exit(0);
}
const response = await fetch(ERC7730_REGISTRY_PIN.url, { redirect: 'error' });
if (!response.ok) {
  console.error(`download failed with status ${response.status}`);
  process.exit(1);
}
const bytes = new Uint8Array(await response.arrayBuffer());
const actual = sha256(bytes);
if (actual !== ERC7730_REGISTRY_PIN.sha256) {
  console.error(`refused, sha256 ${actual} is not the pinned ${ERC7730_REGISTRY_PIN.sha256}`);
  process.exit(1);
}
mkdirSync(ERC7730_DIR, { recursive: true });
writeFileSync(`${path}.partial`, bytes);
renameSync(`${path}.partial`, path);
console.log(`wrote ${path} (${bytes.length} bytes, sha256 ${actual})`);
