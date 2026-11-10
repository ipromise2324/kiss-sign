import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli/main.ts';

const ROOT = join(import.meta.dirname, '..');
const SAFE = '0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

/** A typed line, or one worked out from what the command has printed so far. */
type Answer = string | ((stdout: string) => string);

async function run(argv: string[], home: string, answers?: readonly Answer[]) {
  let stdout = '';
  let stderr = '';
  const asked: string[] = [];
  const queue = [...(answers ?? [])];
  const code = await main(argv, {
    env: { KISS_SIGN_HOME: home },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    readSecret: undefined,
    ask:
      answers === undefined
        ? undefined
        : async (question) => {
            asked.push(question);
            const next = queue.shift();
            return typeof next === 'function' ? next(stdout) : next;
          },
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
  const declined = await run(['book', 'add', 'alice', RECIPIENT], home, ['n']);
  assert.equal(declined.code, 1);
  assert.equal(existsSync(join(home, 'address-book.json')), false);
  const added = await run(['book', 'add', 'alice', RECIPIENT], home, ['y']);
  assert.equal(added.code, 0);
  assert.match(added.stdout, new RegExp(`alice -> ${RECIPIENT}`));
  assert.equal((await run(['book', 'list'], home)).stdout, `alice ${RECIPIENT}\n`);
});

test('card seal prints every name with its full address and stores the card under its hash on yes', async () => {
  const home = freshHome();
  await run(['init', '--safe', SAFE], home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc', amount: '5' } }] }));
  const sealed = await run(['card', 'seal', card], home, ['y']);
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
  const result = await run(['card', 'seal', card], home, ['y']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no-such-vault/);
  assert.deepEqual(result.asked, []);
});

const STEAKHOUSE = '0xbeef088055857739C12CD3765F20b7679Def0f51';

/** The number the prompt lists a name under. */
const numberOf = (name: string) => (stdout: string) => {
  const found = new RegExp(`(\\d+)\\. ${name} 0x`).exec(stdout)?.[1];
  assert.ok(found !== undefined, `${name} is listed`);
  return found;
};

async function sealedFile(values: Record<string, string>) {
  const home = freshHome();
  await run(['init', '--safe', SAFE], home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'morpho/vault-deposit', values }] }));
  const sealed = await run(['card', 'seal', card], home, ['y']);
  return /Sealed card (0x[0-9a-f]{64})/.exec(sealed.stdout)?.[1];
}

test('card new lists vaults with full addresses and seals the same card card seal would', async () => {
  const home = freshHome();
  await run(['init', '--safe', SAFE], home);
  const made = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc'), '5000000', 'y']);
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, new RegExp(`\\d+\\. steakhouse-prime-usdc ${STEAKHOUSE} \\(registry\\)`));
  assert.match(made.asked[1] ?? '', /amount \(base units of usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48\): /);
  assert.match(made.stdout, new RegExp(`vault: steakhouse-prime-usdc ${STEAKHOUSE} \\(registry\\)`));
  assert.equal(made.asked[2], 'Is this what you mean to do? [y/N] ');
  const hash = /Sealed card (0x[0-9a-f]{64})/.exec(made.stdout)?.[1];
  assert.equal(hash, await sealedFile({ vault: 'steakhouse-prime-usdc', amount: '5000000' }));
});

test('card new offers a transfer recipient only from the address book or the Safe', async () => {
  const home = freshHome();
  await run(['init', '--safe', SAFE], home);
  await run(['book', 'add', 'alice', RECIPIENT], home, ['y']);
  const made = await run(['card', 'new', 'erc20/transfer'], home, [numberOf('usdc'), '1', numberOf('alice'), 'y']);
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, new RegExp(`recipient:\\n  1\\. safe ${SAFE} \\(config\\)\\n  2\\. alice ${RECIPIENT} \\(address book\\)\\n`));
  assert.match(made.stdout, new RegExp(`recipient: alice ${RECIPIENT} \\(address-book\\)`));
});

test('card new refuses without a terminal before it asks anything', async () => {
  const home = freshHome();
  await run(['init', '--safe', SAFE], home);
  const result = await run(['card', 'new', 'morpho/vault-deposit'], home);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /confirm at a terminal/);
  assert.equal(result.stdout, '');
});

for (const [what, answers, message] of [
  ['a number past the list', ['9999', '5', 'y'], /vault: "9999" is not a number from 1 to \d+/],
  ['zero', ['0', '5', 'y'], /vault: "0" is not a number/],
  ['a name instead of a number', ['steakhouse-prime-usdc', '5', 'y'], /is not a number/],
  ['a decimal amount', [numberOf('steakhouse-prime-usdc'), '1.5', 'y'], /amount: "1.5" is not a whole number/],
  ['a negative amount', [numberOf('steakhouse-prime-usdc'), '-5', 'y'], /amount: "-5" is not a whole number/],
  ['an empty amount', [numberOf('steakhouse-prime-usdc'), '', 'y'], /amount: "" is not a whole number/],
  ['an amount with a leading zero', [numberOf('steakhouse-prime-usdc'), '05', 'y'], /amount: "05" is not a whole number/],
] as const) {
  test(`card new refuses ${what} and seals nothing`, async () => {
    const home = freshHome();
    await run(['init', '--safe', SAFE], home);
    const result = await run(['card', 'new', 'morpho/vault-deposit'], home, answers);
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    assert.ok(!result.asked.includes('Is this what you mean to do? [y/N] '));
    assert.equal(existsSync(join(home, 'cards')), false);
  });
}

test('card new refuses a template that is not in the repository', async () => {
  const home = freshHome();
  await run(['init', '--safe', SAFE], home);
  const result = await run(['card', 'new', 'morpho/no-such-operation'], home, ['1', 'y']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no template morpho\/no-such-operation in templates\//);
  assert.deepEqual(result.asked, []);
});

test('card new seals nothing when the signer says no', async () => {
  const home = freshHome();
  await run(['init', '--safe', SAFE], home);
  const result = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc'), '5', 'n']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Nothing sealed/);
  assert.equal(existsSync(join(home, 'cards')), false);
});
