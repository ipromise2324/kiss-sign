import type { CallData, CallTree } from './expected.ts';

function hintEntries(id: string, data: CallData): string[] {
  if (data.kind !== 'decoded') return [];
  const own = data.layouts.map((layout) => `${id}-a${layout.at.join('.')}=${layout.kind}(${layout.types.join(',')})`);
  const nested = data.nested;
  if (nested === undefined) return own;
  const inner =
    nested.kind === 'multisend'
      ? nested.calls.flatMap((call) => hintEntries(`C${call.number}`, call.data))
      : nested.kind === 'bundle'
        ? nested.calls.flatMap((call, i) => hintEntries(`${id}.${i + 1}`, call.data))
        : nested.calls.flatMap((call, i) => hintEntries(`${id}.${i + 1}`, call));
  return [...own, ...inner];
}

/**
 * The hints check.sh needs to read the bytes the card's templates read as `encoded` parameters or `packed` parts:
 * `v1`, then one `<path>=<abi|packed>(<types>)` per value, or undefined when there are none.
 */
export function checkHints(tree: CallTree): string | undefined {
  const all = hintEntries('C1', tree.top.data);
  return all.length === 0 ? undefined : ['v1', ...all].join(' ');
}

/** The command the signer types on the independent computer. */
export function checkCommand(tree: CallTree): string {
  const hints = checkHints(tree);
  return hints === undefined ? `./check.sh ${tree.nonce}` : `./check.sh ${tree.nonce} --hints '${hints}'`;
}
