import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_LIST, coreListText, coreOnDisk } from '../src/verdict-core.ts';
import { exitOnHelp } from '../src/script-help.ts';

const HELP = `usage: pnpm verdict-core

Writes docs/verdict-core.txt, the verdict core: every file bin/kiss-sign can run, walked through
every import that is not type-only and every script or JSON file a core file names by a relative
path, with package.json, pnpm-lock.yaml and pnpm-workspace.yaml once a core file imports a
package. It prints the number of files. pnpm test fails when the list is out of date or differs
from the files Node loads to run bin/kiss-sign.

Writes: docs/verdict-core.txt.
Keys: none.
Rules: docs/design/program-ownership.md, "The verdict core".`;

exitOnHelp(HELP);

const root = join(import.meta.dirname, '..');
const core = coreOnDisk(root);
writeFileSync(join(root, CORE_LIST), coreListText(core));
console.log(`${CORE_LIST}: ${core.length} files`);
