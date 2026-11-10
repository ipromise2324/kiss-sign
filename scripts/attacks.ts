import { attacks } from '../src/attacks/attacks.ts';
import { UsageError } from '../src/cli/io.ts';
import { nodeIo } from '../src/cli/main.ts';

try {
  process.exitCode = await attacks(process.argv.slice(2), nodeIo());
} catch (error) {
  if (!(error instanceof Error) || (error.name === 'Error' && !(error instanceof UsageError))) throw error;
  process.stderr.write(`attacks: ${error.message}\n`);
  process.exitCode = 1;
}
