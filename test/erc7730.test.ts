import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { ERC7730_ARCHIVE, chainAt, formatReports, loadSnapshot, studyEntries } from '../src/research/erc7730.ts';
import type { ChainAccess, Erc7730Recording, Snapshot } from '../src/research/erc7730.ts';

const ROOT = join(import.meta.dirname, '..');
const recording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'erc7730', 'smokehouse-usdc-and-usdc.json'), 'utf8')) as Erc7730Recording;
const registry = loadRegistry(ROOT);
const DESCRIPTOR = 'registry/morpho/calldata-steakhouse_financial-bbqUSDC.json';
const INCLUDED = 'ercs/calldata-erc4626-vaults.json';
const SIG = 'registry/morpho/sigs/calldata-steakhouse_financial-bbqUSDC.eip155-1-0x3846c3A30E62075Fa916216b35EF04B8F53931f6.json';
const AUDITOR = '0x3846c3A30E62075Fa916216b35EF04B8F53931f6';

const snapshotWith = (changes: Record<string, string> = {}): Snapshot => ({ commit: recording.commit, files: new Map(Object.entries({ ...recording.files, ...changes })) });
const editJson = (path: string, edit: (doc: any) => void) => {
  const doc = JSON.parse(recording.files[path]!);
  edit(doc);
  return { [path]: JSON.stringify(doc) };
};

async function report(names: readonly string[], options: { files?: Record<string, string>; chain?: readonly Exchange[] | 'none' } = {}): Promise<string> {
  const snapshot = snapshotWith(options.files);
  const chain = async (): Promise<ChainAccess> =>
    options.chain === 'none' ? { unavailable: 'ALCHEMY_API_KEY is not set, so the chain was not read' } : chainAt(replayReader(options.chain ?? (recording.chain as Exchange[])));
  const reports = await studyEntries(
    names.map((n) => registry.entries.get(n)!),
    registry,
    snapshot,
    chain,
  );
  return formatReports(snapshot, reports);
}

const withRevokeAnswer = (answers: Record<string, string>): Exchange[] =>
  (recording.chain as Exchange[]).map((e) =>
    e.method === 'eth_call' && JSON.stringify(e.params).includes('0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587') ? { ...e, answers: { ...e.answers, ...answers } } : e,
  );
const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

