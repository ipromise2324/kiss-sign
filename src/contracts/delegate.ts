import type { Hex } from '../safe/types.ts';

/**
 * What a call that names no function of the code runs. `delegates` is a DELEGATECALL or CALLCODE on its way whose
 * target may be anything but the contract's own address, a word of the call's data, or the value of a storage slot
 * the caller allows: a constant, another slot, or anything else state chose. `unresolved` is a path the walk cannot
 * follow.
 */
export type Fallback =
  | { readonly kind: 'fixed' }
  | { readonly kind: 'delegates'; readonly pc: number }
  | { readonly kind: 'unresolved'; readonly pc: number; readonly why: Unfollowable };

export type Unfollowable = 'dynamic-jump' | 'unknown-opcode' | 'too-many-states';

/**
 * A stack word as far as the walk knows it. `first-word` is the call's first 32 bytes: the selector, then bytes the
 * caller chose. `slot` is the value of a storage slot at a constant key; `state` is anything else state chose.
 */
type Word =
  | { readonly kind: 'constant'; readonly value: bigint }
  | { readonly kind: 'self' }
  | { readonly kind: 'call' }
  | { readonly kind: 'first-word' }
  | { readonly kind: 'slot'; readonly slot: bigint }
  | { readonly kind: 'state' };

const constant = (value: bigint): Word => ({ kind: 'constant', value });
const SELF: Word = { kind: 'self' };
const CALL_DATA: Word = { kind: 'call' };
const FIRST_WORD: Word = { kind: 'first-word' };
const STATE: Word = { kind: 'state' };
const fromState = (w: Word): boolean => w.kind === 'slot' || w.kind === 'state';
const valueOf = (w: Word): bigint | undefined => (w.kind === 'constant' ? w.value : undefined);

const MAX_STATES = 200_000;
const MAX_STACK = 1024;
const WORD = (1n << 256n) - 1n;
const LOW_224 = (1n << 224n) - 1n;
const SELECTOR = 0xffffffffn;

const STOP = 0x00;
const ADD = 0x01;
const MUL = 0x02;
const SUB = 0x03;
const DIV = 0x04;
const SDIV = 0x05;
const MOD = 0x06;
const SMOD = 0x07;
const ADDMOD = 0x08;
const MULMOD = 0x09;
const EXP = 0x0a;
const SIGNEXTEND = 0x0b;
const LT = 0x10;
const GT = 0x11;
const SLT = 0x12;
const SGT = 0x13;
const EQ = 0x14;
const ISZERO = 0x15;
const AND = 0x16;
const OR = 0x17;
const XOR = 0x18;
const NOT = 0x19;
const BYTE = 0x1a;
const SHL = 0x1b;
const SHR = 0x1c;
const SAR = 0x1d;
const CLZ = 0x1e;
const KECCAK256 = 0x20;
const ADDRESS = 0x30;
const BALANCE = 0x31;
const ORIGIN = 0x32;
const CALLER = 0x33;
const CALLVALUE = 0x34;
const CALLDATALOAD = 0x35;
const CALLDATASIZE = 0x36;
const CALLDATACOPY = 0x37;
const CODESIZE = 0x38;
const CODECOPY = 0x39;
const GASPRICE = 0x3a;
const EXTCODESIZE = 0x3b;
const EXTCODECOPY = 0x3c;
const RETURNDATASIZE = 0x3d;
const RETURNDATACOPY = 0x3e;
const EXTCODEHASH = 0x3f;
const BLOCKHASH = 0x40;
const COINBASE = 0x41;
const TIMESTAMP = 0x42;
const NUMBER = 0x43;
const PREVRANDAO = 0x44;
const GASLIMIT = 0x45;
const CHAINID = 0x46;
const SELFBALANCE = 0x47;
const BASEFEE = 0x48;
const BLOBHASH = 0x49;
const BLOBBASEFEE = 0x4a;
const POP = 0x50;
const MLOAD = 0x51;
const MSTORE = 0x52;
const MSTORE8 = 0x53;
const SLOAD = 0x54;
const SSTORE = 0x55;
const JUMP = 0x56;
const JUMPI = 0x57;
const PC = 0x58;
const MSIZE = 0x59;
const GAS = 0x5a;
const JUMPDEST = 0x5b;
const TLOAD = 0x5c;
const TSTORE = 0x5d;
const MCOPY = 0x5e;
const PUSH0 = 0x5f;
const PUSH1 = 0x60;
const PUSH32 = 0x7f;
const DUP1 = 0x80;
const DUP16 = 0x8f;
const SWAP1 = 0x90;
const SWAP16 = 0x9f;
const LOG0 = 0xa0;
const LOG4 = 0xa4;
const CREATE = 0xf0;
const CALL = 0xf1;
const CALLCODE = 0xf2;
const RETURN = 0xf3;
const DELEGATECALL = 0xf4;
const CREATE2 = 0xf5;
const STATICCALL = 0xfa;
const REVERT = 0xfd;
const INVALID = 0xfe;
const SELFDESTRUCT = 0xff;

