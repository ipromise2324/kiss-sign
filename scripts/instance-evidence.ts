import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadStoredConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadRegistry, sizeOf } from '../src/registry.ts';
import { alchemyCall, trimVaultRecording, vaultEvidenceText } from '../src/research/instance-evidence.ts';
import { recordingText } from '../src/chain/bytecode.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = 'usage: pnpm instance-evidence <registry name> [--record <name>]';
const HELP = `${USAGE}

First asks the entry's factory, as pnpm prove-instance does, whether it vouches for the entry,
printing one admitted line per answer, and reads nothing of an entry it does not admit; an entry
with no factory gets a note instead. It then reads the size the entry or its factory declares,
such as a vault's totalAssets() in the token its asset() answers, about every 30 days over the last
12 months through both providers; a month they disagree on is UNVERIFIABLE. For a size that counts
holders it counts the share holders at the latest block: recipients from the Alchemy Transfers API,
balances through Multicall3 on both providers, which must add up to totalSupply(). It prints the
holder count and the top 10 holders' share, no address and no verdict. An entry with no size, of
its own or its factory's, is refused.

Options:
  --record <name>   Write testdata/instance-evidence/<name>.json; refused, writing nothing, when a
                    read got no answer or the recording names the configured Safe. <name> takes
                    lowercase letters, digits and -.

Writes: testdata/instance-evidence/<name>.json with --record, otherwise nothing.
Keys: ALCHEMY_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 2, Vault
history); docs/design/data-shapes.md, "Registry attributes and instance checks".`;

exitOnHelp(HELP);

const { values: flags, positionals } = parseArgs({ options: { record: { type: 'string' } }, allowPositionals: true });
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new Error('--record takes a name of lowercase letters, digits and -');
const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
const [name] = positionals;
const vault = name === undefined ? undefined : registry.entries.get(name);
if (vault === undefined || sizeOf(vault, registry) === undefined) {
  console.error(`${name === undefined ? 'no entry named' : `${name} is not a registry entry that declares a size, or whose factory does`}\n\n${USAGE}`);
  process.exit(2);
}

const endpoints = mainnetEndpoints(process.env);
const recording = recordingTransport(httpsTransport(), endpoints);
const unread: string[] = [];
const note = (read: string) => void unread.push(read);
const reader = createReader(endpoints, recording.transport, { note });
const { read, text } = await vaultEvidenceText(reader, alchemyCall(recording.transport, endpoints[0].url, note), registry, vault);
console.log(text);
if (!read) process.exit(1);

if (flags.record !== undefined) {
  const refusal = unreadRefusal(unread);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exit(1);
  }
  const safe = loadStoredConfig(kissSignHome(process.env))?.safe;
  const fixture = { vault: vault.name, exchanges: trimVaultRecording(recording.exchanges()) };
  if (safe !== undefined && JSON.stringify(fixture).toLowerCase().includes(safe.slice(2))) {
    console.error('the configured Safe holds or once held these shares, so the recording would name it; nothing written');
    process.exit(1);
  }
  const dir = join(root, 'testdata', 'instance-evidence');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${flags.record}.json`);
  writeFileSync(path, recordingText(fixture, 2));
  console.log(`recorded ${path}`);
}
