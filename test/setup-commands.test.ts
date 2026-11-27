import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli/main.ts';
import { keccakCode } from '../src/contracts/code.ts';
import { parseFunctionSignature } from '../src/decode/abi.ts';
import type { Hex } from '../src/safe/types.ts';
import type { Transport } from '../src/chain/rpc.ts';

const ROOT = join(import.meta.dirname, '..');
const FIXTURE_TEMPLATES = join(import.meta.dirname, 'fixtures', 'templates');
const SAFE = '0xAF177c57e369bBD30F47745DbAAF1D225f4B74D0';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

/** A typed line, or one worked out from what the command has printed so far. */
type Answer = string | ((stdout: string) => string);

/** `repoRoot` is published as main before the command runs, unless it is a clone of its own or `unpublished` is set. */
const NOW = 1_800_000_000;

type Chain = { readonly transport: Transport; readonly env?: Record<string, string>; readonly repoRoot?: string; readonly unpublished?: boolean; readonly clock?: number };

const noChain: Chain = { transport: async () => assert.fail('setup commands read no chain'), env: {} };

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Commits `dir` as it is and pushes it to main of its own bare origin, making it a clone of github.com/signer/kiss-sign
 * whose fetches are served offline from that origin through core.sshCommand, so card new and card seal find it current.
 */
function publish(dir: string): string {
  if (!existsSync(join(dir, '.git'))) {
    const origin = mkdtempSync(join(tmpdir(), 'kiss-sign-origin-'));
    git(origin, 'init', '--quiet', '--bare', '--initial-branch=main');
    git(dir, 'init', '--quiet', '--initial-branch=main');
    const ssh = join(origin, 'ssh');
    writeFileSync(ssh, `#!/bin/sh\nexec git-upload-pack '${origin}'\n`);
    chmodSync(ssh, 0o755);
    git(dir, 'remote', 'add', 'origin', 'git@github.com:signer/kiss-sign.git');
    git(dir, 'config', 'core.sshCommand', ssh);
    git(dir, 'config', 'kiss-sign-test.origin', origin);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'data');
  git(dir, 'push', '--quiet', git(dir, 'config', 'kiss-sign-test.origin').trim(), 'HEAD:refs/heads/main');
  return dir;
}

function dataClone(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiss-sign-repo-'));
  for (const sub of ['registry', 'templates']) cpSync(join(ROOT, sub), join(dir, sub), { recursive: true });
  repinned(dir, 'steakhouse-prime-usdc-v2-0f51', { hash: keccakCode(VAULT_CODE), from: 0 });
  return dir;
}

/** The stub runtime code the tests' providers answer for the vault, which its entry is pinned to; it holds no DELEGATECALL. */
const VAULT_CODE: Hex = '0x00' as Hex;

/** Writes `code` as the code pin of entry `name` in `dir`'s registry; undefined removes its pin. */
function repinned(dir: string, name: string, code: unknown): string {
  const path = join(dir, 'registry', 'contracts.json');
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  registry[name].code = code;
  writeFileSync(path, JSON.stringify(registry, null, 2));
  return dir;
}

/** A test's own copy, published as main as it now is; a clone made some other way stays as it is. */
const published = (dir: string): string => (!existsSync(join(dir, '.git')) || isPublished(dir) ? publish(dir) : dir);

function isPublished(dir: string): boolean {
  try {
    return git(dir, 'config', 'kiss-sign-test.origin').trim() !== '';
  } catch {
    return false;
  }
}

let shared: string | undefined;
const signerClone = (): string => (shared ??= publish(dataClone()));

async function run(argv: string[], home: string, answers?: readonly Answer[], chain: Chain = noChain, platform: NodeJS.Platform = 'linux') {
  let stdout = '';
  let stderr = '';
  const asked: string[] = [];
  const queue = [...(answers ?? [])];
  const code = await main(argv, {
    env: { KISS_SIGN_HOME: home, ...(chain.env ?? { ALCHEMY_API_KEY: 'test-key', DRPC_API_KEY: 'test-key-drpc' }) },
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
    repoRoot: chain.repoRoot === undefined ? signerClone() : chain.unpublished === true ? chain.repoRoot : published(chain.repoRoot),
    transport: chain.transport,
    fetchJson: async () => assert.fail('setup commands fetch nothing'),
    now: () => (chain.clock ?? NOW) * 1000,
    readMessage: async () => ({ why: 'this test reads no signed message' }),
  });
  return { code, stdout, stderr, asked };
}

const freshHome = () => mkdtempSync(join(tmpdir(), 'kiss-sign-setup-'));

/** The config init writes for SAFE in a clone of github.com/signer/kiss-sign. */
const configure = (home: string, language?: string) =>
  writeFileSync(join(home, 'config.json'), JSON.stringify({ chainId: 1, safe: SAFE, repo: 'github.com/signer/kiss-sign', ...(language === undefined ? {} : { language }) }));

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
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), { chainId: 1, safe: SAFE, repo: 'github.com/signer/kiss-sign', language: 'en' });
  assert.ok(
    result.stdout.startsWith(
      'kiss-sign is set up\n' +
        `  Safe        ${SAFE}\n` +
        '              Ethereum mainnet (chain 1)\n' +
        '  repository  github.com/signer/kiss-sign\n' +
        "              main of this clone's origin; merging a pull request into it is your confirmation\n" +
        '  language    English (en), for reports, the verify page and the terminal\n' +
        '              pnpm kiss-sign init --language en|zh-TW changes it\n',
    ),
    result.stdout,
  );
});

test('init records the language, prints in it, keeps it when run again without --language, changes it with one even without --safe once set up, and refuses any other', async () => {
  const home = freshHome();
  const language = () => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).language;
  const chinese = await run(['init', '--safe', SAFE, '--language', 'zh-TW'], home, undefined, fork);
  assert.equal(chinese.code, 0, chinese.stderr);
  assert.match(chinese.stdout, /^kiss-sign 設定好了\n/);
  assert.match(chinese.stdout, /語言 +繁體中文 \(zh-TW\)，用在報告、verify 頁面和終端機/);
  assert.equal(language(), 'zh-TW');
  assert.equal((await run(['init', '--safe', SAFE], home, undefined, fork)).code, 0);
  assert.equal(language(), 'zh-TW');
  assert.equal((await run(['init', '--language', 'en'], home, undefined, fork)).code, 0);
  assert.equal(language(), 'en');
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).safe, SAFE);
  const unset = await run(['init', '--language', 'en'], freshHome(), undefined, fork);
  assert.equal(unset.code, 64);
  assert.match(unset.stderr, /init needs --safe <address>\./);
  const other = await run(['init', '--safe', SAFE, '--language', 'fr'], home, undefined, fork);
  assert.equal(other.code, 64);
  assert.match(other.stderr, /--language takes en or zh-TW\./);
  assert.equal(language(), 'en');
});

