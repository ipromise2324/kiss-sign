import { readFileSync } from 'node:fs';
import { ResearchAnswerError, parseResearchAnswer } from '../src/research/answer.ts';

const USAGE = `usage: node scripts/research-parse.ts <answer.json>

Parses the researcher subagent's answer against src/research/answer.schema.json and prints it back with addresses
lowercased. Any value the schema does not admit, an unknown key, or text that is not JSON stops with exit code 2 and
names only where the answer broke the schema, never what it said.`;

const [file, ...rest] = process.argv.slice(2);
if (file === undefined || rest.length > 0) {
  console.error(USAGE);
  process.exit(64);
}
try {
  console.log(JSON.stringify(parseResearchAnswer(readFileSync(file, 'utf8')), null, 2));
} catch (error) {
  if (!(error instanceof ResearchAnswerError)) throw error;
  console.error(`research answer refused: ${error.message}`);
  process.exit(2);
}
