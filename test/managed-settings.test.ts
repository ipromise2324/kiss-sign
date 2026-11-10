import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli/main.ts';

async function run(argv: string[], repoRoot: string, env: Record<string, string>) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    readSecret: undefined,
    ask: undefined,
    repoRoot,
    transport: async () => assert.fail('managed-settings reads no chain'),
    fetchJson: async () => assert.fail('managed-settings fetches nothing'),
  });
  return { code, stdout, stderr };
}

test('managed-settings prints JSON that denies the clone and KISS_SIGN_HOME, locks bypass mode, and forces the sandbox', async () => {
  const { code, stdout, stderr } = await run(['managed-settings'], '/Users/signer/kiss-sign/bin/../', { KISS_SIGN_HOME: '/Users/signer/signing-home' });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), {
    permissions: {
      disableBypassPermissionsMode: 'disable',
      deny: [
        'Edit(//Users/signer/kiss-sign/**)',
        'Read(//Users/signer/kiss-sign/**)',
        'Edit(//Users/signer/signing-home/**)',
        'Read(//Users/signer/signing-home/**)',
        'Read(~/.kiss-sign/.env)',
      ],
    },
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
  });
  assert.match(stderr, /not from an AI session/);
  if (process.platform === 'darwin') {
    assert.match(stderr, /sudo tee '\/Library\/Application Support\/ClaudeCode\/managed-settings\.json'/);
  }
});

test('managed-settings defaults the home to ~/.kiss-sign', async () => {
  const { stdout } = await run(['managed-settings'], '/srv/kiss-sign', { HOME: '/ignored' });
  const deny: string[] = JSON.parse(stdout).permissions.deny;
  assert.ok(deny.some((rule) => /^Edit\(\/\/.+\/\.kiss-sign\/\*\*\)$/.test(rule)), deny.join('\n'));
});

test('managed-settings refuses a path a permission rule would read as a pattern', async () => {
  const { code, stdout, stderr } = await run(['managed-settings'], '/Users/signer/kiss-sign[1]', { KISS_SIGN_HOME: '/Users/signer/home' });
  assert.equal(code, 64);
  assert.equal(stdout, '');
  assert.match(stderr, /reads as a pattern/);
});

test('bin/kiss-sign managed-settings writes only JSON to stdout', () => {
  const root = join(import.meta.dirname, '..');
  const out = execFileSync(join(root, 'bin', 'kiss-sign'), ['managed-settings'], {
    env: { ...process.env, KISS_SIGN_HOME: '/Users/signer/signing-home' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.deepEqual(JSON.parse(out).permissions.deny.slice(0, 2), [`Edit(/${root}/**)`, `Read(/${root}/**)`]);
});
