import { request } from 'node:https';
import { fallbackLookup } from '../chain/dns.ts';
import { requestText } from '../chain/https.ts';
import { record } from '../chain/types.ts';
import { parseAddress } from '../safe/types.ts';
import type { Address } from '../safe/types.ts';

/** What solc needs to rebuild one contract. Sourcify's ABI and bytecode are never read. */
export type VerifiedSource = {
  readonly compilerVersion: string;
  readonly language: 'Solidity';
  readonly sources: Readonly<Record<string, { readonly content: string }>>;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly contractPath: string;
  readonly contractName: string;
};

/** `body` is the parsed JSON, or undefined when the answer was not JSON. */
export type SourcifyAnswer = { readonly status: number; readonly body: unknown };
export type SourcifyGet = (address: Address) => Promise<SourcifyAnswer>;

export type SourceLookup =
  | { readonly kind: 'found'; readonly source: VerifiedSource }
  | { readonly kind: 'not-verified' }
  | { readonly kind: 'unsupported-language'; readonly language: string }
  | { readonly kind: 'unreadable'; readonly why: string };

export const SOURCIFY_FIELDS = 'compilation,stdJsonInput';

const COMPILER_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+\+commit\.[0-9a-f]{8}$/;
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

export const sourcifyHttps: SourcifyGet = async (address) => {
  const answer = await requestText(
    request,
    {
      hostname: 'sourcify.dev',
      path: `/server/v2/contract/1/${address}?fields=${SOURCIFY_FIELDS}`,
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

function text(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is not a string`);
  return value;
}

function parseSources(raw: unknown): Record<string, { content: string }> {
  const sources: Record<string, { content: string }> = {};
  for (const [path, entry] of Object.entries(record(raw))) {
    sources[path] = { content: text(record(entry), 'content') };
  }
  return sources;
}

/** Sourcify's v2 contract record for `address` on mainnet, fetched with `fields=compilation,stdJsonInput`. */
export function parseSourcify(address: Address, answer: SourcifyAnswer): SourceLookup {
  if (answer.status === 404) return { kind: 'not-verified' };
  if (answer.status !== 200) return { kind: 'unreadable', why: `status ${answer.status}` };
  try {
    const body = record(answer.body);
    if (body.chainId !== '1' || parseAddress('address', body.address) !== address) throw new Error('a record for another contract');
    const compilation = record(body.compilation);
    const input = record(body.stdJsonInput);
    const language = text(compilation, 'language');
    if (language !== 'Solidity' || input.language !== 'Solidity') return { kind: 'unsupported-language', language };
    const compilerVersion = text(compilation, 'compilerVersion');
    if (!COMPILER_VERSION.test(compilerVersion)) throw new Error('compilerVersion is not a full solc version');
    const qualified = text(compilation, 'fullyQualifiedName');
    const colon = qualified.lastIndexOf(':');
    const contractPath = qualified.slice(0, colon);
    const contractName = qualified.slice(colon + 1);
    const sources = parseSources(input.sources);
    if (colon <= 0 || contractName === '' || !Object.hasOwn(sources, contractPath)) throw new Error('fullyQualifiedName names no source');
    return { kind: 'found', source: { compilerVersion, language, sources, settings: record(input.settings), contractPath, contractName } };
  } catch (error) {
    return { kind: 'unreadable', why: `malformed record: ${(error as Error).message}` };
  }
}
