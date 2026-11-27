import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { selectorOf } from '../src/decode/abi.ts';
import { MARKET_ENTRY_PARTS, loadRegistry } from '../src/registry.ts';
import type { Registry } from '../src/registry.ts';
import { ReportError, replayInputs, signedEntryNames } from '../src/research/report.ts';
import type { PastTxsSection, Subject } from '../src/research/report.ts';
import { TRACE_ADDRESSES_FILE, outsideAddresses, parseJudgements, requireJudged, traceAddressesText } from '../src/research/trace-addresses.ts';
import type { TracedRun } from '../src/research/trace-addresses.ts';
import type { TraceCall, TracedTx } from '../src/research/trace.ts';
import { checksumAddress } from '../src/safe/types.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { TEMPLATES_DIR, loadTemplate, parseTemplate } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';
import { tempDir } from './fixture-base.ts';
import { runOffline } from './run-offline.ts';

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

const APPROVE = selectorOf('approve(address,uint256)') as Hex;
const routed = (...inner: readonly TraceCall[]): TracedTx => ({ kind: 'traced', hash: hash(1), sender: { kind: 'eoa', address: EOA, call: 0 }, calls: [call(0, EOA, ROUTER, EXECUTE === undefined ? {} : { selector: EXECUTE }), ...inner] });
const fit = (n: number, ...values: readonly Address[]): TracedRun['studies'][number] => ({ kind: 'fit', hash: hash(n), block: 1n, sender: { kind: 'eoa', address: EOA, call: 0 }, paths: [], types: [], values, outside: [], time: undefined });
const runOf = (traces: readonly TracedTx[], studies: TracedRun['studies'] = []): TracedRun => ({ traces, studies });
const outside = (of: typeof template, withRegistry: Registry, ...traces: readonly TracedTx[]) => outsideAddresses(of, withRegistry, [runOf(traces)]);
const lines = (of: typeof template, ...traces: readonly TracedTx[]): string[] => traceAddressesText(of, registry, runOf(traces)).split('\n');

test('every address outside the registry that moves the sender\'s money is found at once, with the call, direction, token, count and an example', () => {
  const found = outside(template, registry, swap(1, POOL), swap(2, POOL), swap(2, POOL), swap(3, SOLVER));
  const moves = (n: number, example: number) => [
    { call: 1, kind: 'transferFrom', direction: 'out', token: USDT, transactions: n, example: hash(example) },
    { call: 1, kind: 'transfer', direction: 'in', token: USDC, transactions: n, example: hash(example) },
  ];
  assert.deepEqual(found, [
    { address: POOL, entry: undefined, moves: moves(2, 1) },
    { address: SOLVER, entry: undefined, moves: moves(1, 3) },
  ]);
  const text = lines(template, swap(1, POOL), swap(3, SOLVER)).join('\n');
  for (const address of [POOL, SOLVER]) assert.ok(text.includes(`${checksumAddress(address)}: outside the registry`));
  assert.match(text, /call 1: usdt paid by the sender in a transferFrom, 1 transaction, e\.g\. 0x0+1/);
});

test('ETH paid by the sender and paid to it names its outside party', () => {
  const tx: TracedTx = { ...swap(1, POOL), kind: 'traced', sender: { kind: 'eoa', address: EOA, call: 0 }, calls: [call(0, EOA, ROUTER, EXECUTE === undefined ? {} : { selector: EXECUTE }), call(1, ROUTER, POOL), call(2, POOL, EOA, { value: '0x1' as Hex })] };
  assert.deepEqual(outside(template, registry, tx), [{ address: POOL, entry: undefined, moves: [{ call: 1, kind: 'eth', direction: 'in', token: 'eth', transactions: 1, example: hash(1) }] }]);
});

test('a registered contract is settled only once an entry the template touches lists it in dependsOn', () => {
  const alone = outside(template, registered('pool', POOL, []), swap(1, POOL));
  assert.deepEqual(alone.map(({ address, entry }) => [address, entry]), [[POOL, 'pool']]);
  assert.deepEqual(outside(template, registered('pool', POOL, ['universal-router-2.1.2']), swap(1, POOL)), []);
});

