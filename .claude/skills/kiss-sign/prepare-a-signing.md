# Prepare a signing

How to do [Prepare a signing](SKILL.md#prepare-a-signing): what to tell the signer, who runs every step in their own terminal.
The flow is in [Every signing](../../../docs/design/flow.md#every-signing).

## The signer's steps

The signer runs every command from the clone as `pnpm kiss-sign <command>`, after `git pull`:

1. Once per merged template, and again whenever it changes: `pnpm kiss-sign template approve <protocol>/<operation>`.
2. `pnpm kiss-sign card new <protocol>/<operation>`.
   It stops first when the clone is behind GitHub's `main`, lists each contract, market or recipient with its full address to pick by number, asks each amount in whole tokens (commas between thousands allowed), reads the token's decimals on chain itself, and seals the card after they confirm.
   It does not ask a computed field, such as a vault deposit's `min-shares`: it reads the declared view, applies the template's slippage, and prints the value with its slippage and source for the signer to check.
3. After the transaction is proposed in the Safe web app: `pnpm kiss-sign verify --card <card hash> --safe-tx-hash <safeTxHash>`.

The Next steps (下一步) section at the bottom of the signer's HTML report lists every step and prompt.

## A recipient not in the address book

Tell the signer to add it in their own terminal with `pnpm kiss-sign book add <name> <address>`, taking the address from a source outside this chat and checking it character by character.

## The hardened tier

If the signer uses it, remind them to run the `./check.sh` command `verify` prints after `MATCH`, `--hints` included, from `ipromise2324/kiss-sign-check` on their independent computer, which runs no AI and no kiss-sign.
They compare its hashes with the hardware wallet and its decoded calls with the sealed card.
Never offer to run it or to write its `known-addresses.txt`.
