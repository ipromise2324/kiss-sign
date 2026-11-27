import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAddressBook } from '../src/address-book.ts';
import { parseCard, resolveCard } from '../src/card.ts';
import type { ResolvedCard } from '../src/card.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Address } from '../src/safe/types.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { checkPerturbations } from '../src/template/perturb.ts';
import { loadRecordedTx } from '../src/template/recorded-tx.ts';
import { loadTemplate } from '../src/template/template.ts';
import { repoWithTestFixtures } from './repo-with-test-fixtures.ts';

const ROOT = repoWithTestFixtures();
const registry = loadRegistry(ROOT);
const { tx } = loadRecordedTx(ROOT, 'erc20-transfer-usdc');
const templates = new Map([['erc20/transfer', loadTemplate(ROOT, 'erc20/transfer', registry)]]);
const card = parseCard({ operations: [{ template: 'erc20/transfer', values: { token: 'usdc', amount: '4000000001000', recipient: 'recipient' } }] });
const resolution = resolveCard(card, { templates, registry, addressBook: parseAddressBook({ recipient: '0xc748543c7832b39b841ae0b151e9ea53d6b0ade3' }), safe: tx.safe });
assert.equal(resolution.kind, 'resolved');
const resolved = (resolution as Extract<typeof resolution, { kind: 'resolved' }>).card;
const usdc = registry.entries.get('usdc')!.address;

const simulated = (tokens: ReadonlyMap<Address, bigint>) => async (): Promise<Observation> => ({
  kind: 'observed',
  observed: { kind: 'executed', eth: 0n, tokens, allowances: [], permit2: [], ends: new Map(), safeState: { kind: 'receipt', logs: [] } },
  logs: [],
});

const perturbed = (tokens: ReadonlyMap<Address, bigint>, card: ResolvedCard = resolved) => checkPerturbations(tx, card, templates, registry, simulated(tokens));

test('the perturbation test runs only when the original passes the effects check, and says why not otherwise', async () => {
  assert.equal((await perturbed(new Map([[usdc, -4000000001000n]]))).kind, 'pass');
  const moved = await perturbed(new Map([[usdc, -4000000001001n]]));
  assert.equal(moved.kind, 'not-run');
  assert.equal(moved.kind === 'not-run' && moved.cause, 'baseline');
  assert.match(moved.kind === 'not-run' ? moved.reason : '', /^the original's effects give MISMATCH: /);
});
