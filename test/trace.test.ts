import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Receipt } from '../src/chain/types.ts';
import { selectorOf } from '../src/decode/abi.ts';
import { loadRegistry } from '../src/registry.ts';
import { flowResults, stateOf, strip } from '../src/research/ledger.ts';
import { TraceError, compareFlow, holdingTemplateCalls, parseRecordedTrace, tokenStepsDisagree, trimTrace } from '../src/research/trace.ts';
import type { FlowLine, TraceCall, TracedTx } from '../src/research/trace.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { loadTemplate } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, 'morpho/market-supply', registry);
const at = (name: string): Address => registry.entries.get(name)?.address.toLowerCase() as Address;
const [USDC, BUNDLES, MORPHO] = [at('usdc'), at('blue-bundles-v1'), at('morpho-blue')];
const SAFE = `0x${'5a'.repeat(20)}` as Address;
const EOA = `0x${'e0'.repeat(20)}` as Address;
const SUPPLY = selectorOf('supply((address,address,address,address,uint256),uint256,uint256,address,bytes)');
const word = (a: Address): string => a.slice(2).padStart(64, '0');

const call = (depth: number, type: TraceCall['type'], from: Address, to: Address, selector?: string, args?: Address[], value?: Hex): TraceCall => ({
  depth,
  type,
  from,
  to,
  ...(selector === undefined ? {} : { selector: selector as Hex }),
  ...(args === undefined ? {} : { args }),
  ...(value === undefined ? {} : { value }),
});

/** A market supply as a Safe sends it: approve, then the bundle that pulls the USDC and supplies it to Morpho. */
const supply = (morphoPulls = true): TraceCall[] => [
  call(0, 'CALL', EOA, SAFE, '0x6a761202'),
  call(1, 'DELEGATECALL', SAFE, `0x${'51'.repeat(20)}` as Address, '0x6a761202'),
  call(2, 'DELEGATECALL', SAFE, `0x${'4d'.repeat(20)}` as Address, '0x8d80ff0a'),
  call(3, 'CALL', SAFE, USDC, '0x095ea7b3', [BUNDLES]),
  call(3, 'CALL', SAFE, BUNDLES, template.calls[1]?.data !== 'empty' ? template.calls[1]?.data.fn.selector : undefined),
  call(4, 'CALL', BUNDLES, USDC, '0x23b872dd', [SAFE, BUNDLES]),
  call(4, 'CALL', BUNDLES, USDC, '0x095ea7b3', [MORPHO]),
  call(4, 'CALL', BUNDLES, MORPHO, SUPPLY),
  ...(morphoPulls ? [call(5, 'CALL', MORPHO, USDC, '0x23b872dd', [BUNDLES, MORPHO])] : []),
];
const traced = (hash: string, calls: readonly TraceCall[]): Extract<TracedTx, { kind: 'traced' }> => ({ kind: 'traced', hash: hash as Hex, sender: { kind: 'safe', address: SAFE }, calls });
const LINE: FlowLine = { after: 2, from: 'blue-bundles-v1', to: 'morpho-blue', selector: SUPPLY };

test('a callTracer answer is cut down to depth, type, from, to, selector, value, reverted and a token call\'s addresses', () => {
  const answer = {
    type: 'CALL',
    from: EOA.toUpperCase().replace('0X', '0x'),
    to: SAFE,
    input: '0x6a761202',
    value: '0x0',
    gas: '0x1',
    output: '0x',
    calls: [
      { type: 'CALL', from: SAFE, to: USDC, input: `0x23b872dd${word(SAFE)}${word(BUNDLES)}${'00'.repeat(32)}`, value: '0x10', output: '0x01' },
      { type: 'STATICCALL', from: SAFE, to: USDC, input: '0x', error: 'execution reverted' },
    ],
  };
  assert.deepEqual(trimTrace(answer), [
    { depth: 0, type: 'CALL', from: EOA, to: SAFE, selector: '0x6a761202' },
    { depth: 1, type: 'CALL', from: SAFE, to: USDC, selector: '0x23b872dd', value: '0x10', args: [SAFE, BUNDLES] },
    { depth: 1, type: 'STATICCALL', from: SAFE, to: USDC, reverted: true },
  ]);
  assert.throws(() => trimTrace({ ...answer, type: 'JUMP' }), TraceError);
  const failedCreate = { type: 'CREATE2', from: SAFE, input: '0x00', error: 'execution reverted' };
  assert.deepEqual(trimTrace({ ...answer, calls: [failedCreate] }).at(-1), { depth: 1, type: 'CREATE2', from: SAFE, reverted: true }, 'a failed create names no address');
});

