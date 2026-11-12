import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli/main.ts';
import type { Transport } from '../src/chain/rpc.ts';

const ROOT = join(import.meta.dirname, '..');
const SAFE = '0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

/** A typed line, or one worked out from what the command has printed so far. */
type Answer = string | ((stdout: string) => string);

type Chain = { readonly transport: Transport; readonly env?: Record<string, string>; readonly repoRoot?: string };

const noChain: Chain = { transport: async () => assert.fail('setup commands read no chain'), env: {} };

async function run(argv: string[], home: string, answers?: readonly Answer[], chain: Chain = noChain, platform: NodeJS.Platform = 'linux') {
  let stdout = '';
  let stderr = '';
  const asked: string[] = [];
  const queue = [...(answers ?? [])];
  const code = await main(argv, {
    env: { KISS_SIGN_HOME: home, ...(chain.env ?? { ALCHEMY_API_KEY: 'test-key' }) },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    platform,
    readSecret: undefined,
    ask:
      answers === undefined
        ? undefined
        : async (question) => {
            asked.push(question);
            const next = queue.shift();
            return typeof next === 'function' ? next(stdout) : next;
          },
    repoRoot: chain.repoRoot ?? ROOT,
    transport: chain.transport,
    fetchJson: async () => assert.fail('setup commands fetch nothing'),
  });
  return { code, stdout, stderr, asked };
}

const freshHome = () => mkdtempSync(join(tmpdir(), 'kiss-sign-setup-'));

/** The config init writes for SAFE in a clone of github.com/signer/kiss-sign. */
const configure = (home: string) => writeFileSync(join(home, 'config.json'), JSON.stringify({ chainId: 1, safe: SAFE, repo: 'github.com/signer/kiss-sign' }));

/** A clone whose origin fetches from each of `urls`, for init to read. */
function cloneWithOrigin(...urls: string[]): Chain {
  const repoRoot = mkdtempSync(join(tmpdir(), 'kiss-sign-clone-'));
  execFileSync('git', ['init', '--quiet', repoRoot]);
  for (const [i, url] of urls.entries()) execFileSync('git', ['-C', repoRoot, 'remote', ...(i === 0 ? ['add', 'origin', url] : ['set-url', '--add', 'origin', url])]);
  return { ...noChain, repoRoot };
}

const fork = cloneWithOrigin('https://github.com/signer/kiss-sign.git');

test('init records the Safe on chain 1 and the repository origin names, and prints both', async () => {
  const home = freshHome();
  const result = await run(['init', '--safe', SAFE], home, undefined, cloneWithOrigin('git@github.com:Signer/Kiss-Sign.git'));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), { chainId: 1, safe: SAFE, repo: 'github.com/signer/kiss-sign' });
  assert.ok(
    result.stdout.startsWith(
      `kiss-sign checks transactions of the Safe ${SAFE} on Ethereum mainnet (chain 1).\n` +
        "It runs only what is on main of github.com/signer/kiss-sign, the repository this clone's origin names.\n" +
        'Merging a pull request into that main is your confirmation.\n',
    ),
    result.stdout,
  );
});

test('init refuses to switch a home to another Safe or another repository', async () => {
  const home = freshHome();
  assert.equal((await run(['init', '--safe', SAFE], home, undefined, fork)).code, 0);
  const safe = await run(['init', '--safe', RECIPIENT], home, undefined, fork);
  assert.equal(safe.code, 1);
  assert.match(safe.stderr, /already set up for another Safe/);
  const repo = await run(['init', '--safe', SAFE], home, undefined, cloneWithOrigin('https://github.com/other/kiss-sign.git'));
  assert.equal(repo.code, 1);
  assert.match(repo.stderr, /already set up for another repository, github\.com\/signer\/kiss-sign\. Remove its config\.json to change it\./);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).repo, 'github.com/signer/kiss-sign');
});