test('a config whose language is neither en nor zh-TW is refused', async () => {
  const home = freshHome();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ chainId: 1, safe: SAFE, repo: 'github.com/signer/kiss-sign', language: 'zh' }));
  const result = await run(['card', 'new', 'morpho/vault-deposit'], home, []);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /config\.json: language must be en or zh-TW/);
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
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), { chainId: 1, safe: SAFE, repo: 'github.com/signer/kiss-sign', language: 'en' });
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
  assert.match(first.stdout, new RegExp(`key file +${keyFile}\\n +created, readable by you only\\n`));
  assert.match(first.stdout, /ALCHEMY_API_KEY +get it at https:\/\/dashboard\.alchemy\.com\/\n +needed by pnpm kiss-sign verify, pnpm kiss-sign card new/);
  assert.match(first.stdout, /ETHERSCAN_API_KEY +get it at https:\/\/etherscan\.io\/myapikey\n +needed by pnpm past-txs, pnpm check-sources and pnpm report/);
  assert.match(first.stdout, new RegExp(`\\n {7}\\$\\{EDITOR:-nano\\} ${keyFile}\\n`));
  assert.match(first.stdout, /\n {5}Or enter each key with the command below; what you type is not shown on screen:\n {7}pnpm kiss-sign key add alchemy\n {7}pnpm kiss-sign key add drpc\n {7}pnpm kiss-sign key add etherscan\n {7}pnpm kiss-sign key add github\n/);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const lines = readFileSync(keyFile, 'utf8').split('\n').filter((line) => !line.startsWith('#') && line !== '');
  assert.deepEqual(lines, ['ALCHEMY_API_KEY=', 'DRPC_API_KEY=', 'ETHERSCAN_API_KEY=', 'GITHUB_TOKEN=']);
  assert.match(
    readFileSync(keyFile, 'utf8'),
    /# GitHub, optional, a fine-grained token with access to public repositories only, read-only from \S+, for pnpm check-sources, pnpm report, pnpm pin-solc and pnpm fetch-erc7730, only to raise the GitHub API rate limit\.\nGITHUB_TOKEN=\n/,
  );

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
  assert.ok(added.stdout.startsWith(`  name     alice\n  address  ${RECIPIENT}\nCheck every character`), added.stdout);
  assert.equal((await run(['book', 'list'], home)).stdout, `alice  ${RECIPIENT}\n`);
});

test('card seal prints every name with its full address and stores the card under its hash on yes', async () => {
  const home = freshHome();
  configure(home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc-v2-0f51', amount: '5', 'min-shares': '4' } }] }));
  const sealed = await run(['card', 'seal', card], home, ['y']);
  assert.equal(sealed.code, 0, sealed.stderr);
  assert.match(sealed.stdout, /│   vault +steakhouse-prime-usdc-v2-0f51  0xbeef088055857739C12CD3765F20b7679Def0f51\n│   amount +5 base units of usdc\n│   min-shares +4 base units of steakhouse-prime-usdc-v2-0f51\n│\n│ card seal reads no decimals, so token amounts other than ETH are in base units only\n/);
  const hash = /Sealed card (0x[0-9a-f]{64})/.exec(sealed.stdout)?.[1];
  assert.ok(hash !== undefined && existsSync(join(home, 'cards', `${hash}.json`)));
});

test('a zh-TW home prints card seal in Traditional Chinese with the same names, addresses and prompt ending, and seals the same hash', async () => {
  const card = join(freshHome(), 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc-v2-0f51', amount: '5', 'min-shares': '4' } }] }));
  const [en, zh] = [freshHome(), freshHome()];
  configure(en);
  configure(zh, 'zh-TW');
  const english = await run(['card', 'seal', card], en, ['y']);
  const chinese = await run(['card', 'seal', card], zh, ['y']);
  assert.equal(chinese.code, 0, chinese.stderr);
  assert.match(chinese.stdout, /^┌─ 你的卡片 ─+\n/);
  assert.match(chinese.stdout, /│   vault +steakhouse-prime-usdc-v2-0f51  0xbeef088055857739C12CD3765F20b7679Def0f51\n│   amount +usdc 的 5 最小單位\n/);
  assert.deepEqual([english.asked, chinese.asked], [['Is this what you mean to do? [y/N] '], ['這是你要做的事嗎？[y/N] ']]);
  const hash = (stdout: string, word: string) => new RegExp(`${word} (0x[0-9a-f]{64})`).exec(stdout)?.[1];
  assert.ok(hash(english.stdout, 'Sealed card') !== undefined);
  assert.equal(hash(chinese.stdout, '已密封卡片'), hash(english.stdout, 'Sealed card'));
});

test('a refusal before any config exists is in English, and init --language zh-TW prints its first run in Chinese', async () => {
  const card = join(freshHome(), 'card.json');
  writeFileSync(card, '{}');
  const none = await run(['book', 'list', 'extra'], freshHome());
  assert.equal(none.stderr, 'kiss-sign: book list takes nothing more.\n');
  const zh = freshHome();
  configure(zh, 'zh-TW');
  assert.equal((await run(['book', 'list', 'extra'], zh)).stderr, 'kiss-sign: book list 不接其他參數。\n');
  assert.equal((await run(['book', 'list'], zh)).stdout, '地址簿是空的。\n');
  const first = await run(['init', '--safe', SAFE, '--language', 'zh-TW'], freshHome(), undefined, fork);
  assert.match(first.stdout, /^kiss-sign 設定好了\n  Safe    0x/);
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
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const VAULT_V2_FACTORY = '0xA1D94F746dEfa1928926b84fB2596c06926C0405';
const HEAD = 21_000_000;
const HEAD_HASH = `0x${'ab'.repeat(32)}`;

const PREVIEW_DEPOSIT = '0xef8b30f7';
const PREVIEW_WITHDRAW = '0x0a28a477';
const PREVIEW_REDEEM = '0x4cdad506';
const BALANCE_OF = '0x70a08231';

type Views = (provider: 'alchemy' | 'drpc', to: string, selector: string, arg: bigint) => bigint | 'revert' | undefined;

/** Steakhouse answers each preview at 0.98 shares per usdc unit times 1e12, and a Safe balance of 2 shares. */
const steakhouseViews: Views = (_provider, to, selector, arg) => {
  if (to.toLowerCase() !== STEAKHOUSE.toLowerCase()) return undefined;
  if (selector === PREVIEW_DEPOSIT || selector === PREVIEW_WITHDRAW) return arg * 980_000_000_000n;
  if (selector === PREVIEW_REDEEM) return arg / 1_000_000_000_000n;
  if (selector === BALANCE_OF && arg === BigInt(SAFE)) return 2_000_000_000_000_000_000n;
  return undefined;
};

/** Two providers that answer decimals() per token address and the views `views` answers; `drpc` overrides what drpc answers for decimals(). */
function decimalsChain(alchemy: Record<string, number | 'revert'>, drpc: Record<string, number | 'revert'> = {}, views: Views = steakhouseViews, code = (_provider: string): Hex => VAULT_CODE): Chain & { calls: string[] } {
  const calls: string[] = [];
  const transport: Transport = async (url, body) => {
    const { method, params } = JSON.parse(body) as { method: string; params: unknown[] };
    const reply = (result: unknown) => ({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
    const reverted = { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }) };
    if (method === 'eth_blockNumber') return reply(`0x${HEAD.toString(16)}`);
    if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') return reply({ number: `0x${HEAD.toString(16)}`, hash: HEAD_HASH, timestamp: `0x${NOW.toString(16)}`, gasLimit: '0x1', mixHash: HEAD_HASH });
    const provider = url.includes('drpc') ? 'drpc' : 'alchemy';
    if (method === 'eth_getCode') return reply(code(provider));
    if (method === 'eth_getStorageAt') return reply(`0x${'0'.repeat(64)}`);
    assert.equal(method, 'eth_call');
    const [{ to, data }, at] = params as [{ to: string; data: string }, { blockHash: string }];
    assert.equal(at.blockHash, HEAD_HASH);
    if (data !== '0x313ce567') {
      const answer = views(provider, to, data.slice(0, 10), BigInt(`0x${data.slice(10) || '0'}`));
      assert.ok(answer !== undefined, `${data.slice(0, 10)} on ${to} is not stubbed`);
      return answer === 'revert' ? reverted : reply(`0x${answer.toString(16).padStart(Math.max(1, Math.ceil(answer.toString(16).length / 64)) * 64, '0')}`);
    }
    calls.push(to.toLowerCase());
    const key = Object.keys(alchemy).find((address) => address.toLowerCase() === to.toLowerCase());
    assert.ok(key !== undefined, `decimals() of ${to} is not stubbed`);
    const answer = provider === 'drpc' ? (drpc[key] ?? alchemy[key]) : alchemy[key];
    if (answer === 'revert') return reverted;
    return reply(`0x${BigInt(answer ?? 0).toString(16).padStart(64, '0')}`);
  };
  return { transport, calls };
}

const mainnet = (views?: Views) => decimalsChain({ [USDC]: 6, [STEAKHOUSE]: 18 }, {}, views);

/** The number the prompt lists a name under. */
const numberOf = (name: string) => (stdout: string) => {
  const found = new RegExp(`(\\d+)\\.\\s+${name}\\s`).exec(stdout)?.[1];
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

test('card new computes nothing from a block more than five minutes from the clock', async () => {
  for (const [clock, said] of [[NOW + 301, /301 s behind/], [NOW - 301, /301 s after/]] as const) {
    const home = freshHome();
    configure(home);
    const made = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'y'], { ...mainnet(), clock });
    assert.equal(made.code, 1, made.stdout);
    assert.match(made.stderr, said);
    assert.ok(!existsSync(join(home, 'cards')));
  }
});

test('card new lists a vault with the factory that created it, takes amounts in whole tokens, computes min-shares, and seals base units as card seal would', async () => {
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'y'], mainnet());
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, new RegExp(`\\n +\\d+\\. +steakhouse-prime-usdc-v2-0f51 +${STEAKHOUSE}\\n`));
  assert.match(made.stdout, new RegExp(`\\n +both created by +vault-v2-factory +${VAULT_V2_FACTORY}\\n`));
  assert.equal(made.asked[1], 'amount (whole usdc, 6 decimals): ');
  assert.ok(made.stdout.includes(`\n    token  usdc  ${USDC}  6 decimals\n`), made.stdout);
  assert.ok(made.stdout.includes("\nmin-shares  computed, not asked: the protocol's app fills it in itself\n"));
  assert.match(made.stdout, new RegExp(`\\n    read +previewDeposit\\(5000000\\) = 4900000000000000000\\n +on steakhouse-prime-usdc-v2-0f51  ${STEAKHOUSE}\\n`));
  assert.match(made.stdout, /\n    expected +4\.9 steakhouse-prime-usdc-v2-0f51\n    slippage +0\.10% less than expected: the protocol's default 0\.03% plus a margin of 0\.07%\n    value +4\.8951 steakhouse-prime-usdc-v2-0f51\n    default from +https:\/\/github\.com\/morpho-org\/sdks\/blob\/[0-9a-f]{40}\/packages\/blue-sdk\/src\/constants\.ts#L24\n/);
  assert.match(
    made.stdout,
    new RegExp(`│   vault +steakhouse-prime-usdc-v2-0f51  ${STEAKHOUSE}\\n│   amount +5 usdc\\n│ +5000000 base units\\n│   min-shares +4\\.8951 steakhouse-prime-usdc-v2-0f51\\n│ +4895100000000000000 base units\\n│\\n│ chain reads at block ${HEAD} of 2027-01-15 08:00:00 UTC, where alchemy and drpc agree\\n`),
  );
  assert.match(made.stdout, /\n    margin +The Morpho app prices the deposit again when it builds the transaction/);
  assert.equal(made.stdout.match(/5000000 base units/g)?.length, 1, 'the amount is shown in base units once, in the card');
  assert.equal(made.asked.length, 3);
  assert.equal(made.asked[2], 'Is this what you mean to do? [y/N] ');
  const hash = /Sealed card (0x[0-9a-f]{64})/.exec(made.stdout)?.[1];
  assert.equal(hash, await sealedFile({ vault: 'steakhouse-prime-usdc-v2-0f51', amount: '5000000', 'min-shares': '4895100000000000000' }));
});

test('a zh-TW home shows the template\'s margin reason in Traditional Chinese and seals the same card', async () => {
  const [en, zh] = [freshHome(), freshHome()];
  configure(en);
  configure(zh, 'zh-TW');
  const english = await run(['card', 'new', 'morpho/vault-deposit'], en, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'y'], mainnet());
  const chinese = await run(['card', 'new', 'morpho/vault-deposit'], zh, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'y'], mainnet());
  assert.equal(chinese.code, 0, chinese.stderr);
  assert.match(chinese.stdout, /\n    緩衝 +Morpho app 組交易時會重新計算一次存款價格/);
  assert.doesNotMatch(chinese.stdout, /The Morpho app prices/);
  const hash = (stdout: string, word: string) => new RegExp(`${word} (0x[0-9a-f]{64})`).exec(stdout)?.[1];
  assert.equal(hash(chinese.stdout, '已密封卡片'), hash(english.stdout, 'Sealed card'));
});

