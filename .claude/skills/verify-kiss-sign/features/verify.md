# Verify

The signer checks a Safe transaction against the sealed card: `verify` first checks that the clone is exactly origin/main, then decodes, re-encodes, applies the floor rules and the template, judges the Safe's asset changes (an executed transaction by its receipt, any other by simulation on the latest block through Alchemy and drpc), and prints `MATCH` with the safeTxHash, or `MISMATCH`/`UNVERIFIABLE` with the checks that caused it. It writes a verdict file and an HTML page to `$KISS_SIGN_HOME/verdicts/` and prints both paths.

## Sub-features

- `verify-match` prints `MATCH` and the safeTxHash; the page shows the 比對清單 with domain hash, message hash, safeTxHash and every call row.
- `verify-mismatch` prints `MISMATCH` with each cause and `No hashes are shown. Do not sign this transaction.`
- `verify-self-check` refuses a checkout that is not exactly origin/main, writing no verdict.
- `verify-tx-file` reads `--tx` as Transaction Service JSON or the Safe web app's JSON.
- `verify-tx-hash` fetches `--safe-tx-hash` from the Safe Transaction Service.
- `verify-language` writes the page in the config's `language`: English by default, Traditional Chinese after `init --language zh-TW` (`KSV_LANGUAGE=zh-TW` for `new-run.sh`). The 比對清單 rows keep `check.sh`'s ids, keys and group titles in either language; only the name column follows the page.

## How to get to it (user POV)

- `bin/kiss-sign verify --card <sealed card hash> --tx <file>`.
- `bin/kiss-sign verify --card <sealed card hash> --safe-tx-hash <hash>`, the form the report's Next steps (下一步) gives.

## Driving it with term.sh and screenshot.sh

Preconditions:

- Run made with `--clone` and the fixture's Safe; `$KSV_CHECKOUT` is the clone, `git status --short` empty.
- `morpho/vault-deposit` approved (template-approve.md) and a card sealed (card-new.md) in this home.
- `"$V/fixture-tx.mjs" morpho-vault-deposit-v2 "$KSV_DIR/tx.json"` run.

- **Verify.** `cd "$KSV_CHECKOUT" && bin/kiss-sign verify --card <hash> --tx "$KSV_DIR/tx.json" > "$KSV_EVIDENCE/verify.txt" 2>&1; echo "exit=$?" >> "$KSV_EVIDENCE/verify.txt"`. Takes about 10 s. Output: `MATCH`, `  safeTxHash  0x06b95af7490d3ebb801881ef8ec11e4a1b3444016ee637ec8effb395f408545d`, `Verdict file: .../verdicts/nonce-1566-<ms>.json`, the page line, `Open it with: open ...`, and `exit=0`.
- **Same by hash.** `bin/kiss-sign verify --card <hash> --safe-tx-hash 0x06b95af7490d3ebb801881ef8ec11e4a1b3444016ee637ec8effb395f408545d` gives the same verdict with the transaction fetched from the Transaction Service.
- **Side effects.** Copy the verdict file and page that `verify` printed (`$KISS_SIGN_HOME/verdicts/nonce-1566-<ms>.{json,html}`) to `$KSV_EVIDENCE`. Every verify writes a new pair.
- **Page.** `"$V/screenshot.sh" <the printed .html> "$KSV_EVIDENCE/verify-page.png"` and open the PNG. It shows `kiss-sign verify · nonce 1566 · MATCH`, a green `MATCH: the transaction fits your card` box (`MATCH：交易符合你的卡片` in a zh-TW home), the passed checks, the Checklist (比對清單) rows `tx-safeTxHash`, `tx-domain` (`0xad4982...`), `tx-message` (`0x691e3a...`), `C1-to` (multisend), `C2` approve on usdc, `C3` bundler3 multicall with nested `C3.1`/`C3.2` rows, then Card (卡片) with the card hash, Expected effects (預期效果), and Calls that move no asset (不移動資產的呼叫).
- **Changed transaction.** `"$V/change-tx.mjs" "$KSV_DIR/tx.json" "$KSV_DIR/tx-changed.json" --uint 1000611448606 1000611448607` (3 places changed) and verify the same card against it: `MISMATCH`, three `fields:` lines (`multiSend[0].approve value: expected 1000611448606, got 1000611448607`, the `erc20TransferFrom amount` and the `erc4626Deposit assets`), `No hashes are shown. Do not sign this transaction.`, exit 1. Its page shows Causes (原因) with each line and a 比對清單 that says no hash is shown.
- **Changed card.** Seal a card with amount `1000611448607` (card-new.md, from a file) and verify it against the unchanged tx: `MISMATCH` with the same three field lines reversed plus `effects: usdc ... changed by -1000611448606, the card explains -1000611448607`.
- **Self-check refusal.** `touch "$KSV_CHECKOUT/stray.txt"` and verify: `this checkout is not exactly main of github.com/<owner>/<repo>, so nothing was verified.` and `  untracked: stray.txt`, exit 1, no new verdict file. Remove `stray.txt` afterwards. Running from a worktree prints `the git directory is ...; sign from a plain git clone`.

## Gotchas

- Only a plain clone at origin/main passes the self-check. A worktree, a branch, an edited or untracked file (outside `.gitignore`) all refuse. Unmerged code can only be exercised through `replay` (replay.md).
- Never write the tx JSON, a card JSON or screenshots inside the clone; use `$KSV_DIR` and `$KSV_EVIDENCE`.
- A changed transaction has no safeTxHash and no execution fields, so it is simulated on the latest block, where its nonce is long used: even an unchanged copy in web-app form gives `UNVERIFIABLE` (`simulation: the Safe's nonce at block <n> is <m>, the transaction's is <k>`). A MISMATCH proof must therefore show the `fields:` cause naming the changed value, not just a non-MATCH verdict.
- Editing the Transaction Service JSON in place fails before any check (`safeTxHash: differs from the hash computed from the transaction`); use `change-tx.mjs`, which writes web-app JSON.
- The executed fixture is judged by its receipt, so `MATCH` holds even though the vault's state moved since; a pending transaction would be simulated on the latest block instead.
- stdout prints only the safeTxHash; the domain and message hashes are on the page and in `replay`'s output.
- A card naming a vault with no report folder at origin/main is refused before any chain read: `card refused: <vault> has no report for <id>`.
- The verdict file holds every chain answer but no provider URL, so no key; still never copy `home/.env`.
