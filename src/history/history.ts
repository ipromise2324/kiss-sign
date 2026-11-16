import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { mainnetEndpoints } from '../chain/providers.ts';
import { createReader } from '../chain/reader.ts';
import type { Reader } from '../chain/reader.ts';
import { recordingTransport, replayReader } from '../chain/recording.ts';
import type { Exchange } from '../chain/recording.ts';
import { OK, UsageError } from '../cli/io.ts';
import type { Io } from '../cli/io.ts';
import { requireConfig } from '../cli/setup.ts';
import { checkFloor } from '../floor/floor.ts';
import { kissSignHome } from '../keys.ts';
import { MARKETS_PATH, REGISTRY_PATH } from '../registry.ts';
import { checksumAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';
import { TEMPLATES_DIR } from '../template/template.ts';
import { fetchOriginMain, fileAt, localOriginMain, optionalFileAt } from '../verify/self-check.ts';
import type { GithubRepo } from '../verify/self-check.ts';
import { VerifyError, evaluate, keccakText } from '../verify/verify.ts';
import type { VerifyInputs } from '../verify/verify.ts';
import { HistoryError, cacheDir, historyDir, loadHistory, mergeRegistry, txsPath } from './load.ts';
import type { History, HistoryCard, HistoryTx } from './load.ts';
import { reasonFor, spentReason } from './reasons.ts';
import type { Facts } from './reasons.ts';
import { renderMarkdown, renderText } from './render.ts';
import type { Report, Row } from './render.ts';
import { RecordingError, parseRecording, recordingText } from '../chain/bytecode.ts';

const SERVICE = 'https://api.safe.global/tx-service/eth/api/v2';

type Cache = { readonly safeTxHash: string; readonly exchanges: readonly Exchange[] };

function writePrivate(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function readCache(path: string, safeTxHash: string): Cache | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let cache: Cache;
  try {
    cache = parseRecording(text, path) as Cache;
  } catch (error) {
    if (error instanceof RecordingError) return undefined;
    throw error;
  }
  return cache.safeTxHash === safeTxHash && Array.isArray(cache.exchanges) ? cache : undefined;
}

/** The card's own words, plus who supplied each value or address the signer did not confirm. */
function cardMarks(card: HistoryCard, history: History): string {
  const marks = card.marks.map((m) => `${m.at.replace(/^operations\[0\]\.values\./, '')}: ${m.note}`);
  for (const op of card.card.operations) {
    for (const name of Object.values(op.values)) {
      const entry = history.book.get(name);
      if (entry !== undefined) marks.push(`${name}: ${entry.mark}`);
    }
  }
  return marks.length === 0 ? 'unmarked' : marks.join('; ');
}

type Context = {
  readonly io: Io;
  readonly home: string;
  readonly safe: Address;
  readonly history: History;
  readonly commit: string;
  readonly registry: string;
  readonly markets: string | undefined;
  readonly refresh: boolean;
  readonly templateText: (id: string) => string | undefined;
};

/** Chain answers come from the nonce's cache unless `--refresh`; a live run records them there for the next run. */
async function evaluateCard(ctx: Context, entry: HistoryTx, card: HistoryCard): Promise<Facts['outcome']> {
  const ids = [...new Set(card.card.operations.map((op) => op.template))];
  const templates = ids.flatMap((id) => {
    const text = ctx.templateText(id);
    return text === undefined ? [] : [{ id, text, approved: keccakText(text) }];
  });
  if (templates.length < ids.length) return { kind: 'no-template', ids: ids.filter((id) => !templates.some((t) => t.id === id)) };
  const named = new Set(card.card.operations.flatMap((op) => Object.values(op.values)));
  const inputs: VerifyInputs = {
    commit: ctx.commit,
    safe: checksumAddress(ctx.safe),
    tx: { format: 'service', json: entry.service },
    card: { hash: card.hash, text: card.text },
    templates,
    registry: ctx.registry,
    ...(ctx.markets === undefined ? {} : { markets: ctx.markets }),
    addressBook: Object.fromEntries(
      [...ctx.history.book].filter(([name]) => named.has(name)).map(([name, { address }]) => [name, checksumAddress(address)]),
    ),
  };
  const path = join(cacheDir(ctx.home), `${entry.nonce}.json`);
  const safeTxHash = String(entry.service.safeTxHash).toLowerCase();
  const cached = ctx.refresh ? undefined : readCache(path, safeTxHash);
  let reader: Reader;
  let recorded: (() => Exchange[]) | undefined;
  if (cached !== undefined) {
    reader = replayReader(cached.exchanges);
  } else {
    const endpoints = mainnetEndpoints(ctx.io.env);
    const recorder = recordingTransport(ctx.io.transport, endpoints);
    reader = createReader(endpoints, recorder.transport);
    recorded = recorder.exchanges;
  }
  try {
    const { verdict } = await evaluate(inputs, reader);
    if (recorded !== undefined) {
      mkdirSync(cacheDir(ctx.home), { recursive: true, mode: 0o700 });
      writePrivate(path, recordingText({ safeTxHash, exchanges: recorded() }));
    }
    return { kind: 'verdict', verdict };
  } catch (error) {
    if (error instanceof VerifyError) return { kind: 'error', message: error.message };
    throw error;
  }
}

async function rowFor(ctx: Context, entry: HistoryTx): Promise<Row> {
  const card = ctx.history.cards.get(entry.nonce);
  const outcome: Facts['outcome'] = card === undefined ? { kind: 'no-card' } : await evaluateCard(ctx, entry, card);
  const intent = ctx.history.intents.get(entry.nonce);
  const reason = reasonFor({ tx: entry.tx, floor: checkFloor(entry.tx), outcome });
  return {
    nonce: entry.nonce,
    date: intent?.date ?? entry.executionDate.slice(0, 10),
    intent: intent === undefined ? '' : intent.app === '' ? intent.intent : `[${intent.app}] ${intent.intent}`,
    verdict: outcome.kind === 'verdict' ? outcome.verdict.kind : outcome.kind === 'error' ? 'ERROR' : 'not run',
    reason,
    note: ctx.history.notes.get(entry.nonce)?.text,
    card: card === undefined ? undefined : cardMarks(card, ctx.history),
  };
}

function originMain(root: string, repo: GithubRepo): string {
  const origin = fetchOriginMain(root, repo);
  if (origin.kind === 'fetched') return origin.commit;
  if (origin.kind === 'refused') throw new HistoryError(`origin/main of ${repo} was refused: ${origin.problems.join('; ')}`);
  try {
    return localOriginMain(root);
  } catch {
    throw new HistoryError('this clone has no origin/main to read templates and the registry from');
  }
}

async function run(io: Io, out: string | undefined, refresh: boolean): Promise<number> {
  const home = kissSignHome(io.env);
  const { safe, repo } = requireConfig(home);
  if (out !== undefined && !relative(resolve(io.repoRoot), resolve(out)).startsWith('..')) {
    throw new UsageError('--out must be outside this repository, so the Safe history never lands in a commit.');
  }
  const history = loadHistory(home, safe);
  const commit = originMain(io.repoRoot, repo);
  const texts = new Map<string, string>();
  const templateText = (id: string): string | undefined => {
    let text = texts.get(id);
    if (text === undefined) {
      text = optionalFileAt(io.repoRoot, commit, `${TEMPLATES_DIR}/${id}/template.json`);
      if (text !== undefined) texts.set(id, text);
    }
    return text;
  };
  const ctx: Context = {
    io,
    home,
    safe,
    history,
    commit,
    registry: mergeRegistry(fileAt(io.repoRoot, commit, REGISTRY_PATH), history.registryOverlay),
    markets: optionalFileAt(io.repoRoot, commit, MARKETS_PATH),
    refresh,
    templateText,
  };
  const own: Row[] = [];
  for (const entry of history.txs) own.push(await rowFor(ctx, entry));
  const byNonce = new Map(own.map((row) => [row.nonce, row]));
  const rows = own.map((row) => {
    const spentBy = history.notes.get(row.nonce)?.spentBy;
    const spender = spentBy === undefined ? undefined : byNonce.get(spentBy);
    return spender === undefined ? row : { ...row, reason: spentReason(row.reason, spender) };
  });
  const report: Report = {
    commit,
    templates: [...texts].map(([id, text]) => ({ id, hash: keccakText(text) })),
    overlay: Object.keys(history.registryOverlay).length,
    rows,
  };
  io.stdout(renderText(report));
  if (out !== undefined) {
    writePrivate(out, renderMarkdown(report));
    io.stdout(`Wrote ${out}\n`);
  }
  return OK;
}

/** Every multisig transaction of the configured Safe, newest first as the service lists them, into `txs.jsonl`. */
async function fetchTxs(io: Io): Promise<number> {
  const home = kissSignHome(io.env);
  const { safe } = requireConfig(home);
  const first = `${SERVICE}/safes/${checksumAddress(safe)}/multisig-transactions/?limit=100`;
  const records: unknown[] = [];
  for (let url: string | null = first; url !== null; ) {
    const page = (await io.fetchJson(url)) as { results?: unknown; next?: unknown };
    if (!Array.isArray(page?.results)) throw new HistoryError(`the Transaction Service answered ${url} without results`);
    records.push(...page.results);
    const next = page.next;
    if (next !== null && (typeof next !== 'string' || !next.startsWith(`${first.split('?')[0]}?`))) {
      throw new HistoryError('the Transaction Service named a next page outside this listing');
    }
    url = next;
  }
  mkdirSync(historyDir(home), { recursive: true, mode: 0o700 });
  writePrivate(txsPath(home), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const executed = records.filter((r) => (r as { isExecuted?: unknown }).isExecuted === true).length;
  io.stdout(`Wrote ${records.length} transactions (${executed} executed) to ${txsPath(home)}\n`);
  return OK;
}

/** `history [--out <file.md>] [--refresh]`, or `history fetch`. */
export async function history(args: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { out: { type: 'string' }, refresh: { type: 'boolean', default: false } },
    strict: true,
  });
  if (positionals.length === 1 && positionals[0] === 'fetch' && values.out === undefined && !values.refresh) return fetchTxs(io);
  if (positionals.length > 0) throw new UsageError('usage: pnpm history [--out <file.md>] [--refresh] | pnpm history fetch');
  return run(io, values.out, values.refresh);
}
