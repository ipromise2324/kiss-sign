import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard, resolveCard } from '../src/card.ts';
import { replayReader } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import { inspectTemplateFields } from '../src/template/check.ts';
import { judgeFixtures } from '../src/template/perturb.ts';
import type { FixtureJudgement } from '../src/template/perturb.ts';
import { parseTemplate } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const NAME = 'uniswap-swap-usdc-usdt';
const recording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'perturb', `${NAME}.json`), 'utf8'));

type Raw = { calls: { args: { deadline: unknown } }[] };

/** The Uniswap swap template with its `deadline` bound by `withinSeconds`, as a test fixture: the shipped template stays free. */
function swapWithin(seconds: bigint) {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'uniswap', 'swap', 'template.json'), 'utf8')) as Raw;
  raw.calls.at(-1)!.args.deadline = { withinSeconds: Number(seconds) };
  return parseTemplate(raw, registry);
}

async function executedTime(): Promise<bigint> {
  const read = await replayReader(recording.exchanges).header({ number: BigInt(recording.executed.number), hash: recording.executed.hash });
  assert.equal(read.kind, 'agreed');
  return (read as Extract<typeof read, { kind: 'agreed' }>).value.time;
}

function deadline(): bigint {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${recording.safeTx}.json`), 'utf8'));
  const tx = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
  const template = swapWithin(31_536_000n);
  const templates = new Map([[template.id, template]]);
  const resolution = resolveCard(parseCard(recording.card), { templates, registry, addressBook: new Map(), safe: tx.safe });
  assert.equal(resolution.kind, 'resolved');
  const { leaves } = inspectTemplateFields(tx, (resolution as Extract<typeof resolution, { kind: 'resolved' }>).card, templates, registry, [], {
    blockTime: { kind: 'read', number: 0n, time: 0n },
  });
  const [start, end] = leaves.find((leaf) => leaf.arg === 'deadline')!.bytes!;
  return BigInt(`0x${Buffer.from(tx.data.slice(2), 'hex').subarray(start, end).toString('hex')}`);
}

const judged = async (seconds: bigint): Promise<FixtureJudgement['outcome']> =>
  (await judgeFixtures(ROOT, swapWithin(seconds), registry)).find((j) => j.name === recording.safeTx)!.outcome;

test('a recorded fixture with a withinSeconds field is perturbed and mutated, counting from the time of the block it ran in', async () => {
  const seconds = deadline() - (await executedTime());
  assert.ok(seconds > 0n);
  const exact = await judged(seconds);
  assert.equal(exact.kind, 'judged');
  const { mutations, perturbation } = exact as Extract<FixtureJudgement['outcome'], { kind: 'judged' }>;
  assert.equal(mutations.kind, 'pass');
  assert.equal(perturbation.kind, 'pass');
});

test('a recorded fixture whose withinSeconds field is one second past its bound is not perturbed: its fields give mismatch', async () => {
  const seconds = deadline() - (await executedTime());
  const late = await judged(seconds - 1n);
  assert.equal(late.kind, 'judged');
  const { mutations, perturbation } = late as Extract<FixtureJudgement['outcome'], { kind: 'judged' }>;
  assert.equal(mutations.kind, 'not-run');
  assert.deepEqual(perturbation, { kind: 'not-run', cause: 'fields', reason: "the transaction's fields give mismatch" });
});