test('a vault with a descriptor: its path, scope, hashes, functions and a valid attestation, checked on both providers', async () => {
  const text = await report(['smokehouse-usdc']);
  assert.match(text, /smokehouse-usdc 0xBEeFFF209270748ddd194831b3fa287a5386f5bC \(vault\)\n {2}descriptor {3}registry\/morpho\/calldata-steakhouse_financial-bbqUSDC\.json\n {2}applies {6}by exact address/);
  assert.match(text, /index {8}index\.calldata\.json names this file/);
  assert.match(text, /includes {5}ercs\/calldata-erc4626-vaults\.json/);
  assert.match(text, /file {9}sha256 c78dcaa71eadfef7cd91a417e7dbd6f548cb820f53b8b3847417691c7740a2ef of the file's bytes/);
  assert.match(text, /hash {9}descriptorHash 0x5d894d892e605db377c8d58b73cd7afc45b17c47ff4f2f4c97ab4e032c42e4c6: keccak256 of the RFC 8785 JSON of the descriptor with includes resolved \(ERC-8176\)/);
  assert.match(text, /function {5}0x6e553f65 deposit\(uint256,address\)\n {4}field {6}assets tokenAmount\n {4}field {6}\(constant\) raw\n {4}field {6}receiver addressName/);
  assert.match(text, /function {5}0xba087652 redeem\(uint256,address,address\)\n {4}field {6}shares tokenAmount\n {4}field {6}receiver addressName\n {4}field {6}owner addressName/);
  assert.match(text, new RegExp(`signer {5}${AUDITOR}, listed in auditors/`));
  assert.match(
    text,
    new RegExp(`result {5}VALID: ERC-8176 schema and domain, data equals this descriptorHash, uid matches its fields, signature recovers ${AUDITOR} \\(both providers\\), never expires, not revoked as of block \\d+`),
  );
});

test('a token without a descriptor says so, and that the index has no entry', async () => {
  const text = await report(['usdc']);
  assert.match(text, /usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \(token\)\n {2}descriptor {3}none: no calldata descriptor lists this address on chain 1\n {2}index {8}index\.calldata\.json has no entry for this address/);
});

test('no text the descriptor writers chose reaches the output', async () => {
  const text = (await report(['smokehouse-usdc', 'usdc'])).replace(/\S+\.json/g, '<file path>');
  const written: string[] = [];
  const walk = (v: unknown, key = ''): void => {
    if (typeof v === 'string' && ['label', 'intent', 'owner', 'url', 'legalName', 'contractName', 'deployEvent', 'name', 'organization'].includes(key)) written.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (typeof v === 'object' && v !== null) for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const [path, content] of Object.entries(recording.files)) if (!path.includes('/sigs/')) walk(JSON.parse(content));
  assert.ok(written.length > 5, 'the fixture holds free text to look for');
  for (const s of written) assert.ok(!text.includes(s), `printed descriptor text ${JSON.stringify(s)}`);
});

test('a revocation the attester recorded on EAS turns the attestation REVOKED', async () => {
  const text = await report(['smokehouse-usdc'], { chain: withRevokeAnswer({ alchemy: word(1790000000), drpc: word(1790000000) }) });
  assert.match(text, new RegExp(`result {5}REVOKED by ${AUDITOR} at unix time 1790000000 \\(getRevokeOffchain at block \\d+, both providers\\)`));
});

test('providers that disagree on the revocation leave the attestation UNVERIFIABLE', async () => {
  const text = await report(['smokehouse-usdc'], { chain: withRevokeAnswer({ drpc: word(1790000000) }) });
  assert.match(text, /result {5}UNVERIFIABLE: getRevokeOffchain: /);
});

test('without the chain an attestation is UNVERIFIABLE, not valid', async () => {
  const text = await report(['smokehouse-usdc'], { chain: 'none' });
  assert.match(text, /result {5}UNVERIFIABLE: ALCHEMY_API_KEY is not set, so the chain was not read/);
});

test('a changed included file changes the descriptorHash, so the attestation no longer covers it', async () => {
  const files = editJson(INCLUDED, (doc) => {
    doc.display.formats['deposit(uint256 assets, address receiver)'].fields[2].visible = 'never';
  });
  const text = await report(['smokehouse-usdc'], { files });
  assert.doesNotMatch(text, /descriptorHash 0x5d894d892e605db377c8d58b73cd7afc45b17c47ff4f2f4c97ab4e032c42e4c6/);
  assert.match(text, /field {6}receiver addressName \(visible: never\)/);
  assert.match(text, /result {5}INVALID: it attests another descriptorHash/);
});

test('an attestation whose fields were changed after signing fails its uid', async () => {
  const files = editJson(SIG, (doc) => {
    doc.sig.message.expirationTime = '1';
  });
  const text = await report(['smokehouse-usdc'], { files });
  assert.match(text, /result {5}INVALID: its uid is not the one its fields give/);
});

test('a file that names another signer than the signature recovers is INVALID', async () => {
  const files = editJson(SIG, (doc) => {
    doc.signer = '0x1111111111111111111111111111111111111111';
  });
  const text = await report(['smokehouse-usdc'], { files });
  assert.match(text, /signer {5}0x1111111111111111111111111111111111111111, not listed in auditors\//);
  assert.match(text, new RegExp(`result {5}INVALID: its signature recovers ${AUDITOR}, not the signer the file names`));
});

test('a descriptor scoped by the vault\'s factory applies to it, and the output says any vault of that factory is covered', async () => {
  const files = editJson(DESCRIPTOR, (doc) => {
    doc.context.contract = { factory: { deployEvent: 'CreateMetaMorpho(address)', deployments: [{ chainId: 1, address: '0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101' }] } };
  });
  const text = await report(['smokehouse-usdc'], { files });
  assert.match(
    text,
    /applies {6}BY FACTORY 0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101 \(the registry's factory metamorpho-factory-1\.0\): ERC-7730 applies it to ANY contract that factory deploys, including an attacker's/,
  );
  assert.doesNotMatch(text, /by exact address/);
  assert.match(text, /2 descriptor\(s\) scoped by factory: registry\/morpho\/calldata-steakhouse_financial-bbqUSDC\.json, registry\/railnet\/calldata-Conduit\.json/);
});

test('a parameter no field names is listed, and a field the descriptor hides shows its visibility', async () => {
  const files = editJson(INCLUDED, (doc) => {
    const fields = doc.display.formats['withdraw(uint256 assets, address receiver, address owner)'].fields;
    doc.display.formats['withdraw(uint256 assets, address receiver, address owner)'].fields = fields.filter((f: { path: string }) => f.path !== 'owner');
  });
  const text = await report(['smokehouse-usdc'], { files });
  assert.match(text, /function {5}0xb460af94 withdraw\(uint256,address,address\)\n {4}field {6}assets tokenAmount\n {4}field {6}receiver addressName\n {4}no field {3}owner/);
});

test('the registry archive is refused when missing or when its sha256 is not the pin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erc7730-'));
  assert.deepEqual(loadSnapshot(dir), { unavailable: `${join(dir, ERC7730_ARCHIVE)} missing; run pnpm fetch-erc7730` });
  writeFileSync(join(dir, ERC7730_ARCHIVE), 'not the archive');
  const refused = loadSnapshot(dir);
  assert.ok('unavailable' in refused && /sha256 [0-9a-f]{64} is not the pinned b4e02f6c/.test(refused.unavailable));
});
