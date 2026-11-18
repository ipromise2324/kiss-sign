# Card new and card seal

The signer states the intent before seeing any transaction: `card new` lists each card field's choices with full addresses, asks each amount in whole tokens (reading `decimals()` through two providers), computes the fields the protocol's app fills (such as `min-shares` from `previewDeposit`), prints the whole card, and after `y` stores it as `$KISS_SIGN_HOME/cards/<hash>.json` and prints `Sealed card <hash>`. `card seal <card.json>` does the same for a card written as a file.

## Sub-features

- `card-pick` picks a listed registry entry by number or exact name.
- `card-amount` converts a whole-token amount (commas between thousands allowed) to base units.
- `card-computed` reads and prints a computed field with its slippage and source.
- `card-seal-yes` stores the card and prints its hash.
- `card-seal-no` stores nothing on any answer but `y`/`yes`.
- `card-seal-file` seals a hand-written card JSON with `card seal`.
- `card-refusals` refuses without a TTY, on an unlisted answer, on a malformed amount, and on a clone whose `templates/` or `registry/` differ from origin/main.

## How to get to it (user POV)

- `bin/kiss-sign card new <protocol>/<operation>...` in the clone.
- `bin/kiss-sign card seal <card.json>` for a card file.
- The report's 下一步 section names both steps with the vault to pick.

## Driving it with term.sh and screenshot.sh

Preconditions:

- Baseline run with the Safe of `morpho-vault-deposit-v2` (the card's `safe` is the config's Safe).
- Alchemy key set; the template counts registry tokens, so chain reads happen.

- **Start.** `"$V/term.sh" start "$KSV_RUN" "$KSV_CHECKOUT"` and `"$V/term.sh" type "$KSV_RUN" 'bin/kiss-sign card new morpho/vault-deposit'`. The screen shows `Card for morpho/vault-deposit`, `vault  pick one by number` and numbered lines, each `<n>.  <name>  <checksummed address>` in columns, then `both created by  vault-v2-factory  0xA1D9...` once below them (`created by` under one entry, `all <n> created by` under more than two). Only vaults with a folder under `templates/morpho/vault-deposit/instances/` or `vaults/` are listed.
- **Pick the vault.** `"$V/term.sh" wait "$KSV_RUN" 'vault: type its number \(1-[0-9]+\): *$' 60`, read the screen for the number in front of `hyperithm-usdc-apex-v2-9e2f`, and type that number (it was `2` on 2026-11-16; the order can change, so read it, or type the exact name). The screen shows `amount  type it` and `token  usdc  0xA0b8...  6 decimals`.
- **Type the amount.** `"$V/term.sh" wait "$KSV_RUN" 'decimals\): *$' 60` then `"$V/term.sh" type "$KSV_RUN" '1,000,611.448606'`. The screen shows `min-shares  computed, not asked: ...` with rows `read  previewDeposit(1000611448606) = <shares>` and the vault it was read on, `expected`, `slippage  0.10% less than expected: ...`, `value`, `default from` and `margin`, then the `┌─ Your card` box: `Safe <fixture safe>`, each value with its full address, each amount in whole tokens above its base units, and the dim line `chain reads at block <n>, where alchemy and drpc agree`.
- **Seal.** `"$V/term.sh" wait "$KSV_RUN" '\[y/N\] *$' 60`, `"$V/term.sh" type "$KSV_RUN" y`, `"$V/term.sh" idle "$KSV_RUN" 30`. The screen ends `Sealed card 0x<64 hex>` and `exit=0`.
- **Side effect.** `ls "$KISS_SIGN_HOME/cards/"` holds `<hash>.json`; copy it to `$KSV_EVIDENCE`. Its `values` hold the vault name, `amount` `1000611448606` and the computed `min-shares`.
- **Seal from a file.** Write `$KSV_DIR/card.json` as `{"operations":[{"template":"morpho/vault-deposit","values":{"vault":"hyperithm-usdc-apex-v2-9e2f","amount":"1000611448606","min-shares":"973551731159989631767877"}}]}`, then in tmux `bin/kiss-sign card seal "$KSV_DIR/card.json"`, wait for `[y/N]`, type `y`. Prints `Sealed card <hash>`.
- **Refusals.** `bin/kiss-sign card new morpho/vault-deposit </dev/null` exits 64 with `card new asks you to confirm at a terminal, ...`. In tmux, answering `9` to the vault prompt prints `vault: "9" is none of the listed choices; ...` and exits 1; `1,00` as an amount is refused as not a plain decimal number.
- **Proof.** `"$V/term.sh" save "$KSV_RUN" "$KSV_EVIDENCE/card-new.txt"`.

## Gotchas

- `min-shares` is computed from the latest block, so a card made today for an old executed transaction holds a lower floor than the transaction's bound; `verify` still gives `MATCH` because the transaction asks for at least as many shares. For a card that mirrors the transaction exactly, use `card seal` with the values in `test/morpho-vault-deposit.test.ts`.
- `card new` needs the card fields' choices to exist: a vault without a report folder for the template is not listed, and with none listed it stops with `no vault has a report for ...`.
- The card's Safe is the config's Safe. A card made in a home initialised for another Safe will not `MATCH` the fixture.
- Typing before the prompt appears is buffered by the terminal and still answers that prompt; wait anyway so the transcript shows each prompt before its answer.
- `card seal` of a card file reads no decimals, so its box shows each token amount other than ETH in base units of its token only, and says so; the verify page shows whole tokens and base units.
- One `term.sh` session is one terminal; run a second journey after `idle` returns, not while a prompt is open.