test('init run again with the same Safe adds the repository to a config written before it had one', async () => {
  const home = freshHome();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ chainId: 1, safe: SAFE }));
  const sealed = await run(['card', 'new', 'morpho/vault-deposit'], home, []);
  assert.equal(sealed.code, 1);
  assert.match(sealed.stderr, /names no repository to trust\. In your clone of your own fork, run pnpm kiss-sign init --safe <your Safe> again\./);
  assert.equal((await run(['init', '--safe', SAFE], home, undefined, fork)).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), { chainId: 1, safe: SAFE, repo: 'github.com/signer/kiss-sign' });
});

test('init refuses a clone whose origin is not one GitHub repository, and writes nothing', async () => {
  for (const [urls, problem] of [
    [['/tmp/kiss-sign.git'], 'origin is /tmp/kiss-sign.git, not a GitHub https or ssh URL'],
    [['https://gitlab.com/signer/kiss-sign.git'], 'origin is https://gitlab.com/signer/kiss-sign.git, not a GitHub https or ssh URL'],
    [['https://github.com.evil.example/signer/kiss-sign.git'], 'origin is https://github.com.evil.example/signer/kiss-sign.git, not a GitHub https or ssh URL'],
    [['https://github.com/signer/kiss-sign.git', 'https://github.com/other/kiss-sign.git'], 'origin names more than one repository: github.com/signer/kiss-sign, github.com/other/kiss-sign'],
    [[], 'there is no origin remote'],
  ] as const) {
    const home = freshHome();
    const result = await run(['init', '--safe', SAFE], home, undefined, cloneWithOrigin(...urls));
    assert.equal(result.code, 1, urls.join(' '));
    assert.equal(result.stderr, `kiss-sign: run init in a clone of your own fork on GitHub; nothing was set up:\n  ${problem}\n`);
    assert.equal(existsSync(join(home, 'config.json')), false);
    assert.equal(existsSync(join(home, '.env')), false);
  }
});

test('init creates a key file readable by its owner only, with an empty line per key, and never overwrites one', async () => {
  const home = freshHome();
  const first = await run(['init', '--safe', SAFE], home, undefined, fork);
  const keyFile = join(home, '.env');
  assert.equal(first.code, 0);
  assert.match(first.stdout, new RegExp(`Created the key file ${keyFile}, readable by you only`));
  assert.match(first.stdout, /ALCHEMY_API_KEY +get it at https:\/\/dashboard\.alchemy\.com\/\n +needed by pnpm kiss-sign verify, pnpm kiss-sign card new/);
  assert.match(first.stdout, /ETHERSCAN_API_KEY +get it at https:\/\/etherscan\.io\/myapikey\n +needed by pnpm past-txs/);
  assert.match(first.stdout, new RegExp(`\\n {7}\\$\\{EDITOR:-nano\\} ${keyFile}\\n`));
  assert.match(first.stdout, /\n {5}Or enter each key with the command below; what you type is not shown on screen:\n {7}pnpm kiss-sign key add alchemy\n {7}pnpm kiss-sign key add etherscan\n/);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const lines = readFileSync(keyFile, 'utf8').split('\n').filter((line) => !line.startsWith('#') && line !== '');
  assert.deepEqual(lines, ['ALCHEMY_API_KEY=', 'ETHERSCAN_API_KEY=']);

  writeFileSync(keyFile, 'ALCHEMY_API_KEY=kept-by-the-signer\n');
  const again = await run(['init', '--safe', SAFE], home, undefined, fork);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /is already there and was left as it is/);
  assert.equal(readFileSync(keyFile, 'utf8'), 'ALCHEMY_API_KEY=kept-by-the-signer\n');
  assert.doesNotMatch(again.stdout, /Warning/);

  chmodSync(keyFile, 0o644);
  const loose = await run(['init', '--safe', SAFE], home, undefined, fork);
  assert.match(loose.stdout, new RegExp(`Warning: other users can read ${keyFile} \\(mode 644\\)\\. Run chmod 600 ${keyFile}\\.`));
});

