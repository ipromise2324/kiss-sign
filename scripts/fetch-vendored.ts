import { parseArgs } from 'node:util';
import { ensureVendored, fetchVendored, isVendoredKind, VENDORED } from '../src/vendor.ts';

const USAGE = `usage: node scripts/fetch-vendored.ts [--missing] <${Object.keys(VENDORED).join('|')}>...

Downloads each pinned file into vendor/ and refuses one whose sha256 differs from its pin. With --missing it touches only
a kind whose files are missing or differ from their pins.`;

const { values, positionals } = parseArgs({ options: { missing: { type: 'boolean' } }, allowPositionals: true });
const kinds = positionals.filter(isVendoredKind);
if (positionals.length === 0 || kinds.length !== positionals.length) {
  console.error(USAGE);
  process.exit(2);
}
let ok = true;
if (values.missing) ok = await ensureVendored(kinds);
else for (const kind of kinds) ok = (await fetchVendored(kind)) && ok;
if (!ok) process.exit(1);
