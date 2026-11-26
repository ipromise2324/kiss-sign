import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Exchange } from '../src/chain/recording.ts';
import { COINGECKO_COINS, DEFILLAMA_PARENTS, DEFILLAMA_PROTOCOLS } from '../src/research/listings.ts';
import { runOffline } from './run-offline.ts';

const REPORT = 'safe-change-threshold';
const { creations } = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'testdata', 'report', `${REPORT}.json`), 'utf8')) as { creations: Record<string, { tx: string }> };

const both = (answer: unknown) => ({ alchemy: answer, drpc: answer });
const blockRead = (number: string): Exchange => ({ method: 'eth_getBlockByNumber', params: [number, false], answers: both({ number, hash: `0x${number.slice(2).padStart(64, '0')}` }) });
const head: Exchange[] = [{ method: 'eth_blockNumber', params: [], answers: both('0x1008') }, blockRead('0x1008')];
const settled = blockRead('0x1000');
const noTransactions = Object.values(creations).flatMap(({ tx }) => ['eth_getTransactionByHash', 'eth_getTransactionReceipt'].map((method): Exchange => ({ method, params: [tx], answers: both(null) })));

const url = ({ hostname, path }: { hostname: string; path: string }) => `https://${hostname}${path}`;
const hintsUrl = `https://api.etherscan.io/v2/api?${new URLSearchParams({ chainid: '1', module: 'contract', action: 'getcontractcreation', contractaddresses: Object.keys(creations).join(',') })}`;
const hints = { status: '1', result: Object.entries(creations).map(([contractAddress, { tx }]) => ({ contractAddress, txHash: tx, contractFactory: '' })) };
const text = (body: unknown) => ({ status: 200, text: JSON.stringify(body) });
const http = { [url(DEFILLAMA_PROTOCOLS)]: text([{ slug: 'other' }]), [url(DEFILLAMA_PARENTS)]: text({ parentProtocols: [] }), [url(COINGECKO_COINS)]: text([]), [hintsUrl]: text(hints) };

const record = (exchanges: readonly Exchange[]) => runOffline('report.ts', ['safe/change-threshold', '--record'], 'report', { exchanges, http, otherwise: { status: 404, text: '' } });
const unreadMethods = (stderr: string) => new Set([...stderr.matchAll(/^ {2}(?:alchemy|drpc) (\w+)/gm)].map((m) => m[1]));

test('report --record stops after the section with an unanswered read, before it reads the next one, and writes nothing', () => {
  const stopped = record([...head, settled]);
  assert.equal(stopped.status, 1, stopped.stderr + stopped.stdout);
  assert.match(stopped.stderr, /^\d+ read\(s\) got no answer after every retry, so nothing is recorded; run the command again later:$/m);
  assert.deepEqual(unreadMethods(stopped.stderr), new Set(['eth_getTransactionByHash', 'eth_getTransactionReceipt']));
  assert.deepEqual([stopped.stdout, stopped.written], ['', []]);

  const further = record([...head, settled, ...noTransactions]);
  assert.equal(further.status, 1, further.stderr + further.stdout);
  assert.deepEqual(unreadMethods(further.stderr), new Set(['eth_getCode']));
  assert.deepEqual([further.stdout, further.written], ['', []]);
});

test('report reads the block 8 behind the head, never the head itself', () => {
  const atHead = record(head);
  assert.notEqual(atHead.status, 0);
  assert.match(atHead.stderr, /block 4096: alchemy failed \(unreachable\); drpc failed \(unreachable\)/);
  assert.deepEqual(atHead.written, []);
});
