/**
 * Loaded with `--import` into a command run by a test: every `fetch`, HTTP or HTTPS request and DNS lookup throws, and so does
 * every file system call on a path under one of the directories `SEALED_PATHS` lists, separated by `:`. Each also writes a line on
 * stderr, so a command that catches the error is still seen.
 */

import dns from 'node:dns';
import fs, { writeSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, sep } from 'node:path';

function refuse(what: string): never {
  const message = `${what}: sealed in this test`;
  writeSync(2, `${message}\n`);
  throw new Error(message);
}

const noNetwork = (): never => refuse('network');

http.request = noNetwork;
http.get = noNetwork;
https.request = noNetwork;
https.get = noNetwork;
dns.lookup = noNetwork as unknown as typeof dns.lookup;
dns.promises.lookup = noNetwork;
globalThis.fetch = noNetwork;

const sealed = (process.env.SEALED_PATHS ?? '').split(':').filter((path) => path !== '').map((path) => resolve(path));
const isSealed = (path: unknown): boolean =>
  (typeof path === 'string' || path instanceof URL) && sealed.some((dir) => { const full = resolve(path instanceof URL ? path.pathname : path); return full === dir || full.startsWith(dir + sep); });

function seal<T extends object>(module: T, names: readonly string[]): void {
  const target = module as Record<string, unknown>;
  for (const name of names) {
    const original = target[name] as (...args: unknown[]) => unknown;
    target[name] = function (this: unknown, path: unknown, ...rest: unknown[]) {
      if (isSealed(path)) refuse(`${name} ${String(path)}`);
      return original.call(this, path, ...rest);
    };
  }
}

const READS = ['readFile', 'readdir', 'stat', 'lstat', 'access', 'open', 'opendir', 'writeFile', 'mkdir', 'rm', 'cp'];
seal(fs, [...READS, ...READS.map((name) => `${name}Sync`), 'existsSync', 'createReadStream', 'createWriteStream']);
seal(fs.promises, READS);
syncBuiltinESMExports();
