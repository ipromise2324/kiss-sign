import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordingText } from '../src/chain/bytecode.ts';
import type { VerdictFile } from '../src/verify/verify.ts';
import { ROOT, VAULT, chain, fixture, git, receiverChanged, run, service, setUp, template, verifyTx, write } from './canaries/verify-harness.ts';

const rowValue = (page: string, id: string): string | undefined => new RegExp(`<span class="id">${id.replace(/\./g, '\\.')}</span><span class="k">[^<]*</span><span class="v">([^<]*)</span>`).exec(page)?.[1];

test('the Morpho deposit verifies to MATCH, prints its safeTxHash, and writes a page with the hashes the hardware wallet shows', async () => {
  const { code, stdout, verdicts, pages } = await verifyTx(service);
  assert.equal(code, 0, stdout);
  assert.equal(verdicts.length, 1);
  assert.equal(pages.length, 1);
  const page = verdicts[0]!.replace(/\.json$/, '.html');
  const quoted = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  assert.match(
    stdout,
    new RegExp(
      `^┌─ MATCH · the transaction fits your card ─+\\n│ nonce +${service.nonce}\\n│ safeTxHash  ${chain.transactionHash}\\n└─+\\n` +
        `The page shows: the domain hash, the message hash and the checklist to compare with check\\.sh\\n  ${quoted(page)}\\nThe verdict file:\\n  ${quoted(verdicts[0]!)}\\n` +
        `Open the page with:\\n  xdg-open ${quoted(page)}\\nOn the independent computer, run:\\n  \\./check\\.sh ${service.nonce}\\n$`,
    ),
  );
  const [domain, message, safeTxHash] = ['tx-domain', 'tx-message', 'tx-safeTxHash'].map((id) => rowValue(pages[0]!, id));
  assert.equal(domain, chain.domainSeparator);
  assert.equal(safeTxHash, chain.transactionHash);
  const eip712 = keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), hexToBytes(domain!.slice(2)), hexToBytes(message!.slice(2))));
  assert.equal(`0x${bytesToHex(eip712)}`, safeTxHash);
});

