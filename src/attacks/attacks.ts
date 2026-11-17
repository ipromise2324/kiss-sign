import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ResolvedCard } from '../card.ts';
import { canonicalJson } from '../canonical.ts';
import { mainnetEndpoints } from '../chain/providers.ts';
import { unreadRefusal } from '../chain/https.ts';
import { createReader } from '../chain/reader.ts';
import type { Reader } from '../chain/reader.ts';
import { recordingTransport, replayReader } from '../chain/recording.ts';
import { OK, UsageError } from '../cli/io.ts';
import type { Io } from '../cli/io.ts';
import { REGISTRY_PATH, attributesText, loadRegistry, marketsText } from '../registry.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { SafeTx } from '../safe/types.ts';
import { TEMPLATES_DIR } from '../template/template.ts';
import { assetClaims } from '../verify/assets.ts';
import { codeClaims } from '../verify/code.ts';
import type { Verdict } from '../verify/verdict.ts';
import { VerifyError, evaluate, judge, keccakText, prepare } from '../verify/verify.ts';
import type { TxInput, VerifyInputs } from '../verify/verify.ts';
import { ATTACKS_DIR, AttackCaseError, CHAINS, caseIds, caseTx, loadCase, loadRecording } from './case.ts';
import type { AttackCase, Recording } from './case.ts';
import { renderCase } from './render.ts';
import { recordingText } from '../chain/bytecode.ts';

/** One run of the checks: a verdict, or the reason verify stopped before one. */
export type Judgement = {
  readonly label: string;
  readonly outcome: { readonly kind: 'verdict'; readonly verdict: Verdict } | { readonly kind: 'refused'; readonly reason: string };
};

export type CaseResult = {
  readonly attack: AttackCase;
  readonly tx: SafeTx;
  readonly service: Readonly<Record<string, unknown>>;
  readonly registry: Registry;
  /** Absent when the card names a template or a name kiss-sign does not have. */
  readonly card: ResolvedCard | undefined;
  readonly judgements: readonly Judgement[];
};

/** The reader as it stood when `number` was the latest block, so verify sees the Safe as its signers did. */
function asOf(reader: Reader, number: bigint): Reader {
  const block: Reader['block'] = (tag) => reader.block(tag === 'latest' ? number : tag);
  return {
    ...reader,
    block,
    blockNumber: async () => {
      const read = await block('latest');
      return read.kind === 'agreed' ? { ...read, value: read.value.number } : read;
    },
  };
}

/** The fields a Safe web app shows before signing, which verify simulates as a pending transaction. */
const proposedJson = (tx: SafeTx) => ({
  to: checksumAddress(tx.to),
  value: tx.value.toString(),
  data: tx.data,
  operation: tx.operation,
  safeTxGas: tx.safeTxGas.toString(),
  baseGas: tx.baseGas.toString(),
  gasPrice: tx.gasPrice.toString(),
  gasToken: checksumAddress(tx.gasToken),
  refundReceiver: checksumAddress(tx.refundReceiver),
  nonce: tx.nonce.toString(),
});

/** Templates and the registry come from this checkout, each template approved at its own hash for the replay. */
function inputsFor(repoRoot: string, attack: AttackCase, tx: TxInput): VerifyInputs {
  const ids = [...new Set(attack.card.operations.map((op) => op.template))];
  const templates = ids.flatMap((id) => {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, TEMPLATES_DIR, id, 'template.json'), 'utf8');
    } catch {
      return [];
    }
    return [{ id, text, approved: keccakText(text) }];
  });
  const cardText = canonicalJson(attack.card);
  const markets = marketsText(repoRoot);
  const attributes = attributesText(repoRoot);
  return {
    commit: 'working tree',
    safe: checksumAddress(attack.safe),
    tx,
    card: { hash: keccakText(cardText), text: cardText },
    templates,
    registry: readFileSync(join(repoRoot, REGISTRY_PATH), 'utf8'),
    ...(markets === undefined ? {} : { markets }),
    ...(attributes === undefined ? {} : { attributes }),
    addressBook: Object.fromEntries([...attack.addressBook].map(([name, address]) => [name, checksumAddress(address)])),
  };
}

async function attempt(label: string, run: () => Promise<Verdict> | Verdict): Promise<Judgement> {
  try {
    return { label, outcome: { kind: 'verdict', verdict: await run() } };
  } catch (error) {
    if (error instanceof VerifyError) return { label, outcome: { kind: 'refused', reason: error.message } };
    throw error;
  }
}

