import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { mainnetEndpoints, MissingKeyError } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadRegistry } from '../src/registry.ts';
import { chainAt, formatReports, loadSnapshot, studyEntries, trimForRecording } from '../src/research/erc7730.ts';
import type { ChainAccess, Erc7730Recording } from '../src/research/erc7730.ts';

const USAGE = `usage: [ALCHEMY_API_KEY=...] node scripts/erc7730.ts <registry name>... [--record <name>]

Finds each registry contract's ERC-7730 calldata descriptors in the pinned registry archive (pnpm fetch-erc7730), and
prints only structured facts: file path, hashes, scope, selectors, field paths and format names, and each ERC-8176
attestation checked against both providers. With no key, attestations print as UNVERIFIABLE.`;

const { values: flags, positionals: names } = parseArgs({ options: { record: { type: 'string' } }, allowPositionals: true });
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new Error('--record takes a name of lowercase letters, digits and -');

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
const unknown = names.filter((name) => !registry.entries.has(name));
if (names.length === 0 || unknown.length > 0) {
  console.error(`${unknown.length > 0 ? `not in the registry: ${unknown.join(', ')}\n\n` : ''}${USAGE}`);
  process.exit(2);
}
const snapshot = loadSnapshot();
if ('unavailable' in snapshot) {
  console.error(snapshot.unavailable);
  process.exit(1);
}

let exchanges: () => unknown[] = () => [];
async function openChain(): Promise<ChainAccess> {
  let endpoints;
  try {
    endpoints = mainnetEndpoints(process.env);
  } catch (error) {
    if (error instanceof MissingKeyError) return { unavailable: 'ALCHEMY_API_KEY is not set, so the chain was not read' };
    throw error;
  }
  const recording = recordingTransport(httpsTransport(), endpoints);
  exchanges = recording.exchanges;
  return chainAt(createReader(endpoints, recording.transport));
}

const entries = names.map((name) => registry.entries.get(name)!);
const reports = await studyEntries(entries, registry, snapshot, openChain);
console.log(formatReports(snapshot, reports));

if (flags.record !== undefined) {
  const dir = join(root, 'testdata', 'erc7730');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${flags.record}.json`);
  const recording: Erc7730Recording = {
    commit: snapshot.commit,
    fetched: new Date().toISOString().slice(0, 10),
    entries: names,
    files: Object.fromEntries(trimForRecording(snapshot, reports)),
    chain: exchanges(),
  };
  writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`);
  console.log(`recorded ${path}`);
}
