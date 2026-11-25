import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { selectorOf } from '../src/decode/abi.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Registry } from '../src/registry.ts';
import type { PastTxsSection, Subject } from '../src/research/report.ts';
import { TRACE_ADDRESSES_FILE, outsideAddresses, parseJudgements, requireJudged, tokenCoverageLines, traceAddressesText } from '../src/research/trace-addresses.ts';
import type { TraceCall, TracedTx } from '../src/research/trace.ts';
import { checksumAddress } from '../src/safe/types.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { loadTemplate } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, 'uniswap/swap', registry);
const at = (name: string): Address => registry.entries.get(name)?.address as Address;
const [ROUTER, USDC, USDT] = [at('universal-router-2.1.2'), at('usdc'), at('usdt')];
const EOA = `0x${'e0'.repeat(20)}` as Address;
const [POOL, SOLVER] = [`0x${'b0'.repeat(20)}` as Address, `0x${'50'.repeat(20)}` as Address];
const EXECUTE = template.calls[0]?.data !== 'empty' ? (template.calls[0]?.data.fn.selector as Hex) : undefined;
const TRANSFER = selectorOf('transfer(address,uint256)') as Hex;
const TRANSFER_FROM = selectorOf('transferFrom(address,address,uint256)') as Hex;

const call = (depth: number, from: Address, to: Address, extra: Partial<TraceCall> = {}): TraceCall => ({ depth, type: 'CALL', from, to, ...extra });
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
/** A swap whose router asks `pool` to pull the sold token from the sender and pay the bought one. */
const swap = (n: number, pool: Address, sell = USDT, buy = USDC): TracedTx => ({
  kind: 'traced',
  hash: hash(n),
  sender: { kind: 'eoa', address: EOA, call: 0 },
  calls: [
    call(0, EOA, ROUTER, EXECUTE === undefined ? {} : { selector: EXECUTE }),
    call(1, ROUTER, pool),
    call(2, pool, sell, { selector: TRANSFER_FROM, args: [EOA, pool] }),
    call(2, pool, buy, { selector: TRANSFER, args: [EOA] }),
  ],
});
const registered = (name: string, address: Address, dependents: readonly string[]): Registry => {
  const entry = { ...registry.entries.get('permit2')!, name, address };
  const entries = new Map([...registry.entries, [name, entry] as const].map(([key, e]) => [key, dependents.includes(key) ? { ...e, dependsOn: [...(e.dependsOn ?? []), name] } : e] as const));
  return { ...registry, entries, byAddress: new Map([...entries.values()].map((e) => [e.address, e] as const)) };
};

test('every address outside the registry that moves the sender\'s money is found at once, with the call, direction, token, count and an example', () => {
  const found = outsideAddresses(template, registry, [swap(1, POOL), swap(2, POOL), swap(2, POOL), swap(3, SOLVER)]);
  const moves = (n: number, example: number) => [
    { call: 1, kind: 'transferFrom', direction: 'out', token: USDT, transactions: n, example: hash(example) },
    { call: 1, kind: 'transfer', direction: 'in', token: USDC, transactions: n, example: hash(example) },
  ];
  assert.deepEqual(found, [
    { address: POOL, entry: undefined, moves: moves(2, 1) },
    { address: SOLVER, entry: undefined, moves: moves(1, 3) },
  ]);
  const text = traceAddressesText(template, registry, [swap(1, POOL), swap(3, SOLVER)]);
  for (const address of [POOL, SOLVER]) assert.ok(text.includes(`${checksumAddress(address)}: outside the registry`));
  assert.match(text, /call 1: usdt paid by the sender in a transferFrom, 1 transaction, e\.g\. 0x0+1/);
});

test('ETH paid by the sender and paid to it names its outside party', () => {
  const tx: TracedTx = { ...swap(1, POOL), kind: 'traced', sender: { kind: 'eoa', address: EOA, call: 0 }, calls: [call(0, EOA, ROUTER, EXECUTE === undefined ? {} : { selector: EXECUTE }), call(1, ROUTER, POOL), call(2, POOL, EOA, { value: '0x1' as Hex })] };
  assert.deepEqual(outsideAddresses(template, registry, [tx]), [{ address: POOL, entry: undefined, moves: [{ call: 1, kind: 'eth', direction: 'in', token: 'eth', transactions: 1, example: hash(1) }] }]);
});

