import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = process.env.KISS_SIGN_CANARY_READS;
if (log !== undefined && log !== '') {
  const append = fs.appendFileSync;
  const real = fs.realpathSync.native;
  const record = (path: unknown): void => {
    if (typeof path !== 'string' && !(path instanceof URL)) return;
    const absolute = resolve(path instanceof URL ? fileURLToPath(path) : path);
    let target = absolute;
    try {
      target = real(absolute);
    } catch {}
    append(log, `${target}\n`);
  };
  const wrap = <T extends object>(target: T, names: readonly string[]): void => {
    for (const name of names) {
      const original = (target as Record<string, unknown>)[name];
      if (typeof original !== 'function') continue;
      (target as Record<string, unknown>)[name] = function (this: unknown, path: unknown, ...rest: unknown[]) {
        record(path);
        return original.call(this, path, ...rest);
      };
    }
  };
  wrap(fs, ['readFileSync', 'readFile', 'readdirSync', 'readdir', 'existsSync', 'statSync', 'stat', 'lstatSync', 'openSync', 'open', 'opendirSync', 'createReadStream', 'cpSync', 'copyFileSync']);
  wrap(fs.promises, ['readFile', 'readdir', 'stat', 'lstat', 'open', 'opendir', 'cp', 'copyFile']);
  syncBuiltinESMExports();
}
