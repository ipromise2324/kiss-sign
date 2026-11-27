import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Read, Reader } from '../src/chain/reader.ts';
import type { Receipt } from '../src/chain/types.ts';
import type { AbiEntry } from '../src/contracts/prove.ts';
import { NO_PROOF_OF_ABSENCE, markedSignature, readEvents, renderEvents, shapeOfAbi, shapeOfSignature } from '../src/research/events.ts';
import type { EventShape, EventsQuery } from '../src/research/events.ts';
import { eventArgTopic } from '../src/research/sources.ts';
import type { Ask, SourceRequest } from '../src/research/sources.ts';
import type { Address, Hex } from '../src/safe/types.ts';

const PROXY = `0x${'52'.repeat(20)}` as Address;
const IMPL = [`0x${'a1'.repeat(20)}`, `0x${'b2'.repeat(20)}`, `0x${'c3'.repeat(20)}`] as const;
const word = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');
const txOf = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const blockHash = (block: bigint) => `0x${block.toString(16).padStart(64, 'b')}` as Hex;

const shape = shapeOfSignature('LogSetImplementation(address indexed implementation, bytes4[] sigs)');
const sigsData = (sigs: readonly string[]) => `0x${word('20')}${word(sigs.length.toString(16))}${sigs.map((s) => s.slice(2).padEnd(64, '0')).join('')}` as Hex;

type Fake = { readonly address: Address; readonly topics: readonly Hex[]; readonly data: Hex; readonly block: bigint; readonly hash: Hex; readonly logIndex: number };
const logs: Fake[] = IMPL.map((impl, i) => ({ address: PROXY, topics: [shape.topic, `0x${word(impl)}` as Hex], data: sigsData(i === 2 ? ['0xad967e15', '0xdacb5419'] : ['0x3ff8b31d']), block: 100n + BigInt(i), hash: txOf(i + 1), logIndex: 0 }));

/** Etherscan's logs over `listed`: those in the asked blocks, ascending, a page of 1000 at a time, then an empty page. */
function etherscan(listed: readonly Fake[], asked: SourceRequest[] = []): Ask {
  return async (request) => {
    asked.push(request);
    if (request.source !== 'etherscan') throw new Error('etherscan only');
    const { fromBlock, toBlock, page } = request.query as Record<string, string>;
    const inRange = listed.filter((l) => l.block >= BigInt(fromBlock as string) && l.block <= BigInt(toBlock as string)).toSorted((a, b) => Number(a.block - b.block) || a.logIndex - b.logIndex);
    const result = inRange.slice((Number(page) - 1) * 1000, Number(page) * 1000);
    if (inRange.length === 0) return { status: '0', message: 'No records found', result: [] };
    return {
      status: '1',
      message: 'OK',
      result: result.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: `0x${l.block.toString(16)}`, blockHash: blockHash(l.block), logIndex: l.logIndex === 0 ? '0x' : `0x${l.logIndex.toString(16)}`, transactionHash: l.hash })),
    };
  };
}

/** A reader whose agreed receipts hold `held`'s logs, by transaction, in `held`'s blocks. */
function receipts(held: readonly Fake[], change: (receipt: Receipt) => Receipt = (r) => r): Reader {
  const getTransactionReceipt = async (hash: Hex): Promise<Read<Receipt | null>> => {
    const mine = held.filter((l) => l.hash === hash);
    const first = mine[0];
    if (first === undefined) return { kind: 'agreed', providers: ['alchemy', 'drpc'], value: null };
    const receipt = { transactionHash: hash, blockHash: blockHash(first.block), blockNumber: first.block, logs: mine.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: BigInt(l.logIndex) })) } as unknown as Receipt;
    return { kind: 'agreed', providers: ['alchemy', 'drpc'], value: change(receipt) };
  };
  return { getTransactionReceipt } as unknown as Reader;
}

const names = (address: Address) => (address === PROXY ? 'fluid-liquidity' : undefined);
const query: EventsQuery = { address: PROXY, shape, topics: [], range: { fromBlock: 0n, toBlock: 200n }, maxPages: 20, maxLogs: 50 };

