import type { NoteUnread } from '../chain/https.ts';
import { messageFromAnswer } from '../template/eip712.ts';
import type { SignedMessage } from '../template/template.ts';
import type { MessageReader } from '../verify/verify.ts';

/** A signed message read from a template's `lookup` URL, cut to its struct's members, or why none was read. */
export type MessageRead = { readonly text: string } | { readonly why: string };

export type ReadMessage = (url: string, message: SignedMessage) => Promise<MessageRead>;

export type MessageExchange = { readonly url: string } & MessageRead;

export function liveMessages(read: MessageReader, note: NoteUnread): ReadMessage {
  return async (url, message) => {
    const answer = await read(url);
    if ('text' in answer) return messageFromAnswer(message.struct, message.answer, answer.text);
    if (answer.noAnswer === true) note(url);
    return { why: answer.why };
  };
}

export function recordingMessages(inner: ReadMessage): { read: ReadMessage; exchanges: () => MessageExchange[] } {
  const exchanges = new Map<string, MessageExchange>();
  return {
    read: async (url, message) => {
      const answer = await inner(url, message);
      exchanges.set(url, { url, ...answer });
      return answer;
    },
    exchanges: () => [...exchanges.values()],
  };
}

export function replayMessages(exchanges: readonly MessageExchange[]): ReadMessage {
  return async (url) => {
    const found = exchanges.find((e) => e.url === url);
    if (found === undefined) return { why: 'not recorded' };
    return 'text' in found ? { text: found.text } : { why: found.why };
  };
}
