import { createHash } from 'node:crypto';
import type { SolcPin } from './solc-pins.ts';
import { githubAuthorization } from '../research/github-token.ts';
import type { GithubToken } from '../research/github-token.ts';

export const SOLC_BIN_LIST = 'https://binaries.soliditylang.org/bin/list.json';
export const SOLC_WASM_LIST = 'https://binaries.soliditylang.org/wasm/list.json';
const GITHUB_REPO = 'argotorg/solidity';

export type Fetched<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'failed'; readonly status: number };
export type Download = Fetched<Uint8Array> | { readonly kind: 'too-large'; readonly limit: number };

/** The most bytes the GitHub asset may hold; every soljson.js is far smaller. */
export const SOLC_ASSET_LIMIT = 64 * 1024 * 1024;

export type PinSolcIo = {
  readonly json: (url: string) => Promise<Fetched<unknown>>;
  readonly bytes: (url: string) => Promise<Download>;
};

/** The response body, or undefined as soon as its declared length or the bytes read pass `limit`. */
export async function readCapped(response: Response, limit: number): Promise<Uint8Array | undefined> {
  if (Number(response.headers.get('content-length') ?? 0) > limit) {
    await response.body?.cancel();
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

/** The GitHub token goes only to api.github.com, and a JSON read follows no redirect, so it cannot reach another host. */
export const nodePinSolcIo = (githubToken: GithubToken | undefined): PinSolcIo => ({
  json: async (url) => {
    const response = await fetch(url, { redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'kiss-sign', ...githubAuthorization(url, githubToken) } });
    return response.ok ? { kind: 'ok', value: await response.json() } : { kind: 'failed', status: response.status };
  },
  bytes: async (url) => {
    const response = await fetch(url, { headers: { 'user-agent': 'kiss-sign' } });
    if (!response.ok) return { kind: 'failed', status: response.status };
    const value = await readCapped(response, SOLC_ASSET_LIMIT);
    return value === undefined ? { kind: 'too-large', limit: SOLC_ASSET_LIMIT } : { kind: 'ok', value };
  },
});

/** What `pin-solc` read, one line per source, and either the pin every source agreed on or why it refused. */
export type Resolution =
  | { readonly kind: 'agreed'; readonly pin: SolcPin; readonly reads: readonly string[] }
  | { readonly kind: 'refused'; readonly why: string; readonly reads: readonly string[] };

const VERSION = /^(\d+)\.(\d+)\.(\d+)\+commit\.[0-9a-f]{8}$/;

const semverOf = (version: string): readonly [number, number, number] | undefined => {
  const match = VERSION.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
};

const compareSemver = (x: readonly number[], y: readonly number[]): number => (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
const compareVersions = (a: string, b: string): number => compareSemver(semverOf(a) ?? [], semverOf(b) ?? []);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The sha256 a soliditylang list gives the build, without its `0x`, or why there is none. */
function listedSha256(list: unknown, version: string): { readonly path: string; readonly sha256: string } | string {
  if (!isObject(list) || !Array.isArray(list.builds)) return 'the list has no builds array';
  const builds = list.builds.filter((build): build is Record<string, unknown> => isObject(build) && build.longVersion === version);
  if (builds.length !== 1) return builds.length === 0 ? `the list has no build ${version}` : `the list has ${builds.length} builds ${version}`;
  const [build] = builds as [Record<string, unknown>];
  if (build.path !== `soljson-v${version}.js`) return `the list names the file ${String(build.path)}, not soljson-v${version}.js`;
  if (typeof build.sha256 !== 'string' || !/^0x[0-9a-f]{64}$/.test(build.sha256)) return `the list gives no sha256 for ${version}`;
  return { path: build.path, sha256: build.sha256.slice(2) };
}

/**
 * Finds the sha256 of solc `version` that soliditylang's `bin/list.json` gives and the `soljson.js` asset of the same
 * GitHub release hashes to, and, from 0.6.2 on, that `wasm/list.json` gives too; that list is on the same host as
 * `bin/list.json`, so it is no independent source. Any source missing or disagreeing refuses.
 */
export async function resolveSolcPin(version: string, io: PinSolcIo): Promise<Resolution> {
  const reads: string[] = [];
  const refuse = (why: string): Resolution => ({ kind: 'refused', why, reads });
  const semver = semverOf(version);
  if (semver === undefined) return refuse(`${version} is not a release version such as 0.4.18+commit.9cf6e910`);
  const short = semver.join('.');

  const binList = await io.json(SOLC_BIN_LIST);
  if (binList.kind === 'failed') return refuse(`${SOLC_BIN_LIST} answered status ${binList.status}`);
  const listed = listedSha256(binList.value, version);
  if (typeof listed === 'string') return refuse(`${SOLC_BIN_LIST}: ${listed}`);
  const releases = isObject(binList.value) ? binList.value.releases : undefined;
  if (!isObject(releases) || releases[short] !== listed.path) return refuse(`${SOLC_BIN_LIST}: release ${short} is not ${listed.path}`);
  reads.push(`${SOLC_BIN_LIST}: ${listed.path} sha256 ${listed.sha256}`);

  const releaseUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${short}`;
  const assetUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${short}/soljson.js`;
  const release = await io.json(releaseUrl);
  if (release.kind === 'failed') return refuse(`${releaseUrl} answered status ${release.status}`);
  const assets = isObject(release.value) && Array.isArray(release.value.assets) ? release.value.assets : [];
  if (!assets.some((asset) => isObject(asset) && asset.name === 'soljson.js' && asset.browser_download_url === assetUrl)) {
    return refuse(`${releaseUrl}: the release has no soljson.js asset at ${assetUrl}`);
  }
  reads.push(`${releaseUrl}: release v${short} has the asset soljson.js`);

  const asset = await io.bytes(assetUrl);
  if (asset.kind === 'failed') return refuse(`${assetUrl} answered status ${asset.status}`);
  if (asset.kind === 'too-large') return refuse(`${assetUrl} holds more than ${asset.limit} bytes`);
  const assetSha256 = createHash('sha256').update(asset.value).digest('hex');
  reads.push(`${assetUrl}: ${asset.value.length} bytes, sha256 ${assetSha256}`);
  if (assetSha256 !== listed.sha256) return refuse(`the GitHub asset has sha256 ${assetSha256}, but ${SOLC_BIN_LIST} gives ${listed.sha256}`);

  if (compareSemver(semver, [0, 6, 2]) >= 0) {
    const wasmList = await io.json(SOLC_WASM_LIST);
    if (wasmList.kind === 'failed') return refuse(`${SOLC_WASM_LIST} answered status ${wasmList.status}`);
    const wasm = listedSha256(wasmList.value, version);
    if (typeof wasm === 'string') return refuse(`${SOLC_WASM_LIST}: ${wasm}`);
    reads.push(`${SOLC_WASM_LIST}: ${wasm.path} sha256 ${wasm.sha256}`);
    if (wasm.sha256 !== listed.sha256) return refuse(`${SOLC_WASM_LIST} gives sha256 ${wasm.sha256}, but ${SOLC_BIN_LIST} gives ${listed.sha256}`);
  }
  return { kind: 'agreed', pin: { file: listed.path, sha256: listed.sha256 }, reads };
}

export type PinChange =
  | { readonly kind: 'written'; readonly text: string }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'conflict'; readonly pinned: SolcPin };

const PINS_BLOCK = /^export const SOLC_PINS: Readonly<Record<string, SolcPin>> = \{\n[\s\S]*?\n\};\n/m;

/** The text of `solc-pins.ts` with `pin` added for `version` and every pin sorted by version, or why it stays as it is. */
export function addSolcPin(source: string, pins: Readonly<Record<string, SolcPin>>, version: string, pin: SolcPin): PinChange {
  const pinned = pins[version];
  if (pinned !== undefined) return pinned.file === pin.file && pinned.sha256 === pin.sha256 ? { kind: 'unchanged' } : { kind: 'conflict', pinned };
  if (source.match(new RegExp(PINS_BLOCK.source, 'gm'))?.length !== 1) throw new Error('solc-pins.ts has no single SOLC_PINS block to rewrite');
  const entries = Object.entries({ ...pins, [version]: pin }).sort(([a], [b]) => compareVersions(a, b));
  const body = entries.map(([v, p]) => `  '${v}': {\n    file: '${p.file}',\n    sha256: '${p.sha256}',\n  },\n`).join('');
  return { kind: 'written', text: source.replace(PINS_BLOCK, `export const SOLC_PINS: Readonly<Record<string, SolcPin>> = {\n${body}};\n`) };
}
