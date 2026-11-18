import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReader } from '../src/chain/reader.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { REPLAY_ENDPOINTS, replayTransport } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import type { Transport } from '../src/chain/rpc.ts';
import type { Read, Reader } from '../src/chain/reader.ts';
import type { BlockRef, CallResult } from '../src/chain/types.ts';
import { loadRegistry, parseRegistry, sizeOf } from '../src/registry.ts';
import { checksumAddress } from '../src/safe/types.ts';
import type { Hex } from '../src/safe/types.ts';
import { alchemyCall, factoryAnswer, formatVaultEvidence, gatherVaultEvidence, readStoredEvidence, vaultEvidenceText } from '../src/research/instance-evidence.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const recorded: { vault: string; exchanges: Exchange[] } = readRecording(join(ROOT, 'testdata', 'instance-evidence', 'steakhouse-high-yield-usdc-v2-a757.json'));
const TOTAL_ASSETS = '0x01e1d114';
const TOTAL_SUPPLY = '0x18160ddd';

async function evidenceFrom(exchanges: readonly Exchange[]): Promise<string> {
  const transport = replayTransport(exchanges, REPLAY_ENDPOINTS);
  const reader = createReader(REPLAY_ENDPOINTS, transport, { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] });
  const evidence = await gatherVaultEvidence(reader, alchemyCall(transport, REPLAY_ENDPOINTS[0].url, () => {}, []), registry.entries.get(recorded.vault)!, sizeOf(registry.entries.get(recorded.vault)!, registry)!);
  assert.ok(!('kind' in evidence), 'the latest block is read');
  return formatVaultEvidence(evidence, registry);
}

const callsTo = (data: string) => (e: Exchange) => e.method === 'eth_call' && (e.params as [{ data: string }])[0].data === data;
function edited(match: (e: Exchange) => boolean, nth: number, answers: Exchange['answers']): Exchange[] {
  let seen = -1;
  return recorded.exchanges.map((e) => (match(e) && ++seen === nth ? { ...e, answers } : e));
}

