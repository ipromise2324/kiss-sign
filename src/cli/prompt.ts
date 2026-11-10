/** Terminal escape sequences, such as bracketed-paste markers and arrow keys. */
const ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Reads one line from a TTY in raw mode and echoes nothing. readline is not used, because it echoes. Ctrl-C, Ctrl-D,
 * or the end of input gives up with undefined.
 */
export function hiddenPrompt(question: string, stdin: NodeJS.ReadStream, stderr: NodeJS.WriteStream): Promise<string | undefined> {
  return new Promise((resolve) => {
    let input = '';
    const finish = (value: string | undefined): void => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      resolve(value);
    };
    const onEnd = (): void => finish(undefined);
    const onData = (chunk: string): void => {
      input += chunk;
      let typed = '';
      for (const char of input.replace(ESCAPE, '')) {
        if (char === '\r' || char === '\n') return finish(typed);
        if (char === '\x03' || char === '\x04') return finish(undefined);
        if (char === '\x7f' || char === '\b') typed = typed.slice(0, -1);
        else if (char >= ' ') typed += char;
      }
    };
    stderr.write(question);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.resume();
  });
}
