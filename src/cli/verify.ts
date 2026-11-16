import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadAddressBook } from '../address-book.ts';
import { cardsDir, loadSealed } from '../card.ts';
import { canonicalJson } from '../canonical.ts';
import { mainnetEndpoints } from '../chain/providers.ts';
import { createReader } from '../chain/reader.ts';
import { recordingTransport, replayReader } from '../chain/recording.ts';
import { loadApproved } from '../config.ts';
import { kissSignHome } from '../keys.ts';
import { MARKETS_PATH, REGISTRY_PATH, parseRegistry } from '../registry.ts';
import type { Registry } from '../registry.ts';
import { checksumAddress, parseHex } from '../safe/types.ts';
import { describeCallScan } from '../simulate/simulate.ts';
import { TEMPLATES_DIR } from '../template/template.ts';
import { fileAt, optionalFileAt, pathsAt, selfCheck } from '../verify/self-check.ts';
import { reportedVaults, unreportedVault } from '../template/vault-reports.ts';
import { callTree } from '../verify/expected.ts';
import type { CallTree } from '../verify/expected.ts';
import { verdictPage } from '../verify/page.ts';
import { expectedChanges } from '../simulate/effects.ts';
import { VERDICT_FORMAT, VerifyError, evaluate, evaluateTx, parseVerdictFile, prepare, readTokenDecimals } from '../verify/verify.ts';
import type { Evaluation, TxInput, VerdictFile, VerifyInputs } from '../verify/verify.ts';
import { FAILED, OK, UsageError } from './io.ts';
import type { Io } from './io.ts';
import { requireConfig, shellWord } from './setup.ts';

const SERVICE = 'https://api.safe.global/tx-service/eth/api/v1';

export const verdictsDir = (home: string): string => join(home, 'verdicts');

function printReplay({ verdict, hashes, calls }: Evaluation, registry: Registry, io: Io): void {
  io.stdout(`${verdict.kind}\n`);
  if (verdict.kind !== 'MATCH') for (const cause of verdict.causes) for (const detail of cause.details) io.stdout(`  ${cause.check}: ${detail}\n`);
  for (const line of describeCallScan(calls, registry)) io.stdout(`${line}\n`);
  if (verdict.kind === 'MATCH') {
    io.stdout(`  domain hash   ${hashes.domainHash}\n  message hash  ${hashes.messageHash}\n  safeTxHash    ${hashes.safeTxHash}\n`);
    io.stdout('This is a replay of a recorded verdict, not permission to sign. Run pnpm kiss-sign verify before signing.\n');
    return;
  }
  io.stdout('No hashes are shown. Do not sign this transaction.\n');
}

async function txInput(file: string | undefined, safeTxHash: string | undefined, io: Io): Promise<TxInput> {
  if ((file === undefined) === (safeTxHash === undefined)) throw new UsageError('verify needs exactly one of --tx <file> or --safe-tx-hash <hash>.');
  if (file !== undefined) {
    const json: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const isService = typeof json === 'object' && json !== null && Object.hasOwn(json, 'safeTxHash');
    return { format: isService ? 'service' : 'web-app', json };
  }
  const hash = parseHex('--safe-tx-hash', safeTxHash);
  if (hash.length !== 66) throw new UsageError('--safe-tx-hash takes a 32-byte hash.');
  const json = await io.fetchJson(`${SERVICE}/multisig-transactions/${hash}/`);
  const reported = (json as { safeTxHash?: unknown } | null)?.safeTxHash;
  if (typeof reported !== 'string' || reported.toLowerCase() !== hash) throw new VerifyError(`the Transaction Service did not return ${hash}`);
  return { format: 'service', json };
}

