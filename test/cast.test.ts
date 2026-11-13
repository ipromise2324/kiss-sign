import assert from 'node:assert/strict';
import { test } from 'node:test';
import { castValue } from '../src/decode/cast.ts';
import type { AbiValue } from '../src/decode/codec.ts';
import type { Address, Hex } from '../src/safe/types.ts';

const span = [0, 0] as const;
const uint = (value: bigint): AbiValue => ({ kind: 'uint', value, span });
const bytes = (hex: string): AbiValue => ({ kind: 'bytes', value: Uint8Array.from(Buffer.from(hex, 'hex')), span });

test('a value prints as `cast decode-calldata` prints it, for each ABI kind', () => {
  const cases: [AbiValue, string][] = [
    [uint(50000000000n), '50000000000'],
    [uint(2n ** 256n - 1n), '115792089237316195423570985008687907853269984665640564039457584007913129639935'],
    [{ kind: 'int', value: -5n, span }, '-5'],
    [{ kind: 'bool', value: true, span }, 'true'],
    [{ kind: 'bool', value: false, span }, 'false'],
    [{ kind: 'address', value: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address, span }, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
    [{ kind: 'fixed-bytes', value: '0x095ea7b3' as Hex, span }, '0x095ea7b3'],
    [bytes('00ff10'), '0x00ff10'],
    [bytes(''), '0x'],
    [{ kind: 'string', value: new TextEncoder().encode('say "hi"\n'), span }, '"say \\"hi\\"\\n"'],
    [{ kind: 'array', items: [uint(1n), uint(2n)], span }, '[1, 2]'],
    [{ kind: 'array', items: [], span }, '[]'],
    [{ kind: 'tuple', fields: [uint(0n), bytes(''), { kind: 'tuple', fields: [{ kind: 'bool', value: true, span }], span }], span }, '(0, 0x, (true))'],
  ];
  for (const [value, text] of cases) assert.equal(castValue(value), text);
});
