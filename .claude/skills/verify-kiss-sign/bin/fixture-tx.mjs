#!/usr/bin/env node
// Usage: fixture-tx.mjs <fixture name or path> <out.json>
//
// Writes the Transaction Service JSON of a testdata/safe-tx fixture (its `service` field), the form `verify --tx`
// reads, and prints its Safe, nonce and safeTxHash. A bare name such as `morpho-vault-deposit-v2` is looked up in
// testdata/safe-tx/ of the repository this script lives in.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [fixture, output] = process.argv.slice(2);
if (fixture === undefined || output === undefined) {
  console.error('usage: fixture-tx.mjs <fixture name or path> <out.json>');
  process.exit(2);
}
const repo = resolve(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..');
const path = fixture.endsWith('.json') ? resolve(fixture) : join(repo, 'testdata', 'safe-tx', `${fixture}.json`);
const { service } = JSON.parse(readFileSync(path, 'utf8'));
if (service === undefined) {
  console.error(`${path} has no service field`);
  process.exit(1);
}
writeFileSync(output, `${JSON.stringify(service, null, 2)}\n`);
console.log(`safe ${service.safe} nonce ${service.nonce} safeTxHash ${service.safeTxHash} executed ${service.isExecuted === true}`);
