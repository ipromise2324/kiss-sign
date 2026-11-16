import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { HttpAnswer } from '../src/chain/https.ts';
import type { Read, Reader } from '../src/chain/reader.ts';
import type { BlockRef } from '../src/chain/types.ts';
import { create2Address, createAddress, parseCreationHints, proveCreation } from '../src/research/deployer.ts';
import { readPackage } from '../src/research/npm-package.ts';
import { parseImmunefiPrograms, trimImmunefiPrograms, verifiedDomains } from '../src/research/site-listings.ts';
import { htmlBlocks } from '../src/research/source-page.ts';
import { checksumAddress, parseAddress, parseHex } from '../src/safe/types.ts';
import type { Address, Hex } from '../src/safe/types.ts';

const SETTLEMENT = parseAddress('a', '0x9008D19f58AAbD9eD0D60971565AA8510560ab41');
const RELAYER = parseAddress('a', '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110');

const orgPage = (org: string, description: string, verified: readonly string[]) =>
  htmlBlocks(`<html><body><h1>${org}</h1><div>${description}</div>${
    verified.length === 0
      ? ''
      : `<details><summary title="Label: Verified">Verified</summary><div><p>We've verified that the organization <strong>${org}</strong> controls the domain:</p><ul>${verified.map((d) => `<li><svg><path d="m"></path></svg><strong>${d}</strong></li>`).join('')}</ul><div><a href="https://docs.github.com">Learn more about verified organizations</a></div></div></details>`
  }<ul><li>Earth</li><li><a href="https://example.org">example.org</a></li></ul></body></html>`);

test("GitHub's page names the domains it verified an organization controls, and text the organization wrote cannot", () => {
  assert.deepEqual(verifiedDomains({ kind: 'served', blocks: orgPage('Uniswap', 'Web3 infrastructure', ['uniswap.org']) }, 'uniswap'), { kind: 'domains', domains: ['uniswap.org'] });
  assert.deepEqual(verifiedDomains({ kind: 'served', blocks: orgPage('cowprotocol', 'CoW', []) }, 'cowprotocol'), { kind: 'domains', domains: [] });
  const description = orgPage('evil', "We've verified that the organization evil controls the domain:", []);
  assert.deepEqual(verifiedDomains({ kind: 'served', blocks: description }, 'evil'), { kind: 'domains', domains: [] });
  assert.deepEqual(verifiedDomains({ kind: 'served', blocks: orgPage('Uniswap', 'x', ['uniswap.org']) }, 'other'), { kind: 'domains', domains: [] }, 'another organization');
  assert.deepEqual(verifiedDomains({ kind: 'unread', why: 'timeout' }, 'uniswap'), { kind: 'unread', why: 'timeout' });
});

test("an Immunefi program's scope holds each Ethereum address an etherscan.io link names, and its recording keeps only those", () => {
  const raw = [
    {
      slug: 'cowprotocol',
      websiteUrl: 'https://cow.fi/',
      githubUrl: 'http://github.com/cowprotocol',
      assets: [{ url: 'https://github.com/cowprotocol/contracts' }, { url: `https://etherscan.io/address/${RELAYER}#code` }],
      assetsBodyV2: `deployed at\n${SETTLEMENT.toUpperCase()}\n- Ethereum: https://etherscan.io/address/${checksumAddress(SETTLEMENT)}#code\n- Gnosis: https://gnosisscan.io/address/0x${'11'.repeat(20)}`,
      rewardsBody: 'long text',
    },
    { slug: 'other', assets: [{ url: `https://etherscan.io/address/0x${'22'.repeat(20)}` }] },
  ];
  const programs = parseImmunefiPrograms(raw);
  const cow = programs.get('cowprotocol')!;
  assert.deepEqual([...cow.addresses].sort(), [SETTLEMENT, RELAYER].sort());
  assert.equal(cow.github?.href, 'http://github.com/cowprotocol');
  const kept = trimImmunefiPrograms(raw, new Set(['cowprotocol']));
  assert.deepEqual(parseImmunefiPrograms(JSON.parse(JSON.stringify(kept))), new Map([['cowprotocol', cow]]));
  assert.doesNotMatch(JSON.stringify(kept), /long text|gnosisscan/);
});

