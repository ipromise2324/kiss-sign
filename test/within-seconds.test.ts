import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Card, ResolvedCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Reader } from '../src/chain/reader.ts';
import { selectorOf } from '../src/decode/abi.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { BlockTimeRead, FieldChain, FieldCheck } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { TemplateError, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { evaluate, keccakText, parseVerdictFile } from '../src/verify/verify.ts';
import type { VerdictFile, VerifyInputs } from '../src/verify/verify.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const load = (dir: string, name: string): string => readFileSync(join(ROOT, 'testdata', dir, `${name}.json`), 'utf8');

type Raw = { calls: { args: { orderUid: { packed: { rule: { eip712: { fields: Record<string, unknown> } } }[] } } }[] };

/** The CoW swap template with `validTo` bound by `rule`, as a test fixture: the shipped template stays as it is. */
function cowWith(rule: unknown, id = 'cow/swap'): Raw {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', id, 'template.json'), 'utf8')) as Raw;
  raw.calls.at(-1)!.args.orderUid.packed[0]!.rule.eip712.fields.validTo = rule;
  return raw;
}

const refusal = (raw: unknown): string => {
  try {
    parseTemplate(raw, registry);
    return 'parsed';
  } catch (error) {
    assert.ok(error instanceof TemplateError);
    return error.message;
  }
};

const VALID_TO = 'calls[0].args.orderUid.packed.digest.eip712.fields.validTo';

test('template load takes withinSeconds only on a number, as a whole number of seconds from 1 to a year', () => {
  assert.equal(refusal(cowWith({ withinSeconds: 604800 })), 'parsed');
  assert.equal(refusal(cowWith({ withinSeconds: 31536000 })), 'parsed');
  for (const bad of [0, -1, 1.5, '600', 31536001, null]) {
    assert.equal(refusal(cowWith({ withinSeconds: bad })), `${VALID_TO}.withinSeconds: a whole number of seconds from 1 to 31536000 (365 days)`, String(bad));
  }
  const receiver = cowWith({ withinSeconds: 600 });
  const fields = receiver.calls.at(-1)!.args.orderUid.packed[0]!.rule.eip712.fields;
  fields.receiver = { withinSeconds: 600 };
  assert.equal(refusal(receiver), 'calls[0].args.orderUid.packed.digest.eip712.fields.receiver: a withinSeconds rule cannot bind a address');
  fields.receiver = { safe: true };
  fields.partiallyFillable = { withinSeconds: 600 };
  assert.equal(refusal(receiver), 'calls[0].args.orderUid.packed.digest.eip712.fields.partiallyFillable: a withinSeconds rule cannot bind a bool');
});

const SAFE = '0x1111111111111111111111111111111111111111' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** A fixture template whose one call takes a deadline as a plain argument. */
const DEADLINE = parseTemplate(
  {
    id: 'test/deadline',
    card: {},
    calls: [{ to: { safe: true }, value: { const: '0' }, function: 'execute(uint256 deadline)', args: { deadline: { withinSeconds: 3600 } } }],
    effects: { gives: [], gets: [] },
  },
  registry,
);

function deadlineTx(deadline: bigint): SafeTx {
  return {
    chainId: 1n,
    safe: SAFE,
    version: '1.4.1',
    to: SAFE,
    value: 0n,
    data: `${selectorOf('execute(uint256)')}${deadline.toString(16).padStart(64, '0')}` as Hex,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: 0n,
  };
}

const resolvedFor = (templates: ReadonlyMap<string, Template>, card: Card, safe: Address): ResolvedCard => {
  const result = resolveCard(card, { templates, registry, addressBook: new Map(), safe });
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
};

const BLOCK: BlockTimeRead = { kind: 'read', number: 24000000n, time: 1_780_000_000n };

