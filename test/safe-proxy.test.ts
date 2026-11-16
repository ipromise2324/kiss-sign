import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Exchange } from '../src/chain/recording.ts';
import { replayReader } from '../src/chain/recording.ts';
import { safeProxyFactory } from '../src/contracts/proxy.ts';
import { OFFICIAL_SAFE_PROXY_FACTORIES, safeProxyCreated } from '../src/safe/deployments.ts';
import type { Hex } from '../src/safe/types.ts';
import { readRecording } from '../src/chain/bytecode.ts';

const DIR = join(import.meta.dirname, '..', 'testdata', 'safe-proxy');
const fixtures = readdirSync(DIR).map((file) => readRecording<{ transaction: Hex; exchanges: Exchange[] }>(join(DIR, file)));

async function created(fixture: (typeof fixtures)[number]) {
  const reader = replayReader(fixture.exchanges);
  const receipt = await reader.getTransactionReceipt(fixture.transaction);
  assert.ok(receipt.kind === 'agreed' && receipt.value !== null);
  const creation = safeProxyCreated(receipt.value.logs);
  assert.ok(creation !== undefined, `${fixture.transaction} holds a ProxyCreation from an official factory`);
  const block = await reader.block(receipt.value.blockNumber);
  assert.ok(block.kind === 'agreed');
  const code = await reader.getCode(creation.proxy, block.value);
  assert.ok(code.kind === 'agreed');
  return { ...creation, code: code.value };
}

test('the code every official Safe proxy factory deploys is a known Safe proxy of that version', async () => {
  const factories = new Set<string>();
  for (const fixture of fixtures) {
    const { factory, version, proxy, code } = await created(fixture);
    factories.add(factory);
    assert.match(safeProxyFactory(code) ?? 'unknown', new RegExp(` ${version.replaceAll('.', '\\.')}$`), `the proxy ${proxy} the ${version} factory created`);
  }
  assert.deepEqual([...factories].sort(), OFFICIAL_SAFE_PROXY_FACTORIES.map((f) => f.address).sort());
});
