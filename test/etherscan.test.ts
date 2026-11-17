import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecording } from '../src/chain/bytecode.ts';
import { abiCaseBlock, abiCaseEtherscan, abiCaseReader } from '../src/contracts/abi-case.ts';
import type { AbiCase } from '../src/contracts/abi-case.ts';
import { parseEtherscan, retryingEtherscan } from '../src/contracts/etherscan.ts';
import type { EtherscanAnswer } from '../src/contracts/etherscan.ts';
import { proveAbi } from '../src/contracts/prove.ts';
import type { AbiProof, AbiRefusal } from '../src/contracts/prove.ts';
import { warmCompilers } from './solc-pool.ts';

const usdt = readRecording(join(import.meta.dirname, '..', 'testdata', 'abi', 'usdt.json')) as AbiCase;
const compilers = await warmCompilers([usdt]);
const answer = usdt.etherscan[usdt.address] as EtherscanAnswer;
const result = (answer.body as { result: Record<string, string>[] }).result[0] as Record<string, string>;

const withResult = (change: Record<string, string>): EtherscanAnswer => ({ status: 200, body: { status: '1', message: 'OK', result: [{ ...result, ...change }] } });
const prove = (served: EtherscanAnswer): Promise<AbiProof | AbiRefusal> =>
  proveAbi(abiCaseReader(usdt), usdt.address, abiCaseBlock(usdt), { etherscan: abiCaseEtherscan({ [usdt.address]: served }), compilers });

test('a source Etherscan holds as a map of files is compiled with the settings its fields give', async () => {
  const proof = await prove(withResult({ SourceCode: JSON.stringify({ 'token/TetherToken.sol': { content: result.SourceCode } }) }));
  assert.equal(proof.kind, 'proven');
  assert.equal((proof as AbiProof).contractPath, 'token/TetherToken.sol');
});

test('a map of files with two that define the contract and no ContractFileName is refused, not guessed', async () => {
  const file = { content: result.SourceCode };
  const proof = await prove(withResult({ SourceCode: JSON.stringify({ 'a/TetherToken.sol': file, 'b/TetherToken.sol': file }) }));
  assert.deepEqual(proof.kind === 'refused' && proof.refusal, { why: 'etherscan-unreadable', at: usdt.address, detail: 'malformed answer: 2 files define TetherToken' });
});

test('a Vyper source is refused as a language the program does not compile', () => {
  assert.deepEqual(parseEtherscan(withResult({ CompilerType: 'vyper', CompilerVersion: 'vyper:0.3.10' })), { kind: 'unsupported-language', language: 'Vyper' });
});

test('a compiler version without its commit is refused', () => {
  assert.deepEqual(parseEtherscan(withResult({ CompilerVersion: 'v0.4.18' })), { kind: 'unreadable', why: 'malformed answer: CompilerVersion is not a full solc version' });
});

test('an unverified contract is not verified, and a refusal is unreadable', () => {
  assert.deepEqual(parseEtherscan(withResult({ SourceCode: '' })), { kind: 'not-verified' });
  assert.equal(parseEtherscan({ status: 200, body: { status: '0', message: 'NOTOK', result: 'Invalid API Key' } }).kind, 'unreadable');
});

test('a refusal is asked again and, still refused, noted as unread so nothing is recorded', async () => {
  const limited: EtherscanAnswer = { status: 200, body: { status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (3/sec)' } };
  const unread: string[] = [];
  let asked = 0;
  const get = retryingEtherscan(async () => (asked++, limited), (read) => void unread.push(read), [0]);
  assert.deepEqual(await get(usdt.address), limited);
  assert.equal(asked, 2);
  assert.deepEqual(unread, [`etherscan ${usdt.address}: rate limited`]);
});