test('init on macOS prints a command that opens the key file in TextEdit, quoting a path with a space', async () => {
  const home = join(freshHome(), 'my home');
  const result = await run(['init', '--safe', SAFE], home, undefined, fork, 'darwin');
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes(`\n       open -e '${join(home, '.env')}'\n`), result.stdout);
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
  configure(home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc', amount: '5', 'min-shares': '4' } }] }));
  const sealed = await run(['card', 'seal', card], home, ['y']);
  assert.equal(sealed.code, 0, sealed.stderr);
  assert.match(sealed.stdout, /vault: steakhouse-prime-usdc 0xbeef088055857739C12CD3765F20b7679Def0f51/);
  const hash = /Sealed card (0x[0-9a-f]{64})/.exec(sealed.stdout)?.[1];
  assert.ok(hash !== undefined && existsSync(join(home, 'cards', `${hash}.json`)));
});

test('card seal refuses a name in neither the registry nor the address book', async () => {
  const home = freshHome();
  configure(home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'morpho/vault-deposit', values: { vault: 'no-such-vault', amount: '5' } }] }));
  const result = await run(['card', 'seal', card], home, ['y']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no-such-vault/);
  assert.deepEqual(result.asked, []);
});

const STEAKHOUSE = '0xbeef088055857739C12CD3765F20b7679Def0f51';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const VAULT_V2_FACTORY = '0xA1D94F746dEfa1928926b84fB2596c06926C0405';
const HEAD = 21_000_000;
const HEAD_HASH = `0x${'ab'.repeat(32)}`;

/** Two providers that answer decimals() per token address; `drpc` overrides what drpc answers. */
function decimalsChain(alchemy: Record<string, number | 'revert'>, drpc: Record<string, number | 'revert'> = {}): Chain & { calls: string[] } {
  const calls: string[] = [];
  const transport: Transport = async (url, body) => {
    const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
    const reply = (result: unknown) => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
    if (method === 'eth_blockNumber') return reply(`0x${HEAD.toString(16)}`);
    if (method === 'eth_getBlockByNumber') return reply({ number: `0x${HEAD.toString(16)}`, hash: HEAD_HASH });
    assert.equal(method, 'eth_call');
    const [{ to, data }, at] = params as [{ to: string; data: string }, { blockHash: string }];
    assert.equal(data, '0x313ce567');
    assert.equal(at.blockHash, HEAD_HASH);
    calls.push(to.toLowerCase());
    const key = Object.keys(alchemy).find((address) => address.toLowerCase() === to.toLowerCase());
    assert.ok(key !== undefined, `decimals() of ${to} is not stubbed`);
    const answer = url.includes('drpc') ? (drpc[key] ?? alchemy[key]) : alchemy[key];
    if (answer === 'revert') return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }) };
    return reply(`0x${BigInt(answer ?? 0).toString(16).padStart(64, '0')}`);
  };
  return { transport, calls };
}

const mainnet = () => decimalsChain({ [USDC]: 6, [STEAKHOUSE]: 18 });

/** The number the prompt lists a name under. */
const numberOf = (name: string) => (stdout: string) => {
  const found = new RegExp(`(\\d+)\\. ${name} 0x`).exec(stdout)?.[1];
  assert.ok(found !== undefined, `${name} is listed`);
  return found;
};

async function sealedFile(values: Record<string, string>) {
  const home = freshHome();
  configure(home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'morpho/vault-deposit', values }] }));
  const sealed = await run(['card', 'seal', card], home, ['y']);
  return /Sealed card (0x[0-9a-f]{64})/.exec(sealed.stdout)?.[1];
}

