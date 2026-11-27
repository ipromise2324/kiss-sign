import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard, Resolution } from '../src/card.ts';
import { canonicalJson } from '../src/canonical.ts';
import { encodeCall, uintWord } from '../src/decode/codec.ts';
import type { AbiValue } from '../src/decode/codec.ts';
import { selectorOf } from '../src/decode/abi.ts';
import { MULTISEND } from '../src/decode/multisend.ts';
import type { Reader } from '../src/chain/reader.ts';
import { loadRegistry, parseRegistry } from '../src/registry.ts';
import { describeFinding, judgeEffects } from '../src/simulate/effects.ts';
import { withSimulatedViews } from '../src/simulate/executed.ts';
import type { EffectVerdict, Observed, ViewAnswer } from '../src/simulate/effects.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { checkCode, codeClaims } from '../src/verify/code.ts';
import { VerifyError, keccakText, prepare } from '../src/verify/verify.ts';
import type { VerifyInputs } from '../src/verify/verify.ts';

const SOURCE = 'https://docs.morpho.org/get-started/resources/addresses';
const CONTRACTS = {
  'morpho-blue': { address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', kind: 'lending', source: SOURCE },
  usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', kind: 'token', source: SOURCE },
  cbbtc: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', kind: 'token', source: SOURCE },
  'morpho-oracle-cbbtc-usdc-86': { address: '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a', kind: 'oracle', source: SOURCE },
  'adaptive-curve-irm': { address: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', kind: 'irm', source: SOURCE },
  'blue-bundles-v1': { address: '0xb0b0000000000000000000000000000000000b0b', kind: 'router', source: SOURCE },
};
const ID = '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64';
const MARKET = {
  lending: 'morpho-blue',
  loanToken: 'usdc',
  collateralToken: 'cbbtc',
  oracle: 'morpho-oracle-cbbtc-usdc-86',
  irm: 'adaptive-curve-irm',
  lltv: '860000000000000000',
  id: ID,
};

const withMarket = (changes: Record<string, unknown>, name = 'usdc-cbbtc-86') => () => parseRegistry(CONTRACTS, { [name]: { ...MARKET, ...changes } });

test('a market whose id is the hash of its parameters resolves each part to its registry entry', () => {
  const market = parseRegistry(CONTRACTS, { 'usdc-cbbtc-86': MARKET }).markets.get('usdc-cbbtc-86');
  assert.equal(market?.id, ID);
  assert.equal(market?.lltv, 860000000000000000n);
  assert.deepEqual(
    [market?.lending.name, market?.loanToken.name, market?.collateralToken.name, market?.oracle.name, market?.irm.name],
    ['morpho-blue', 'usdc', 'cbbtc', 'morpho-oracle-cbbtc-usdc-86', 'adaptive-curve-irm'],
  );
});

test('a market id written in capitals is the same id', () => {
  assert.equal(withMarket({ id: `0x${ID.slice(2).toUpperCase()}` })().markets.get('usdc-cbbtc-86')?.id, ID);
});

test('a market whose id is not the hash of its parameters is refused, naming the hash they give', () => {
  assert.throws(withMarket({ lltv: '915000000000000000' }), {
    name: 'RegistryError',
    message: /^markets\.usdc-cbbtc-86\.id: is not the id of these parameters, which hash to 0x[0-9a-f]{64}$/,
  });
  assert.throws(withMarket({ collateralToken: 'usdc' }), { message: /^markets\.usdc-cbbtc-86\.id: is not the id of these parameters/ });
});

test('a market part that names an entry of the wrong kind, or no entry, is refused', () => {
  assert.throws(withMarket({ oracle: 'usdc' }), { message: 'markets.usdc-cbbtc-86.oracle: "usdc" is not an oracle in the registry' });
  assert.throws(withMarket({ irm: 'no-such-irm' }), { message: 'markets.usdc-cbbtc-86.irm: "no-such-irm" is not an irm in the registry' });
  assert.throws(withMarket({ lending: 'usdc' }), { message: 'markets.usdc-cbbtc-86.lending: "usdc" is not a lending in the registry' });
  assert.throws(withMarket({ loanToken: 'morpho-blue' }), { message: 'markets.usdc-cbbtc-86.loanToken: "morpho-blue" is not a token in the registry' });
});

test('a market with a part missing, an extra field, or an lltv that is not a uint256 is refused', () => {
  const { irm: _, ...noIrm } = MARKET;
  assert.throws(() => parseRegistry(CONTRACTS, { m: noIrm }), { message: 'markets.m.irm: missing' });
  assert.throws(withMarket({ curator: 'x' }, 'm'), { message: 'markets.m.curator: unexpected field' });
  for (const lltv of [860000000000000000, '0.86', '-1', '08', (1n << 256n).toString()]) {
    assert.throws(withMarket({ lltv }, 'm'), { message: 'markets.m.lltv: not a decimal integer below 2^256' }, String(lltv));
  }
  assert.throws(withMarket({ id: '0x64d6' }, 'm'), { message: 'markets.m.id: not 32 bytes' });
});

test('a market name must be a name that no contract, the Safe or ETH already holds', () => {
  assert.throws(withMarket({}, 'usdc'), { message: 'markets.usdc: is also a registry contract' });
  assert.throws(withMarket({}, 'safe'), { message: 'markets.safe: not a market name' });
  assert.throws(withMarket({}, 'eth'), { message: 'markets.eth: not a market name' });
  assert.throws(withMarket({}, 'USDC Market'), { message: 'markets.USDC Market: not a market name' });
});

test('a repository without registry/markets.json has no markets, and one with it has them', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-markets-'));
  mkdirSync(join(root, 'registry'));
  writeFileSync(join(root, 'registry', 'contracts.json'), JSON.stringify(CONTRACTS));
  assert.equal(loadRegistry(root).markets.size, 0);
  writeFileSync(join(root, 'registry', 'markets.json'), JSON.stringify({ 'usdc-cbbtc-86': MARKET }));
  assert.deepEqual([...loadRegistry(root).markets.keys()], ['usdc-cbbtc-86']);
});

const registry = parseRegistry(CONTRACTS, { 'usdc-cbbtc-86': MARKET });
const SAFE = '0x5afe00000000000000000000000000000000005a' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const MULTISEND_CALL_ONLY = '0x9641d764fc13c8b624c04430c7356c1c7c8102e2' as Address;
const at = (name: keyof typeof CONTRACTS): Address => CONTRACTS[name].address.toLowerCase() as Address;

/** The supply template the brief names, as a template author writes it. */
const SUPPLY = {
  id: 'morpho/market-supply',
  card: { market: { kind: 'market' }, amount: { kind: 'amount', of: 'market.loanToken' } },
  calls: [
    {
      to: { card: 'market.loanToken' },
      value: { const: '0' },
      function: 'approve(address spender, uint256 value)',
      args: { spender: { contract: 'blue-bundles-v1' }, value: { card: 'amount' } },
    },
    {
      to: { contract: 'blue-bundles-v1' },
      value: { const: '0' },
      function:
        'blueBundlesV1Supply((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, (uint8 kind, bytes data) loanTokenPermit, uint256 referralFeePct, address referralFeeRecipient, uint256 deadline)',
      args: {
        marketParams: { card: 'market' },
        assets: { card: 'amount' },
        loanTokenPermit: { fields: { kind: { const: '0' }, data: { free: { unread: 'test: no permit' } } } },
        referralFeePct: { const: '0' },
        referralFeeRecipient: { const: '0x0000000000000000000000000000000000000000' },
        deadline: { free: 'test: a deadline only shortens when the call can run' },
      },
    },
  ],
  effects: {
    gives: [{ token: 'card.market.loanToken', amount: 'card.amount' }],
    gets: [],
    views: [
      {
        to: { contract: 'morpho-blue' },
        function: 'position(bytes32 id, address user) returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
        args: { id: { card: 'market.id' }, user: { safe: true } },
        change: { supplyShares: 'increases', borrowShares: 'same', collateral: 'same' },
      },
    ],
  },
};

const template = parseTemplate(SUPPLY, registry, 'committed');
const templates = new Map([[template.id, template]]);
const supplyCard = (market = 'usdc-cbbtc-86', amount = '5000000'): Card => ({ operations: [{ template: template.id, values: { market, amount } }] });
const resolve = (card: Card): Resolution => resolveCard(card, { templates, registry, addressBook: new Map(), safe: SAFE });

function resolved(card: Card = supplyCard()): ResolvedCard {
  const result = resolve(card);
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<Resolution, { kind: 'resolved' }>).card;
}

