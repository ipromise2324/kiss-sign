import type { Transport } from '../chain/rpc.ts';
import type { Env } from '../keys.ts';
import type { MessageReader } from '../verify/verify.ts';
import type { Labels } from './labels.ts';

export type Io = {
  readonly env: Env;
  /** Which command opens a file in an editor. */
  readonly platform: NodeJS.Platform;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** True when stdout is a terminal that takes colour; absent or false prints plain text. */
  readonly color?: boolean;
  /** Undefined when stdin is not a terminal, so no key can arrive through a pipe or a chat. */
  readonly readSecret: ((question: string) => Promise<string | undefined>) | undefined;
  /** One line typed at the terminal, or undefined at the end of input. Undefined when stdin is not a terminal, so only the signer can answer. */
  readonly ask: ((question: string) => Promise<string | undefined>) | undefined;
  /** The clone kiss-sign runs from, which the self-check compares with origin/main. */
  readonly repoRoot: string;
  /** JSON-RPC to the two providers. */
  readonly transport: Transport;
  /** GET a JSON document, for the Safe Transaction Service. */
  readonly fetchJson: (url: string) => Promise<unknown>;
  /** This computer's clock, in milliseconds since 1970; absent reads the machine's own. */
  readonly now?: () => number;
  /** A signed message's text read from a template's `lookup`, or why it could not be read. */
  readonly readMessage: MessageReader;
};

export const OK = 0;
export const FAILED = 1;
export const USAGE = 64;

export class UsageError extends Error {}

export type Terminal = {
  readonly ask: (question: string) => Promise<string | undefined>;
  /** True only for y or yes. */
  readonly confirm: (question: string) => Promise<boolean>;
};

/** Refuses up front when there is no terminal to answer at, so nothing is shown or asked first. */
export function terminal(io: Io, command: string, w: Labels): Terminal {
  const { ask } = io;
  if (ask === undefined) throw new UsageError(w.confirmAtTerminal(command));
  return { ask, confirm: async (question) => /^y(es)?$/i.test((await ask(question))?.trim() ?? '') };
}
