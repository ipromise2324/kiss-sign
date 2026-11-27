import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard, resolveCard } from '../src/card.ts';
import { headerHash } from '../src/chain/header-hash.ts';
import { replayReader } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import { inspectTemplateFields } from '../src/template/check.ts';
import { judgeFixtures, replayPerturbRecording } from '../src/template/perturb.ts';
import type { FixtureJudgement } from '../src/template/perturb.ts';
import { parseTemplate } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const registry = loadRegistry(ROOT);
const NAME = 'uniswap-swap-permit-usdc-usdt';
const recording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'perturb', `${NAME}.json`), 'utf8'));

type Raw = { calls: { args: { deadline: unknown } }[] };

/** The fixture template uniswap/swap-permit with its `deadline` bound by `withinSeconds`. */
function swapWithin(seconds: bigint) {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'uniswap', 'swap-permit', 'template.json'), 'utf8')) as Raw;
  raw.calls.at(-1)!.args.deadline = { withinSeconds: Number(seconds) };
  return parseTemplate(raw, registry, 'committed');
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

type Block = Record<string, unknown> & { hash: string; timestamp: string };
type Recorded = { executed: { hash: string }; parent: { hash: string }; exchanges: { method: string; params: unknown[]; answers: Record<string, Block> }[] };

/** Replays `recording`, as edited, from a copy of the repository whose only perturb recording it is. */
function replayEdited(edit: (raw: Recorded) => void) {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-perturb-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['templates', 'registry']) symlinkSync(join(ROOT, dir), join(root, dir));
  mkdirSync(join(root, 'testdata', 'perturb'), { recursive: true });
  symlinkSync(join(ROOT, 'testdata', 'safe-tx'), join(root, 'testdata', 'safe-tx'));
  const raw = structuredClone(recording) as Recorded;
  edit(raw);
  writeFileSync(join(root, 'testdata', 'perturb', `${NAME}.json`), JSON.stringify(raw));
  return replayPerturbRecording(root, NAME, registry);
}

const executedBlocks = (raw: Recorded): Block[] =>
  raw.exchanges.filter((e) => e.method === 'eth_getBlockByHash' && e.params[0] === raw.executed.hash).flatMap((e) => Object.values(e.answers));
const later = (block: Block) => `0x${(BigInt(block.timestamp) + 1n).toString(16)}`;

test('a perturb recording replays from a copy of the repository as it was recorded', async () => {
  assert.equal((await replayEdited(() => {})).kind, 'pass');
});

test("a perturb recording whose executed block's time was edited is refused: the header no longer hashes to its hash", async () => {
  await assert.rejects(
    replayEdited((raw) => {
      for (const block of executedBlocks(raw)) block.timestamp = later(block);
    }),
    new RegExp(`perturb/${NAME}\\.json: \\w+'s block ${recording.executed.number} does not hash to its hash ${recording.executed.hash}`),
  );
});

test('a perturb recording whose executed block was rebuilt, with a later time and its new hash, is refused: its fixture gives another time', async () => {
  await assert.rejects(
    replayEdited((raw) => {
      const [block] = executedBlocks(raw);
      const forged = { ...block!, timestamp: later(block!) };
      forged.hash = headerHash(forged);
      for (const e of raw.exchanges) {
        if (e.params[0] === raw.executed.hash) e.params[0] = forged.hash;
        for (const [provider, answer] of Object.entries(e.answers)) if (answer?.hash === raw.executed.hash) e.answers[provider] = forged;
      }
      raw.executed.hash = forged.hash;
    }),
    /has time \d+; its fixture says the transaction ran in block \d+ at time \d+/,
  );
});

test('a perturb recording whose parent block was rebuilt, with another gas limit and its new hash, is refused: the executed block names another parent', async () => {
  await assert.rejects(
    replayEdited((raw) => {
      const block = raw.exchanges.flatMap((e) => Object.values(e.answers)).find((answer) => answer?.hash === raw.parent.hash)!;
      const forged = { ...block, gasLimit: `0x${(BigInt(block.gasLimit as string) + 1n).toString(16)}` };
      forged.hash = headerHash(forged);
      for (const e of raw.exchanges) {
        e.params = JSON.parse(JSON.stringify(e.params).replaceAll(raw.parent.hash, forged.hash));
        for (const [provider, answer] of Object.entries(e.answers)) if (answer?.hash === raw.parent.hash) e.answers[provider] = forged;
      }
      raw.parent.hash = forged.hash;
    }),
    new RegExp(`block ${recording.executed.number} does not name the recorded parent 0x[0-9a-f]{64}`),
  );
});

test('a perturb recording that holds another block at its parent height is refused, even where the replay does not read it', async () => {
  let forgedHash = '';
  await assert.rejects(
    replayEdited((raw) => {
      for (const e of raw.exchanges.filter((e) => e.method === 'eth_getBlockByNumber')) {
        for (const [provider, answer] of Object.entries(e.answers)) {
          if (answer?.hash !== raw.parent.hash) continue;
          const forged = { ...answer, gasLimit: `0x${(BigInt(answer.gasLimit as string) + 1n).toString(16)}` };
          forged.hash = forgedHash = headerHash(forged);
          e.answers[provider] = forged;
        }
      }
    }),
    (error: Error) => error.message.endsWith(`block ${recording.parent.number} is recorded with hash ${recording.parent.hash}, not ${forgedHash}`),
  );
});
