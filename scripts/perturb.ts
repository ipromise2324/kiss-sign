import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCard, resolveCard } from '../src/card.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import type { Read } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import type { Hex } from '../src/safe/types.ts';
import { endsNeeded, expectedChanges } from '../src/simulate/effects.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import { checkPerturbations } from '../src/template/perturb.ts';
import { loadTemplate, parseTemplate } from '../src/template/template.ts';

const USAGE = `usage: ALCHEMY_API_KEY=... node scripts/perturb.ts <safe-tx fixture name> --card '<card json>' [--template <template.json>] [--record <name>]`;
const ROOT = join(import.meta.dirname, '..');

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { card: { type: 'string' }, template: { type: 'string' }, record: { type: 'string' } },
});
const [fixtureName] = positionals;
if (flags.card === undefined || fixtureName === undefined || positionals.length !== 1) throw new Error(USAGE);
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new Error('--record takes a name of lowercase letters, digits and hyphens');

const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${fixtureName}.json`), 'utf8'));
const tx = parseServiceTx(fixture.service, { chainId: 1n, version: fixture.chain.version });
const registry = loadRegistry(ROOT);
const card = parseCard(JSON.parse(flags.card));
const templates = new Map(card.operations.map((op) => [op.template, loadTemplate(ROOT, op.template, registry)]));
if (flags.template !== undefined) {
  const template = parseTemplate(JSON.parse(readFileSync(flags.template, 'utf8')), registry);
  templates.set(template.id, template);
}
const resolution = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
if (resolution.kind === 'refused') throw new Error(`card refused: ${resolution.reason} at ${resolution.at}: ${resolution.detail}`);
const expectations = expectedChanges(resolution.card, templates, registry);
const watch = expectations.kind === 'expected' ? [...expectations.changes.keys()].filter((asset) => asset !== 'eth') : [];

const endpoints = mainnetEndpoints(process.env);
const recorder = recordingTransport(httpsTransport(), endpoints);
const reader = createReader(endpoints, recorder.transport);
const agreed = <T>(read: Read<T>): T => {
  if (read.kind === 'unverifiable') throw new Error(read.reason);
  return read.value;
};
const txHash = fixture.service.transactionHash as Hex;
const receipt = agreed(await reader.getTransactionReceipt(txHash));
if (receipt === null) throw new Error('the transaction has no receipt');
const executed = agreed(await reader.block(receipt.blockNumber));
const parent = agreed(await reader.header(agreed(await reader.block(receipt.blockNumber - 1n))));
const time = agreed(await reader.header(executed)).time;

const report = await checkPerturbations(tx, resolution.card, templates, registry, (copy) =>
  simulateSafeTx(reader, { tx: copy, parent, time, watch, ends: endsNeeded(expectations) }),
);
console.log(`${fixtureName}: every free field changed, simulated on block ${parent.number} by ${reader.providers.join(' and ')}`);
if (report.kind === 'not-run') console.log(`  not run: ${report.reason}`);
else {
  for (const r of report.runs) {
    const claim = r.leaf.rule.kind === 'free' ? r.leaf.rule.claim : '';
    console.log(`  ${r.leaf.callPath} ${r.leaf.arg} [${claim}] = ${r.value}: ${r.outcome}${r.detail === '' ? '' : ` (${r.detail})`}`);
  }
  console.log(report.kind === 'pass' ? 'PASS' : `FAIL: ${report.failed.map((r) => `${r.leaf.callPath} ${r.leaf.arg} = ${r.value} ${r.outcome}`).join('; ')}`);
}

if (flags.record !== undefined) {
  const out = join(ROOT, 'testdata', 'perturb', `${flags.record}.json`);
  const recording = {
    safeTx: fixtureName,
    card: JSON.parse(flags.card),
    ...(flags.template === undefined ? {} : { template: JSON.parse(readFileSync(flags.template, 'utf8')) }),
    executed: { number: executed.number.toString(), hash: executed.hash },
    parent: { number: parent.number.toString(), hash: parent.hash },
    exchanges: recorder.exchanges().filter((e) => reader.providers.every((p) => p in e.answers || p in (e.errors ?? {}))),
  };
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, `${JSON.stringify(recording, null, 2)}\n`);
  console.log(`wrote ${out}: ${recording.exchanges.length} requests`);
}
