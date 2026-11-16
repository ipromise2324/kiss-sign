# Template approve

The signer approves a template once per merged version: kiss-sign fetches origin/main, prints the template's commit with its subject and the template's keccak256 fingerprint, and after a `y` records that fingerprint in `$KISS_SIGN_HOME/approved-templates.json`. `verify` refuses a template whose fingerprint is not approved.

## Sub-features

- `approve-yes` records the fingerprint after `y`.
- `approve-no` records nothing after any other answer (`Nothing approved.`).
- `approve-unmerged` refuses an id with no `template.json` on origin/main.
- `approve-no-tty` refuses without a terminal.

## How to get to it (user POV)

- Run `bin/kiss-sign template approve <protocol>/<operation>` (or `pnpm kiss-sign template approve ...`) in the clone.
- The report's 下一步 section tells the signer to run it.

## Driving it with term.sh and screenshot.sh

Preconditions:

- Baseline run; the template id exists on origin/main (`morpho/vault-deposit`).

- **Start.** Run `"$V/term.sh" start "$KSV_RUN" "$KSV_CHECKOUT"` and `"$V/term.sh" type "$KSV_RUN" 'bin/kiss-sign template approve morpho/vault-deposit'`. The screen shows `Template: morpho/vault-deposit`, `From main of github.com/<owner>/<repo>, commit <40 hex>:`, the quoted subject, and `Fingerprint of templates/morpho/vault-deposit/template.json at that commit:` with a `0x` hash.
- **Confirm.** Run `"$V/term.sh" wait "$KSV_RUN" '\[y/N\] *$' 60` then `"$V/term.sh" type "$KSV_RUN" y` and `"$V/term.sh" idle "$KSV_RUN"`. The last lines are `Approved morpho/vault-deposit.` and `exit=0`.
- **Side effect.** `cat "$KISS_SIGN_HOME/approved-templates.json"` holds `morpho/vault-deposit` with the printed fingerprint. Copy it to `$KSV_EVIDENCE`.
- **Decline.** Repeat and answer `n`. `Nothing approved.`, `exit=1`, the file unchanged.
- **No TTY.** `bin/kiss-sign template approve morpho/vault-deposit </dev/null` prints `template approve asks you to confirm at a terminal, ...` and exits 64.
- **Proof.** `"$V/term.sh" save "$KSV_RUN" "$KSV_EVIDENCE/template-approve.txt"`.

## Gotchas

- The fingerprint is of the file at origin/main, not on disk; approving from a branch that edits the template approves main's version.
- Every `origin` URL must be the config's `repo`; a fork's clone with another origin fails with `origin is ..., not github.com/...`.
- `verify` with an unapproved template does not refuse early; it judges and reports the template check, so approve first when the journey wants `MATCH`.
