import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

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
 * fluid/vault-deposit is not here: its min-shares is checked on the simulated result, so no value of the transaction
 * implies it.
 */
const SHIPPED: Record<string, Shipped> = {
  'compound/supply': { fixtures: ['compound-supply-usdc', 'compound-supply-usdc-other-safe'] },
  'cow/swap': { fixtures: ['cow-swap-usdc', 'cow-swap-usdt'], bounded: ['min-buy'] },
  'erc20/transfer': { fixtures: ['erc20-transfer-usdc-a', 'erc20-transfer-usdc-b', 'erc20-transfer-usdc-c'] },
  'eth/transfer': { fixtures: ['eth-transfer-large', 'eth-transfer-small', 'eth-transfer-third'] },
  'morpho/vault-deposit': { fixtures: ['morpho-bundles-deposit', 'morpho-bundles-deposit-two-tags', 'morpho-deposit-steakhouse-prime', 'morpho-deposit-steakhouse-prime-other-safe', 'morpho-deposit-steakhouse-prime-third-safe'], bounded: ['min-shares'] },
  'morpho/vault-v2-cap-accept': { fixtures: ['sentora-rlusd-main-cap-accept-kbtc-251', 'sentora-rlusd-main-cap-accept-kbtc-213'] },
  'morpho/vault-v2-cap-submit': { fixtures: ['sentora-rlusd-main-cap-submit-kbtc-284', 'sentora-rlusd-main-cap-submit-kbtc-273'] },
  'safe/add-owner': { fixtures: ['safe-add-owner-multisend', 'safe-add-owner-nonce-0', 'safe-add-owner-to-3', 'safe-add-owner-v1-3-0'] },
  'safe/change-threshold': { fixtures: ['safe-change-threshold-1-3-0', 'safe-change-threshold-1-4-1'] },
  'safe/remove-owner': { fixtures: ['safe-remove-owner-1-4-1', 'safe-remove-owner-first-1-3-0', 'safe-remove-owner-to-1'], verdict: OWNERS_NOT_READ },
  'safe/swap-owner': { fixtures: ['safe-swap-owner-first-signer', 'safe-swap-owner-v130', 'safe-swap-owner-v141'], verdict: OWNERS_NOT_READ },
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
