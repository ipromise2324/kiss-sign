import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../../src/card.ts';
import type { ResolvedCard } from '../../src/card.ts';
import { readRecording } from '../../src/chain/bytecode.ts';
import { replayReader } from '../../src/chain/recording.ts';
import type { Exchange } from '../../src/chain/recording.ts';
import { loadRegistry } from '../../src/registry.ts';
import { parseServiceTx } from '../../src/safe/parse.ts';
import type { Address, Hex } from '../../src/safe/types.ts';
import { describeFinding, judgeEffects } from '../../src/simulate/effects.ts';
import type { EffectVerdict, Observed } from '../../src/simulate/effects.ts';
import { simulateSafeTx } from '../../src/simulate/simulate.ts';
import { checkTemplateFields } from '../../src/template/check.ts';
import { checkMutations } from '../../src/template/mutation.ts';
import { TemplateError, parseTemplate } from '../../src/template/template.ts';
import type { Template } from '../../src/template/template.ts';
import { detailText } from '../../src/verify/detail-text.ts';
import { repoWithTestFixtures } from '../repo-with-test-fixtures.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURES = repoWithTestFixtures();
const load = (dir: string, name: string) => readRecording<any>(join(ROOT, 'testdata', dir, `${name}.json`));
type Fixture = { executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };

const recorded: Fixture = load('simulate', 'morpho-vault-deposit');
const safeTxFixture = load('safe-tx', 'morpho-vault-deposit');
const deposit = parseServiceTx(safeTxFixture.service, { chainId: 1n, version: safeTxFixture.chain.version });
const registry = loadRegistry(ROOT);
const raw = JSON.parse(readFileSync(join(FIXTURES, 'templates', 'morpho', 'vault-deposit-bundler3', 'template.json'), 'utf8'));

const USDC = registry.entries.get('usdc')!.address;
const USDT = registry.entries.get('usdt')!.address;
/** What the other Safe's recorded deposit gave, in USDC base units. */
const AMOUNT = 1800000000180n;
const WHY = { en: 'rounding, as the protocol documents', 'zh-TW': '協定文件寫的捨入' };

/** The deposit template with its effects, or one call argument, replaced. */
const variant = (effects: object, approveValue: object = { card: 'amount' }): Template =>
  parseTemplate({ ...raw, effects, calls: [{ ...raw.calls[0], args: { ...raw.calls[0].args, value: approveValue } }, ...raw.calls.slice(1)] }, registry);

const gives = (extra: object) => ({ gives: [{ token: 'card.vault.asset', amount: 'card.amount', ...extra }], gets: [{ token: 'card.vault', amount: 'positive' }] });

