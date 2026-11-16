import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/**
 * A recording keeps each distinct code once, in its top-level `bytecode` table by keccak256, and each code answer
 * names it as `{ "keccak256": ... }`. Code answers are the providers' answers of an `eth_getCode` exchange and the
 * `value` of an ABI case's `getCode` read. An answer that is not lowercase hex, such as a provider's null or uppercase
 * code, stays as it was, so the reader judges it as it did live.
 */
const TABLE = 'bytecode';

export class RecordingError extends Error {}

type Json = unknown;
type Ref = { readonly keccak256: string };

const isObject = (value: Json): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isHex = (value: Json): value is string => typeof value === 'string' && /^0x([0-9a-f]{2})*$/.test(value);
const isRef = (value: Json): value is Ref => isObject(value) && Object.keys(value).join() === 'keccak256' && typeof value.keccak256 === 'string';
const keccakHex = (code: string): string => `0x${bytesToHex(keccak_256(hexToBytes(code.slice(2))))}`;

/** Calls `swap` on each code answer and returns the value with each one replaced, leaving `value` as it was. */
function mapCodes(value: Json, swap: (answer: Json, where: string) => Json, where = ''): Json {
  if (Array.isArray(value)) return value.map((item, i) => mapCodes(item, swap, `${where}[${i}]`));
  if (!isObject(value)) return value;
  const out: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value)) out[key] = mapCodes(item, swap, `${where}.${key}`);
  if (value.method === 'eth_getCode' && isObject(value.answers)) {
    out.answers = Object.fromEntries(Object.entries(value.answers).map(([provider, answer]) => [provider, swap(answer, `${where}.answers.${provider}`)]));
  }
  if (value.method === 'getCode' && Object.hasOwn(value, 'value')) out.value = swap(value.value, `${where}.value`);
  return out;
}

/** The recording with each code moved into its `bytecode` table, which it gets only when it holds code. */
export function packRecording(recording: Json): Json {
  if (!isObject(recording)) throw new RecordingError('a recording is a JSON object');
  if (Object.hasOwn(recording, TABLE)) throw new RecordingError(`a recording to write already has "${TABLE}"`);
  const table = new Map<string, string>();
  const packed = mapCodes(recording, (answer) => {
    if (!isHex(answer)) return answer;
    const hash = keccakHex(answer);
    table.set(hash, answer);
    return { keccak256: hash };
  });
  if (table.size === 0) return packed;
  return { ...(packed as Record<string, Json>), [TABLE]: Object.fromEntries([...table].sort(([a], [b]) => (a < b ? -1 : 1))) };
}

/** The recording as its program wrote it, each code put back. `where` names the file in a refusal. */
export function unpackRecording(recording: Json, where: string): Json {
  const refuse = (problem: string): never => {
    throw new RecordingError(`${where}: ${problem}`);
  };
  if (!isObject(recording)) return refuse('not a JSON object');
  const { [TABLE]: table = {}, ...rest } = recording;
  if (!isObject(table)) return refuse(`"${TABLE}" is not an object`);
  for (const [hash, code] of Object.entries(table)) {
    if (!isHex(code) || keccakHex(code) !== hash) refuse(`${TABLE}.${hash} is not code whose keccak256 is its key`);
  }
  const named = new Set<string>();
  const unpacked = mapCodes(rest, (answer, at) => {
    if (isHex(answer)) return refuse(`${at} holds code itself, not its keccak256 in "${TABLE}"; record it again`);
    if (!isRef(answer)) return answer;
    if (!Object.hasOwn(table, answer.keccak256)) return refuse(`${at} names ${answer.keccak256}, which "${TABLE}" lacks`);
    named.add(answer.keccak256);
    return table[answer.keccak256];
  });
  const unused = Object.keys(table).find((hash) => !named.has(hash));
  if (unused !== undefined) refuse(`${TABLE}.${unused} is code no answer names`);
  return unpacked;
}

/** The text a recording is written as: packed, with the indent its writer uses, and a final newline. */
export const recordingText = (recording: Json, indent?: number): string => `${JSON.stringify(packRecording(recording), null, indent)}\n`;

export const parseRecording = (text: string, where: string): Json => unpackRecording(JSON.parse(text) as Json, where);

/** Like `JSON.parse`, it trusts the caller's type; each reader parses what it uses. */
export const readRecording = <T = Json>(path: string): T => parseRecording(readFileSync(path, 'utf8'), path) as T;
