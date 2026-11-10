import { gunzipSync } from 'node:zlib';

export type TarArchive = {
  /** The pax global header's `comment`, where GitHub writes the commit an archive was made from. */
  readonly comment: string | undefined;
  /** Regular files by path, with the archive's top directory removed. */
  readonly files: ReadonlyMap<string, Uint8Array>;
};

export class TarError extends Error {
  override name = 'TarError';
}

const BLOCK = 512;
const MAX_UNPACKED = 256 * 1024 * 1024;

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/\0.*$/s, '');

function octal(bytes: Uint8Array): number {
  const digits = text(bytes).trim();
  if (!/^[0-7]+$/.test(digits)) throw new TarError('a tar header with a bad size');
  return Number.parseInt(digits, 8);
}

function paxRecords(bytes: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const body = new TextDecoder().decode(bytes);
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(' ', at);
    const length = Number(body.slice(at, space));
    if (space < 0 || !Number.isSafeInteger(length) || length <= 0) throw new TarError('a malformed pax record');
    const record = body.slice(space + 1, at + length - 1);
    const equals = record.indexOf('=');
    if (equals < 0) throw new TarError('a malformed pax record');
    records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

/** Reads a gzipped ustar archive with pax headers, as GitHub's codeload serves one. Links and devices are skipped. */
export function readTarGz(gzipped: Uint8Array): TarArchive {
  const tar = gunzipSync(gzipped, { maxOutputLength: MAX_UNPACKED });
  const files = new Map<string, Uint8Array>();
  let comment: string | undefined;
  let nextPath: string | undefined;
  for (let at = 0; at + BLOCK <= tar.length; ) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const body = tar.subarray(at + BLOCK, at + BLOCK + size);
    if (body.length !== size) throw new TarError('a truncated tar archive');
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'g') {
      comment = paxRecords(body).get('comment') ?? comment;
      continue;
    }
    if (type === 'x') {
      nextPath = paxRecords(body).get('path');
      continue;
    }
    const prefix = text(header.subarray(345, 500));
    const name = nextPath ?? (prefix === '' ? '' : `${prefix}/`) + text(header.subarray(0, 100));
    nextPath = undefined;
    if (type !== '0' && type !== '\0') continue;
    const path = name.split('/').slice(1).join('/');
    if (path === '' || path.split('/').some((part) => part === '..' || part === '.' || part === '')) throw new TarError(`an archive path that is not plain: ${JSON.stringify(name)}`);
    files.set(path, body);
  }
  return { comment, files };
}
