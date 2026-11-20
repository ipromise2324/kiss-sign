import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import { replayReader } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Registry } from '../src/registry.ts';
import { pastTxs } from '../src/research/past-txs.ts';
import { renderPastTxs } from '../src/research/past-txs-render.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { replayMessages } from '../src/research/messages.ts';
import { samplingOf } from '../src/research/recording.ts';
import { replayAsk } from '../src/research/sources.ts';
import type { AnchorKind } from '../src/research/sources.ts';
import type { Address } from '../src/safe/types.ts';
import { parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = repoWithTestFixtures('implementation-read');
const registry = loadRegistry(ROOT);
const withSteth = loadRegistry(FIXTURES);
const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'erc20', 'transfer', 'template.json'), 'utf8'));
const WHY = { en: 'rounding, as past transactions show', 'zh-TW': '過去交易顯示的捨入' };

const transfer = (seen: Registry, tolerance?: object): Template =>
  parseTemplate({ ...raw, effects: { ...raw.effects, gives: [{ ...raw.effects.gives[0], ...(tolerance === undefined ? {} : { tolerance: { ...tolerance, why: WHY } }) }] } }, seen);

async function study(name: string, seen: Registry, template: Template): Promise<string> {
  const recorded: PastTxsRecording = readRecording(join(ROOT, 'testdata', 'research', `${name}.json`));
  const { query } = recorded;
  const run = await pastTxs(
    { template, anchor: { token: query.token as Address, kind: query.anchor as AnchorKind }, sampling: samplingOf(query) },
    { ask: replayAsk(recorded.sources), reader: replayReader(recorded.exchanges), registry: seen, readMessage: replayMessages([]), exclude: undefined, maxTxs: query.maxTxs },
  );
  return renderPastTxs(run, seen);
}

const STETH = /^ {4}(?:steth )?0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84.*: 28 transactions, 0 from Safes, 28 from EOAs\n {6}the sender: exact in 7, 1 base unit higher in 21; at most 1 base unit higher\n {6}the receiver: 2 base units lower in 1, 1 base unit lower in 19, exact in 8; at most 2 base units lower$/m;

test('past stETH transfers, each run alone on its parent block, left the sender up to 1 wei more and the receiver up to 2 wei less than the amount they state', async () => {
  const text = await study('erc20-transfer-steth', registry, transfer(registry));
  assert.match(text, /^ {2}gives card\.amount of card\.token to card\.recipient; tolerance: none declared, so 0$/m);
  assert.match(text, STETH);
  assert.match(text, /outside the registry, so no card can name it and it gives no finding/);
  assert.doesNotMatch(text, /FINDING/, 'a token no card can name gives no finding');
});

test('with stETH a registry token, a template allowing 0 gets a FINDING for the wei the sender kept, and one allowing 1 higher none', async () => {
  const none = await study('erc20-transfer-steth', withSteth, transfer(withSteth));
  assert.match(none, STETH);
  assert.match(none, /^ {4}FINDING: a sender's balance ended up to 1 base unit higher than stated, beyond the tolerance; such a transaction to sign would be MISMATCH$/m);
  const enough = await study('erc20-transfer-steth', withSteth, transfer(withSteth, { more: 1 }));
  assert.match(enough, /tolerance: 0 base units lower, 1 base unit higher$/m);
  assert.doesNotMatch(enough, /FINDING/);
  const wrongWay = await study('erc20-transfer-steth', withSteth, transfer(withSteth, { less: 1 }));
  assert.match(wrongWay, /FINDING: a sender's balance ended up to 1 base unit higher than stated/, 'a tolerance in the other direction allows none of it');
});

test('past USDC transfers moved exactly the stated amount, so the section is left out, and a tolerance declared on them is a tolerance with no evidence', async () => {
  const exact = await study('erc20-transfer-usdc', registry, transfer(registry));
  assert.doesNotMatch(exact, /amounts against balances/);
  const unfounded = await study('erc20-transfer-usdc', registry, transfer(registry, { less: 2 }));
  assert.match(unfounded, /^ {4}usdc 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48: \d+ transactions, \d+ from Safes, \d+ from EOAs\n {6}the sender: exact in \d+; at most 0 base units either way$/m);
  assert.match(unfounded, /^ {4}FINDING: a tolerance is declared, but no measured transaction ended other than exactly as stated: no evidence for it$/m);
});
