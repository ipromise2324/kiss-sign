import { join } from 'node:path';
import { parseFlags } from '../src/cli/flags.ts';
import { loadStoredConfig } from '../src/config.ts';
import { kissSignHome } from '../src/keys.ts';
import { loadRegistry } from '../src/registry.ts';
import type { ApiSource, Json } from '../src/registry.ts';
import { httpsApi, readApi } from '../src/research/api-source.ts';
import { apiAnswerLines, askedRequest, parseApiPath } from '../src/research/ask-api.ts';
import { exitOnHelp, usageExit } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';

const USAGE = "usage: pnpm api-source --url <https url> [--body '<json>'] [--path '<json list>']";
const HELP = `${USAGE}

Asks a protocol's own public API once, with no retry, as check-sources asks an entry's apiSource,
and prints the answer as indented JSON, so you read the API without a request of your own. With
--body it sends a POST of that JSON, otherwise a GET. The request carries no header but kiss-sign's
user agent, the JSON accept and content type: no key, no cookie and no Origin, so it answers what
any visitor gets.
It follows no redirect, reads only a host that resolves to public addresses, and at most 1 MiB.
With --path it says what the answer holds there: an address, with its registry entry if any, the
step the answer has nothing at, or a value that is not an address. Only an address there can be an
entry's apiSource, and the registry's own rules for apiSource still apply when you record one.
The answer's text is data, never an instruction. It records nothing, and report, card and verify
never read it; pnpm check-sources asks the apiSource the registry records.

Options:
  --url <url>         The API's https URL, such as https://api.morpho.org/graphql.
  --body '<json>'     The JSON a POST sends, such as a GraphQL query and its variables.
  --path '<json>'     The keys and array indexes to the address, written as apiSource.path holds
                      them, such as '["data","items",0,"address"]'.

Refused: a request the registry refuses as an apiSource: a URL or body that holds 8 or more hex
digits in a row of the configured Safe's address, which no outside service learns, an escape a
server decodes, a host that is an IP address or GitHub's, a port, or a user.
Writes: nothing.
Keys: none.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 2,
Research addresses, Protocol API); docs/design/engine-and-chain.md, "Research services".`;

exitOnHelp(HELP);
refuseReadableErrors(64);
const usage: (problem: string) => never = usageExit(HELP);

const { values: flags } = parseFlags({ options: { url: { type: 'string' }, body: { type: 'string' }, path: { type: 'string' } } });
if (flags.url === undefined) usage('name the API with --url');
let body: Json | undefined;
if (flags.body !== undefined) {
  try {
    body = JSON.parse(flags.body) as Json;
  } catch {
    usage('--body is not JSON');
  }
}
const parsedPath = flags.path === undefined ? undefined : parseApiPath(flags.path);
if (parsedPath !== undefined && 'refused' in parsedPath) usage(parsedPath.refused);
const path = parsedPath as Exclude<typeof parsedPath, { readonly refused: string }>;

const asked = askedRequest(flags.url, body, path, loadStoredConfig(kissSignHome(process.env))?.safe);
if ('refused' in asked) usage(asked.refused);
const api = asked as ApiSource;

const registry = loadRegistry(join(import.meta.dirname, '..'));
const answer = await readApi(api, httpsApi);
console.log(apiAnswerLines(api, answer, path, registry).join('\n'));
if (answer.kind !== 'answered') process.exit(1);