/** A copy of main whose morpho/vault-deposit holds each reason as `reason` makes it from the shipped `{ en, zh-TW }`. */
function reasonsClone(reason: (both: Record<string, string>) => unknown): string {
  const dir = dataClone();
  const path = join(dir, 'templates', 'morpho', 'vault-deposit', 'template.json');
  const template = JSON.parse(readFileSync(path, 'utf8'));
  const margin = template.card['min-shares'].computed.margin;
  margin.why = reason(margin.why);
  const [, deposit] = template.calls;
  deposit.trailer.why = reason(deposit.trailer.why);
  const { free } = deposit.args.assetPermit.fields.data;
  free.unread = reason(free.unread);
  writeFileSync(path, JSON.stringify(template, null, 2));
  return publish(dir);
}

test('a reason the template holds only in another language is shown in that language, and a plain string reads as English', async () => {
  const en = freshHome();
  configure(en);
  const zhOnly = await run(['card', 'new', 'morpho/vault-deposit'], en, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'n'], { ...mainnet(), repoRoot: reasonsClone((both) => ({ 'zh-TW': both['zh-TW'] })) });
  assert.match(zhOnly.stdout, /\n    margin +Morpho app 組交易時會重新計算一次存款價格/);
  const zh = freshHome();
  configure(zh, 'zh-TW');
  const plain = await run(['card', 'new', 'morpho/vault-deposit'], zh, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'n'], { ...mainnet(), repoRoot: reasonsClone((both) => both.en) });
  assert.match(plain.stdout, /\n    緩衝 +The Morpho app prices the deposit again/);
});

test('card new reads a computed field\'s inner read first, here the Safe\'s share balance for a withdrawal of all', async () => {
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'morpho/vault-withdraw-all'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), 'y'], { ...mainnet(), repoRoot: withdrawClone() });
  assert.equal(made.code, 0, made.stderr);
  const balance = made.stdout.indexOf(`balanceOf(safe) = 2000000000000000000\n                  on steakhouse-prime-usdc-v2-0f51  ${STEAKHOUSE}\n`);
  const redeem = made.stdout.indexOf(`previewRedeem(2000000000000000000) = 2000000\n                  on steakhouse-prime-usdc-v2-0f51  ${STEAKHOUSE}\n`);
  assert.ok(balance !== -1 && redeem > balance, made.stdout);
  assert.match(made.stdout, /\n    expected +2 usdc\n[\s\S]*\n    value +1\.998 usdc\n[\s\S]*│   min-assets +1\.998 usdc\n│ +1998000 base units\n/);
});