test('after MATCH, the page lists every call the transaction makes in the 比對清單 rows check.sh writes', async () => {
  const { pages } = await verifyTx(service);
  const page = pages[0]!;
  assert.match(page, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
  assert.doesNotMatch(page, /<script|<link|<img|src=/i);
  assert.equal(rowValue(page, 'tx-nonce'), String(service.nonce));
  assert.deepEqual([...page.matchAll(/<div class="g"><span class="id">(C[0-9.]+)<\/span>/g)].map((m) => m[1]), ['C1', 'C2', 'C3', 'C3.1', 'C3.2']);
  assert.deepEqual(
    ['C1-to', 'C2-to', 'C3-to', 'C3.1-to', 'C3.2-to'].map((id) => rowValue(page, id)?.toLowerCase()),
    [service.to, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0x6566194141eefa99af43bb5aa71460ca2dc90245', ...Array(2).fill('0x4a6c312ec70e8747a587ee860a0353cd42be0ae0')].map((a) => String(a).toLowerCase()),
  );
  assert.deepEqual(
    ['C1-fn', 'C2-fn', 'C3-fn', 'C3.1-fn', 'C3.2-fn'].map((id) => rowValue(page, id)?.split(' ')[1]),
    ['0x8d80ff0a', '0x095ea7b3', '0x374f435d', '0xd96ca0b9', '0x6ef5eeae'],
  );
  assert.equal(rowValue(page, 'C3.2-a2'), '1800000000180');
  assert.equal(rowValue(page, 'C3.2-a3'), '1033376152028289');
  assert.match(rowValue(page, 'C3-extra') ?? '', /^0x[0-9a-f]{16}$/);
  assert.equal(rowValue(page, 'end-count'), '3');
});

test('the verdict file verify writes replays to the same verdict', async () => {
  const { repo, home, verdicts } = await verifyTx(service);
  const replayed = await run(['replay', verdicts[0]!], repo, home);
  assert.equal(replayed.code, 0, replayed.stderr);
  assert.match(replayed.stdout, /^┌─ MATCH · replay of a recorded verdict ─+\n[\s\S]*\n└─+\nSame verdict as recorded\.\n$/);
  assert.doesNotMatch(replayed.stdout, /比對清單|呼叫/);
});

test('a verdict whose template holds the older computed read form, "to": "card.<field>", still replays to the same verdict', async () => {
  const older = JSON.parse(template.text);
  older.card['min-shares'] = {
    kind: 'amount',
    of: 'vault',
    computed: {
      read: { to: 'card.vault', function: 'previewDeposit(uint256 assets) returns (uint256 shares)', args: { assets: 'card.amount' } },
      bound: 'floor',
      default: { bps: 3, source: 'https://github.com/morpho-org/sdks/blob/56f1ed62827a7aab39d979c0143d1fbf970c37ca/packages/blue-sdk/src/constants.ts#L24' },
    },
  };
  const text = `${JSON.stringify(older, null, 2)}\n`;
  const fingerprint = `0x${bytesToHex(keccak_256(new TextEncoder().encode(text)))}`;
  const card = JSON.parse(fixture.inputs.card.text);
  card.operations[0].values['min-shares'] = '1';
  const cardText = JSON.stringify(card);
  const cardHash = `0x${bytesToHex(keccak_256(new TextEncoder().encode(cardText)))}`;
  const { base, repo, home } = setUp(fingerprint);
  write(join(repo, 'templates', template.id, 'template.json'), text);
  git(repo, 'commit', '--quiet', '-am', 'a template written before reads took rules');
  git(repo, 'push', '--quiet', join(base, 'origin.git'), 'main');
  write(join(home, 'cards', `${cardHash}.json`), cardText);
  const verified = await run(['verify', '--card', cardHash, '--tx', write(join(base, 'tx.json'), JSON.stringify(service))], repo, home);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  const [verdict] = readdirSync(join(home, 'verdicts')).filter((name) => name.endsWith('.json'));
  const path = join(home, 'verdicts', verdict!);
  assert.ok(readFileSync(path, 'utf8').includes('\\"to\\": \\"card.vault\\"'), 'the verdict file holds the older form');
  const replayed = await run(['replay', path], repo, home);
  assert.equal(replayed.code, 0, replayed.stderr);
  assert.match(replayed.stdout, /\nSame verdict as recorded\.\n$/);
});

test('a signer who chose zh-TW at init gets the verify page and the terminal in Traditional Chinese, with the same verdict file', async () => {
  const english = await verifyTx(receiverChanged());
  const { code, stdout, pages, verdicts, repo, home } = await verifyTx(receiverChanged(), undefined, undefined, 'zh-TW');
  assert.equal(code, 1);
  assert.match(pages[0]!, /<html lang="zh-Hant">/);
  assert.match(pages[0]!, /MISMATCH：交易和你的卡片不符，不要簽/);
  assert.match(pages[0]!, /不顯示任何 hash。不要簽這筆交易。/);
  assert.match(stdout, /^┌─ MISMATCH · 交易和你的卡片不符，不要簽 ─+\n│ nonce +\d+\n/);
  const detail = /multiSend\[1\]\.multicall\.bundle\[1\]\.data\.erc4626Deposit receiver：應為 0x[0-9a-f]{40}，實際 0x1{40}/;
  /** The box wraps a long row at a space or between Chinese characters; joined without spaces, the row reads whole. */
  const joined = (text: string) => text.replaceAll(/\n│ {9,}/g, '').replaceAll(' ', '');
  const compact = new RegExp(`│fields${detail.source.replaceAll(' ', '')}\n`);
  assert.match(joined(stdout), compact);
  assert.match(pages[0]!, new RegExp(`<div class="meta">${detail.source}</div>`));
  assert.doesNotMatch(stdout + pages[0]!, /expected|got 0x/);
  assert.match(stdout, /│ 不顯示任何 hash。不要簽這筆交易。\n└─+\n頁面上有：每一項檢查\n/);
  const result = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as VerdictFile).result;
  assert.deepEqual(result(verdicts[0]!), result(english.verdicts[0]!));
  const replayed = await run(['replay', verdicts[0]!], repo, home);
  assert.equal(replayed.code, 0, replayed.stderr);
  assert.match(replayed.stdout, /^┌─ MISMATCH · 重算已記錄的判決 ─+\n[\s\S]*\n和記錄的判決相同。\n$/);
  assert.match(joined(replayed.stdout), compact);
});

test('in English the verdict box and the page show each detail exactly as the verdict file stores it', async () => {
  const { stdout, pages, verdicts } = await verifyTx(receiverChanged());
  const { verdict } = (JSON.parse(readFileSync(verdicts[0]!, 'utf8')) as VerdictFile).result;
  const details = verdict.kind === 'MATCH' ? [] : verdict.causes.flatMap((cause) => cause.details);
  assert.equal(details.length, 1);
  assert.match(details[0]!, /^multiSend\[1\]\.multicall\.bundle\[1\]\.data\.erc4626Deposit receiver: expected 0x[0-9a-f]{40}, got 0x1{40}$/);
  assert.ok(stdout.replaceAll(/\n│ {9,}/g, ' ').includes(`│ fields  ${details[0]}\n`));
  assert.ok(pages[0]!.includes(`<div class="meta">${details[0]}</div>`));
});

test('verify finds the report of an instance under instances/ as under vaults/, and refuses one with a report in both', async () => {
  const verifyWith = async (folders: readonly string[]) => {
    const { base, repo, home } = setUp(undefined, false);
    for (const folder of folders) write(join(repo, 'templates', template.id, folder, VAULT, 'report.generated.md'), '# report\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'reports');
    git(repo, 'push', '--quiet', join(base, 'origin.git'), 'main');
    return run(['verify', '--card', fixture.inputs.card.hash, '--tx', write(join(base, 'tx.json'), JSON.stringify(service))], repo, home);
  };
  const moved = await verifyWith(['instances']);
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(moved.stdout, /MATCH/);
  const both = await verifyWith(['instances', 'vaults']);
  assert.equal(both.code, 1);
  assert.equal(both.stderr, `kiss-sign: card refused: ${VAULT} has a report for ${template.id} in both instances/ and vaults/; keep one. Nothing was verified.\n`);
});

test('verify and replay never read GITHUB_TOKEN, from the environment or the key file', async () => {
  const token = 'github_pat_planted0for0the0verify0test';
  const { base, repo, home } = setUp();
  write(join(home, '.env'), `GITHUB_TOKEN=${token}\n`);
  const asked: PropertyKey[] = [];
  const watch = (env: Record<string, string>) =>
    new Proxy({ ...env, GITHUB_TOKEN: token }, {
      get: (target, key) => (asked.push(key), Reflect.get(target, key)),
      has: (target, key) => (asked.push(key), Reflect.has(target, key)),
    });
  const file = write(join(base, 'tx.json'), JSON.stringify(service));
  const verified = await run(['verify', '--card', fixture.inputs.card.hash, '--tx', file], repo, home, watch);
  assert.equal(verified.code, 0, verified.stderr);
  const verdict = readdirSync(join(home, 'verdicts')).find((name) => name.endsWith('.json'))!;
  const replayed = await run(['replay', join(home, 'verdicts', verdict)], repo, home, watch);
  assert.equal(replayed.code, 0, replayed.stderr);
  assert.ok(asked.includes('ALCHEMY_API_KEY'), 'the guard sees what verify reads');
  assert.ok(!asked.includes('GITHUB_TOKEN'));
  const written = readdirSync(join(home, 'verdicts')).map((name) => readFileSync(join(home, 'verdicts', name), 'utf8'));
  for (const text of [verified.stdout, verified.stderr, replayed.stdout, replayed.stderr, ...written]) assert.ok(!text.includes(token));
});

test('replay of a CoW order says the assets the order moves change later, and prints the same box verify does, with no call list', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'kiss-sign-replay-'));
  const { code, stdout, stderr } = await run(['replay', join(ROOT, 'testdata', 'verify', 'cow-swap-approve.json')], empty, empty);
  assert.equal(code, 0, stderr);
  assert.match(stdout.replace(/\n│ */g, ' '), /This transaction signs only the digest of a message \(Order\)\. The assets that message moves change later, when someone acts on it, not in this transaction\./);
  assert.doesNotMatch(stdout, /move no asset|moves an asset/);
});

