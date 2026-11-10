import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { replayTransport } from '../src/chain/recording.ts';
import type { Transport } from '../src/chain/rpc.ts';
import { history } from '../src/history/history.ts';
import type { VerdictFile } from '../src/verify/verify.ts';

const ROOT = join(import.meta.dirname, '..');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const deposit: VerdictFile = readJson(join(ROOT, 'testdata', 'verify', 'morpho-vault-deposit.json'));
const records = (name: string) =>
  readFileSync(join(ROOT, 'testdata', 'history', `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const ENV = { ALCHEMY_API_KEY: 'test-key' };
const DEPOSIT_CARD = { operations: [{ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc', amount: '1800000000180' } }] };
const MARKS = [{ at: 'operations[0].values.amount', note: 'taken from the transaction' }];

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A clone whose origin/main holds this repository's template and registry, and a home holding one Safe's history. */
function setUp(name: string, cards: Record<number, unknown> = {}, notes: Record<string, unknown> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'kiss-sign-history-'));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(base, 'clone', '--quiet', origin, repo);
  for (const path of ['templates/morpho/vault-deposit/template.json', 'registry/contracts.json']) {
    write(join(repo, path), readFileSync(join(ROOT, path), 'utf8'));
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'templates');
  git(repo, 'push', '--quiet', 'origin', 'main');
  const txs = records(name);
  const home = join(base, 'home');
  write(join(home, 'config.json'), JSON.stringify({ chainId: 1, safe: txs[0]!.safe }));
  write(join(home, 'history', 'txs.jsonl'), txs.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const intents = txs.map((r) => ({ nonce: r.nonce, date: String(r.executionDate).slice(0, 10), app: '', intent: `intent of nonce ${r.nonce}`, hash: r.transactionHash }));
  write(join(home, 'history', 'intents.json'), JSON.stringify(intents));
  write(join(home, 'history', 'notes.json'), JSON.stringify(notes));
  for (const [nonce, card] of Object.entries(cards)) write(join(home, 'history', 'cards', `${nonce}.json`), JSON.stringify(card));
  return { base, repo, home };
}

const OFFLINE: Transport = async () => assert.fail('this run must read the chain from the cache');

/** Runs the harness; chain answers come from the recorded deposit unless `transport` says otherwise. */
async function run(at: { repo: string; home: string }, args: string[] = [], transport?: Transport) {
  let stdout = '';
  let stderr = '';
  const env = { ...ENV, KISS_SIGN_HOME: at.home };
  const code = await history(args, {
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    readSecret: undefined,
    confirm: undefined,
    repoRoot: at.repo,
    transport: transport ?? replayTransport(deposit.exchanges, mainnetEndpoints(env)),
    fetchJson: async () => assert.fail('only history fetch reads the Transaction Service'),
  });
  return { code, stdout, stderr };
}

/** The row a reader sees for one nonce: its line and the indented lines under it. */
const rowOf = (stdout: string, nonce: number): string => {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^ *${nonce}  `).test(line));
  assert.ok(start >= 0, `no row for nonce ${nonce}`);
  const end = lines.findIndex((line, i) => i > start && !line.startsWith(' '.repeat(33)));
  return lines.slice(start, end).join('\n');
};

const withCard = { 249: { ...DEPOSIT_CARD, origin: 'history', marks: MARKS } };

test('a deposit with its card is MATCH, and the card column says which values came from the transaction', async () => {
  const { code, stdout } = await run(setUp('morpho-safe', withCard));
  assert.equal(code, 0);
  assert.match(rowOf(stdout, 249), /^  249  2026-\d\d-\d\d  MATCH         intent of nonce 249\n {33}card: amount: taken from the transaction$/);
  assert.match(stdout, /Templates are approved at their origin\/main hash \([0-9a-f]{40}\) for this run only, since history is not a signing: morpho\/vault-deposit 0x[0-9a-f]{64}\./);
});

test('reason row cow-next-phase: a setPreSignature inside a MultiSend, even when the floor refuses its approval', async () => {
  const { stdout } = await run(setUp('cow-safe'));
  assert.match(
    rowOf(stdout, 559),
    /^  559  [\d-]{10}  not run       intent of nonce 559\n {33}cow-next-phase: GPv2Settlement setPreSignature at multiSend\[1\]; the floor also refuses unlimited-approval at multiSend\[0\]$/,
  );
});

test('reason row cow-next-phase: an order cancelled with GPv2Settlement invalidateOrder', async () => {
  const { stdout } = await run(setUp('cow-safe'));
  assert.match(rowOf(stdout, 558), /^  558  [\d-]{10}  not run       intent of nonce 558\n {33}cow-next-phase: GPv2Settlement invalidateOrder at call$/);
});

test('a note naming the nonce that spends an approval gives the approval that nonce\'s reason', async () => {
  const { stdout } = await run(setUp('cow-safe', {}, { 10: { note: 'approval for the order', spentBy: 11 } }));
  assert.match(
    rowOf(stdout, 10),
    /^   10  [\d-]{10}  not run       intent of nonce 10\n {33}cow-next-phase: its approval is spent by nonce 11: GPv2Settlement setPreSignature at call; note: approval for the order$/,
  );
  assert.match(rowOf(stdout, 11), /\n {33}cow-next-phase: GPv2Settlement setPreSignature at call$/);
});

test('a note whose spending nonce is not later is refused', async () => {
  await assert.rejects(run(setUp('cow-safe', {}, { 11: { note: 'x', spentBy: 10 } })), /notes\.json\.11\.spentBy: an approval is spent by a later nonce/);
});