const bool = (b: boolean): bigint => (b ? 1n : 0n);

function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  for (let b = base & WORD, e = exponent; e > 0n; e >>= 1n, b = (b * b) & WORD) if (e & 1n) result = (result * b) & WORD;
  return result;
}

type Fold = (a: bigint, b: bigint) => bigint;

/**
 * Folded on constants: enough for solc's dispatcher and for the masks it puts on jump targets and addresses. ADD and
 * MUL are not, so that a loop counter does not become a new constant, and a new state, on every turn; MUL by one,
 * which solc before 0.5 puts on a `bytes32` constant such as a proxy's slot, keeps the other operand.
 */
const FOLDS: ReadonlyMap<number, Fold> = new Map<number, Fold>([
  [SUB, (a, b) => (a - b) & WORD],
  [DIV, (a, b) => (b === 0n ? 0n : a / b)],
  [EXP, power],
  [LT, (a, b) => bool(a < b)],
  [GT, (a, b) => bool(a > b)],
  [EQ, (a, b) => bool(a === b)],
  [ISZERO, (a) => bool(a === 0n)],
  [AND, (a, b) => a & b],
  [OR, (a, b) => a | b],
  [XOR, (a, b) => a ^ b],
  [NOT, (a) => ~a & WORD],
  [SHL, (shift, value) => (shift > 255n ? 0n : (value << shift) & WORD)],
  [SHR, (shift, value) => (shift > 255n ? 0n : value >> shift)],
]);

const OPERANDS: ReadonlyMap<number, number> = new Map([
  ...[ADD, MUL, SUB, DIV, SDIV, MOD, SMOD, EXP, SIGNEXTEND, LT, GT, SLT, SGT, EQ, AND, OR, XOR, BYTE, SHL, SHR, SAR].map((op) => [op, 2] as const),
  ...[ADDMOD, MULMOD].map((op) => [op, 3] as const),
  ...[ISZERO, NOT, CLZ].map((op) => [op, 1] as const),
]);

const CALL_VALUES: ReadonlySet<number> = new Set([CALLVALUE, CALLDATASIZE, CODESIZE, PC]);

/** Opcodes that read the world outside the call, by how many operands they take. Each pushes one word. */
const STATE_READ_OPERANDS: ReadonlyMap<number, number> = new Map([
  ...[BALANCE, EXTCODESIZE, EXTCODEHASH, BLOCKHASH, BLOBHASH, TLOAD].map((op) => [op, 1] as const),
  ...[ORIGIN, CALLER, GASPRICE, RETURNDATASIZE, COINBASE, TIMESTAMP, NUMBER, PREVRANDAO, GASLIMIT, CHAINID, SELFBALANCE, BASEFEE, BLOBBASEFEE, MSIZE, GAS].map(
    (op) => [op, 0] as const,
  ),
  [CREATE, 3],
  [CREATE2, 4],
]);

