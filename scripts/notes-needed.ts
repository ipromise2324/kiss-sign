import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadStoredConfig } from '../src/config.ts';
import { cachedCompilers } from '../src/contracts/solc.ts';
import { kissSignHome } from '../src/keys.ts';
import { LANGUAGES } from '../src/language.ts';
import { loadRegistry } from '../src/registry.ts';
import { NotesError } from '../src/research/notes.ts';
import { notesNeeded } from '../src/research/notes-needed.ts';
import { loadPublicSuffixList } from '../src/research/public-suffix.ts';
import { ReportError, replayInputs } from '../src/research/report.ts';
import { UsageError } from '../src/research/usage.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { ensureVendored } from '../src/vendor.ts';

const USAGE = 'usage: pnpm notes-needed <protocol>/<operation> [--instance-of <instance>]';
const HELP = `${USAGE}

Prints as JSON, offline and from the recordings pnpm report --record wrote, every text notes.json
must hold before pnpm report --render accepts it, so all are written in one pass:
  languages  each notes file and the languages its texts hold (the signer's, with no text yet)
  skeleton   per file, the keys it lacks or holds empty, nested as the file nests them; an empty
             object in a list stands for an item already written
  about      what asks for each missing key, and how many characters it may hold
  toReview   every result under To review, reviewed or not, in the program's current words
  remove     keys a file holds that --render refuses, since the report has nothing by that name
With flow lines in notes.json the results cover them; with none, every money call in the traces is
listed. Adding a flow line can change them, so write the lines, then run this again. The limits
and shapes are the program's; --render still checks everything. A text listed here is the
program's, never text of a page or a token.

Writes: nothing; downloads into vendor/ any pinned solc or Public Suffix List that is missing.
Keys: none. The signer's language is read from $KISS_SIGN_HOME/config.json.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 6,
Written by the AI, as data).`;

exitOnHelp(HELP);

const { values: flags, positionals } = parseArgs({ options: { 'instance-of': { type: 'string' } }, allowPositionals: true });
const [template] = positionals;
if (template === undefined || positionals.length > 1) {
  console.error(USAGE);
  process.exit(2);
}

const root = join(import.meta.dirname, '..');
if (!(await ensureVendored(['solc', 'psl']))) process.exit(1);
const language = loadStoredConfig(kissSignHome(process.env))?.language;
try {
  const { inputs } = await replayInputs(root, loadRegistry(root), { template, instance: flags['instance-of'] }, cachedCompilers(), loadPublicSuffixList());
  console.log(JSON.stringify(notesNeeded(root, inputs, language === undefined ? LANGUAGES : [language]), null, 1));
} catch (error) {
  if (!(error instanceof ReportError || error instanceof NotesError || error instanceof UsageError)) throw error;
  console.error(`REFUSED  ${error.message}`);
  process.exit(2);
}