const BLOCK = 512;
function tarGz(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [path, text] of Object.entries(files)) {
    const body = new TextEncoder().encode(text);
    const header = new Uint8Array(BLOCK);
    header.set(new TextEncoder().encode(`package/${path}`), 0);
    header.set(new TextEncoder().encode(`${body.length.toString(8).padStart(11, '0')}\0`), 124);
    header[156] = '0'.charCodeAt(0);
    parts.push(header, body, new Uint8Array((BLOCK - (body.length % BLOCK)) % BLOCK));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

const SDK = { package: '@example/sdk', version: '1.0.0', file: 'dist/addresses.js', label: 'SETTLEMENT' };
const TARBALL = tarGz({ 'dist/addresses.js': `export const SETTLEMENT = "${checksumAddress(SETTLEMENT)}";\n`, 'install.js': 'process.exit(1)' });
const sha = (algorithm: string, bytes: Uint8Array) => createHash(algorithm).update(bytes).digest();
const json = (value: unknown, status = 200): HttpAnswer => ({ status, text: JSON.stringify(value) });
const statement = (repository: string, digest: string) =>
  Buffer.from(JSON.stringify({ subject: [{ digest: { sha512: digest } }], predicate: { buildDefinition: { externalParameters: { workflow: { repository } } } } })).toString('base64');

function npm(change: { tarball?: Uint8Array; integrity?: string; attestations?: HttpAnswer } = {}) {
  const tarball = change.tarball ?? TARBALL;
  const answers: Record<string, HttpAnswer> = {
    'https://registry.npmjs.org/@example%2fsdk/1.0.0': json({ dist: { tarball: 'https://registry.npmjs.org/@example/sdk/-/sdk-1.0.0.tgz', integrity: change.integrity ?? `sha512-${sha('sha512', TARBALL).toString('base64')}` } }),
    'https://registry.npmjs.org/@example/sdk/-/sdk-1.0.0.tgz': { status: 200, text: '', bytes: tarball },
    'https://registry.npmjs.org/-/npm/v1/attestations/@example%2fsdk@1.0.0':
      change.attestations ?? json({ attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: statement('https://github.com/example/sdk', sha('sha512', TARBALL).toString('hex')) } } }] }),
  };
  return async (url: string) => answers[url] ?? assert.fail(`not asked: ${url}`);
}

const pinned = { ...SDK, sha256: `0x${sha('sha256', TARBALL).toString('hex')}` as Hex };

test('an SDK package is read as data: its tarball hashes, its provenance, and the one file the registry names', async () => {
  const read = await readPackage(pinned, npm());
  assert.equal(read.kind, 'read');
  if (read.kind !== 'read') return;
  assert.equal(read.sha256, pinned.sha256);
  assert.equal(read.integrity, true);
  assert.deepEqual(read.provenance, { kind: 'built', repository: 'https://github.com/example/sdk', sameTarball: true });
  assert.deepEqual(read.file, { kind: 'served', blocks: [{ text: `export const SETTLEMENT = "${checksumAddress(SETTLEMENT)}";` }] });
});

test("an SDK whose tarball npm's integrity or provenance does not name, or with no provenance, says so", async () => {
  const other = tarGz({ 'dist/addresses.js': 'nothing' });
  const swapped = await readPackage(pinned, npm({ tarball: other }));
  assert.ok(swapped.kind === 'read' && swapped.sha256 !== pinned.sha256 && !swapped.integrity && swapped.provenance.kind === 'built' && !swapped.provenance.sameTarball);
  const none = await readPackage(pinned, npm({ attestations: json({ error: 'not found' }, 404) }));
  assert.ok(none.kind === 'read' && none.provenance.kind === 'none');
  const missing = await readPackage({ ...pinned, file: 'dist/other.js' }, npm());
  assert.ok(missing.kind === 'read' && missing.file.kind === 'failed');
  const elsewhere = await readPackage(pinned, async (url) => (url.endsWith('/1.0.0') ? json({ dist: { tarball: 'https://evil.example/sdk.tgz', integrity: 'sha512-x' } }) : assert.fail(url)));
  assert.deepEqual(elsewhere, { kind: 'failed', why: 'npm names no tarball on https://registry.npmjs.org/ for @example/sdk@1.0.0' });
});

