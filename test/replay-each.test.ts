import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReportError } from '../src/research/report.ts';
import { replayEach } from './replay-each.ts';

test('one report that refuses, such as one reading a stale summary, leaves every other report replayed and keeps its refusal', async () => {
  const stale = 'testdata/research/erc20-transfer-steth.json: the registry entries it reads changed since it was studied; run pnpm past-txs --restudy erc20-transfer-steth';
  const run = await replayEach(['erc20/transfer', 'morpho/vault-deposit', 'safe/add-owner'], async (id) => {
    if (id === 'erc20/transfer') throw new ReportError(stale);
    return `${id} page`;
  });
  assert.deepEqual([...run.done], [['morpho/vault-deposit', 'morpho/vault-deposit page'], ['safe/add-owner', 'safe/add-owner page']]);
  assert.deepEqual([...run.refused], [['erc20/transfer', `ReportError: ${stale}`]]);
});
