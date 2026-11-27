import { join } from 'node:path';
import { kissSignHome } from '../src/keys.ts';
import { commandLanguage } from '../src/language.ts';
import { loadRegistry } from '../src/registry.ts';
import { buildProgress, ProgressError, renderProgress } from '../src/research/build-progress.ts';
import { parseFlags } from '../src/cli/flags.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';

const USAGE = 'usage: pnpm progress <protocol>/<operation> [--instance <registry name>]';
const HELP = `${USAGE}

Prints how far building a template and its report has come, so the AI can tell the signer in one
line which step of how many is done, what is next and how long that step usually takes. The steps
are those of the kiss-sign skill's Build a template, in its order; each is decided only from files
in this checkout and its git state:
   1 State the intent           templates/<protocol>/<operation>/ exists
   2 Research the addresses     every registry entry the template names, or notes.json's entries
                                name, has a source and a code pin; done with nothing to research
                                when template.json parses and names no registry entry
   3 Establish the ABI          testdata/abi/ holds an ABI case of each entry whose ABI is used
                                (written by step 7's pnpm report --record)
   4 Draft the template         template.json parses
   5 Study past transactions    a past-txs summary of the operation (anchored on the instance)
                                in testdata/research/
   6 Check the protocol's health  notes.json's protocols name each protocol the protocol facts cover,
                                each with audits and incidents, and notes.json holds a judgment
                                when a call reaches a contract, not a token, DefiLlama does not
                                list; done with nothing to write when every call reaches a token
   7 Generate the report        docs.json, the recording in testdata/report/, report.generated.md
   8 Write the notes and reviews  notes.json, and the report page in the signer's language,
                                rendered after the last change to notes.json
   9 Add the tests              a test/*.test.ts names the operation, and the instance for an
                                instance's report; when the report's folder is new since HEAD left
                                origin/main, one such file is new or changed since then
  10 Check and commit           steps 1-9 done and git shows none of the operation's files changed
  11 Push and tell the signer   the last commit of the template's, recording's and summaries' files
                                is on a remote-tracking branch (read locally, nothing fetched)
Each step is done, partly done with what is missing, or not started. A later step may be done
before an earlier one, such as docs.json written while a past-txs search still runs; Next is the
first step not done. The usual minutes of the next step come from src/research/build-progress-times.json, which says which runs they were measured on.
pnpm notes-needed lists exactly what notes.json lacks; this command does not run it.

Options:
  --instance <registry name>  the instance of a template reported per instance

Writes: nothing. Network: none. Keys: none. The language is the language field of
$KISS_SIGN_HOME/config.json, else English; nothing else of it is read.
Rules: docs/design/flow.md, "First time an operation is done: build its template".`;

exitOnHelp(HELP);
refuseReadableErrors();

const { values: flags, positionals } = parseFlags({ options: { instance: { type: 'string' } }, allowPositionals: true });
const [template] = positionals;
if (template === undefined || positionals.length > 1 || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(template)) {
  console.error(USAGE);
  process.exit(2);
}

const root = join(import.meta.dirname, '..');
const language = commandLanguage([], kissSignHome(process.env));
const target = { template, instance: flags.instance };
try {
  process.stdout.write(renderProgress(buildProgress(root, loadRegistry(root), target, language), target, language));
} catch (error) {
  if (!(error instanceof ProgressError)) throw error;
  console.error(`REFUSED  ${error.message}`);
  process.exit(2);
}
