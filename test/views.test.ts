import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Reader } from '../src/chain/reader.ts';
import type { BlockHeader, BlockRef, SimulatedCall, SimulationRequest } from '../src/chain/types.ts';
import { selectorOf } from '../src/decode/abi.ts';
import { hashSafeTx } from '../src/safe/hash.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import type { Observed, ViewCall } from '../src/simulate/effects.ts';
import { EXECUTION_SUCCESS } from '../src/simulate/events.ts';
import { observeExecuted } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';

const SAFE = '0x5afe00000000000000000000000000000000005a' as Address;
const OWNER = '0x0000000000000000000000000000000000000a11' as Address;
const LENDING = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb' as Address;
const ZERO = `0x${'00'.repeat(20)}` as Address;
const TX: SafeTx = {
  chainId: 1n,
  safe: SAFE,
  version: '1.4.1',
  to: '0x1111111111111111111111111111111111111111' as Address,
  value: 0n,
  data: '0x' as Hex,
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: ZERO,
  refundReceiver: ZERO,
  nonce: 7n,
};
const VIEW: ViewCall = { to: LENDING, data: `${selectorOf('position(bytes32,address)')}${'64'.repeat(32)}${SAFE.slice(2).padStart(64, '0')}` as Hex };

const words = (...values: bigint[]): Hex => `0x${values.map((v) => v.toString(16).padStart(64, '0')).join('')}` as Hex;
const PARENT: BlockHeader = { number: 100n, hash: `0x${'aa'.repeat(32)}` as Hex, time: 1_700_000_000n, gasLimit: 36_000_000n, mixHash: `0x${'00'.repeat(32)}` as Hex };
const BLOCK: BlockRef = { number: 101n, hash: `0x${'bb'.repeat(32)}` as Hex };
const SUCCESS = { address: SAFE, topics: [EXECUTION_SUCCESS, hashSafeTx(TX).safeTxHash], data: words(0n) };
const EXEC = selectorOf('execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)');
const agreed = <T>(value: T) => ({ kind: 'agreed', value, providers: ['alchemy', 'drpc'] }) as const;

/** The Safe's own views, as a one-owner Safe with no modules, guard or fallback handler answers them. */
function safeAnswer(data: Hex): Hex {
  if (data.startsWith(selectorOf('getOwners()'))) return words(32n, 1n, BigInt(OWNER));
  if (data.startsWith(selectorOf('getThreshold()'))) return words(1n);
  if (data.startsWith(selectorOf('nonce()'))) return words(TX.nonce);
  if (data.startsWith(selectorOf('getModulesPaginated(address,uint256)'))) return words(64n, 1n, 0n);
  if (data.startsWith(selectorOf('getStorageAt(uint256,uint256)'))) return words(32n, 32n, 0n);
  return assert.fail(`the Safe is not asked ${data.slice(0, 10)}`);
}

/** Answers the simulation call by call; the view gives `before` ahead of the transaction and `after` behind it. */
function simulatingReader(view: { before: SimulatedCall; after: SimulatedCall }, requests: SimulationRequest[]): Reader {
  const unused = () => assert.fail('not read in a simulation');
  return {
    providers: ['alchemy', 'drpc'],
    blockNumber: unused,
    block: unused,
    header: unused,
    getCode: unused,
    getBalance: unused,
    getStorageAt: unused,
    getTransactionReceipt: unused,
    getTransaction: unused,
    call: async (request) => agreed({ kind: 'returned', data: safeAnswer(request.data) }),
    simulateV1: async (request) => {
      requests.push(request);
      const exec = request.calls.findIndex((call) => call.data.startsWith(EXEC));
      return agreed(
        request.calls.map((call, i): SimulatedCall => {
          if (i === exec) return { status: 'success', returnData: words(1n), logs: [SUCCESS] };
          if (call.to === LENDING) return i < exec ? view.before : view.after;
          if (call.to === SAFE) return { status: 'success', returnData: safeAnswer(call.data), logs: [] };
          return { status: 'success', returnData: words(5n), logs: [] };
        }),
      );
    },
  };
}

