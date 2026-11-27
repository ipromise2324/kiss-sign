import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAddressBook } from '../src/address-book.ts';
import { parseCard, resolveCard } from '../src/card.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import type { Read } from '../src/chain/reader.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { loadStoredConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { attributesText, marketsText, registryFromTexts } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import { checksumAddress, parseAddress, parseUint256 } from '../src/safe/types.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { checkSimulatedFloor } from '../src/floor/simulated.ts';
import type { FloorAllowed } from '../src/floor/floor.ts';
import { floorAllowed } from '../src/floor/summary.ts';
import { describeFinding, endsNeeded, expectedChanges, judgeEffects, viewCalls } from '../src/simulate/effects.ts';
import type { EffectVerdict, Observed, Permit2Allowance, ViewAnswer, ViewCall } from '../src/simulate/effects.ts';
import { observeExecuted, withSimulatedSafeState, withSimulatedViews } from '../src/simulate/executed.ts';
import { describeCallScan, scanCallsOf, simulateTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { eoaCannotTest, eoaReceiptDiffers, loadRecordedTx } from '../src/template/recorded-tx.ts';
import type { RecordedTx } from '../src/template/recorded-tx.ts';
import { loadTemplate, parseTemplate } from '../src/template/template.ts';
import { recordingText } from '../src/chain/bytecode.ts';
import { parseFlags } from '../src/cli/flags.ts';
import { UsageError } from '../src/cli/io.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';

const USAGE = `usage: pnpm simulate (<fixture name> | <safe> <nonce>) [--card '<card json>']
  [--template <template.json>] [--registry <contracts.json>] [--book '<address book json>']
  [--record <name>]
Without --card it prints what the transaction did and which calls move no asset, and judges nothing:
it lists the simulated floor's findings with no card's allowances, which are not verify's verdict.
--template replaces the card's template of that id, for a negative test.`;
const HELP = `${USAGE}

Simulates an executed Safe transaction through execTransaction on its parent block, at the
execution block's time, and reads its receipt, both through both providers. It prints both
effects on the Safe (ETH, tokens, allowances, Permit2 allowances, view readings, Safe settings),
the simulated floor, and with --card the verdict of each. Then it runs each call as a Safe
transaction of its own and marks the calls that move no asset of the Safe. The transaction comes
from testdata/safe-tx/<name>.json, or, given <safe> <nonce>, from the Safe Transaction Service;
that form runs locally only and records nothing.

An EOA's transaction, recorded by pnpm record-eoa-tx, is simulated as its one call from the EOA,
its effects read on the EOA. It has no Safe settings, so they print as not read and the simulated
floor never passes, and a card whose template binds the Safe's nonce or changes its settings is
refused. Its receipt's effects are not read, since the EOA paid gas and may have sent other
transactions in the block; its logs are its call's own, so the simulation is UNVERIFIABLE when
its logs differ from the receipt's in address or topics.

Options:
  --card '<card json>'          Judge both effects against this card: effects MATCH, MISMATCH or
                                UNVERIFIABLE, and the simulated floor; not verify's verdict.
  --template <template.json>    Replace the card's template of that id, for a negative test; needs
                                --card, and the recording carries it.
  --registry <contracts.json>   Read registry entries from this file, not registry/contracts.json.
  --book '<address book json>'  Address-book entries the card names.
  --record <name>               Write testdata/simulate/<name>.json; only with a fixture name, and
                                nothing is written when a read got no answer or the recording or
                                its name mentions the configured Safe.

Writes: testdata/simulate/<name>.json with --record; otherwise nothing.
Keys: ALCHEMY_API_KEY and DRPC_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
Rules: docs/design/engine-and-chain.md, "Engine checks that every template gets".`;
const SERVICE = 'https://api.safe.global/tx-service/eth/api/v2';
const ROOT = join(import.meta.dirname, '..');

exitOnHelp(HELP);
refuseReadableErrors();

const { values: flags, positionals } = parseFlags({
  allowPositionals: true,
  options: { card: { type: 'string' }, template: { type: 'string' }, registry: { type: 'string' }, book: { type: 'string' }, record: { type: 'string' } },
});
if (positionals.length < 1 || positionals.length > 2) throw new UsageError(USAGE);
if (flags.template !== undefined && flags.card === undefined) throw new UsageError('--template replaces a template of the card, so it needs --card');
if (flags.record !== undefined && (positionals.length !== 1 || !/^[a-z0-9-]+$/.test(flags.record))) {
  throw new UsageError('--record takes a name, and records only a safe-tx fixture, never a Safe given by address');
}

async function serviceTx(first: string, nonce: string): Promise<Record<string, unknown>> {
  const safe = parseAddress('safe', first);
  const url = `${SERVICE}/safes/${checksumAddress(safe)}/multisig-transactions/?nonce=${parseUint256('nonce', nonce)}&executed=true`;
  const listing = (await (await fetch(url)).json()) as { count?: number; results?: Record<string, unknown>[] };
  const service = listing.results?.[0];
  if (listing.count !== 1 || service === undefined) throw new Error(`expected one executed transaction, the service listed ${listing.count}`);
  return service;
}

const endpoints = mainnetEndpoints(process.env);
const recorder = recordingTransport(httpsTransport(), endpoints);
const unread: string[] = [];
const reader = createReader(endpoints, recorder.transport, { note: (read) => void unread.push(read) });
const agreed = <T>(read: Read<T>): T => {
  if (read.kind === 'unverifiable') throw new Error(read.reason);
  return read.value;
};

async function recordedOrServiceTx(): Promise<Pick<RecordedTx, 'sender' | 'tx' | 'hash'> & { readonly recorded?: RecordedTx }> {
  const [first, nonce] = positionals as [string, string | undefined];
  if (nonce === undefined) {
    const recorded = loadRecordedTx(ROOT, first);
    return { ...recorded, recorded };
  }
  const service = await serviceTx(first, nonce);
  const receipt = agreed(await reader.getTransactionReceipt(service.transactionHash as Hex));
  if (receipt === null) throw new Error('the transaction has no receipt');
  const answer = agreed(await reader.call({ to: parseAddress('safe', service.safe), data: '0xffa1ad74' as Hex }, agreed(await reader.block(receipt.blockNumber - 1n))));
  if (answer.kind !== 'returned') throw new Error('VERSION() reverted');
  const version = Buffer.from(answer.data.slice(130, 130 + Number(BigInt(`0x${answer.data.slice(66, 130)}`)) * 2), 'hex').toString('utf8');
  const tx = parseServiceTx(service, { chainId: 1n, version });
  return { sender: 'safe', tx, hash: service.transactionHash as Hex };
}

const { sender, tx, hash: txHash, recorded } = await recordedOrServiceTx();
const safe = tx.safe;
const receipt = agreed(await reader.getTransactionReceipt(txHash));
if (receipt === null) throw new Error('the transaction has no receipt');
const executed = agreed(await reader.block(receipt.blockNumber));
if (receipt.transactionHash !== txHash || executed.hash !== receipt.blockHash || (recorded?.executed.hash !== undefined && recorded.executed.hash !== executed.hash)) {
  throw new Error(`the transaction ran in block ${receipt.blockHash}, not the block ${recorded?.executed.hash ?? executed.hash} its fixture or the providers name`);
}
const parentRef = agreed(await reader.block(receipt.blockNumber - 1n));
const [parent, executedHeader] = [agreed(await reader.header(parentRef)), agreed(await reader.header(executed))];

const markets = marketsText(ROOT);
const registry = registryFromTexts(readFileSync(flags.registry ?? join(ROOT, 'registry', 'contracts.json'), 'utf8'), markets, attributesText(ROOT));
function judged(): { judge: (observed: Observed) => EffectVerdict; watch: Address[]; ends: Address[]; views: ViewCall[]; allowed: FloorAllowed } | undefined {
  if (flags.card === undefined) return undefined;
  const card = parseCard(JSON.parse(flags.card));
  const templates = new Map(card.operations.map((op) => [op.template, loadTemplate(ROOT, op.template, registry)]));
  if (flags.template !== undefined) {
    const template = parseTemplate(JSON.parse(readFileSync(flags.template, 'utf8')), registry, 'committed');
    templates.set(template.id, template);
  }
  const untestable = recorded === undefined ? undefined : [...templates.values()].map((template) => eoaCannotTest(recorded, template)).find((why) => why !== undefined);
  if (untestable !== undefined) throw new Error(untestable);
  const addressBook = parseAddressBook(JSON.parse(flags.book ?? '{}'));
  const resolution = resolveCard(card, { templates, registry, addressBook, safe });
  if (resolution.kind === 'refused') throw new Error(`card refused: ${resolution.reason} at ${resolution.at}: ${resolution.detail}`);
  const expectations = expectedChanges(resolution.card, templates, registry);
  return {
    judge: (observed) => judgeEffects(observed, resolution.card, templates, registry),
    watch: expectations.kind === 'expected' ? [...expectations.changes.keys()].filter((asset): asset is Address => asset !== 'eth') : [],
    ends: endsNeeded(expectations),
    views: viewCalls(resolution.card, templates, registry),
    allowed: floorAllowed(resolution.card, templates, registry),
  };
}
const card = judged();
const [watch, ends, views] = [card?.watch ?? [], card?.ends ?? [], card?.views ?? []];

const name = (address: string) => registry.byAddress.get(address as never)?.name ?? address;
function print(label: string, observation: Observation): void {
  console.log(`\n${label}`);
  if (observation.kind === 'unverifiable') {
    console.log(`  UNVERIFIABLE: ${observation.reasons.join('; ')}`);
    return;
  }
  const { observed } = observation;
  if (observed.kind === 'not-executed') console.log(`  not executed: ${observed.why}`);
  else {
    console.log(`  ETH ${observed.eth}`);
    for (const [token, delta] of observed.tokens) console.log(`  ${name(token)} ${delta > 0n ? '+' : ''}${delta}`);
    for (const [token, left] of observed.ends) console.log(`  ${name(token)} held after: ${left}`);
    for (const a of observed.allowances) console.log(`  allowance ${name(a.token)} to ${name(a.spender)}: ${a.before} -> ${a.after}`);
    const show = ({ amount, expiration, nonce }: Permit2Allowance) => `${amount} until ${expiration} (nonce ${nonce})`;
    for (const a of observed.permit2) console.log(`  Permit2 allowance ${name(a.token)} to ${name(a.spender)}: ${show(a.before)} -> ${show(a.after)}`);
    const answer = (a: ViewAnswer) => (a.kind === 'returned' ? a.data : `unread, ${a.why}`);
    for (const v of observed.views ?? []) console.log(`  view ${name(v.to)} ${v.data.slice(0, 10)} (${v.readIn}): ${answer(v.before)} -> ${answer(v.after)}`);
    const evidence = observed.safeState;
    if (evidence.kind === 'read') {
      for (const [field, value] of Object.entries(evidence.before)) {
        const after = evidence.after[field as keyof typeof evidence.after];
        const show = (v: unknown) => (Array.isArray(v) ? `${v.length} entries` : String(v));
        console.log(`  safe ${field}: ${show(value)}${String(after) === String(value) ? ' (unchanged)' : ` -> ${show(after)}`}`);
      }
    } else if (evidence.kind === 'receipt') console.log(`  safe settings from ${evidence.logs.length} receipt logs`);
    else console.log("  safe settings: not read, an EOA sent the transaction");
  }
  const floor = checkSimulatedFloor(observed, safe, card?.allowed);
  const findings = floor.kind === 'pass' ? '' : `\n${floor.findings.map((f) => `    ${f.rule}: ${f.detail}`).join('\n')}`;
  if (card === undefined) {
    const found = floor.kind === 'pass' ? 'nothing found' : `${floor.findings.length} finding(s)`;
    console.log(`  simulated floor, checked with no card, so it allows no approval or Safe setting change: ${found}. This is no verdict of verify, which checks the floor against the card's operations.${findings}`);
    return;
  }
  console.log(`  simulated floor ${floor.kind === 'pass' ? 'PASS' : 'REFUSED'}${findings}`);
  const verdict = card.judge(observed);
  if (verdict.kind === 'match') console.log('  effects MATCH');
  else if (verdict.kind === 'mismatch') console.log(`  effects MISMATCH\n${verdict.findings.map((f) => `    ${describeFinding(f, registry)}`).join('\n')}`);
  else console.log(`  effects UNVERIFIABLE: ${verdict.reasons.join('; ')}`);
}

console.log(`${sender === 'safe' ? `nonce ${tx.nonce}` : `an EOA's transaction from ${tx.safe}`}, executed in block ${executed.number}; simulating on block ${parent.number}, agreed by ${reader.providers.join(' and ')}`);
const simulated = await simulateTx(sender, reader, { tx, parent, time: executedHeader.time, watch, ends, views });
if (sender === 'safe') {
  print(`simulated through execTransaction at block ${parent.number}`, simulated);
  const receiptObservation = withSimulatedViews(await observeExecuted(reader, txHash, tx, ends, views), simulated, views);
  print(`from the receipt of ${txHash}`, card?.allowed.change === undefined ? receiptObservation : withSimulatedSafeState(receiptObservation, simulated));
  console.log(`\neach call run as a Safe transaction of its own at block ${parent.number}`);
} else {
  const unlike = simulated.kind === 'observed' && simulated.observed.kind === 'executed' ? eoaReceiptDiffers(receipt.logs, simulated.logs) : undefined;
  print(`simulated as the EOA's own call at block ${parent.number}`, unlike === undefined ? simulated : { kind: 'unverifiable', reasons: [unlike] });
  console.log(`\nfrom the receipt of ${txHash}: effects not read, since the EOA paid gas and may have sent other transactions in the block; its logs ${unlike === undefined ? 'match the simulation in address and topics' : 'differ from the simulation'}`);
  console.log(`\nthe EOA's call run alone at block ${parent.number}`);
}
for (const line of describeCallScan(await scanCallsOf(sender, reader, { tx, parent, time: executedHeader.time, watch }), registry)) console.log(`  ${line}`);

if (flags.record !== undefined) {
  const refusal = unreadRefusal(unread);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exit(1);
  }
  const out = join(ROOT, 'testdata', 'simulate', `${flags.record}.json`);
  const configured = loadStoredConfig(kissSignHome(process.env))?.safe;
  const fixture = {
    safeTx: positionals[0],
    transactionHash: txHash,
    ...(flags.template === undefined ? {} : { template: JSON.parse(readFileSync(flags.template, 'utf8')) }),
    executed: { number: executed.number.toString(), hash: executed.hash },
    parent: { number: parent.number.toString(), hash: parent.hash },
    providers: reader.providers,
    exchanges: recorder.exchanges().filter((e) => reader.providers.every((p) => p in e.answers || p in (e.errors ?? {}))),
  };
  if (configured !== undefined && `${out}\n${JSON.stringify(fixture)}`.toLowerCase().includes(configured.slice(2))) {
    console.error('the recording would mention the configured Safe; nothing written');
    process.exit(1);
  }
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, recordingText(fixture, 2));
  console.log(`\nwrote ${out}: ${fixture.exchanges.length} requests, each answered by ${reader.providers.join(' and ')}`);
}
