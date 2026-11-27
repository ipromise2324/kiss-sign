import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCard } from '../src/card.ts';
import type { Card } from '../src/card.ts';
import { parseFlags } from '../src/cli/flags.ts';
import { UsageError } from '../src/cli/io.ts';
import { loadRegistry } from '../src/registry.ts';
import { impliedCard } from '../src/research/implied-card.ts';
import { leafValue, loosen } from '../src/research/study.ts';
import { eoaCannotTest, loadRecordedTx } from '../src/template/recorded-tx.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';
import { checkTemplateFields, inspectTemplateFields } from '../src/template/check.ts';
import type { FieldCheck } from '../src/template/check.ts';
import { TEMPLATES_DIR, TemplateError, loadTemplate, wordAddress } from '../src/template/template.ts';
import type { Template } from '../src/template/template.ts';

const USAGE = `usage: pnpm template check <protocol>/<operation>
       pnpm template implied-card <protocol>/<operation> <fixture name>...`;
const HELP = `${USAGE}

Offline checks of a draft template, reading only the checkout's files:
  check         parses templates/<protocol>/<operation>/template.json with the registry, with the
                parser and rules kiss-sign template approve, verify, card new and the tests use, and
                prints its card fields and calls, or REFUSED with the file, the path and the
                problem the parser names, exit 1.
  implied-card  prints the card each executed transaction in testdata/safe-tx/<name>.json was
                made for, as the test of the template requires MATCH with, then checks the
                transaction against it as verify's field check does and prints MATCH, MISMATCH
                with each finding, or UNVERIFIABLE with why. An EOA's transaction, recorded by
                pnpm record-eoa-tx, is checked as its one call with safe the EOA, and is refused
                for a template that binds the Safe's nonce.

The implied card takes each field from the value the transaction binds to it. An amount the
transaction bounds rather than states, such as a deposit's min-shares under a share price bound or
a swap's least amount out under atLeast, takes the boundary, every bound on it intersected: the
most the card may hold, else the least. Each boundary is checked: the card holding it gives MATCH,
and one step past it (one more than the most, one less than the least) does not, else NOT A
BOUNDARY. A contract field seen only through an attribute, such as vault.asset, takes the one
registry entry it may name with those attributes; a market, the one market of
registry/markets.json with the values shown. An address field takes safe for the Safe, else the
name of the registry entry at that address, else its field name; a recipient field safe or its
field name; an owner field its field name. A book line gives each field name's address, for --book
of pnpm simulate and for the test's address book. A field no value shows is listed as missing, and
nothing is checked. A signed message is read from testdata/messages/<name>.json when there is one;
the time of a withinSeconds rule is the fixture's block; an owner a rule reads from the Safe's
owners is not read, so such a check is UNVERIFIABLE. Exit 1 unless every transaction MATCHes.

Writes: nothing. Keys: none.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 7,
  pnpm template).`;

const args = process.argv.slice(2);
exitOnHelp(HELP, args[0] === 'check' || args[0] === 'implied-card' ? args.slice(1) : args);
refuseReadableErrors(64);

const ROOT = join(import.meta.dirname, '..');
const { positionals } = parseFlags({ allowPositionals: true, options: {} });
const [command, id, ...fixtures] = positionals;
if (id === undefined || (command === 'check' && fixtures.length > 0) || (command === 'implied-card' && fixtures.length === 0)) throw new UsageError(USAGE);
if (command !== 'check' && command !== 'implied-card') throw new UsageError(`name check or implied-card\n${USAGE}`);

const registry = loadRegistry(ROOT);
const file = join(TEMPLATES_DIR, id, 'template.json');
let template: Template;
try {
  template = loadTemplate(ROOT, id, registry);
} catch (error) {
  if (!(error instanceof TemplateError) && !(error instanceof SyntaxError)) throw error;
  console.error(`REFUSED  ${file}: ${error.message.replace(/\r?\n/g, '\\n')}`);
  process.exit(1);
}

if (command === 'check') {
  console.log(`OK  ${file} parses with the registry`);
  for (const [name, field] of template.card) console.log(`  card ${name}: ${field.kind}`);
  template.calls.forEach((call, i) => console.log(`  call ${i + 1}: ${call.data === 'empty' ? 'no data' : call.data.fn.signature}`));
  await new Promise((done) => process.stdout.write('', done));
  process.exit(0);
}