test('card new lists a vault with the factory that created it, takes amounts in whole tokens, reads decimals on chain, and seals base units as card seal would', async () => {
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc'), '5', '4.8', 'y'], mainnet());
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, new RegExp(`  \\d+\\. steakhouse-prime-usdc ${STEAKHOUSE} \\(registry\\)  \\(factory vault-v2-factory ${VAULT_V2_FACTORY}\\)\n`));
  assert.equal(made.asked[1], `amount (usdc ${USDC}, 6 decimals): `);
  assert.equal(made.asked[2], `min-shares (steakhouse-prime-usdc ${STEAKHOUSE}, 18 decimals): `);
  assert.ok(made.stdout.includes(`usdc ${USDC} has 6 decimals: decimals() at block ${HEAD}, where alchemy and drpc agree\n`));
  assert.ok(made.stdout.includes('  amount: 5 usdc = 5000000 base units\n'));
  assert.ok(made.stdout.includes('  min-shares: 4.8 steakhouse-prime-usdc = 4800000000000000000 base units\n'));
  assert.ok(made.stdout.includes('amounts in whole tokens:\n  amount: 5 usdc = 5000000 base units\n  min-shares: 4.8 steakhouse-prime-usdc = 4800000000000000000 base units\n\n'));
  assert.match(made.stdout, new RegExp(`vault: steakhouse-prime-usdc ${STEAKHOUSE} \\(registry\\)\\n  amount: 5000000\\n`));
  assert.equal(made.asked[3], 'Is this what you mean to do? [y/N] ');
  const hash = /Sealed card (0x[0-9a-f]{64})/.exec(made.stdout)?.[1];
  assert.equal(hash, await sealedFile({ vault: 'steakhouse-prime-usdc', amount: '5000000', 'min-shares': '4800000000000000000' }));
});

test('card new reads each token\'s decimals once across operations', async () => {
  const home = freshHome();
  configure(home);
  const chain = mainnet();
  const vault = numberOf('steakhouse-prime-usdc');
  const made = await run(['card', 'new', 'morpho/vault-deposit', 'morpho/vault-withdraw'], home, [vault, '1.25', '1', vault, '0.000001', '1', 'y'], chain);
  assert.equal(made.code, 0, made.stderr);
  assert.ok(made.stdout.includes('  amount: 1.25 usdc = 1250000 base units\n'));
  assert.ok(made.stdout.includes('  amount: 0.000001 usdc = 1 base units\n'));
  assert.ok(made.stdout.includes('operation 1 amount: 1.25 usdc = 1250000 base units\n'));
  assert.ok(made.stdout.includes('operation 2 amount: 0.000001 usdc = 1 base units\n'));
  assert.deepEqual(chain.calls.toSorted(), [STEAKHOUSE, STEAKHOUSE, USDC, USDC].map((a) => a.toLowerCase()).toSorted());
});

test('card new asks for a choice by its number, and takes its exact listed name or full address too', async () => {
  for (const pick of [numberOf('steakhouse-prime-usdc'), 'steakhouse-prime-usdc', STEAKHOUSE.toLowerCase(), STEAKHOUSE.toUpperCase().replace('0X', '0x')]) {
    const home = freshHome();
    configure(home);
    const made = await run(['card', 'new', 'morpho/vault-deposit'], home, [pick, '5', '4.8', 'y'], mainnet());
    assert.equal(made.code, 0, made.stderr);
    assert.match(made.asked[0]!, /^vault: type its number \(1-\d+\): $/);
    assert.match(made.stdout, new RegExp(`  vault: steakhouse-prime-usdc ${STEAKHOUSE}`));
  }
});

test('card new refuses an address listed under two choices and asks for the number', async () => {
  const home = freshHome();
  configure(home);
  await run(['book', 'add', 'treasury', SAFE], home, ['y']);
  const result = await run(['card', 'new', 'eth/transfer'], home, [SAFE.toLowerCase(), '1', 'y']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /recipient: ".*" matches more than one listed choice; type the number in front of the one you mean \(1-2\)/);
});

test('card new counts eth in 18 decimals without reading the chain', async () => {
  const home = freshHome();
  configure(home);
  await run(['book', 'add', 'alice', RECIPIENT], home, ['y']);
  const made = await run(['card', 'new', 'eth/transfer'], home, [numberOf('alice'), '0.5', 'y'], { ...noChain, env: {} });
  assert.equal(made.code, 0, made.stderr);
  assert.equal(made.asked[1], 'amount (eth, 18 decimals): ');
  assert.ok(made.stdout.includes('  amount: 0.5 eth = 500000000000000000 base units\n'));
});

