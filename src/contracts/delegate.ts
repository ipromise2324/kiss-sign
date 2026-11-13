import type { Hex } from '../safe/types.ts';

/**
 * What a call that names no function of the code runs: whether a DELEGATECALL or CALLCODE on its way may take its
 * target from state (storage, another contract's answer, the block) rather than from a constant, the contract's own
 * address, or the call's data. `unresolved` is a path the walk cannot follow.
 */
export type Fallback =
  | { readonly kind: 'fixed' }
  | { readonly kind: 'delegates'; readonly pc: number }
  | { readonly kind: 'unresolved'; readonly pc: number; readonly why: Unfollowable };

export type Unfollowable = 'dynamic-jump' | 'unknown-opcode' | 'too-many-states';

/** A stack word: its value when it is a constant, and whether state may have chosen it. */
type Word = { readonly value: bigint | undefined; readonly state: boolean };

const constant = (value: bigint): Word => ({ value, state: false });
const FROM_CALL: Word = { value: undefined, state: false };
const FROM_STATE: Word = { value: undefined, state: true };
/** The call's first word: the selector in its top four bytes, then bytes the caller chose. Known by identity. */
const FIRST_WORD: Word = { value: undefined, state: false };

const MAX_STATES = 200_000;
const MAX_STACK = 1024;
const WORD = (1n << 256n) - 1n;
const SELECTOR = 0xffffffffn;

const KECCAK256 = 0x20;
const CALLDATALOAD = 0x35;
const MLOAD = 0x51;
const MSTORE = 0x52;
const MSTORE8 = 0x53;
const JUMP = 0x56;
const JUMPI = 0x57;
const JUMPDEST = 0x5b;
const PUSH0 = 0x5f;
const PUSH1 = 0x60;
const PUSH32 = 0x7f;
const DUP1 = 0x80;
const DUP16 = 0x8f;
const SWAP1 = 0x90;
const SWAP16 = 0x9f;
const LOG0 = 0xa0;
const LOG4 = 0xa4;
const CALL = 0xf1;
const CALLCODE = 0xf2;
const DELEGATECALL = 0xf4;
const STATICCALL = 0xfa;

const bool = (b: boolean): bigint => (b ? 1n : 0n);

/**
 * Arithmetic and comparison, [operands, fold on constants]. The folds are enough for solc's dispatcher, which compares
 * the selector by EQ, LT and GT, and for the masks it puts on jump targets and addresses, such as `and(tag, 0xffffffff)`.
 * ADD and MUL do not fold, so a loop counter does not become a new constant on every turn.
 */
type Fold = (a: bigint, b: bigint) => bigint;
const PURE: ReadonlyMap<number, readonly [number, Fold?]> = new Map<number, readonly [number, Fold?]>([
  [0x01, [2]],
  [0x02, [2]],
  [0x03, [2, (a, b) => (a - b) & WORD]],
  [0x04, [2, (a, b) => (b === 0n ? 0n : a / b)]],
  [0x05, [2]],
  [0x06, [2]],
  [0x07, [2]],
  [0x08, [3]],
  [0x09, [3]],
  [0x0a, [2]],
  [0x0b, [2]],
  [0x10, [2, (a, b) => bool(a < b)]],
  [0x11, [2, (a, b) => bool(a > b)]],
  [0x12, [2]],
  [0x13, [2]],
  [0x14, [2, (a, b) => bool(a === b)]],
  [0x15, [1, (a) => bool(a === 0n)]],
  [0x16, [2, (a, b) => a & b]],
  [0x17, [2, (a, b) => a | b]],
  [0x18, [2, (a, b) => a ^ b]],
  [0x19, [1, (a) => ~a & WORD]],
  [0x1a, [2]],
  [0x1b, [2, (shift, value) => (shift > 255n ? 0n : (value << shift) & WORD)]],
  [0x1c, [2, (shift, value) => (shift > 255n ? 0n : value >> shift)]],
  [0x1d, [2]],
  [0x1e, [1]],
]);

/** The contract's own address, the call's value and data size, the code's size and the program counter. */
const OF_CALL: ReadonlySet<number> = new Set([0x30, 0x34, 0x36, 0x38, 0x58]);