test('a registered contract is settled only once an entry the template touches lists it in dependsOn', () => {
  const alone = outsideAddresses(template, registered('pool', POOL, []), [swap(1, POOL)]);
  assert.deepEqual(alone.map(({ address, entry }) => [address, entry]), [[POOL, 'pool']]);
  assert.deepEqual(outsideAddresses(template, registered('pool', POOL, ['universal-router-2.1.2']), [swap(1, POOL)]), []);
});

test('a trace that does not count, or whose money calls the template binds, gives no address', () => {
  assert.deepEqual(outsideAddresses(template, registry, [{ kind: 'unverifiable', hash: hash(1), why: 'no trace' }]), []);
  const transfer = loadTemplate(ROOT, 'erc20/transfer', registry);
  const pays: TracedTx = { kind: 'traced', hash: hash(1), sender: { kind: 'eoa', address: EOA, call: 0 }, calls: [call(0, EOA, USDC, { selector: TRANSFER, args: [POOL] })] };
  assert.deepEqual(outsideAddresses(transfer, registry, [pays]), []);
});

test('the tokens traced on each side of a choice show a sample of one direction', () => {
  const [, out, into] = tokenCoverageLines(template, registry, [swap(1, POOL), swap(2, POOL)]);
  assert.match(out ?? '', /paid by the sender: usdt in 2; in none: .*\busdc\b/);
  assert.match(into ?? '', /paid to the sender: usdc in 2; in none: .*\busdt\b/);
  const both = tokenCoverageLines(template, registry, [swap(1, POOL), swap(2, POOL, USDC, USDT)]);
  assert.match(both[1] ?? '', /paid by the sender: usdc in 1; usdt in 1/);
});

const judgement = { judgement: 'not-fixed', reason: 'Each order is settled by another solver.', sources: ['https://example.org/solvers'] };
const subjectIn = (): { readonly root: string; readonly subject: Subject; readonly write: (raw: unknown) => void } => {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-judged-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'report'));
  const subject: Subject = { kind: 'template', template, docs: [], vault: undefined, dir: 'report' };
  return { root, subject, write: (raw) => writeFileSync(join(root, 'report', TRACE_ADDRESSES_FILE), JSON.stringify(raw)) };
};
const sections = (...traces: readonly TracedTx[]) => [{ run: { traces } } as unknown as PastTxsSection];

test('a report is refused while any address is unjudged, naming all of them, and recorded once each is judged', () => {
  const { root, subject, write } = subjectIn();
  const past = sections(swap(1, POOL), swap(2, SOLVER));
  const refusal = (): string => {
    try {
      requireJudged(root, subject, registry, past);
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail('not refused');
  };
  const none = refusal();
  for (const address of [POOL, SOLVER]) assert.ok(none.includes(checksumAddress(address)));
  write({ [checksumAddress(SOLVER)]: judgement });
  assert.ok(refusal().includes(checksumAddress(POOL)) && !refusal().includes(checksumAddress(SOLVER)));
  write({ [SOLVER]: judgement, [POOL]: { ...judgement, judgement: 'known-limit', needs: 'A rule that names the pool from the card.' } });
  requireJudged(root, subject, registry, past);
  write({ [USDC]: judgement });
  assert.throws(() => requireJudged(root, subject, registry, sections()), /is usdc, whose code verify checks; delete its judgement/);
});

test('a judgement is refused without a reason, a source or, for a known limit, the change it needs', () => {
  const refused = (value: unknown, why: RegExp) => assert.throws(() => parseJudgements('f.json', { [POOL]: value }), why);
  refused({ ...judgement, judgement: 'fine' }, /not-fixed or known-limit/);
  refused({ ...judgement, reason: ' ' }, /reason is not a non-empty string/);
  refused({ ...judgement, sources: [] }, /at least one https URL/);
  refused({ ...judgement, sources: ['http://example.org'] }, /not an https URL/);
  refused({ ...judgement, judgement: 'known-limit' }, /needs is not a non-empty string/);
  refused({ ...judgement, needs: 'x' }, /"needs" is not a field of a not-fixed judgement/);
  assert.throws(() => parseJudgements('f.json', { [checksumAddress(POOL)]: judgement, [POOL]: judgement }), /judged twice/);
  assert.throws(() => parseJudgements('f.json', { '0x1234': judgement }), /not a 20-byte hex address/);
});