test('a plain argument bound by withinSeconds matches up to that many seconds after the block time and is MISMATCH one second later', () => {
  const templates = new Map([[DEADLINE.id, DEADLINE]]);
  const card = resolvedFor(templates, { operations: [{ template: DEADLINE.id, values: {} }] }, SAFE);
  const fields = (deadline: bigint, chain: FieldChain = { blockTime: BLOCK }): FieldCheck => checkTemplateFields(deadlineTx(deadline), card, templates, registry, [], chain);
  assert.deepEqual(fields(1_780_003_600n), { kind: 'match' });
  assert.deepEqual(fields(0n), { kind: 'match' });
  assert.deepEqual(fields(1_780_003_601n), {
    kind: 'mismatch',
    findings: [{ callPath: 'call.execute', arg: 'deadline', bytes: [4, 36], expected: 'at most 1780003600: 3600 seconds after the time of block 24000000, 1780000000', actual: '1780003601' }],
  });
  assert.deepEqual(fields(1_780_003_600n, {}), { kind: 'unverifiable', reasons: ['the time of the block the transaction is judged on: not read'] });
  assert.deepEqual(fields(1_780_003_600n, { blockTime: { kind: 'unread', why: 'the providers disagree' } }), {
    kind: 'unverifiable',
    reasons: ['the time of the block the transaction is judged on: the providers disagree'],
  });
  assert.deepEqual(checkMutations(deadlineTx(1_780_003_600n), card, templates, registry, [], { blockTime: BLOCK }), { kind: 'pass', bound: 3, free: 0 });
});

type Order = Record<string, unknown> & { sellToken: string; buyToken: string; sellAmount: string; buyAmount: string; validTo: number };

test('an order member bound by withinSeconds is MISMATCH past the bound, and the mutation check moves it one second past', () => {
  const fixture = JSON.parse(load('safe-tx', 'cow-swap-usdt'));
  const tx = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
  const order = JSON.parse(load('messages', 'cow-swap-usdt')) as Order;
  const template = parseTemplate(cowWith({ withinSeconds: 600 }), registry);
  const templates = new Map([[template.id, template]]);
  const name = (address: string) => registry.byAddress.get(address.toLowerCase() as Address)!.name;
  const values = { 'sell-token': name(order.sellToken), 'buy-token': name(order.buyToken), 'sell-amount': order.sellAmount, 'min-buy': order.buyAmount };
  const card = resolvedFor(templates, { operations: [{ template: 'cow/swap', values }] }, tx.safe);
  const messages = [load('messages', 'cow-swap-usdt')];
  const at = (seconds: bigint): FieldChain => ({ blockTime: { kind: 'read', number: 1n, time: BigInt(order.validTo) - seconds } });
  assert.deepEqual(checkTemplateFields(tx, card, templates, registry, messages, at(600n)), { kind: 'match' });
  const late = checkTemplateFields(tx, card, templates, registry, messages, at(601n));
  assert.equal(late.kind, 'mismatch');
  assert.deepEqual(
    (late as Extract<FieldCheck, { kind: 'mismatch' }>).findings.map((f) => `${f.arg}: expected ${f.expected}, got ${f.actual}`),
    [`orderUid.digest.validTo: expected at most ${order.validTo - 1}: 600 seconds after the time of block 1, ${order.validTo - 601}, got ${order.validTo}`],
  );
  assert.deepEqual(checkMutations(tx, card, templates, registry, messages, at(600n)), { kind: 'pass', bound: 16, free: 1 });
});

const VERDICT: VerdictFile = parseVerdictFile(JSON.parse(load('verify', 'cow-swap-approve')));

/** The verdict file's inputs with its CoW template's `validTo` bound by `seconds`, approved as so changed. */
function bounded(seconds: number): VerifyInputs {
  const templates = VERDICT.inputs.templates.map((t) => {
    const text = JSON.stringify(cowWith({ withinSeconds: seconds }, t.id));
    return { ...t, text, approved: keccakText(text) };
  });
  return { ...VERDICT.inputs, templates };
}

