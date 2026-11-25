import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Reader } from '../chain/reader.ts';
import type { BlockHeader, BlockRef, StateOverride } from '../chain/types.ts';
import { SAFE_PROXY_CODE } from '../contracts/proxy.ts';
import type { Address, Hex } from '../safe/types.ts';
import { inPool } from './pool.ts';
import { officialSingleton, proveParty } from './study.ts';
import type { PartyProof } from './study.ts';

const BATCH_CODE_ADDRESS = '0x000000000000000000000000000000536166652d' as Address;

const ZERO = `0x${'00'.repeat(20)}` as Address;

/** Returns EXTCODEHASH of the address in each calldata word. */
const CODE_HASHES = '0x60005b8036111560155780353f81526020016002565b366000f3' as Hex;

/** STATICCALLs the address in each calldata word with no data and returns the first word each answers; reverts when one fails. */
const FIRST_WORDS = '0x60005b80361115601f576020816000600084355afa156024576020016002565b366000f35b60006000fd' as Hex;

const SLOT_0 = '0x60005460005260206000f3' as Hex;

/** The most addresses a batch asks about: at 2,600 gas a cold account and 2,100 a cold slot, well within `BATCH_GAS`. */
const BATCH_SIZE = 500;
const BATCH_GAS = 1n << 24n;
const MIN_BATCH_PARTIES = 4;
const BATCH_WIDTH = 4;
const SINGLE_WIDTH = 8;

const PROXY_HASHES: ReadonlySet<string> = new Set([...SAFE_PROXY_CODE.keys()].map((code) => bytesToHex(keccak_256(hexToBytes(code.slice(2))))));

async function agreedWords(reader: Reader, header: BlockHeader, code: Hex, overrides: Readonly<Record<Address, StateOverride>>, addresses: readonly Address[]): Promise<string[] | undefined> {
  const { number, time, gasLimit, mixHash } = header;
  const data = `0x${addresses.map((address) => address.slice(2).padStart(64, '0')).join('')}` as Hex;
  const run = await reader.simulateV1(
    {
      block: { number: number + 1n, time: time + 12n, gasLimit, prevRandao: mixHash },
      stateOverrides: { ...overrides, [BATCH_CODE_ADDRESS]: { code } },
      calls: [{ from: ZERO, to: BATCH_CODE_ADDRESS, data, gas: BATCH_GAS }],
    },
    header,
  );
  const call = run.kind === 'agreed' ? run.value[0] : undefined;
  if (call?.status !== 'success' || call.returnData.length !== data.length) return undefined;
  return addresses.map((_, i) => call.returnData.slice(2 + i * 64, 2 + (i + 1) * 64));
}

/** What `proveParty` proves of each address at `at`, read in batches, and alone where the providers give no agreed batch. */
export async function proveParties(reader: Reader, parties: readonly Address[], at: BlockRef): Promise<PartyProof[]> {
  const header = parties.length < MIN_BATCH_PARTIES ? undefined : await reader.header(at);
  if (header?.kind !== 'agreed') return inPool(parties, SINGLE_WIDTH, (party) => proveParty(reader, party, at));
  const chunks = Array.from({ length: Math.ceil(parties.length / BATCH_SIZE) }, (_, i) => parties.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE));
  return (await inPool(chunks, BATCH_WIDTH, (chunk) => proveBatch(reader, chunk, header.value, at))).flat();
}

async function proveBatch(reader: Reader, parties: readonly Address[], header: BlockHeader, at: BlockRef): Promise<PartyProof[]> {
  const singly = () => inPool(parties, SINGLE_WIDTH, (party) => proveParty(reader, party, at));
  const hashes = await agreedWords(reader, header, CODE_HASHES, {}, parties);
  if (hashes === undefined) return singly();
  const proxies = parties.filter((_, i) => PROXY_HASHES.has(hashes[i] as string));
  const slots = proxies.length === 0 ? [] : await agreedWords(reader, header, FIRST_WORDS, Object.fromEntries(proxies.map((proxy) => [proxy, { code: SLOT_0 }])), proxies);
  if (slots === undefined) return singly();
  const safes = new Set(proxies.filter((_, i) => officialSingleton(`0x${slots[i]}` as Hex)));
  return parties.map((party) => ({ kind: safes.has(party) ? 'safe' : 'not-safe' }));
}
