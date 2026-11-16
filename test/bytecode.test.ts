import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { parseRecording, recordingText } from '../src/chain/bytecode.ts';

const CODE = '0x6080604052';
const OTHER = '0x6001';
const keccak = (code: string): string => `0x${bytesToHex(keccak_256(hexToBytes(code.slice(2))))}`;
const getCode = (address: string, alchemy: unknown, drpc: unknown) => ({ method: 'eth_getCode', params: [address, '0x1'], answers: { alchemy, drpc } });

const recording = {
  code: [getCode('0xaa', CODE, CODE), getCode('0xbb', CODE, OTHER), { method: 'eth_call', params: [], answers: { alchemy: CODE } }],
  reads: [{ method: 'getCode', args: ['0xaa'], value: CODE }],
};

test('a recording keeps each distinct code once, by its keccak256, and reads back as it was', () => {
  const text = recordingText(recording, 2);
  const stored = JSON.parse(text);
  assert.deepEqual(Object.keys(stored.bytecode), [keccak(CODE), keccak(OTHER)].sort());
  assert.equal(text.split(CODE).length - 1, 2, 'the code once in the table, and the eth_call answer, which is not code');
  assert.deepEqual(stored.code[1].answers, { alchemy: { keccak256: keccak(CODE) }, drpc: { keccak256: keccak(OTHER) } });
  assert.deepEqual(stored.reads[0].value, { keccak256: keccak(CODE) });
  assert.deepEqual(parseRecording(text, 'r.json'), recording);
});

test('a recording without code gets no table', () => {
  assert.equal(recordingText({ exchanges: [] }), '{"exchanges":[]}\n');
});

test('a recording that writes code out in full, names code its table lacks, or holds code no answer names is refused', () => {
  const stored = JSON.parse(recordingText(recording));
  assert.throws(() => parseRecording(JSON.stringify(recording), 'r.json'), { message: 'r.json: .code[0].answers.alchemy holds code itself, not its keccak256 in "bytecode"; record it again' });
  const lacking = { ...stored, bytecode: { [keccak(CODE)]: CODE } };
  assert.throws(() => parseRecording(JSON.stringify(lacking), 'r.json'), { message: `r.json: .code[1].answers.drpc names ${keccak(OTHER)}, which "bytecode" lacks` });
  const extra = { ...stored, bytecode: { ...stored.bytecode, [keccak('0x00')]: '0x00' } };
  assert.throws(() => parseRecording(JSON.stringify(extra), 'r.json'), { message: `r.json: bytecode.${keccak('0x00')} is code no answer names` });
  const forged = { ...stored, bytecode: { ...stored.bytecode, [keccak(OTHER)]: '0x6002' } };
  assert.throws(() => parseRecording(JSON.stringify(forged), 'r.json'), { message: `r.json: bytecode.${keccak(OTHER)} is not code whose keccak256 is its key` });
});