/** A copy of main whose morpho/vault-deposit reads min-shares from a quote on a fixed registry contract, with constant arguments and a tuple answer. */
function quoteClone(): string {
  const dir = dataClone();
  const path = join(dir, 'templates', 'morpho', 'vault-deposit', 'template.json');
  const template = JSON.parse(readFileSync(path, 'utf8'));
  template.card['min-shares'].computed.read = {
    to: { contract: 'steakhouse-prime-usdc-v2-0f51' },
    function: QUOTE.signature,
    args: { i: { const: '-1' }, dx: { card: 'amount' }, who: { safe: true } },
    output: 'best.shares',
  };
  writeFileSync(path, JSON.stringify(template, null, 2));
  return publish(dir);
}

const QUOTE = { signature: 'quote(int128 i, uint256 dx, address who) returns (uint256 low, (uint256 shares, uint128 fee) best)', selector: parseFunctionSignature('quote(int128,uint256,address)').selector };
const WORD = 1n << 256n;

/** The quote answers three words, low, shares and fee, when it is asked for -1, 5000000 and the Safe; `words` cuts the answer short. */
const quoteViews = (words: number): Views => (_provider, to, selector, arg) => {
  if (to.toLowerCase() !== STEAKHOUSE.toLowerCase() || selector !== QUOTE.selector) return undefined;
  assert.equal(arg, ((WORD - 1n) * WORD + 5_000_000n) * WORD + BigInt(SAFE), 'i is -1 in two\'s complement, dx the amount, who the Safe');
  const answer = [1n, 4_900_000_000_000_000_000n, 7n].slice(0, words);
  return answer.reduce((all, word) => all * WORD + word, 0n);
};

test('card new reads a computed field from a fixed registry contract with constant arguments, and picks one number from a tuple answer', async () => {
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'y'], { ...mainnet(quoteViews(3)), repoRoot: quoteClone() });
  assert.equal(made.code, 0, made.stderr);
  assert.ok(made.stdout.includes(`\n    read          quote(-1, 5000000, safe) = 4900000000000000000\n                  on steakhouse-prime-usdc-v2-0f51  ${STEAKHOUSE}\n`), made.stdout);
  assert.match(made.stdout, /│   min-shares +4\.8951 steakhouse-prime-usdc-v2-0f51\n│ +4895100000000000000 base units\n/);
});

test('card new refuses a read whose answer is not the encoding of what the function returns, and seals nothing', async () => {
  const home = freshHome();
  configure(home);
  const result = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'y'], { ...mainnet(quoteViews(2)), repoRoot: quoteClone() });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot read quote\(-1, 5000000, safe\) on steakhouse-prime-usdc-v2-0f51 0xbeef\S+: its answer is not the encoding of \(uint256,\(uint256,uint128\)\)/);
  assert.equal(existsSync(join(home, 'cards')), false);
});

test('card new rounds a ceiling up, as a withdrawal\'s max-shares', async () => {
  const home = freshHome();
  configure(home);
  const chain = mainnet((_p, to, selector, arg) => (selector === PREVIEW_WITHDRAW && to.toLowerCase() === STEAKHOUSE.toLowerCase() ? arg * 1999n : undefined));
  const made = await run(['card', 'new', 'morpho/vault-withdraw'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), '0.000001', 'y'], { ...chain, repoRoot: withdrawClone() });
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /\n    slippage +0\.10% more than expected/);
  assert.match(made.stdout, /│   max-shares +0\.000000000000002001 steakhouse-prime-usdc-v2-0f51\n│ +2001 base units\n/, made.stdout);
});

for (const [what, views, message] of [
  ['the providers disagree on the preview', ((provider, _to, selector, arg) => (selector === PREVIEW_DEPOSIT ? arg * (provider === 'drpc' ? 2n : 1n) : undefined)) as Views, /cannot read previewDeposit\(5000000\) on steakhouse-prime-usdc-v2-0f51 0xbeef.*: eth_call: alchemy and drpc disagree/],
  ['the preview reverts', ((_p, _to, selector) => (selector === PREVIEW_DEPOSIT ? 'revert' : undefined)) as Views, /cannot read previewDeposit\(5000000\) on .*: it reverted/],
  ['the floor comes to 0', ((_p, _to, selector) => (selector === PREVIEW_DEPOSIT ? 1n : undefined)) as Views, /min-shares comes to 0, which would bound nothing/],
] as const) {
  test(`card new refuses when ${what}, and seals nothing`, async () => {
    const home = freshHome();
    configure(home);
    const result = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'y'], mainnet(views));
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    assert.ok(!result.asked.includes('Is this what you mean to do? [y/N] '));
    assert.equal(existsSync(join(home, 'cards')), false);
  });
}

for (const [what, code, pin, message] of [
  ['runs code its pin does not name', () => '0x01' as Hex, undefined, /steakhouse-prime-usdc-v2-0f51 0xbeef\S+, which a value is read from, is not shown to run the code the registry pins: steakhouse-prime-usdc-v2-0f51 0xbeef\S+ has code hash 0x[0-9a-f]{64} at block 21000000, the registry pins 0x[0-9a-f]{64}/],
  ['runs code the providers disagree on', (provider: string) => (provider === 'drpc' ? '0x01' : VAULT_CODE) as Hex, undefined, /not shown to run the code the registry pins: eth_getCode: alchemy and drpc disagree/],
  ['has no code pin', () => VAULT_CODE, 'none', /not shown to run the code the registry pins: .* has no code pin in the registry/],
  ['delegates, though its pin names no implementation', () => `0x363d3d373d3d3d363d73${'11'.repeat(20)}5af43d82803e903d91602b57fd5bf3` as Hex, 'clone', /not shown to run the code the registry pins: .* delegates to 0x1{40} at block 21000000, the registry pins no implementation/],
] as const) {
  test(`card new refuses to compute a value from a contract that ${what}, calls nothing on it, and seals nothing`, async () => {
    const home = freshHome();
    configure(home);
    const served = code as (provider: string) => Hex;
    const repoRoot = repinned(dataClone(), 'steakhouse-prime-usdc-v2-0f51', pin === 'none' ? undefined : { hash: keccakCode(pin === 'clone' ? served('alchemy') : VAULT_CODE), from: 0 });
    const views: Views = (_provider, _to, selector) => assert.fail(`${selector} was called`);
    const result = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'y'], { ...decimalsChain({ [USDC]: 6, [STEAKHOUSE]: 18 }, {}, views, served), repoRoot });
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    assert.equal(existsSync(join(home, 'cards')), false);
  });
}

test('card new refuses to compute a value from a contract one of whose dependsOn entries runs other code than its pin names', async () => {
  const home = freshHome();
  configure(home);
  const repoRoot = dataClone();
  const path = join(repoRoot, 'registry', 'contracts.json');
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  const [dependency] = Object.entries<{ kind: string; code?: object; dependsOn?: string[] }>(registry).find(([, entry]) => entry.kind === 'router' && entry.code !== undefined && entry.dependsOn === undefined)!;
  registry['steakhouse-prime-usdc-v2-0f51'].dependsOn = [dependency];
  writeFileSync(path, JSON.stringify(registry, null, 2));
  const result = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'y'], { ...mainnet(), repoRoot });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not shown to run the code the registry pins: .* has code hash 0x[0-9a-f]{64} at block 21000000/);
});

