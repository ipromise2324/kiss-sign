import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadStoredConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { loadRegistry } from '../src/registry.ts';
import { alchemyCall, trimVaultRecording, vaultEvidenceText } from '../src/research/vault-evidence.ts';

const USAGE = `usage: ALCHEMY_API_KEY=... node scripts/vault-evidence.ts <registry vault name> [--record <name>]

Reads the vault's totalAssets() about every 30 days over the last 12 months through Alchemy and drpc, and counts its
share holders at the latest block: every address the Alchemy Transfers API shows receiving shares, with balances read
through both providers that must add up to totalSupply(). It prints evidence, no verdict, and no holder address.

The numbers come from the vault's own code. A vault that names a factory is read only after that factory answers, as
pnpm prove-instance asks it, that it created the vault.`;

const { values: flags, positionals } = parseArgs({ options: { record: { type: 'string' } }, allowPositionals: true });
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new Error('--record takes a name of lowercase letters, digits and -');
const root = join(import.meta.dirname, '..');
const registry = loadRegistry(root);
const [name] = positionals;
const vault = name === undefined ? undefined : registry.entries.get(name);
if (vault?.kind !== 'vault') {
  console.error(`${name === undefined ? 'no vault named' : `${name} is not a vault in the registry`}\n\n${USAGE}`);
  process.exit(2);
}

const endpoints = mainnetEndpoints(process.env);
const recording = recordingTransport(httpsTransport(), endpoints);
const reader = createReader(endpoints, recording.transport);
const { read, text } = await vaultEvidenceText(reader, alchemyCall(recording.transport, endpoints[0].url), registry, vault);
console.log(text);
if (!read) process.exit(1);

if (flags.record !== undefined) {
  const safe = loadStoredConfig(kissSignHome(process.env))?.safe;
  const fixture = { vault: vault.name, exchanges: trimVaultRecording(recording.exchanges()) };
  if (safe !== undefined && JSON.stringify(fixture).toLowerCase().includes(safe.slice(2))) {
    console.error('the configured Safe holds or once held these shares, so the recording would name it; nothing written');
    process.exit(1);
  }
  const dir = join(root, 'testdata', 'vault-evidence');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${flags.record}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`recorded ${path}`);
}
