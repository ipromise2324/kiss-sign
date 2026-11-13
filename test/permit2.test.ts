import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import type { Reader } from '../src/chain/reader.ts';
import { checkFloor } from '../src/floor/floor.ts';
import { checkSimulatedFloor } from '../src/floor/simulated.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { describeFinding, judgeEffects } from '../src/simulate/effects.ts';
import type { Observed, Permit2Change } from '../src/simulate/effects.ts';
import { observeExecuted } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { loadTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const load = (dir: string, name: string) => JSON.parse(readFileSync(join(ROOT, 'testdata', dir, `${name}.json`), 'utf8'));

type Fixture = { transactionHash: Hex; executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };

const registry = loadRegistry(ROOT);
const PENDLE = '0x808507121b80c02388fad14726482e061b8da827' as Address;
const WBTC = '0x79cc183e0ca58962c92ddf2bd4f602bfbc24ddb5' as Address;
const USDC = registry.entries.get('usdc')!.address;
const POSITION_MANAGER = '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e' as Address;
const PERMIT2_MAX = (1n << 160n) - 1n;

function txOf(name: string): SafeTx {
  const fixture = load('safe-tx', name);
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

async function observe(name: string): Promise<{ simulated: Observed; receipt: Observed }> {
  const fixture: Fixture = load('simulate', name);
  const reader: Reader = replayReader(fixture.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(fixture.parent), await header(fixture.executed)];
  const tx = txOf(name);
  const observed = (observation: Observation): Observed => {
    assert.equal(observation.kind, 'observed', observation.kind === 'unverifiable' ? observation.reasons.join('; ') : '');
    return (observation as Extract<Observation, { kind: 'observed' }>).observed;
  };
  return {
    simulated: observed(await simulateSafeTx(reader, { tx, parent, time: executed.time, watch: [], ends: [] })),
    receipt: observed(await observeExecuted(reader, fixture.transactionHash, tx, [])),
  };
}

const permit2Of = (observed: Observed): readonly Permit2Change[] => {
  assert.equal(observed.kind, 'executed');
  return (observed as Extract<Observed, { kind: 'executed' }>).permit2;
};

const depositTemplate = loadTemplate(ROOT, 'morpho/vault-deposit', registry);
const templates = new Map([[depositTemplate.id, depositTemplate]]);
const SAFE = '0x2222222222222222222222222222222222222222' as Address;
const VAULT = registry.entries.get('steakhouse-prime-usdc-v2-0f51')!.address;
const AMOUNT = 1_000_000n;
const resolution = resolveCard(
  { operations: [{ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc-v2-0f51', amount: `${AMOUNT}`, 'min-shares': '1' } }] },
  { templates, registry, addressBook: new Map(), safe: SAFE },
);
assert.equal(resolution.kind, 'resolved');
const depositCard = (resolution as Extract<typeof resolution, { kind: 'resolved' }>).card;

const depositWith = (permit2: readonly Permit2Change[]) =>
  judgeEffects(
    {
      kind: 'executed',
      eth: 0n,
      tokens: new Map([
        [USDC, -AMOUNT],
        [VAULT, 1n],
      ]),
      allowances: [],
      permit2,
      ends: new Map(),
      safeState: { kind: 'receipt', logs: [] },
    },
    depositCard,
    templates,
    registry,
  );

test('a Uniswap v4 deposit from another Safe approves Permit2 and spends all of it: simulation and receipt read the same allowance, which ends at zero', async () => {
  const { simulated, receipt } = await observe('uniswap-v4-add-liquidity-permit2');
  const spent = [
    {
      token: PENDLE,
      spender: POSITION_MANAGER,
      before: { amount: 0n, expiration: 1793633819n, nonce: 0n },
      after: { amount: 0n, expiration: 1793899307n, nonce: 0n },
    },
  ];
  assert.deepEqual(permit2Of(simulated), spent);
  assert.deepEqual(permit2Of(receipt), spent);
  assert.deepEqual(checkSimulatedFloor(simulated, txOf('uniswap-v4-add-liquidity-permit2').safe), { kind: 'pass' });
  assert.deepEqual(depositWith(spent), { kind: 'match' });
});

test('a Permit2 approval of 2^160-1 from another Safe is refused by the static floor, the simulated floor and the effects', async () => {
  const tx = txOf('permit2-unlimited-approval');
  assert.equal(checkFloor(tx).kind, 'refused');
  const { simulated, receipt } = await observe('permit2-unlimited-approval');
  const left = permit2Of(simulated);
  assert.deepEqual(permit2Of(receipt), left);
  assert.deepEqual(
    left.map(({ token, after }) => [token, after.amount]),
    [
      [WBTC, PERMIT2_MAX],
      [USDC, PERMIT2_MAX],
    ],
  );
  for (const observed of [simulated, receipt]) {
    const floor = checkSimulatedFloor(observed, tx.safe);
    assert.equal(floor.kind, 'refused');
    const details = (floor as Extract<typeof floor, { kind: 'refused' }>).findings.map((f) => f.detail);
    for (const token of [WBTC, USDC]) assert.ok(details.includes(`Permit2 allowance of token ${token} to spender ${POSITION_MANAGER} for ${PERMIT2_MAX}`), token);
  }
  const verdict = depositWith(left);
  assert.equal(verdict.kind, 'mismatch');
  const findings = (verdict as Extract<typeof verdict, { kind: 'mismatch' }>).findings;
  assert.deepEqual(
    findings.map((f) => [f.kind, 'token' in f ? f.token : undefined]),
    [
      ['open-permit2-allowance', WBTC],
      ['open-permit2-allowance', USDC],
    ],
  );
  assert.match(describeFinding(findings[1]!, registry), /^Permit2 allowance raised and not spent in the same transaction: usdc 0x[0-9a-f]{40} to 0xbd21/);
});

const change = (before: [bigint, bigint, bigint], after: [bigint, bigint, bigint]): Permit2Change => {
  const allowance = ([amount, expiration, nonce]: [bigint, bigint, bigint]) => ({ amount, expiration, nonce });
  return { token: USDC, spender: POSITION_MANAGER, before: allowance(before), after: allowance(after) };
};

test('a Permit2 allowance may fall or be voided, but not rise in amount or last longer', () => {
  assert.deepEqual(depositWith([change([100n, 2000n, 0n], [40n, 2000n, 0n])]), { kind: 'match' });
  assert.deepEqual(depositWith([change([100n, 2000n, 0n], [100n, 2000n, 3n])]), { kind: 'match' });
  assert.deepEqual(depositWith([change([100n, 2000n, 0n], [0n, 9000n, 1n])]), { kind: 'match' });
  for (const raised of [change([100n, 2000n, 0n], [101n, 2000n, 0n]), change([100n, 2000n, 0n], [100n, 2001n, 0n]), change([0n, 0n, 0n], [1n, 1n, 1n])]) {
    assert.deepEqual(depositWith([raised]), { kind: 'mismatch', findings: [{ kind: 'open-permit2-allowance', ...raised }] });
  }
});