test('a recorded trace is refused when its calls do not nest or hold a field the recording never writes', () => {
  const hash = `0x${'ab'.repeat(32)}`;
  assert.deepEqual(parseRecordedTrace({ hash, calls: supply() }, 'traces[0]'), { hash, calls: supply() });
  assert.deepEqual(parseRecordedTrace({ hash, unreadable: 'trace.to: not an address' }, 'traces[0]'), { hash, unreadable: 'trace.to: not an address' });
  assert.throws(() => parseRecordedTrace({ hash, calls: [{ ...call(0, 'CALL', SAFE, USDC), value: '0x0' }] }, 'traces[0]'), /zero, which a recording never writes/);
  assert.throws(() => parseRecordedTrace({ hash, calls: [call(1, 'CALL', SAFE, USDC)] }, 'traces[0]'), /not one call tree/);
  assert.throws(() => parseRecordedTrace({ hash, calls: [{ ...call(0, 'CALL', SAFE, USDC), input: '0x' }] }, 'traces[0]'), /input is not a field/);
});

const log = (token: Address, topic: string, from: Address, to: Address): Receipt['logs'][number] => ({ address: token, topics: [topic as Hex, `0x${word(from)}` as Hex, `0x${word(to)}` as Hex], data: '0x' as Hex, logIndex: 0n });
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const receipt = (logs: Receipt['logs']): Receipt => ({ transactionHash: `0x${'01'.repeat(32)}` as Hex, blockHash: `0x${'02'.repeat(32)}` as Hex, blockNumber: 1n, transactionIndex: 0n, status: 1, from: EOA, to: SAFE, contractAddress: null, gasUsed: 0n, logs });
const supplyLogs = [log(USDC, APPROVAL, SAFE, BUNDLES), log(USDC, TRANSFER, SAFE, BUNDLES), log(USDC, APPROVAL, BUNDLES, MORPHO), log(USDC, TRANSFER, BUNDLES, MORPHO)];

test("a trace's token steps must match the receipt's logs both ways", () => {
  const tokens = new Set([USDC]);
  assert.equal(tokenStepsDisagree(supply(), receipt(supplyLogs), tokens), undefined);
  assert.match(tokenStepsDisagree(supply(), receipt(supplyLogs.slice(0, 3)), tokens) ?? '', /the trace holds a transfer of .* the receipt does not log/);
  assert.match(tokenStepsDisagree(supply(false), receipt(supplyLogs), tokens) ?? '', /the receipt logs a transfer of .* with no call in the trace/);
  assert.equal(tokenStepsDisagree(supply(), receipt([...supplyLogs, log(USDC, TRANSFER, `0x${'00'.repeat(20)}` as Address, SAFE)]), tokens), undefined, 'a mint has no call');
  assert.match(tokenStepsDisagree(supply(), receipt([...supplyLogs, log(USDC, APPROVAL, SAFE, MORPHO)]), tokens) ?? '', /the receipt logs an approval of .* with no approve, transferFrom or permit in the trace/);
  assert.equal(tokenStepsDisagree(supply(), receipt([...supplyLogs, log(USDC, APPROVAL, SAFE, BUNDLES)]), tokens), undefined, 'a token may log an Approval when transferFrom spends the allowance');
  const permitted = [...supply(), call(4, 'CALL', BUNDLES, USDC, '0xd505accf', [SAFE, MORPHO])];
  assert.equal(tokenStepsDisagree(permitted, receipt([...supplyLogs, log(USDC, APPROVAL, SAFE, MORPHO)]), tokens), undefined, 'a permit sets the allowance it logs');
});