test('card new offers a transfer recipient only from the address book or the Safe', async () => {
  const home = freshHome();
  configure(home);
  await run(['book', 'add', 'alice', RECIPIENT], home, ['y']);
  const made = await run(['card', 'new', 'erc20/transfer'], home, [numberOf('usdc'), numberOf('alice'), '1', 'y'], mainnet());
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, new RegExp(`recipient:\\n  1\\. safe ${SAFE} \\(safe\\)\\n  2\\. alice ${RECIPIENT} \\(address-book\\)\\n`));
  assert.match(made.stdout, new RegExp(`recipient: alice ${RECIPIENT} \\(address-book\\)`));
  assert.match(made.stdout, /amount: 1000000\n/);
});

test('card new asks for base units when the token is no registry contract, so it has no decimals to read', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'kiss-sign-repo-'));
  cpSync(join(ROOT, 'registry'), join(repoRoot, 'registry'), { recursive: true });
  const transfer = JSON.parse(readFileSync(join(ROOT, 'templates', 'erc20', 'transfer', 'template.json'), 'utf8'));
  mkdirSync(join(repoRoot, 'templates', 'test', 'any-token'), { recursive: true });
  const template = { ...transfer, id: 'test/any-token', card: { ...transfer.card, token: { kind: 'address' } } };
  writeFileSync(join(repoRoot, 'templates', 'test', 'any-token', 'template.json'), JSON.stringify(template));
  const home = freshHome();
  configure(home);
  await run(['book', 'add', 'alice', RECIPIENT], home, ['y']);
  const made = await run(['card', 'new', 'test/any-token'], home, [numberOf('alice'), '2', '5', 'y'], { ...decimalsChain({}), repoRoot });
  assert.equal(made.code, 0, made.stderr);
  assert.equal(made.asked[2], 'amount (base units of card.token, which is no registry contract, so its decimals are not read): ');
  assert.match(made.stdout, /amount: 5\n/);
});

test('card new lists only the entries of the protocol a contract field names, and refuses any other', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'kiss-sign-repo-'));
  cpSync(join(ROOT, 'registry'), join(repoRoot, 'registry'), { recursive: true });
  const fluid = JSON.parse(readFileSync(join(ROOT, 'templates', 'fluid', 'vault-deposit', 'template.json'), 'utf8'));
  mkdirSync(join(repoRoot, 'templates', 'test', 'fluid-only'), { recursive: true });
  const template = { ...fluid, id: 'test/fluid-only', card: { ...fluid.card, vault: { kind: 'contract', registryKind: 'vault', defillama: 'fluid-lending' } } };
  writeFileSync(join(repoRoot, 'templates', 'test', 'fluid-only', 'template.json'), JSON.stringify(template));
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'test/fluid-only'], home, ['steakhouse-prime-usdc'], { ...mainnet(), repoRoot });
  assert.equal(made.code, 1);
  assert.match(made.stdout, /vault:\n  1\. fluid-fusdc 0x\w{40} \(registry\)\n  2\. fluid-fusdt 0x\w{40} \(registry\)\n/);
  assert.match(made.stderr, /vault: "steakhouse-prime-usdc" is none of the listed choices/);
});

