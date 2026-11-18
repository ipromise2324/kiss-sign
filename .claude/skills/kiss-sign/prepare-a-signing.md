# Prepare a signing

How to do [Prepare a signing](SKILL.md#prepare-a-signing): what to tell the signer, who runs every step in their own terminal.
The flow is in [Every signing](../../../docs/design/flow.md#every-signing).

## The signer's steps

The signer runs every command from the clone as `pnpm kiss-sign <command>`, after `git pull`:

1. Once per merged template, and again whenever it changes: `pnpm kiss-sign template approve <protocol>/<operation>`.
2. `pnpm kiss-sign card new <protocol>/<operation>`.
   It first fetches GitHub's `main` and stops, telling the signer to `git pull`, when the clone's `templates/` or `registry/` differ from it.
   It lists each contract, market or recipient with its full address; the signer picks by number, or by the exact name, full address or market id as listed.
   It asks each amount in whole tokens (commas between thousands allowed), reading a registry token's decimals on chain itself; ETH is 18 with no read, and a token outside the registry is asked in base units.
   It does not ask a computed field, such as a vault deposit's `min-shares`: it reads the declared view, applies the template's slippage, and prints the value with its slippage and source for the signer to check.
   It ends with the card in one box and asks the seal question; on the signer's yes it stores the card and prints its hash, which `verify --card` takes, before the signer sees the Safe transaction.
3. After the transaction is proposed in the Safe web app: `pnpm kiss-sign verify --card <card hash> --safe-tx-hash <safeTxHash>`.

When the card has an amount the signer types, the first time a template or an instance is used, the card names a small amount; the full amount gets a new card once the small transaction has settled as expected ([Every signing](../../../docs/design/flow.md#every-signing), step 13, Small amount first).

The Next steps (下一步) section at the bottom of the signer's HTML report lists every step and prompt.

## A recipient not in the address book

Tell the signer to add it in their own terminal with `pnpm kiss-sign book add <name> <address>`, taking the address from a source outside this chat and checking it character by character.

## The hardened tier

If the signer uses it, remind them to run the `./check.sh` command `verify` prints after `MATCH`, `--hints` included, from `ipromise2324/kiss-sign-check` on their independent computer, which runs no AI and no kiss-sign.
They compare its hashes with the hardware wallet and its decoded calls with the sealed card.
Never offer to run it or to write its `known-addresses.txt`.