test('replay names an older verdict format and says to run verify again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-replay-'));
  const path = write(join(dir, 'old.json'), recordingText({ ...fixture, format: 'kiss-sign-verdict-1' }));
  const { code, stderr } = await run(['replay', path], dir, dir);
  assert.equal(code, 1);
  assert.match(stderr, /format "kiss-sign-verdict-1", not kiss-sign-verdict-3; run verify again/);
});

test('replay refuses a verdict file that writes code out in full instead of naming it by its keccak256', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-replay-'));
  const path = write(join(dir, 'inline.json'), JSON.stringify(fixture));
  const { code, stderr } = await run(['replay', path], dir, dir);
  assert.equal(code, 1);
  assert.match(stderr, /the verdict file: \.exchanges\[\d+\]\.answers\.\w+ holds code itself, not its keccak256 in "bytecode"/);
});

test('replay says when only the call marks differ from the recorded ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-replay-'));
  const claimed = { ...fixture, result: { ...fixture.result, calls: { kind: 'unverifiable', reasons: ['edited'] } } };
  const path = write(join(dir, 'calls.json'), recordingText(claimed));
  const { code, stderr } = await run(['replay', path], dir, dir);
  assert.equal(code, 1);
  assert.match(stderr, /the recorded verdict was MATCH; this program now gives the same verdict but different call marks or hashes/);
});
