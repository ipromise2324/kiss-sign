import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_LIST, coreListText, coreOnDisk } from '../src/verdict-core.ts';

const root = join(import.meta.dirname, '..');
const core = coreOnDisk(root);
writeFileSync(join(root, CORE_LIST), coreListText(core));
console.log(`${CORE_LIST}: ${core.length} files`);