test('a trace that does not count, or whose money calls the template binds, gives no address', () => {
  assert.deepEqual(outside(template, registry, { kind: 'unverifiable', hash: hash(1), why: 'no trace' }), []);
  const transfer = loadTemplate(ROOT, 'erc20/transfer', registry);
  const pays: TracedTx = { kind: 'traced', hash: hash(1), sender: { kind: 'eoa', address: EOA, call: 0 }, calls: [call(0, EOA, USDC, { selector: TRANSFER, args: [POOL] })] };
  assert.deepEqual(outside(transfer, registry, pays), []);
});

test('the tokens traced on each side of a choice show a sample of one direction, and only where both sides are a choice', () => {
  const covered = (...traces: readonly TracedTx[]): string[] => lines(template, ...traces).filter((line) => /^  paid (by|to) the sender:/.test(line));
  const [out, into] = covered(swap(1, POOL), swap(2, POOL));
  assert.match(out ?? '', /paid by the sender: usdt in 2; in none: .*\busdc\b/);
  assert.match(into ?? '', /paid to the sender: usdc in 2; in none: .*\busdt\b/);
  assert.match(covered(swap(1, POOL), swap(2, POOL, USDC, USDT))[0] ?? '', /paid by the sender: usdc in 1; usdt in 1/);
  const transfer = loadTemplate(ROOT, 'erc20/transfer', registry);
  const pays: TracedTx = { kind: 'traced', hash: hash(1), sender: { kind: 'eoa', address: EOA, call: 0 }, calls: [call(0, EOA, USDC, { selector: TRANSFER, args: [POOL] })] };
  assert.deepEqual(lines(transfer, pays).filter((line) => line !== '').length, 1);
});

test('an approval to the sender, or a call that only reads, delegates or is no plain call, counts as no money moved', () => {
  const covered = lines(template, routed(
    call(1, POOL, USDT, { selector: APPROVE, args: [EOA] }),
    call(1, ROUTER, POOL),
    call(2, POOL, USDC, { type: 'DELEGATECALL', selector: TRANSFER_FROM, args: [EOA, POOL] }),
    call(2, POOL, USDC, { type: 'STATICCALL', selector: TRANSFER, args: [EOA] }),
  )).filter((line) => /the sender:/.test(line));
  assert.equal(covered.length, 2);
  for (const line of covered) assert.match(line, /the sender: in none: /);
  assert.deepEqual(outside(template, registry, routed(call(1, ROUTER, POOL), call(2, POOL, USDT, { selector: APPROVE, args: [EOA] }), call(2, POOL, USDC, { type: 'DELEGATECALL', selector: TRANSFER_FROM, args: [EOA, POOL] }))), []);
});

test('an allowance the sender gives to an outside spender, or spends of an outside owner, names that address', () => {
  const tx = routed(
    call(1, ROUTER, POOL),
    call(2, POOL, EOA),
    call(3, EOA, USDC, { selector: APPROVE, args: [SOLVER] }),
    call(3, EOA, USDC, { selector: TRANSFER_FROM, args: [POOL, SOLVER] }),
  );
  const of = (address: Address) => outside(template, registry, tx).find((found) => found.address === address)?.moves.map(({ kind, direction }) => `${kind} ${direction}`);
  assert.deepEqual(of(SOLVER), ['approve approval', 'transferFrom spent']);
  assert.deepEqual(of(POOL), ['transferFrom spent']);
  assert.match(lines(template, tx).join('\n'), /call 1: usdc approved by the sender/);
});

test('a money call a bound call makes itself adds no move to an address another contract names', () => {
  const tx = routed(
    call(1, ROUTER, USDT, { selector: TRANSFER_FROM, args: [POOL, EOA] }),
    call(1, ROUTER, POOL),
    call(2, POOL, USDT, { selector: TRANSFER_FROM, args: [EOA, POOL] }),
  );
  assert.deepEqual(outside(template, registry, tx).map(({ address, moves }) => [address, moves.map((m) => m.direction)]), [[POOL, ['out']]]);
});