/**
 * On Ethereum, verify runs twice as of the block before execution: once on the fields alone, simulated as a pending
 * transaction, and once on the Transaction Service record, judged by its receipt. Elsewhere only the checks that need
 * no chain run, and the simulation is unverifiable.
 */
export async function judgeCase(repoRoot: string, attack: AttackCase, service: Readonly<Record<string, unknown>>, reader: Reader): Promise<CaseResult> {
  const tx = caseTx(attack, service);
  const registry = loadRegistry(repoRoot);
  const executed = inputsFor(repoRoot, attack, { format: 'service', json: service });
  let card: ResolvedCard | undefined;
  try {
    card = prepare(executed).card;
  } catch (error) {
    if (!(error instanceof VerifyError)) throw error;
  }
  const judgements: Judgement[] = [];
  if (attack.chain === 'eth') {
    const parent = BigInt(String(service.blockNumber)) - 1n;
    const pinned = asOf(reader, parent);
    const proposed = inputsFor(repoRoot, attack, { format: 'web-app', json: proposedJson(tx) });
    judgements.push(await attempt(`as proposed, simulated on block ${parent}`, async () => (await evaluate(proposed, pinned)).verdict));
    judgements.push(await attempt('as executed, judged by its receipt', async () => (await evaluate(executed, pinned)).verdict));
  } else {
    const reason = `kiss-sign reads Ethereum only, and this transaction ran on ${CHAINS[attack.chain].name}`;
    judgements.push(
      await attempt('as proposed, without a simulation', () => {
        const prepared = prepare(executed);
        const unread = { kind: 'unverifiable', reasons: [reason] } as const;
        const unless = (claims: readonly unknown[]) => (claims.length === 0 ? ({ kind: 'pass' } as const) : unread);
        return judge(prepared, tx, unread, {
          assets: unless(assetClaims(prepared.card, prepared.templates, prepared.registry)),
          code: unless(codeClaims(tx, prepared.card, prepared.templates, prepared.registry)),
        });
      }),
    );
  }
  return { attack, tx, service, registry, card, judgements };
}

const SERVICE = (chain: string) => `https://api.safe.global/tx-service/${chain}/api/v2`;

async function record(io: Io, id: string): Promise<CaseResult> {
  const attack = loadCase(io.repoRoot, id);
  const url = `${SERVICE(attack.chain)}/safes/${checksumAddress(attack.safe)}/multisig-transactions/?nonce=${attack.nonce}&executed=true`;
  const listing = (await io.fetchJson(url)) as { count?: unknown; results?: unknown };
  const service = Array.isArray(listing?.results) && listing.count === 1 ? (listing.results[0] as Record<string, unknown>) : undefined;
  if (service === undefined) throw new AttackCaseError(`${id}: expected one executed transaction at nonce ${attack.nonce}, the service listed ${String(listing?.count)}`);
  const endpoints = mainnetEndpoints(io.env);
  const recorder = recordingTransport(io.transport, endpoints);
  const unread: string[] = [];
  const result = await judgeCase(io.repoRoot, attack, service, createReader(endpoints, recorder.transport, { note: (read) => void unread.push(read) }));
  const refusal = unreadRefusal(unread);
  if (refusal !== undefined) throw new AttackCaseError(`${id}: ${refusal}`);
  const recording: Recording = { service, exchanges: recorder.exchanges() };
  const dir = join(io.repoRoot, ATTACKS_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'recording.json'), recordingText(recording, 2));
  io.stderr(`Wrote ${join(ATTACKS_DIR, id, 'recording.json')}: ${recording.exchanges.length} chain requests\n`);
  return result;
}

/** Every case, replayed from its recording alone. */
export async function replayCases(repoRoot: string): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const id of caseIds(repoRoot)) {
    const recording = loadRecording(repoRoot, id);
    results.push(await judgeCase(repoRoot, loadCase(repoRoot, id), recording.service, replayReader(recording.exchanges)));
  }
  return results;
}

/** `attacks`, or `attacks --record <case>`. */
export async function attacks(args: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], options: { record: { type: 'string' } }, strict: true, allowPositionals: true });
  if (positionals.length > 0) throw new UsageError('usage: pnpm attacks [--record <case>]');
  const results = values.record === undefined ? await replayCases(io.repoRoot) : [await record(io, values.record)];
  io.stdout(results.map(renderCase).join('\n'));
  return OK;
}
