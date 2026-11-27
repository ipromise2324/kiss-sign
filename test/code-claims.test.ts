import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { Reader } from '../src/chain/reader.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Hex } from '../src/safe/types.ts';
import { parseTemplate } from '../src/template/template.ts';
import { checkCode, codeClaims } from '../src/verify/code.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', 'eth-transfer-null-data.json'), 'utf8'));
const tx = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });

/** CoW's swap with its call sent to Bundler3, its uid's owner part and its order's receiver changed to registry contracts, so the settlement contract is named only as the order's verifyingContract. */
function cowSwapElsewhere() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'cow', 'swap', 'template.json'), 'utf8'));
  const call = raw.calls[0];
  call.to = { contract: 'bundler3' };
  const [digest, owner] = call.args.orderUid.packed;
  owner.rule = { contract: 'vault-bundles-v1' };
  digest.rule.eip712.fields.receiver = { contract: 'gpv2-vault-relayer' };
  return parseTemplate(raw, registry, 'committed');
}

test('a contract a template names only inside packed bytes, a signed message or its domain has its code checked against its pin', async () => {
  const template = cowSwapElsewhere();
  const card = resolveCard(
    { operations: [{ template: template.id, values: { 'sell-token': 'usdc', 'buy-token': 'usdt', 'sell-amount': '1000000', 'min-buy': '990000' } }] },
    { templates: new Map([[template.id, template]]), registry, addressBook: new Map(), safe: tx.safe },
  );
  assert.equal(card.kind, 'resolved');
  const claims = codeClaims(tx, card.card, new Map([[template.id, template]]), registry);
  const names = claims.map((entry) => entry.name);
  for (const name of ['gpv2-settlement', 'vault-bundles-v1', 'gpv2-vault-relayer']) assert.ok(names.includes(name), `${name} is checked: ${names.join(', ')}`);
  const otherCode = new Proxy({}, { get: (_, key) => (key === 'getCode' ? async () => ({ kind: 'agreed', value: '0x00', providers: ['alchemy', 'drpc'] }) : () => assert.fail(`${String(key)} is not read`)) }) as Reader;
  const result = await checkCode(otherCode, claims, { number: 1n, hash: `0x${'00'.repeat(32)}` as Hex }, 'pending');
  assert.equal(result.kind, 'mismatch');
  const mismatched = result.kind === 'mismatch' ? result.findings.map((finding) => finding.split(' ')[0]) : [];
  for (const name of ['gpv2-settlement', 'vault-bundles-v1', 'gpv2-vault-relayer']) assert.ok(mismatched.includes(name), `${name} is MISMATCH: ${mismatched.join(', ')}`);
});