const span = [0, 0] as const;
const address = (value: Address): AbiValue => ({ kind: 'address', value, span });
const uint = (value: bigint): AbiValue => ({ kind: 'uint', value, span });
type Params = { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint };
const PARAMS: Params = { loanToken: at('usdc'), collateralToken: at('cbbtc'), oracle: at('morpho-oracle-cbbtc-usdc-86'), irm: at('adaptive-curve-irm'), lltv: 860000000000000000n };

const packed = (to: Address, data: Uint8Array): Uint8Array => concatBytes(Uint8Array.of(0), hexToBytes(to.slice(2)), uintWord(0n), uintWord(BigInt(data.length)), data);

/** The Safe's batch: an exact approval of the loan token to the bundler, then the supply. */
function supplyTx(params: Params = PARAMS, amount = 5000000n): SafeTx {
  const [approve, supply] = template.calls.map((call) => (call.data === 'empty' ? assert.fail('a call with data') : call.data.fn));
  const approveData = encodeCall({ fn: approve!, args: [address(at('blue-bundles-v1')), uint(amount)], trailer: undefined });
  const marketParams: AbiValue = { kind: 'tuple', fields: [address(params.loanToken), address(params.collateralToken), address(params.oracle), address(params.irm), uint(params.lltv)], span };
  const permit: AbiValue = { kind: 'tuple', fields: [uint(0n), { kind: 'bytes', value: new Uint8Array(), span }], span };
  const supplyData = encodeCall({ fn: supply!, args: [marketParams, uint(amount), permit, uint(0n), address(`0x${'00'.repeat(20)}` as Address), uint(1_800_000_000n)], trailer: undefined });
  const batch = concatBytes(packed(params.loanToken, approveData), packed(at('blue-bundles-v1'), supplyData));
  const data = `0x${bytesToHex(encodeCall({ fn: MULTISEND, args: [{ kind: 'bytes', value: batch, span }], trailer: undefined }))}` as Hex;
  const zero = `0x${'00'.repeat(20)}` as Address;
  return { chainId: 1n, safe: SAFE, version: '1.4.1', to: MULTISEND_CALL_ONLY, value: 0n, data, operation: 1, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zero, refundReceiver: zero, nonce: 7n };
}

