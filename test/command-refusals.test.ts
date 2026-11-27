import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const SEALED_OFF = pathToFileURL(join(import.meta.dirname, 'sealed-off.ts')).href;

/** Runs a command from `root` with no key, an empty home, and no network. */
function run(root: string, file: string, args: readonly string[]) {
  const sandbox = mkdtempSync(join(tmpdir(), 'kiss-sign-refusal-'));
  try {
    return spawnSync(process.execPath, ['--import', SEALED_OFF, join(root, file), ...args], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: sandbox, KISS_SIGN_HOME: join(sandbox, 'home') },
      encoding: 'utf8',
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const twice = (flag: string): string[] => [`--${flag}`, 'a', `--${flag}=b`];
const repeated = (flag: string): string => `--${flag} is given more than once, and it takes one value\n`;

const SCRIPT_FLAGS: readonly (readonly [script: string, flag: string, args: readonly string[]])[] = [
  ['api-source', 'url', []],
  ['check-sources', 'record', []],
  ['erc7730', 'record', ['usdc']],
  ['find-sources', 'protocol', ['usdc']],
  ['instance-evidence', 'record', []],
  ['notes-needed', 'instance-of', ['erc20/transfer']],
  ['past-txs', 'event-arg', ['uniswap/approve-permit2', '--token', 'usdt', '--anchor', 'event', '--event', 'Approval(address indexed owner, address indexed spender, uint256 value)']],
  ['perturb', 'card', ['some-fixture']],
  ['progress', 'instance', ['erc20/transfer']],
  ['pool-depth', 'min', ['usdc', '--auto']],
  ['prove-instance', 'registry', ['usdc']],
  ['report', 'instance-of', ['erc20/transfer']],
  ['report', 'text', ['erc20/transfer']],
  ['simulate', 'card', ['some-fixture']],
];

for (const [script, flag, args] of SCRIPT_FLAGS) {
  test(`pnpm ${script} refuses --${flag} given twice in one line, before it reads anything`, () => {
    const result = run(ROOT, join('scripts', `${script}.ts`), [...args, ...twice(flag)]);
    assert.equal(result.stderr, repeated(flag));
    assert.equal(result.status, ['api-source', 'find-sources', 'past-txs'].includes(script) ? 64 : 2, 'the exit code of the script\'s other usage errors');
  });
}

test('pnpm find-sources --github-org without GITHUB_TOKEN says code search needs one, before it reads the network', () => {
  const result = run(ROOT, join('scripts', 'find-sources.ts'), ['usdc', '--github-org', 'circlefin']);
  assert.match(result.stderr, /^--github-org needs GITHUB_TOKEN: GitHub's code search answers no request without one\./);
  assert.equal(result.status, 1);
});

test('pnpm api-source refuses an IP literal, a decimal IP or a port with its usage, before it reads the network', () => {
  for (const url of ['https://10.0.0.1/', 'https://2130706433/', 'https://api.example.org:8443/']) {
    const result = run(ROOT, join('scripts', 'api-source.ts'), ['--url', url]);
    assert.match(result.stderr, /^--url: must name a DNS host with no port and no user\nusage: pnpm api-source /);
    assert.equal(result.status, 64);
  }
});

test('pnpm survey refuses --event given twice with its usage', () => {
  const result = run(ROOT, join('scripts', 'survey.ts'), ['usdc', ...twice('event')]);
  assert.ok(result.stderr.startsWith(repeated('event')), result.stderr);
  assert.equal(result.status, 64);
});

test('a flag declared to repeat, such as survey --token, is not refused for repeating', () => {
  const result = run(ROOT, join('scripts', 'survey.ts'), ['usdc', '--token', 'usdc', '--token', 'weth']);
  assert.doesNotMatch(result.stderr, /more than once/);
});

for (const [words, flag] of [[['verify'], 'card'], [['init'], 'safe']] as const) {
  test(`kiss-sign ${words.join(' ')} refuses --${flag} given twice`, () => {
    const result = run(ROOT, join('bin', 'kiss-sign'), [...words, ...twice(flag)]);
    assert.equal(result.stderr, `kiss-sign: --${flag} is given more than once, and it takes one value.\n`);
    assert.equal(result.status, 64);
  });
}

test('kiss-sign refuses a repeated flag in the language the command prints in', () => {
  const result = run(ROOT, join('bin', 'kiss-sign'), ['init', '--language', 'zh-TW', ...twice('safe')]);
  assert.equal(result.stderr, 'kiss-sign: --safe 給了不只一次，但它只接一個值。\n');
  assert.equal(result.status, 64);
});

for (const [script, flag] of [['history', 'out'], ['attacks', 'record']] as const) {
  test(`pnpm ${script} refuses --${flag} given twice`, () => {
    const result = run(ROOT, join('scripts', `${script}.ts`), twice(flag));
    assert.equal(result.stderr, repeated(flag));
    assert.equal(result.status, 1);
  });
}

/** A copy of the program whose registry or template is mid-edit, the rest linked to this checkout. */
function brokenCopy(edit: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-broken-'));
  const copied = ['src', 'scripts', 'registry', 'templates'];
  for (const name of readdirSync(ROOT)) if (!['.git', ...copied].includes(name)) symlinkSync(join(ROOT, name), join(root, name));
  for (const name of copied) cpSync(join(ROOT, name), join(root, name), { recursive: true });
  edit(root);
  return root;
}

const editJson = (path: string, change: (json: Record<string, Record<string, unknown>>) => void): void => {
  const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
  change(json);
  writeFileSync(path, JSON.stringify(json, null, 1));
};

const brokenRegistry = brokenCopy((root) => editJson(join(root, 'registry', 'contracts.json'), (entries) => void (entries.usdc!.address = '0x12')));
const notJson = brokenCopy((root) => writeFileSync(join(root, 'registry', 'contracts.json'), '{\n "usdc": {\n'));
const brokenTemplate = brokenCopy((root) => editJson(join(root, 'templates', 'erc20', 'transfer', 'template.json'), (template) => void (template.card = { amount: { type: 'no-such-type' } })));
after(() => [brokenRegistry, notJson, brokenTemplate].forEach((root) => rmSync(root, { recursive: true, force: true })));

const REGISTRY_READERS: readonly (readonly [script: string, args: readonly string[]])[] = [
  ['check-sources', ['weth']],
  ['erc7730', ['weth']],
  ['find-sources', ['weth']],
  ['instance-evidence', ['weth']],
  ['notes-needed', ['erc20/transfer']],
  ['past-txs', ['erc20/transfer', '--token', 'weth', '--anchor', 'any']],
  ['progress', ['erc20/transfer']],
  ['prove-instance', ['weth']],
  ['report', ['erc20/transfer', '--offline']],
  ['survey', ['weth']],
  ['decode-tx', [`0x${'11'.repeat(32)}`]],
  ['attacks', []],
];

for (const [script, args] of REGISTRY_READERS) {
  test(`pnpm ${script} refuses a registry mid-edit in one line, with no stack trace`, () => {
    const result = run(brokenRegistry, join('scripts', `${script}.ts`), args);
    assert.equal(result.stderr, 'REFUSED  registry: usdc.address: not a 20-byte hex address\n');
    assert.equal(result.status, 1);
  });
}

test('pnpm report refuses a template mid-edit in one line, with no stack trace', () => {
  const result = run(brokenTemplate, join('scripts', 'report.ts'), ['erc20/transfer', '--offline']);
  assert.match(result.stderr, /^REFUSED {2}template: [^\n]+\n$/);
  assert.equal(result.status, 1);
});

test('pnpm report --text reads the last rendered page while the template is mid-edit', () => {
  writeFileSync(join(brokenTemplate, 'templates', 'erc20', 'transfer', 'report.generated.en.html'), '<html><head><title>x</title></head><body><h2>To review</h2><p>the page as last rendered</p></body></html>');
  const result = run(brokenTemplate, join('scripts', 'report.ts'), ['erc20/transfer', '--text', 'en']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'To review\nthe page as last rendered\n');
});

test('a script refuses a registry file that is not JSON in one line', () => {
  const result = run(notJson, join('scripts', 'progress.ts'), ['erc20/transfer']);
  assert.match(result.stderr, /^REFUSED {2}[^\n]*JSON[^\n]*\n$/);
  assert.equal(result.status, 1);
});
