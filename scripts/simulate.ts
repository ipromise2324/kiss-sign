import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCard, resolveCard } from '../src/card.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import type { Read } from '../src/chain/reader.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import type { Transport } from '../src/chain/rpc.ts';
import { parseRegistry } from '../src/registry.ts';
import { parseServiceTx } from '../src/safe/parse.ts';
import { checksumAddress, parseAddress, parseUint256 } from '../src/safe/types.ts';
import type { Hex } from '../src/safe/types.ts';
import { checkSimulatedFloor } from '../src/floor/simulated.ts';
import { describeFinding, expectedChanges, judgeEffects } from '../src/simulate/effects.ts';
import { observeExecuted } from '../src/simulate/executed.ts';
import { simulateSafeTx } from '../src/simulate/simulate.ts';
import type { Observation } from '../src/simulate/simulate.ts';
import { loadTemplate } from '../src/template/template.ts';

const USAGE = `usage: ALCHEMY_API_KEY=... node scripts/simulate.ts (<safe-tx fixture name> | <safe> <nonce>) --card '<card json>'
  [--registry <contracts.json>] [--record <name>]`;
const SERVICE = 'https://api.safe.global/tx-service/eth/api/v2';
const ROOT = join(import.meta.dirname, '..');

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { card: { type: 'string' }, registry: { type: 'string' }, record: { type: 'string' } },
});
if (flags.card === undefined || positionals.length < 1 || positionals.length > 2) throw new Error(USAGE);
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

type Exchange = { method: string; params: unknown; answers: Record<string, unknown> };
const exchanges: Exchange[] = [];
const endpoints = mainnetEndpoints(process.env);
const providerAt = new Map(endpoints.map((e) => [e.url, e.provider]));

/** Keeps each provider's raw `result` by request, never a URL, so a fixture holds no key. */
function recording(inner: Transport): Transport {
  return async (url, body, signal) => {
    const answer = await inner(url, body, signal);
    const { method, params } = JSON.parse(body) as { method: string; params: unknown };
    let result: unknown;
    try {
      result = (JSON.parse(answer.text) as { result?: unknown }).result;
    } catch {
      return answer;
    }
    if (result === undefined) return answer;
    let exchange = exchanges.find((e) => e.method === method && JSON.stringify(e.params) === JSON.stringify(params));
    if (exchange === undefined) {
      exchange = { method, params, answers: {} };
      exchanges.push(exchange);
    }
    exchange.answers[providerAt.get(url) ?? 'unknown'] = result;
    return answer;
  };
}

const reader = createReader(endpoints, recording(httpsTransport()));
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

const registry = parseRegistry(JSON.parse(readFileSync(flags.registry ?? join(ROOT, 'registry', 'contracts.json'), 'utf8')));
const card = parseCard(JSON.parse(flags.card));
const templates = new Map(card.operations.map((op) => [op.template, loadTemplate(ROOT, op.template, registry)]));
const resolution = resolveCard(card, { templates, registry, addressBook: new Map(), safe });
if (resolution.kind === 'refused') throw new Error(`card refused: ${resolution.reason} at ${resolution.at}: ${resolution.detail}`);
const resolved = resolution.card;
const expectations = expectedChanges(resolved, templates, registry);
const watch = expectations.kind === 'expected' ? [...expectations.changes.keys()] : [];

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
    for (const a of observed.allowances) console.log(`  allowance ${name(a.token)} to ${name(a.spender)}: ${a.before} -> ${a.after}`);
    const evidence = observed.safeState;
    if (evidence.kind === 'read') {
      for (const [field, value] of Object.entries(evidence.before)) {
        const after = evidence.after[field as keyof typeof evidence.after];
        const show = (v: unknown) => (Array.isArray(v) ? `${v.length} entries` : String(v));
        console.log(`  safe ${field}: ${show(value)}${String(after) === String(value) ? ' (unchanged)' : ` -> ${show(after)}`}`);
      }
    } else console.log(`  safe settings from ${evidence.logs.length} receipt logs`);
  }
  const floor = checkSimulatedFloor(observed, safe);
  if (floor.kind === 'pass') console.log('  simulated floor PASS');
  else console.log(`  simulated floor REFUSED\n${floor.findings.map((f) => `    ${f.rule}: ${f.detail}`).join('\n')}`);
  const verdict = judgeEffects(observed, resolved, templates, registry);
  if (verdict.kind === 'match') console.log('  verdict MATCH');
  else if (verdict.kind === 'mismatch') console.log(`  verdict MISMATCH\n${verdict.findings.map((f) => `    ${describeFinding(f, registry)}`).join('\n')}`);
  else console.log(`  verdict UNVERIFIABLE: ${verdict.reasons.join('; ')}`);
}

console.log(`nonce ${tx.nonce}, executed in block ${executed.number}; simulating on block ${parent.number}, agreed by ${reader.providers.join(' and ')}`);
print(
  `simulated through execTransaction at block ${parent.number}`,
  await simulateSafeTx(reader, { tx, parent, time: executedHeader.time, watch }),
);
print(`from the receipt of ${txHash}`, await observeExecuted(reader, txHash, tx));

if (flags.record !== undefined) {
  const out = join(ROOT, 'testdata', 'simulate', `${flags.record}.json`);
  const fixture = {
    safeTx: positionals[0],
    transactionHash: txHash,
    executed: { number: executed.number.toString(), hash: executed.hash },
    parent: { number: parent.number.toString(), hash: parent.hash },
    providers: reader.providers,
    exchanges: exchanges.filter((e) => reader.providers.every((p) => p in e.answers)),
  };
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`\nwrote ${out}: ${fixture.exchanges.length} requests, each answered by ${reader.providers.join(' and ')}`);
}
