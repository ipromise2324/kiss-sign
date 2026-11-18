import { createHash } from 'node:crypto';
import type { PackagePin } from '../verify/package-pins.ts';
import { readTarGz } from './tar.ts';

const REGISTRY = 'https://registry.npmjs.org/';

export type PinRead = { readonly kind: 'pinned'; readonly integrity: string; readonly pin: PackagePin } | { readonly kind: 'refused'; readonly why: string };

export type Get = (url: string) => Promise<{ readonly status: number; readonly bytes: Uint8Array }>;

/**
 * Reads `<name>@<version>` from registry.npmjs.org and pins its tarball's files when the tarball's sha512 is `integrity`,
 * the lockfile's, or npm's `dist.integrity` for a version the lockfile does not hold. Nothing in the package runs.
 */
export async function readPackagePin(name: string, version: string, integrity: string | undefined, get: Get): Promise<PinRead> {
  const meta = await get(`${REGISTRY}${name.replace('/', '%2f')}/${version}`);
  if (meta.status !== 200) return { kind: 'refused', why: `npm answered HTTP ${meta.status} for ${name}@${version}` };
  const dist = (JSON.parse(new TextDecoder().decode(meta.bytes)) as { dist?: { tarball?: unknown; integrity?: unknown } }).dist;
  const expected = integrity ?? dist?.integrity;
  if (typeof dist?.tarball !== 'string' || !dist.tarball.startsWith(REGISTRY)) return { kind: 'refused', why: `npm names no tarball on ${REGISTRY} for ${name}@${version}` };
  if (typeof expected !== 'string' || !expected.startsWith('sha512-')) return { kind: 'refused', why: `no sha512 integrity for ${name}@${version}` };
  const tarball = await get(dist.tarball);
  if (tarball.status !== 200) return { kind: 'refused', why: `npm answered HTTP ${tarball.status} for ${dist.tarball}` };
  const sha512 = `sha512-${createHash('sha512').update(tarball.bytes).digest('base64')}`;
  if (sha512 !== expected) return { kind: 'refused', why: `the tarball of ${name}@${version} is ${sha512}, not ${expected}` };
  const files = [...readTarGz(tarball.bytes).files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, bytes]) => [path, createHash('sha256').update(bytes).digest('hex')]);
  return { kind: 'pinned', integrity: sha512, pin: { package: `${name}@${version}`, files: Object.fromEntries(files) } };
}

/** The text of `src/verify/package-pins.ts` holding `pins`, sorted by package. */
export function packagePinsText(pins: Readonly<Record<string, PackagePin>>): string {
  const sorted = Object.fromEntries(Object.entries(pins).sort(([, a], [, b]) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0)));
  return `/** Every file of a package's tarball with its sha256, keyed by the tarball's sha512 as pnpm-lock.yaml gives it. */
export type PackagePin = { readonly package: string; readonly files: Readonly<Record<string, string>> };

/**
 * Written by \`node scripts/pin-packages.ts\`, which downloads each tarball from registry.npmjs.org and requires its sha512
 * to be the key before it hashes the files. Every command of bin/kiss-sign requires each package it loads to hold
 * exactly these files.
 */
export const PACKAGE_PINS: Readonly<Record<string, PackagePin>> = ${JSON.stringify(sorted, null, 2)};
`;
}