const MARKET_PARTS = ['morpho-blue', 'usdc', 'cbbtc', 'morpho-oracle-cbbtc-usdc-86', 'adaptive-curve-irm'];
for (const [what, changed, read] of [
  ['the token a card field\'s attribute names', 'usdc', { to: { card: 'vault' }, function: 'quote(address asset) returns (uint256 shares)', args: { asset: { card: 'vault.asset' } } }],
  ['a registry contract an argument names', 'usdc', { to: { card: 'vault' }, function: 'quote(address asset) returns (uint256 shares)', args: { asset: { contract: 'usdc' } } }],
  ['the oracle of a market it reads', 'morpho-oracle-cbbtc-usdc-86', { to: { card: 'market.lending' }, function: 'position(bytes32 id, address user) returns (uint256 shares)', args: { id: { card: 'market.id' }, user: { safe: true } } }],
  ['the rate model of a market an argument names', 'adaptive-curve-irm', { to: { card: 'vault' }, function: 'quote(bytes32 id) returns (uint256 shares)', args: { id: { card: 'market.id' } } }],
] as const) {
  test(`card new refuses to compute a value when ${what} runs other code than its pin names`, async () => {
    const home = freshHome();
    configure(home);
    const dir = dataClone();
    for (const name of MARKET_PARTS) if (name !== changed) repinned(dir, name, { hash: keccakCode(VAULT_CODE), from: 0 });
    const path = join(dir, 'templates', 'morpho', 'vault-deposit', 'template.json');
    const template = JSON.parse(readFileSync(path, 'utf8'));
    const reading = JSON.stringify(read).includes('market.');
    if (reading) template.card.market = { kind: 'market' };
    template.card['min-shares'].computed.read = read;
    writeFileSync(path, JSON.stringify(template, null, 2));
    const result = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), ...(reading ? ['usdc-cbbtc-86'] : []), '5', 'y'], { ...mainnet(() => 5_000_000_000_000_000_000n), repoRoot: publish(dir) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`not shown to run the code the registry pins: ${changed} 0x\\S+ has code hash`));
    assert.equal(existsSync(join(home, 'cards')), false);
  });
}

test('card new takes commas between thousands, as the protocol\'s app shows an amount', async () => {
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), '1,000,611.448606', 'y'], mainnet());
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /│   amount +1,000,611\.448606 usdc\n│ +1000611448606 base units\n/);
});

test('card new and card seal stop before asking anything when templates or registry here are behind main on GitHub', async () => {
  const repoRoot = publish(dataClone());
  const before = git(repoRoot, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(repoRoot, 'registry', 'contracts.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(repoRoot, 'registry', 'contracts.json'), 'utf8')) }, null, 1));
  publish(repoRoot);
  git(repoRoot, 'reset', '--quiet', '--hard', before);
  const home = freshHome();
  configure(home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'eth/transfer', values: { amount: '1', recipient: 'safe' } }] }));
  for (const argv of [['card', 'new', 'eth/transfer'], ['card', 'seal', card]]) {
    const result = await run(argv, home, ['1', '1', 'y'], { ...noChain, repoRoot, unpublished: true });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'kiss-sign: templates/ and registry/ here are not main of github.com/signer/kiss-sign on GitHub; run git pull, then run this again.\n  changed: registry/contracts.json\n');
    assert.deepEqual(result.asked, []);
    assert.equal(result.stdout, '');
  }
  git(repoRoot, 'merge', '--quiet', '--ff-only', 'origin/main');
  writeFileSync(join(repoRoot, 'templates', 'extra.json'), '{}\n');
  const untracked = await run(['card', 'seal', card], home, ['y'], { ...noChain, repoRoot, unpublished: true });
  assert.equal(untracked.code, 1);
  assert.match(untracked.stderr, /run git pull, then run this again\.\n  not on main: templates\/extra\.json\n$/);
  rmSync(join(repoRoot, 'templates', 'extra.json'));
  const sealed = await run(['card', 'seal', card], home, ['y'], { ...noChain, repoRoot, unpublished: true });
  assert.equal(sealed.code, 0, sealed.stderr);
  git(repoRoot, 'config', 'core.sshCommand', 'false');
  const offline = await run(['card', 'seal', card], home, ['y'], { ...noChain, repoRoot, unpublished: true });
  assert.equal(offline.code, 1);
  assert.equal(offline.stderr, 'kiss-sign: could not check that templates/ and registry/ here are main of github.com/signer/kiss-sign on GitHub, so nothing was asked.\n  could not fetch github.com/signer/kiss-sign\n');
  assert.deepEqual(offline.asked, []);
});

test('card new reads each token\'s decimals once across operations', async () => {
  const home = freshHome();
  configure(home);
  const chain = mainnet();
  const vault = numberOf('steakhouse-prime-usdc-v2-0f51');
  const made = await run(['card', 'new', 'morpho/vault-deposit', 'morpho/vault-withdraw'], home, [vault, '1.25', vault, '0.000001', 'y'], { ...chain, repoRoot: withdrawClone() });
  assert.equal(made.code, 0, made.stderr);
  assert.ok(made.stdout.includes('\nOperation 1 of 2: morpho/vault-deposit\n') && made.stdout.includes('\nOperation 2 of 2: morpho/vault-withdraw\n'), made.stdout);
  assert.match(made.stdout, /│ 1\. morpho\/vault-deposit\n[^]*?│   amount +1\.25 usdc\n│ +1250000 base units\n[^]*│ 2\. morpho\/vault-withdraw\n[^]*?│   amount +0\.000001 usdc\n│ +1 base units\n/);
  assert.deepEqual(chain.calls.toSorted(), [STEAKHOUSE, STEAKHOUSE, USDC, USDC].map((a) => a.toLowerCase()).toSorted());
});

test('card new asks for a choice by its number, and takes its exact listed name or full address too', async () => {
  for (const pick of [numberOf('steakhouse-prime-usdc-v2-0f51'), 'steakhouse-prime-usdc-v2-0f51', STEAKHOUSE.toLowerCase(), STEAKHOUSE.toUpperCase().replace('0X', '0x')]) {
    const home = freshHome();
    configure(home);
    const made = await run(['card', 'new', 'morpho/vault-deposit'], home, [pick, '5', 'y'], mainnet());
    assert.equal(made.code, 0, made.stderr);
    assert.match(made.asked[0]!, /^vault: type its number \(1-\d+\): $/);
    assert.match(made.stdout, new RegExp(`│   vault +steakhouse-prime-usdc-v2-0f51  ${STEAKHOUSE}`));
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
  assert.equal(made.asked[1], 'amount (whole ETH, 18 decimals): ');
  assert.match(made.stdout, /│   amount +0\.5 ETH\n│ +500000000000000000 base units\n/);
});

test('card new in a zh-TW home asks in Traditional Chinese, with the same prompt endings and the same card hash', async () => {
  const sealed: string[] = [];
  for (const language of ['en', 'zh-TW']) {
    const home = freshHome();
    configure(home, language);
    await run(['book', 'add', 'alice', RECIPIENT], home, ['y']);
    const made = await run(['card', 'new', 'eth/transfer'], home, [numberOf('alice'), '0.5', 'y'], { ...noChain, env: {} });
    assert.equal(made.code, 0, made.stderr);
    assert.ok(made.asked.every((question, i) => /\(1-[0-9]+\): $|\): $|\[y\/N\] $/.test(question)), made.asked.join('|'));
    if (language === 'zh-TW') {
      assert.deepEqual(made.asked.slice(1), ['amount (整顆 ETH 的數量，18 位小數): ', '這是你要做的事嗎？[y/N] ']);
      assert.match(made.asked[0]!, /^recipient：輸入編號 \(1-\d+\): $/);
      assert.match(made.stdout, /│   amount +0\.5 ETH\n│ +500000000000000000 最小單位\n/);
    }
    sealed.push(/(0x[0-9a-f]{64})\n$/.exec(made.stdout)?.[1] ?? '');
  }
  assert.equal(sealed[0], sealed[1]);
});