const check = (tx: SafeTx, card: ResolvedCard = resolved()): FieldCheck => checkTemplateFields(tx, card, templates, registry);

test('a card names a market by its name, and resolves to that market with every part', () => {
  const value = resolved().operations[0]?.values.get('market');
  assert.equal(value?.kind, 'market');
  assert.equal(value?.kind === 'market' ? value.market.id : undefined, ID);
});

test('a card naming no market, or a contract instead of one, is refused', () => {
  assert.deepEqual(resolve(supplyCard('usdc-wbtc-86')), {
    kind: 'refused',
    reason: 'unknown-name',
    at: 'operations[0].values.market',
    field: 'market',
    detail: '"usdc-wbtc-86" is not a market in registry/markets.json',
  });
  assert.equal((resolve(supplyCard('usdc')) as Extract<Resolution, { kind: 'refused' }>).detail, '"usdc" is not a market in registry/markets.json');
});

test('a verdict input with the markets table resolves a market card, and one without it refuses the card', () => {
  const cardText = canonicalJson(supplyCard());
  const inputs: VerifyInputs = {
    commit: 'test',
    safe: SAFE,
    tx: { format: 'web-app', json: {} },
    card: { hash: keccakText(cardText), text: cardText },
    templates: [{ id: template.id, text: JSON.stringify(SUPPLY), approved: null }],
    registry: JSON.stringify(CONTRACTS),
    markets: JSON.stringify({ 'usdc-cbbtc-86': MARKET }),
    addressBook: {},
  };
  assert.equal(prepare(inputs).card.operations[0]?.values.get('market')?.kind, 'market');
  const { markets: _, ...before } = inputs;
  assert.throws(() => prepare(before), new VerifyError('the card is refused at operations[0].values.market: "usdc-cbbtc-86" is not a market in registry/markets.json'));
});

