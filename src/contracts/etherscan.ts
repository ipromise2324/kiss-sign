import { request } from 'node:https';
import { fallbackLookup } from '../chain/dns.ts';
import { requestText, retried, transientStatus } from '../chain/https.ts';
import type { NoteUnread } from '../chain/https.ts';
import { MissingKeyError } from '../chain/providers.ts';
import { record } from '../chain/types.ts';
import { findKey, keySpec } from '../keys.ts';
import type { Env, KeySpec } from '../keys.ts';
import type { Address } from '../safe/types.ts';

/** What solc needs to rebuild one contract. Etherscan's ABI is never read. */
export type VerifiedSource = {
  readonly compilerVersion: string;
  readonly language: 'Solidity';
  readonly sources: Readonly<Record<string, { readonly content: string }>>;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly contractPath: string;
  readonly contractName: string;
};

/** `body` is the parsed JSON, or undefined when the answer was not JSON. */
export type EtherscanAnswer = { readonly status: number; readonly body: unknown };
export type EtherscanGet = (address: Address) => Promise<EtherscanAnswer>;

export type SourceLookup =
  | { readonly kind: 'found'; readonly source: VerifiedSource }
  | { readonly kind: 'not-verified' }
  | { readonly kind: 'unsupported-language'; readonly language: string }
  | { readonly kind: 'unreadable'; readonly why: string };

const COMPILER_VERSION = /^v?([0-9]+\.[0-9]+\.[0-9]+\+commit\.[0-9a-f]{8})$/;
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
/** The free plan allows a few requests a second. */
const PAUSE_MS = 400;

/** Etherscan's `getsourcecode` for `address` on mainnet; the key is sent only in the request and never reaches a message. */
export function etherscanHttps(key: string): EtherscanGet {
  let last = 0;
  return async (address) => {
    const wait = last + PAUSE_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = Date.now();
    const query = new URLSearchParams({ chainid: '1', module: 'contract', action: 'getsourcecode', address, apikey: key });
    const answer = await requestText(
      request,
      {
        hostname: 'api.etherscan.io',
        path: `/v2/api?${query}`,
        servername: 'api.etherscan.io',
        headers: { accept: 'application/json' },
        rejectUnauthorized: true,
        lookup: fallbackLookup(),
        signal: AbortSignal.timeout(60_000),
      },
      undefined,
      MAX_ANSWER_BYTES,
    );
    try {
      return { status: answer.status, body: JSON.parse(answer.text) };
    } catch {
      return { status: answer.status, body: undefined };
    }
  };
}

/** `etherscanHttps` with `ETHERSCAN_API_KEY` from the environment or `$KISS_SIGN_HOME/.env`; a missing key throws `MissingKeyError`. */
export function etherscanFromEnv(env: Env): EtherscanGet {
  const spec = keySpec('etherscan') as KeySpec;
  const key = findKey(spec, env)?.value;
  if (key === undefined) throw new MissingKeyError(spec);
  return etherscanHttps(key);
}

/** Etherscan says it is rate limited in an answer with HTTP status 200. */
function rateLimited({ body }: EtherscanAnswer): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const { status, result } = body as Record<string, unknown>;
  return status === '0' && typeof result === 'string' && /rate limit/i.test(result);
}

/** `get`, asking again after each pause while Etherscan gives no answer or is rate limited, and noting an address that never got one. */
export const retryingEtherscan =
  (get: EtherscanGet, note: NoteUnread, pausesMs?: readonly number[]): EtherscanGet =>
  (address) =>
    retried(`etherscan ${address}`, () => get(address), (answer) => transientStatus({ status: answer.status, text: '' }) ?? (rateLimited(answer) ? 'rate limited' : undefined), note, pausesMs);

function text(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== 'string') throw new Error(`${name} is not a string`);
  return value;
}