/** Reads of the world outside the call, by how many operands they take. Each pushes one word. */
const OF_STATE: ReadonlyMap<number, number> = new Map([
  ...[0x31, 0x3b, 0x3f, 0x40, 0x49, 0x54, 0x5c].map((op) => [op, 1] as const),
  ...[0x32, 0x33, 0x3a, 0x3d, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x4a, 0x59, 0x5a].map((op) => [op, 0] as const),
  [0xf0, 3],
  [0xf5, 4],
]);

/** Opcodes that consume operands and push nothing: [operands, whether they write bytes state chose to memory]. */
const CONSUME: ReadonlyMap<number, readonly [number, boolean]> = new Map<number, readonly [number, boolean]>([
  [0x37, [3, false]],
  [0x39, [3, false]],
  [0x3c, [4, true]],
  [0x3e, [3, true]],
  [0x50, [1, false]],
  [0x55, [2, false]],
  [0x5d, [2, false]],
  [0x5e, [3, false]],
]);

const HALT: ReadonlySet<number> = new Set([0x00, 0xf3, 0xfd, 0xfe, 0xff]);

type State = { readonly pc: number; readonly stack: readonly Word[] };

const keyOf = ({ pc, stack }: State): string =>
  `${pc}:${stack.map((w) => (w === FIRST_WORD ? 'w' : w.value !== undefined ? w.value.toString(16) : w.state ? 's' : 'c')).join(',')}`;

const LOW_224 = (1n << 224n) - 1n;

/** The selector read out of the first word as solc does: `shr(224, w)`, `div(w, 2**224)`, or a mask on its top bytes. */
function selectorOf(op: number, operands: readonly Word[], selector: bigint): Word | undefined {
  const [a, b] = operands as [Word, Word];
  const top = (shift: bigint) => constant(shift >= 256n ? 0n : (selector << 224n) >> shift);
  if (op === 0x1c && b === FIRST_WORD && a.value !== undefined && a.value >= 224n) return top(a.value);
  if (op === 0x04 && a === FIRST_WORD && b.value !== undefined && b.value > 0n && (b.value & (b.value - 1n)) === 0n && b.value >= 1n << 224n) {
    return top(BigInt(b.value.toString(2).length - 1));
  }
  const mask = a === FIRST_WORD ? b.value : b === FIRST_WORD ? a.value : undefined;
  if (op === 0x16 && mask !== undefined && (mask & LOW_224) === 0n) return constant((selector << 224n) & mask);
  return undefined;
}

class Unresolved extends Error {
  readonly pc: number;
  readonly why: Unfollowable;
  constructor(pc: number, why: Unfollowable) {
    super(why);
    this.pc = pc;
    this.why = why;
  }
}

/** `pushed` holds every constant the code pushes, and the top four bytes of each whose other bytes are zero. */
type Code = { readonly bytes: Uint8Array; readonly jumpdests: ReadonlySet<number>; readonly pushed: ReadonlySet<bigint> };

function parse(code: Hex): Code {
  const bytes = Buffer.from(code.slice(2), 'hex');
  const jumpdests = new Set<number>();
  const pushed = new Set<bigint>();
  for (let at = 0; at < bytes.length; at++) {
    const op = bytes[at] ?? 0;
    if (op === JUMPDEST) jumpdests.add(at);
    if (op >= PUSH1 && op <= PUSH32) {
      const size = op - PUSH1 + 1;
      const value = BigInt(`0x${Buffer.from(bytes.subarray(at + 1, at + 1 + size)).toString('hex') || '0'}`);
      pushed.add(value);
      if ((value & LOW_224) === 0n) pushed.add(value >> 224n);
      at += size;
    }
  }
  return { bytes, jumpdests, pushed };
}

/**
 * Walks every path a call with `selector` can take, on words that keep only a constant value and whether state chose
 * them, and on memory as one flag: whether a word state chose was ever written to it. A jump must go to a constant,
 * a branch on a constant takes only its side, and past `MAX_STATES` the walk gives up. Returns where a DELEGATECALL or
 * CALLCODE state may aim, if any, and whether memory came to hold a word state chose.
 */