const refusal = (change: (raw: typeof SUPPLY) => void): string => {
  const raw = structuredClone(SUPPLY);
  change(raw);
  try {
    parseTemplate(raw, registry, 'committed');
  } catch (error) {
    return (error as Error).message;
  }
  return 'accepted';
};

test('a whole market binds only a MarketParams tuple: four addresses and a uint256, in that order', () => {
  const supply = SUPPLY.calls[1]!;
  const withSignature = (params: string) => (raw: typeof SUPPLY) => {
    raw.calls[1]!.function = supply.function.replace(/^blueBundlesV1Supply\(\([^)]*\) marketParams/, `blueBundlesV1Supply((${params}) marketParams`);
  };
  const shape = 'calls[1].args.marketParams: a whole market binds only a (address,address,address,address,uint256) tuple, not a';
  assert.equal(refusal(withSignature('address a, address b, address c, address d')), `${shape} (address,address,address,address)`);
  assert.equal(refusal(withSignature('address a, address b, address c, uint256 lltv, address d')), `${shape} (address,address,address,uint256,address)`);
  assert.equal(refusal(withSignature('address a, address b, address c, address d, uint128 lltv')), `${shape} (address,address,address,address,uint128)`);
  assert.equal(
    refusal((raw) => {
      (raw.calls[0]!.args as Record<string, unknown>).spender = { card: 'market' };
    }),
    'calls[0].args.spender: a whole market binds only a (address,address,address,address,uint256) tuple, not a address',
  );
});

test('a market part binds a value of its own type, and a part a market lacks is refused', () => {
  const bind = (rule: unknown) => (raw: typeof SUPPLY) => {
    (raw.calls[1]!.args as Record<string, unknown>).referralFeePct = rule;
  };
  assert.equal(refusal(bind({ card: 'market.lltv' })), 'accepted');
  assert.equal(refusal(bind({ card: 'market.id' })), 'calls[1].args.referralFeePct: a card rule cannot bind a uint256');
  assert.equal(refusal(bind({ card: 'market.oracle' })), 'calls[1].args.referralFeePct: a card rule cannot bind a uint256');
  assert.equal(refusal(bind({ card: 'market.curator' })), 'calls[1].args.referralFeePct.card: "curator" is not one of lending, loanToken, collateralToken, oracle, irm, lltv, id');
  assert.equal(
    refusal((raw) => {
      raw.card.amount.of = 'market.lltv';
    }),
    'card.amount.of: must name a token',
  );
});

test('the supply batch matches its template and the market on the card', () => {
  assert.deepEqual(check(supplyTx()), { kind: 'match' });
});

