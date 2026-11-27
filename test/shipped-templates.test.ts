import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TEMPLATES_DIR } from '../src/template/template.ts';
import { GENERATED_FILE } from '../src/template/vault-reports.ts';
import { REPORTED_FILE } from './repo-with-test-fixtures.ts';

/**
 * The shipped templates as this checkout holds them, not the frozen test/fixtures/base/ the program's tests read: a
 * template.json changed so that a test transaction no longer gives MATCH, or a bounded field loses its bound, fails here
 * with the command that shows why.
 */
const ROOT = join(import.meta.dirname, '..');

type Shipped = { readonly fixtures: readonly string[]; readonly bounded?: readonly string[]; readonly verdict?: string };

/** The owner rules read the Safe's owners from chain, which implied-card does not read. */
const OWNERS_NOT_READ = "UNVERIFIABLE the Safe's owners: not read";

/**
 * Each shipped template's test transactions in testdata/safe-tx/ and the card fields whose implied value is a bound.
 * uniswap/approve-permit2 and uniswap/allow-router are not here: their test transactions batch them with a swap, and
 * implied-card reads a transaction of one template.
 */
const SHIPPED: Record<string, Shipped> = {
  'compound/supply': { fixtures: ['compound-supply-usdc', 'compound-supply-usdc-again', 'compound-supply-usdc-other-safe'] },
  'cow/swap': { fixtures: ['cow-swap-usdc', 'cow-swap-usdt'], bounded: ['min-buy'] },
  'cow/swap-approve': { fixtures: ['cow-swap-approve-cbbtc', 'cow-swap-approve-usdt'], bounded: ['min-buy'] },
  'erc20/transfer': { fixtures: ['erc20-transfer-usdc', 'erc20-transfer-usdc-other-safe', 'erc20-transfer-usdt'] },
  'eth/transfer': { fixtures: ['eth-transfer-first-nonce', 'eth-transfer-null-data', 'safe-cancel', 'safe-cancel-other-safe'] },
  'fluid/vault-deposit': { fixtures: ['fluid-deposit-usdc', 'fluid-deposit-usdt', 'fluid-deposit-usdt-other-safe'] },
  'morpho/vault-deposit': { fixtures: ['morpho-bundles-deposit', 'morpho-bundles-deposit-two-tags', 'morpho-vault-bundles-deposit', 'morpho-vault-bundles-deposit-other-safe'], bounded: ['min-shares'] },
  'morpho/vault-v2-adapter-cap-accept': { fixtures: ['vault-v2-adapter-cap-accept-kpk'] },
  'morpho/vault-v2-adapter-cap-submit': { fixtures: ['vault-v2-adapter-cap-submit-kpk'] },
  'morpho/vault-v2-cap-accept': { fixtures: ['vault-v2-cap-accept'] },
  'morpho/vault-v2-cap-decrease': { fixtures: ['vault-v2-cap-decrease', 'vault-v2-cap-decrease-other-safe'] },
  'morpho/vault-v2-cap-submit': {
    fixtures: ['vault-v2-cap-submit', 'vault-v2-cap-submit-860', 'vault-v2-cap-submit-flowmark', 'vault-v2-cap-submit-gauntlet', 'vault-v2-cap-submit-kpk', 'vault-v2-cap-submit-other-safe'],
  },
  'morpho/vault-v2-collateral-cap-submit': { fixtures: ['vault-v2-collateral-cap-submit-kpk-weeth'] },
  'morpho/vault-v2-revoke': { fixtures: ['vault-v2-revoke'] },
  'safe/add-owner': { fixtures: ['safe-add-owner-1-3-0', 'safe-add-owner-raise-threshold'] },
  'safe/change-threshold': { fixtures: ['safe-change-threshold-lower', 'safe-change-threshold-raise'] },
  'safe/remove-owner': { fixtures: ['safe-remove-owner-1-3-0', 'safe-remove-owner-first', 'safe-remove-owner-multisend-1-5-0'], verdict: OWNERS_NOT_READ },
  'safe/swap-owner': { fixtures: ['safe-swap-owner-1-3-0', 'safe-swap-owner-first'], verdict: OWNERS_NOT_READ },
  'uniswap/swap': { fixtures: ['uniswap-swap-hook-usdc-usdt', 'uniswap-swap-hook-usdc-usdt-2'], bounded: ['min-buy'] },
  'uniswap/swap-no-hook': { fixtures: ['uniswap-swap-no-hook-usdc-usdt'], bounded: ['min-buy'] },
};

/** What `pnpm template implied-card` printed for one transaction: its verdict line and each bounded field, or each line that is neither. */
function outcomes(stdout: string): Map<string, { verdict: string[]; bounded: string[]; other: string[] }> {
  const found = new Map<string, { verdict: string[]; bounded: string[]; other: string[] }>();
  let current: { verdict: string[]; bounded: string[]; other: string[] } | undefined;
  for (const line of stdout.split('\n')) {
    const name = /^([a-z0-9-]+):/.exec(line)?.[1];
    if (name !== undefined) found.set(name, (current = { verdict: [], bounded: [], other: [] }));
    else if (current === undefined || /^ {2}(card|book) /.test(line) || line === '') continue;
    else if (/^ {2}MATCH /.test(line) || line === `  ${OWNERS_NOT_READ}`) current.verdict.push(line.replace(/ +judged at .*$/, '').trim());
    else if (/^ {2}boundary /.test(line)) current.bounded.push(line.split(' ')[3]!);
    else current.other.push(line.trim());
  }
  return found;
}

for (const [id, { fixtures, bounded = [], verdict = 'MATCH' }] of Object.entries(SHIPPED)) {
  test(`${id}: each of its test transactions gives ${verdict === 'MATCH' ? 'MATCH' : 'no other finding'} with the card it implies${bounded.length > 0 ? `, ${bounded.join(', ')} at its bound` : ''}`, () => {
    const command = `pnpm template implied-card ${id} ${fixtures.join(' ')}`;
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'template.ts'), 'implied-card', id, ...fixtures], { cwd: ROOT, encoding: 'utf8' });
    const fix = `templates/${id}/template.json no longer gives its test transactions their card; run ${command} to see why, and fix the template or, for a change you mean, the test that pins it:\n${run.stdout}${run.stderr}`;
    const found = outcomes(run.stdout);
    assert.deepEqual([...found.keys()], fixtures, fix);
    for (const name of fixtures) assert.deepEqual(found.get(name), { verdict: [verdict], bounded, other: [] }, `${name}: ${fix}`);
  });
}

test('each instance the frozen base says has a report has its shipped report', () => {
  const missing = (JSON.parse(readFileSync(REPORTED_FILE, 'utf8')) as string[]).filter((instance) => !existsSync(join(ROOT, TEMPLATES_DIR, instance, GENERATED_FILE)));
  const commands = missing.map((instance) => `pnpm report ${instance.split('/instances/').join(' --instance-of ')} --record`);
  assert.deepEqual(commands, [], `the tests that run card new and card seal pick these instances by their report; record each again with:\n${commands.join('\n')}`);
});
