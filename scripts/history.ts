import { nodeIo } from '../src/cli/main.ts';
import { UsageError } from '../src/cli/io.ts';
import { history } from '../src/history/history.ts';
import { exitOnHelp } from '../src/script-help.ts';

const HELP = `usage: pnpm history [--out <file.md>] [--refresh]
usage: pnpm history fetch

pnpm history fetch downloads every multisig transaction of the configured Safe from the Safe
Transaction Service into $KISS_SIGN_HOME/history/txs.jsonl.

pnpm history runs each executed transaction in txs.jsonl through the checks verify runs, with the
card in history/cards/<nonce>.json and each template it names approved at its origin/main hash for
the run. It prints one row per nonce with its verdict and, for each that is not MATCH, its reason:
refused-by-design, no-card-yet, no-template with the template ids a card names that origin/main
does not hold, or the verdict's causes; then a summary. It writes its text in the config's
language. Chain answers are cached per nonce in history/cache/, so a rerun reads the chain only for a
nonce one of whose reads got no answer, which is not cached; it still fetches origin/main, and
uses the local origin/main when GitHub cannot be reached.

Optional files in $KISS_SIGN_HOME/history/:
  cards/<nonce>.json    { "operations": [...], "origin": "history", "marks": [{ "at":
                        "operations[0].values.<field>", "note": "..." }] }
  registry.json         Local registry entries, no name registry/contracts.json holds; pinned
                        with pnpm pin-code --history.
  address-book.json     { "<name>": { "address": "0x...", "mark": "<who confirmed it>" } }
  notes.json            A note per nonce: { "<nonce>": "<text>" }, or { "<nonce>": { "note":
                        "<text>", "spentBy": <nonce> } } for an approval a later nonce spends.
                        When the approval has no card, its row takes that nonce's reason. The
                        spending nonce must be an executed transaction in the history, and must
                        not itself be an approval spent by another nonce.

Options:
  --out <file.md>   Also write the report as Markdown, to a file outside the repository.
  --refresh         Read every chain answer again, ignoring history/cache/.

Writes: history/txs.jsonl (fetch); history/cache/<nonce>.json; <file.md> with --out.
Keys: ALCHEMY_API_KEY, from the environment or $KISS_SIGN_HOME/.env, for a nonce not cached; fetch
  needs none. It never reads GITHUB_TOKEN.
Rules: docs/design/known-limits.md, "Known limits".`;

const args = process.argv.slice(2);
exitOnHelp(HELP, args[0] === 'fetch' ? args.slice(1) : args);

try {
  process.exitCode = await history(args, nodeIo());
} catch (error) {
  if (!(error instanceof Error) || (error.name === 'Error' && !(error instanceof UsageError))) throw error;
  process.stderr.write(`history: ${error.message}\n`);
  process.exitCode = 1;
}
