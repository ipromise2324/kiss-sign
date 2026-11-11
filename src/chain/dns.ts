import { promises as dns } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP, isIPv4 } from 'node:net';
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

/** The A records of a DoH answer, or undefined when the resolver could not answer now, as with SERVFAIL. */
function aRecords(raw: unknown): Resolved[] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { Status, Answer } = raw as { Status?: unknown; Answer?: unknown };
  if (Status === 3) return [];
  if (Status !== 0) return undefined;
  if (!Array.isArray(Answer)) return [];
  return Answer.flatMap((record: unknown) => {
    const { type, data } = (typeof record === 'object' && record !== null ? record : {}) as { type?: unknown; data?: unknown };
    return type === A_RECORD && typeof data === 'string' && isIPv4(data) ? [{ address: data, family: 4 as const }] : [];
  });
}

/**
 * A host's A records over DoH. Only a resolver's answer makes a name not exist (`ENOTFOUND`); when none answers, the
 * lookup fails as an outage (`EAI_AGAIN`), whatever the system resolver said, since offline it too says `ENOTFOUND`.
 */
export async function resolveOverHttps(hostname: string, query: DohQuery): Promise<Resolved[]> {
  let answered = false;
  for (const resolver of DOH_RESOLVERS) {
    try {
      const addresses = aRecords(await query(`${resolver}?name=${encodeURIComponent(hostname)}&type=A`));
      if (addresses === undefined) continue;
      answered = true;
      if (addresses.length > 0) return addresses;
    } catch {
      continue;
    }
  }
  throw Object.assign(new Error(`${hostname} did not resolve over DNS over HTTPS`), { code: answered ? 'ENOTFOUND' : 'EAI_AGAIN' });
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
 * Addresses no public server has: loopback, private, link-local, shared, documentation, benchmark, multicast and reserved
 * ranges. One list per family, since a BlockList also matches an IPv4 address against an IPv6 rule for its mapped form.
 */
const NOT_PUBLIC = { ipv4: new BlockList(), ipv6: new BlockList() };
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NOT_PUBLIC.ipv4.addSubnet(network, prefix, 'ipv4');
// Only global unicast, 2000::/3, is public, less Teredo and 6to4, which embed an IPv4 address, and the benchmarking and
// documentation ranges; NAT64's 64:ff9b::/96 is checked by the IPv4 address it embeds, so a host on a DNS64 network
// stays reachable.
for (const [network, prefix] of [['2001::', 32], ['2001:2::', 48], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) NOT_PUBLIC.ipv6.addSubnet(network, prefix, 'ipv6');
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet('2000::', 3, 'ipv6');
const NAT64 = new BlockList();
NAT64.addSubnet('64:ff9b::', 96, 'ipv6');

/** The last 32 bits of an IPv6 address as dotted IPv4. */
function embeddedIpv4(address: string): string {
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const words = (part: string) => (part === '' ? [] : part.split(':'));
  const groups = [...words(head), ...Array(8 - words(head).length - words(tail).length).fill('0'), ...words(tail)];
  const [high, low] = groups.slice(6).map((g) => parseInt(g, 16)) as [number, number];
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/** Whether a public server can have `address`; its family is read from the address itself. */
export function isPublicAddress({ address }: Pick<Resolved, 'address'>): boolean {
  const family = isIP(address);
  if (family === 4) return !NOT_PUBLIC.ipv4.check(address, 'ipv4');
  if (family !== 6 || address.includes('.')) return false;
  if (NAT64.check(address, 'ipv6')) return isPublicAddress({ address: embeddedIpv4(address) });
  return GLOBAL_UNICAST.check(address, 'ipv6') && !NOT_PUBLIC.ipv6.check(address, 'ipv6');
}

/**
 * Refuses a URL host that is an IP literal no public server has. Node connects to a literal without a lookup, so
 * `fallbackLookup`'s `publicOnly` never sees it.
 */
export function publicHost(hostname: string): string | undefined {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) === 0 || isPublicAddress({ address: bare })) return undefined;
  return `${hostname} is not a public address`;
}

/**
 * A `lookup` for node:https. Only the IP comes from DoH: TLS still checks the certificate against the host name, so a
 * wrong address can only fail the connection. With `publicOnly`, a host with any address no public server has is
 * refused, so a URL from the registry cannot reach this machine or its network.
 */
export function fallbackLookup(deps: ResolveDeps = SYSTEM_RESOLVE, publicOnly = false) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolveHost(hostname, deps).then(
      (addresses) => {
        const first = addresses[0];
        if (publicOnly && !addresses.every(isPublicAddress)) callback(Object.assign(new Error(`${hostname} resolves to an address that is not public`), { code: 'ENOTPUBLIC' }), '');
        else if (first === undefined) callback(Object.assign(new Error(`${hostname} has no address`), { code: 'ENOTFOUND' }), '');
        else if (options.all === true) callback(null, addresses.map(({ address, family }) => ({ address, family })));
        else callback(null, first.address, first.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, ''),
    );
  };
}
