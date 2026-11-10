import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli/main.ts';

const ROOT = join(import.meta.dirname, '..');
const SAFE = '0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

async function run(argv: string[], home: string, answer?: boolean) {
  let stdout = '';
  let stderr = '';
  const asked: string[] = [];
  const code = await main(argv, {
    env: { KISS_SIGN_HOME: home },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    readSecret: undefined,
    confirm: answer === undefined ? undefined : async (question) => (asked.push(question), answer),
    repoRoot: ROOT,
    transport: async () => assert.fail('setup commands read no chain'),
    fetchJson: async () => assert.fail('setup commands fetch nothing'),
  });
  return { code, stdout, stderr, asked };
}

const freshHome = () => mkdtempSync(join(tmpdir(), 'kiss-sign-setup-'));

test('init writes the Safe on chain 1 and refuses to switch a home to another Safe', async () => {
  const home = freshHome();
  assert.equal((await run(['init', '--safe', SAFE], home)).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), { chainId: 1, safe: SAFE });
  const again = await run(['init', '--safe', RECIPIENT], home);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already set up for another Safe/);
});

test('book add refuses without a terminal and adds nothing', async () => {
  const home = freshHome();
  const result = await run(['book', 'add', 'alice', RECIPIENT], home);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /confirm at a terminal/);
  assert.equal(existsSync(join(home, 'address-book.json')), false);
});

test('book add shows the full address, adds it on yes, and book list prints it', async () => {
  const home = freshHome();
  const declined = await run(['book', 'add', 'alice', RECIPIENT], home, false);
  assert.equal(declined.code, 1);
  assert.equal(existsSync(join(home, 'address-book.json')), false);
  const added = await run(['book', 'add', 'alice', RECIPIENT], home, true);
  assert.equal(added.code, 0);
  assert.match(added.stdout, new RegExp(`alice -> ${RECIPIENT}`));
  assert.equal((await run(['book', 'list'], home)).stdout, `alice ${RECIPIENT}\n`);
});

test('card seal prints every name with its full address and stores the card under its hash on yes', async () => {
  const home = freshHome();
  await run(['init', '--safe', SAFE], home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc', amount: '5' } }] }));
  const sealed = await run(['card', 'seal', card], home, true);
  assert.equal(sealed.code, 0, sealed.stderr);
  assert.match(sealed.stdout, /vault: steakhouse-prime-usdc 0xbeef088055857739C12CD3765F20b7679Def0f51/);
  const hash = /Sealed card (0x[0-9a-f]{64})/.exec(sealed.stdout)?.[1];
  assert.ok(hash !== undefined && existsSync(join(home, 'cards', `${hash}.json`)));
});

test('card seal refuses a name in neither the registry nor the address book', async () => {
  const home = freshHome();
  await run(['init', '--safe', SAFE], home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'morpho/vault-deposit', values: { vault: 'no-such-vault', amount: '5' } }] }));
  const result = await run(['card', 'seal', card], home, true);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no-such-vault/);
  assert.deepEqual(result.asked, []);
});
