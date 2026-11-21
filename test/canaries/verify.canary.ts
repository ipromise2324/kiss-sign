import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordingText } from '../../src/chain/bytecode.ts';
import { httpsTransport } from '../../src/chain/rpc.ts';
import type { Language } from '../../src/language.ts';
import type { VerdictFile } from '../../src/verify/verify.ts';
import { FIXTURE_PATH, ROOT, VAULT, chain, fixture, git, receiverChanged, run, service, setUp, template, verifyTx, write } from './verify-harness.ts';

const hashLine = (stdout: string, label: string): string | undefined => new RegExp(`${label}\\s+(0x[0-9a-f]{64})`).exec(stdout)?.[1];

async function socketsOpenedBy(run: () => Promise<unknown>): Promise<string[]> {
  const opened: string[] = [];
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    opened.push(JSON.stringify(args[0]));
    throw new Error('no network in this test');
  } as typeof connect;
  try {
    await run();
  } finally {
    net.Socket.prototype.connect = connect;
  }
  return opened;
}

test('a copy with its receiver changed is MISMATCH, names the check and the field, and shows no hashes', async () => {
  const { code, stdout, pages, verdicts } = await verifyTx(receiverChanged());
  assert.equal(code, 1);
  assert.match(stdout, /^┌─ MISMATCH · the transaction does not fit your card ─+\n/);
  assert.doesNotMatch(stdout, /check\.sh/);
  const file = JSON.parse(readFileSync(verdicts[0]!, 'utf8')) as VerdictFile;
  for (const hash of Object.values(file.result.hashes)) {
    assert.doesNotMatch(stdout, new RegExp(hash.slice(2)));
    assert.doesNotMatch(pages[0]!, new RegExp(hash.slice(2)));
  }
  assert.match(stdout.replaceAll(/\n│ {9,}/g, ' '), /│ fields +multiSend\[1\]\.multicall\.bundle\[1\]\.data\.erc4626Deposit receiver: expected 0x[0-9a-f]{40}, got 0x1{40}\n/);
  assert.doesNotMatch(stdout, /domain hash|message hash|safeTxHash/);
  assert.match(pages[0]!, /<html lang="en">/);
  assert.match(pages[0]!, /MISMATCH: the transaction does not fit your card\. Do not sign/);
  assert.match(pages[0]!, /No hash is shown\. Do not sign this transaction\./);
  assert.doesNotMatch(pages[0]!, /比對清單 -->|domain hash|message hash/);
});

test('replay of a recorded MISMATCH reproduces it, says so, and exits 0', async () => {
  const { code, repo, home, verdicts } = await verifyTx(service, `0x${'00'.repeat(32)}`);
  assert.equal(code, 1);
  const replayed = await run(['replay', verdicts[0]!], repo, home);
  assert.equal(replayed.code, 0, replayed.stderr);
  assert.match(replayed.stdout, /^┌─ MISMATCH · replay of a recorded verdict ─+\n[\s\S]*│ No hashes are shown\. Do not sign this transaction\.\n└─+\nSame verdict as recorded\.\n$/);
});

test('a template that differs from its approved hash is MISMATCH', async () => {
  const { code, stdout } = await verifyTx(service, `0x${'00'.repeat(32)}`);
  assert.equal(code, 1);
  assert.match(stdout.replaceAll(/\n│ {9,}/g, ' '), /^┌─ MISMATCH [^\n]*\n│ nonce +\d+\n│ template-approval  morpho\/vault-deposit hashes to 0x[0-9a-f]{64}, the approved hash is 0x0{64}\n/);
});

test('a template never approved is UNVERIFIABLE', async () => {
  const { code, stdout } = await verifyTx(service, null);
  assert.equal(code, 1);
  assert.match(stdout, /^┌─ UNVERIFIABLE [^\n]*\n│ nonce +\d+\n│ template-approval  morpho\/vault-deposit was never approved/);
});

test('the socket guard sees a real HTTPS request', async () => {
  const opened = await socketsOpenedBy(() => httpsTransport()('https://127.0.0.1:9/', '{}', new AbortController().signal).catch(() => undefined));
  assert.ok(opened.length > 0);
});

