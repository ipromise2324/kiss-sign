import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCard } from '../src/card.ts';
import type { ResolvedCard } from '../src/card.ts';
import { readRecording } from '../src/chain/bytecode.ts';
import { replayReader } from '../src/chain/recording.ts';
import type { Exchange } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Address, Hex, SafeTx } from '../src/safe/types.ts';
import { checkTemplateFields } from '../src/template/check.ts';
import type { FieldChain } from '../src/template/check.ts';
import { checkMutations } from '../src/template/mutation.ts';
import { loadTemplate } from '../src/template/template.ts';
import { readOwners } from '../src/verify/verify.ts';

const ROOT = join(import.meta.dirname, '..');
const ID = 'safe/remove-owner';
const registry = loadRegistry(ROOT);
const templates = new Map([[ID, loadTemplate(ROOT, ID, registry)]]);

/** Each fixture is another Safe's executed `removeOwner`, with the card `pnpm template implied-card` prints for it. */
const CASES = [
  { fixture: 'safe-remove-owner-first-1-3-0', owner: '0x772c42fd886c404081e5c7de50da5a8af7bde170', threshold: '2' },
  { fixture: 'safe-remove-owner-1-4-1', owner: '0x1e8fec1d1b9d490ccffaff7f4cbfeb5207a5c577', threshold: '2' },
  { fixture: 'safe-remove-owner-to-1', owner: '0x8836fa482d9ae1107f5313a9d2bddc584440dca0', threshold: '1' },
] as const;

function safeTx(name: string): SafeTx {
  const { service, chain } = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${name}.json`), 'utf8'));
  return parseServiceTx(service, { chainId: 1n, version: chain.version });
}

/** The Safe's owners at the parent block, as verify reads them, replayed from the fixture's simulate recording. */
async function chainOf(name: string, safe: Address): Promise<FieldChain> {
  const recording = readRecording<{ parent: { number: string; hash: Hex }; exchanges: Exchange[] }>(join(ROOT, 'testdata', 'simulate', `${name}.json`));
  const owners = await readOwners(replayReader(recording.exchanges), safe, { number: BigInt(recording.parent.number), hash: recording.parent.hash });
  assert.equal(owners.kind, 'read');
  return { owners };
}

function cardOf(tx: SafeTx, owner: string, threshold: string): ResolvedCard {
  const result = resolveCard(
    { operations: [{ template: ID, values: { owner: 'owner', threshold } }] },
    { templates, registry, addressBook: new Map([['owner', owner as Address]]), safe: tx.safe },
  );
  assert.equal(result.kind, 'resolved', result.kind === 'refused' ? result.detail : '');
  return (result as Extract<typeof result, { kind: 'resolved' }>).card;
}

for (const c of CASES) {
  test(`${c.fixture}: another Safe's removeOwner matches its implied card, and every bound field changed alone mismatches`, async () => {
    const tx = safeTx(c.fixture);
    const chain = await chainOf(c.fixture, tx.safe);
    const card = cardOf(tx, c.owner, c.threshold);
    assert.deepEqual(checkTemplateFields(tx, card, templates, registry, [], chain), { kind: 'match' });
    assert.deepEqual(checkMutations(tx, card, templates, registry, [], chain), { kind: 'pass', bound: 5, free: 0 });
  });
}

test('a card naming another signer or another threshold is a mismatch on the same transaction', async () => {
  const c = CASES[1];
  const tx = safeTx(c.fixture);
  const chain = await chainOf(c.fixture, tx.safe);
  const args = (owner: string, threshold: string) => {
    const result = checkTemplateFields(tx, cardOf(tx, owner, threshold), templates, registry, [], chain);
    return result.kind === 'mismatch' ? result.findings.map((f) => f.arg).sort() : result.kind;
  };
  assert.deepEqual(args(c.owner, '3'), ['_threshold']);
  const other = CASES[0].owner;
  assert.notEqual(args(other, c.threshold), 'match');
});

test('without the owner list read, the prevOwner rule cannot be checked and the transaction is not a match', () => {
  const c = CASES[0];
  const tx = safeTx(c.fixture);
  const result = checkTemplateFields(tx, cardOf(tx, c.owner, c.threshold), templates, registry, [], {});
  assert.notEqual(result.kind, 'match');
});