/** The time and number of the block the recorded transaction ran in, read from the verdict file's own exchanges. */
async function executedBlock(): Promise<{ number: bigint; time: bigint; validTo: bigint }> {
  const reader = replayReader(VERDICT.exchanges);
  const hash = (VERDICT.inputs.tx.json as { transactionHash: Hex }).transactionHash;
  const receipt = await reader.getTransactionReceipt(hash);
  assert.ok(receipt.kind === 'agreed' && receipt.value !== null);
  const block = await reader.block(receipt.value.blockNumber);
  assert.equal(block.kind, 'agreed');
  const header = await reader.header((block as Extract<typeof block, { kind: 'agreed' }>).value);
  assert.equal(header.kind, 'agreed');
  const validTo = BigInt((JSON.parse(VERDICT.inputs.messages![0]!) as Order).validTo);
  return { number: receipt.value.blockNumber, time: (header as Extract<typeof header, { kind: 'agreed' }>).value.time, validTo };
}

test('verify counts from the time of the block an executed order ran in, read from the verdict file alone on replay', async () => {
  const { number, time, validTo } = await executedBlock();
  const exact = Number(validTo - time);
  assert.ok(exact > 1, 'the order expires after its block');
  const fits = await evaluate(bounded(exact), replayReader(VERDICT.exchanges));
  assert.equal(fits.verdict.kind, 'MATCH');
  const late = await evaluate(bounded(exact - 1), replayReader(VERDICT.exchanges));
  assert.equal(late.verdict.kind, 'MISMATCH');
  const fields = late.verdict.kind === 'MISMATCH' ? late.verdict.causes.find((c) => c.check === 'fields') : undefined;
  assert.deepEqual(fields?.details, [`multiSend[1].setPreSignature orderUid.digest.validTo: expected at most ${validTo - 1n}: ${exact - 1} seconds after the time of block ${number}, ${time}, got ${validTo}`]);
});

test('without the block time in the verdict file the field check is UNVERIFIABLE, never MATCH', async () => {
  const { time, validTo } = await executedBlock();
  const headerless = VERDICT.exchanges.filter((e) => e.method !== 'eth_getBlockByHash');
  const { verdict } = await evaluate(bounded(Number(validTo - time)), replayReader(headerless));
  assert.equal(verdict.kind, 'UNVERIFIABLE');
  const fields = verdict.kind === 'UNVERIFIABLE' ? verdict.causes.find((c) => c.check === 'fields') : undefined;
  assert.match(fields?.details[0] ?? '', /^the time of the block the transaction is judged on: /);
});

test('a pending order counts from the time of the latest block verify reads', async () => {
  const { validTo } = await executedBlock();
  const inner = replayReader(VERDICT.exchanges);
  const latest = await inner.block('latest');
  assert.equal(latest.kind, 'agreed');
  const head = (latest as Extract<typeof latest, { kind: 'agreed' }>).value;
  const time = validTo - 3600n;
  const reader: Reader = {
    ...inner,
    header: async (at) => (at.hash === head.hash ? { kind: 'agreed', providers: inner.providers, value: { ...head, time, gasLimit: 30_000_000n, mixHash: `0x${'00'.repeat(32)}` as Hex } } : inner.header(at)),
  };
  const pending = (seconds: number): VerifyInputs => {
    const inputs = bounded(seconds);
    return { ...inputs, tx: { ...inputs.tx, json: { ...(inputs.tx.json as object), isExecuted: false, transactionHash: null } } };
  };
  const late = await evaluate(pending(3599), reader);
  assert.equal(late.verdict.kind, 'MISMATCH');
  const fields = late.verdict.kind === 'MISMATCH' ? late.verdict.causes.find((c) => c.check === 'fields') : undefined;
  assert.deepEqual(fields?.details, [`multiSend[1].setPreSignature orderUid.digest.validTo: expected at most ${validTo - 1n}: 3599 seconds after the time of block ${head.number}, ${time}, got ${validTo}`]);
  const fits = await evaluate(pending(3600), reader);
  const causes = fits.verdict.kind === 'MATCH' ? [] : fits.verdict.causes.map((c) => c.check);
  assert.ok(!causes.includes('fields'), causes.join(', '));
});
