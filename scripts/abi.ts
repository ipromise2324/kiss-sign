import { join } from 'node:path';
import { parseFlags } from '../src/cli/flags.ts';
import { UsageError } from '../src/cli/io.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Registry } from '../src/registry.ts';
import { encodedHash, selectorLine, topicLine } from '../src/research/abi-hash.ts';
import type { Address } from '../src/safe/types.ts';
import { addressOfWord } from '../src/script-args.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';

const USAGE = `usage: pnpm abi selector '<function signature>'
       pnpm abi topic '<event signature>'
       pnpm abi hash '<types>' <value>...`;
const HELP = `${USAGE}

Computes, offline, the numbers a template or a registry entry names by hash, so no script of your
own computes them:
  selector  the 4-byte selector of a function, keccak256 of its canonical signature:
              pnpm abi selector 'approve(address spender, uint256 value)'
  topic     the topic 0 of an event's logs, keccak256 of its canonical signature:
              pnpm abi topic 'Transfer(address indexed from, address indexed to, uint256 value)'
  hash      abi.encode of the values as the types, and keccak256 of the encoding, such as an id a
            contract computes from a struct with no view that answers it: a Morpho Blue market id
            from its MarketParams, or a Uniswap v4 PoolId from its PoolKey (currency0, currency1,
            fee, tickSpacing, hooks):
              pnpm abi hash '(address,address,uint24,int24,address)' '["usdc","usdt","500","1","0x0000000000000000000000000000000000000000"]'

Each line prints the result, then the canonical form it hashed. Parameter names and indexed play
no part. For hash, <types> is a comma list, and each value is one word in the order of the types: a
decimal number, true or false, 0x and hex digits for bytes and bytesN, the text for a string, an
address or a registry name for an address, and a tuple or an array as one JSON array of such words.
hash prints the encoding too, so a value can be compared with what a call or a log holds. Give --
before the first value that starts with a dash, such as a negative number:
  pnpm abi hash 'int24' -- -60

Writes: nothing. Reads: registry/, only when an address is given by name. Keys: none.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 3,
  pnpm abi).`;

exitOnHelp(HELP);
refuseReadableErrors(64);

const { positionals } = parseFlags({ allowPositionals: true, options: {} });
const [kind, first, ...rest] = positionals;
if (first === undefined) throw new UsageError(USAGE);
if ((kind === 'selector' || kind === 'topic') && rest.length > 0) throw new UsageError(`${kind} takes one signature, quoted as one word\n${USAGE}`);
if (kind === 'selector') console.log(selectorLine(first));
else if (kind === 'topic') console.log(topicLine(first));
else if (kind === 'hash') {
  let registry: Registry | undefined;
  const addressOf = (word: string): Address | undefined => {
    if (/^0x[0-9a-fA-F]{40}$/.test(word)) return addressOfWord({ entries: new Map() }, word);
    registry ??= loadRegistry(join(import.meta.dirname, '..'));
    return addressOfWord(registry, word);
  };
  const { encoded, hash, types } = encodedHash(first, rest, addressOf);
  console.log(`keccak256 ${hash}  abi.encode${types}`);
  console.log(`encoded   ${encoded}`);
} else throw new UsageError(`name selector, topic or hash\n${USAGE}`);
