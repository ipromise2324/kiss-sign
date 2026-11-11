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
 * origin is the official URL, served offline from a local bare repository through core.sshCommand.
 */
function setUp(approved: string | null = template.approved) {
  const base = mkdtempSync(join(tmpdir(), 'kiss-sign-verify-'));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  git(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(base, 'clone', '--quiet', origin, repo);
  write(join(repo, 'templates', template.id, 'template.json'), template.text);
  write(join(repo, 'registry', 'contracts.json'), fixture.inputs.registry);
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'templates');
  git(repo, 'push', '--quiet', 'origin', 'main');
  const ssh = write(join(base, 'ssh'), `#!/bin/sh\nexec git-upload-pack '${origin}'\n`);
  chmodSync(ssh, 0o755);
  git(repo, 'remote', 'set-url', 'origin', 'git@github.com:ipromise2324/kiss-sign.git');
  git(repo, 'config', 'core.sshCommand', ssh);
  const home = join(base, 'home');
  write(join(home, 'config.json'), JSON.stringify({ chainId: 1, safe: fixture.inputs.safe }));
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

async function verifyTx(tx: unknown, approved?: string | null) {
  const { base, repo, home } = setUp(approved);
  const file = write(join(base, 'tx.json'), JSON.stringify(tx));
  const result = await run(['verify', '--card', fixture.inputs.card.hash, '--tx', file], repo, home);
  const verdicts = readdirSync(join(home, 'verdicts')).map((name) => join(home, 'verdicts', name));
  return { ...result, repo, home, verdicts };
}

const hashLine = (stdout: string, label: string): string | undefined => new RegExp(`${label}\\s+(0x[0-9a-f]{64})`).exec(stdout)?.[1];

test('the Morpho deposit verifies to MATCH and prints the hashes the hardware wallet shows', async () => {
  const { code, stdout, verdicts } = await verifyTx(service);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /^MATCH\nEvery call moves an asset of the Safe\.\n  domain hash/);
  const [domain, message, safeTxHash] = ['domain hash', 'message hash', 'safeTxHash'].map((label) => hashLine(stdout, label));
  assert.equal(domain, chain.domainSeparator);
  assert.equal(safeTxHash, chain.transactionHash);
  const eip712 = keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), hexToBytes(domain!.slice(2)), hexToBytes(message!.slice(2))));
  assert.equal(`0x${bytesToHex(eip712)}`, safeTxHash);
  assert.equal(verdicts.length, 1);
  assert.match(stdout, new RegExp(`Verdict file: ${verdicts[0]}`));
});

test('the verdict file verify writes replays to the same verdict', async () => {
  const { repo, home, verdicts } = await verifyTx(service);
  const replayed = await run(['replay', verdicts[0]!], repo, home);
  assert.equal(replayed.code, 0, replayed.stderr);
  assert.match(replayed.stdout, /^MATCH\n[\s\S]*Same verdict as recorded\.\n$/);
});

test('a copy with its receiver changed is MISMATCH, names the check and the field, and shows no hashes', async () => {
  const { safe: _safe, safeTxHash: _hash, ...rest } = service;
  const fields = ['to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver', 'nonce'];
  const webApp = Object.fromEntries(Object.entries(rest).filter(([key]) => fields.includes(key)));
  const safe = fixture.inputs.safe.slice(2).toLowerCase();
  const data = String(webApp.data).toLowerCase();
  assert.equal(data.split(safe).length, 2, 'the Safe appears once in the deposit, as its receiver');
  webApp.data = data.replace(safe, '11'.repeat(20));
  const { code, stdout } = await verifyTx(webApp);
  assert.equal(code, 1);
  assert.match(stdout, /^MISMATCH\n/);
  assert.match(stdout, /fields: multiSend\[1\]\.multicall\.bundle\[1\]\.data\.erc4626Deposit receiver: expected 0x[0-9a-f]{40}, got 0x1{40}/);
  assert.doesNotMatch(stdout, /domain hash|message hash|safeTxHash/);
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
