import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { mainnetEndpoints, MissingKeyError } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadRegistry } from '../src/registry.ts';
import { chainAt, formatReports, loadSnapshot, studyEntries, trimForRecording } from '../src/research/erc7730.ts';
import type { ChainAccess, Erc7730Recording } from '../src/research/erc7730.ts';
import { ensureVendored, nodeVendorIoWith } from '../src/vendor.ts';
import { readGithubToken } from '../src/research/github-token.ts';
import { recordingText } from '../src/chain/bytecode.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = 'usage: pnpm erc7730 <registry name>... [--record <name>]';
const HELP = `${USAGE}

Finds each entry's ERC-7730 calldata descriptors in the pinned archive of the ERC-7730 registry, by
exact address or by the entry's registry factory (printed loudly), and its EIP-712 descriptors by
exact address when they bind no domain name or version, which a Safe's own SafeTx never has. It
prints only structured facts: path, file sha256, ERC-8176 descriptorHash, includes, per function
the selector, per EIP-712 message its primary type and type hash, each field's path, format and
visibility, and each ERC-8176 attestation as VALID, REVOKED, EXPIRED, INVALID or
UNVERIFIABLE, with its signer recovered and its revocation read through both providers. It never
prints descriptor text. Without ALCHEMY_API_KEY and DRPC_API_KEY the attestations print as
UNVERIFIABLE. It downloads a missing or changed archive first, as pnpm fetch-erc7730 does.

Options:
  --record <name>   Write testdata/erc7730/<name>.json; refused when a chain read got no answer.
                    <name> takes lowercase letters, digits and -.

Writes: testdata/erc7730/<name>.json with --record, otherwise nothing.
Keys: ALCHEMY_API_KEY and DRPC_API_KEY, optional, from the environment or $KISS_SIGN_HOME/.env.
GITHUB_TOKEN, optional, sent only to api.github.com when the archive is fetched; it raises GitHub's
limit from 60 to 5,000 requests an hour and changes no answer.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 2,
ERC-7730); docs/design/engine-and-chain.md, "Research services".`;

exitOnHelp(HELP);

const { values: flags, positionals: names } = parseArgs({ options: { record: { type: 'string' } }, allowPositionals: true });
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new Error('--record takes a name of lowercase letters, digits and -');

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
const unknown = names.filter((name) => !registry.entries.has(name));
if (names.length === 0 || unknown.length > 0) {
  console.error(`${unknown.length > 0 ? `not in the registry: ${unknown.join(', ')}\n\n` : ''}${USAGE}`);
  process.exit(2);
}
if (!(await ensureVendored(['erc7730'], nodeVendorIoWith(readGithubToken(process.env))))) process.exit(1);
const snapshot = loadSnapshot();
if ('unavailable' in snapshot) {
  console.error(snapshot.unavailable);
  process.exit(1);
}

let exchanges: () => unknown[] = () => [];
const unread: string[] = [];
async function openChain(): Promise<ChainAccess> {
  let endpoints;
  try {
    endpoints = mainnetEndpoints(process.env);
  } catch (error) {
    if (error instanceof MissingKeyError) return { unavailable: `${error.env} is not set, so the chain was not read` };
    throw error;
  }
  const recording = recordingTransport(httpsTransport(), endpoints);
  exchanges = recording.exchanges;
  return chainAt(createReader(endpoints, recording.transport, { note: (read) => void unread.push(read) }));
}

const entries = names.map((name) => registry.entries.get(name)!);
const reports = await studyEntries(entries, registry, snapshot, openChain);
console.log(formatReports(snapshot, reports));

if (flags.record !== undefined) {
  const refusal = unreadRefusal(unread);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exit(1);
  }
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
  writeFileSync(path, recordingText(recording, 2));
  console.log(`recorded ${path}`);
}