let failed = false;
const loosened = loosen(template);
const templates = new Map([[id, template]]);
for (const name of fixtures) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new UsageError(`${name}: a fixture name is lowercase letters, digits and hyphens`);
  const recorded = loadRecordedTx(ROOT, name);
  const { tx } = recorded;
  const messagePath = join(ROOT, 'testdata', 'messages', `${name}.json`);
  const messages = existsSync(messagePath) ? [readFileSync(messagePath, 'utf8')] : [];
  const blockTime = { kind: 'read', ...recorded.executed } as const;
  const shape = inspectTemplateFields(tx, { safe: tx.safe, operations: [{ template: id, values: new Map() }] }, new Map([[id, loosened.shape]]), registry, messages);
  console.log(`${name}:${recorded.sender === 'eoa' ? ` an EOA's transaction, its call checked with safe the EOA ${tx.safe}` : ''}`);
  const untestable = eoaCannotTest(recorded, template);
  if (untestable !== undefined) {
    console.log(`  REFUSED  ${untestable}`);
    failed = true;
    continue;
  }
  if (shape.check.kind !== 'match' || shape.leaves.length !== loosened.rules.length) {
    const why = shape.check.kind === 'mismatch' ? shape.check.findings.map((f) => `${f.callPath}.${f.arg} expected ${f.expected}, got ${f.actual}`) : shape.check.kind === 'unverifiable' ? shape.check.reasons : ['its leaves do not pair with the template'];
    console.log(`  NOT THE SHAPE  the transaction does not make ${id}'s calls: ${why.join('; ')}`);
    failed = true;
    continue;
  }
  const values = shape.leaves.map((leaf, i) => {
    const value = leafValue(leaf, tx);
    return loosened.rules[i]?.kind === 'address-word' ? (wordAddress(value) ?? value) : value;
  });
  const implied = impliedCard(template, loosened.rules, values, tx.safe, registry, tx.nonce);
  console.log(`  card ${JSON.stringify(implied.card)}`);
  if (implied.book.size > 0) console.log(`  book ${JSON.stringify(Object.fromEntries(implied.book))}`);
  if (implied.missing.length > 0) {
    for (const { field, why } of implied.missing) console.log(`  MISSING ${field}: ${why}`);
    failed = true;
    continue;
  }
  const judged = (card: Card): FieldCheck | { readonly kind: 'refused'; readonly why: string } => {
    const resolution = resolveCard(card, { templates, registry, addressBook: implied.book, safe: tx.safe });
    if (resolution.kind === 'refused') return { kind: 'refused', why: `${resolution.reason} at ${resolution.at}: ${resolution.detail}` };
    return checkTemplateFields(tx, resolution.card, templates, registry, messages, { blockTime });
  };
  const check = judged(implied.card);
  if (check.kind === 'match') console.log(`  MATCH  judged at block ${blockTime.number}, time ${blockTime.time}`);
  else {
    failed = true;
    if (check.kind === 'refused') console.log(`  REFUSED card: ${check.why}`);
    else if (check.kind === 'mismatch') for (const f of check.findings) console.log(`  MISMATCH ${f.callPath}.${f.arg}: expected ${f.expected}, got ${f.actual}`);
    else for (const reason of check.reasons) console.log(`  UNVERIFIABLE ${reason}`);
    continue;
  }
  for (const { field, side, value } of implied.boundaries) {
    const past = side === 'most' ? value + 1n : value - 1n;
    const operation = implied.card.operations[0] as Card['operations'][number];
    const at = (n: bigint): Card => ({ operations: [{ ...operation, values: { ...operation.values, [field]: String(n) } }] });
    const [inside, beyond] = [judged(at(value)), judged(at(past))];
    const word = side === 'most' ? 'at most' : 'at least';
    if (inside.kind === 'match' && beyond.kind !== 'match') console.log(`  boundary ${field} ${word} ${value}: ${past} gives ${beyond.kind.toUpperCase()}`);
    else {
      failed = true;
      console.log(`  NOT A BOUNDARY ${field} ${word} ${value}: ${value} gives ${inside.kind.toUpperCase()}, ${past} gives ${beyond.kind.toUpperCase()}`);
    }
  }
}
process.exitCode = failed ? 1 : 0;