function walk(code: Code, selector: bigint, memoryFromState: boolean): { readonly delegates: number | undefined; readonly memoryFromState: boolean } {
  const { bytes, jumpdests } = code;
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
      if (target.value === undefined) throw new Unresolved(at, 'dynamic-jump');
      return target.value < BigInt(bytes.length) && jumpdests.has(Number(target.value)) ? { pc: Number(target.value), stack: [...stack] } : undefined;
    };
    let pc = next.pc;
    for (;;) {
      if (pc >= bytes.length) break;
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
        if (condition.value !== 0n) {
          const to = jumpTo(target, at);
          if (to !== undefined) enqueue(to);
        }
        if (condition.value === undefined || condition.value === 0n) enqueue({ pc, stack: [...stack] });
        break;
      }
      if (HALT.has(op)) break;
      const pure = PURE.get(op);
      if (pure !== undefined) {
        const operands = take(pure[0]);
        if (operands === undefined) break;
        const [count, fold] = pure;
        const values = operands.map((w) => w.value);
        let result: Word = selectorOf(op, operands, selector) ?? (operands.some((w) => w.state) ? FROM_STATE : FROM_CALL);
        if (fold !== undefined && values.every((v) => v !== undefined)) result = constant(fold(values[0] as bigint, count === 2 ? (values[1] as bigint) : 0n));
        if (!push(result)) break;
        continue;
      }
      if (OF_CALL.has(op)) {
        if (!push(FROM_CALL)) break;
        continue;
      }
      if (op === CALLDATALOAD) {
        const offset = take(1)?.[0];
        if (offset === undefined) break;
        if (!push(offset.state ? FROM_STATE : offset.value === 0n ? FIRST_WORD : FROM_CALL)) break;
        continue;
      }
      if (op === MLOAD || op === KECCAK256) {
        const operands = take(op === MLOAD ? 1 : 2);
        if (operands === undefined || !push(memory || operands.some((w) => w.state) ? FROM_STATE : FROM_CALL)) break;
        continue;
      }
      if (op === MSTORE || op === MSTORE8) {
        const operands = take(2);
        if (operands === undefined) break;
        if (operands.some((w) => w.state)) memory = true;
        continue;
      }
      const ofState = OF_STATE.get(op);
      if (ofState !== undefined) {
        if (take(ofState) === undefined || !push(FROM_STATE)) break;
        continue;
      }
      const consume = CONSUME.get(op);
      if (consume !== undefined) {
        const operands = take(consume[0]);
        if (operands === undefined) break;
        if (consume[1] || operands.some((w) => w.state)) memory = true;
        continue;
      }
      if (op >= LOG0 && op <= LOG4) {
        if (take(2 + op - LOG0) === undefined) break;
        continue;
      }
      if (op === CALL || op === CALLCODE || op === DELEGATECALL || op === STATICCALL) {
        const operands = take(op === CALL || op === CALLCODE ? 7 : 6);
        if (operands === undefined) break;
        if ((op === DELEGATECALL || op === CALLCODE) && (operands[1] as Word).state) return { delegates: at, memoryFromState: memory };
        if ((operands[operands.length - 1] as Word).value !== 0n) memory = true;
        if (!push(FROM_STATE)) break;
        continue;
      }
      throw new Unresolved(at, 'unknown-opcode');
    }
  }
  return { delegates: undefined, memoryFromState: memory };
}

/**
 * Follows a call whose selector the code never pushes, alone or in the top bytes of a word, so it matches no function and takes the fallback (or the
 * receive function, or a revert). Memory starts as holding nothing state chose; when a walk finds it can, the walk
 * runs again with memory counted as state's from the start.
 */
export function fallbackDelegation(code: Hex): Fallback {
  const parsed = parse(code);
  let selector = SELECTOR;
  while (parsed.pushed.has(selector)) selector -= 1n;
  try {
    let memoryFromState = false;
    for (;;) {
      const run = walk(parsed, selector, memoryFromState);
      if (run.delegates !== undefined) return { kind: 'delegates', pc: run.delegates };
      if (run.memoryFromState === memoryFromState) return { kind: 'fixed' };
      memoryFromState = run.memoryFromState;
    }
  } catch (error) {
    if (error instanceof Unresolved) return { kind: 'unresolved', pc: error.pc, why: error.why };
    throw error;
  }
}