export async function verify(args: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { card: { type: 'string' }, tx: { type: 'string' }, 'safe-tx-hash': { type: 'string' } },
    strict: true,
  });
  if (values.card === undefined) throw new UsageError('verify needs --card <sealed card hash>.');
  const home = kissSignHome(io.env);
  const { safe, repo } = requireConfig(home);
  const check = selfCheck(io.repoRoot, repo);
  if (check.kind === 'differs') {
    io.stderr(`kiss-sign: this checkout is not exactly main of ${repo}, so nothing was verified.\n${check.problems.map((p) => `  ${p}\n`).join('')}`);
    return FAILED;
  }
  const card = loadSealed(home, values.card);
  const approved = loadApproved(home);
  const book = loadAddressBook(home);
  const named = new Set(card.operations.flatMap((op) => Object.values(op.values)));
  const ids = [...new Set(card.operations.map((op) => op.template))];
  const markets = optionalFileAt(io.repoRoot, check.commit, MARKETS_PATH);
  const inputs: VerifyInputs = {
    commit: check.commit,
    safe: checksumAddress(safe),
    tx: await txInput(values.tx, values['safe-tx-hash'], io),
    card: { hash: values.card, text: readFileSync(join(cardsDir(home), `${values.card}.json`), 'utf8') },
    templates: ids.map((id) => ({
      id,
      text: fileAt(io.repoRoot, check.commit, `${TEMPLATES_DIR}/${id}/template.json`),
      approved: approved.get(id) ?? null,
    })),
    registry: fileAt(io.repoRoot, check.commit, REGISTRY_PATH),
    ...(markets === undefined ? {} : { markets }),
    addressBook: Object.fromEntries([...book].filter(([name]) => named.has(name)).map(([name, address]) => [name, checksumAddress(address)])),
  };
  const parsed = prepare(inputs);
  const unreported = unreportedVault(parsed.card, parsed.templates, parsed.registry, (id) => reportedVaults(id, pathsAt(io.repoRoot, check.commit, `${TEMPLATES_DIR}/${id}`)));
  if (unreported !== undefined) {
    io.stderr(`kiss-sign: card refused: ${unreported}. Nothing was verified.\n`);
    return FAILED;
  }
  const endpoints = mainnetEndpoints(io.env);
  const recorder = recordingTransport(io.transport, endpoints);
  const reader = createReader(endpoints, recorder.transport);
  const { evaluation: result, tx, prepared, latest } = await evaluateTx(inputs, reader);
  const decimals = await readTokenDecimals(reader, prepared, latest);
  const file: VerdictFile = { format: VERDICT_FORMAT, inputs, exchanges: recorder.exchanges(), result };
  const dir = verdictsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `nonce-${tx.nonce}-${Date.now()}.json`);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  const { verdict, hashes } = result;
  io.stdout(`${verdict.kind}\n`);
  if (verdict.kind !== 'MATCH') for (const cause of verdict.causes) for (const detail of cause.details) io.stdout(`  ${cause.check}: ${detail}\n`);
  let tree: CallTree | undefined;
  if (verdict.kind === 'MATCH') {
    tree = callTree(tx, { ...prepared, decimals });
    io.stdout(`  safeTxHash  ${hashes.safeTxHash}\n`);
  } else {
    io.stdout('No hashes are shown. Do not sign this transaction.\n');
  }
  const page = path.replace(/\.json$/, '.html');
  const html = verdictPage({
    verdict,
    nonce: tx.nonce,
    card: prepared.card,
    cardHash: values.card,
    registry: prepared.registry,
    templates: prepared.templates,
    decimals,
    expected: expectedChanges(prepared.card, prepared.templates, prepared.registry),
    calls: result.calls,
    tree,
    verdictFile: path,
  });
  writeFileSync(`${page}.tmp`, html, { mode: 0o600 });
  renameSync(`${page}.tmp`, page);
  io.stdout(`Verdict file: ${path}\n`);
  io.stdout(
    verdict.kind === 'MATCH'
      ? `kiss-sign verify page, nonce ${tx.nonce}, MATCH, with the domain hash, the message hash and the 比對清單 to compare with check.sh: ${page}\n`
      : `kiss-sign verify page, nonce ${tx.nonce}, ${verdict.kind}, with every check: ${page}\n`,
  );
  io.stdout(`Open it with: ${io.platform === 'darwin' ? 'open' : 'xdg-open'} ${shellWord(page)}\n`);
  return result.verdict.kind === 'MATCH' ? OK : FAILED;
}

/** Recomputes a verdict from its file alone, with the chain's recorded answers, and compares it with the recorded one. */
export async function replay(args: readonly string[], io: Io): Promise<number> {
  const [path, ...extra] = args;
  if (path === undefined || extra.length > 0) throw new UsageError('replay takes the path of one verdict file.');
  const file = parseVerdictFile(JSON.parse(readFileSync(path, 'utf8')));
  const result = await evaluate(file.inputs, replayReader(file.exchanges));
  printReplay(result, parseRegistry(JSON.parse(file.inputs.registry)), io);
  if (canonicalJson(result) !== canonicalJson(file.result)) {
    const what = canonicalJson(result.verdict) === canonicalJson(file.result.verdict) ? 'the same verdict but different call marks or hashes' : 'another result';
    io.stderr(`kiss-sign: the recorded verdict was ${file.result.verdict.kind}; this program now gives ${what}.\n`);
    return FAILED;
  }
  io.stdout('Same verdict as recorded.\n');
  return OK;
}