test("a note naming a spending nonce leaves a row that has its own verdict its own reason", async () => {
  const card = { operations: [{ ...DEPOSIT_CARD.operations[0]!, values: { vault: 'steakhouse-prime-usdc', amount: '1' } }], origin: 'history', marks: [] };
  const { stdout } = await run(setUp('morpho-safe', { 249: card }, { 249: { note: 'approval for the migration', spentBy: 338 } }));
  assert.match(rowOf(stdout, 249), /  MISMATCH  .*\n {33}mismatch: fields\+effects: fields: multiSend\[0\]\.approve value: expected 1, got 1800000000180; .*; note: approval for the migration\n/);
});

test('a note whose spending nonce is not in the history is refused', async () => {
  await assert.rejects(run(setUp('cow-safe', {}, { 10: { note: 'x', spentBy: 12 } })), /notes\.json\.10\.spentBy: no executed transaction at nonce 12 in the history/);
});

test('a note whose spending nonce is itself an approval spent later is refused', async () => {
  const notes = { 10: { note: 'x', spentBy: 11 }, 11: { note: 'y', spentBy: 558 } };
  await assert.rejects(run(setUp('cow-safe', {}, notes)), /notes\.json\.10\.spentBy: nonce 11 is itself an approval spent by nonce 558/);
});

test('reason row refused-by-design: the static floor refuses an unlimited approval, and names the rule', async () => {
  const { stdout } = await run(setUp('morpho-safe', withCard, { 338: 'approved for a migration' }));
  assert.match(rowOf(stdout, 338), /\n {33}refused-by-design: unlimited-approval at multiSend\[0\]; note: approved for a migration$/);
});

test('reason row no-card-yet: a transaction without a card file is not run', async () => {
  const { stdout } = await run(setUp('morpho-safe', withCard));
  assert.match(rowOf(stdout, 248), /^  248  [\d-]{10}  not run       intent of nonce 248\n {33}no-card-yet: no card file, so no template covers it yet$/);
});

test("reason row verdict causes: a card whose amount differs is MISMATCH, with the check and its first detail", async () => {
  const card = { operations: [{ ...DEPOSIT_CARD.operations[0]!, values: { vault: 'steakhouse-prime-usdc', amount: '1' } }], origin: 'history', marks: [] };
  const { stdout } = await run(setUp('morpho-safe', { 249: card }));
  assert.match(rowOf(stdout, 249), /  MISMATCH  .*\n {33}mismatch: fields\+effects: fields: multiSend\[0\]\.approve value: expected 1, got 1800000000180; effects: /);
});

test('the summary counts MATCH and each reason with its nonces', async () => {
  const { stdout } = await run(setUp('morpho-safe', withCard));
  assert.ok(
    stdout.endsWith('\nSummary\n  MATCH                           1  249\n  no-card-yet                     1  248\n  refused-by-design               1  338\n'),
    stdout,
  );
});

test('a rerun reads the chain from the cache, and --refresh reads it again', async () => {
  const at = setUp('morpho-safe', withCard);
  await run(at);
  assert.match(rowOf((await run(at, [], OFFLINE)).stdout, 249), /  MATCH  /);
  const refreshed = await run(at, ['--refresh'], async () => ({ status: 503, text: '' }));
  assert.match(rowOf(refreshed.stdout, 249), /  (UNVERIFIABLE|ERROR)  /);
});

test('--out writes the same rows as Markdown, and refuses a file inside the repository', async () => {
  const at = setUp('morpho-safe', withCard, { 338: 'a | b' });
  const out = join(at.base, 'history.md');
  await run(at, ['--out', out]);
  const markdown = readFileSync(out, 'utf8');
  assert.match(markdown, /\n\| 249 \| [\d-]{10} \| intent of nonce 249 \| MATCH \|  \| amount: taken from the transaction \|\n/);
  assert.match(markdown, /\n\| 338 \| [\d-]{10} \| intent of nonce 338 \| not run \| refused-by-design: unlimited-approval at multiSend\[0\]; note: a \\\| b \|  \|\n/);
  await assert.rejects(run(at, ['--out', join(at.repo, 'history.md')]), /--out must be outside this repository/);
});

test('an intent whose hash is not the transaction that executed its nonce is refused', async () => {
  const at = setUp('morpho-safe');
  const path = join(at.home, 'history', 'intents.json');
  const intents = readJson(path);
  intents[0].hash = `0x${'11'.repeat(32)}`;
  writeFileSync(path, JSON.stringify(intents));
  await assert.rejects(run(at), /intents\.json\[0\]: its hash is not the transaction that executed nonce 338/);
});

test('history fetch follows the service pages and writes every record', async () => {
  const at = setUp('morpho-safe');
  const all = records('morpho-safe');
  const pages: Record<string, unknown> = {};
  const first = `https://api.safe.global/tx-service/eth/api/v2/safes/${all[0]!.safe}/multisig-transactions/?limit=100`;
  pages[first] = { results: all.slice(0, 2), next: `${first}&offset=2` };
  pages[`${first}&offset=2`] = { results: all.slice(2), next: null };
  let stdout = '';
  const code = await history(['fetch'], {
    env: { KISS_SIGN_HOME: at.home },
    stdout: (text) => void (stdout += text),
    stderr: () => undefined,
    readSecret: undefined,
    confirm: undefined,
    repoRoot: at.repo,
    transport: OFFLINE,
    fetchJson: async (url) => pages[url] ?? assert.fail(`unexpected ${url}`),
  });
  assert.equal(code, 0);
  assert.match(stdout, /^Wrote 3 transactions \(3 executed\) to /);
  assert.equal(readFileSync(join(at.home, 'history', 'txs.jsonl'), 'utf8').trim().split('\n').length, 3);
});
