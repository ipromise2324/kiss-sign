# Replay

`replay` recomputes a recorded verdict offline from its verdict file alone (inputs plus every recorded chain answer), prints the verdict, the call scan and on `MATCH` the domain hash, message hash and safeTxHash, and says whether it equals the recorded result. It runs no self-check, so it runs the code of whatever checkout it is called from.

## Sub-features

- `replay-same` prints `Same verdict as recorded.` and exits 0 whatever the recorded verdict, a `MISMATCH` included.
- `replay-differs` prints `the recorded verdict was <kind>; this program now gives ...` and exits 1 when the code judges differently.
- `replay-branch` runs a branch's code on a verdict `verify` recorded from main.

## How to get to it (user POV)

- `bin/kiss-sign replay <verdict file>`, with the path `verify` printed.

## Driving it with term.sh and screenshot.sh

Preconditions:

- A verdict file from verify.md, copied to `$KSV_EVIDENCE`.

- **Replay.** `cd "$KSV_CHECKOUT" && bin/kiss-sign replay <verdict file verify printed, or its copy in $KSV_EVIDENCE> > "$KSV_EVIDENCE/replay.txt" 2>&1; echo "exit=$?" >> "$KSV_EVIDENCE/replay.txt"`. Output: `MATCH`, `Every call moves an asset of the Safe.`, `  domain hash   0xad49821825ecd3145efc36f190e241ce2083daeae560046ceb4d87c4a3b77a5b`, `  message hash  0x691e3ae283f9c860565029905c44ef28844897ca8fb7b097b3234b31a4ef8c15`, `  safeTxHash    0x06b95af7490d3ebb801881ef8ec11e4a1b3444016ee637ec8effb395f408545d`, the not-permission-to-sign line, `Same verdict as recorded.`, `exit=0`.
- **Branch code.** Run the same command from the branch checkout (a worktree works) to see the branch's judgement of a main-recorded verdict. A change meant to keep verdicts must still print `Same verdict as recorded.` and exit 0.
- **Branch page.** `replay` writes no page. To see a branch's change to `verify`'s page before it merges, render the page from a recorded verdict file with the branch's code: `evaluateTx` on `replayReader(file.exchanges)`, then `readTokenDecimals` on the same reader at the block it returns, give what `src/cli/verify.ts` hands to `verdictPage`; write that to a file and screenshot it. A verdict file recorded before verify read decimals for every verdict renders base units with `decimals() 沒讀到` for a token whose answer it lacks.
- **Offline.** It answers every chain read from the file's recorded exchanges and needs no key.

## Gotchas

- Replay is not a signing check: it prints `This is a replay of a recorded verdict, not permission to sign.` Never present it as a verify.
- It needs no `KISS_SIGN_HOME` content, but export the run's home anyway so nothing reaches `~/.kiss-sign`.
- It takes exactly one path; a glob matching several verdict files is a usage error.
