import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli/main.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { replayTransport } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import type { VerdictFile } from '../src/verify/verify.ts';

const ROOT = join(import.meta.dirname, '..');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const FIXTURE_PATH = join(ROOT, 'testdata', 'verify', 'morpho-vault-deposit.json');
const fixture: VerdictFile = readJson(FIXTURE_PATH);
const chain = readJson(join(ROOT, 'testdata', 'safe-tx', 'morpho-vault-deposit.json')).chain;
const service = fixture.inputs.tx.json as Record<string, unknown>;
const template = fixture.inputs.templates[0]!;
const ENV = { ALCHEMY_API_KEY: 'test-key' };

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/**
 * A clone at its origin/main holding the fixture's template and registry, and a home set up as the signer set it up. Its
 * origin is the configured repository's URL, served offline from a local bare repository through core.sshCommand.
 */
const VAULT = (JSON.parse(fixture.inputs.card.text) as { operations: { values: { vault: string } }[] }).operations[0]!.values.vault;

function setUp(approved: string | null = template.approved, reported = true) {
  const base = mkdtempSync(join(tmpdir(), 'kiss-sign-verify-'));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(base, 'clone', '--quiet', origin, repo);
  write(join(repo, 'templates', template.id, 'template.json'), template.text);
  write(join(repo, 'registry', 'contracts.json'), fixture.inputs.registry);
  if (reported) write(join(repo, 'templates', template.id, 'vaults', VAULT, 'report.generated.md'), '# report\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'templates');
  git(repo, 'push', '--quiet', 'origin', 'main');
  const ssh = write(join(base, 'ssh'), `#!/bin/sh\nexec git-upload-pack '${origin}'\n`);
  chmodSync(ssh, 0o755);
  git(repo, 'remote', 'set-url', 'origin', 'git@github.com:signer/kiss-sign.git');
  git(repo, 'config', 'core.sshCommand', ssh);
  const home = join(base, 'home');
  write(join(home, 'config.json'), JSON.stringify({ chainId: 1, safe: fixture.inputs.safe, repo: 'github.com/signer/kiss-sign' }));
  write(join(home, 'cards', `${fixture.inputs.card.hash}.json`), fixture.inputs.card.text);
  if (approved !== null) write(join(home, 'approved-templates.json'), JSON.stringify({ [template.id]: approved }));
  return { base, repo, home };
}

/** Runs the CLI with every provider answer served from the recorded deposit, never from the network. */
async function run(argv: string[], repo: string, home: string) {
  let stdout = '';
  let stderr = '';
  const env = { ...ENV, KISS_SIGN_HOME: home };
  const code = await main(argv, {
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    platform: 'linux',
    readSecret: undefined,
    ask: undefined,
    repoRoot: repo,
    transport: replayTransport(fixture.exchanges, mainnetEndpoints(env)),
    fetchJson: async () => assert.fail('these tests give the transaction as a file'),
  });
  return { code, stdout, stderr };
}

async function verifyTx(tx: unknown, approved?: string | null, reported?: boolean) {
  const { base, repo, home } = setUp(approved, reported);
  const file = write(join(base, 'tx.json'), JSON.stringify(tx));
  const result = await run(['verify', '--card', fixture.inputs.card.hash, '--tx', file], repo, home);
  const names = readdirSync(join(home, 'verdicts'));
  const verdicts = names.filter((name) => name.endsWith('.json')).map((name) => join(home, 'verdicts', name));
  const pages = names.filter((name) => name.endsWith('.html')).map((name) => readFileSync(join(home, 'verdicts', name), 'utf8'));
  return { ...result, repo, home, verdicts, pages };
}

const hashLine = (stdout: string, label: string): string | undefined => new RegExp(`${label}\\s+(0x[0-9a-f]{64})`).exec(stdout)?.[1];

const rowValue = (page: string, id: string): string | undefined => new RegExp(`<span class="id">${id.replace(/\./g, '\\.')}</span><span class="k">[^<]*</span><span class="v">([^<]*)</span>`).exec(page)?.[1];

test('the Morpho deposit verifies to MATCH, prints its safeTxHash, and writes a page with the hashes the hardware wallet shows', async () => {
  const { code, stdout, verdicts, pages } = await verifyTx(service);
  assert.equal(code, 0, stdout);
  assert.equal(verdicts.length, 1);
  assert.equal(pages.length, 1);
  const page = verdicts[0]!.replace(/\.json$/, '.html');
  assert.equal(stdout, `MATCH\n  safeTxHash  ${chain.transactionHash}\nVerdict file: ${verdicts[0]}\nPage with the domain hash, the message hash and the 比對清單 to compare with check.sh: ${page}\nOpen it with: xdg-open ${page}\n`);
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
  assert.match(replayed.stdout, /^MATCH\n[\s\S]*Same verdict as recorded\.\n$/);
  assert.doesNotMatch(replayed.stdout, /比對清單|呼叫/);
});

test('a copy with its receiver changed is MISMATCH, names the check and the field, and shows no hashes', async () => {
  const { safe: _safe, safeTxHash: _hash, ...rest } = service;
  const fields = ['to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver', 'nonce'];
  const webApp = Object.fromEntries(Object.entries(rest).filter(([key]) => fields.includes(key)));
  const safe = fixture.inputs.safe.slice(2).toLowerCase();
  const data = String(webApp.data).toLowerCase();
  assert.equal(data.split(safe).length, 2, 'the Safe appears once in the deposit, as its receiver');
  webApp.data = data.replace(safe, '11'.repeat(20));
  const { code, stdout, pages, verdicts } = await verifyTx(webApp);
  assert.equal(code, 1);
  assert.match(stdout, /^MISMATCH\n/);
  const file = JSON.parse(readFileSync(verdicts[0]!, 'utf8')) as VerdictFile;
  for (const hash of Object.values(file.result.hashes)) {
    assert.doesNotMatch(stdout, new RegExp(hash.slice(2)));
    assert.doesNotMatch(pages[0]!, new RegExp(hash.slice(2)));
  }
  assert.match(stdout, /fields: multiSend\[1\]\.multicall\.bundle\[1\]\.data\.erc4626Deposit receiver: expected 0x[0-9a-f]{40}, got 0x1{40}/);
  assert.doesNotMatch(stdout, /domain hash|message hash|safeTxHash/);
  assert.match(pages[0]!, /MISMATCH：交易和你的卡片不符，不要簽/);
  assert.match(pages[0]!, /不顯示任何 hash。不要簽這筆交易。/);
  assert.doesNotMatch(pages[0]!, /比對清單 -->|domain hash|message hash/);
});

test('a template that differs from its approved hash is MISMATCH', async () => {
  const { code, stdout } = await verifyTx(service, `0x${'00'.repeat(32)}`);
  assert.equal(code, 1);
  assert.match(stdout, /^MISMATCH\n  template-approval: morpho\/vault-deposit hashes to 0x[0-9a-f]{64}, the approved hash is 0x0{64}\n/);
});

test('a template never approved is UNVERIFIABLE', async () => {
  const { code, stdout } = await verifyTx(service, null);
  assert.equal(code, 1);
  assert.match(stdout, /^UNVERIFIABLE\n  template-approval: morpho\/vault-deposit was never approved/);
});

/** Every socket connection attempted while `run` runs, refused before it reaches the network. */
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
  const path = write(join(dir, 'edited.json'), JSON.stringify(edited));
  const { code, stderr } = await run(['replay', path], dir, dir);
  assert.equal(code, 1);
  assert.match(stderr, /the card does not hash to 0x/);
});