test('each market parameter changed alone is a mismatch at that part, against the registry market', () => {
  const path = 'multiSend[1].blueBundlesV1Supply';
  const cases: [keyof Params, Address | bigint, string][] = [
    ['loanToken', OTHER, PARAMS.loanToken],
    ['collateralToken', at('usdc'), PARAMS.collateralToken],
    ['oracle', OTHER, PARAMS.oracle],
    ['irm', OTHER, PARAMS.irm],
    ['lltv', 915000000000000000n, '860000000000000000'],
  ];
  for (const [part, value, expected] of cases) {
    const result = check(supplyTx({ ...PARAMS, [part]: value }));
    assert.equal(result.kind, 'mismatch', part);
    const findings = (result as Extract<FieldCheck, { kind: 'mismatch' }>).findings.filter((f) => f.callPath === path);
    assert.deepEqual(
      findings.map((f) => [f.arg, f.expected, f.actual]),
      [[`marketParams.${part}`, expected, String(value)]],
      part,
    );
  }
});

test('a supply to another market than the card names is a mismatch, and so is a card naming another market', () => {
  const other = parseRegistry(CONTRACTS, {
    'usdc-cbbtc-86': MARKET,
    'usdc-cbbtc-915': { ...MARKET, lltv: '915000000000000000', id: '0x46d5534a38e80d1d8e85d3421c1f1339abd47244c4799a657f44410be8581afc' },
  });
  assert.equal(other.markets.size, 2);
  const card = resolveCard(supplyCard('usdc-cbbtc-915'), { templates, registry: other, addressBook: new Map(), safe: SAFE });
  assert.equal(card.kind, 'resolved');
  assert.equal(checkTemplateFields(supplyTx(), (card as Extract<Resolution, { kind: 'resolved' }>).card, templates, other).kind, 'mismatch');
});

test('the mutation check changes every bound field, the five market parameters among them, and each gives a mismatch', () => {
  // approve: to, value, spender, amount; supply: to, value, 5 market parameters, assets, permit kind, fee, fee recipient.
  assert.deepEqual(checkMutations(supplyTx(), resolved(), templates, registry), { kind: 'pass', bound: 15, free: 2 });
});

test('verify requires a code pin for Morpho Blue and every contract the market on the card names', async () => {
  const claims = codeClaims(supplyTx(), resolved(), templates, registry);
  const noReads = new Proxy({}, { get: () => () => assert.fail('an entry without a pin is not read') }) as Reader;
  const result = await checkCode(noReads, claims, { number: 1n, hash: `0x${'00'.repeat(32)}` as Hex }, 'pending');
  const unpinned = result.kind === 'unverifiable' ? result.reasons.map((r) => r.split(' ')[0]).sort() : [];
  assert.deepEqual(unpinned, ['adaptive-curve-irm', 'blue-bundles-v1', 'cbbtc', 'morpho-blue', 'morpho-oracle-cbbtc-usdc-86', 'usdc']);
});

/** Morpho Blue's `position(id, Safe)` for the card's market, encoded here by hand. */
const POSITION = {
  to: at('morpho-blue'),
  data: `${selectorOf('position(bytes32,address)')}${ID.slice(2)}${SAFE.slice(2).padStart(64, '0')}` as Hex,
};
const answer = (...words: bigint[]): ViewAnswer => ({ kind: 'returned', data: `0x${words.map((w) => w.toString(16).padStart(64, '0')).join('')}` as Hex });

/** What the supply did to the Safe: it gave the card's amount of the loan token, and its position read as given. */
const supplied = (position?: { before: ViewAnswer; after: ViewAnswer }): Observed => ({
  kind: 'executed',
  eth: 0n,
  tokens: new Map([[PARAMS.loanToken, -5000000n]]),
  allowances: [],
  permit2: [],
  ends: new Map(),
  safeState: { kind: 'receipt', logs: [] },
  ...(position === undefined ? {} : { views: [{ ...POSITION, ...position, readIn: 'simulation' as const }] }),
});

const judged = (observed: Observed, t: Template = template): EffectVerdict => judgeEffects(observed, resolved(), new Map([[t.id, t]]), registry);
const described = (verdict: EffectVerdict): string[] => (verdict.kind === 'mismatch' ? verdict.findings.map((f) => describeFinding(f, registry)) : [verdict.kind]);
const VIEW = `morpho-blue ${at('morpho-blue')} position(${ID}, ${SAFE})`;