test('a recorded vault: 13 monthly totalAssets() points through both providers, its asset, and its holders checked against totalSupply()', async () => {
  const text = await evidenceFrom(recorded.exchanges);
  assert.match(text, /^vault {8}steakhouse-high-yield-usdc-v2-a757 0xbeeff2C5bF38f90e3482a8b19F12E5a6D2FCa757\n/);
  assert.match(text, /asset\(\) {6}usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 6 decimals, the asset the registry names/);
  assert.equal(text.match(/^ {2}\d{4}-\d{2}-\d{2} {2}block \d+ {2}[\d,]+\.\d{6} usdc$/gm)?.length, 13);
  assert.match(text, /2026-11-10 {2}block 26385872 {2}43,152,031\.442033 usdc/);
  assert.match(text, /2025-11-14 {2}block 23793872 {2}2,733,798\.381217 usdc/);
  assert.match(text, /holders {6}452 addresses hold shares at block 26385872, of 1038 that ever received them \(Alchemy Transfers API\); their balances, read through both providers, add up to totalSupply\(\) 40782343699607624786980381/);
  assert.match(text, /top 10 {7}hold 53\.52% of the shares; each: 18\.03%, 8\.57%,/);
  assert.deepEqual([...new Set(text.match(/(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g))], ['0xbeeff2C5bF38f90e3482a8b19F12E5a6D2FCa757', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'], 'no holder address is printed');
});

test('providers that disagree on one month make that point UNVERIFIABLE and leave the others', async () => {
  const original = recorded.exchanges.filter(callsTo(TOTAL_ASSETS))[3]!;
  const text = await evidenceFrom(edited(callsTo(TOTAL_ASSETS), 3, { ...original.answers, drpc: `0x${'00'.repeat(31)}01` }));
  assert.match(text, /2026-08-12 {2}block 25737872 {2}UNVERIFIABLE eth_call: alchemy and drpc disagree/);
  assert.equal(text.match(/^ {2}\d{4}-\d{2}-\d{2} {2}block \d+ {2}[\d,]+\.\d{6} usdc$/gm)?.length, 12);
});

test('a month before the vault had code says so', async () => {
  const text = await evidenceFrom(edited(callsTo(TOTAL_ASSETS), 12, { alchemy: '0x', drpc: '0x' }));
  assert.match(text, /2025-11-14 {2}block 23793872 {2}no code at the vault yet/);
});

test('holders whose balances fall short of totalSupply() are UNVERIFIABLE: the holder list is incomplete', async () => {
  const more = `0x${(40782343699607624786980381n + 1n).toString(16).padStart(64, '0')}`;
  const text = await evidenceFrom(edited(callsTo(TOTAL_SUPPLY), 0, { alchemy: more, drpc: more }));
  assert.match(text, /holders {6}UNVERIFIABLE the 452 holders found hold 40782343699607624786980381 of 40782343699607624786980382 shares, so the holder list is incomplete/);
  assert.doesNotMatch(text, /top 10/);
});

test('a Transfers API answer with no transfer list leaves the holders UNVERIFIABLE', async () => {
  const text = await evidenceFrom(edited((e) => e.method === 'alchemy_getAssetTransfers', 0, { alchemy: { error: 'nope' } }));
  assert.match(text, /holders {6}UNVERIFIABLE the Alchemy Transfers API sent no transfer list/);
});

/** The evidence when the Transfers API answers HTTP 503 `failures` times before it answers, each request asked again twice. */
async function withFailingTransfers(failures: number): Promise<{ text: string; unread: string[] }> {
  const replay = replayTransport(recorded.exchanges, REPLAY_ENDPOINTS);
  let left = failures;
  const flaky: Transport = async (url, body, signal) =>
    (JSON.parse(body) as { method: string }).method === 'alchemy_getAssetTransfers' && left-- > 0 ? { status: 503, text: '' } : replay(url, body, signal);
  const unread: string[] = [];
  const reader = createReader(REPLAY_ENDPOINTS, replay, { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [], note: (r) => unread.push(r) });
  const evidence = await gatherVaultEvidence(reader, alchemyCall(flaky, REPLAY_ENDPOINTS[0].url, (r) => unread.push(r), [0, 0]), registry.entries.get(recorded.vault)!, sizeOf(registry.entries.get(recorded.vault)!, registry)!);
  assert.ok(!('kind' in evidence), 'the latest block is read');
  return { text: formatVaultEvidence(evidence, registry), unread };
}

test('a Transfers API that answers 503 and then answers is asked again, and the holders are counted', async () => {
  const { text, unread } = await withFailingTransfers(2);
  assert.match(text, /holders {6}452 addresses hold shares at block 26385872/);
  assert.deepEqual(unread, []);
});

test('a Transfers API still answering 503 after every pause leaves the holders UNVERIFIABLE, and --record refuses to write', async () => {
  const { text, unread } = await withFailingTransfers(Infinity);
  assert.match(text, /holders {6}UNVERIFIABLE the Alchemy Transfers API failed \(alchemy answered HTTP 503\)/);
  assert.deepEqual(unread, ['alchemy alchemy_getAssetTransfers: HTTP 503']);
  assert.match(unreadRefusal(unread) ?? '', /^1 read\(s\) got no answer after every retry, so nothing is recorded/);
});

test('a Transfers API that refuses the request is noted, so --record refuses to keep holders it could not count', async () => {
  const replay = replayTransport(recorded.exchanges, REPLAY_ENDPOINTS);
  const refusing: Transport = async (url, body, signal) =>
    (JSON.parse(body) as { method: string }).method === 'alchemy_getAssetTransfers' ? { status: 200, text: '{"jsonrpc":"2.0","id":1,"error":{"code":-32600}}' } : replay(url, body, signal);
  const unread: string[] = [];
  const reader = createReader(REPLAY_ENDPOINTS, replay, { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] });
  const evidence = await gatherVaultEvidence(reader, alchemyCall(refusing, REPLAY_ENDPOINTS[0].url, (r) => unread.push(r), [0, 0]), registry.entries.get(recorded.vault)!, sizeOf(registry.entries.get(recorded.vault)!, registry)!);
  assert.ok(!('kind' in evidence), 'the latest block is read');
  assert.match(formatVaultEvidence(evidence, registry), /holders {6}UNVERIFIABLE the Alchemy Transfers API failed \(alchemy refused the request\)/);
  assert.deepEqual(unread, ['alchemy alchemy_getAssetTransfers: refused the request']);
});

test("a vault its factory computes the address of is read after a first line naming the call and the address it answered", async () => {
  const FUSDC = '0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33';
  const fluid = parseRegistry({
    usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', kind: 'token', source: 'https://example.org/usdc' },
    'fluid-lending-factory': {
      address: '0x54B91A0D94cb471F37f949c60F7Fa7935b551D03',
      kind: 'factory',
      source: 'https://example.org/lending-factory',
      instanceCheck: { function: 'computeToken(address,string)', args: [{ attribute: 'asset' }, { string: 'fToken' }] },
      size: { function: 'totalAssets()', unit: { function: 'asset()', attribute: 'asset' }, holders: true },
    },
    'fluid-fusdc': { address: FUSDC, kind: 'vault', source: 'https://example.org/fusdc', attributes: { asset: 'usdc', factory: 'fluid-lending-factory' } },
  });
  const at: BlockRef = { number: 24_000_000n, hash: `0x${'ab'.repeat(32)}` as Hex };
  const blocks: Read<BlockRef>[] = [
    { kind: 'agreed', value: at, providers: ['alchemy', 'drpc'] },
    { kind: 'unverifiable', reason: 'no second block', answers: [{ provider: 'alchemy', kind: 'malformed' }, { provider: 'drpc', kind: 'malformed' }] },
  ];
  const reader = {
    block: async () => blocks.shift()!,
    call: async (): Promise<Read<CallResult>> => ({ kind: 'agreed', value: { kind: 'returned', data: `0x${'00'.repeat(12)}${FUSDC.slice(2).toLowerCase()}` as Hex }, providers: ['alchemy', 'drpc'] }),
  } as Partial<Reader> as Reader;
  const { text } = await vaultEvidenceText(reader, async () => assert.fail('no Transfers API read'), fluid, fluid.entries.get('fluid-fusdc')!);
  assert.equal(text.split('\n')[0], `admitted     fluid-lending-factory answered computeToken(usdc,"fToken") = ${FUSDC} at block 24000000`);
  const fusdc = fluid.entries.get('fluid-fusdc')!;
  assert.equal(factoryAnswer(text, fusdc, fluid), 'admitted');
  assert.deepEqual(readStoredEvidence(text, fusdc, fluid).admitted, { factory: 'fluid-lending-factory', answers: [{ asker: 'fluid-lending-factory', check: 'computeToken(usdc,"fToken")', answer: FUSDC }], block: 24_000_000n });
  for (const answer of ['0x5C20B550819128074FD538Edf79791733ccEdd18', FUSDC.toLowerCase(), 'true']) {
    const other = text.replace(FUSDC, answer);
    assert.equal(factoryAnswer(other, fusdc, fluid), 'unread', `${answer} does not admit a vault whose factory computes its address`);
    assert.equal(readStoredEvidence(other, fusdc, fluid).admitted, undefined);
  }
});

test('a factory that answers true admits only with true, and a stored line from before the computed check reads as it did', () => {
  const vault = registry.entries.get('hyperithm-usdc-apex-v2-9e2f')!;
  const line = 'admitted     vault-v2-factory answered isVaultV2(address) = true at block 26404800';
  assert.equal(factoryAnswer(line, vault, registry), 'admitted');
  assert.deepEqual(readStoredEvidence(line, vault, registry).admitted, { factory: 'vault-v2-factory', answers: [{ asker: 'vault-v2-factory', check: 'isVaultV2(address)', answer: 'true' }], block: 26_404_800n });
  assert.equal(factoryAnswer(`${line}\n${line}`, vault, registry), 'unread', 'a line more than the factory declares views is no admission');
  const computed = line.replace('= true', `= ${checksumAddress(vault.address)}`);
  assert.equal(factoryAnswer(computed, vault, registry), 'unread');
  assert.equal(readStoredEvidence(computed, vault, registry).admitted, undefined);
  assert.equal(factoryAnswer("REFUSED vault-v2-factory answered isVaultV2(address) false for hyperithm-usdc-apex-v2-9e2f: it did not create it; the vault's code is not read", vault, registry), 'not-created');
});
