import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attacks, replayCases } from '../src/attacks/attacks.ts';
import { loadRecording } from '../src/attacks/case.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { replayTransport } from '../src/chain/recording.ts';
import type { Transport } from '../src/chain/rpc.ts';
import type { Io } from '../src/cli/io.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const REPO = join(import.meta.dirname, '..');
const ROOT = repoWithTestFixtures();

const results = await replayCases(ROOT);

test('pnpm attacks prints, per case, the card with full addresses, the decoded call, and each verdict, offline', async () => {
  let stdout = '';
  const code = await attacks([], {
    env: {},
    stdout: (text) => void (stdout += text),
    stderr: () => undefined,
    platform: 'linux',
    readSecret: undefined,
    ask: undefined,
    repoRoot: ROOT,
    transport: async () => assert.fail('a replay reads no provider'),
    fetchJson: async () => assert.fail('a replay reads no Transaction Service'),
    readMessage: async () => ({ why: 'this test reads no signed message' }),
  });
  assert.equal(code, 0);
  assert.match(stdout, /recipient  bybit-warm-wallet 0xf89d7b9c864f589bbF53a82105107622B35EaA40 \(the case's address book\)/);
  assert.match(stdout, /operation   1, delegatecall/);
  assert.match(stdout, /call        transfer\(address,uint256\) \(selector 0xa9059cbb\)\n    to        0xbDd077f651EBe7f7b3cE16fe5F2b025BE2969516 /);
  assert.match(stdout, /call        selector 0x804e1f0a, no published signature\n    word 0    0x000000000000000000000000ef279c2ab14960aa319008cbea384b9f8ac35fc6/);
  assert.match(stdout, /newOwner  0x57ba8957ed2ff2e7AE38F4935451E81Ce1eEFbf5 /);
  assert.deepEqual(stdout.match(/^Floor rules alone: .*$/gm), ['Floor rules alone: refused by fee-fields, delegatecall', 'Floor rules alone: pass', 'Floor rules alone: refused by delegatecall']);
  const verdicts = stdout.match(/^Verdict .*$/gm) ?? [];
  assert.equal(verdicts.length, results.flatMap((r) => r.judgements).length);
  for (const line of verdicts) assert.match(line, /: (MISMATCH|UNVERIFIABLE|no verdict, verify stopped: .*)$/);
});

async function recordInRepoCopy(id: string, transport: (served: Transport, drpc: string) => Transport): Promise<{ code: number | Error; before: string; after: string }> {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-attacks-'));
  try {
    for (const dir of ['templates', 'registry']) cpSync(join(ROOT, dir), join(root, dir), { recursive: true });
    cpSync(join(REPO, 'testdata', 'attacks'), join(root, 'testdata', 'attacks'), { recursive: true });
    const path = join(root, 'testdata', 'attacks', id, 'recording.json');
    const before = readFileSync(path, 'utf8');
    const { service, exchanges } = loadRecording(root, id);
    const env = { ALCHEMY_API_KEY: 'test-key', DRPC_API_KEY: 'test-key-drpc', KISS_SIGN_HOME: join(root, 'home') };
    const endpoints = mainnetEndpoints(env);
    const io: Io = {
      env,
      stdout: () => undefined,
      stderr: () => undefined,
      platform: 'linux',
      readSecret: undefined,
      ask: undefined,
      repoRoot: root,
      transport: transport(replayTransport(exchanges, endpoints), endpoints[1].url),
      fetchJson: async () => ({ count: 1, results: [service] }),
      readMessage: async () => ({ why: 'this test reads no signed message' }),
    };
    const code = await attacks(['--record', id], io).catch((error: Error) => error);
    return { code, before, after: readFileSync(path, 'utf8') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('attacks --record refuses, naming the read and leaving the recording as it was, when a read still fails on the way after every retry', async () => {
  const { code, before, after } = await recordInRepoCopy('wazirx', (served, drpc) => async (url, body, signal) => {
    if (url === drpc && body.includes('eth_getTransactionReceipt')) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return served(url, body, signal);
  });
  assert.ok(code instanceof Error);
  assert.match(code.message, /^wazirx: \d+ read\(s\) got no answer after every retry, so nothing is recorded; run the command again later:\n/);
  assert.match(code.message, /^ {2}drpc eth_getTransactionReceipt: unreachable$/m);
  assert.equal(after, before);
});
