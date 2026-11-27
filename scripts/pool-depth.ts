import { join } from 'node:path';
import { parseFlags } from '../src/cli/flags.ts';
import { UsageError } from '../src/cli/io.ts';
import { openMainnetReader } from '../src/chain/reader.ts';
import { loadRegistry } from '../src/registry.ts';
import { poolDepthText } from '../src/research/pool-depth.ts';
import type { Blocks, Window } from '../src/research/pool-depth.ts';
import { addressOfWord } from '../src/script-args.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';

const USAGE = 'usage: pnpm pool-depth <pool registry name | address> (--blocks <calm>,<stressed> | --auto) [--window 30|5] [--min <liquidity>]';
const HELP = `${USAGE}

Prints a Uniswap v3 pool's harmonic mean liquidity, the measure a pool's twap.minLiquidity is
compared with: observe([window, 0]) read and computed as card new reads it, the window times 2^128
over the change in secondsPerLiquidityCumulativeX128, for 30 minutes (a pair whose own feeds share a
peg and may be off by at most 50 bps together) and 5 (any other pair, such as a two-pool route
through this pool), through both providers at each block; a read they disagree on is UNVERIFIABLE.
Beside each it prints the mean price and, as orientation, how much of each token moves that price
100 ticks (about 1%) if the liquidity stayed at its mean across the band. Its tokens are the pool's
token0() and token1() at the latest settled block. It reads the pool whether or not it runs pinned
code, as research before the pool's entry and pin exist; card new reads only a pinned pool.

Options:
  --blocks <calm>,<stressed>  Read these two block numbers, such as a quiet day and the block of a
                              depeg found with the pool's Swap events. Exits 1 when either gives no
                              measure over any window.
  --auto                      Read one block every 7200 (about a day, not exactly) over the last
                              year and pick calm, the sample of median liquidity, and stressed, the
                              one whose mean price moved most from the readable sample before it
                              (unreadable samples are skipped, so a move can span several days);
                              it also prints the thinnest sample. A daily sample can land up to a
                              day after a short stress; read a known one with --blocks.
  --window 30|5               Read only that window; --auto ranks by it (by 30 when both are read).
  --min <liquidity>           Mark each measure under this minLiquidity and, with --auto, count the
                              samples under it per window; the registry's twap.minLiquidity when
                              the pool is a registry entry with one.

Set twap.minLiquidity at or just below the lowest of the calm and stressed measures over every
window a route reads the pool at (both, unless the pool serves one kind of pair only); on a block
the pool is thinner, card new holds its price in doubt and the signer types the minimum twice.
Write the command line, the calm, stressed and lowest values, the value chosen and why in
entries.<pool> of the template's notes.json.

Writes: nothing.
Keys: ALCHEMY_API_KEY and DRPC_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
Rules: docs/design/data-shapes.md, "Prices" (a pool's twap); "Intent card" (the floor's rule).`;

exitOnHelp(HELP);

refuseReadableErrors();

const { values: flags, positionals } = parseFlags({ options: { blocks: { type: 'string' }, auto: { type: 'boolean' }, window: { type: 'string' }, min: { type: 'string' } }, allowPositionals: true });
const [target] = positionals;
if (target === undefined || positionals.length > 1) throw new UsageError(`name one pool\n\n${USAGE}`);
if ((flags.blocks === undefined) === (flags.auto !== true)) throw new UsageError(`give either --blocks or --auto\n\n${USAGE}`);
const given = /^(\d+),(\d+)$/.exec(flags.blocks ?? '');
if (flags.blocks !== undefined && given === null) throw new UsageError('--blocks takes two block numbers, calm first: --blocks 23000000,23100000');
if (flags.window !== undefined && !['30', '5'].includes(flags.window)) throw new UsageError('--window takes 30 or 5');
if (flags.min !== undefined && !/^[1-9]\d*$/.test(flags.min)) throw new UsageError('--min takes a liquidity above 0, as a decimal integer');
const blocks: Blocks = given === null ? { kind: 'auto' } : { kind: 'given', calm: BigInt(given[1] as string), stressed: BigInt(given[2] as string) };
const windows: readonly Window[] = flags.window === undefined ? [1800n, 300n] : [flags.window === '5' ? 300n : 1800n];

const registry = loadRegistry(join(import.meta.dirname, '..'));
const address = addressOfWord(registry, target);
if (address === undefined) throw new UsageError(`${target} is neither a registry entry nor an address\n\n${USAGE}`);
const min = flags.min === undefined ? registry.byAddress.get(address)?.twap?.minLiquidity : BigInt(flags.min);

const { read, text } = await poolDepthText(openMainnetReader(process.env), registry, address, { blocks, windows, min });
console.log(text);
if (!read) process.exit(1);