test('a supply that credits the Safe supply shares and leaves its debt and collateral alone matches', () => {
  assert.deepEqual(judged(supplied({ before: answer(100n, 7n, 9n), after: answer(4_900_100n, 7n, 9n) })), { kind: 'match' });
});

test('supply shares that do not increase, or debt or collateral that moves, are each a mismatch naming the view and both values', () => {
  assert.deepEqual(described(judged(supplied({ before: answer(100n, 7n, 9n), after: answer(100n, 8n, 0n) }))), [
    `${VIEW} supplyShares: 100 before, 100 after in a simulated block; the template needs it to increase`,
    `${VIEW} borrowShares: 7 before, 8 after in a simulated block; the template needs it to stay the same`,
    `${VIEW} collateral: 9 before, 0 after in a simulated block; the template needs it to stay the same`,
  ]);
});

test('a view whose template says decreases matches a fall and refuses a rise', () => {
  const raw = structuredClone(SUPPLY);
  raw.effects.views[0]!.change = { supplyShares: 'decreases' } as never;
  const withdraw = parseTemplate(raw, registry, 'committed');
  assert.deepEqual(judged(supplied({ before: answer(100n, 0n, 0n), after: answer(40n, 0n, 0n) }), withdraw), { kind: 'match' });
  assert.deepEqual(described(judged(supplied({ before: answer(100n, 0n, 0n), after: answer(140n, 0n, 0n) }), withdraw)), [
    `${VIEW} supplyShares: 100 before, 140 after in a simulated block; the template needs it to decrease`,
  ]);
});

test('a view that was not read, reverted, or answered something else is unverifiable, and never a match', () => {
  assert.deepEqual(judged(supplied()), { kind: 'unverifiable', reasons: [`${VIEW} was not read`] });
  assert.deepEqual(judged(supplied({ before: answer(100n, 0n, 0n), after: { kind: 'unread', why: 'it reverted at block 9' } })), {
    kind: 'unverifiable',
    reasons: [`${VIEW} could not be read after the transaction in a simulated block: it reverted at block 9`],
  });
  assert.deepEqual(judged(supplied({ before: answer(100n, 0n), after: answer(200n, 0n, 0n) })), {
    kind: 'unverifiable',
    reasons: [`${VIEW} could not be read before the transaction in a simulated block: its answer does not decode as uint256, uint128, uint128`],
  });
  assert.deepEqual(judged(supplied({ before: answer(100n, 1n << 128n, 0n), after: answer(200n, 0n, 0n) })).kind, 'unverifiable');
});

test('an executed supply is judged on its view both at its blocks and simulated alone, so another transaction in its block cannot pass for it', () => {
  const atBlocks = { ...supplied(), views: [{ ...POSITION, before: answer(100n, 0n, 0n), after: answer(150n, 0n, 0n), readIn: 'blocks' as const }] };
  const receipt = { kind: 'observed', observed: atBlocks, logs: [] } as const;
  const alone = (before: ViewAnswer, after: ViewAnswer) =>
    ({ kind: 'observed', observed: { ...supplied(), safeState: { kind: 'receipt', logs: [] }, views: [{ ...POSITION, before, after, readIn: 'simulation' as const }] }, logs: [] }) as const;
  const judgedWith = (simulated: Parameters<typeof withSimulatedViews>[1]) => {
    const merged = withSimulatedViews(receipt, simulated, [POSITION]);
    assert.equal(merged.kind, 'observed');
    return judged((merged as Extract<typeof merged, { kind: 'observed' }>).observed);
  };
  assert.deepEqual(judgedWith(alone(answer(100n, 0n, 0n), answer(140n, 0n, 0n))), { kind: 'match' });
  assert.deepEqual(described(judgedWith(alone(answer(100n, 0n, 0n), answer(100n, 0n, 0n)))), [
    `${VIEW} supplyShares: 100 before, 100 after in a simulated block; the template needs it to increase`,
  ]);
  assert.deepEqual(judgedWith({ kind: 'unverifiable', reasons: ['no agreed parent block'] }), {
    kind: 'unverifiable',
    reasons: [`${VIEW} could not be read before the transaction in a simulated block: no agreed parent block`],
  });
  assert.deepEqual(judgedWith({ kind: 'observed', observed: supplied(), logs: [] }), {
    kind: 'unverifiable',
    reasons: [`${VIEW} could not be read before the transaction in a simulated block: the simulation on the parent block did not read it`],
  });
});

