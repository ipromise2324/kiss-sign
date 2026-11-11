import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SafeTxParseError, checksumAddress, parseAddress, parseHex } from './safe/types.ts';
import type { Address, Hex } from './safe/types.ts';
import { githubRepo } from './verify/self-check.ts';
import type { GithubRepo } from './verify/self-check.ts';

/** Written by `init`. Ethereum mainnet only. `repo` is the signer's own repository, whose main `verify` runs. */
export type Config = { readonly chainId: 1n; readonly safe: Address; readonly repo: GithubRepo };

/** config.json as stored. One written before `repo` existed has none until `init` runs again. */
export type StoredConfig = { readonly safe: Address; readonly repo: GithubRepo | undefined };

/** Template id to the keccak256 of its template.json, as the signer approved it. */
export type ApprovedTemplates = ReadonlyMap<string, Hex>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export const configPath = (home: string): string => join(home, 'config.json');
export const approvedPath = (home: string): string => join(home, 'approved-templates.json');

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError(`${path}: not JSON`);
  }
}

export function writeJson(home: string, path: string, value: unknown): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Undefined before `init`. */
export function loadStoredConfig(home: string): StoredConfig | undefined {
  const path = configPath(home);
  const raw = readJson(path);
  if (raw === undefined) return undefined;
  if (!isObject(raw) || raw.chainId !== 1) throw new ConfigError(`${path}: must be { "chainId": 1, "safe": <address>, "repo": "github.com/<owner>/<name>" }`);
  let safe: Address;
  try {
    safe = parseAddress('safe', raw.safe);
  } catch (error) {
    if (error instanceof SafeTxParseError) throw new ConfigError(`${path}: ${error.message}`);
    throw error;
  }
  if (raw.repo === undefined) return { safe, repo: undefined };
  const repo = typeof raw.repo === 'string' ? githubRepo(`https://${raw.repo}`) : undefined;
  if (repo === undefined || repo !== raw.repo) throw new ConfigError(`${path}: repo must be github.com/<owner>/<name> in lowercase`);
  return { safe, repo };
}

/** Undefined before `init`. */
export function loadConfig(home: string): Config | undefined {
  const stored = loadStoredConfig(home);
  if (stored === undefined) return undefined;
  if (stored.repo === undefined) {
    throw new ConfigError(`${configPath(home)} names no repository to trust. In your clone of your own fork, run pnpm kiss-sign init --safe <your Safe> again.`);
  }
  return { chainId: 1n, safe: stored.safe, repo: stored.repo };
}

export function saveConfig(home: string, config: Config): void {
  writeJson(home, configPath(home), { chainId: 1, safe: checksumAddress(config.safe), repo: config.repo });
}

export function loadApproved(home: string): ApprovedTemplates {
  const raw = readJson(approvedPath(home));
  if (raw === undefined) return new Map();
  if (!isObject(raw)) throw new ConfigError(`${approvedPath(home)}: not a JSON object`);
  try {
    return new Map(Object.entries(raw).map(([id, hash]) => [id, parseHex(id, hash)]));
  } catch (error) {
    if (error instanceof SafeTxParseError) throw new ConfigError(`${approvedPath(home)}: ${error.message}`);
    throw error;
  }
}

export function saveApproved(home: string, approved: ApprovedTemplates): void {
  writeJson(home, approvedPath(home), Object.fromEntries([...approved].sort(([a], [b]) => (a < b ? -1 : 1))));
}
