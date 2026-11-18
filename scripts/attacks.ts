import { attacks } from '../src/attacks/attacks.ts';
import { UsageError } from '../src/cli/io.ts';
import { nodeIo } from '../src/cli/main.ts';
import { exitOnHelp } from '../src/script-help.ts';

const HELP = `usage: pnpm attacks [--record <case>]

Replays real blind-signing attacks on Safes offline from testdata/attacks/<case>/ (case.json and
recording.json). For each case it prints what the signers believed, as a card with names and full
addresses, the transaction that ran, decoded, and each verdict with the checks that caught it. An
Ethereum case runs verify twice as of the block before execution: on the fields alone, simulated
as a pending transaction, and on the Transaction Service record, judged by its receipt. A case on
another chain runs only the checks that need no chain, and its simulation is UNVERIFIABLE.

Options:
  --record <case>   Read the case's transaction from the Safe Transaction Service and its chain
                    answers live into testdata/attacks/<case>/recording.json, then replay it.

Writes: testdata/attacks/<case>/recording.json with --record; otherwise nothing.
Keys: ALCHEMY_API_KEY with --record, from the environment or $KISS_SIGN_HOME/.env; none otherwise.
Rules: docs/design/program-ownership.md, "The program gate" (the canaries).`;

exitOnHelp(HELP);

try {
  process.exitCode = await attacks(process.argv.slice(2), nodeIo());
} catch (error) {
  if (!(error instanceof Error) || (error.name === 'Error' && !(error instanceof UsageError))) throw error;
  process.stderr.write(`attacks: ${error.message}\n`);
  process.exitCode = 1;
}
