import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCard, resolveCard } from '../src/card.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import type { Read } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadStoredConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { loadRegistry } from '../src/registry.ts';
import { endsNeeded, expectedChanges, viewCalls } from '../src/simulate/effects.ts';
import { simulateTx } from '../src/simulate/simulate.ts';
import { checkPerturbations, checkRecordedBlocks, executedOn, ownReceiptLogs } from '../src/template/perturb.ts';
import { eoaCannotTest, loadRecordedTx } from '../src/template/recorded-tx.ts';
import { loadTemplate, parseTemplate } from '../src/template/template.ts';
import { recordingText } from '../src/chain/bytecode.ts';
import { parseFlags } from '../src/cli/flags.ts';
import { UsageError } from '../src/cli/io.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';

const USAGE = `usage: pnpm perturb <fixture name> --card '<card json>' [--template <template.json>]
  [--record <name>]`;
const HELP = `${USAGE}

Runs the perturbation test on the executed transaction in testdata/safe-tx/<name>.json, a Safe's
or, recorded by pnpm record-eoa-tx, an EOA's one call. The original must first execute in the
simulation and pass the effects check, and an EOA's must emit the logs its receipt holds; otherwise
it prints not run, with why. It changes each free field to other values of its type, one at a time,
simulates every copy on the parent block through both providers, and prints each outcome: reverted,
refused by the field or effects check, the same logs and effects on the sender, or changed. It prints
PASS, or FAIL naming each copy its field's claim forbids. An EOA's transaction is refused for a
template that binds the Safe's nonce or changes its settings; a copy of an EOA's call that sends ETH
and reverts is unverifiable, since it ran through a forwarder that gives the EOA code. With
--record, nothing is written when the recording or its name mentions the configured Safe.

Options:
  --card '<card json>'         The card the transaction was made for; required.
  --template <template.json>   Replace the card's template of that id, for a negative test; the
                               recording carries it.
  --record <name>              Write testdata/perturb/<name>.json, which pnpm test replays, after
                               checking its blocks; nothing is written when a read got no answer.

Writes: testdata/perturb/<name>.json with --record; otherwise nothing.
Keys: ALCHEMY_API_KEY and DRPC_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
Rules: docs/design/engine-and-chain.md, "Engine checks that every template gets" (the
  perturbation test).`;
const ROOT = join(import.meta.dirname, '..');

exitOnHelp(HELP);
refuseReadableErrors();

const { values: flags, positionals } = parseFlags({
  allowPositionals: true,
  options: { card: { type: 'string' }, template: { type: 'string' }, record: { type: 'string' } },
});
const [fixtureName] = positionals;
if (flags.card === undefined || fixtureName === undefined || positionals.length !== 1) throw new UsageError(USAGE);
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new UsageError('--record takes a name of lowercase letters, digits and hyphens');

const recorded = loadRecordedTx(ROOT, fixtureName);
const { tx } = recorded;
const registry = loadRegistry(ROOT);
const card = parseCard(JSON.parse(flags.card));
const templates = new Map(card.operations.map((op) => [op.template, loadTemplate(ROOT, op.template, registry)]));
if (flags.template !== undefined) {
  const template = parseTemplate(JSON.parse(readFileSync(flags.template, 'utf8')), registry, 'committed');
  templates.set(template.id, template);
}
const untestable = [...templates.values()].map((template) => eoaCannotTest(recorded, template)).find((why) => why !== undefined);
if (untestable !== undefined) throw new Error(untestable);
const resolution = resolveCard(card, { templates, registry, addressBook: new Map(), safe: tx.safe });
if (resolution.kind === 'refused') throw new Error(`card refused: ${resolution.reason} at ${resolution.at}: ${resolution.detail}`);
const expectations = expectedChanges(resolution.card, templates, registry);
const watch = expectations.kind === 'expected' ? [...expectations.changes.keys()].filter((asset) => asset !== 'eth') : [];

const endpoints = mainnetEndpoints(process.env);
const recorder = recordingTransport(httpsTransport(), endpoints);
const unread: string[] = [];
const reader = createReader(endpoints, recorder.transport, { note: (read) => void unread.push(read) });
const agreed = <T>(read: Read<T>): T => {
  if (read.kind === 'unverifiable') throw new Error(read.reason);
  return read.value;
};
const receipt = agreed(await reader.getTransactionReceipt(recorded.hash));
if (receipt === null) throw new Error('the transaction has no receipt');
const executed = agreed(await reader.header(agreed(await reader.block(receipt.blockNumber))));
const parent = agreed(await reader.header(agreed(await reader.block(receipt.blockNumber - 1n))));
if (executed.hash !== receipt.blockHash || (recorded.executed.hash !== undefined && recorded.executed.hash !== executed.hash)) {
  throw new Error(`the transaction ran in block ${receipt.blockHash}, not the block ${recorded.executed.hash ?? executed.hash} its fixture or the providers name`);
}

const report = await checkPerturbations(
  tx,
  resolution.card,
  templates,
  registry,
  (copy) => simulateTx(recorded.sender, reader, { tx: copy, parent, time: executed.time, watch, ends: endsNeeded(expectations), views: viewCalls(resolution.card, templates, registry) }),
  { chain: executedOn(executed), receiptLogs: await ownReceiptLogs(reader, recorded) },
);
console.log(`${fixtureName}${recorded.sender === 'eoa' ? " (an EOA's transaction)" : ''}: every free field changed, simulated on block ${parent.number} by ${reader.providers.join(' and ')}`);
if (report.kind === 'not-run') console.log(`  not run: ${report.reason}`);
else {
  for (const r of report.runs) {
    const claim = r.leaf.rule.kind === 'free' ? r.leaf.rule.claim : '';
    console.log(`  ${r.leaf.callPath} ${r.leaf.arg} [${claim}] = ${r.value}: ${r.outcome}${r.detail === '' ? '' : ` (${r.detail})`}`);
  }
  console.log(report.kind === 'pass' ? 'PASS' : `FAIL: ${report.failed.map((r) => `${r.leaf.callPath} ${r.leaf.arg} = ${r.value} ${r.outcome}`).join('; ')}`);
}

if (flags.record !== undefined) {
  const refusal = unreadRefusal(unread);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exit(1);
  }
  const out = join(ROOT, 'testdata', 'perturb', `${flags.record}.json`);
  const recording = {
    safeTx: fixtureName,
    card: JSON.parse(flags.card),
    ...(flags.template === undefined ? {} : { template: JSON.parse(readFileSync(flags.template, 'utf8')) }),
    executed: { number: executed.number.toString(), hash: executed.hash },
    parent: { number: parent.number.toString(), hash: parent.hash },
    exchanges: recorder.exchanges().filter((e) => reader.providers.every((p) => p in e.answers || p in (e.errors ?? {}))),
  };
  checkRecordedBlocks(out, recording, recorded.executed);
  const configured = loadStoredConfig(kissSignHome(process.env))?.safe;
  if (configured !== undefined && `${out}\n${JSON.stringify(recording)}`.toLowerCase().includes(configured.slice(2))) {
    console.error('the recording would mention the configured Safe; nothing written');
    process.exit(1);
  }
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, recordingText(recording, 2));
  console.log(`wrote ${out}: ${recording.exchanges.length} requests`);
}
