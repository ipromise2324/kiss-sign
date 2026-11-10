import { nodeIo } from '../src/cli/main.ts';
import { UsageError } from '../src/cli/io.ts';
import { history } from '../src/history/history.ts';

try {
  process.exitCode = await history(process.argv.slice(2), nodeIo());
} catch (error) {
  if (!(error instanceof Error) || (error.name === 'Error' && !(error instanceof UsageError))) throw error;
  process.stderr.write(`history: ${error.message}\n`);
  process.exitCode = 1;
}
