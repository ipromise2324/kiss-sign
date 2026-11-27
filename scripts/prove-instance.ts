import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordingText } from '../src/chain/bytecode.ts';
import { unreadRefusal } from '../src/chain/https.ts';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { createReader } from '../src/chain/reader.ts';
import { recordingTransport, trimBlockAnswers } from '../src/chain/recording.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import { admitted, proveInstance } from '../src/contracts/instance.ts';
import { ATTRIBUTES_PATH, MARKETS_PATH, REGISTRY_PATH, attributesText, marketsText, registryFromTexts } from '../src/registry.ts';
import { checksumAddress } from '../src/safe/types.ts';
import { parseFlags } from '../src/cli/flags.ts';
import { UsageError } from '../src/cli/io.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';

const USAGE = 'usage: pnpm prove-instance <registry name> [--registry <dir>] [--record <name>]';
const HELP = `${USAGE}

Asks every view of the instanceCheck of the factory the entry's factory attribute names whether it
vouches for the entry, through both providers at the latest block. A view such as
isMetaMorpho(address) must answer true. One with bound arguments, such as
computeToken(address,string) with the entry's asset and "fToken", or getPool(address,address,uint24)
with its token0, token1 and 500, must answer the entry's own address. A view asked of each entry
naming the entry (namedBy), such as a Vault V2's isAdapter(address), or of the entry itself, such
as an adapter's parentVault(), must answer as declared. It prints what it asked of whom and the
answer both providers gave. It prints REFUSED and exits 1 for an entry with no factory to ask and
for any view that does not answer as declared.

Options:
  --registry <dir>  Add the entries, markets and attributes of <dir>/contracts.json,
                    <dir>/markets.json and <dir>/attributes.json, such as a test fixture's, to the
                    repository's; a name the repository's file already holds is refused.
  --record <name>   Write testdata/instance/<name>.json once every view passed; refused when a read
                    got no answer. <name> takes lowercase letters, digits and -.

Writes: testdata/instance/<name>.json with --record, otherwise nothing.
Keys: ALCHEMY_API_KEY and DRPC_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
Rules: docs/design/data-shapes.md, "Registry attributes and instance checks".`;

exitOnHelp(HELP);
refuseReadableErrors();

const { values: flags, positionals } = parseFlags({ options: { registry: { type: 'string' }, record: { type: 'string' } }, allowPositionals: true });
const [name] = positionals;
if (name === undefined) {
  console.error(USAGE);
  process.exit(2);
}
if (flags.record !== undefined && !/^[a-z0-9-]+$/.test(flags.record)) throw new UsageError('--record takes a name of lowercase letters, digits and -');

const root = join(import.meta.dirname, '..');
const json = (text: string | undefined): Record<string, unknown> => (text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>));
const added = (path: string): Record<string, unknown> => {
  if (flags.registry === undefined) return {};
  try {
    return json(readFileSync(join(flags.registry, path.slice('registry/'.length)), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
};
const merged = (own: Record<string, unknown>, path: string): string => {
  const more = added(path);
  const twin = Object.keys(more).find((key) => key in own);
  if (twin !== undefined) throw new Error(`${flags.registry}: ${twin} is in the repository's ${path} too`);
  return JSON.stringify({ ...own, ...more });
};
const registry = registryFromTexts(
  merged(json(readFileSync(join(root, REGISTRY_PATH), 'utf8')), REGISTRY_PATH),
  merged(json(marketsText(root)), MARKETS_PATH),
  merged(json(attributesText(root)), ATTRIBUTES_PATH),
);

const endpoints = mainnetEndpoints(process.env);
const recording = recordingTransport(httpsTransport(), endpoints);
const unread: string[] = [];
const reader = createReader(endpoints, recording.transport, { note: (read) => void unread.push(read) });
const block = await reader.block('latest');
if (block.kind === 'unverifiable') throw new Error(block.reason);

const proof = await proveInstance(reader, registry, name, block.value);
if (proof.kind === 'unasked') {
  console.log(`REFUSED ${name} at block ${block.value.number}: ${proof.why}`);
  process.exit(1);
}
const lines = [`contract   ${name} ${checksumAddress(proof.entry.address)}`, `factory    ${proof.factory.name} ${checksumAddress(proof.factory.address)}`, `block      ${block.value.number} ${block.value.hash}`];
for (const answer of proof.answers) {
  const asker = answer.asker === undefined ? '' : `${answer.asker.name} `;
  lines.push(answer.kind === 'vouched' ? `answered   ${asker}${answer.asked} = ${answer.answered} (${answer.providers.join(', ')})` : `REFUSED    ${answer.why}`);
}
console.log(lines.join('\n'));
if (!admitted(proof)) process.exit(1);

if (flags.record !== undefined) {
  const refusal = unreadRefusal(unread);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exit(1);
  }
  const dir = join(root, 'testdata', 'instance');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${flags.record}.json`);
  writeFileSync(path, recordingText({ entry: name, block: { number: `${block.value.number}`, hash: block.value.hash }, exchanges: recording.exchanges().map(trimBlockAnswers) }, 2));
  console.log(`recorded ${path}`);
}
