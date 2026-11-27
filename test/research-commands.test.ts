import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parseCard } from '../src/card.ts';
import { baseRepo } from './repo-with-test-fixtures.ts';
import { programWith } from './run-offline.ts';

const ROOT = join(import.meta.dirname, '..');
/** The program with the frozen templates and registry, for the commands a test checks against a template's fields. */
const BASE = programWith(baseRepo());
const SEALED_OFF = pathToFileURL(join(import.meta.dirname, 'sealed-off.ts')).href;

/** Runs a script with no key, an empty home and no network. */
function run(script: string, args: readonly string[], root = ROOT) {
  const sandbox = mkdtempSync(join(tmpdir(), 'kiss-sign-research-'));
  try {
    return spawnSync(process.execPath, ['--import', SEALED_OFF, join(root, 'scripts', `${script}.ts`), ...args], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: sandbox, KISS_SIGN_HOME: join(sandbox, 'home') },
      encoding: 'utf8',
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test('pnpm abi selector and topic print the hash of the canonical signature, names and indexed aside', () => {
  const selector = run('abi', ['selector', 'approve(address spender, uint256 value)']);
  assert.equal(selector.stdout, '0x095ea7b3  approve(address,uint256)\n');
  const topic = run('abi', ['topic', 'Transfer(address indexed from, address indexed to, uint256 value)']);
  assert.equal(topic.stdout, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef  Transfer(address,address,uint256)\n');
});

test('pnpm abi hash gives each Morpho Blue market id of the registry from its parameters, as a tuple or as flat values', () => {
  const markets = JSON.parse(readFileSync(join(ROOT, 'registry', 'markets.json'), 'utf8')) as Record<string, Record<string, string>>;
  for (const [name, m] of Object.entries(markets)) {
    const params = [m.loanToken, m.collateralToken, m.oracle, m.irm, m.lltv] as string[];
    const tuple = run('abi', ['hash', '(address,address,address,address,uint256)', JSON.stringify(params)]);
    assert.equal(tuple.status, 0, tuple.stderr);
    assert.match(tuple.stdout, new RegExp(`^keccak256 ${m.id}  abi\\.encode\\(\\(address,address,address,address,uint256\\)\\)\n`), name);
    assert.match(run('abi', ['hash', 'address,address,address,address,uint256', ...params]).stdout, new RegExp(`^keccak256 ${m.id} `), name);
  }
});

test('pnpm abi hash encodes a tuple holding a dynamic array and a string, and an array of tuples holding bytes, as cast abi-encode does', () => {
  const tuple = run('abi', ['hash', '(address,uint256[],string)', '["0x00000000000000000000000000000000000000aa",["1","2"],"hi"]']);
  assert.equal(tuple.status, 0, tuple.stderr);
  assert.equal(
    tuple.stdout,
    'keccak256 0x50721bf8cfe99835262de27a205c87f396d04ffd5d76dc67da0806a91cdd55bb  abi.encode((address,uint256[],string))\n' +
      `encoded   0x${['20', 'aa', '60', 'c0', '2', '1', '2', '2'].map((w) => w.padStart(64, '0')).join('')}${'6869'.padEnd(64, '0')}\n`,
  );
  const array = run('abi', ['hash', '(uint8,bytes)[]', '[["1","0x1234"],["2","0x"]]']);
  assert.equal(array.status, 0, array.stderr);
  assert.equal(
    array.stdout,
    'keccak256 0x0c1fbedd65c3a3c1b803e57f8fff2dde671048f2d8daef4aa7af3a36a3bc1375  abi.encode((uint8,bytes)[])\n' +
      `encoded   0x${['20', '2', '40', 'c0', '1', '40', '2'].map((w) => w.padStart(64, '0')).join('')}${'1234'.padEnd(64, '0')}${['2', '40', '0'].map((w) => w.padStart(64, '0')).join('')}\n`,
  );
});

test('pnpm abi refuses a value outside its type, a wrong count and an unknown kind with exit 64, printing no hash', () => {
  for (const args of [['hash', 'uint8', '256'], ['hash', 'address,uint256', 'usdc'], ['hash', '(address,uint24)', '["usdc"]'], ['hash', '(address,uint24)', '["usdc",'], ['hash', 'address', 'no-such-entry'], ['selector', 'approve(address'], ['digest', 'x']]) {
    const result = run('abi', args);
    assert.equal(result.status, 64, args.join(' '));
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr, '');
  }
  assert.match(run('abi', ['hash', '(address,uint24)', '["usdc",']).stderr, /^\(address,uint24\) takes a JSON array of 2 items/);
});

test('pnpm template check parses every committed template and lists its card fields and calls', () => {
  for (const protocol of readdirSync(join(ROOT, 'templates'))) {
    for (const operation of readdirSync(join(ROOT, 'templates', protocol))) {
      const result = run('template', ['check', `${protocol}/${operation}`]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`^OK  templates/${protocol}/${operation}/template\\.json parses with the registry\n(  card .*\n)+(  call \\d+: .*\n)+$`));
    }
  }
});

test('pnpm template check refuses a draft the parser refuses, naming the file, the path and the problem', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-draft-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(ROOT, 'scripts', 'template.ts'), join(root, 'scripts', 'template.ts'));
    for (const dir of ['src', 'registry', 'node_modules', 'testdata']) symlinkSync(join(ROOT, dir), join(root, dir));
    const draft = JSON.parse(readFileSync(join(ROOT, 'templates', 'erc20', 'transfer', 'template.json'), 'utf8'));
    mkdirSync(join(root, 'templates', 'erc20', 'transfer'), { recursive: true });
    writeFileSync(join(root, 'templates', 'erc20', 'transfer', 'template.json'), JSON.stringify({ ...draft, extra: true }));
    const result = run('template', ['check', 'erc20/transfer'], root);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'REFUSED  templates/erc20/transfer/template.json: template.extra: unexpected field\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The cards each test file wrote by hand for its fixtures. */
const HAND_WRITTEN: readonly (readonly [template: string, fixture: string, values: Record<string, string>])[] = [
  ['morpho/vault-deposit', 'morpho-vault-bundles-deposit', { vault: 'steakhouse-prime-usdc-v2-0f51', amount: '10000000000', 'min-shares': '9609712613964437589511' }],
  ['morpho/vault-deposit', 'morpho-vault-bundles-deposit-other-safe', { vault: 'steakhouse-prime-usdc-v2-0f51', amount: '60000000000', 'min-shares': '57722843047406249093813' }],
  ['morpho/vault-deposit', 'morpho-bundles-deposit', { vault: 'steakhouse-prime-usdc-v2-0f51', amount: '31583325527', 'min-shares': '30442521166571443751074' }],
  ['morpho/vault-deposit', 'morpho-bundles-deposit-two-tags', { vault: 'steakhouse-prime-usdc-v2-0f51', amount: '2700000000000', 'min-shares': '2605667274057129893492827' }],
];

for (const [template, fixture, values] of HAND_WRITTEN) {
  test(`pnpm template implied-card ${template} ${fixture} prints the card its test wrote by hand, the share price bound's boundary included, and MATCH`, () => {
    const result = run('template', ['implied-card', template, fixture], BASE);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(parseCard(JSON.parse(/^ {2}card (.*)$/m.exec(result.stdout)?.[1] ?? 'null')), { operations: [{ template, values }] });
    assert.match(result.stdout, /^ {2}MATCH {2}judged at block \d+, time \d+$/m);
  });
}

test('pnpm template implied-card names a recipient outside the registry in a book line, and reads a signed message from testdata/messages/', () => {
  const transfer = run('template', ['implied-card', 'erc20/transfer', 'erc20-transfer-usdc'], BASE);
  assert.equal(transfer.status, 0, transfer.stdout);
  assert.match(transfer.stdout, /^ {2}card \{"operations":\[\{"template":"erc20\/transfer","values":\{"token":"usdc","amount":"4000000001000","recipient":"recipient"\}\}\]\}\n {2}book \{"recipient":"0x[0-9a-f]{40}"\}\n {2}MATCH /m);
  const swap = run('template', ['implied-card', 'cow/swap', 'cow-swap-usdc-base'], BASE);
  assert.equal(swap.status, 0, swap.stdout);
  assert.match(swap.stdout, /"sell-amount":"100000000000","min-buy":"99084887371"/);
});

test('pnpm template implied-card exits 1 for a transaction of another shape and for a check it cannot make offline', () => {
  const other = run('template', ['implied-card', 'erc20/transfer', 'cow-swap-usdc-base'], BASE);
  assert.equal(other.status, 1);
  assert.match(other.stdout, /^ {2}NOT THE SHAPE {2}the transaction does not make erc20\/transfer's calls: /m);
  const owners = run('template', ['implied-card', 'safe/remove-owner', 'safe-remove-owner-first'], BASE);
  assert.equal(owners.status, 1);
  assert.match(owners.stdout, /^ {2}UNVERIFIABLE the Safe's owners/m);
});

test('past-txs --show --tx prints the card a fit implies, and with a template changed since the study the transaction alone, saying to restudy', () => {
  const tx = '0x8615e98b9f927f0cb88e7c0cf162591b787d755ed02237158f1dbc53bdabc377';
  const fresh = run('past-txs', ['--show', 'safe-add-owner', '--tx', tx]);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /^ {2}implied card \{"operations":\[\{"template":"safe\/add-owner"/m);
  const root = mkdtempSync(join(tmpdir(), 'kiss-sign-stale-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(ROOT, 'scripts', 'past-txs.ts'), join(root, 'scripts', 'past-txs.ts'));
    for (const dir of ['src', 'registry', 'node_modules', 'testdata', 'docs']) symlinkSync(join(ROOT, dir), join(root, dir));
    mkdirSync(join(root, 'templates', 'safe', 'add-owner'), { recursive: true });
    const draft = readFileSync(join(ROOT, 'templates', 'safe', 'add-owner', 'template.json'), 'utf8');
    writeFileSync(join(root, 'templates', 'safe', 'add-owner', 'template.json'), `${draft}\n`);
    const stale = run('past-txs', ['--show', 'safe-add-owner', '--tx', tx], root);
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, new RegExp(`^${tx}  `));
    assert.doesNotMatch(stale.stdout, /implied card \{/);
    assert.match(stale.stdout, /^ {2}no implied card: the template changed since it was studied, so the values no longer pair with the rules; run pnpm past-txs --restudy safe-add-owner$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('past-txs refuses --tx without --show, --restudy beside --show, and the --input it no longer has, before it reads a key or a recording', () => {
  for (const args of [['--restudy', '--show', 'safe-add-owner'], ['--tx', '0x'], ['--show', 'safe-add-owner', '--tx', '0x', '--input']]) {
    const result = run('past-txs', args);
    assert.equal(result.status, 64, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^(use --restudy or --show, not both|--tx names one transaction of --show <name>|.*--input)/, args.join(' '));
  }
});

test('pnpm report --text prints the rendered page as text, with no markup, in the language asked', () => {
  const en = run('report', ['erc20/transfer', '--text', 'en']);
  assert.equal(en.status, 0, en.stderr);
  assert.match(en.stdout, /^To review \[AI judgment\] 2$/m);
  assert.match(en.stdout, /^\[pass\] Source verified 1 \/ 1$/m, 'an ABI proven but for its metadata hash counts as passed');
  assert.match(en.stdout, / usdc: compiled again, only the metadata hash differs from the code on chain, so its function selectors and parameter types are proven and it counts as passed; its parameter names are not proven\.$/m);
  assert.match(en.stdout, /\(https:\/\/github\.com\/ethereum\/ERCs\/blob\/[0-9a-f]{40}\/ERCS\/erc-20\.md\)/);
  assert.doesNotMatch(en.stdout, /<\/?(span|div|a|p|h\d|svg|td|li)\b|&#\d+;/);
  const zh = run('report', ['erc20/transfer', '--text', 'zh-TW']).stdout;
  assert.match(zh, /^待確認 \[AI 判斷\] 2$/m);
  assert.match(zh, /^\[通過\] 原始碼驗證 1 \/ 1$/m);
  assert.match(zh, /usdc 重新編譯後只有 metadata hash 跟鏈上不同，所以函式選擇器和參數型別有證明，算通過；參數名稱沒有證明。$/m);
  for (const args of [['--text', 'fr'], ['--text', 'en', '--render']]) assert.equal(run('report', ['erc20/transfer', ...args]).status, 2, args.join(' '));
  const supply = run('report', ['compound/supply', '--instance-of', 'compound-v3-cusdcv3', '--text', 'en']);
  assert.equal(supply.status, 0, supply.stderr);
  assert.match(supply.stdout, /^\[fail\] Transaction addresses 1 \/ 2$/m, 'a failed row shows its icon as [fail]');
  assert.match(supply.stdout, /^\[pass\] Source verified 2 \/ 2$/m);
  assert.match(supply.stdout, /approve 0x095ea7b3$/m, 'a function name and its selector stay apart');
  assert.equal(supply.stdout.match(/^Contents$/gm)?.length, 1, 'the contents print once');
  const missing = run('report', ['erc20/transfer', '--instance-of', 'no-such-vault', '--text', 'en']);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, 'REFUSED  no templates/erc20/transfer/instances/no-such-vault/report.generated.en.html; run pnpm report erc20/transfer --instance-of no-such-vault --render first\n');
});
