import { createHash } from 'node:crypto';
import { transientError, transientStatus } from '../chain/https.ts';
import type { HttpAnswer } from '../chain/https.ts';
import type { RegistryEntry, SdkPackage } from '../registry.ts';
import type { Hex } from '../safe/types.ts';
import { pageBlocks } from './source-page.ts';
import type { HttpGet, Page } from './source-page.ts';
import { readTarGz } from './tar.ts';

/** npm's provenance for a version: the GitHub repository whose workflow built it, and whether it names this tarball's sha512. */
export type Provenance = { readonly kind: 'none' } | { readonly kind: 'built'; readonly repository: string; readonly sameTarball: boolean };

/**
 * What the program read of one pinned package version: the tarball's sha256, whether its sha512 is npm's
 * `dist.integrity`, its provenance, and the named file as a page. `failed` is an answer that is not the package, such
 * as a 404; `unread` is no answer.
 */
export type PackageRead =
  | { readonly kind: 'read'; readonly sha256: Hex; readonly integrity: boolean; readonly provenance: Provenance; readonly file: Page }
  | { readonly kind: 'failed'; readonly why: string }
  | { readonly kind: 'unread'; readonly why: string };

export type PackageReads = ReadonlyMap<string, PackageRead>;

export const packageKey = (sdk: SdkPackage): string => `${sdk.package}@${sdk.version}`;

const REGISTRY = 'https://registry.npmjs.org/';
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const escapedName = (name: string) => name.replace('/', '%2f');

type Got = { readonly kind: 'answer'; readonly answer: HttpAnswer } | Extract<PackageRead, { kind: 'failed' | 'unread' }>;

async function fetched(url: string, get: HttpGet): Promise<Got> {
  try {
    const answer = await get(url);
    const transient = transientStatus(answer);
    return transient === undefined ? { kind: 'answer', answer } : { kind: 'unread', why: `${url} answered ${transient}` };
  } catch (error) {
    return { kind: transientError(error) ? 'unread' : 'failed', why: `${new URL(url).hostname} unreachable` };
  }
}

function json(got: Got & { kind: 'answer' }): unknown {
  try {
    return JSON.parse(got.answer.text);
  } catch {
    return undefined;
  }
}

/** The repository a provenance statement names: SLSA v1's workflow repository. */
function provenanceOf(raw: unknown, sha512: string): Provenance {
  const attestations = isRecord(raw) && Array.isArray(raw.attestations) ? raw.attestations : [];
  for (const attestation of attestations) {
    if (!isRecord(attestation) || attestation.predicateType !== 'https://slsa.dev/provenance/v1') continue;
    const envelope = isRecord(attestation.bundle) && isRecord(attestation.bundle.dsseEnvelope) ? attestation.bundle.dsseEnvelope : {};
    let statement: unknown;
    try {
      statement = JSON.parse(Buffer.from(String(envelope.payload ?? ''), 'base64').toString('utf8'));
    } catch {
      continue;
    }
    if (!isRecord(statement) || !isRecord(statement.predicate) || !isRecord(statement.predicate.buildDefinition)) continue;
    const external = statement.predicate.buildDefinition.externalParameters;
    const repository = isRecord(external) && isRecord(external.workflow) ? external.workflow.repository : undefined;
    if (typeof repository !== 'string') continue;
    const subjects = Array.isArray(statement.subject) ? statement.subject : [];
    const sameTarball = subjects.some((s) => isRecord(s) && isRecord(s.digest) && s.digest.sha512 === sha512);
    return { kind: 'built', repository, sameTarball };
  }
  return { kind: 'none' };
}

/**
 * Reads the pinned version: its metadata, its provenance and its tarball from registry.npmjs.org, then the one named
 * file of the tarball as data. Nothing in the package runs.
 */
export async function readPackage(sdk: SdkPackage, get: HttpGet): Promise<PackageRead> {
  const meta = await fetched(`${REGISTRY}${escapedName(sdk.package)}/${sdk.version}`, get);
  if (meta.kind !== 'answer') return meta;
  if (meta.answer.status !== 200) return { kind: 'failed', why: `npm answered HTTP ${meta.answer.status} for ${packageKey(sdk)}` };
  const body = json(meta);
  const dist = isRecord(body) ? body.dist : undefined;
  const tarball = isRecord(dist) ? dist.tarball : undefined;
  const integrity = isRecord(dist) ? dist.integrity : undefined;
  if (typeof tarball !== 'string' || !tarball.startsWith(REGISTRY)) return { kind: 'failed', why: `npm names no tarball on ${REGISTRY} for ${packageKey(sdk)}` };
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) return { kind: 'failed', why: `npm gives no sha512 integrity for ${packageKey(sdk)}` };
  const tar = await fetched(tarball, get);
  if (tar.kind !== 'answer') return tar;
  if (tar.answer.status !== 200 || tar.answer.bytes === undefined) return { kind: 'failed', why: `npm answered HTTP ${tar.answer.status} for the tarball of ${packageKey(sdk)}` };
  const bytes = tar.answer.bytes;
  const sha512 = createHash('sha512').update(bytes).digest();
  const attested = await fetched(`${REGISTRY}-/npm/v1/attestations/${escapedName(sdk.package)}@${sdk.version}`, get);
  if (attested.kind === 'unread') return attested;
  const provenance = attested.kind === 'answer' && attested.answer.status === 200 ? provenanceOf(json(attested), sha512.toString('hex')) : { kind: 'none' as const };
  let text: string | undefined;
  try {
    const file = readTarGz(bytes).files.get(sdk.file);
    text = file === undefined ? undefined : new TextDecoder().decode(file);
  } catch {
    return { kind: 'failed', why: `the tarball of ${packageKey(sdk)} is not a readable gzipped tar` };
  }
  return {
    kind: 'read',
    sha256: `0x${createHash('sha256').update(bytes).digest('hex')}` as Hex,
    integrity: integrity === `sha512-${sha512.toString('base64')}`,
    provenance,
    file: text === undefined ? { kind: 'failed', why: `${packageKey(sdk)} has no file ${sdk.file}` } : { kind: 'served', blocks: pageBlocks(`https://npm.invalid/${sdk.file}`, '', text) },
  };
}

/** Each entry's SDK package, read once per version. */
export async function gatherPackages(entries: readonly RegistryEntry[], get: HttpGet): Promise<Map<string, PackageRead>> {
  const reads = new Map<string, PackageRead>();
  for (const { sdk } of entries) if (sdk !== undefined && !reads.has(packageKey(sdk))) reads.set(packageKey(sdk), await readPackage(sdk, get));
  return reads;
}

/** The GitHub repository each package's provenance names, so its organization's page is read with the sources'. */
export const provenanceRepositories = (reads: PackageReads): string[] =>
  [...reads.values()].flatMap((read) => (read.kind === 'read' && read.provenance.kind === 'built' ? [read.provenance.repository] : []));