const returned = (data: Hex): SimulatedCall => ({ status: 'success', returnData: data, logs: [] });
const executed = (observation: Observation): Extract<Observed, { kind: 'executed' }> => {
  assert.equal(observation.kind, 'observed', observation.kind === 'unverifiable' ? observation.reasons.join('; ') : '');
  const { observed } = observation as Extract<Observation, { kind: 'observed' }>;
  assert.equal(observed.kind, 'executed');
  return observed as Extract<Observed, { kind: 'executed' }>;
};

test('a pending transaction reads each view in the measured block, just before and just after it', async () => {
  const requests: SimulationRequest[] = [];
  const reader = simulatingReader({ before: returned(words(100n, 0n, 0n)), after: returned(words(200n, 0n, 0n)) }, requests);
  const observed = executed(await simulateSafeTx(reader, { tx: TX, parent: PARENT, time: PARENT.time + 12n, watch: [], ends: [], views: [VIEW] }));
  assert.deepEqual(observed.views, [{ ...VIEW, before: { kind: 'returned', data: words(100n, 0n, 0n) }, after: { kind: 'returned', data: words(200n, 0n, 0n) } }]);
  const measured = requests[1]?.calls ?? [];
  const exec = measured.findIndex((call) => call.data.startsWith(EXEC));
  assert.deepEqual([measured[exec - 1]?.to, measured.at(-1)?.to], [LENDING, LENDING], 'the view is the last read on each side');
  assert.equal(requests[0]?.calls.some((call) => call.to === LENDING), false, 'the discovery run reads no view');
});

test('a view that reverts in the simulated block is unread, and the balances are still measured', async () => {
  const reader = simulatingReader({ before: returned(words(1n, 0n, 0n)), after: { status: 'reverted', returnData: '0x' as Hex, logs: [] } }, []);
  const observed = executed(await simulateSafeTx(reader, { tx: TX, parent: PARENT, time: PARENT.time + 12n, watch: [], ends: [], views: [VIEW] }));
  assert.deepEqual(observed.views?.[0]?.after, { kind: 'unread', why: 'it reverted in the simulated block' });
  assert.equal(observed.eth, 0n);
});

test('without views the measured block holds only the balance and Safe reads, and the result carries no views', async () => {
  const requests: SimulationRequest[] = [];
  const observed = executed(await simulateSafeTx(simulatingReader({ before: returned('0x' as Hex), after: returned('0x' as Hex) }, requests), { tx: TX, parent: PARENT, time: PARENT.time + 12n, watch: [], ends: [] }));
  assert.equal('views' in observed, false);
  // The ETH balance read and the six Safe reads of a 1.4.1 Safe, on each side of the transaction.
  assert.equal(requests[1]?.calls.length, 7 + 1 + 7);
  assert.equal(requests[1]?.calls.some((call) => call.to === LENDING), false);
});

test('an executed transaction reads each view at the parent block and at the execution block', async () => {
  const at: bigint[] = [];
  const unused = () => assert.fail('not read for a receipt');
  const reader: Reader = {
    providers: ['alchemy', 'drpc'],
    blockNumber: unused,
    header: unused,
    getCode: unused,
    getStorageAt: unused,
    getTransaction: unused,
    simulateV1: unused,
    getTransactionReceipt: async (hash) =>
      agreed({ transactionHash: hash, blockHash: BLOCK.hash, blockNumber: BLOCK.number, transactionIndex: 0n, status: 1, from: OWNER, to: SAFE, contractAddress: null, gasUsed: 1n, logs: [{ ...SUCCESS, logIndex: 0n }] }),
    block: async (tag) => agreed(tag === BLOCK.number ? BLOCK : { number: PARENT.number, hash: PARENT.hash }),
    getBalance: async () => agreed(0n),
    call: async (request, block) => {
      assert.deepEqual(request, VIEW);
      at.push(block.number);
      return block.number === PARENT.number ? agreed({ kind: 'returned', data: words(100n, 0n, 0n) }) : agreed({ kind: 'reverted' });
    },
  };
  const observed = executed(await observeExecuted(reader, `0x${'cc'.repeat(32)}` as Hex, TX, [], [VIEW]));
  assert.deepEqual(at.toSorted(), [PARENT.number, BLOCK.number]);
  assert.deepEqual(observed.views, [{ ...VIEW, before: { kind: 'returned', data: words(100n, 0n, 0n) }, after: { kind: 'unread', why: 'it reverted at block 101' } }]);
});
