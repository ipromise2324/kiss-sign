import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addSolcPin, resolveSolcPin, SOLC_BIN_LIST, SOLC_WASM_LIST } from '../src/contracts/pin-solc.ts';
import type { Fetched, PinSolcIo } from '../src/contracts/pin-solc.ts';
import { SOLC_PINS } from '../src/contracts/solc-pins.ts';
import type { SolcPin } from '../src/contracts/solc-pins.ts';
import { nodeVendorIo } from '../src/vendor.ts';

const OLD = '0.4.18+commit.9cf6e910';
const NEW = '0.8.28+commit.7893614a';
const PINS_PATH = join(import.meta.dirname, '..', 'src', 'contracts', 'solc-pins.ts');

const pinOf = (version: string): SolcPin => SOLC_PINS[version] ?? assert.fail(`${version} is pinned`);
const short = (version: string): string => version.split('+')[0] ?? '';
const listOf = (entries: Readonly<Record<string, string>>) => ({
  builds: Object.entries(entries).map(([version, sha256]) => ({ path: `soljson-v${version}.js`, longVersion: version, sha256: `0x${sha256}` })),
  releases: Object.fromEntries(Object.keys(entries).map((version) => [short(version), `soljson-v${version}.js`])),
});
const releaseUrl = (version: string) => `https://api.github.com/repos/argotorg/solidity/releases/tags/v${short(version)}`;
const assetUrl = (version: string) => `https://github.com/argotorg/solidity/releases/download/v${short(version)}/soljson.js`;
const releaseOf = (version: string) => ({ tag_name: `v${short(version)}`, assets: [{ name: 'soljson.js', browser_download_url: assetUrl(version) }] });

/** The answers each source gives for `version` when they all agree, read from the vendored compiler, with `changes` applied. */
function offline(version: string, changes: { readonly json?: Record<string, unknown>; readonly bytes?: Record<string, Uint8Array> } = {}): PinSolcIo {
  const pin = pinOf(version);
  const json: Record<string, unknown> = {
    [SOLC_BIN_LIST]: listOf({ [version]: pin.sha256 }),
    [SOLC_WASM_LIST]: listOf({ [version]: pin.sha256 }),
    [releaseUrl(version)]: releaseOf(version),
    ...changes.json,
  };
  const bytes: Record<string, Uint8Array> = { [assetUrl(version)]: readFileSync(join(nodeVendorIo.root, 'solc', pin.file)), ...changes.bytes };
  const answer = <T>(value: T | undefined): Fetched<T> => (value === undefined ? { kind: 'failed', status: 404 } : { kind: 'ok', value });
  return { json: async (url) => answer(json[url]), bytes: async (url) => answer(bytes[url]) };
}

const refusal = async (version: string, io: PinSolcIo): Promise<string> => {
  const resolved = await resolveSolcPin(version, io);
  return resolved.kind === 'refused' ? resolved.why : assert.fail(`refused, not ${resolved.kind}`);
};

test('solc 0.4.18 resolves to its pin and writes solc-pins.ts back byte for byte', async () => {
  const resolved = await resolveSolcPin(OLD, offline(OLD, { json: { [SOLC_WASM_LIST]: undefined } }));
  assert.equal(resolved.kind, 'agreed');
  assert.deepEqual(resolved.kind === 'agreed' && resolved.pin, pinOf(OLD));
  assert.deepEqual(resolved.reads, [
    `${SOLC_BIN_LIST}: soljson-v${OLD}.js sha256 ${pinOf(OLD).sha256}`,
    `${releaseUrl(OLD)}: release v0.4.18 has the asset soljson.js`,
    `${assetUrl(OLD)}: 7139666 bytes, sha256 ${pinOf(OLD).sha256}`,
  ]);

  const source = readFileSync(PINS_PATH, 'utf8');
  const { [OLD]: _, ...without } = SOLC_PINS;
  const entry = `  '${OLD}': {\n    file: '${pinOf(OLD).file}',\n    sha256: '${pinOf(OLD).sha256}',\n  },\n`;
  assert.deepEqual(addSolcPin(source.replace(entry, ''), without, OLD, pinOf(OLD)), { kind: 'written', text: source });
});

test('before 0.6.2 the wasm list is not read, since it names a later build', async () => {
  const io = offline(OLD, { json: { [SOLC_WASM_LIST]: listOf({ [OLD]: '5bb50839ba5116bf31669f3de8dad72eaec298ba32a643be7d0dc2d1392c54d6' }) } });
  assert.equal((await resolveSolcPin(OLD, io)).kind, 'agreed');
});

