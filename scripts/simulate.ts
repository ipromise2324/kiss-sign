import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseAddressBook } from '../src/address-book.ts';
import { parseCard, resolveCard } from '../src/card.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import type { Read } from '../src/chain/reader.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { marketsText, parseRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import { checksumAddress, parseAddress, parseUint256 } from '../src/safe/types.ts';
import type { Address, Hex } from '../src/safe/types.ts';
import { checkSimulatedFloor } from '../src/floor/simulated.ts';
import type { SettingsChange } from '../src/floor/simulated.ts';
import { settingsChange } from '../src/floor/summary.ts';
import { describeFinding, endsNeeded, expectedChanges, judgeEffects, viewCalls } from '../src/simulate/effects.ts';
import type { EffectVerdict, Observed, Permit2Allowance, ViewAnswer, ViewCall } from '../src/simulate/effects.ts';
import { observeExecuted, withSimulatedSafeState, withSimulatedViews } from '../src/simulate/executed.ts';
import { describeCallScan, scanCalls, simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { loadTemplate, parseTemplate } from '../src/template/template.ts';
import { recordingText } from '../src/chain/bytecode.ts';

const USAGE = `usage: ALCHEMY_API_KEY=... node scripts/simulate.ts (<safe-tx fixture name> | <safe> <nonce>) [--card '<card json>']
  [--template <template.json>] [--registry <contracts.json>] [--book '<address book json>'] [--record <name>]
Without --card it prints what the transaction did and which calls move no asset, and judges nothing.
--template replaces the card's template of that id, for a negative test.`;
const SERVICE = 'https://api.safe.global/tx-service/eth/api/v2';
const ROOT = join(import.meta.dirname, '..');

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { card: { type: 'string' }, template: { type: 'string' }, registry: { type: 'string' }, book: { type: 'string' }, record: { type: 'string' } },
});
if (positionals.length < 1 || positionals.length > 2) throw new Error(USAGE);
if (flags.template !== undefined && flags.card === undefined) throw new Error('--template replaces a template of the card, so it needs --card');
if (flags.record !== undefined && (positionals.length !== 1 || !/^[a-z0-9-]+$/.test(flags.record))) {
  throw new Error('--record takes a name, and records only a safe-tx fixture, never a Safe given by address');
}

async function serviceTx(): Promise<{ service: Record<string, unknown>; version: string | undefined }> {
  const [first, nonce] = positionals as [string, string | undefined];
  if (nonce === undefined) {
    const fixture = JSON.parse(readFileSync(join(ROOT, 'testdata', 'safe-tx', `${first}.json`), 'utf8'));
    return { service: fixture.service, version: fixture.chain.version };
  }
  const safe = parseAddress('safe', first);
  const url = `${SERVICE}/safes/${checksumAddress(safe)}/multisig-transactions/?nonce=${parseUint256('nonce', nonce)}&executed=true`;
  const listing = (await (await fetch(url)).json()) as { count?: number; results?: Record<string, unknown>[] };
  const service = listing.results?.[0];
  if (listing.count !== 1 || service === undefined) throw new Error(`expected one executed transaction, the service listed ${listing.count}`);
  return { service, version: undefined };
}

const endpoints = mainnetEndpoints(process.env);
const recorder = recordingTransport(httpsTransport(), endpoints);
const reader = createReader(endpoints, recorder.transport);
const agreed = <T>(read: Read<T>): T => {
  if (read.kind === 'unverifiable') throw new Error(read.reason);
  return read.value;
};

const { service, version: knownVersion } = await serviceTx();
const txHash = service.transactionHash as Hex;
const receipt = agreed(await reader.getTransactionReceipt(txHash));
if (receipt === null) throw new Error('the transaction has no receipt');
const executed = agreed(await reader.block(receipt.blockNumber));
const parentRef = agreed(await reader.block(receipt.blockNumber - 1n));
const [parent, executedHeader] = [agreed(await reader.header(parentRef)), agreed(await reader.header(executed))];
const safe = parseAddress('safe', service.safe);
let version = knownVersion;
if (version === undefined) {
  const answer = agreed(await reader.call({ to: safe, data: '0xffa1ad74' as Hex }, parentRef));
  if (answer.kind !== 'returned') throw new Error('VERSION() reverted');
  version = Buffer.from(answer.data.slice(130, 130 + Number(BigInt(`0x${answer.data.slice(66, 130)}`)) * 2), 'hex').toString('utf8');
}
const tx = parseServiceTx(service, { chainId: 1n, version });

