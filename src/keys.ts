import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const KEYS = [
  {
    name: 'alchemy',
    label: 'Alchemy',
    env: 'ALCHEMY_API_KEY',
    signup: 'https://dashboard.alchemy.com/',
    usedBy: 'pnpm kiss-sign verify, pnpm kiss-sign card new, and the pnpm research scripts',
  },
  { name: 'etherscan', label: 'Etherscan', env: 'ETHERSCAN_API_KEY', signup: 'https://etherscan.io/myapikey', usedBy: 'pnpm past-txs' },
] as const;

export type KeySpec = (typeof KEYS)[number];
export type KeyName = KeySpec['name'];
export type Env = Readonly<Record<string, string | undefined>>;
export type FoundKey = { readonly value: string; readonly from: 'environment' | 'file' };

const KEY_SHAPE = /^[A-Za-z0-9_.-]{8,256}$/;

export class KeyError extends Error {
  override name = 'KeyError';
}

export function keySpec(name: string): KeySpec | undefined {
  return KEYS.find((spec) => spec.name === name);
}

export function kissSignHome(env: Env): string {
  const home = env.KISS_SIGN_HOME;
  return home !== undefined && home !== '' ? home : join(homedir(), '.kiss-sign');
}

export function keyFilePath(home: string): string {
  return join(home, '.env');
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').map((line) => line.replace(/\r$/, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function isLineFor(line: string, spec: KeySpec): boolean {
  return line.trim().startsWith(`${spec.env}=`);
}

function valueIn(lines: readonly string[], spec: KeySpec): string | undefined {
  const value = lines.findLast((line) => isLineFor(line, spec))?.trim().slice(spec.env.length + 1);
  return value === undefined || value === '' ? undefined : value;
}

/** The environment wins over the key file. A `.env` in the working directory is never read. */
export function findKey(spec: KeySpec, env: Env): FoundKey | undefined {
  const fromEnv = env[spec.env];
  if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv, from: 'environment' };
  const fromFile = valueIn(readLines(keyFilePath(kissSignHome(env))), spec);
  return fromFile === undefined ? undefined : { value: fromFile, from: 'file' };
}

function writeAtomically(home: string, lines: readonly string[]): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = keyFilePath(home);
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const text = lines.filter((line) => line !== '').map((line) => `${line}\n`).join('');
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Writes a key file with one empty line per key, readable by the owner only. False when a file is already there, which is left as it is. */
export function createKeyFile(home: string): boolean {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const text = KEYS.map((spec) => `# ${spec.label}, a free key from ${spec.signup}, for ${spec.usedBy}.\n${spec.env}=\n`).join('');
  let fd: number;
  try {
    fd = openSync(keyFilePath(home), 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}

export function saveKey(home: string, spec: KeySpec, value: string): void {
  if (!KEY_SHAPE.test(value)) {
    throw new KeyError(`An ${spec.label} key is 8 to 256 letters, digits, '.', '-' or '_', and what you typed is not. No key saved.`);
  }
  const lines = readLines(keyFilePath(home));
  const line = `${spec.env}=${value}`;
  const kept = lines.filter((existing) => !isLineFor(existing, spec));
  writeAtomically(home, [...kept, line]);
}

/** True when the file held the key. */
export function removeKey(home: string, spec: KeySpec): boolean {
  const lines = readLines(keyFilePath(home));
  const kept = lines.filter((line) => !isLineFor(line, spec));
  if (kept.length === lines.length) return false;
  writeAtomically(home, kept);
  return true;
}