test('from 0.6.2 on the wasm list must give the same sha256', async () => {
  const agreed = await resolveSolcPin(NEW, offline(NEW));
  assert.equal(agreed.kind, 'agreed');
  assert.equal(agreed.reads.at(-1), `${SOLC_WASM_LIST}: soljson-v${NEW}.js sha256 ${pinOf(NEW).sha256}`);

  const other = '00'.repeat(32);
  assert.equal(
    await refusal(NEW, offline(NEW, { json: { [SOLC_WASM_LIST]: listOf({ [NEW]: other }) } })),
    `${SOLC_WASM_LIST} gives sha256 ${other}, but ${SOLC_BIN_LIST} gives ${pinOf(NEW).sha256}`,
  );
  assert.equal(await refusal(NEW, offline(NEW, { json: { [SOLC_WASM_LIST]: listOf({}) } })), `${SOLC_WASM_LIST}: the list has no build ${NEW}`);
});

test('a GitHub asset whose sha256 differs from the list is refused with both hashes', async () => {
  const io = offline(OLD, { bytes: { [assetUrl(OLD)]: new TextEncoder().encode('not solc') } });
  assert.match(await refusal(OLD, io), new RegExp(`^the GitHub asset has sha256 [0-9a-f]{64}, but ${SOLC_BIN_LIST} gives ${pinOf(OLD).sha256}$`));
});

test('a missing release, a release with no soljson.js, or a failed download is refused', async () => {
  assert.equal(await refusal(OLD, offline(OLD, { json: { [releaseUrl(OLD)]: undefined } })), `${releaseUrl(OLD)} answered status 404`);
  assert.equal(
    await refusal(OLD, offline(OLD, { json: { [releaseUrl(OLD)]: { tag_name: 'v0.4.18', assets: [] } } })),
    `${releaseUrl(OLD)}: the release has no soljson.js asset at ${assetUrl(OLD)}`,
  );
  const elsewhere = { tag_name: 'v0.4.18', assets: [{ name: 'soljson.js', browser_download_url: 'https://example.org/soljson.js' }] };
  assert.match(await refusal(OLD, offline(OLD, { json: { [releaseUrl(OLD)]: elsewhere } })), /has no soljson\.js asset at/);
  const noAsset = offline(OLD);
  assert.equal(await refusal(OLD, { ...noAsset, bytes: async () => ({ kind: 'failed', status: 404 }) }), `${assetUrl(OLD)} answered status 404`);
});

test('a version the list lacks, a build that is not the release, or no release version at all is refused', async () => {
  assert.equal(await refusal(OLD, offline(OLD, { json: { [SOLC_BIN_LIST]: listOf({}) } })), `${SOLC_BIN_LIST}: the list has no build ${OLD}`);
  const nightly = { ...listOf({ [OLD]: pinOf(OLD).sha256 }), releases: { '0.4.18': 'soljson-v0.4.18+commit.00000000.js' } };
  assert.equal(await refusal(OLD, offline(OLD, { json: { [SOLC_BIN_LIST]: nightly } })), `${SOLC_BIN_LIST}: release 0.4.18 is not soljson-v${OLD}.js`);
  assert.equal(await refusal('0.4.18', offline(OLD)), '0.4.18 is not a release version such as 0.4.18+commit.9cf6e910');
});

test('a version pinned already is left alone, or refused with both pins when the hash differs', () => {
  const source = readFileSync(PINS_PATH, 'utf8');
  assert.deepEqual(addSolcPin(source, SOLC_PINS, OLD, pinOf(OLD)), { kind: 'unchanged' });
  assert.deepEqual(addSolcPin(source, SOLC_PINS, OLD, { ...pinOf(OLD), sha256: '00'.repeat(32) }), { kind: 'conflict', pinned: pinOf(OLD) });
});

test('a new pin is written in version order', () => {
  const source = readFileSync(PINS_PATH, 'utf8');
  const pin = { file: 'soljson-v0.8.4+commit.c7e474f2.js', sha256: '11'.repeat(32) };
  const change = addSolcPin(source, SOLC_PINS, '0.8.4+commit.c7e474f2', pin);
  assert.equal(change.kind, 'written');
  const versions = [...(change.kind === 'written' ? change.text : '').matchAll(/^ {2}'([^']+)': \{$/gm)].map((match) => match[1]);
  assert.deepEqual(versions.slice(2, 6), ['0.7.3+commit.9bfce1f6', '0.7.6+commit.7338295f', '0.8.4+commit.c7e474f2', '0.8.19+commit.7dd6d404']);
});
