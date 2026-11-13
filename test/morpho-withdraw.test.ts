import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { endsNeeded, expectedChanges, judgeEffects } from '../src/simulate/effects.ts';
import type { EffectVerdict } from '../src/simulate/effects.ts';
import { observeExecuted } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const WITHDRAW = 'morpho/vault-withdraw';
const ALL = 'morpho/vault-withdraw-all';
const templates = new Map([WITHDRAW, ALL].map((id) => [id, loadTemplate(ROOT, id, registry)]));
const VAULT = 'hyperithm-usdc-apex-v1-7777';

function safeTx(name: string): SafeTx {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

function resolved(tx: SafeTx, card: Card): ResolvedCard {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

const LOOSE_MAX_SHARES = `${10n ** 40n}`;
const withdraw = (amount: string, maxShares = LOOSE_MAX_SHARES): Card['operations'][number] => ({
  template: WITHDRAW,
  values: { vault: VAULT, amount, 'max-shares': maxShares },
});
const withdrawAll = (vault = VAULT, minAssets = '1'): Card['operations'][number] => ({ template: ALL, values: { vault, 'min-assets': minAssets } });
const card = (...operations: Card['operations']): Card => ({ operations });
const check = (tx: SafeTx, c: Card): FieldCheck => checkTemplateFields(tx, resolved(tx, c), templates, registry);
const findings = (result: FieldCheck) => (result.kind === 'mismatch' ? result.findings.map((f) => `${f.callPath}.${f.arg}`) : result);

const CASES = [
  { name: 'morpho-withdraw-apex', op: withdraw('583913520554', '555874861469460312138864'), bound: 14, free: 1 },
  { name: 'morpho-withdraw-apex-other-safe', op: withdraw('300000000000', '285585667181036150934684'), bound: 14, free: 1 },
  { name: 'morpho-withdraw-all-apex', op: withdrawAll(VAULT, '1367287893326'), bound: 13, free: 2 },
  { name: 'morpho-withdraw-all-apex-other-safe', op: withdrawAll(VAULT, '25172004987'), bound: 13, free: 2 },
] as const;

for (const c of CASES) {
  const tx = safeTx(c.name);

  test(`${c.name} matches ${c.op.template} with the card it implies`, () => {
    assert.deepEqual(check(tx, card(c.op)), { kind: 'match' });
  });

  test(`${c.name}: every bound field, changed alone, gives a mismatch`, () => {
    assert.deepEqual(checkMutations(tx, resolved(tx, card(c.op)), templates, registry), { kind: 'pass', bound: c.bound, free: c.free });
  });
}

function replaceSafeAt(tx: SafeTx, occurrence: number, other: Address): SafeTx {
  const safe = tx.safe.slice(2).toLowerCase();
  const parts = tx.data.split(safe);
  assert.ok(parts.length > occurrence + 1, 'the Safe occurs often enough');
  const data = parts.map((part, i) => (i === 0 ? part : `${i === occurrence + 1 ? other.slice(2) : safe}${part}`)).join('');
  return { ...tx, data: data as Hex };
}

const OTHER = '0x1111111111111111111111111111111111111111' as Address;

test('a withdrawal paid to someone else, or of someone else\'s shares, is a mismatch at that field', () => {
  const tx = safeTx('morpho-withdraw-apex');
  const op = card(withdraw('583913520554'));
  assert.deepEqual(findings(check(replaceSafeAt(tx, 0, OTHER), op)), ['multiSend[1].multicall.bundle[0].data.erc4626Withdraw.receiver']);
  assert.deepEqual(findings(check(replaceSafeAt(tx, 1, OTHER), op)), ['multiSend[1].multicall.bundle[0].data.erc4626Withdraw.owner']);
});

test('a card with another amount is a mismatch at the withdrawn assets', () => {
  const tx = safeTx('morpho-withdraw-apex');
  assert.deepEqual(findings(check(tx, card(withdraw('583913520555')))), ['multiSend[1].multicall.bundle[0].data.erc4626Withdraw.assets']);
});

test('a withdrawal of all is not a withdrawal of an amount, and the other way round', () => {
  assert.deepEqual(findings(check(safeTx('morpho-withdraw-all-apex'), card(withdraw('1')))), ['multiSend[1].multicall.bundle[0].data.selector']);
  assert.deepEqual(findings(check(safeTx('morpho-withdraw-apex'), card(withdrawAll()))), ['multiSend[1].multicall.bundle[0].data.selector']);
});

test('a withdrawal from another vault is a mismatch', () => {
  const result = check(safeTx('morpho-withdraw-all-apex'), card(withdrawAll('smokehouse-usdc-v1-f5bc')));
  assert.deepEqual(findings(result), ['multiSend[0].to', 'multiSend[1].multicall.bundle[0].data.erc4626Redeem.vault']);
});

type Fixture = { safeTx: string; transactionHash: Hex; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };
const recording = (name: string): Fixture => JSON.parse(readFileSync(join(ROOT, 'testdata', 'simulate', `${name}.json`), 'utf8'));

async function observe(name: string, c: Card): Promise<{ simulated: EffectVerdict; receipt: EffectVerdict }> {
  const fixture = recording(name);
  const tx = safeTx(fixture.safeTx);
  const reader = replayReader(fixture.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const resolvedCard = resolved(tx, c);
  const expectations = expectedChanges(resolvedCard, templates, registry);
  const watch = expectations.kind === 'expected' ? [...expectations.changes.keys()].filter((asset) => asset !== 'eth') : [];
  const ends = endsNeeded(expectations);
  const [parent, executed] = [await header(fixture.parent), await header(fixture.executed)];
  const judged = (observation: Observation): EffectVerdict => {
    assert.equal(observation.kind, 'observed', observation.kind === 'unverifiable' ? observation.reasons.join('; ') : '');
    return judgeEffects((observation as Extract<Observation, { kind: 'observed' }>).observed, resolvedCard, templates, registry);
  };
  return {
    simulated: judged(await simulateSafeTx(reader, { tx, parent, time: executed.time, watch, ends })),
    receipt: judged(await observeExecuted(reader, fixture.transactionHash, tx, ends)),
  };
}

test('a redeem of all the Safe\'s shares matches its effects, simulated and from its receipt', async () => {
  assert.deepEqual(await observe('morpho-withdraw-all', card(withdrawAll())), { simulated: { kind: 'match' }, receipt: { kind: 'match' } });
});

test('the Morpho app\'s withdrawal of an amount leaves part of its share approval open, which the effects refuse', async () => {
  const { simulated, receipt } = await observe('morpho-withdraw-open-allowance', card(withdraw('300000000000')));
  assert.deepEqual(simulated, receipt);
  assert.deepEqual(
    simulated.kind === 'mismatch' ? simulated.findings.map((f) => [f.kind, f.kind === 'open-allowance' ? f.after > f.before : undefined]) : simulated,
    [['open-allowance', true]],
  );
});

const SHARES = registry.entries.get(VAULT)!.address;
const USDC = registry.entries.get('usdc')!.address;

function judgeObserved(c: Card, tokens: [Address, bigint][], ends: [Address, bigint][]): EffectVerdict {
  const tx = safeTx('morpho-withdraw-all-apex');
  const observed = { kind: 'executed', eth: 0n, tokens: new Map(tokens), allowances: [], permit2: [], ends: new Map(ends), safeState: { kind: 'receipt', logs: [] } } as const;
  return judgeEffects(observed, resolved(tx, c), templates, registry);
}

test('a redeem that leaves the Safe holding shares is a mismatch for a card that withdraws all', () => {
  assert.deepEqual(judgeObserved(card(withdrawAll()), [[SHARES, -10n], [USDC, 11n]], [[SHARES, 1n]]), {
    kind: 'mismatch',
    findings: [{ kind: 'not-all', asset: SHARES, left: 1n }],
  });
});

test('a card that withdraws all, judged without the Safe\'s balance afterwards, is unverifiable', () => {
  assert.equal(judgeObserved(card(withdrawAll()), [[SHARES, -10n], [USDC, 11n]], []).kind, 'unverifiable');
});

test('a withdrawal that burns no shares is a mismatch', () => {
  assert.deepEqual(judgeObserved(card(withdraw('11')), [[USDC, 11n]], []), {
    kind: 'mismatch',
    findings: [{ kind: 'balance', asset: SHARES, expected: { kind: 'less-than', change: 0n }, actual: 0n }],
  });
});

test('two withdrawals from one vault, one of them of all, cannot be judged', () => {
  const tx = safeTx('morpho-withdraw-all-apex');
  assert.equal(expectedChanges(resolved(tx, card(withdrawAll(), withdraw('1'))), templates, registry).kind, 'unverifiable');
});

const BOTH_ALL = card(withdrawAll('smokehouse-usdc-v1-f5bc', '20245327154'), withdrawAll('usual-boosted-usdc-v1-3a3d', '17322520385'));
const ALL_THEN_AMOUNT = card(withdrawAll('smokehouse-usdc-v1-f5bc', '346769119920'), {
  template: WITHDRAW,
  values: { vault: 'usual-boosted-usdc-v1-3a3d', amount: '154000000000', 'max-shares': '139013506340509964396628' },
});

test('two withdrawals in one multicall match a card with two operations, and each bound field is caught', () => {
  const cases = [
    ['morpho-withdraw-two-vaults-all', BOTH_ALL, 24, 4],
    ['morpho-withdraw-two-vaults', ALL_THEN_AMOUNT, 25, 3],
  ] as const;
  for (const [name, c, bound, free] of cases) {
    const tx = safeTx(name);
    assert.deepEqual(check(tx, c), { kind: 'match' }, name);
    assert.deepEqual(checkMutations(tx, resolved(tx, c), templates, registry), { kind: 'pass', bound, free }, name);
  }
});

test('the operations of a merged multicall must be on the card, in its order', () => {
  const tx = safeTx('morpho-withdraw-two-vaults-all');
  assert.deepEqual(findings(check(tx, card(withdrawAll('usual-boosted-usdc-v1-3a3d'), withdrawAll('smokehouse-usdc-v1-f5bc')))), [
    'multiSend[0].to',
    'multiSend[1].to',
    'multiSend[2].multicall.bundle[0].data.erc4626Redeem.vault',
    'multiSend[2].multicall.bundle[1].data.erc4626Redeem.vault',
  ]);
  assert.deepEqual(findings(check(tx, card(withdrawAll('smokehouse-usdc-v1-f5bc')))), ['multiSend[1].to', 'multiSend[1].selector', 'multiSend[2].call']);
});

test('two redeems of all, from two vaults, match their effects simulated and from their receipt', async () => {
  assert.deepEqual(await observe('morpho-withdraw-two-vaults-all', BOTH_ALL), { simulated: { kind: 'match' }, receipt: { kind: 'match' } });
});

test('a redeem of all whose shares another transaction in the same block also moved cannot be judged from its receipt', async () => {
  const fixture = recording('morpho-withdraw-all');
  const tx = safeTx(fixture.safeTx);
  const balanceOf = `0x70a08231${tx.safe.slice(2).toLowerCase().padStart(64, '0')}`;
  const leftOver = `0x${(1n).toString(16).padStart(64, '0')}`;
  const exchanges = fixture.exchanges.map((exchange) => {
    const [request, at] = exchange.params as [{ data?: string }, { blockHash?: string }];
    if (exchange.method !== 'eth_call' || request.data !== balanceOf || at.blockHash !== fixture.parent.hash) return exchange;
    const answers = exchange.answers as Record<string, string>;
    return { ...exchange, answers: Object.fromEntries(Object.entries(answers).map(([provider, answer]) => [provider, `0x${(BigInt(answer) + BigInt(leftOver)).toString(16).padStart(64, '0')}`])) };
  });
  const resolvedCard = resolved(tx, card(withdrawAll()));
  const observation = await observeExecuted(replayReader(exchanges), fixture.transactionHash, tx, endsNeeded(expectedChanges(resolvedCard, templates, registry)));
  assert.equal(observation.kind, 'unverifiable');
  assert.match(observation.kind === 'unverifiable' ? observation.reasons.join('; ') : '', /another transaction in block \d+ moved the Safe's/);
});

test('an allowance that falls is allowed, one that rises and stays open is a mismatch', () => {
  const spender = registry.entries.get('general-adapter-1')!.address;
  const judge = (before: bigint, after: bigint): EffectVerdict => {
    const tx = safeTx('morpho-withdraw-all-apex');
    const observed = {
      kind: 'executed', eth: 0n, tokens: new Map([[SHARES, -5n], [USDC, 5n]]), ends: new Map([[SHARES, 0n]]),
      allowances: [{ token: SHARES, spender, before, after }], permit2: [], safeState: { kind: 'receipt', logs: [] },
    } as const;
    return judgeEffects(observed, resolved(tx, card(withdrawAll())), templates, registry);
  };
  assert.deepEqual(judge(490n, 0n), { kind: 'match' });
  assert.deepEqual(judge(0n, 0n), { kind: 'match' });
  assert.equal(judge(0n, 1n).kind, 'mismatch');
});

test('a card that allows fewer burned shares, or wants more assets, than the price bound guarantees is a mismatch at the bound', () => {
  const amount = safeTx('morpho-withdraw-apex');
  assert.deepEqual(findings(check(amount, card(withdraw('583913520554', '555874861469460312138863')))), [
    'multiSend[1].multicall.bundle[0].data.erc4626Withdraw.minSharePriceE27',
  ]);
  const all = safeTx('morpho-withdraw-all-apex');
  assert.deepEqual(findings(check(all, card(withdrawAll(VAULT, '1367287893327')))), ['multiSend[1].multicall.bundle[0].data.erc4626Redeem.minSharePriceE27']);
});

test('each operation of a merged multicall is held to its own card bound', () => {
  const tx = safeTx('morpho-withdraw-two-vaults-all');
  assert.deepEqual(findings(check(tx, card(withdrawAll('smokehouse-usdc-v1-f5bc', '20245327154'), withdrawAll('usual-boosted-usdc-v1-3a3d', '17322520386')))), [
    'multiSend[2].multicall.bundle[1].data.erc4626Redeem.minSharePriceE27',
  ]);
});

test('a redeem of 2^256-1 shares states no share count, so its price bound guarantees nothing and is a mismatch', () => {
  const tx = safeTx('morpho-withdraw-all-apex');
  const data = tx.data.slice(2);
  const selector = data.indexOf('a7f6e606');
  assert.ok(selector > 0 && data.indexOf('a7f6e606', selector + 1) === -1, 'one erc4626Redeem');
  const sharesAt = selector + 8 + 64;
  const max = { ...tx, data: `0x${data.slice(0, sharesAt)}${'f'.repeat(64)}${data.slice(sharesAt + 64)}` as Hex };
  const result = check(max, card(withdrawAll(VAULT, '1')));
  assert.equal(result.kind, 'mismatch');
  const found = result.kind === 'mismatch' ? result.findings.find((f) => f.arg === 'minSharePriceE27') : undefined;
  assert.match(found?.expected ?? '', /not the whole balance/);
});

test('a card naming a vault of another protocol is refused before any check', () => {
  const tx = safeTx('morpho-withdraw-apex');
  const result = resolveCard(card({ template: WITHDRAW, values: { vault: 'fluid-fusdc', amount: '1', 'max-shares': '1' } }), { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.deepEqual(result.kind === 'refused' ? [result.reason, result.detail] : result.kind, ['wrong-protocol', 'fluid-fusdc is a vault of fluid-lending, not of morpho-blue']);
});