test('replay reports a recorded verdict this program does not reproduce', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-replay-'));
  const claimed = { ...fixture, result: { ...fixture.result, verdict: { kind: 'MISMATCH', causes: [] } } };
  const path = write(join(dir, 'claimed.json'), JSON.stringify(claimed));
  const { code, stdout, stderr } = await run(['replay', path], dir, dir);
  assert.equal(code, 1);
  assert.match(stdout, /^MATCH\n/);
  assert.match(stderr, /the recorded verdict was MISMATCH; this program now gives another result/);
});

test('replay names an older verdict format and says to run verify again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-replay-'));
  const path = write(join(dir, 'old.json'), JSON.stringify({ ...fixture, format: 'kiss-sign-verdict-1' }));
  const { code, stderr } = await run(['replay', path], dir, dir);
  assert.equal(code, 1);
  assert.match(stderr, /format "kiss-sign-verdict-1", not kiss-sign-verdict-2; run verify again/);
});

test('replay says when only the call marks differ from the recorded ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-replay-'));
  const claimed = { ...fixture, result: { ...fixture.result, calls: { kind: 'unverifiable', reasons: ['edited'] } } };
  const path = write(join(dir, 'calls.json'), JSON.stringify(claimed));
  const { code, stderr } = await run(['replay', path], dir, dir);
  assert.equal(code, 1);
  assert.match(stderr, /the recorded verdict was MATCH; this program now gives the same verdict but different call marks or hashes/);
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
