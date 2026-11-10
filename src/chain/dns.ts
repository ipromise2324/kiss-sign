import { promises as dns } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { request } from 'node:https';
import { isIPv4 } from 'node:net';
import { requestText } from './https.ts';

export type Resolved = { readonly address: string; readonly family: 4 | 6 };
export type SystemLookup = (hostname: string) => Promise<readonly Resolved[]>;
/** Fetches one DoH JSON answer. The resolvers are named by IP, so asking them needs no DNS. */
export type DohQuery = (url: string) => Promise<unknown>;
export type ResolveDeps = { readonly system: SystemLookup; readonly query: DohQuery };

export const DOH_RESOLVERS = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/resolve'] as const;

const SYSTEM_DNS_FAILED = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const A_RECORD = 1;

const systemLookup: SystemLookup = async (hostname) =>
  (await dns.lookup(hostname, { all: true })).map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));

const dohQuery: DohQuery = async (url) => {
  const target = new URL(url);
  const answer = await requestText(
    request,
    {
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers: { accept: 'application/dns-json' },
      rejectUnauthorized: true,
      signal: AbortSignal.timeout(5_000),
    },
    undefined,
    64 * 1024,
  );
  if (answer.status !== 200) throw new Error(`DoH status ${answer.status}`);
  return JSON.parse(answer.text);
};

export const SYSTEM_RESOLVE: ResolveDeps = { system: systemLookup, query: dohQuery };

function aRecords(raw: unknown): Resolved[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const { Status, Answer } = raw as { Status?: unknown; Answer?: unknown };
  if (Status !== 0 || !Array.isArray(Answer)) return [];
  return Answer.flatMap((record: unknown) => {
    const { type, data } = (typeof record === 'object' && record !== null ? record : {}) as { type?: unknown; data?: unknown };
    return type === A_RECORD && typeof data === 'string' && isIPv4(data) ? [{ address: data, family: 4 as const }] : [];
  });
}

export async function resolveOverHttps(hostname: string, query: DohQuery): Promise<Resolved[]> {
  for (const resolver of DOH_RESOLVERS) {
    try {
      const addresses = aRecords(await query(`${resolver}?name=${encodeURIComponent(hostname)}&type=A`));
      if (addresses.length > 0) return addresses;
    } catch {
      continue;
    }
  }
  throw Object.assign(new Error(`${hostname} did not resolve over DNS over HTTPS`), { code: 'ENOTFOUND' });
}

export async function resolveHost(hostname: string, deps: ResolveDeps): Promise<readonly Resolved[]> {
  try {
    return await deps.system(hostname);
  } catch (error) {
    if (!SYSTEM_DNS_FAILED.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    return resolveOverHttps(hostname, deps.query);
  }
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for node:https. Only the IP comes from DoH: TLS still checks the certificate against the host name, so a
 * wrong address can only fail the connection.
 */
export function fallbackLookup(deps: ResolveDeps = SYSTEM_RESOLVE) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolveHost(hostname, deps).then(
      (addresses) => {
        const first = addresses[0];
        if (first === undefined) callback(Object.assign(new Error(`${hostname} has no address`), { code: 'ENOTFOUND' }), '');
        else if (options.all === true) callback(null, addresses.map(({ address, family }) => ({ address, family })));
        else callback(null, first.address, first.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, ''),
    );
  };
}