const markets = marketsText(ROOT);
const registry = parseRegistry(JSON.parse(readFileSync(flags.registry ?? join(ROOT, 'registry', 'contracts.json'), 'utf8')), markets === undefined ? {} : JSON.parse(markets));
function judged(): { judge: (observed: Observed) => EffectVerdict; watch: Address[]; ends: Address[]; views: ViewCall[]; change: SettingsChange | undefined } | undefined {
  if (flags.card === undefined) return undefined;
  const card = parseCard(JSON.parse(flags.card));
  const templates = new Map(card.operations.map((op) => [op.template, loadTemplate(ROOT, op.template, registry)]));
  if (flags.template !== undefined) {
    const template = parseTemplate(JSON.parse(readFileSync(flags.template, 'utf8')), registry);
    templates.set(template.id, template);
  }
  const addressBook = parseAddressBook(JSON.parse(flags.book ?? '{}'));
  const resolution = resolveCard(card, { templates, registry, addressBook, safe });
  if (resolution.kind === 'refused') throw new Error(`card refused: ${resolution.reason} at ${resolution.at}: ${resolution.detail}`);
  const expectations = expectedChanges(resolution.card, templates, registry);
  const change = settingsChange(resolution.card, templates);
  return {
    change,
    judge: (observed) => judgeEffects(observed, resolution.card, templates, registry),
    watch: expectations.kind === 'expected' ? [...expectations.changes.keys()].filter((asset): asset is Address => asset !== 'eth') : [],
    ends: endsNeeded(expectations),
    views: viewCalls(resolution.card, templates, registry),
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
    } else console.log(`  safe settings from ${evidence.logs.length} receipt logs`);
  }
  const floor = checkSimulatedFloor(observed, safe, card?.change);
  if (floor.kind === 'pass') console.log('  simulated floor PASS');
  else console.log(`  simulated floor REFUSED\n${floor.findings.map((f) => `    ${f.rule}: ${f.detail}`).join('\n')}`);
  if (card === undefined) return;
  const verdict = card.judge(observed);
  if (verdict.kind === 'match') console.log('  verdict MATCH');
  else if (verdict.kind === 'mismatch') console.log(`  verdict MISMATCH\n${verdict.findings.map((f) => `    ${describeFinding(f, registry)}`).join('\n')}`);
  else console.log(`  verdict UNVERIFIABLE: ${verdict.reasons.join('; ')}`);
}

console.log(`nonce ${tx.nonce}, executed in block ${executed.number}; simulating on block ${parent.number}, agreed by ${reader.providers.join(' and ')}`);
const simulated = await simulateSafeTx(reader, { tx, parent, time: executedHeader.time, watch, ends, views });
print(`simulated through execTransaction at block ${parent.number}`, simulated);
const receiptObservation = withSimulatedViews(await observeExecuted(reader, txHash, tx, ends, views), simulated, views);
print(`from the receipt of ${txHash}`, card?.change === undefined ? receiptObservation : withSimulatedSafeState(receiptObservation, simulated));
console.log(`\neach call run as a Safe transaction of its own at block ${parent.number}`);
for (const line of describeCallScan(await scanCalls(reader, { tx, parent, time: executedHeader.time, watch }), registry)) console.log(`  ${line}`);

if (flags.record !== undefined) {
  const out = join(ROOT, 'testdata', 'simulate', `${flags.record}.json`);
  const fixture = {
    safeTx: positionals[0],
    transactionHash: txHash,
    ...(flags.template === undefined ? {} : { template: JSON.parse(readFileSync(flags.template, 'utf8')) }),
    executed: { number: executed.number.toString(), hash: executed.hash },
    parent: { number: parent.number.toString(), hash: parent.hash },
    providers: reader.providers,
    exchanges: recorder.exchanges().filter((e) => reader.providers.every((p) => p in e.answers)),
  };
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, recordingText(fixture, 2));
  console.log(`\nwrote ${out}: ${fixture.exchanges.length} requests, each answered by ${reader.providers.join(' and ')}`);
}