function card(template: Template, amount: bigint): ResolvedCard {
  const values = { vault: 'steakhouse-prime-usdc-v2-0f51', amount: `${amount}`, 'min-shares': '1741863305677219101283940' };
  const result = resolveCard({ operations: [{ template: template.id, values }] }, { templates: new Map([[template.id, template]]), registry, addressBook: new Map(), safe: deposit.safe });
  assert.equal(result.kind, 'resolved');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

let simulatedOnce: Observed | undefined;
async function simulated(): Promise<Observed> {
  if (simulatedOnce !== undefined) return simulatedOnce;
  const reader = replayReader(recorded.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(recorded.parent), await header(recorded.executed)];
  const observation = await simulateSafeTx(reader, { tx: deposit, parent, time: executed.time, watch: [USDC], ends: [] });
  assert.equal(observation.kind, 'observed');
  simulatedOnce = (observation as Extract<typeof observation, { kind: 'observed' }>).observed;
  return simulatedOnce;
}

const judge = (observed: Observed, template: Template, amount: bigint): EffectVerdict => judgeEffects(observed, card(template, amount), new Map([[template.id, template]]), registry);
const details = (verdict: EffectVerdict): string[] => (verdict.kind === 'mismatch' ? verdict.findings.map((f) => describeFinding(f, registry)) : [verdict.kind]);

test('a card amount 2 base units above what the recorded deposit gave matches only with a tolerance of 2 more, in that direction alone', async () => {
  const observed = await simulated();
  const exact = variant(gives({}));
  assert.deepEqual(details(judge(observed, exact, AMOUNT)), ['match']);
  assert.deepEqual(details(judge(observed, exact, AMOUNT + 2n)), [`usdc ${USDC} changed by -1800000000180, the card explains -1800000000182`]);
  const more = variant(gives({ tolerance: { more: 2, why: WHY } }));
  assert.deepEqual(details(judge(observed, more, AMOUNT + 2n)), ['match']);
  assert.deepEqual(details(judge(observed, more, AMOUNT + 3n)), [`usdc ${USDC} changed by -1800000000180, the card explains between -1800000000183 and -1800000000181`]);
  assert.deepEqual(details(judge(observed, more, AMOUNT - 1n)), [`usdc ${USDC} changed by -1800000000180, the card explains between -1800000000179 and -1800000000177`]);
  const less = variant(gives({ tolerance: { less: 1, why: WHY } }));
  assert.deepEqual(details(judge(observed, less, AMOUNT - 1n)), ['match']);
  assert.deepEqual(details(judge(observed, less, AMOUNT + 1n)), [`usdc ${USDC} changed by -1800000000180, the card explains between -1800000000182 and -1800000000181`]);
});

test('a range finding reads in Traditional Chinese', () => {
  const finding = `usdc ${USDC} changed by -1800000000180, the card explains between -1800000000183 and -1800000000181`;
  assert.equal(detailText(finding, 'zh-TW'), `usdc ${USDC} 變動了 -1800000000180，卡片說明的是 介於 -1800000000183 和 -1800000000181 之間`);
});

test('what the Safe gives at most a card amount matches any amount up to it, and neither more nor a gain', async () => {
  const observed = await simulated();
  const atMost = variant({ gives: [{ token: 'card.vault.asset', amount: { atMost: 'card.amount' } }], gets: [{ token: 'card.vault', amount: 'positive' }] });
  assert.deepEqual(details(judge(observed, atMost, AMOUNT)), ['match']);
  assert.deepEqual(details(judge(observed, atMost, AMOUNT * 2n)), ['match']);
  assert.deepEqual(details(judge(observed, atMost, AMOUNT - 1n)), [`usdc ${USDC} changed by -1800000000180, the card explains between -1800000000179 and 0`]);
  const executed = observed as Extract<Observed, { kind: 'executed' }>;
  const gained = { ...executed, tokens: new Map([...executed.tokens, [USDC, 1n]]) };
  assert.deepEqual(details(judge(gained, atMost, AMOUNT)), [`usdc ${USDC} changed by +1, the card explains between -1800000000180 and 0`]);
});

test('an effect may name a registry token, which judges the recorded deposit as the card field naming it does', async () => {
  const observed = await simulated();
  const named = variant({ gives: [{ token: 'usdc', amount: 'card.amount' }], gets: [{ token: 'card.vault', amount: 'positive' }] });
  assert.deepEqual(details(judge(observed, named, AMOUNT)), ['match']);
  assert.deepEqual(details(judge(observed, named, AMOUNT + 1n)), [`usdc ${USDC} changed by -1800000000180, the card explains -1800000000181`]);
});

test('a token the template touches may change within its tolerance and no further; one no template names may not change at all', async () => {
  const executed = (await simulated()) as Extract<Observed, { kind: 'executed' }>;
  const withUsdt = (change: bigint): Observed => ({ ...executed, tokens: new Map([...executed.tokens, [USDT, change]]) });
  const touched = variant({ ...gives({}), touches: [{ token: 'usdt', tolerance: { more: 1, why: WHY } }] });
  assert.deepEqual(details(judge(withUsdt(0n), touched, AMOUNT)), ['match']);
  assert.deepEqual(details(judge(withUsdt(1n), touched, AMOUNT)), ['match']);
  assert.deepEqual(details(judge(withUsdt(2n), touched, AMOUNT)), [`usdt ${USDT} changed by +2, the card explains between 0 and +1`]);
  assert.deepEqual(details(judge(withUsdt(-1n), touched, AMOUNT)), [`usdt ${USDT} changed by -1, the card explains between 0 and +1`]);
  assert.deepEqual(details(judge(withUsdt(1n), variant(gives({})), AMOUNT)), [`usdt ${USDT} changed by +1, the card explains 0`]);
});

test('template load refuses a tolerance over the cap, one on an open amount, one with no direction, and a touched token the effects already name', () => {
  const refusal = (effects: object): string => {
    try {
      variant(effects);
    } catch (error) {
      assert.ok(error instanceof TemplateError, String(error));
      return error.message;
    }
    return 'loaded';
  };
  assert.match(refusal(gives({ tolerance: { less: 11, why: WHY } })), /tolerance\.less: not a whole number of base units from 1 to 10/);
  assert.match(refusal(gives({ tolerance: { less: 0, why: WHY } })), /tolerance\.less: not a whole number of base units from 1 to 10/);
  assert.match(refusal(gives({ tolerance: { why: WHY } })), /names neither less nor more/);
  assert.match(refusal(gives({ tolerance: { less: 1 } })), /why/);
  assert.match(refusal({ gives: [], gets: [{ token: 'card.vault', amount: 'positive', tolerance: { more: 1, why: WHY } }] }), /only an exact card amount of a token takes a tolerance/);
  assert.match(refusal({ gives: [{ token: 'usdc', amount: 'card.amount' }], gets: [], touches: [{ token: 'usdc', tolerance: { more: 1, why: WHY } }] }), /usdc is named in gives, gets or touches already/);
  assert.match(refusal({ gives: [{ token: 'bundler3', amount: 'card.amount' }], gets: [] }), /bundler3 is a router, not a token or a vault/);
  assert.match(refusal({ gives: [], gets: [], touches: [{ token: 'usdt', tolerance: { more: 1, why: WHY } }, { token: 'usdt', tolerance: { more: 1, why: WHY } }] }), /usdt is named in gives, gets or touches already/);
  assert.match(refusal({ gives: [{ token: 'eth', amount: 'card.amount', tolerance: { less: 1, why: WHY } }], gets: [] }), /only an exact card amount of a token takes a tolerance/);
  assert.match(refusal({ gives: [{ token: 'card.vault.asset', amount: { atLeast: 'card.amount' } }], gets: [] }), /atMost/);
  assert.match(refusal({ gives: [], gets: [{ token: 'card.vault', amount: { atMost: 'card.amount' } }] }), /atLeast/);
});

test('an atMost field matches the recorded deposit at its card amount, refuses a card amount below it, and its mutation to the loosest value is caught', () => {
  const template = variant(gives({}), { atMost: 'card.amount' });
  const templates = new Map([[template.id, template]]);
  assert.equal(checkTemplateFields(deposit, card(template, AMOUNT), templates, registry).kind, 'match');
  const below = checkTemplateFields(deposit, card(template, AMOUNT - 1n), templates, registry);
  const approve = below.kind === 'mismatch' ? below.findings.filter((f) => f.arg === 'value' && f.expected.startsWith('at most')) : [];
  assert.deepEqual(approve.map((f) => [f.expected, f.actual]), [[`at most ${AMOUNT - 1n}`, `${AMOUNT}`]]);
  assert.equal(detailText(`multiSend[0].approve value: expected at most ${AMOUNT - 1n}, got ${AMOUNT}`, 'zh-TW').includes(`最多 ${AMOUNT - 1n}`), true);
  assert.equal(checkMutations(deposit, card(template, AMOUNT), templates, registry).kind, 'pass');
});

test('a touched token that an effect reaches through a card field cannot widen its open amount: the recorded deposit with no shares is not a MATCH', async () => {
  const executed = (await simulated()) as Extract<Observed, { kind: 'executed' }>;
  const vault = registry.entries.get('steakhouse-prime-usdc-v2-0f51')!.address;
  const noShares: Observed = { ...executed, tokens: new Map([...executed.tokens, [vault, 0n]]) };
  const touched = variant({ ...gives({}), touches: [{ token: 'steakhouse-prime-usdc-v2-0f51', tolerance: { less: 1, why: WHY } }] });
  assert.deepEqual(judge(noShares, touched, AMOUNT), { kind: 'unverifiable', reasons: [`the card touches ${vault} and names it in an effect too`] });
  const atMost = variant({ gives: [{ token: 'card.vault.asset', amount: { atMost: 'card.amount' } }], gets: [{ token: 'card.vault', amount: 'positive' }] });
  const both = new Map([[atMost.id, atMost]]);
  const usdcTouch = parseTemplate({ ...raw, id: 'test/touch', effects: { gives: [], gets: [], touches: [{ token: 'usdc', tolerance: { more: 1, why: WHY } }] } }, registry);
  const templates = new Map([...both, [usdcTouch.id, usdcTouch]]);
  const values = { vault: 'steakhouse-prime-usdc-v2-0f51', amount: `${AMOUNT}`, 'min-shares': '1741863305677219101283940' };
  const result = resolveCard({ operations: [{ template: atMost.id, values }, { template: usdcTouch.id, values }] }, { templates, registry, addressBook: new Map(), safe: deposit.safe });
  assert.equal(result.kind, 'resolved');
  const twoOps = (result as Extract<typeof result, { kind: 'resolved' }>).card;
  assert.deepEqual(judgeEffects(executed, twoOps, templates, registry), { kind: 'unverifiable', reasons: [`the card touches ${USDC} and names it in an effect too`] });
  const exact = parseTemplate({ ...raw, id: 'test/exact', effects: { gives: [{ token: 'usdc', amount: 'card.amount', tolerance: { less: 1, why: WHY } }], gets: [] } }, registry);
  const withExact = new Map([...both, [exact.id, exact]]);
  const mixed = resolveCard({ operations: [{ template: exact.id, values }, { template: atMost.id, values }] }, { templates: withExact, registry, addressBook: new Map(), safe: deposit.safe });
  assert.equal(mixed.kind, 'resolved');
  const exactThenAtMost = (mixed as Extract<typeof mixed, { kind: 'resolved' }>).card;
  assert.deepEqual(judgeEffects(executed, exactThenAtMost, withExact, registry), { kind: 'unverifiable', reasons: [`a tolerance on ${USDC} would widen an open or atMost amount of it`] });
});

test('tolerances add up over the card\'s operations, each within its cap', async () => {
  const executed = (await simulated()) as Extract<Observed, { kind: 'executed' }>;
  const touch = parseTemplate({ ...raw, id: 'test/touch', effects: { gives: [], gets: [], touches: [{ token: 'usdt', tolerance: { more: 10, why: WHY } }] } }, registry);
  const templates = new Map([[touch.id, touch]]);
  const values = { vault: 'steakhouse-prime-usdc-v2-0f51', amount: `${AMOUNT}`, 'min-shares': '1' };
  const result = resolveCard({ operations: [{ template: touch.id, values }, { template: touch.id, values }] }, { templates, registry, addressBook: new Map(), safe: deposit.safe });
  assert.equal(result.kind, 'resolved');
  const twice = (result as Extract<typeof result, { kind: 'resolved' }>).card;
  const usdtOnly = (change: bigint): Observed => ({ ...executed, tokens: new Map([[USDT, change]]) });
  assert.deepEqual(judgeEffects(usdtOnly(20n), twice, templates, registry), { kind: 'match' });
  assert.deepEqual(details(judgeEffects(usdtOnly(21n), twice, templates, registry)), [`usdt ${USDT} changed by +21, the card explains between 0 and +20`]);
});

test("an atMost bound on a call's ETH value is mutated to the largest value, which the field check catches", () => {
  const fixture = load('safe-tx', 'eth-transfer-null-data');
  const tx = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
  const rawEth = JSON.parse(readFileSync(join(ROOT, 'templates', 'eth', 'transfer', 'template.json'), 'utf8'));
  const template = parseTemplate({ ...rawEth, calls: [{ ...rawEth.calls[0], value: { atMost: 'card.amount' } }] }, registry);
  const templates = new Map([[template.id, template]]);
  const payee = String(fixture.service.to).toLowerCase();
  const resolve = (amount: bigint): ResolvedCard => {
    const result = resolveCard({ operations: [{ template: template.id, values: { amount: `${amount}`, recipient: 'payee' } }] }, { templates, registry, addressBook: new Map([['payee', payee as Address]]), safe: tx.safe });
    assert.equal(result.kind, 'resolved', JSON.stringify(result));
    return (result as Extract<typeof result, { kind: 'resolved' }>).card;
  };
  assert.equal(checkTemplateFields(tx, resolve(tx.value + 1n), templates, registry).kind, 'match');
  assert.equal(checkTemplateFields(tx, resolve(tx.value - 1n), templates, registry).kind, 'mismatch');
  assert.equal(checkMutations(tx, resolve(tx.value), templates, registry).kind, 'pass');
});
