import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainnetEndpoints } from '../src/chain/providers.ts';
import { headerHash } from '../src/chain/header-hash.ts';
import { createReader } from '../src/chain/reader.ts';
import type { Read } from '../src/chain/reader.ts';
import { httpsTransport } from '../src/chain/rpc.ts';
import type { Transport } from '../src/chain/rpc.ts';
import { parseFlags } from '../src/cli/flags.ts';
import { UsageError } from '../src/cli/io.ts';
import { loadStoredConfig } from '../src/config.ts';
import { safeProxyFactory } from '../src/contracts/proxy.ts';
import { kissSignHome } from '../src/keys.ts';
import { EXEC_TRANSACTION } from '../src/research/safe-nonce.ts';
import { parseHex } from '../src/safe/types.ts';
import { exitOnHelp } from '../src/script-help.ts';
import { refuseReadableErrors } from '../src/script-refusal.ts';
import { RECORDED_TX_DIR, parseRecordedTx } from '../src/template/recorded-tx.ts';

const USAGE = 'usage: pnpm record-eoa-tx <name> <transaction hash>';
const HELP = `${USAGE}

Records an EOA's executed transaction, one call it sent itself, into testdata/safe-tx/<name>.json
with "sender": "eoa", for an operation no other Safe's transaction fits: template implied-card,
simulate, perturb and the report read it as the EOA's call, with the EOA where the template puts
the Safe. It reads the transaction, its receipt and its block from Alchemy and drpc, which must
agree. It refuses a transaction that reverted or created a contract, a sender with code at the
parent block (only a plain EOA's call is simulated faithfully), an EIP-7702 transaction (type 4,
or any authorization list) or a type it does not know, a call to the sender itself, and a call to a
Safe proxy or of execTransaction, which pnpm record-safe-tx records. Both providers' transaction
and receipt must carry the requested hash and agree on its block, sender and target, and the block
header must hash to the receipt's block hash. It writes nothing when the recording or its name
mentions the Safe in $KISS_SIGN_HOME/config.json. Never record a transaction an owner of that Safe
sent. <name> is lowercase letters, digits and hyphens.

Writes: testdata/safe-tx/<name>.json.
Keys: ALCHEMY_API_KEY and DRPC_API_KEY, from the environment or $KISS_SIGN_HOME/.env.
Rules: docs/design/flow.md, "First time an operation is done: build its template" (step 7,
  Write the template).`;

exitOnHelp(HELP);
refuseReadableErrors();

const { positionals } = parseFlags({ allowPositionals: true, options: {} });
const [name, hashArg] = positionals;
if (positionals.length !== 2 || name === undefined || hashArg === undefined || !/^[a-z0-9-]+$/.test(name)) throw new UsageError(USAGE);
const hash = parseHex('transaction hash', hashArg);
if (hash.length !== 66) throw new UsageError(`${USAGE}\nthe transaction hash is 32 bytes`);
const configured = loadStoredConfig(kissSignHome(process.env))?.safe;
if (configured !== undefined && name.includes(configured.slice(2))) throw new Error('the name mentions the configured Safe; nothing written');

/**
 * Each provider's last raw answer to the two methods whose parsed form drops what this script checks: a transaction's
 * type and authorization list, and the header fields a block's hash is computed from.
 */
const RAW_METHODS = ['eth_getTransactionByHash', 'eth_getBlockByHash'] as const;
const raw = new Map<string, Map<string, Record<string, unknown>>>(RAW_METHODS.map((method) => [method, new Map()]));
const https = httpsTransport();
const transport: Transport = async (url, body, signal) => {
  const answer = await https(url, body, signal);
  const kept = raw.get(String((JSON.parse(body) as { method?: unknown }).method));
  if (kept !== undefined) {
    try {
      const result = (JSON.parse(answer.text) as { result?: unknown }).result;
      if (typeof result === 'object' && result !== null) kept.set(url, result as Record<string, unknown>);
    } catch {}
  }
  return answer;
};
const bothRaw = (method: (typeof RAW_METHODS)[number]): Record<string, unknown>[] => {
  const answers = [...(raw.get(method) as Map<string, Record<string, unknown>>).values()];
  if (answers.length !== 2) throw new Error(`${method} was not answered by both providers; nothing written`);
  return answers;
};
const reader = createReader(mainnetEndpoints(process.env), transport);
const agreed = <T>(read: Read<T>, what: string): T => {
  if (read.kind === 'unverifiable') throw new Error(`${what}: ${read.reason}`);
  return read.value;
};

const sent = agreed(await reader.getTransaction(hash), 'the transaction');
const receipt = agreed(await reader.getTransactionReceipt(hash), 'its receipt');
if (sent === null || receipt === null) throw new Error('both providers have no executed transaction with that hash');
if (sent.hash !== hash || receipt.transactionHash !== hash) throw new Error('a provider answered for another transaction; nothing written');
if (sent.blockHash !== receipt.blockHash || sent.blockNumber !== receipt.blockNumber || sent.from !== receipt.from || sent.to !== receipt.to) {
  throw new Error('the transaction and its receipt disagree on its block, sender or target; nothing written');
}
const KNOWN_TYPES = new Set(['0x0', '0x1', '0x2', '0x3']);
for (const { type, authorizationList } of bothRaw('eth_getTransactionByHash')) {
  if (type === '0x4' || (Array.isArray(authorizationList) && authorizationList.length > 0)) throw new Error('the transaction is an EIP-7702 one, which sets accounts\' code; nothing written');
  if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) throw new Error(`a provider gives the transaction type ${String(type)}, not legacy, EIP-2930, EIP-1559 or EIP-4844; nothing written`);
}
if (receipt.status !== 1) throw new Error('the transaction reverted; nothing written');
if (sent.to === null) throw new Error('the transaction created a contract; nothing written');
if (sent.to === sent.from) throw new Error('the transaction is a call of the sender to itself; nothing written');
const block = agreed(await reader.header(agreed(await reader.block(receipt.blockNumber), 'its block')), 'its block');
if (block.hash !== receipt.blockHash || bothRaw('eth_getBlockByHash').some((header) => headerHash(header) !== receipt.blockHash)) {
  throw new Error('the block header does not hash to the block hash its receipt names; nothing written');
}
const parent = agreed(await reader.block(receipt.blockNumber - 1n), 'the parent block');
if (agreed(await reader.getCode(sent.from, parent), "the sender's code").length > 2) throw new Error('the sender has code at the parent block, so it is not a plain EOA; nothing written');
if (safeProxyFactory(agreed(await reader.getCode(sent.to, parent), "the target's code")) !== undefined || sent.input.startsWith(EXEC_TRANSACTION.selector)) {
  throw new Error('the transaction calls a Safe; record it with pnpm record-safe-tx; nothing written');
}

const fixture = {
  sender: 'eoa',
  chainId: 1,
  providers: reader.providers,
  transaction: { hash: sent.hash, from: sent.from, to: sent.to, value: sent.value.toString(), input: sent.input },
  block: { number: block.number.toString(), hash: block.hash, time: block.time.toString() },
};
if (configured !== undefined && JSON.stringify(fixture).toLowerCase().includes(configured.slice(2))) throw new Error('the recording mentions the configured Safe; nothing written');
const file = join(RECORDED_TX_DIR, `${name}.json`);
parseRecordedTx(fixture, file);
const out = join(import.meta.dirname, '..', file);
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${out}: ${sent.from}'s call to ${sent.to} at block ${block.number}, agreed by ${reader.providers.join(' and ')}`);
