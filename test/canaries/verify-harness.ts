import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../../src/cli/main.ts';
import { mainnetEndpoints } from '../../src/chain/providers.ts';
import { readRecording } from '../../src/chain/bytecode.ts';
import { replayTransport } from '../../src/chain/recording.ts';
import type { Language } from '../../src/language.ts';
import type { VerdictFile } from '../../src/verify/verify.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
export const FIXTURE_PATH = join(ROOT, 'testdata', 'verify', 'morpho-vault-deposit.json');
export const fixture: VerdictFile = readRecording(FIXTURE_PATH);
export const chain = readJson(join(ROOT, 'testdata', 'safe-tx', 'morpho-vault-deposit.json')).chain;
export const service = fixture.inputs.tx.json as Record<string, unknown>;
export const template = fixture.inputs.templates[0]!;
const ENV = { ALCHEMY_API_KEY: 'test-key' };

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

export function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/**
 * A clone at its origin/main holding the fixture's template and registry, and a home set up as the signer set it up. Its
 * origin is the configured repository's URL, served offline from a local bare repository through core.sshCommand.
 */
export const VAULT = (JSON.parse(fixture.inputs.card.text) as { operations: { values: { vault: string } }[] }).operations[0]!.values.vault;

export function setUp(approved: string | null = template.approved, reported = true, language?: Language) {
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
  write(join(home, 'config.json'), JSON.stringify({ chainId: 1, safe: fixture.inputs.safe, repo: 'github.com/signer/kiss-sign', language }));
  write(join(home, 'cards', `${fixture.inputs.card.hash}.json`), fixture.inputs.card.text);
  if (approved !== null) write(join(home, 'approved-templates.json'), JSON.stringify({ [template.id]: approved }));
  return { base, repo, home };
}

/** Runs the CLI with every provider answer served from the recorded deposit, never from the network. */
export async function run(argv: string[], repo: string, home: string, watch = (env: Record<string, string>): Record<string, string> => env) {
  let stdout = '';
  let stderr = '';
  const env = { ...ENV, KISS_SIGN_HOME: home };
  const code = await main(argv, {
    env: watch(env),
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    platform: 'linux',
    readSecret: undefined,
    ask: undefined,
    repoRoot: repo,
    transport: replayTransport(fixture.exchanges, mainnetEndpoints(env)),
    fetchJson: async () => assert.fail('these tests give the transaction as a file'),
    readMessage: async () => ({ why: 'this test reads no signed message' }),
  });
  return { code, stdout, stderr };
}

export async function verifyTx(tx: unknown, approved?: string | null, reported?: boolean, language?: Language) {
  const { base, repo, home } = setUp(approved, reported, language);
  const file = write(join(base, 'tx.json'), JSON.stringify(tx));
  const result = await run(['verify', '--card', fixture.inputs.card.hash, '--tx', file], repo, home);
  const names = readdirSync(join(home, 'verdicts'));
  const verdicts = names.filter((name) => name.endsWith('.json')).map((name) => join(home, 'verdicts', name));
  const pages = names.filter((name) => name.endsWith('.html')).map((name) => readFileSync(join(home, 'verdicts', name), 'utf8'));
  return { ...result, repo, home, verdicts, pages };
}

/** The deposit as the Safe web app's JSON, with its receiver changed from the Safe to 0x1111…. */
export function receiverChanged(): Record<string, unknown> {
  const { safe: _safe, safeTxHash: _hash, ...rest } = service;
  const fields = ['to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver', 'nonce'];
  const webApp = Object.fromEntries(Object.entries(rest).filter(([key]) => fields.includes(key)));
  const safe = fixture.inputs.safe.slice(2).toLowerCase();
  const data = String(webApp.data).toLowerCase();
  assert.equal(data.split(safe).length, 2, 'the Safe appears once in the deposit, as its receiver');
  webApp.data = data.replace(safe, '11'.repeat(20));
  return webApp;
}

/** Every socket connection attempted while `run` runs, refused before it reaches the network. */