type Effect = { readonly operands: number; readonly writesStateToMemory: boolean };

/** Opcodes that push nothing. A copy with an operand state chose may also write bytes state chose. */
const EFFECTS: ReadonlyMap<number, Effect> = new Map<number, Effect>([
  [CALLDATACOPY, { operands: 3, writesStateToMemory: false }],
  [CODECOPY, { operands: 3, writesStateToMemory: false }],
  [EXTCODECOPY, { operands: 4, writesStateToMemory: true }],
  [RETURNDATACOPY, { operands: 3, writesStateToMemory: true }],
  [POP, { operands: 1, writesStateToMemory: false }],
  [SSTORE, { operands: 2, writesStateToMemory: false }],
  [TSTORE, { operands: 2, writesStateToMemory: false }],
  [MCOPY, { operands: 3, writesStateToMemory: false }],
]);

const HALTS: ReadonlySet<number> = new Set([STOP, RETURN, REVERT, INVALID, SELFDESTRUCT]);

/** The selector read out of the first word as solc does: `shr(224, w)`, `div(w, 2**224)`, or a mask on its top bytes. */
function selectorOf(op: number, [a, b]: readonly Word[], selector: bigint): Word | undefined {
  const top = (shift: bigint) => constant(shift >= 256n ? 0n : (selector << 224n) >> shift);
  const shift = a === undefined ? undefined : valueOf(a);
  const divisor = b === undefined ? undefined : valueOf(b);
  if (op === SHR && b?.kind === 'first-word' && shift !== undefined && shift >= 224n) return top(shift);
  if (op === DIV && a?.kind === 'first-word' && divisor !== undefined && divisor >= 1n << 224n && (divisor & (divisor - 1n)) === 0n) {
    return top(BigInt(divisor.toString(2).length - 1));
  }
  const mask = a?.kind === 'first-word' && b !== undefined ? valueOf(b) : b?.kind === 'first-word' && a !== undefined ? valueOf(a) : undefined;
  if (op === AND && mask !== undefined && (mask & LOW_224) === 0n) return constant((selector << 224n) & mask);
  return undefined;
}

function compute(op: number, operands: readonly Word[], selector: bigint): Word {
  const read = selectorOf(op, operands, selector);
  if (read !== undefined) return read;
  const values = operands.map(valueOf);
  const fold = FOLDS.get(op);
  if (fold !== undefined && values.every((v) => v !== undefined)) return constant(fold(values[0] as bigint, values[1] ?? 0n));
  const [a, b] = operands as [Word, Word];
  if (op === MUL && (valueOf(a) === 1n || valueOf(b) === 1n)) return valueOf(a) === 1n ? b : a;
  if (op === AND && (a.kind === 'constant') !== (b.kind === 'constant')) {
    const masked = a.kind === 'constant' ? b : a;
    if (masked.kind === 'self' || masked.kind === 'slot') return masked;
  }
  return operands.some(fromState) ? STATE : CALL_DATA;
}

type State = { readonly pc: number; readonly stack: readonly Word[] };

function tag(w: Word): string {
  switch (w.kind) {
    case 'constant':
      return w.value.toString(16);
    case 'slot':
      return `k${w.slot.toString(16)}`;
    case 'self':
      return 'a';
    case 'call':
      return 'c';
    case 'first-word':
      return 'w';
    case 'state':
      return 's';
  }
}

const keyOf = ({ pc, stack }: State): string => `${pc}:${stack.map(tag).join(',')}`;

class Unresolved extends Error {
  readonly pc: number;
  readonly why: Unfollowable;
  constructor(pc: number, why: Unfollowable) {
    super(why);
    this.pc = pc;
    this.why = why;
  }
}

type Code = { readonly bytes: Uint8Array; readonly jumpdests: ReadonlySet<number>; readonly selectorsTaken: ReadonlySet<bigint> };