test('a balance the card does not explain is still a mismatch when the view is right', () => {
  const observed = { ...supplied({ before: answer(1n, 0n, 0n), after: answer(2n, 0n, 0n) }), tokens: new Map([[PARAMS.loanToken, -6000000n]]) } as Observed;
  assert.equal(judged(observed).kind, 'mismatch');
});

test('a view must name a registry contract or a contract card field, a function with its returns, bound arguments and numeric return values to judge', () => {
  const view = (change: (v: (typeof SUPPLY)['effects']['views'][number]) => void) => (raw: typeof SUPPLY) => change(raw.effects.views[0]!);
  assert.equal(refusal(view((v) => void (v.to = { card: 'market.lending' } as never))), 'effects.views[0].to: must name a registry contract, or a contract card field or one of its attributes');
  assert.match(refusal(view((v) => void (v.function = 'position(bytes32 id, address user)'))), /^effects\.views\[0\]\.function: .* expected "returns \("$/);
  assert.equal(
    refusal(view((v) => void (v.args = { id: { free: 'any market' }, user: { safe: true } } as never))),
    "effects.views[0].args.id: a view's argument is bound by card, safe, contract or const, not free",
  );
  assert.equal(refusal(view((v) => void (v.change = { shares: 'increases' } as never))), 'effects.views[0].change.shares: not a named return value of position');
  assert.equal(refusal(view((v) => void (v.change = { supplyShares: 'grows' } as never))), 'effects.views[0].change.supplyShares: not one of increases, decreases, same, or card.<amount or percent field>');
  assert.equal(refusal(view((v) => void (v.change = {} as never))), 'effects.views[0].change: names no return value');
  assert.equal(
    refusal(
      view((v) => {
        v.function = 'idToMarketParams(bytes32 id) returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)';
        v.args = { id: { card: 'market.id' } } as never;
        v.change = { oracle: 'same' } as never;
      }),
    ),
    'effects.views[0].change.oracle: address is not a number; only a number is judged',
  );
});

test('a bytes32 bound to the market id matches that id and nothing else', () => {
  const byId = parseTemplate(
    {
      id: 'test/market-id',
      card: { market: { kind: 'market' } },
      calls: [{ to: { card: 'market.lending' }, value: { const: '0' }, function: 'idToMarketParams(bytes32 id)', args: { id: { card: 'market.id' } } }],
      effects: { gives: [], gets: [] },
    },
    registry,
    'committed',
  );
  const card = resolveCard({ operations: [{ template: byId.id, values: { market: 'usdc-cbbtc-86' } }] }, { templates: new Map([[byId.id, byId]]), registry, addressBook: new Map(), safe: SAFE });
  assert.equal(card.kind, 'resolved');
  const call = (id: string): SafeTx => ({ ...supplyTx(), to: at('morpho-blue'), operation: 0, data: `${selectorOf('idToMarketParams(bytes32)')}${id.slice(2)}` as Hex });
  const resolvedCard = (card as Extract<Resolution, { kind: 'resolved' }>).card;
  const fields = (tx: SafeTx) => checkTemplateFields(tx, resolvedCard, new Map([[byId.id, byId]]), registry);
  assert.deepEqual(fields(call(ID)), { kind: 'match' });
  const other = `0x${'46'.repeat(32)}`;
  const result = fields(call(other));
  assert.deepEqual(result.kind === 'mismatch' ? result.findings.map((f) => [f.arg, f.expected, f.actual]) : result, [['id', ID, other]]);
});