test('--language=zh-TW sets the language of a first init, and a config that cannot be read leaves refusals in English', async () => {
  const first = await run(['init', '--safe', SAFE, '--language=zh-TW'], freshHome(), undefined, fork);
  assert.match(first.stdout, /^kiss-sign 設定好了\n/);
  const broken = freshHome();
  writeFileSync(join(broken, 'config.json'), '{"chainId": 1, "language": "zh-TW"}');
  assert.equal((await run(['book', 'list', 'extra'], broken)).stderr, 'kiss-sign: book list takes nothing more.\n');
});

test('card new refuses a typed 0 where card seal would, says why in the signer\'s language, and asks again', async () => {
  const swapping = async (language: string) => {
    const home = freshHome();
    configure(home, language);
    const made = await run(['card', 'new', 'cow/swap'], home, [numberOf('usdc'), numberOf('usdt'), '1', '0', '0.5', 'y'], decimalsChain({ [USDC]: 6, [USDT]: 6 }));
    assert.equal(made.code, 0, made.stderr);
    assert.equal(made.asked[3], made.asked[4]);
    assert.match(made.stdout, /│   min-buy +0\.5 usdt\n│ +500000 /);
    return made;
  };
  const english = await swapping('en');
  assert.equal(english.asked[3], 'min-buy (whole usdt, 6 decimals): ');
  assert.ok(english.stdout.replace(/\s+/g, ' ').includes(' min-buy cannot be 0: a share price bound or atLeast compares the transaction with it, and 0 there bounds nothing or nothing can meet it, so card seal would refuse the card. Type an amount above 0. '), english.stdout);
  const chinese = await swapping('zh-TW');
  assert.equal(chinese.asked[3], 'min-buy (整顆 usdt 的數量，6 位小數): ');
  assert.ok(chinese.stdout.replace(/\s+/g, '').includes('min-buy不能是0：份額價格界線或atLeast會拿交易跟它比較，0在這裡不是什麼都不限，就是沒有交易能滿足，所以cardseal會拒絕這張卡片。請輸入大於0的數量。'), chinese.stdout);
});

test('card new offers a transfer recipient only from the address book or the Safe', async () => {
  const home = freshHome();
  configure(home);
  await run(['book', 'add', 'alice', RECIPIENT], home, ['y']);
  const made = await run(['card', 'new', 'erc20/transfer'], home, [numberOf('usdc'), numberOf('alice'), '1', 'y'], mainnet());
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, new RegExp(`\\nrecipient  pick one by number\\n  1\\.  safe   this Safe     ${SAFE}\\n  2\\.  alice  address book  ${RECIPIENT}\\n`));
  assert.match(made.stdout, new RegExp(`│   amount +1 usdc\\n│ +1000000 base units\\n│   recipient +alice \\(address book\\)  ${RECIPIENT}\\n`));
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
  assert.match(made.stdout, /│   amount +5 base units\n/);
});

function withdrawClone(): string {
  const dir = dataClone();
  for (const template of ['morpho/vault-withdraw', 'morpho/vault-withdraw-all']) {
    cpSync(join(FIXTURE_TEMPLATES, template), join(dir, 'templates', template), { recursive: true });
    reportVault(dir, template, 'steakhouse-prime-usdc-v2-0f51');
  }
  return publish(dir);
}

/** A report for `vault` under the template, as `pnpm report --instance-of` writes it; the gate reads only that the file is there. */
function reportVault(repoRoot: string, template: string, vault: string): void {
  mkdirSync(join(repoRoot, 'templates', template, 'instances', vault), { recursive: true });
  writeFileSync(join(repoRoot, 'templates', template, 'instances', vault, 'report.generated.md'), '# report\n');
}

test('card new lists only the vaults with a report for a template reported per vault', async () => {
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'morpho/vault-deposit'], home, ['smokehouse-usdc-v1-f5bc'], mainnet());
  assert.equal(made.code, 1);
  const listed = [...made.stdout.matchAll(/^ *\d+\.\s+([a-z0-9.-]+)\s/gm)].map((m) => m[1]);
  assert.deepEqual(listed, ['steakhouse-prime-usdc-v2-0f51', 'hyperithm-usdc-apex-v2-9e2f']);
  assert.match(made.stderr, /vault: "smokehouse-usdc-v1-f5bc" is none of the listed choices/);
});

test('card new takes a Vault V2 cap as max or in whole tokens and a relative cap as a percent, and seals them in base units', async () => {
  const home = freshHome();
  configure(home);
  const id = '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64';
  const made = await run(['card', 'new', 'morpho/vault-v2-cap-submit'], home, ['flowmark-fgenesis-v2-6439', id, 'max', '35.5', 'y'], decimalsChain({ [USDC]: 6 }));
  assert.equal(made.code, 0, made.stderr);
  assert.equal(made.asked[2], 'absolute-cap (whole usdc, 6 decimals, or max): ');
  assert.equal(made.asked[3], 'relative-cap (a percent, 100 at most, such as 100 or 35.5): ');
  assert.ok(made.stdout.includes('\n    max  2^128-1 is the largest absolute cap Vault V2 can store; '), made.stdout);
  assert.match(made.stdout, /│   absolute-cap +340,282,366,920,938,463,463,374,607,431,768\.211455 usdc\n│ +340282366920938463463374607431768211455 base units\n/, made.stdout);
  assert.match(made.stdout, /│   relative-cap +35\.5%\n│ +355000000000000000 base units, 100% being 10\^18\n/, made.stdout);
  assert.match(made.stdout, /Sealed card 0x[0-9a-f]{64}/);
  const other = freshHome();
  configure(other);
  const refused = await run(['card', 'new', 'morpho/vault-v2-cap-submit'], other, ['flowmark-fgenesis-v2-6439', id, '5', '100.5'], decimalsChain({ [USDC]: 6 }));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /relative-cap: "100\.5" is more than 100 percent/);
});

test('card new refuses a template reported per instance when no instance has a report', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'kiss-sign-repo-'));
  cpSync(join(ROOT, 'registry'), join(repoRoot, 'registry'), { recursive: true });
  cpSync(join(ROOT, 'templates', 'morpho', 'vault-deposit', 'template.json'), join(repoRoot, 'templates', 'morpho', 'vault-deposit', 'template.json'));
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'morpho/vault-deposit'], home, ['1'], { ...mainnet(), repoRoot });
  assert.equal(made.code, 1);
  assert.match(made.stderr, /vault: no vault the card can name has a report for morpho\/vault-deposit; build one first/);
  assert.deepEqual(made.asked, []);
});

test('card seal refuses a vault with no report for the template, before it asks anything', async () => {
  const home = freshHome();
  configure(home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'morpho/vault-deposit', values: { vault: 'smokehouse-usdc-v1-f5bc', amount: '5', 'min-shares': '4' } }] }));
  const result = await run(['card', 'seal', card], home, ['y']);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'kiss-sign: card refused: smokehouse-usdc-v1-f5bc has no report for morpho/vault-deposit; build one first\n');
  assert.deepEqual(result.asked, []);
  assert.equal(existsSync(join(home, 'cards')), false);
});