/** Every constant the code pushes, and the top four bytes of each whose other bytes are zero, can be a selector it compares. */
function parse(code: Hex): Code {
  const bytes = Buffer.from(code.slice(2), 'hex');
  const jumpdests = new Set<number>();
  const selectorsTaken = new Set<bigint>();
  for (let at = 0; at < bytes.length; at++) {
    const op = bytes[at] ?? 0;
    if (op === JUMPDEST) jumpdests.add(at);
    if (op >= PUSH1 && op <= PUSH32) {
      const size = op - PUSH1 + 1;
      const value = BigInt(`0x${Buffer.from(bytes.subarray(at + 1, at + 1 + size)).toString('hex') || '0'}`);
      selectorsTaken.add(value);
      if ((value & LOW_224) === 0n) selectorsTaken.add(value >> 224n);
      at += size;
    }
  }
  return { bytes, jumpdests, selectorsTaken };
}

/**
 * Walks every path a call with `selector` can take, keeping memory as one flag: whether a word state chose was ever
 * written to it. A jump must go to a constant, a branch on a constant takes only its side, and past `MAX_STATES` the
 * walk gives up. Returns where a DELEGATECALL or CALLCODE aims at code `allowed` does not cover, if anywhere, and
 * whether memory came to hold a word state chose.
 */