test('card new lists each market with its id, its lltv and every part, takes the id as the answer, and counts its amount in the loan token', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'kiss-sign-repo-'));
  cpSync(join(ROOT, 'registry'), join(repoRoot, 'registry'), { recursive: true });
  const contracts = JSON.parse(readFileSync(join(ROOT, 'registry', 'contracts.json'), 'utf8'));
  const source = 'https://docs.morpho.org/get-started/resources/addresses';
  const added = {
    'morpho-blue': { address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', kind: 'lending', source },
    cbbtc: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', kind: 'token', source },
    'morpho-oracle-cbbtc-usdc-86': { address: '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a', kind: 'oracle', source },
    'adaptive-curve-irm': { address: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC', kind: 'irm', source },
  };
  writeFileSync(join(repoRoot, 'registry', 'contracts.json'), JSON.stringify({ ...contracts, ...added }));
  const id = '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64';
  const market = { lending: 'morpho-blue', loanToken: 'usdc', collateralToken: 'cbbtc', oracle: 'morpho-oracle-cbbtc-usdc-86', irm: 'adaptive-curve-irm', lltv: '860000000000000000', id };
  writeFileSync(join(repoRoot, 'registry', 'markets.json'), JSON.stringify({ 'usdc-cbbtc-86': market }));
  mkdirSync(join(repoRoot, 'templates', 'test', 'market'), { recursive: true });
  const template = {
    id: 'test/market',
    card: { market: { kind: 'market' }, amount: { kind: 'amount', of: 'market.loanToken' } },
    calls: [{ to: { card: 'market.loanToken' }, value: { const: '0' }, function: 'approve(address spender, uint256 value)', args: { spender: { card: 'market.lending' }, value: { card: 'amount' } } }],
    effects: { gives: [], gets: [] },
  };
  writeFileSync(join(repoRoot, 'templates', 'test', 'market', 'template.json'), JSON.stringify(template));
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'test/market'], home, [id, '2.5', 'y'], { ...decimalsChain({ [USDC]: 6 }), repoRoot });
  assert.equal(made.code, 0, made.stderr);
  assert.equal(made.asked[0], 'market: type its number (1-1): ');
  const parts = [
    `lending morpho-blue ${added['morpho-blue'].address}`,
    `loanToken usdc ${USDC}`,
    `collateralToken cbbtc ${added.cbbtc.address}`,
    `oracle morpho-oracle-cbbtc-usdc-86 ${added['morpho-oracle-cbbtc-usdc-86'].address}`,
    `irm adaptive-curve-irm ${added['adaptive-curve-irm'].address}`,
  ];
  assert.ok(made.stdout.includes(`market:\n  1. usdc-cbbtc-86 id ${id}, lltv 0.86 (860000000000000000)\n${parts.map((line) => `       ${line}\n`).join('')}`), made.stdout);
  assert.equal(made.asked[1], `amount (usdc ${USDC}, 6 decimals): `);
  assert.ok(made.stdout.includes(`  market: usdc-cbbtc-86 id ${id}, lltv 0.86 (860000000000000000) (markets table)\n${parts.map((line) => `    ${line}\n`).join('')}  amount: 2500000\n`), made.stdout);
  assert.match(made.stdout, /Sealed card 0x[0-9a-f]{64}/);
});

test('card new refuses without a terminal before it asks anything', async () => {
  const home = freshHome();
  configure(home);
  const result = await run(['card', 'new', 'morpho/vault-deposit'], home);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /confirm at a terminal/);
  assert.equal(result.stdout, '');
});

test('card new refuses before it asks anything when no Alchemy key is set', async () => {
  const home = freshHome();
  configure(home);
  const result = await run(['card', 'new', 'morpho/vault-deposit'], home, ['1', '5', '4', 'y'], { ...mainnet(), env: {} });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Alchemy needs an API key in ALCHEMY_API_KEY/);
  assert.deepEqual(result.asked, []);
});

const MAX_USDC = (2n ** 256n - 1n).toString().replace(/(\d{6})$/, '.$1');
const OVER_USDC = (2n ** 256n).toString().replace(/(\d{6})$/, '.$1');

test('card new takes the largest amount below 2^256 base units', async () => {
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc'), MAX_USDC, '0', 'y'], mainnet());
  assert.equal(made.code, 0, made.stderr);
  assert.ok(made.stdout.includes(`  amount: ${MAX_USDC} usdc = ${2n ** 256n - 1n} base units\n`));
});

