import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openMainnetReader } from '../src/chain/reader.ts';
import { pinOf, readCodeHistory, readRunningCode, samePin } from '../src/contracts/code.ts';
import { describeRefusal } from '../src/contracts/prove.ts';
import { mergeRegistry } from '../src/history/load.ts';
import { kissSignHome } from '../src/keys.ts';
import { REGISTRY_PATH, attributesText, registryFromTexts, unreachedSeeds } from '../src/registry.ts';
import type { CodePin, CodePins, CodeSpan, PinnedCode, ProxyDeclaration, Route } from '../src/registry.ts';
import { checksumAddress, parseAddress } from '../src/safe/types.ts';
import { exitOnHelp } from '../src/script-help.ts';

const USAGE = 'usage: pnpm pin-code [<registry name>...] [--history]';
const HELP = `${USAGE}

Reads, through both providers at one agreed block, each entry's code and, behind a proxy, its
implementation and that code, with the extension the implementation hands a call it has no
function for to, if any, and that code, and for an entry with routes each implementation its
seeds reach, with that code and the selectors it serves. It writes their keccak256 into the entry's code and
prints each pin as new, unchanged, or CHANGED with the old pin. It refuses an entry one of whose
seeds routes nowhere. For an entry with no pin, a pin with no from, or a changed pin, it then
searches the blocks back to the deployment for each change of that code, writes the first block of
today's code as from and each older pin with its from under earlier, prints each span, and prints
FINDING for a recorded pin it did not find again. With no names it pins every entry. Any REFUSED
entry makes it exit 1 after it writes the rest. verify requires every registry contract a
transaction touches, and each entry it names in dependsOn, to run its current pin, and an executed
transaction the pin whose span holds its block.

Options:
  --history   Pin the local entries of $KISS_SIGN_HOME/history/registry.json instead.

Writes: registry/contracts.json, or $KISS_SIGN_HOME/history/registry.json with --history.
Keys: ALCHEMY_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 2, Pin
the code and Pin the routes); docs/design/engine-and-chain.md, "Engine checks that every template
gets".`;

exitOnHelp(HELP);

const { values: flags, positionals: names } = parseArgs({ options: { history: { type: 'boolean', default: false } }, allowPositionals: true });
const root = join(import.meta.dirname, '..');
const repoPath = join(root, REGISTRY_PATH);
const path = flags.history ? join(kissSignHome(process.env), 'history', 'registry.json') : repoPath;
const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
const unknown = names.filter((name) => !Object.hasOwn(file, name));
if (unknown.length > 0) {
  console.error(`not in ${path}: ${unknown.join(', ')}\n\n${USAGE}`);
  process.exit(1);
}
const attributes = attributesText(root);
const parse = () => registryFromTexts(flags.history ? mergeRegistry(readFileSync(repoPath, 'utf8'), file, attributes) : JSON.stringify(file), undefined, attributes);
const recorded = parse();

const routeJson = ({ address, hash, selectors }: Route) => ({ address: checksumAddress(address), hash, selectors });
const pinnedJson = ({ address, hash }: PinnedCode) => ({ address: checksumAddress(address), hash });
const pinJson = (pin: CodePin) => ({
  hash: pin.hash,
  ...(pin.implementation === undefined
    ? {}
    : { implementation: { ...pinnedJson(pin.implementation), ...(pin.implementation.extension === undefined ? {} : { extension: pinnedJson(pin.implementation.extension) }) } }),
  ...(pin.routes === undefined ? {} : { routes: pin.routes.map(routeJson) }),
});
const codeJson = ({ earlier, current }: CodePins) => ({
  ...pinJson(current.pin),
  from: Number(current.from),
  ...(earlier.length === 0 ? {} : { earlier: earlier.map((span) => ({ from: Number(span.from), ...pinJson(span.pin) })) }),
});
const pinText = (pin: CodePin) =>
  [
    pin.hash,
    ...(pin.implementation === undefined ? [] : [`implementation ${checksumAddress(pin.implementation.address)} ${pin.implementation.hash}`]),
    ...(pin.implementation?.extension === undefined ? [] : [`extension ${checksumAddress(pin.implementation.extension.address)} ${pin.implementation.extension.hash}`]),
    ...(pin.routes === undefined ? [] : [`routes ${pin.routes.length === 0 ? 'none' : pin.routes.map((r) => `${checksumAddress(r.address)} ${r.hash} (${r.selectors.length} selectors)`).join(', ')}`]),
  ].join(', ');

const reader = openMainnetReader(process.env);
const block = await reader.block('latest');
if (block.kind === 'unverifiable') throw new Error(block.reason);
console.log(`block ${block.value.number} ${block.value.hash}, providers ${reader.providers.join(', ')}\n`);

let refused = false;
for (const name of names.length > 0 ? names : Object.keys(file)) {
  const entry = file[name] as Record<string, unknown>;
  const address = parseAddress(`${name}.address`, entry.address);
  const where = `${name} ${checksumAddress(address)}`;
  const was = recorded.entries.get(name)?.code;
  const declared: ProxyDeclaration = recorded.entries.get(name) ?? {};
  const routing = declared.routes;
  const ranged = typeof entry.code === 'object' && entry.code !== null && 'from' in entry.code;
  const head = await readRunningCode(reader, address, block.value, declared);
  if (head.kind === 'refused') {
    console.log(`REFUSED ${where}: ${describeRefusal(head.refusal)}`);
    refused = true;
    continue;
  }
  const headPin = pinOf(head.code);
  const unreached = routing === undefined ? [] : unreachedSeeds(routing, headPin.routes ?? []);
  if (unreached.length > 0) {
    console.log(`REFUSED ${where}: the seed ${unreached.join(', ')} routes nowhere at block ${block.value.number}; choose seeds that reach every implementation`);
    refused = true;
    continue;
  }
  if (was !== undefined && ranged && samePin(was.current.pin, headPin)) {
    console.log(`${where} ${pinText(was.current.pin)} from block ${was.current.from} (unchanged)`);
    continue;
  }
  const history = await readCodeHistory(reader, address, block.value.number, headPin, declared);
  if (history.kind === 'refused') {
    console.log(`REFUSED ${where}: ${describeRefusal(history.refusal)}`);
    refused = true;
    continue;
  }
  const { pins } = history;
  const spans: CodeSpan[] = [...pins.earlier, pins.current];
  const status = was === undefined ? 'new' : samePin(was.current.pin, pins.current.pin) ? 'unchanged, ranges read' : `CHANGED, was ${pinText(was.current.pin)}`;
  console.log(`${where} (${status})`);
  const first = spans[0] as CodeSpan;
  console.log(history.before === 'genesis' ? '  held since block 0' : `  before block ${first.from}: ${describeRefusal(history.before)}`);
  for (const span of spans) console.log(`  from block ${span.from}: ${pinText(span.pin)}`);
  for (const old of was === undefined ? [] : [...was.earlier, was.current]) {
    if (!spans.some((span) => samePin(span.pin, old.pin))) console.log(`  FINDING: the pin recorded from block ${old.from}, ${pinText(old.pin)}, is in no span read`);
  }
  entry.code = codeJson(pins);
}

parse();
writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`, { mode: flags.history ? 0o600 : 0o644 });
renameSync(`${path}.tmp`, path);
console.log(`\nWrote ${path}`);
if (refused) process.exit(1);
