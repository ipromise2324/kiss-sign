import type { Transport } from '../chain/rpc.ts';
import type { Env } from '../keys.ts';

export type Io = {
  readonly env: Env;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Undefined when stdin is not a terminal, so no key can arrive through a pipe or a chat. */
  readonly readSecret: ((question: string) => Promise<string | undefined>) | undefined;
  /** A yes/no question at the terminal. Undefined when stdin is not a terminal, so only the signer can say yes. */
  readonly confirm: ((question: string) => Promise<boolean>) | undefined;
  /** The clone kiss-sign runs from, which the self-check compares with origin/main. */
  readonly repoRoot: string;
  /** JSON-RPC to the two providers. */
  readonly transport: Transport;
  /** GET a JSON document, for the Safe Transaction Service. */
  readonly fetchJson: (url: string) => Promise<unknown>;
};

export const OK = 0;
export const FAILED = 1;
export const USAGE = 64;

export class UsageError extends Error {}

/** Refuses up front when there is no terminal to confirm at, and returns the question to ask once the details are shown. */
export function terminalConfirm(io: Io, command: string): (question: string) => Promise<boolean> {
  if (io.confirm === undefined) {
    throw new UsageError(`${command} asks you to confirm at a terminal, so run it in your own terminal with nothing piped into it.`);
  }
  return io.confirm;
}