test('a flow line is confirmed in N of M traced transactions, and a money call no line covers is a finding', () => {
  const both = [traced('0x01', supply()), traced('0x02', supply())];
  assert.deepEqual(compareFlow(template, registry, [LINE], both), { lines: [{ seen: 2, of: 2 }], uncovered: [] });
  assert.deepEqual(
    flowResults(compareFlow(template, registry, [LINE], both)).map((r) => [r.id, r.finding.kind]),
    [['flow.1', 'agrees']],
  );

  const elsewhere = supply().map((c) => (c.selector === SUPPLY ? { ...c, selector: '0x12345678' as Hex } : c));
  const partly = compareFlow(template, registry, [LINE], [traced('0x01', supply()), traced('0x02', elsewhere)]);
  assert.deepEqual(partly.lines, [{ seen: 1, of: 2 }]);
  assert.deepEqual(partly.uncovered, [{ call: 2, from: 'morpho-blue', to: 'usdc', kind: 'transferFrom', transactions: 1, others: [] }], "Morpho's pull is explained only where the line was seen");
  assert.deepEqual(
    flowResults(partly).map((r) => [r.id, r.finding.kind]),
    [
      ['flow.1', 'line-partly-seen'],
      ['trace.2.morpho-blue.usdc.transferFrom', 'money-uncovered'],
    ],
  );

  const noLine = compareFlow(template, registry, [], both);
  assert.deepEqual(noLine.uncovered, [{ call: 2, from: 'morpho-blue', to: 'usdc', kind: 'transferFrom', transactions: 2, others: [] }]);
});

test('a line seen nowhere is red, one seen in some and a money call no line covers amber, and each counts on the 呼叫追蹤 line', () => {
  const nowhere = supply().map((c) => (c.selector === SUPPLY ? { ...c, selector: '0x12345678' as Hex } : c));
  const results = flowResults(compareFlow(template, registry, [LINE], [traced('0x01', nowhere)]));
  assert.deepEqual(results.map((r) => [r.id, r.finding.kind, stateOf(r)]), [
    ['flow.1', 'line-not-seen', 'bad'],
    ['trace.2.morpho-blue.usdc.transferFrom', 'money-uncovered', 'warn'],
  ]);
  assert.deepEqual(strip({ entries: [], results }).find((s) => s.line === 'trace'), { line: 'trace', state: 'bad', passed: 0, counted: 2 });
});

test('with no traced transaction no line is compared, and a line with no function is never compared', () => {
  assert.deepEqual(flowResults(compareFlow(template, registry, [LINE], [])), []);
  assert.deepEqual(
    flowResults(compareFlow(template, registry, [{ ...LINE, selector: undefined }], [traced('0x01', supply())])).map((r) => r.id),
    ['trace.2.morpho-blue.usdc.transferFrom'],
  );
});

test('ETH sent inside a call is a money call, and a delegation is no step between a covered call and its child', () => {
  const eth = [...supply(), call(5, 'DELEGATECALL', MORPHO, `0x${'77'.repeat(20)}` as Address, '0xabcdef01'), call(6, 'CALL', MORPHO, SAFE, undefined, undefined, '0x1' as Hex)];
  assert.deepEqual(compareFlow(template, registry, [LINE], [traced('0x01', eth)]).uncovered, []);
  const deep = [...supply(), call(5, 'CALL', MORPHO, `0x${'77'.repeat(20)}` as Address, '0xabcdef01'), call(6, 'CALL', `0x${'77'.repeat(20)}` as Address, SAFE, undefined, undefined, '0x1' as Hex)];
  assert.deepEqual(compareFlow(template, registry, [LINE], [traced('0x01', deep)]).uncovered, [{ call: 2, from: 'other', to: 'safe', kind: 'eth', transactions: 1, others: [`0x${'77'.repeat(20)}`] }]);
});

test('a trace nested deeper than the EVM allows is no trace, and a recording cannot hold one', () => {
  let frame: Record<string, unknown> = { type: 'CALL', from: SAFE, to: USDC, input: '0x' };
  for (let i = 0; i < 1100; i++) frame = { type: 'CALL', from: SAFE, to: USDC, input: '0x', calls: [frame] };
  assert.throws(() => trimTrace(frame), (e: unknown) => e instanceof TraceError && /deeper than the 1024 nested calls/.test(e.message));
  const deep = Array.from({ length: 1026 }, (_, depth) => call(depth, 'CALL', SAFE, USDC));
  assert.throws(() => parseRecordedTrace({ hash: `0x${'ab'.repeat(32)}`, calls: deep }, 'traces[0]'), TraceError);
});

test("a traced transaction whose trace does not hold the template's calls in order is UNVERIFIABLE with why, not left out", () => {
  const withoutSupply = supply().filter((c) => !(c.from === SAFE && c.to === BUNDLES));
  assert.deepEqual(holdingTemplateCalls(template, registry, traced('0x01', withoutSupply)), { kind: 'unverifiable', hash: '0x01', why: "the trace does not hold the template's calls in order" });
  assert.equal(holdingTemplateCalls(template, registry, traced('0x01', supply())).kind, 'traced');
});
