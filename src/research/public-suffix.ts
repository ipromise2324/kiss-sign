import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';

/** The list at commit 8437e526 of github.com/publicsuffix/list; the raw file and GitHub's contents API gave the same sha256. */
export const PUBLIC_SUFFIX_PIN = {
  url: 'https://raw.githubusercontent.com/publicsuffix/list/8437e5262f13305f94087abe699b4fe2be1d1de8/public_suffix_list.dat',
  file: 'public_suffix_list.dat',
  sha256: 'd3e6243b51695327984abb3e2a5aa7077096867f75121e031e6a5a3840ca8bcd',
} as const;

export const PUBLIC_SUFFIX_DIR = join(import.meta.dirname, '..', '..', 'vendor', 'publicsuffix');

/** Hosts that give each owner a subdomain, as the list's private section does, that the list leaves out. */
const UNLISTED_SHARED = ['medium.com', 'mirror.xyz', 'substack.com'];

/**
 * Platforms that give each owner a path, such as `github.com/<org>` or `linktr.ee/<name>`, which the list cannot name:
 * the platform and every subdomain of it, such as `www.youtube.com` or `apps.apple.com`, are the platform's host, never
 * an owner's site.
 */
const PATH_SHARED = ['github.com', 'gitlab.com', 'linktr.ee', 'x.com', 'twitter.com', 't.me', 'discord.gg', 'discord.com', 'youtube.com', 'notion.so', 'google.com', 'apple.com', 'snapshot.org', 'immunefi.com'];

export type PublicSuffixList = { readonly rules: ReadonlySet<string> };
export type SuffixListUnavailable = { readonly unavailable: string };

export function parsePublicSuffixList(text: string): PublicSuffixList {
  const rules = new Set<string>([...UNLISTED_SHARED, ...PATH_SHARED, ...PATH_SHARED.map((host) => `*.${host}`)]);
  for (const line of text.split('\n')) {
    const rule = line.trim().split(/\s/)[0];
    if (rule === undefined || rule === '' || rule.startsWith('//')) continue;
    const prefix = rule.startsWith('!') ? '!' : rule.startsWith('*.') ? '*.' : '';
    rules.add(prefix + domainToASCII(rule.slice(prefix.length)));
  }
  return { rules };
}

export function loadPublicSuffixList(dir: string = PUBLIC_SUFFIX_DIR): PublicSuffixList | SuffixListUnavailable {
  const path = join(dir, PUBLIC_SUFFIX_PIN.file);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { unavailable: `${path} missing; run pnpm fetch-psl` };
    throw error;
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== PUBLIC_SUFFIX_PIN.sha256) return { unavailable: `${path} sha256 ${actual} is not the pinned ${PUBLIC_SUFFIX_PIN.sha256}` };
  return parsePublicSuffixList(bytes.toString('utf8'));
}

/** The registrable domain (eTLD+1), such as `morpho.org` for `docs.morpho.org`; undefined for an IP or a public suffix itself. */
export function registrableDomain(host: string, list: PublicSuffixList): string | undefined {
  if (isIP(host) !== 0 || host.startsWith('[')) return undefined;
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  const suffixAt = (i: number) => labels.slice(i).join('.');
  let suffixLabels = 1;
  for (let i = 0; i < labels.length; i++) {
    if (list.rules.has(`!${suffixAt(i)}`)) {
      suffixLabels = labels.length - i - 1;
      break;
    }
    if (list.rules.has(suffixAt(i)) || (i + 1 < labels.length && list.rules.has(`*.${suffixAt(i + 1)}`))) {
      suffixLabels = labels.length - i;
      break;
    }
  }
  return suffixLabels >= labels.length ? undefined : suffixAt(labels.length - suffixLabels - 1);
}
