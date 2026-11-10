import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { replayReader } from '../src/chain/recording.ts';
import { loadRegistry } from '../src/registry.ts';
import { pastTxs, renderPastTxs } from '../src/research/past-txs.ts';
import { scrubRecording } from '../src/research/recording.ts';
import type { PastTxsRecording } from '../src/research/recording.ts';
import { replayAsk } from '../src/research/sources.ts';
import type { AnchorKind, SourceExchange } from '../src/research/sources.ts';
import type { Address } from '../src/safe/types.ts';
import { loadTemplate, parseTemplate } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';

const ROOT = join(import.meta.dirname, '..');
const recording: PastTxsRecording = JSON.parse(readFileSync(join(ROOT, 'testdata', 'research', 'morpho-vault-deposit.json'), 'utf8'));
const registry = loadRegistry(ROOT);
const template = loadTemplate(ROOT, recording.query.template, registry);

const FIT = '0x88a65493c62cfc17be33cbc587fca29edf71d0984b6ba2295873dfb1a9a38c4c';
const MISFIT = '0xbd242bf8e4ff0a45a27468a62553bae8770bd456c12420028de0f82e28e18a80';

/** The Safe that executed `hash`, as the recorded chain read says. */
function safeOf(hash: string): Address {
  const read = recording.exchanges.find((e) => e.method === 'eth_getTransactionByHash' && JSON.stringify(e.params) === JSON.stringify([hash]));
  return (read?.answers.alchemy as { to: Address }).to;
}

async function report(
  options: { exclude?: Address; sources?: readonly SourceExchange[]; template?: Template; exchanges?: PastTxsRecording['exchanges'] } = {},
): Promise<string> {
  const { query } = recording;
  const run = await pastTxs(
    {
      template: options.template ?? template,
      anchor: { token: query.token as Address, kind: query.anchor as AnchorKind, fromBlock: BigInt(query.fromBlock), toBlock: BigInt(query.toBlock) },
    },
    { ask: replayAsk(options.sources ?? recording.sources), reader: replayReader(options.exchanges ?? recording.exchanges), registry, exclude: options.exclude, maxTxs: 200 },
  );
  return renderPastTxs(run, registry);
}

test('a recorded search reports both sources, the Safe transactions, and how each template field was filled', async () => {
  const text = await report();
  assert.match(text, /^sources: alchemy found 65, etherscan found 65; both 65, only alchemy 0, only etherscan 0$/m);
  assert.match(text, /^executed by a Safe through execTransaction: 3 of 65, from 1 Safe$/m);
  assert.match(text, /^ {2}62 not a call to execTransaction \(called 0x374f435d in 25, /m);
  assert.match(text, /^fit the template's shape: 2 transactions from 1 Safe; misfits: 1 from 1 Safe$/m);
  assert.match(text, /erc4626Deposit\.receiver {2}\[the Safe\]\n {4}equalled the Safe in 2 of 2 \(1 Safe\); values: the Safe in 2$/m);
  assert.match(text, /erc4626Deposit\.assets {2}\[card amount\]\n {4}same as the other leaves bound to card amount in 2 of 2; /m);
  assert.match(text, /approve\.spender {2}\[contract general-adapter1\]\n {4}equalled contract general-adapter1 in 2 of 2 /m);
  assert.match(text, new RegExp(`^ {2}1 from 1 Safe: calls usdc\\.approve, another contract\\.0x6bbba4e0\\n {4}e\\.g\\. ${MISFIT}$`, 'm'));
  assert.match(text, new RegExp(`^examples that fit: ${FIT}, `, 'm'));
});

test('the configured Safe is left out of every count and example, and never printed', async () => {
  const safe = safeOf(FIT);
  const text = await report({ exclude: safe });
  assert.match(text, /^sources: alchemy found 62, etherscan found 62; both 62, /m);
  assert.match(text, /^executed by a Safe through execTransaction: 0 of 62, from 0 Safes$/m);
  assert.doesNotMatch(text, new RegExp(`${safe.slice(2)}|${FIT}|${MISFIT}`, 'i'));
});

test('a transaction only one source found is still studied, and marked', async () => {
  const sources = recording.sources.map(({ request, answer }) =>
    request.source === 'etherscan'
      ? { request, answer: { ...(answer as object), result: (answer as { result: { transactionHash: string }[] }).result.filter((log) => log.transactionHash !== FIT) } }
      : { request, answer },
  );
  const text = await report({ sources });
  assert.match(text, /^sources: alchemy found 65, etherscan found 64; both 64, only alchemy 1, only etherscan 0$/m);
  assert.match(text, new RegExp(`^ {2}only alchemy: ${FIT}$`, 'm'));
  assert.match(text, new RegExp(`^examples that fit: ${FIT} \\[only alchemy\\], `, 'm'));
});

test('a transaction a provider would not serve is unreadable for that reason, apart from one the providers disagree on', async () => {
  const exchanges = recording.exchanges.map((e) => {
    if (e.method !== 'eth_getTransactionByHash') return e;
    if (JSON.stringify(e.params) === JSON.stringify([FIT])) return { ...e, answers: { alchemy: e.answers.alchemy }, statuses: { drpc: 429 } };
    if (JSON.stringify(e.params) === JSON.stringify([MISFIT])) return { ...e, answers: { ...e.answers, drpc: { ...(e.answers.drpc as object), nonce: '0x0' } } };
    return e;
  });
  const text = await report({ exchanges });
  assert.match(text, new RegExp(`^ {2}1 unreadable, eth_getTransactionByHash: drpc failed \\(rate-limited\\): ${FIT}$`, 'm'));
  assert.match(text, new RegExp(`^ {2}1 unreadable, eth_getTransactionByHash: alchemy and drpc disagree: ${MISFIT}$`, 'm'));
});

test('a recording that would name the configured Safe loses those entries, or is refused', () => {
  const safe = safeOf(FIT);
  const scrubbed = JSON.stringify(scrubRecording(recording, [safe]));
  assert.doesNotMatch(scrubbed, new RegExp(safe.slice(2), 'i'));
  assert.throws(() => scrubRecording({ ...recording, query: { ...recording.query, token: safe } }, [safe]), /still mentions the configured Safe/);
});

test('a template whose trailer allowance is shorter than real use lists those transactions as misfits, with the reason', async () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'templates', 'morpho', 'vault-deposit', 'template.json'), 'utf8'));
  raw.calls[1].trailer.maxBytes = 1;
  const text = await report({ template: parseTemplate(raw, registry) });
  assert.match(text, /^fit the template's shape: 0 transactions from 0 Safes; misfits: 3 from 1 Safe$/m);
  assert.match(text, /^ {2}2 from 1 Safe: more bytes after the arguments than the template allows, at multiSend\[1\]$/m);
});
