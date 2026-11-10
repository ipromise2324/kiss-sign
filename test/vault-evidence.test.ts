import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReader } from '../src/chain/reader.ts';
import { REPLAY_ENDPOINTS, replayTransport } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { alchemyCall, formatVaultEvidence, gatherVaultEvidence } from '../src/research/vault-evidence.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const recorded: { vault: string; exchanges: Exchange[] } = JSON.parse(readFileSync(join(ROOT, 'testdata', 'vault-evidence', 'steakhouse-high-yield-usdc.json'), 'utf8'));
const TOTAL_ASSETS = '0x01e1d114';
const TOTAL_SUPPLY = '0x18160ddd';

async function evidenceFrom(exchanges: readonly Exchange[]): Promise<string> {
  const transport = replayTransport(exchanges, REPLAY_ENDPOINTS);
  const reader = createReader(REPLAY_ENDPOINTS, transport, { timeoutMs: 1000, retryPausesMs: [], rateLimitPausesMs: [] });
  const evidence = await gatherVaultEvidence(reader, alchemyCall(transport, REPLAY_ENDPOINTS[0].url), registry.entries.get(recorded.vault)!);
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
  assert.match(text, /^vault {8}steakhouse-high-yield-usdc 0xbeeff2C5bF38f90e3482a8b19F12E5a6D2FCa757\n/);
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