function parseSources(raw: unknown): Record<string, { content: string }> {
  const sources: Record<string, { content: string }> = {};
  for (const [path, entry] of Object.entries(record(raw))) {
    const content = record(entry).content;
    if (typeof content !== 'string') throw new Error(`${path} has no content`);
    sources[path] = { content };
  }
  if (Object.keys(sources).length === 0) throw new Error('no sources');
  return sources;
}

const escaped = (name: string): string => name.replace(/\$/g, '\\$');

/** The file `ContractFileName` names, or else the one file that defines a contract or library named `name`. */
function contractPathOf(sources: Record<string, { content: string }>, fileName: string, name: string): string {
  if (fileName !== '' && Object.hasOwn(sources, fileName)) return fileName;
  const defines = new RegExp(`\\b(?:contract|library)\\s+${escaped(name)}(?![A-Za-z0-9_$])`);
  const files = Object.keys(sources).filter((path) => defines.test((sources[path] as { content: string }).content));
  if (files.length !== 1) throw new Error(`${files.length} files define ${name}`);
  return files[0] as string;
}

/** The settings the answer's fields give for a source Etherscan holds as one file or as a file map. */
function fieldSettings(item: Record<string, unknown>): Record<string, unknown> {
  const runs = Number(text(item, 'Runs'));
  if (!Number.isSafeInteger(runs) || runs < 0) throw new Error('Runs is not a count');
  const evm = text(item, 'EVMVersion');
  return { optimizer: { enabled: text(item, 'OptimizationUsed') === '1', runs }, ...(evm === '' || /^default$/i.test(evm) ? {} : { evmVersion: evm.toLowerCase() }) };
}

/**
 * Etherscan's `getsourcecode` answer. `SourceCode` is one Solidity file, a JSON map of files, or, wrapped in a second pair
 * of braces, the standard JSON input with its own settings; the first two take their settings from the answer's fields.
 */
export function parseEtherscan(answer: EtherscanAnswer): SourceLookup {
  if (answer.status !== 200) return { kind: 'unreadable', why: `status ${answer.status}` };
  try {
    const body = record(answer.body);
    if (body.status !== '1' || !Array.isArray(body.result) || body.result.length !== 1) {
      throw new Error(`status ${String(body.status).slice(0, 8)}, ${String(body.message).slice(0, 40)}`);
    }
    const item = record(body.result[0]);
    const code = text(item, 'SourceCode');
    if (code === '') return { kind: 'not-verified' };
    const type = text(item, 'CompilerType');
    if (type === 'vyper' || text(item, 'CompilerVersion').startsWith('vyper')) return { kind: 'unsupported-language', language: 'Vyper' };
    if (type !== 'solc' && type !== 'solc-j') throw new Error('CompilerType is not solc');
    const version = COMPILER_VERSION.exec(text(item, 'CompilerVersion'));
    if (version === null) throw new Error('CompilerVersion is not a full solc version');
    const contractName = text(item, 'ContractName');
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(contractName)) throw new Error('ContractName is not an identifier');
    const fileName = text(item, 'ContractFileName');
    let sources: Record<string, { content: string }>;
    let settings: Record<string, unknown>;
    if (code.startsWith('{{') && code.endsWith('}}')) {
      const input = record(JSON.parse(code.slice(1, -1)));
      if (input.language !== 'Solidity') return { kind: 'unsupported-language', language: String(input.language).slice(0, 20) };
      sources = parseSources(input.sources);
      settings = record(input.settings);
    } else if (code.startsWith('{')) {
      sources = parseSources(JSON.parse(code));
      settings = fieldSettings(item);
    } else {
      sources = { [fileName === '' ? `${contractName}.sol` : fileName]: { content: code } };
      settings = fieldSettings(item);
    }
    const contractPath = contractPathOf(sources, fileName, contractName);
    return { kind: 'found', source: { compilerVersion: version[1] as string, language: 'Solidity', sources, settings, contractPath, contractName } };
  } catch (error) {
    return { kind: 'unreadable', why: `malformed answer: ${(error as Error).message}` };
  }
}