test('events prints each log with the block of the receipt that confirms it, its transaction and decoded arguments, oldest first, and the footer', async () => {
  const text = renderEvents(await readEvents(query, { ask: etherscan(logs), reader: receipts(logs) }), names, false);
  assert.match(text, new RegExp(`^LogSetImplementation\\(address indexed,bytes4\\[\\]\\) logged by ${PROXY} \\(registry: fluid-liquidity\\)\\nevent shape: the signature as given\\n`));
  assert.match(text, /searched Etherscan's logs from block 0 to 200: 3 logs in 2 pages\n/);
  assert.match(text, new RegExp(`\\nblock 100  tx ${txOf(1)}\\n  implementation: 0x(a1){20}\\n  sigs: 1 items\\n    \\[0\\]: 0x3ff8b31d\\nblock 101 `));
  assert.match(text, new RegExp(`\\nblock 102  tx ${txOf(3)}\\n  implementation: 0x(c3){20}\\n  sigs: 2 items\\n    \\[0\\]: 0xad967e15\\n    \\[1\\]: 0xdacb5419\\n${NO_PROOF_OF_ABSENCE.replace(/[.()]/g, '\\$&')}\\n$`));
  assert.doesNotMatch(text, /NOT CONFIRMED|older not shown|STOPPED/);
});

test('events shows the newest --max-logs, keeps the whole oldest block, and names the --to-block that shows the older ones', async () => {
  const twoIn101 = [...logs, { ...(logs[1] as Fake), hash: txOf(9), logIndex: 4 }];
  const text = renderEvents(await readEvents({ ...query, maxLogs: 2 }, { ask: etherscan(twoIn101), reader: receipts(twoIn101) }), names, false);
  assert.match(text, /\nshowing the newest 3, oldest first, whole blocks; 1 older not shown: raise --max-logs, or pass --to-block 100\nblock 101 /);
  assert.equal(text.match(/\nblock 101 /g)?.length, 2);
  assert.doesNotMatch(text, /\nblock 100 /);
});

test('events marks NOT CONFIRMED a log the agreed receipt holds at another index, in another block, or not at all', async () => {
  const only = [logs[0] as Fake];
  const moved = renderEvents(await readEvents(query, { ask: etherscan(only), reader: receipts([{ ...(logs[0] as Fake), logIndex: 1 }]) }), names, false);
  assert.match(moved, new RegExp(`\\nblock 100 \\(as Etherscan lists it\\)  tx ${txOf(1)}  NOT CONFIRMED: the agreed receipt holds no such log at index 0\\n`));
  const reorged = renderEvents(await readEvents(query, { ask: etherscan(only), reader: receipts(only, (r) => ({ ...r, blockHash: `0x${'ee'.repeat(32)}` as Hex })) }), names, false);
  assert.match(reorged, /NOT CONFIRMED: the agreed receipt's block hash is 0x(ee){32}\n/);
  const none = renderEvents(await readEvents(query, { ask: etherscan(only), reader: receipts([]) }), names, false);
  assert.match(none, /NOT CONFIRMED: the providers know no such transaction\n/);
});

test('events leaves out a listed log of another contract or event, and says when a log does not decode as the event as written', async () => {
  const stray = { ...(logs[1] as Fake), address: `0x${'99'.repeat(20)}` as Address };
  const extra = { ...(logs[0] as Fake), topics: [shape.topic, `0x${word(IMPL[0])}`, `0x${word('1')}`] as Hex[] };
  const text = renderEvents(await readEvents(query, { ask: etherscan([extra, stray]), reader: receipts([extra]) }), names, false);
  assert.match(text, /\n1 logs Etherscan listed are not of this contract, range, event or filter; left out\n/);
  assert.match(text, /\n {2}does not decode: 2 topics after the event's, for 1 indexed arguments; mark each indexed argument in --event\n {2}topics: /);
  assert.doesNotMatch(text, /block 101/);
});

test('events asks a range Etherscan cannot list whole again as two, newer first, and stops at the page cap saying which blocks it read', async () => {
  const busy: Fake[] = Array.from({ length: 12_000 }, (_, i) => ({ ...(logs[0] as Fake), block: 1000n + BigInt(Math.floor(i / 10)), hash: txOf(i + 10), logIndex: i % 10 }));
  const asked: SourceRequest[] = [];
  const run = await readEvents({ ...query, range: { fromBlock: 1000n, toBlock: 2199n }, maxPages: 40, maxLogs: 5 }, { ask: etherscan(busy, asked), reader: receipts(busy) });
  const text = renderEvents(run, names, false);
  assert.match(text, /from block 1000 to 2199: 12000 logs in \d+ pages\n/);
  assert.doesNotMatch(text, /STOPPED/);
  assert.match(text, new RegExp(`\\nblock 2199  tx ${txOf(11_999 + 10)}\\n`));
  const capped = renderEvents(await readEvents({ ...query, range: { fromBlock: 1000n, toBlock: 2199n }, maxPages: 17, maxLogs: 5 }, { ask: etherscan(busy), reader: receipts(busy) }), names, false);
  assert.match(capped, /\nSTOPPED at the cap of 17 pages: only blocks 1700 to 2199 were read; narrow it with --from-block and --to-block\n/);
  const oneBlock = busy.map((l) => ({ ...l, block: 1000n }));
  const full = renderEvents(await readEvents({ ...query, range: { fromBlock: 1000n, toBlock: 1000n } }, { ask: etherscan(oneBlock), reader: receipts(oneBlock) }), names, false);
  assert.match(full, /\nSTOPPED at block 1000, which holds more logs than Etherscan lists for one range \(10 pages of 1000\): no block was read whole;/);
});

test("events takes parameter names and indexed arguments from the proven ABI's event, filters by an indexed argument, and refuses an anonymous event", async () => {
  const abi: AbiEntry[] = [
    { type: 'function', name: 'f', inputs: [] },
    { type: 'event', name: 'LogSetImplementation', anonymous: false, inputs: [{ name: 'implementation_', type: 'address', indexed: true }, { name: 'sigs_', type: 'bytes4[]', indexed: false }] },
    { type: 'event', name: 'Hidden', anonymous: true, inputs: [{ name: 'who', type: 'address', indexed: true }] },
  ];
  const proven = shapeOfAbi(abi, 'LogSetImplementation(address,bytes4[])', 'the proven ABI, test') as EventShape;
  assert.equal(markedSignature(proven), 'LogSetImplementation(address indexed,bytes4[])');
  assert.equal(shapeOfAbi(abi, 'LogRemoveImplementation(address)', 'test'), undefined);
  assert.throws(() => shapeOfAbi(abi, 'Hidden(address)', 'test'), /Hidden\(address\) is anonymous in the proven ABI: its logs carry no signature topic/);
  const topic = eventArgTopic(markedSignature(proven), { position: 1, address: IMPL[2] });
  const asked: SourceRequest[] = [];
  const text = renderEvents(await readEvents({ ...query, shape: proven, topics: [topic] }, { ask: etherscan(logs, asked), reader: receipts(logs) }), names, false);
  assert.equal(asked[0]?.source === 'etherscan' ? asked[0].query.topic1 : undefined, `0x${word(IMPL[2])}`);
  assert.match(text, /\nevent shape: the proven ABI, test\nonly logs whose topic 1 is 0x0{24}(c3){20}\n/);
  assert.match(text, /\n2 logs Etherscan listed are not of this contract, range, event or filter; left out\n/);
  assert.match(text, /\n {2}implementation_: 0x(c3){20}\n {2}sigs_: 2 items\n/);
  await assert.rejects(readEvents({ ...query, shape: proven, topics: [topic, topic] }, { ask: etherscan(logs), reader: receipts(logs) }), /two filters on one indexed argument/);
});

test('events prints an indexed value that does not decode as its type, and an indexed string as the hash it logs', async () => {
  const strings = shapeOfSignature('Named(string indexed name, address indexed who)');
  const log = { ...(logs[0] as Fake), topics: [strings.topic, `0x${'12'.repeat(32)}`, `0x${'ff'.repeat(32)}`] as Hex[], data: '0x' as Hex };
  const text = renderEvents(await readEvents({ ...query, shape: strings }, { ask: etherscan([log]), reader: receipts([log]) }), names, false);
  assert.match(text, /\n {2}name: 0x(12){32} \(an indexed string logs only the keccak256 of its value\)\n {2}who: 0x(ff){32}, which does not decode as address\n/);
});