function walk(
  code: Code,
  selector: bigint,
  allowed: readonly bigint[],
  memoryFromState: boolean,
): { readonly delegates: number | undefined; readonly memoryFromState: boolean } {
  const { bytes, jumpdests } = code;
  const covered = (target: Word): boolean =>
    target.kind === 'self' || target.kind === 'call' || target.kind === 'first-word' || (target.kind === 'slot' && allowed.includes(target.slot));
  let memory = memoryFromState;
  const seen = new Set<string>();
  const queue: State[] = [];
  const enqueue = (state: State) => {
    const key = keyOf(state);
    if (seen.has(key)) return;
    if (seen.size >= MAX_STATES) throw new Unresolved(state.pc, 'too-many-states');
    seen.add(key);
    queue.push(state);
  };
  enqueue({ pc: 0, stack: [] });
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const stack = [...next.stack];
    const take = (n: number): Word[] | undefined => (stack.length < n ? undefined : stack.splice(stack.length - n, n).reverse());
    const push = (word: Word): boolean => stack.push(word) <= MAX_STACK;
    const jumpTo = (target: Word, at: number): State | undefined => {
      const to = valueOf(target);
      if (to === undefined) throw new Unresolved(at, 'dynamic-jump');
      return to < BigInt(bytes.length) && jumpdests.has(Number(to)) ? { pc: Number(to), stack: [...stack] } : undefined;
    };
    let pc = next.pc;
    while (pc < bytes.length) {
      const at = pc;
      const op = bytes[pc] ?? 0;
      pc += 1;
      if (op >= PUSH1 && op <= PUSH32) {
        const size = op - PUSH1 + 1;
        let value = 0n;
        for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(bytes[pc + i] ?? 0);
        pc += size;
        if (!push(constant(value))) break;
        continue;
      }
      if (op === PUSH0) {
        if (!push(constant(0n))) break;
        continue;
      }
      if (op >= DUP1 && op <= DUP16) {
        const word = stack[stack.length - (op - DUP1 + 1)];
        if (word === undefined || !push(word)) break;
        continue;
      }
      if (op >= SWAP1 && op <= SWAP16) {
        const other = stack.length - 1 - (op - SWAP1 + 1);
        if (other < 0) break;
        const top = stack[stack.length - 1] as Word;
        stack[stack.length - 1] = stack[other] as Word;
        stack[other] = top;
        continue;
      }
      if (op === JUMPDEST) continue;
      if (op === JUMP) {
        const target = take(1)?.[0];
        if (target === undefined) break;
        const to = jumpTo(target, at);
        if (to !== undefined) enqueue(to);
        break;
      }
      if (op === JUMPI) {
        const operands = take(2);
        if (operands === undefined) break;
        const [target, condition] = operands as [Word, Word];
        const taken = valueOf(condition);
        if (taken !== 0n) {
          const to = jumpTo(target, at);
          if (to !== undefined) enqueue(to);
        }
        if (taken === undefined || taken === 0n) enqueue({ pc, stack: [...stack] });
        break;
      }
      if (HALTS.has(op)) break;
      const operandCount = OPERANDS.get(op);
      if (operandCount !== undefined) {
        const operands = take(operandCount);
        if (operands === undefined || !push(compute(op, operands, selector))) break;
        continue;
      }
      if (op === ADDRESS || CALL_VALUES.has(op)) {
        if (!push(op === ADDRESS ? SELF : CALL_DATA)) break;
        continue;
      }
      if (op === CALLDATALOAD || op === SLOAD) {
        const key = take(1)?.[0];
        if (key === undefined) break;
        const value = valueOf(key);
        const word = fromState(key) ? STATE : op === SLOAD ? (value === undefined ? STATE : { kind: 'slot' as const, slot: value }) : value === 0n ? FIRST_WORD : CALL_DATA;
        if (!push(word)) break;
        continue;
      }
      if (op === MLOAD || op === KECCAK256) {
        const operands = take(op === MLOAD ? 1 : 2);
        if (operands === undefined || !push(memory || operands.some(fromState) ? STATE : CALL_DATA)) break;
        continue;
      }
      if (op === MSTORE || op === MSTORE8) {
        const operands = take(2);
        if (operands === undefined) break;
        if (operands.some(fromState)) memory = true;
        continue;
      }
      const stateRead = STATE_READ_OPERANDS.get(op);
      if (stateRead !== undefined) {
        if (take(stateRead) === undefined || !push(STATE)) break;
        continue;
      }
      const effect = EFFECTS.get(op);
      if (effect !== undefined) {
        const operands = take(effect.operands);
        if (operands === undefined) break;
        if (effect.writesStateToMemory || operands.some(fromState)) memory = true;
        continue;
      }
      if (op >= LOG0 && op <= LOG4) {
        if (take(2 + op - LOG0) === undefined) break;
        continue;
      }
      if (op === CALL || op === CALLCODE || op === DELEGATECALL || op === STATICCALL) {
        const operands = take(op === CALL || op === CALLCODE ? 7 : 6);
        if (operands === undefined) break;
        if ((op === DELEGATECALL || op === CALLCODE) && !covered(operands[1] as Word)) return { delegates: at, memoryFromState: memory };
        if (valueOf(operands[operands.length - 1] as Word) !== 0n) memory = true;
        if (!push(STATE)) break;
        continue;
      }
      throw new Unresolved(at, 'unknown-opcode');
    }
  }
  return { delegates: undefined, memoryFromState: memory };
}

/**
 * Follows a call whose selector the code never pushes, alone or in the top bytes of a word, so it matches no function
 * and takes the fallback (or the receive function, or a revert). `allowed` names the storage slots a known proxy keeps
 * its implementation in. Memory starts as holding nothing state chose; when a walk finds it can, the walk runs again
 * with memory counted as state's from the start.
 */
export function fallbackDelegation(code: Hex, allowed: readonly bigint[] = []): Fallback {
  const parsed = parse(code);
  let selector = SELECTOR;
  while (parsed.selectorsTaken.has(selector)) selector -= 1n;
  try {
    let memoryFromState = false;
    for (;;) {
      const run = walk(parsed, selector, allowed, memoryFromState);
      if (run.delegates !== undefined) return { kind: 'delegates', pc: run.delegates };
      if (run.memoryFromState === memoryFromState) return { kind: 'fixed' };
      memoryFromState = run.memoryFromState;
    }
  } catch (error) {
    if (error instanceof Unresolved) return { kind: 'unresolved', pc: error.pc, why: error.why };
    throw error;
  }
}