test('replay of the recorded deposit gives MATCH from the verdict file alone and opens no socket', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'kiss-sign-replay-'));
  let result: Awaited<ReturnType<typeof run>> | undefined;
  const opened = await socketsOpenedBy(async () => {
    result = await run(['replay', FIXTURE_PATH], empty, empty);
  });
  assert.deepEqual(opened, []);
  assert.equal(result?.code, 0, result?.stderr);
  assert.equal(hashLine(result!.stdout, 'safeTxHash'), chain.transactionHash);
  assert.match(result!.stdout, /Same verdict as recorded/);
});

test('replay refuses a verdict file whose card was edited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-replay-'));
  const edited = { ...fixture, inputs: { ...fixture.inputs, card: { ...fixture.inputs.card, text: fixture.inputs.card.text.replace('1800000000180', '1800000000181') } } };
  const path = write(join(dir, 'edited.json'), recordingText(edited));
  const { code, stderr } = await run(['replay', path], dir, dir);
  assert.equal(code, 1);
  assert.match(stderr, /the card does not hash to 0x/);
});

test('replay reports a recorded verdict this program does not reproduce', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-replay-'));
  const claimed = { ...fixture, result: { ...fixture.result, verdict: { kind: 'MISMATCH', causes: [] } } };
  const path = write(join(dir, 'claimed.json'), recordingText(claimed));
  const { code, stdout, stderr } = await run(['replay', path], dir, dir);
  assert.equal(code, 1);
  assert.match(stdout, /^┌─ MATCH · replay of a recorded verdict ─+\n/);
  assert.match(stderr, /the recorded verdict was MISMATCH; this program now gives another result/);
});

test('verify refuses a sealed card whose computed floor is 0 before it reads the chain, in the signer\'s language, and writes no verdict', async () => {
  const card = { operations: [{ template: template.id, values: { vault: 'steakhouse-prime-usdc-v2-0f51', amount: '5000000', 'min-shares': '0' } }] };
  const text = JSON.stringify(card);
  const hash = `0x${bytesToHex(keccak_256(new TextEncoder().encode(text)))}`;
  const expected: Record<Language, string> = {
    en: 'kiss-sign: card refused at operations[0].values.min-shares: min-shares is 0; a computed amount, or one a share price bound or atLeast compares with, must be at least 1, since 0 there bounds nothing or nothing can meet it\n',
    'zh-TW': 'kiss-sign: 卡片在 operations[0].values.min-shares 被拒絕：min-shares 是 0；算出來的數量，或份額價格界線、atLeast 拿來比較的數量，至少要是 1，因為 0 在這裡不是什麼都不限，就是沒有交易能滿足\n',
  };
  for (const language of ['en', 'zh-TW'] as const) {
    const { base, repo, home } = setUp(undefined, true, language);
    write(join(repo, 'templates', template.id, 'template.json'), readFileSync(join(ROOT, 'templates', template.id, 'template.json'), 'utf8'));
    for (const file of ['contracts.json', 'attributes.json']) write(join(repo, 'registry', file), readFileSync(join(ROOT, 'registry', file), 'utf8'));
    git(repo, 'add', 'registry');
    git(repo, 'commit', '--quiet', '-am', 'the current template');
    git(repo, 'push', '--quiet', join(base, 'origin.git'), 'main');
    write(join(home, 'cards', `${hash}.json`), text);
    const file = write(join(base, 'tx.json'), JSON.stringify(service));
    const { code, stdout, stderr } = await run(['verify', '--card', hash, '--tx', file], repo, home);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.equal(stderr, expected[language]);
    assert.equal(readdirSync(home).includes('verdicts'), false);
  }
});

test('verify refuses a card naming a vault with no report for the template at origin/main, and writes no verdict', async () => {
  const { base, repo, home } = setUp(undefined, false);
  const file = write(join(base, 'tx.json'), JSON.stringify(service));
  const { code, stdout, stderr } = await run(['verify', '--card', fixture.inputs.card.hash, '--tx', file], repo, home);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.equal(stderr, `kiss-sign: card refused: ${VAULT} has no report for ${template.id}; build one first. Nothing was verified.\n`);
  assert.equal(readdirSync(home).includes('verdicts'), false);
});
