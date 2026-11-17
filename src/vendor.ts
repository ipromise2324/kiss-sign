import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOLC_DOWNLOAD_BASE, SOLC_PINS } from './contracts/solc-pins.ts';
import { ERC7730_ARCHIVE, ERC7730_REGISTRY_PIN } from './research/erc7730.ts';
import { PUBLIC_SUFFIX_PIN } from './research/public-suffix.ts';
import { checkCommit, httpsGet } from './research/source-page.ts';
import type { HttpGet } from './research/source-page.ts';
import type { GithubToken } from './research/github-token.ts';

type PinnedFile = { readonly name: string; readonly file: string; readonly url: string; readonly sha256: string };
type GitHubCommit = { readonly owner: string; readonly repo: string; readonly commit: string };
type Vendored = { readonly dir: string; readonly what: string; readonly files: readonly PinnedFile[]; readonly onDefaultBranch?: GitHubCommit };

const [erc7730Owner, erc7730Repo] = ERC7730_REGISTRY_PIN.repository.split('/').slice(1) as [string, string];

/** Each pinned download, by the directory under `vendor/` it lives in. */
export const VENDORED = {
  solc: {
    dir: 'solc',
    what: 'the pinned solc compilers',
    files: Object.entries(SOLC_PINS).map(([version, pin]) => ({
      name: `solc ${version}`,
      file: pin.file,
      url: `${SOLC_DOWNLOAD_BASE}${encodeURIComponent(pin.file)}`,
      sha256: pin.sha256,
    })),
  },
  psl: {
    dir: 'publicsuffix',
    what: 'the pinned Public Suffix List',
    files: [{ name: 'Public Suffix List', file: PUBLIC_SUFFIX_PIN.file, url: PUBLIC_SUFFIX_PIN.url, sha256: PUBLIC_SUFFIX_PIN.sha256 }],
  },
  erc7730: {
    dir: 'erc7730',
    what: 'the pinned ERC-7730 registry archive',
    files: [{ name: 'ERC-7730 registry', file: ERC7730_ARCHIVE, url: ERC7730_REGISTRY_PIN.url, sha256: ERC7730_REGISTRY_PIN.sha256 }],
    onDefaultBranch: { owner: erc7730Owner, repo: erc7730Repo, commit: ERC7730_REGISTRY_PIN.commit },
  },
} as const satisfies Record<string, Vendored>;

export type VendoredKind = keyof typeof VENDORED;

export const isVendoredKind = (name: string): name is VendoredKind => Object.hasOwn(VENDORED, name);

export type VendorIo = {
  readonly root: string;
  readonly download: (url: string) => Promise<Response>;
  readonly get: HttpGet;
  /** Progress and refusals, kept off stdout so a report's text stays clean. */
  readonly log: (line: string) => void;
};

export const nodeVendorIo: VendorIo = {
  root: join(import.meta.dirname, '..', 'vendor'),
  download: (url) => fetch(url, { redirect: 'error' }),
  get: httpsGet(),
  log: (line) => console.error(line),
};

/** `nodeVendorIo`, its GitHub reads sending the token. */
export const nodeVendorIoWith = (githubToken: GithubToken | undefined): VendorIo => ({ ...nodeVendorIo, get: httpsGet(githubToken) });

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const matchesPin = (path: string, pin: PinnedFile): boolean => existsSync(path) && sha256(readFileSync(path)) === pin.sha256;

/** Downloads every file of `kind` that does not match its pin, refusing any download whose sha256 differs. True when all match. */
export async function fetchVendored(kind: VendoredKind, io: VendorIo = nodeVendorIo): Promise<boolean> {
  const vendored: Vendored = VENDORED[kind];
  const pinned = vendored.onDefaultBranch;
  if (pinned !== undefined) {
    const checked = await checkCommit({ kind: 'pinned', ...pinned, path: '' }, io.get, new Map());
    if (checked.kind !== 'on-default') {
      io.log(`refused, commit ${pinned.commit}: ${'why' in checked ? checked.why : `not on the default branch ${checked.branch} (${checked.status})`}`);
      return false;
    }
    io.log(`commit ${pinned.commit} is on the default branch ${checked.branch} of ${pinned.owner}/${pinned.repo} (GitHub compare: ${checked.status})`);
  }
  const dir = join(io.root, vendored.dir);
  mkdirSync(dir, { recursive: true });
  let allMatch = true;
  for (const pin of vendored.files) {
    const path = join(dir, pin.file);
    if (matchesPin(path, pin)) {
      io.log(`${pin.name}: ${path} already matches the pin`);
      continue;
    }
    const response = await io.download(pin.url);
    if (!response.ok) {
      io.log(`${pin.name}: download failed with status ${response.status}`);
      allMatch = false;
      continue;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== pin.sha256) {
      io.log(`${pin.name}: refused, sha256 ${actual} is not the pinned ${pin.sha256}`);
      allMatch = false;
      continue;
    }
    writeFileSync(`${path}.partial`, bytes);
    renameSync(`${path}.partial`, path);
    io.log(`${pin.name}: wrote ${path} (${bytes.length} bytes, sha256 ${actual})`);
  }
  return allMatch;
}

/** Fetches each kind that has a file missing or not matching its pin, and leaves the rest alone. True when all match. */
export async function ensureVendored(kinds: readonly VendoredKind[], io: VendorIo = nodeVendorIo): Promise<boolean> {
  for (const kind of kinds) {
    const vendored: Vendored = VENDORED[kind];
    if (vendored.files.every((pin) => matchesPin(join(io.root, vendored.dir, pin.file), pin))) continue;
    io.log(`downloading ${vendored.what} into vendor/${vendored.dir}/, since a file there is missing or differs from its pin`);
    if (!(await fetchVendored(kind, io))) return false;
  }
  return true;
}
