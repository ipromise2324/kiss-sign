import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { describeCallScan, scanCalls } from '../src/simulate/simulate.ts';
import type { CallScan } from '../src/simulate/simulate.ts';

const ROOT = join(import.meta.dirname, '..');
const load = (dir: string, name: string) => JSON.parse(readFileSync(join(ROOT, 'testdata', dir, `${name}.json`), 'utf8'));
const registry = loadRegistry(ROOT);

type Fixture = { executed: { number: string; hash: Hex }; parent: { number: string; hash: Hex }; exchanges: Exchange[] };

const MORPHO_BLUE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb' as Address;
const SET_AUTHORIZATION = '0xeecea000' as Hex;
const PENDLE = '0x808507121b80c02388fad14726482e061b8da827' as Address;

function txOf(name: string): SafeTx {
  const fixture = load('safe-tx', name);
  return parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
}

async function scan(name: string, tx: SafeTx = txOf(name), exchanges?: Exchange[]): Promise<CallScan> {
  const fixture: Fixture = load('simulate', name);
  const reader = replayReader(exchanges ?? fixture.exchanges);
  const header = async (at: { number: string; hash: Hex }) => {
    const read = await reader.header({ number: BigInt(at.number), hash: at.hash });
    assert.equal(read.kind, 'agreed');
    return (read as Extract<typeof read, { kind: 'agreed' }>).value;
  };
  const [parent, executed] = [await header(fixture.parent), await header(fixture.executed)];
  return scanCalls(reader, { tx, parent, time: executed.time, watch: [] });
}

test('a Morpho borrow from another Safe marks only its setAuthorization, the one call that moves no asset', async () => {
  const result = await scan('morpho-borrow-set-authorization');
  assert.deepEqual(result, { kind: 'scanned', movesNothing: [{ path: 'multiSend[1]', to: MORPHO_BLUE, selector: SET_AUTHORIZATION }] });
  assert.deepEqual(describeCallScan(result, registry), [
    'These calls move no asset of the Safe. Whatever they do changes a setting or grants a permission:',
    `  multiSend[1] to unregistered ${MORPHO_BLUE}, selector ${SET_AUTHORIZATION}`,
  ]);
});

test('a setAuthorization sent on its own is marked', async () => {
  assert.deepEqual(await scan('morpho-set-authorization'), { kind: 'scanned', movesNothing: [{ path: 'call', to: MORPHO_BLUE, selector: SET_AUTHORIZATION }] });
});

test('in a Uniswap v4 deposit only the last approve, which leaves an allowance already spent at zero, moves nothing', async () => {
  assert.deepEqual(await scan('uniswap-v4-add-liquidity-permit2'), {
    kind: 'scanned',
    movesNothing: [{ path: 'multiSend[4]', to: PENDLE, selector: '0x095ea7b3' }],
  });
});

test('a deposit and the unlimited Permit2 approval change an asset or an allowance in every call', async () => {
  assert.deepEqual(await scan('permit2-unlimited-approval'), { kind: 'scanned', movesNothing: [] });
  assert.deepEqual(describeCallScan({ kind: 'scanned', movesNothing: [] }, registry), ['Every call moves an asset of the Safe.']);
});

test('a scan whose measuring run the providers disagree on is unverifiable, and says so', async () => {
  const fixture: Fixture = load('simulate', 'morpho-borrow-set-authorization');
  const lying = structuredClone(fixture.exchanges);
  const runs = lying.filter((e) => e.method === 'eth_simulateV1');
  const last = runs[runs.length - 1]!;
  const calls = (last.answers.drpc as { calls: { returnData: string }[] }[])[0]!.calls;
  calls[0]!.returnData = `0x${'7'.padStart(64, '0')}`;
  const result = await scan('morpho-borrow-set-authorization', undefined, lying);
  assert.equal(result.kind, 'unverifiable');
  assert.match(describeCallScan(result, registry)[0]!, /^Which calls move no asset of the Safe could not be read: .*eth_simulateV1: alchemy and drpc disagree/);
});