test('card seal refuses a hand-written card whose computed floor is 0, in the signer\'s language, before it asks anything', async () => {
  const sealing = async (language: string, values: Record<string, string>) => {
    const home = freshHome();
    configure(home, language);
    const card = join(home, 'card.json');
    writeFileSync(card, JSON.stringify({ operations: [{ template: 'morpho/vault-deposit', values: { vault: 'steakhouse-prime-usdc-v2-0f51', ...values } }] }));
    const result = await run(['card', 'seal', card], home, ['y']);
    assert.deepEqual(result.asked, []);
    assert.equal(existsSync(join(home, 'cards')), false);
    return result;
  };
  const english = await sealing('en', { amount: '5000000', 'min-shares': '0' });
  assert.equal(english.code, 1);
  assert.equal(
    english.stderr,
    'kiss-sign: card refused at operations[0].values.min-shares: min-shares is 0; a computed amount, or one a share price bound or atLeast compares with, must be at least 1, since 0 there bounds nothing or nothing can meet it\n',
  );
  const chinese = await sealing('zh-TW', { amount: '5000000', 'min-shares': '0' });
  assert.equal(chinese.stderr, 'kiss-sign: 卡片在 operations[0].values.min-shares 被拒絕：min-shares 是 0；算出來的數量，或份額價格界線、atLeast 拿來比較的數量，至少要是 1，因為 0 在這裡不是什麼都不限，就是沒有交易能滿足\n');
  const amount = await sealing('en', { amount: '0', 'min-shares': '1' });
  assert.match(amount.stderr, /card refused at operations\[0\]\.values\.amount: amount is 0; a computed amount/);
});

test('card seal does not count a report reached through a symlinked folder, which git would not list', async () => {
  const repoRoot = anyTokenClone();
  const elsewhere = mkdtempSync(join(tmpdir(), 'kiss-sign-elsewhere-'));
  reportVault(elsewhere, 'test/any-token', 'smokehouse-usdc-v1-f5bc');
  mkdirSync(join(repoRoot, 'templates', 'test', 'any-token', 'instances'));
  symlinkSync(join(elsewhere, 'templates', 'test', 'any-token', 'instances', 'smokehouse-usdc-v1-f5bc'), join(repoRoot, 'templates', 'test', 'any-token', 'instances', 'smokehouse-usdc-v1-f5bc'));
  const home = freshHome();
  configure(home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'test/any-token', values: { token: 'smokehouse-usdc-v1-f5bc', amount: '5', recipient: 'safe' } }] }));
  const instanceLink = await run(['card', 'seal', card], home, ['y'], { ...noChain, repoRoot });
  assert.equal(instanceLink.stderr, 'kiss-sign: card refused: smokehouse-usdc-v1-f5bc has no report for test/any-token; build one first\n');
  const linked = anyTokenClone();
  symlinkSync(join(elsewhere, 'templates', 'test', 'any-token', 'instances'), join(linked, 'templates', 'test', 'any-token', 'instances'));
  const folderLink = await run(['card', 'seal', card], home, ['y'], { ...noChain, repoRoot: linked });
  assert.equal(folderLink.stderr, 'kiss-sign: card refused: smokehouse-usdc-v1-f5bc has no report for test/any-token; build one first\n');
});

/** A clone whose `test/any-token` template takes its token through an address field, which may name any registry entry. */
function anyTokenClone(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'kiss-sign-repo-'));
  cpSync(join(ROOT, 'registry'), join(repoRoot, 'registry'), { recursive: true });
  const transfer = JSON.parse(readFileSync(join(ROOT, 'templates', 'erc20', 'transfer', 'template.json'), 'utf8'));
  mkdirSync(join(repoRoot, 'templates', 'test', 'any-token'), { recursive: true });
  writeFileSync(join(repoRoot, 'templates', 'test', 'any-token', 'template.json'), JSON.stringify({ ...transfer, id: 'test/any-token', card: { ...transfer.card, token: { kind: 'address' } } }));
  return repoRoot;
}

test('card seal refuses a vault named through an address field unless the template has a report for it', async () => {
  const repoRoot = anyTokenClone();
  const home = freshHome();
  configure(home);
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'test/any-token', values: { token: 'smokehouse-usdc-v1-f5bc', amount: '5', recipient: 'safe' } }] }));
  const refused = await run(['card', 'seal', card], home, ['y'], { ...noChain, repoRoot });
  assert.equal(refused.code, 1);
  assert.equal(refused.stderr, 'kiss-sign: card refused: smokehouse-usdc-v1-f5bc has no report for test/any-token; build one first\n');
  assert.deepEqual(refused.asked, []);
  reportVault(repoRoot, 'test/any-token', 'smokehouse-usdc-v1-f5bc');
  const sealed = await run(['card', 'seal', card], home, ['y'], { ...noChain, repoRoot });
  assert.equal(sealed.code, 0, sealed.stderr);
});

test('card new lists and card seal accepts an instance whose report is under instances/', async () => {
  const repoRoot = anyTokenClone();
  reportVault(repoRoot, 'test/any-token', 'steakhouse-prime-usdc-v2-0f51');
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'test/any-token'], home, ['smokehouse-usdc-v1-f5bc'], { ...decimalsChain({}), repoRoot });
  const listed = [...made.stdout.matchAll(/^ *\d+\.\s+([a-z0-9.-]+)\s/gm)].map((m) => m[1]);
  assert.ok(listed.includes('steakhouse-prime-usdc-v2-0f51') && !listed.includes('smokehouse-usdc-v1-f5bc'), listed.join());
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'test/any-token', values: { token: 'steakhouse-prime-usdc-v2-0f51', amount: '5', recipient: 'safe' } }] }));
  const sealed = await run(['card', 'seal', card], home, ['y'], { ...noChain, repoRoot });
  assert.equal(sealed.code, 0, sealed.stderr);
});

test('a report under vaults/, the folder per-instance reports left, is not found: card new does not list the instance and card seal refuses it', async () => {
  const repoRoot = anyTokenClone();
  reportVault(repoRoot, 'test/any-token', 'steakhouse-prime-usdc-v2-0f51');
  mkdirSync(join(repoRoot, 'templates', 'test', 'any-token', 'vaults', 'smokehouse-usdc-v1-f5bc'), { recursive: true });
  writeFileSync(join(repoRoot, 'templates', 'test', 'any-token', 'vaults', 'smokehouse-usdc-v1-f5bc', 'report.generated.md'), '# report\n');
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'test/any-token'], home, ['smokehouse-usdc-v1-f5bc'], { ...decimalsChain({}), repoRoot });
  const listed = [...made.stdout.matchAll(/^ *\d+\.\s+([a-z0-9.-]+)\s/gm)].map((m) => m[1]);
  assert.ok(listed.includes('steakhouse-prime-usdc-v2-0f51') && !listed.includes('smokehouse-usdc-v1-f5bc'), listed.join());
  const card = join(home, 'card.json');
  writeFileSync(card, JSON.stringify({ operations: [{ template: 'test/any-token', values: { token: 'smokehouse-usdc-v1-f5bc', amount: '5', recipient: 'safe' } }] }));
  const refused = await run(['card', 'seal', card], home, ['y'], { ...noChain, repoRoot });
  assert.equal(refused.code, 1);
  assert.equal(refused.stderr, 'kiss-sign: card refused: smokehouse-usdc-v1-f5bc has no report for test/any-token; build one first\n');
  assert.deepEqual(refused.asked, []);
});

test('card new does not offer a vault with no report for the template through an address field', async () => {
  const repoRoot = anyTokenClone();
  reportVault(repoRoot, 'test/any-token', 'steakhouse-prime-usdc-v2-0f51');
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'test/any-token'], home, ['smokehouse-usdc-v1-f5bc'], { ...decimalsChain({}), repoRoot });
  assert.equal(made.code, 1);
  const listed = [...made.stdout.matchAll(/^ *\d+\.\s+([a-z0-9.-]+)\s/gm)].map((m) => m[1]);
  assert.ok(listed.includes('steakhouse-prime-usdc-v2-0f51') && listed.includes('usdc'), listed.join());
  assert.ok(!listed.includes('smokehouse-usdc-v1-f5bc'), 'a vault with no report is not listed');
  assert.match(made.stderr, /token: "smokehouse-usdc-v1-f5bc" is none of the listed choices/);
});