test('a Safe sender and a template of two calls: the call an address is reached from, over both', () => {
  const deposit = loadTemplate(ROOT, 'compound/supply', registry);
  const [approve, supply] = deposit.calls.map((c) => (c.data === 'empty' ? undefined : (c.data.fn.selector as Hex))) as [Hex, Hex];
  const comet = at('compound-v3-cusdcv3');
  const SAFE = `0x${'5a'.repeat(20)}` as Address;
  const tx = (first: Hex): TracedTx => ({
    kind: 'traced',
    hash: hash(1),
    sender: { kind: 'safe', address: SAFE },
    calls: [
      call(0, EOA, SAFE),
      call(1, SAFE, USDC, { selector: first, args: [comet] }),
      call(1, SAFE, comet, { selector: supply }),
      call(2, comet, POOL),
      call(3, POOL, USDC, { selector: TRANSFER_FROM, args: [SAFE, POOL] }),
    ],
  });
  assert.deepEqual(outside(deposit, registry, tx(approve)).map(({ address, moves }) => [address, moves.map((m) => [m.call, m.direction])]), [[POOL, [[2, 'out']]]]);
  const both: TracedTx = {
    ...(tx(approve) as Extract<TracedTx, { kind: 'traced' }>),
    calls: [
      call(0, EOA, SAFE),
      call(1, SAFE, USDC, { selector: approve, args: [comet] }),
      call(2, USDC, POOL),
      call(3, POOL, USDC, { selector: TRANSFER_FROM, args: [SAFE, POOL] }),
      call(1, SAFE, comet, { selector: supply }),
      call(2, comet, POOL),
      call(3, POOL, SOLVER, { selector: TRANSFER_FROM, args: [SAFE, POOL] }),
      call(3, POOL, USDC, { selector: TRANSFER, args: [SAFE] }),
    ],
  };
  assert.deepEqual(outside(deposit, registry, both).find(({ address }) => address === POOL)?.moves.map((m) => [m.call, m.kind, m.token]), [[1, 'transferFrom', USDC], [2, 'transferFrom', SOLVER], [2, 'transfer', USDC]]);
  assert.deepEqual(outside(deposit, registry, tx('0x12345678' as Hex)), []);
  assert.match(lines(deposit, tx('0x12345678' as Hex))[0] ?? '', /nothing found over 0 traced, 1 not counted$/);
});

test('an entry the card of another transaction could name is checked only in a trace whose own calls hold it', () => {
  const other = at('weeth');
  const tx = swap(1, POOL, USDT, other);
  const found = (values: readonly Address[]) => outsideAddresses(template, registry, [runOf([tx], [fit(1, ...values)])]).map(({ address }) => address);
  assert.ok(found([USDT, USDC]).includes(other));
  assert.ok(!found([USDT, other]).includes(other));
  assert.ok(!found([]).includes(other));
});

test('a card field names only the vault the calls hold, with its asset, or the market all of whose parts they hold', () => {
  const vaults = loadTemplate(ROOT, 'fluid/vault-deposit', registry);
  const signed = signedEntryNames(vaults, registry, new Set([at('fluid-fusdc')]));
  assert.deepEqual(['fluid-fusdc', 'usdc', 'fluid-fusdt', 'usdt'].map((name) => signed.has(name)), [true, true, false, false]);
  const markets = loadTemplate(ROOT, 'morpho/market-supply', registry);
  const [one, two] = [...registry.markets.values()];
  assert.ok(one && two);
  const parts = MARKET_ENTRY_PARTS.map((part) => one[part]);
  const onlyTwo = MARKET_ENTRY_PARTS.map((part) => two[part]).filter((entry) => !parts.includes(entry));
  assert.ok(onlyTwo.length > 0);
  const chosen = signedEntryNames(markets, registry, new Set(parts.map((entry) => entry.address)));
  assert.ok(parts.every((entry) => chosen.has(entry.name)) && !onlyTwo.some((entry) => chosen.has(entry.name)));
  const partial = signedEntryNames(markets, registry, new Set([one.loanToken.address]));
  assert.ok([...parts, ...onlyTwo].every((entry) => partial.has(entry.name)));
});

test('a run always says over how many traces nothing was found, and how many do not count', () => {
  const none: TracedTx = { kind: 'unverifiable', hash: hash(1), why: 'no trace' };
  assert.match(lines(template)[0] ?? '', /nothing found over 0 traced, 0 not counted$/);
  assert.match(lines(template, none)[0] ?? '', /nothing found over 0 traced, 1 not counted$/);
  assert.match(traceAddressesText(template, registry, runOf([], [fit(1), fit(2)])), /nothing found over 0 traced, 2 not counted$/m);
  assert.match(lines(template, swap(1, POOL), none)[0] ?? '', /over 1 traced, 0 not counted/);
  assert.match(lines(template, swap(2, POOL), none)[0] ?? '', /over 1 traced, 1 not counted/);
});