for (const [what, answers, message] of [
  ['a number past the list', ['9999', '5', 'y'], /vault: "9999" is none of the listed choices; type the number in front of the one you mean \(1-\d+\)/],
  ['zero', ['0', '5', 'y'], /vault: "0" is none of the listed choices/],
  ['an empty answer', ['', '5', 'y'], /vault: "" is none of the listed choices/],
  ['a name that is not listed', ['steakhouse', '5', 'y'], /vault: "steakhouse" is none of the listed choices/],
  ['a listed name in another case', ['Steakhouse-Prime-USDC', '5', 'y'], /vault: "Steakhouse-Prime-USDC" is none of the listed choices/],
  ['part of a listed address', [STEAKHOUSE.slice(0, 20), '5', 'y'], /is none of the listed choices/],
  ['more fractional digits than usdc has decimals', [numberOf('steakhouse-prime-usdc'), '1.0000001', 'y'], /amount: "1.0000001" has more than 6 digits after the point, and usdc has 6 decimals/],
  ['a negative amount', [numberOf('steakhouse-prime-usdc'), '-5', 'y'], /amount: "-5" is not a plain decimal number/],
  ['an empty amount', [numberOf('steakhouse-prime-usdc'), '', 'y'], /amount: "" is not a plain decimal number/],
  ['a hex amount', [numberOf('steakhouse-prime-usdc'), '0x10', 'y'], /amount: "0x10" is not a plain decimal number/],
  ['an amount with an exponent', [numberOf('steakhouse-prime-usdc'), '5e6', 'y'], /amount: "5e6" is not a plain decimal number/],
  ['an amount with a plus sign', [numberOf('steakhouse-prime-usdc'), '+5', 'y'], /amount: "\+5" is not a plain decimal number/],
  ['an amount with a comma', [numberOf('steakhouse-prime-usdc'), '1,5', 'y'], /amount: "1,5" is not a plain decimal number/],
  ['an amount with no digit before the point', [numberOf('steakhouse-prime-usdc'), '.5', 'y'], /amount: ".5" is not a plain decimal number/],
  ['an amount with no digit after the point', [numberOf('steakhouse-prime-usdc'), '5.', 'y'], /amount: "5." is not a plain decimal number/],
  ['an amount of 2^256 base units', [numberOf('steakhouse-prime-usdc'), OVER_USDC, 'y'], /amount: ".*" is 2\^256 base units or more/],
  ['an amount with far too many digits', [numberOf('steakhouse-prime-usdc'), '9'.repeat(100), 'y'], /amount: ".*" is 2\^256 base units or more/],
  ['an amount with a leading zero', [numberOf('steakhouse-prime-usdc'), '05', 'y'], /amount: "05" is not a plain decimal number/],
] as const) {
  test(`card new refuses ${what} and seals nothing`, async () => {
    const home = freshHome();
    configure(home);
    const result = await run(['card', 'new', 'morpho/vault-deposit'], home, answers, mainnet());
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    assert.ok(!result.asked.includes('Is this what you mean to do? [y/N] '));
    assert.equal(existsSync(join(home, 'cards')), false);
  });
}

for (const [what, chain, message] of [
  ['the providers disagree on decimals()', decimalsChain({ [USDC]: 6, [STEAKHOUSE]: 18 }, { [USDC]: 18 }), /cannot read the decimals of usdc 0xA0b8.*: eth_call: alchemy and drpc disagree/],
  ['decimals() reverts', decimalsChain({ [USDC]: 'revert', [STEAKHOUSE]: 18 }), /cannot read the decimals of usdc 0xA0b8.*: decimals\(\) reverted/],
  ['decimals() is past 77', decimalsChain({ [USDC]: 78, [STEAKHOUSE]: 18 }), /cannot read the decimals of usdc 0xA0b8.*: decimals\(\) answered 78/],
] as const) {
  test(`card new refuses when ${what}, before it asks for the amount`, async () => {
    const home = freshHome();
    configure(home);
    const result = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc'), '5', '4', 'y'], chain);
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    assert.equal(result.asked.length, 1);
    assert.equal(existsSync(join(home, 'cards')), false);
  });
}

test('card new refuses a template that is not in the repository', async () => {
  const home = freshHome();
  configure(home);
  const result = await run(['card', 'new', 'morpho/no-such-operation'], home, ['1', 'y']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no template morpho\/no-such-operation in templates\//);
  assert.deepEqual(result.asked, []);
});

test('card new seals nothing when the signer says no', async () => {
  const home = freshHome();
  configure(home);
  const result = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc'), '5', '4', 'n'], mainnet());
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Nothing sealed/);
  assert.equal(existsSync(join(home, 'cards')), false);
});