test('card new lists only the entries of the protocol a contract field names, and refuses any other', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'kiss-sign-repo-'));
  cpSync(join(ROOT, 'registry'), join(repoRoot, 'registry'), { recursive: true });
  const fluid = JSON.parse(readFileSync(join(ROOT, 'templates', 'fluid', 'vault-deposit', 'template.json'), 'utf8'));
  mkdirSync(join(repoRoot, 'templates', 'test', 'fluid-only'), { recursive: true });
  const template = { ...fluid, id: 'test/fluid-only', card: { ...fluid.card, vault: { kind: 'contract', registryKind: 'vault', defillama: 'fluid-lending' } } };
  writeFileSync(join(repoRoot, 'templates', 'test', 'fluid-only', 'template.json'), JSON.stringify(template));
  for (const vault of ['fluid-fusdc', 'fluid-fusdt', 'steakhouse-prime-usdc-v2-0f51']) reportVault(repoRoot, 'test/fluid-only', vault);
  const home = freshHome();
  configure(home);
  const made = await run(['card', 'new', 'test/fluid-only'], home, ['steakhouse-prime-usdc-v2-0f51'], { ...mainnet(), repoRoot });
  assert.equal(made.code, 1);
  assert.match(made.stdout, /\nvault  pick one by number\n  1\.  fluid-fusdc  0x\w{40}\n  2\.  fluid-fusdt  0x\w{40}\n      both created by  fluid-lending-factory  0x\w{40}\n/);
  assert.match(made.stderr, /vault: "steakhouse-prime-usdc-v2-0f51" is none of the listed choices/);
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
    `id               ${id}`,
    `lending          morpho-blue                  ${added['morpho-blue'].address}`,
    `loanToken        usdc                         ${USDC}`,
    `collateralToken  cbbtc                        ${added.cbbtc.address}`,
    `oracle           morpho-oracle-cbbtc-usdc-86  ${added['morpho-oracle-cbbtc-usdc-86'].address}`,
    `irm              adaptive-curve-irm           ${added['adaptive-curve-irm'].address}`,
  ];
  assert.ok(made.stdout.includes(`\nmarket  pick one by number\n  1.  usdc-cbbtc-86  lltv 0.86 (860000000000000000)\n${parts.map((line) => `      ${line}\n`).join('')}`), made.stdout);
  assert.equal(made.asked[1], 'amount (whole usdc, 6 decimals): ');
  assert.ok(made.stdout.includes(`│   market  usdc-cbbtc-86  lltv 0.86 (860000000000000000)\n${parts.map((line) => `│     ${line}\n`).join('')}│   amount  2.5 usdc\n│           2500000 base units\n`), made.stdout);
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
  const made = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), MAX_USDC, 'y'], mainnet(() => 10n ** 30n));
  assert.equal(made.code, 0, made.stderr);
  const [, whole, base] = /│   amount +([\d,.]+) usdc (\d+) base units\n/.exec(made.stdout.replaceAll(/\n│ {14,}/g, ' ')) ?? [];
  assert.deepEqual([whole?.replaceAll(',', ''), base], [MAX_USDC, `${2n ** 256n - 1n}`]);
});

for (const [what, answers, message] of [
  ['a number past the list', ['9999', '5', 'y'], /vault: "9999" is none of the listed choices; type the number in front of the one you mean \(1-\d+\)/],
  ['zero', ['0', '5', 'y'], /vault: "0" is none of the listed choices/],
  ['an empty answer', ['', '5', 'y'], /vault: "" is none of the listed choices/],
  ['a name that is not listed', ['steakhouse', '5', 'y'], /vault: "steakhouse" is none of the listed choices/],
  ['a listed name in another case', ['Steakhouse-Prime-USDC', '5', 'y'], /vault: "Steakhouse-Prime-USDC" is none of the listed choices/],
  ['part of a listed address', [STEAKHOUSE.slice(0, 20), '5', 'y'], /is none of the listed choices/],
  ['more fractional digits than usdc has decimals', [numberOf('steakhouse-prime-usdc-v2-0f51'), '1.0000001', 'y'], /amount: "1.0000001" has more than 6 digits after the point, and usdc has 6 decimals/],
  ['a negative amount', [numberOf('steakhouse-prime-usdc-v2-0f51'), '-5', 'y'], /amount: "-5" is not a plain decimal number/],
  ['an empty amount', [numberOf('steakhouse-prime-usdc-v2-0f51'), '', 'y'], /amount: "" is not a plain decimal number/],
  ['a hex amount', [numberOf('steakhouse-prime-usdc-v2-0f51'), '0x10', 'y'], /amount: "0x10" is not a plain decimal number/],
  ['an amount with an exponent', [numberOf('steakhouse-prime-usdc-v2-0f51'), '5e6', 'y'], /amount: "5e6" is not a plain decimal number/],
  ['an amount with a plus sign', [numberOf('steakhouse-prime-usdc-v2-0f51'), '+5', 'y'], /amount: "\+5" is not a plain decimal number/],
  ['an amount with a comma that does not separate thousands', [numberOf('steakhouse-prime-usdc-v2-0f51'), '1,5', 'y'], /amount: "1,5" is not a plain decimal number/],
  ['an amount with a group of two digits', [numberOf('steakhouse-prime-usdc-v2-0f51'), '1,00', 'y'], /amount: "1,00" is not a plain decimal number/],
  ['an amount with a first group of four digits', [numberOf('steakhouse-prime-usdc-v2-0f51'), '1000,000', 'y'], /amount: "1000,000" is not a plain decimal number/],
  ['an amount with a leading comma', [numberOf('steakhouse-prime-usdc-v2-0f51'), ',100', 'y'], /amount: ",100" is not a plain decimal number/],
  ['an amount with a first group of 0', [numberOf('steakhouse-prime-usdc-v2-0f51'), '0,100', 'y'], /amount: "0,100" is not a plain decimal number/],
  ['an amount with a comma after the point', [numberOf('steakhouse-prime-usdc-v2-0f51'), '1.000,5', 'y'], /amount: "1.000,5" is not a plain decimal number/],
  ['an amount mixing grouped and ungrouped thousands', [numberOf('steakhouse-prime-usdc-v2-0f51'), '1,0000', 'y'], /amount: "1,0000" is not a plain decimal number/],
  ['an amount with no digit before the point', [numberOf('steakhouse-prime-usdc-v2-0f51'), '.5', 'y'], /amount: ".5" is not a plain decimal number/],
  ['an amount with no digit after the point', [numberOf('steakhouse-prime-usdc-v2-0f51'), '5.', 'y'], /amount: "5." is not a plain decimal number/],
  ['an amount of 2^256 base units', [numberOf('steakhouse-prime-usdc-v2-0f51'), OVER_USDC, 'y'], /amount: ".*" is 2\^256 base units or more/],
  ['an amount with far too many digits', [numberOf('steakhouse-prime-usdc-v2-0f51'), '9'.repeat(100), 'y'], /amount: ".*" is 2\^256 base units or more/],
  ['an amount with a leading zero', [numberOf('steakhouse-prime-usdc-v2-0f51'), '05', 'y'], /amount: "05" is not a plain decimal number/],
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
    const result = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', '4', 'y'], chain);
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
  const result = await run(['card', 'new', 'morpho/vault-deposit'], home, [numberOf('steakhouse-prime-usdc-v2-0f51'), '5', 'n'], mainnet());
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Nothing sealed/);
  assert.equal(existsSync(join(home, 'cards')), false);
});