const judgement = { judgement: 'not-fixed', reason: 'Each order is settled by another solver.', sources: ['https://example.org/solvers'] };
const subjectIn = (of = template): { readonly root: string; readonly subject: Subject; readonly write: (raw: unknown) => void } => {
  const root = tempDir('kiss-sign-judged-');
  mkdirSync(join(root, 'report'));
  const subject: Subject = { kind: 'template', template: of, docs: [], vault: undefined, shared: new Set(), dir: 'report' };
  return { root, subject, write: (raw) => writeFileSync(join(root, 'report', TRACE_ADDRESSES_FILE), JSON.stringify(raw)) };
};
const sections = (...traces: readonly TracedTx[]) => [{ run: runOf(traces) } as unknown as PastTxsSection];

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
});

test('a judgement of an address no recorded trace names is refused', () => {
  const { root, subject, write } = subjectIn();
  write({ [POOL]: judgement, [SOLVER]: judgement });
  assert.throws(() => requireJudged(root, subject, registry, sections(swap(1, POOL))), (error: Error) => error instanceof ReportError && error.message.includes(`names ${checksumAddress(SOLVER)} as`) && !error.message.includes(checksumAddress(POOL)));
  write({ [POOL]: judgement });
  requireJudged(root, subject, registry, sections(swap(1, POOL)));
});

test('a template that moves money with no counted trace is recorded only with a reason, which one with a trace may not hold', () => {
  const { root, subject, write } = subjectIn();
  const none: TracedTx = { kind: 'unverifiable', hash: hash(1), why: 'no trace' };
  for (const past of [[], sections(), sections(none)]) assert.throws(() => requireJudged(root, subject, registry, past), /no call trace counts \(0 traced, \d not counted\)/);
  write({ untraced: { reason: 'Nobody has made this swap yet.' } });
  for (const past of [[], sections(none)]) requireJudged(root, subject, registry, past);
  write({ untraced: { reason: 'Nobody has made this swap yet.' }, [POOL]: judgement });
  assert.throws(() => requireJudged(root, subject, registry, sections(swap(1, POOL))), /"untraced" is only for/);
  const admin = subjectIn(loadTemplate(ROOT, 'safe/add-owner', registry));
  requireJudged(admin.root, admin.subject, registry, []);
  admin.write({ untraced: { reason: 'x' } });
  assert.throws(() => requireJudged(admin.root, admin.subject, registry, []), /"untraced" is only for/);
  for (const id of ['erc20/transfer', 'uniswap/approve-permit2']) {
    const moves = subjectIn(loadTemplate(ROOT, id, registry));
    assert.throws(() => requireJudged(moves.root, moves.subject, registry, []), /no call trace counts/);
  }
});

test('pnpm report --record refuses before any read while the traces are not settled', () => {
  const run = runOffline('report.ts', ['erc20/transfer', '--record'], 'research', { exchanges: [] }, [], undefined, undefined, ROOT);
  assert.equal(run.status, 2, run.stderr + run.stdout);
  assert.match(run.stderr, /^REFUSED  no call trace counts/m);
  assert.deepEqual(run.written, []);
});

/** A copy of the fixtures' templates and registry with eth/transfer's report recording alone, fetched on `fetched`, and no past transaction. */
function recordedReport(fetched: string): string {
  const root = tempDir('kiss-sign-recorded-');
  for (const dir of [TEMPLATES_DIR, 'registry']) cpSync(join(ROOT, dir), join(root, dir), { recursive: true });
  for (const dir of ['report', 'research']) mkdirSync(join(root, 'testdata', dir), { recursive: true });
  const recording = join('testdata', 'report', 'eth-transfer.json');
  writeFileSync(join(root, recording), JSON.stringify({ ...JSON.parse(readFileSync(join(ROOT, recording), 'utf8')), fetched }));
  return root;
}
const rendered = (root: string) => replayInputs(root, loadRegistry(root), { template: 'eth/transfer' }, undefined as never, undefined as never);