test('CREATE and CREATE2 give the addresses the chain does: CoW settlement made its vault relayer at nonce 1, and EIP-1014’s first example', () => {
  assert.equal(createAddress(SETTLEMENT, 1n), RELAYER);
  const zero = parseAddress('a', `0x${'00'.repeat(20)}`);
  assert.equal(create2Address(zero, new Uint8Array(32), Uint8Array.of(0)), parseAddress('a', '0x4D1A2e2bB4F88F0250f26Ffff098B0b30B26BF38'));
});

const TX = parseHex('tx', `0x${'ab'.repeat(32)}`);
const SENDER = parseAddress('a', `0x${'5e'.repeat(20)}`);
const agreed = <T>(value: T): Read<T> => ({ kind: 'agreed', value, providers: ['alchemy', 'drpc'] });
const block = (n: bigint): BlockRef => ({ number: n, hash: parseHex('h', `0x${n.toString(16).padStart(64, '0')}`) });

function chain(change: { to?: Address | null; created?: Address | null; codeBefore?: Hex; nonces?: [bigint, bigint]; unread?: boolean } = {}): Reader {
  const code = (address: Address, at: BlockRef): Hex => (at.number === 100n || address !== RELAYER ? parseHex('c', '0x60') : (change.codeBefore ?? parseHex('c', '0x')));
  return {
    getTransaction: async () => (change.unread ? { kind: 'unverifiable', reason: 'drpc failed (timeout)', answers: [] as never } : agreed({ hash: TX, from: SENDER, to: change.to === undefined ? SETTLEMENT : change.to, input: parseHex('i', '0x'), nonce: 0n, value: 0n, blockHash: null, blockNumber: 100n })),
    getTransactionReceipt: async () => agreed({ status: 1, blockNumber: 100n, contractAddress: change.created ?? null, logs: [] }),
    block: async (n: bigint) => agreed(block(n)),
    getCode: async (address: Address, at: BlockRef) => agreed(code(address, at)),
    getTransactionCount: async (_: Address, at: BlockRef) => agreed(at.number === 100n ? (change.nonces?.[1] ?? 2n) : (change.nonces?.[0] ?? 0n)),
  } as unknown as Reader;
}

test('a creation is proved through both providers: deployed by its sender, or by CREATE from the contract its transaction calls', async () => {
  assert.deepEqual(await proveCreation(RELAYER, { tx: TX, factory: undefined }, chain({ to: null, created: RELAYER })), {
    kind: 'proven',
    tx: TX,
    block: 100n,
    sender: SENDER,
    via: { kind: 'transaction' },
  });
  assert.deepEqual(await proveCreation(RELAYER, { tx: TX, factory: SETTLEMENT }, chain()), { kind: 'proven', tx: TX, block: 100n, sender: SENDER, via: { kind: 'create', factory: SETTLEMENT } });
  assert.equal((await proveCreation(RELAYER, { tx: TX, factory: SETTLEMENT }, chain({ nonces: [2n, 3n] }))).kind, 'unproven', 'nonce 1 was used before the block');
  assert.equal((await proveCreation(RELAYER, { tx: TX, factory: SETTLEMENT }, chain({ to: SENDER }))).kind, 'unproven', 'the transaction neither calls nor deploys the factory');
  assert.equal((await proveCreation(RELAYER, { tx: TX, factory: undefined }, chain({ to: null, created: RELAYER, codeBefore: parseHex('c', '0x60') }))).kind, 'unproven', 'code was there before');
  assert.deepEqual(await proveCreation(RELAYER, { tx: TX, factory: undefined }, chain({ unread: true })), { kind: 'unread', why: 'drpc failed (timeout)' });
});

test("Etherscan's contract-creation answer names each transaction and the contract that made the address, nothing more", () => {
  const hints = parseCreationHints({
    status: '1',
    message: 'OK',
    result: [
      { contractAddress: RELAYER, contractCreator: SENDER, contractFactory: checksumAddress(SETTLEMENT), txHash: TX },
      { contractAddress: SETTLEMENT, contractCreator: SENDER, contractFactory: '', txHash: TX },
    ],
  });
  assert.deepEqual(hints, new Map([[RELAYER, { tx: TX, factory: SETTLEMENT }], [SETTLEMENT, { tx: TX, factory: undefined }]]));
  assert.deepEqual(parseCreationHints({ status: '0', message: 'No data found', result: [] }), new Map());
  assert.throws(() => parseCreationHints({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }), /Etherscan refused: NOTOK/);
});
