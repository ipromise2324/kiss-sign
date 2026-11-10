import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Exchange } from '../src/chain/recording.ts';
import { replayReader } from '../src/chain/recording.ts';
import { ZEPPELINOS_IMPLEMENTATION_SLOT } from '../src/contracts/proxy.ts';
import { RegistryError, loadRegistry, parseRegistry } from '../src/registry.ts';
import { evaluate } from '../src/verify/verify.ts';
import type { VerdictFile, VerifyInputs } from '../src/verify/verify.ts';

const ROOT = join(import.meta.dirname, '..');
const recorded: VerdictFile = JSON.parse(readFileSync(join(ROOT, 'testdata', 'verify', 'morpho-vault-deposit.json'), 'utf8'));
const BUNDLER3 = '0x6566194141eefa99af43bb5aa71460ca2dc90245';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ZEPPELINOS_SLOT = `0x${ZEPPELINOS_IMPLEMENTATION_SLOT.toString(16)}`;

const verdictOf = async (exchanges: readonly Exchange[], inputs: VerifyInputs = recorded.inputs) =>
  (await evaluate(inputs, replayReader(exchanges))).verdict;

function answering(method: string, params: (p: unknown[]) => boolean, value: string, only?: 'drpc'): Exchange[] {
  let changed = 0;
  const exchanges = recorded.exchanges.map((e) => {
    if (e.method !== method || !params(e.params as unknown[])) return e;
    changed++;
    return { ...e, answers: only === undefined ? { alchemy: value, drpc: value } : { ...e.answers, [only]: value } };
  });
  assert.equal(changed, 1, `one recorded ${method} matched`);
  return exchanges;
}

const codeOf = (address: string) => (p: unknown[]) => p[0] === address;
const slotOf = (address: string, slot: string) => (p: unknown[]) => p[0] === address && p[1] === slot;

function withRegistry(edit: (entries: Record<string, Record<string, unknown>>) => void): VerifyInputs {
  const entries = JSON.parse(recorded.inputs.registry);
  edit(entries);
  return { ...recorded.inputs, registry: JSON.stringify(entries) };
}

test('the recorded deposit runs the pinned code of every contract it touches, so it is MATCH', async () => {
  assert.deepEqual(await verdictOf(recorded.exchanges), { kind: 'MATCH' });
});

test('a contract whose code changed since it was pinned is MISMATCH', async () => {
  const verdict = await verdictOf(answering('eth_getCode', codeOf(BUNDLER3), '0x6000'));
  assert.equal(verdict.kind, 'MISMATCH');
  assert.deepEqual(verdict.kind === 'MISMATCH' ? verdict.causes.map((c) => c.check) : [], ['contract-code']);
  assert.match(JSON.stringify(verdict), /bundler3 0x6566194141eefa99af43bb5aa71460ca2dc90245 has code hash 0x[0-9a-f]{64} at block \d+, the registry pins 0xd3912f2b/);
});

const TOUCHED = [
  ['multisend-call-only-1.4.1', '0x9641d764fc13c8b624c04430c7356c1c7c8102e2', 'the Safe transaction calls it'],
  ['general-adapter1', '0x4a6c312ec70e8747a587ee860a0353cd42be0ae0', 'a template rule names it'],
  ['steakhouse-prime-usdc', '0xbeef088055857739c12cd3765f20b7679def0f51', 'the card names it'],
  ['usdc', USDC, "the card's vault names it as its asset"],
] as const;

for (const [name, address, why] of TOUCHED) {
  test(`${name} is checked because ${why}`, async () => {
    const verdict = await verdictOf(answering('eth_getCode', codeOf(address), '0x6000'));
    assert.equal(verdict.kind, 'MISMATCH');
    assert.match(JSON.stringify(verdict), new RegExp(`${name} ${address} has code hash`));
  });
}

test('a proxy that delegates to another implementation than its pin is MISMATCH, even when that code cannot be read', async () => {
  const other = `0x${'0'.repeat(24)}${'11'.repeat(20)}`;
  const verdict = await verdictOf(answering('eth_getStorageAt', slotOf(USDC, ZEPPELINOS_SLOT), other));
  assert.equal(verdict.kind, 'MISMATCH');
  assert.deepEqual(verdict.kind === 'MISMATCH' ? verdict.causes.map((c) => c.check) : [], ['contract-code']);
  assert.match(JSON.stringify(verdict), /usdc 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 delegates to 0x1111111111111111111111111111111111111111 at block \d+, the registry pins 0x43506849d7c04f9138d1a2050bbf3a0c054402dd/);
});

test('an implementation whose code changed at the pinned address is MISMATCH', async () => {
  const verdict = await verdictOf(answering('eth_getCode', codeOf('0x43506849d7c04f9138d1a2050bbf3a0c054402dd'), '0x6000'));
  assert.equal(verdict.kind, 'MISMATCH');
  assert.match(JSON.stringify(verdict), /usdc 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48's implementation 0x43506849d7c04f9138d1a2050bbf3a0c054402dd has code hash/);
});

test('code the two providers disagree on is UNVERIFIABLE', async () => {
  const verdict = await verdictOf(answering('eth_getCode', codeOf(BUNDLER3), '0x6000', 'drpc'));
  assert.equal(verdict.kind, 'UNVERIFIABLE');
  assert.deepEqual(verdict.kind === 'UNVERIFIABLE' ? verdict.causes.map((c) => c.check) : [], ['contract-code']);
});

test('a touched entry with no code pin, as a local history entry may be, is UNVERIFIABLE and names the command that pins it', async () => {
  const verdict = await verdictOf(recorded.exchanges, withRegistry((entries) => delete entries['steakhouse-prime-usdc']!.code));
  assert.equal(verdict.kind, 'UNVERIFIABLE');
  assert.match(JSON.stringify(verdict), /steakhouse-prime-usdc 0xbeef088055857739c12cd3765f20b7679def0f51 has no code pin in the registry; run pnpm pin-code steakhouse-prime-usdc/);
});

test('a pin that names no implementation for a contract that now delegates is MISMATCH', async () => {
  const verdict = await verdictOf(recorded.exchanges, withRegistry((entries) => delete (entries.usdc!.code as Record<string, unknown>).implementation));
  assert.equal(verdict.kind, 'MISMATCH');
  assert.match(JSON.stringify(verdict), /usdc 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 delegates to 0x43506849d7c04f9138d1a2050bbf3a0c054402dd at block \d+, the registry pins no implementation/);
});

test('every entry in registry/contracts.json carries a code pin', () => {
  const unpinned = [...loadRegistry(ROOT).entries.values()].filter((entry) => entry.code === undefined).map((entry) => entry.name);
  assert.deepEqual(unpinned, []);
});

test('a code pin with an implementation but no implementation hash is refused', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'registry', 'contracts.json'), 'utf8'));
  delete raw.usdc.code.implementation.hash;
  assert.throws(() => parseRegistry(raw), (error: unknown) => error instanceof RegistryError && error.message === 'usdc.code.implementation.hash: not 0x-prefixed even-length hex');
});