test('a report that judges its traced addresses, or recorded since the rule, is rendered only while they are settled', async () => {
  const before = recordedReport('2026-11-25');
  await assert.rejects(rendered(before), (error: Error) => !(error instanceof ReportError), 'one recorded before the rule with no file goes on to the reads this test leaves out');
  writeFileSync(join(before, TEMPLATES_DIR, 'eth', 'transfer', TRACE_ADDRESSES_FILE), JSON.stringify({ [POOL]: judgement, untraced: { reason: 'x' } }));
  await assert.rejects(rendered(before), (error: Error) => error instanceof ReportError && error.message.includes(`names ${checksumAddress(POOL)} as an address to settle`));
  const since = recordedReport('2026-11-26');
  await assert.rejects(rendered(since), (error: Error) => error instanceof ReportError && /no call trace counts/.test(error.message));
  writeFileSync(join(since, TEMPLATES_DIR, 'eth', 'transfer', TRACE_ADDRESSES_FILE), JSON.stringify({ untraced: { reason: 'Nobody has made it yet.' } }));
  await assert.rejects(rendered(since), (error: Error) => !(error instanceof ReportError), 'a settled one goes on');
});

const REPORT_FOLDER = /^[^/]+\/[^/]+\/(instances\/[^/]+\/)?trace-addresses\.json$/;
function parseCommitted(root: string): void {
  const dir = join(root, TEMPLATES_DIR);
  for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith(TRACE_ADDRESSES_FILE))) {
    assert.match(file, REPORT_FOLDER);
    parseJudgements(file, readFileSync(join(dir, file), 'utf8'));
  }
}

test('every committed trace-addresses.json is a report\'s own and holds only what the AI may write', () => {
  parseCommitted(join(import.meta.dirname, '..'));
  const root = repoWithTestFixtures();
  const planted = join(root, TEMPLATES_DIR, 'erc20', 'transfer', TRACE_ADDRESSES_FILE);
  writeFileSync(planted, JSON.stringify({ [POOL]: judgement }));
  parseCommitted(root);
  writeFileSync(planted, JSON.stringify({ [POOL]: { ...judgement, reason: '' } }));
  assert.throws(() => parseCommitted(root), /reason"?: not a non-empty string/);
});

test('a judgement is refused without a reason, a source or, for a known limit, the change it needs', () => {
  const parse = (value: unknown) => parseJudgements('f.json', JSON.stringify(value));
  const refused = (value: unknown, why: RegExp) => assert.throws(() => parse({ [POOL]: value }), (error: Error) => error instanceof ReportError && why.test(error.message));
  refused({ ...judgement, judgement: 'fine' }, /not-fixed or known-limit/);
  refused({ ...judgement, reason: ' ' }, /reason: not a non-empty string/);
  refused({ ...judgement, reason: 'safe \u202e txet' }, /reason: holds a control or bidirectional character/);
  refused({ ...judgement, reason: 'x'.repeat(601) }, /reason: longer than 600 characters/);
  refused({ ...judgement, sources: [] }, /at least one https URL/);
  refused({ ...judgement, sources: ['http://example.org'] }, /sources\[0\]: not an https URL/);
  refused({ ...judgement, sources: ['https://etherscan.io@example.org/'] }, /sources\[0\]: a URL with a user name or password/);
  const limit = { ...judgement, judgement: 'known-limit' };
  refused(limit, /needs: not a non-empty string/);
  refused({ ...limit, needs: 'a\u0007' }, /needs: holds a control/);
  refused({ ...limit, needs: 'x'.repeat(601) }, /needs: longer than 600/);
  refused({ ...judgement, needs: 'x' }, /"needs" is not a field here/);
  refused({ ...limit, needs: 'x', why: 'x' }, /"why" is not a field here/);
  assert.throws(() => parse({ [checksumAddress(POOL)]: judgement, [POOL]: judgement }), /judged twice/);
  assert.throws(() => parse({ untraced: { reason: '' } }), /reason: not a non-empty string/);
  assert.throws(() => parse({ untraced: { reason: 'x', sources: [] } }), /"sources" is not a field here/);
  assert.throws(() => parse({ '0x1234': judgement }), /^ReportError: f\.json\["0x1234"\]: not a 20-byte hex address$/);
  assert.throws(() => parse({ ['k'.repeat(200)]: judgement }), (error: Error) => error.message === `f.json["${'k'.repeat(80)}"]: not a 20-byte hex address`);
  assert.throws(() => parse([]), /not a JSON object/);
  assert.throws(() => parseJudgements('f.json', '{'), /f\.json: not JSON/);
});
