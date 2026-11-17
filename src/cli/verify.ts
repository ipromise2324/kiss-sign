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
import type { Verdict } from '../verify/verdict.ts';
import { BOX_WIDTH, box, paint, rows, text, wrap } from './format.ts';
import type { Paint, Row } from './format.ts';
import { FAILED, OK, UsageError } from './io.ts';
import { LABELS } from './labels.ts';
import type { Io } from './io.ts';
import { requireConfig, shellWord } from './setup.ts';
import { recordingText } from '../chain/bytecode.ts';

const SERVICE = 'https://api.safe.global/tx-service/eth/api/v1';

export const verdictsDir = (home: string): string => join(home, 'verdicts');

const V = LABELS.verdict;

const frameOf = (kind: Verdict['kind'], p: Paint): ((text: string) => string) => (kind === 'MATCH' ? p.ok : kind === 'MISMATCH' ? p.bad : p.warn);

/** Each check that caused a verdict other than MATCH, one row per detail. */
const causeRows = (verdict: Verdict): Row[] => (verdict.kind === 'MATCH' ? [] : verdict.causes.flatMap((cause) => cause.details.map((detail): Row => [cause.check, detail])));

function printReplay({ verdict, hashes, calls }: Evaluation, registry: Registry, io: Io): void {
  const p = paint(io.color === true);
  const scan = describeCallScan(calls, registry).flatMap((line) => wrap(line, BOX_WIDTH));
  const body =
    verdict.kind === 'MATCH'
      ? [...scan, '', ...rows([['domain hash', hashes.domainHash], ['message hash', hashes.messageHash], ['safeTxHash', hashes.safeTxHash]], 0, BOX_WIDTH), '', ...wrap(V.notPermission, BOX_WIDTH)]
      : [...rows(causeRows(verdict), 0, BOX_WIDTH), ...scan, '', V.noHashes];
  io.stdout(text(box(V.replayTitle(verdict.kind), body, frameOf(verdict.kind, p))));
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
  const { safe, repo, language } = requireConfig(home);
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
  const { evaluation: result, tx, inputs: used, prepared, latest, unread, kept } = await evaluateTx(inputs, reader, io.readMessage);
  for (const why of unread) io.stderr(`kiss-sign: a signed message could not be read: ${why}\n`);
  const decimals = await readTokenDecimals(reader, prepared, latest);
  const file: VerdictFile = { format: VERDICT_FORMAT, inputs: used, exchanges: recorder.exchanges(), result };
  const dir = verdictsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `nonce-${tx.nonce}-${Date.now()}.json`);
  writeFileSync(`${path}.tmp`, recordingText(file, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  const { verdict, hashes } = result;
  const p = paint(io.color === true);
  const tree: CallTree | undefined = verdict.kind === 'MATCH' ? callTree(tx, { ...prepared, decimals }) : undefined;
  const body =
    verdict.kind === 'MATCH'
      ? rows([[V.nonce, `${tx.nonce}`], ['safeTxHash', hashes.safeTxHash, p.heading]], 0, BOX_WIDTH)
      : [...rows([[V.nonce, `${tx.nonce}`], ...causeRows(verdict)], 0, BOX_WIDTH), '', V.noHashes];
  io.stdout(text(box(V.title[verdict.kind], body, frameOf(verdict.kind, p))));
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
    kept,
    tree,
    verdictFile: path,
    language,
  });
  writeFileSync(`${page}.tmp`, html, { mode: 0o600 });
  renameSync(`${page}.tmp`, page);
  io.stdout(
    text([
      `${V.page}: ${verdict.kind === 'MATCH' ? V.pageMatch : V.pageOther}`,
      `  ${page}`,
      `${V.file}:`,
      `  ${path}`,
      `${V.open}:`,
      `  ${io.platform === 'darwin' ? 'open' : 'xdg-open'} ${shellWord(page)}`,
    ]),
  );
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
  io.stdout(`${V.same}\n`);
  return OK;
}
